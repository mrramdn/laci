use chrono::{DateTime, SecondsFormat, Utc};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
use walkdir::{DirEntry, WalkDir};

pub const HEAVY: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".output",
    ".turbo",
    ".vercel",
    ".venv",
    "venv",
    "vendor",
    "__pycache__",
    ".cache",
    ".gradle",
    "out",
    ".dart_tool",
    "coverage",
    "test-results",
    ".expo",
    ".parcel-cache",
];

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn modified(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}
pub fn age(at: &str) -> f64 {
    DateTime::parse_from_rfc3339(at)
        .map(|t| (Utc::now().timestamp_millis() - t.timestamp_millis()) as f64 / 86_400_000.0)
        .unwrap_or(f64::INFINITY)
}
pub fn text(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.is_symlink() || meta.len() > 2_000_000 {
        return None;
    }
    fs::read_to_string(path).ok()
}
pub fn entries(path: &Path) -> Vec<fs::DirEntry> {
    let mut out: Vec<_> = fs::read_dir(path).into_iter().flatten().filter_map(|e| e.ok()).collect();
    out.sort_by_key(|e| e.file_name());
    out
}
pub fn walk(path: &Path, include_heavy: bool) -> impl Iterator<Item = DirEntry> {
    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_entry(move |e| {
            e.depth() == 0
                || (e.file_name() != ".git"
                    && (include_heavy
                        || (!HEAVY.contains(&e.file_name().to_str().unwrap_or(""))
                            && (!e.file_type().is_dir() || !e.file_name().to_string_lossy().starts_with('.')))))
        })
        .filter_map(|e| e.ok())
}
pub fn size(path: &Path) -> u64 {
    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// A private temporary inode prevents following a pre-created temporary-file symlink.
pub fn replace(path: &Path, contents: &[u8]) -> crate::Result<()> {
    let parent = path.parent().ok_or("File has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(path).is_ok_and(|m| m.is_symlink()) {
        return Err(format!("Refusing to edit linked file {}", path.display()));
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    if let Ok(meta) = fs::metadata(path) {
        temp.as_file().set_permissions(meta.permissions()).map_err(|e| e.to_string())?;
    }
    temp.write_all(contents).and_then(|()| temp.as_file().sync_all()).map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn read_limit(path: &Path, limit: u64) -> Option<String> {
    let mut text = String::new();
    fs::File::open(path).ok()?.take(limit).read_to_string(&mut text).ok()?;
    Some(text)
}
