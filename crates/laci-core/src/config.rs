use crate::{
    Result,
    env::Env,
    files, paths,
    platform::{
        self,
        path::{may_contain, same_path},
    },
};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::LazyLock};

static APP_NAME: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[\w.+-]{1,40}$").expect("app name pattern"));
static EXTENSION: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\.[A-Za-z0-9]{1,10}$").expect("extension pattern"));
static JSON_FIELD: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z_][\w.-]{0,40}$").expect("JSON field pattern"));
static CONNECTOR_SLUG: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"[^a-z0-9]+").expect("connector slug pattern"));
static CONNECTOR_ID: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^custom-[a-z0-9][a-z0-9-]*$").expect("connector ID pattern"));

pub fn load(env: &Env) -> Value {
    let file = env.config_dir.join("config.json");
    let fresh = !file.is_file();
    let mut c = read(&file).unwrap_or_else(|| json!({}));
    if fresh {
        c["presets"] = json!([]);
    }
    c["custom"] = json!(
        c["custom"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| validate_connector(env, v).ok())
            .collect::<Vec<_>>()
    );
    c["apps"] = validate_apps(&c["apps"]).unwrap_or_else(|_| json!({}));
    if !matches!(c["terminalTarget"].as_str(), Some("internal" | "external")) {
        c.as_object_mut().expect("config object").remove("terminalTarget");
    }
    if !matches!(c["theme"].as_str(), Some("light" | "dark")) {
        c.as_object_mut().expect("config object").remove("theme");
    }
    if !matches!(c["design"].as_str(), Some("simple" | "detailed")) {
        c.as_object_mut().expect("config object").remove("design");
    }
    if !matches!(c["updates"].as_str(), Some("daily" | "off")) {
        c.as_object_mut().expect("config object").remove("updates");
    }
    if !c["roots"].is_array() {
        c.as_object_mut().expect("config object").remove("roots");
    }
    if !c["presets"].is_array() {
        c.as_object_mut().expect("config object").remove("presets");
    }
    c
}
/// The settings config.json holds, or `None` when it can't be read as settings.
fn read(file: &Path) -> Option<Value> {
    files::text(file).and_then(|s| serde_json::from_str::<Value>(&s).ok()).filter(Value::is_object)
}
pub fn save(env: &Env, c: &Value) -> Result<()> {
    let file = env.config_dir.join("config.json");
    // Settings that are there but can't be read, as when the app that syncs them can't download them, were loaded as
    // defaults: written over, they would be gone. An empty file holds nothing, and a link is refused below.
    if fs::symlink_metadata(&file).is_ok_and(|meta| !meta.is_symlink() && meta.len() > 0) && read(&file).is_none() {
        return Err(format!(
            "Laci couldn't read your settings in {}, so it won't write over them. Make sure the app that syncs that \
             folder is running, or fix the file, then try again.",
            paths::tilde(&file, &env.home)
        ));
    }
    let mut text = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    text.push('\n');
    files::replace(&file, text.as_bytes())
}
pub fn validate_roots(env: &Env, roots: &Value) -> Result<Value> {
    let array = roots.as_array().ok_or("Pick folders to scan")?;
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for value in array {
        let raw = value.as_str().ok_or("Invalid folder")?;
        let requested = paths::expand(raw.trim(), &env.home);
        let existing = load(env)["roots"].as_array().is_some_and(|roots| {
            roots.iter().filter_map(Value::as_str).any(|root| same_path(&paths::expand(root, &env.home), &requested))
        });
        // Retaining a selected but disconnected disk must not prevent unrelated settings edits.
        let p = if existing && requested.is_absolute() { requested } else { paths::selected_directory(raw, env)? };
        // The root of a disk or a share holds the system and everything else there, not a place of projects. One kept
        // from before, as 2.5 took it, stays: Laci still looks through it, and other settings must still save.
        if !existing && p.parent().is_none() {
            return Err(format!(
                "{} is a whole disk, and Laci doesn't look through one. Choose the folder where you keep projects.",
                p.display()
            ));
        }
        if !roots.iter().any(|r| paths::within(&p, r)) {
            roots.push(p);
        }
    }
    let minimal: Vec<_> = roots
        .iter()
        .filter(|p| !roots.iter().any(|r| r != *p && paths::within(p, r)))
        .map(|p| Value::String(paths::tilde(p, &env.home)))
        .collect();
    Ok(Value::Array(minimal))
}

/// Restore an already recorded selection even when its drive is offline.
pub(crate) fn restore_roots(env: &Env, roots: &Value) -> Result<Value> {
    let roots = roots.as_array().ok_or("Invalid saved scan locations")?;
    roots
        .iter()
        .map(|root| {
            let p = paths::expand(root.as_str().ok_or("Invalid saved folder")?, &env.home);
            if !p.is_absolute() {
                return Err("Invalid saved folder".into());
            }
            Ok(json!(paths::tilde(&p, &env.home)))
        })
        .collect::<Result<Vec<_>>>()
        .map(Value::Array)
}

/// Remember the selected filesystem so an empty mountpoint is not mistaken for a deleted project.
pub fn root_identities(env: &Env, roots: &Value, previous: &Value) -> Value {
    let mut out = json!({});
    for raw in roots.as_array().into_iter().flatten().filter_map(Value::as_str) {
        let path = paths::expand(raw, &env.home);
        let key = path.to_string_lossy();
        if let Some(old) = previous.get(key.as_ref()) {
            out[key.as_ref()] = old.clone();
        } else if let Ok(id) =
            std::fs::metadata(&path).map_err(|e| e.to_string()).and_then(|meta| platform::identity(&path, &meta))
        {
            out[key.as_ref()] = id.to_json();
        }
    }
    out
}

/// A folder picked in Settings, or `None` to clear it. Keeping the stored folder works while its drive is offline.
fn chosen_folder(env: &Env, value: &Value, key: &str, missing: &str) -> Result<Option<std::path::PathBuf>> {
    let raw = value.as_str().ok_or(missing)?.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let requested = paths::expand(raw, &env.home);
    let stored = load(env)[key].as_str().map(|old| paths::expand(old, &env.home));
    Ok(Some(if stored.is_some_and(|stored| same_path(&stored, &requested)) && requested.is_absolute() {
        requested
    } else {
        paths::selected_directory(raw, env)?
    }))
}

pub fn validate_archive_dir(env: &Env, value: &Value) -> Result<Value> {
    let path = chosen_folder(env, value, "archiveDir", "Pick an archive folder")?;
    Ok(json!(path.map(|p| paths::tilde(&p, &env.home)).unwrap_or_default()))
}

/// The folder agents write session reports to. Laci only reads it, and it grants no project actions.
pub fn validate_reports_dir(env: &Env, value: &Value) -> Result<Value> {
    let Some(path) = chosen_folder(env, value, "reportsDir", "Pick the reports folder")? else {
        return Ok(json!(""));
    };
    if may_contain(&path, &env.home) {
        return Err("Pick the folder that holds the reports, not your home folder or one above it".into());
    }
    if [&env.config_dir, &env.data_dir, &env.cache_dir].iter().any(|own| may_contain(own, &path)) {
        return Err("That folder belongs to Laci itself".into());
    }
    Ok(json!(paths::tilde(&path, &env.home)))
}

/// The folder chosen for the copy of AI chats (`backup::dir`), or `None` for the default, `<data dir>/history`, which
/// is also what choosing that folder itself means. The copy must have a folder of its own: not home or one above it,
/// not one of Laci's own folders or anything inside them, and nothing that holds an agent's history or lies inside it.
/// Whether the folder is empty is asked when the copy moves (`ops::move_backup`).
pub fn validate_backup_dir(env: &Env, value: &Value) -> Result<Option<std::path::PathBuf>> {
    let raw = value.as_str().ok_or("Pick a folder for the copy of AI chats")?.trim();
    let default = paths::normalize(&env.data_dir.join("history"));
    let real = |path: &Path| platform::path::canonical(path).unwrap_or_else(|_| paths::normalize(path));
    if raw.is_empty() || same_path(&paths::expand(raw, &env.home), &default) {
        return Ok(None);
    }
    let Some(path) = chosen_folder(env, value, "backupDir", "Pick a folder for the copy of AI chats")? else {
        return Ok(None);
    };
    if same_path(&path, &real(&default)) {
        return Ok(None);
    }
    if [env.home.clone(), real(&env.home)].iter().any(|home| may_contain(&path, home)) {
        return Err("Choose a folder of its own for the copy, not your home folder or one above it".into());
    }
    if [&env.config_dir, &env.data_dir, &env.cache_dir]
        .iter()
        .flat_map(|own| [paths::normalize(own.as_path()), real(own.as_path())])
        .any(|own| may_contain(&own, &path) || may_contain(&path, &own))
    {
        return Err("That folder belongs to Laci itself. Choose another one.".into());
    }
    for c in crate::agents::connectors(env, &load(env)) {
        let Some(store) = c["link"]["dir"].as_str().map(|raw| paths::expand(raw, &env.home)) else { continue };
        if [paths::normalize(&store), real(&store)]
            .iter()
            .any(|store| may_contain(store, &path) || may_contain(&path, store))
        {
            return Err(format!(
                "That folder holds the history of {}, or is inside it. Choose a folder of its own for the copy.",
                c["name"].as_str().unwrap_or("an AI helper")
            ));
        }
    }
    Ok(Some(path))
}

/// The folders whose drive Laci recognises by the identity it recorded in `rootIdentities`: the scan locations, the
/// archive folder and the folder chosen for the copy of AI chats.
pub(crate) fn known_locations(cfg: &Value) -> Value {
    let mut locations = cfg["roots"].as_array().cloned().unwrap_or_default();
    for key in ["archiveDir", "backupDir"] {
        if let Some(dir) = cfg[key].as_str().filter(|dir| !dir.trim().is_empty()) {
            locations.push(json!(dir));
        }
    }
    Value::Array(locations)
}

pub fn validate_apps(apps: &Value) -> Result<Value> {
    let mut out = json!({});
    for key in ["terminal", "editor", "files"] {
        if let Some(s) = apps[key].as_str().filter(|s| !s.is_empty()) {
            if !APP_NAME.is_match(s) {
                return Err(format!("{key}: use a program name"));
            }
            out[key] = json!(s);
        }
    }
    Ok(out)
}
pub fn validate_connector(env: &Env, raw: &Value) -> Result<Value> {
    let name = raw["name"].as_str().unwrap_or("").trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("Give the connector a name (up to 40 characters)".into());
    }
    let agent = if raw["agent"].is_null() { None } else { Some(crate::providers::validate_agent(env, &raw["agent"])?) };
    let mut link = raw["link"].clone();
    let kind = raw["link"]["kind"].as_str().unwrap_or("");
    if agent.is_some() && matches!(kind, "" | "none") {
        // A tool Laci only starts: it keeps no history Laci can read.
        link = json!({"kind":"none"});
    } else if kind == "inside" {
        let p = link["path"].as_str().ok_or("Pick a path inside the project")?.trim().trim_end_matches('/');
        if p.is_empty() || p.len() > 200 || p.starts_with('/') || p.split('/').any(|s| s == ".." || s.is_empty()) {
            return Err("History path must stay inside the project".into());
        }
        link["path"] = json!(p);
    } else if ["cwd", "named", "mentions"].contains(&kind) {
        let dir = paths::home_path(link["dir"].as_str().ok_or("Pick a history folder")?, env)?;
        link["dir"] = json!(paths::tilde(&dir, &env.home));
        if kind == "named" && !matches!(link["naming"].as_str(), Some("dashes" | "sha256")) {
            return Err("Pick the folder naming scheme".into());
        }
        if kind == "cwd" || kind == "mentions" {
            let ext = link["ext"].as_str().unwrap_or(if kind == "cwd" { ".jsonl" } else { ".md" }).trim();
            if !EXTENSION.is_match(ext) {
                return Err("File type: use .jsonl or .md".into());
            }
            link["ext"] = json!(ext);
        }
        if kind == "cwd" {
            let field = link["field"].as_str().unwrap_or("cwd").trim();
            if !JSON_FIELD.is_match(field) {
                return Err("Invalid JSON field".into());
            }
            link["field"] = json!(field);
        }
    } else {
        return Err("Pick how the history links to a project".into());
    }
    let slug = CONNECTOR_SLUG.replace_all(&name.to_lowercase(), "-").trim_matches('-').to_owned();
    let id = raw["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("custom-{}", if slug.is_empty() { "tool" } else { &slug }));
    if !CONNECTOR_ID.is_match(&id) {
        return Err("Invalid connector id".into());
    }
    let mut spec = json!({"id":id,"name":name,"link":link});
    if let Some(agent) = agent {
        spec["agent"] = agent;
    }
    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_config_keeps_preset_defaults_and_tilde_paths() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        save(&env,&json!({"roots":["~/project"],"custom":[{"id":"custom-old","name":"Old","link":{"kind":"cwd","dir":"~/history","field":"project.cwd","ext":".jsonl"}}],"apps":{"editor":"code"},"theme":"dark"})).unwrap();
        let cfg = load(&env);
        assert!(cfg["presets"].is_null());
        assert_eq!(cfg["roots"][0], "~/project");
        assert_eq!(cfg["custom"][0]["link"]["dir"], "~/history");
        assert_eq!(cfg["apps"]["editor"], "code");
        assert!(validate_connector(&env, &json!({"name":"Bad","link":{"kind":"inside","path":"../history"}})).is_err());
    }
    #[test]
    fn unknown_design_and_update_choices_are_dropped_and_known_ones_kept() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        for (design, updates) in [("simple", "daily"), ("detailed", "off")] {
            save(&env, &json!({"roots":[],"design":design,"updates":updates})).unwrap();
            let cfg = load(&env);
            assert_eq!((cfg["design"].as_str(), cfg["updates"].as_str()), (Some(design), Some(updates)));
        }
        for bad in [json!("Simple"), json!("classic"), json!(""), json!(true), json!({"design":"simple"})] {
            save(&env, &json!({"roots":[],"theme":"dark","design":bad,"updates":bad})).unwrap();
            let cfg = load(&env);
            assert!(cfg.get("design").is_none() && cfg.get("updates").is_none(), "{bad}");
            assert_eq!(cfg["theme"], "dark");
        }
    }
}
