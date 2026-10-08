use crate::{Result, env::Env, files, paths};
use serde_json::{Value, json};
use std::sync::LazyLock;

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
    let fresh = !env.config_dir.join("config.json").is_file();
    let mut c = files::text(&env.config_dir.join("config.json"))
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
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
    if !c["roots"].is_array() {
        c.as_object_mut().expect("config object").remove("roots");
    }
    if !c["presets"].is_array() {
        c.as_object_mut().expect("config object").remove("presets");
    }
    c
}
pub fn save(env: &Env, c: &Value) -> Result<()> {
    let mut text = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    text.push('\n');
    files::replace(&env.config_dir.join("config.json"), text.as_bytes())
}
pub fn validate_roots(env: &Env, roots: &Value) -> Result<Value> {
    let array = roots.as_array().ok_or("Pick folders to scan")?;
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for value in array {
        let raw = value.as_str().ok_or("Invalid folder")?;
        let requested = paths::expand(raw.trim(), &env.home);
        let existing = load(env)["roots"].as_array().is_some_and(|roots| {
            roots.iter().filter_map(Value::as_str).any(|root| paths::expand(root, &env.home) == requested)
        });
        // Retaining a selected but disconnected disk must not prevent unrelated settings edits.
        let p = if existing && requested.is_absolute() { requested } else { paths::selected_directory(raw, env)? };
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
    use std::os::unix::fs::MetadataExt;
    let mut out = json!({});
    for raw in roots.as_array().into_iter().flatten().filter_map(Value::as_str) {
        let path = paths::expand(raw, &env.home);
        let key = path.to_string_lossy();
        if let Some(old) = previous.get(key.as_ref()) {
            out[key.as_ref()] = old.clone();
        } else if let Ok(meta) = std::fs::metadata(&path) {
            out[key.as_ref()] = json!({"device":meta.dev(),"inode":meta.ino()});
        }
    }
    out
}

pub fn validate_archive_dir(env: &Env, value: &Value) -> Result<Value> {
    let raw = value.as_str().ok_or("Pick an archive folder")?.trim();
    if raw.is_empty() {
        return Ok(json!(""));
    }
    let requested = paths::expand(raw, &env.home);
    let stored = load(env)["archiveDir"].as_str().map(|old| paths::expand(old, &env.home));
    let path = if stored.as_ref() == Some(&requested) && requested.is_absolute() {
        requested
    } else {
        paths::selected_directory(raw, env)?
    };
    Ok(json!(paths::tilde(&path, &env.home)))
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
}
