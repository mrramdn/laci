//! Detached history is removable only when its selected, available workspace confirms absence.
use crate::{Result, config, env::Env, paths, scan, service::string, sidecar};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

pub(crate) fn absence(env: &Env, project: &Path) -> Result<()> {
    if !project.is_absolute() {
        return Err("History has no verified project location".into());
    }
    sidecar::plain_path(project)?;
    let cfg = config::load(env);
    let selected = scan::root_status(env, &cfg);
    let root = selected
        .iter()
        .filter(|r| project.starts_with(string(r, "path")))
        .max_by_key(|r| string(r, "path").len())
        .ok_or("This location is outside the selected scan folders")?;
    if !Path::new(string(root, "path")).starts_with(&env.home)
        && cfg["rootIdentities"].get(string(root, "path")).is_none()
    {
        return Err("The external drive has no recorded identity. Reconnect it and save its scan location in Settings before cleanup.".into());
    }
    if root["available"] != true {
        return Err("The project's selected folder or drive is unavailable".into());
    }
    if project == Path::new(string(root, "path")) {
        return Err("A selected root cannot be confirmed deleted".into());
    }
    match fs::symlink_metadata(project) {
        Ok(_) => return Err("The project location exists again; rescan to reconnect its history".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err("The project location cannot be checked".into()),
    }
    // Read every existing ancestor to distinguish ENOENT from inaccessible paths and links.
    for parent in project.ancestors().skip(1) {
        if !parent.starts_with(string(root, "path")) {
            break;
        }
        match fs::symlink_metadata(parent) {
            Ok(meta) if meta.is_dir() => {
                fs::read_dir(parent).map_err(|_| "The project parent cannot be read".to_owned())?;
            }
            Ok(_) => return Err("The project parent has changed".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("The project parent cannot be checked".into()),
        }
    }
    Ok(())
}

fn identity(env: &Env, source: &Path) -> Result<String> {
    paths::home_path(&source.to_string_lossy(), env)?;
    sidecar::plain_path(source)?;
    if [&env.home, &env.config_dir, &env.data_dir, &env.cache_dir].iter().any(|p| p.starts_with(source))
        || [&env.config_dir, &env.data_dir, &env.cache_dir].iter().any(|p| source.starts_with(p))
    {
        return Err("This path contains protected settings or recovery data".into());
    }
    let mut hash = Sha256::new();
    for (count, entry) in walkdir::WalkDir::new(source).follow_links(false).sort_by_file_name().into_iter().enumerate()
    {
        if count >= 20_000 {
            return Err("History is too large to verify safely; split the cleanup first".into());
        }
        let entry = entry.map_err(|_| "History changed or cannot be read".to_owned())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|_| "History changed or cannot be read".to_owned())?;
        if meta.is_symlink() || (!meta.is_file() && !meta.is_dir()) {
            return Err("Linked or special history files cannot be cleaned up".into());
        }
        hash.update(entry.path().as_os_str().as_encoded_bytes());
        for value in [
            meta.dev(),
            meta.ino(),
            meta.len(),
            meta.mtime() as u64,
            meta.mtime_nsec() as u64,
            meta.ctime() as u64,
            meta.ctime_nsec() as u64,
        ] {
            hash.update(value.to_le_bytes());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Adds a review token derived from the proposal, never from client-provided file paths.
pub(crate) fn prepare(env: &Env, snapshot: &Value, proposal: &mut Value) {
    if proposal["category"] != "orphan" {
        return;
    }
    let check = (|| -> Result<Value> {
        let mut projects = Vec::new();
        let ownership = |history: &Value| -> Result<Vec<PathBuf>> {
            if history["ownershipComplete"] != true {
                return Err("Laci couldn't read all of this history, so it won't clean it up".into());
            }
            let cwds = history["cwds"]
                .as_object()
                .filter(|cwds| !cwds.is_empty())
                .ok_or("The history's project locations are unmatched")?;
            Ok(cwds.keys().map(PathBuf::from).collect())
        };
        let moves = proposal["action"]["moves"].as_array().ok_or("Missing cleanup paths")?;
        let id = string(proposal, "id");
        if let Some(name) = id.strip_prefix("orphan:")
            && let Some(claude) = snapshot["claude"].get(name)
        {
            if moves.len() != 1 || moves[0]["from"] != claude["dir"] {
                return Err("The history source does not match its ownership evidence".into());
            }
            projects.extend(ownership(claude)?);
        } else {
            for source in moves {
                let items: Vec<_> = snapshot["items"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(_, item)| item)
                    .filter(|item| source["from"] == item["file"])
                    .collect();
                if items.is_empty() {
                    return Err("The history source has no ownership evidence".into());
                }
                for item in items {
                    projects.extend(ownership(item)?);
                }
            }
        }
        projects.sort();
        projects.dedup();
        if projects.is_empty() {
            return Err("The history's project location is unmatched".into());
        }
        for project in &projects {
            absence(env, project)?;
        }
        let sources = proposal["action"]["moves"]
            .as_array()
            .ok_or("Missing cleanup paths")?
            .iter()
            .map(|m| {
                let source = Path::new(m["from"].as_str().ok_or("Missing history source")?);
                // A connector may reference an entire store, but cleanup must only select its children.
                if snapshot["connectors"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|c| c["link"]["dir"].as_str().is_some_and(|dir| Path::new(dir).starts_with(source)))
                {
                    return Err("An entire connector store cannot be removed as orphan history".into());
                }
                Ok(json!({"path":source,"identity":identity(env,source)?}))
            })
            .collect::<Result<Vec<_>>>()?;
        let selected = scan::root_status(env, &config::load(env));
        let roots: Vec<_> = selected
            .into_iter()
            .filter(|root| projects.iter().any(|project| project.starts_with(string(root, "path"))))
            .collect();
        Ok(json!({"projects":projects,"roots":roots,"sources":sources}))
    })();
    proposal["recovery"] = json!({"default":"quarantine","choices":["quarantine","trash"],"quarantine":"Laci Undo restores these exact history paths.","trash":"Restore these history paths through system Trash; Laci Undo is unavailable."});
    match check {
        Ok(token) => {
            // The public ID binds MCP confirmations to the reviewed sources across rescans.
            let fingerprint =
                Sha256::digest(json!({"action":proposal["action"],"validation":token}).to_string().as_bytes());
            proposal["id"] = json!(format!("{}:{fingerprint:x}", string(proposal, "id")));
            proposal["availability"] = json!("missing");
            proposal["validation"] = token;
        }
        Err(reason) => {
            proposal["availability"] = json!("unavailable");
            proposal["blocked"] = json!(true);
            proposal["reason"] = json!(reason);
            proposal["why"] = proposal["reason"].clone();
            proposal["title"] = json!("Detached history needs a location check");
        }
    }
}

pub(crate) fn revalidate(env: &Env, reviewed: &Value, fresh: &Value) -> Result<()> {
    if reviewed["category"] != "orphan" || reviewed["validation"].is_null() || fresh["availability"] != "missing" {
        return Err(fresh["reason"]
            .as_str()
            .unwrap_or("This history is no longer confirmed orphaned. Rescan and review it again.")
            .into());
    }
    if reviewed["id"] != fresh["id"]
        || reviewed["action"] != fresh["action"]
        || reviewed["validation"] != fresh["validation"]
    {
        return Err("This history or its source location changed. Rescan and review the updated paths.".into());
    }
    let sources = fresh["validation"]["sources"].as_array().ok_or("Missing checked history paths")?;
    for source in sources {
        let path = Path::new(string(source, "path"));
        if identity(env, path)? != source["identity"] {
            return Err("History changed during validation. Try again after its writer stops.".into());
        }
    }
    ensure_idle(&sources.iter().map(|s| PathBuf::from(string(s, "path"))).collect::<Vec<_>>())
}

fn ensure_idle(sources: &[PathBuf]) -> Result<()> {
    for process in fs::read_dir("/proc").map_err(|_| "Could not check running history writers".to_owned())? {
        let process = process.map_err(|e| e.to_string())?;
        if process.file_name().to_string_lossy().parse::<u32>().is_err() {
            continue;
        }
        if fs::read_link(process.path().join("cwd")).is_ok_and(|cwd| sources.iter().any(|p| cwd.starts_with(p))) {
            return Err("History is in use by a running process. Close it first.".into());
        }
        let Ok(fds) = fs::read_dir(process.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = fs::read_link(fd.path()) else {
                continue;
            };
            if !sources.iter().any(|p| target.starts_with(p)) {
                continue;
            }
            let info = fs::read_to_string(process.path().join("fdinfo").join(fd.file_name()))
                .map_err(|_| "Could not verify a process using this history".to_owned())?;
            let flags = info
                .lines()
                .find_map(|l| l.strip_prefix("flags:").and_then(|n| u32::from_str_radix(n.trim(), 8).ok()))
                .ok_or("Could not verify a process using this history")?;
            if flags & 3 != 0 {
                return Err("History has an open writer. Stop the session before cleaning it up.".into());
            }
        }
    }
    Ok(())
}
