use crate::{Result, env::Env};
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

pub fn enc(path: &str) -> String {
    // Claude encodes UTF-16 units; an astral character occupies two units in its store name.
    path.encode_utf16()
        .map(|u| if u < 128 && (u as u8).is_ascii_alphanumeric() { char::from(u as u8) } else { '-' })
        .collect()
}
