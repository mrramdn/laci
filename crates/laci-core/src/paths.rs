use crate::{Result, env::Env, platform::Identity};
use std::path::{Component, Path, PathBuf};

pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => (),
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

pub fn expand(raw: &str, home: &Path) -> PathBuf {
    normalize(&if raw == "~" {
        home.to_owned()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(raw)
    })
}

pub fn within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

pub fn tilde(path: &Path, home: &Path) -> String {
    path.strip_prefix(home)
        .map(|p| if p.as_os_str().is_empty() { "~".to_owned() } else { format!("~/{}", p.display()) })
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

/// Check both the spelling and the existing filesystem, including missing destinations below symlinks.
pub fn home_path(raw: &str, env: &Env) -> Result<PathBuf> {
    let p = expand(raw.trim(), &env.home);
    if !p.is_absolute() || !within(&p, &env.home) {
        return Err("Path must be inside your home folder".into());
    }
    let root = env.home.canonicalize().map_err(|e| e.to_string())?;
    let mut ancestor = p.as_path();
    while std::fs::symlink_metadata(ancestor).is_err() {
        ancestor = ancestor.parent().ok_or("Invalid path")?;
    }
    let actual = ancestor.canonicalize().map_err(|e| e.to_string())?;
    if !within(&actual, &root) {
        return Err("A symlink points outside your home folder".into());
    }
    Ok(p)
}

/// Explicitly selected folders are canonicalized before being stored in settings.
pub fn selected_directory(raw: &str, env: &Env) -> Result<PathBuf> {
    let path = expand(raw.trim(), &env.home);
    if !path.is_absolute() || !path.is_dir() {
        return Err("Pick an existing folder with an absolute path".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}

/// Project access includes only home and the folders explicitly selected in settings.
/// A selected root replaced by a symlink must not silently authorize a different disk location.
pub fn workspace_path(raw: &str, env: &Env) -> Result<PathBuf> {
    let path = expand(raw.trim(), &env.home);
    if path.starts_with(&env.home) {
        return home_path(raw, env);
    }
    if !path.is_absolute() {
        return Err("Path must be inside home or a selected workspace folder".into());
    }
    for root in workspace_roots(env).into_iter().filter(|root| path.starts_with(root)) {
        if root.canonicalize().is_ok_and(|actual| actual == root) && contained_actual(&path, &root).is_ok() {
            return Ok(path);
        }
    }
    Err("Path must stay inside home or a selected workspace folder; symlink escapes are not allowed".into())
}

/// Only a move journal may restore a missing, explicitly selected root, and only under its original parent.
pub(crate) fn restore_workspace_root(raw: &str, env: &Env, recorded: Identity) -> Result<PathBuf> {
    let path = expand(raw, &env.home);
    if !path.is_absolute() || path.starts_with(&env.home) || !workspace_roots(env).contains(&path) {
        return Err("The original workspace root is no longer selected".into());
    }
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        _ => return Err("The original workspace path has changed".into()),
    }
    let parent = path.parent().ok_or("Missing workspace parent")?;
    crate::sidecar::plain_path(parent)?;
    let actual = parent.canonicalize().map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(parent).map_err(|e| e.to_string())?;
    let id = crate::platform::identity(parent, &meta)?;
    if actual != parent || !meta.is_dir() || id != recorded {
        return Err("The original workspace disk or parent folder has changed".into());
    }
    Ok(path)
}

/// The process-selected XDG location authorizes this file, not browsing its surrounding folders.
pub(crate) fn config_file(env: &Env) -> Result<PathBuf> {
    let file = normalize(&env.config_dir.join("config.json"));
    if !file.is_absolute() {
        return Err("Configuration folder must be absolute".into());
    }
    crate::sidecar::plain_path(&file)?;
    Ok(file)
}

pub fn workspace_roots(env: &Env) -> Vec<PathBuf> {
    let cfg = crate::config::load(env);
    let mut roots: Vec<_> = cfg["roots"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .map(|raw| expand(raw, &env.home))
        .filter(|path| path.is_absolute())
        .collect();
    if let Some(raw) = cfg["archiveDir"].as_str().filter(|raw| !raw.is_empty()) {
        let path = expand(raw, &env.home);
        if path.is_absolute() {
            roots.push(path);
        }
    }
    roots
}

fn contained_actual(path: &Path, root: &Path) -> Result<()> {
    let mut ancestor = path;
    while std::fs::symlink_metadata(ancestor).is_err() {
        ancestor = ancestor.parent().ok_or("Invalid path")?;
    }
    let actual = ancestor.canonicalize().map_err(|e| e.to_string())?;
    if !within(&actual, root) {
        return Err("A symlink points outside the selected folder".into());
    }
    Ok(())
}

pub fn enc(path: &str) -> String {
    // Claude encodes UTF-16 units; an astral character occupies two units in its store name.
    path.encode_utf16()
        .map(|u| if u < 128 && (u as u8).is_ascii_alphanumeric() { char::from(u as u8) } else { '-' })
        .collect()
}
