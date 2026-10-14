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
/// Like `text` for a file in a folder someone else writes: the last path component is never followed as a
/// link, even when one replaces the file after it was listed, and a FIFO cannot block the read.
pub fn text_nofollow(path: &Path, limit: u64) -> Option<String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32);
    }
    let file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > limit {
        return None;
    }
    String::from_utf8(bytes).ok()
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

pub fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}
/// Set owner-only permissions on an existing path (Unix); other platforms keep their defaults.
pub fn restrict(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)?.permissions().mode() & 0o777 != mode {
            fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
        }
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}
/// Create one of Laci's own folders as 0700, or tighten an existing one.
pub fn private_dir(path: &Path) -> crate::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    match builder.create(path) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e.to_string()),
        _ => {}
    }
    restrict(path, 0o700).map_err(|e| e.to_string())
}
/// Open a log for appending as 0600, tightening a file that already has wider permissions.
pub fn private_append(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options.open(path)?;
    restrict(path, 0o600)?;
    Ok(file)
}
/// Rotate an oversized log, tightening it first so the rotated copy is private too.
pub fn rotate_private(path: &Path, to: &Path, limit: u64) {
    if fs::metadata(path).is_ok_and(|m| m.len() > limit) {
        let _ = restrict(path, 0o600);
        let _ = fs::rename(path, to);
    }
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
