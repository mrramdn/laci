//! Detached history is removable only when its selected, available workspace confirms absence.
use crate::{
    Result, config,
    env::Env,
    paths,
    platform::{
        self, ensure_idle,
        path::{may_contain, same_path},
    },
    scan,
    service::string,
    sidecar,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
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
        .filter(|r| paths::within(project, Path::new(string(r, "path"))))
        .max_by_key(|r| string(r, "path").len())
        .ok_or("This location is outside the selected scan folders")?;
    let root_path = Path::new(string(root, "path"));
    if !paths::within(root_path, &env.home) && cfg["rootIdentities"].get(string(root, "path")).is_none() {
        return Err("The external drive has no recorded identity. Reconnect it and save its scan location in Settings before cleanup.".into());
    }
    if root["available"] != true {
        return Err("The project's selected folder or drive is unavailable".into());
    }
    if same_path(project, root_path) {
        return Err("A selected root cannot be confirmed deleted".into());
    }
    match fs::symlink_metadata(project) {
        Ok(_) => return Err("The project location exists again; rescan to reconnect its history".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err("The project location cannot be checked".into()),
    }
    // Read every existing ancestor to distinguish ENOENT from inaccessible paths and links.
    for parent in project.ancestors().skip(1) {
        if !paths::within(parent, root_path) {
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
    if [&env.home, &env.config_dir, &env.data_dir, &env.cache_dir].iter().any(|p| may_contain(source, p))
        || [&env.config_dir, &env.data_dir, &env.cache_dir].iter().any(|p| may_contain(p, source))
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
        let stamp =
            platform::change_stamp(entry.path(), &meta).map_err(|_| "History changed or cannot be read".to_owned())?;
        let ((mtime, mtime_nsec), (ctime, ctime_nsec)) = (stamp.modified, stamp.changed);
        hash.update(entry.path().as_os_str().as_encoded_bytes());
        hash.update(stamp.identity.volume.to_le_bytes());
        hash.update(stamp.identity.file.to_le_bytes());
        for value in [meta.len(), mtime as u64, mtime_nsec as u64, ctime as u64, ctime_nsec as u64] {
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
                    .any(|c| c["link"]["dir"].as_str().is_some_and(|dir| may_contain(source, Path::new(dir))))
                {
                    return Err("An entire connector store cannot be removed as orphan history".into());
                }
                Ok(json!({"path":source,"identity":identity(env,source)?}))
            })
            .collect::<Result<Vec<_>>>()?;
        let selected = scan::root_status(env, &config::load(env));
        let roots: Vec<_> = selected
            .into_iter()
            .filter(|root| projects.iter().any(|project| paths::within(project, Path::new(string(root, "path")))))
            .collect();
        Ok(json!({"projects":projects,"roots":roots,"sources":sources}))
    })();
    proposal["recovery"] = json!({"default":"quarantine","choices":["quarantine","trash"],"quarantine":"Laci Undo restores these exact history paths.","trash":format!("Restore these history paths through {}; Laci Undo is unavailable.",platform::BIN.bare)});
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
