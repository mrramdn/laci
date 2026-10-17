//! Rules for paths. For now they compare paths component by component, exactly as spelled, as Laci always has on
//! Linux.
use crate::Result;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// `path` with every link and every `.` or `..` resolved.
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    path.canonicalize()
}

/// Whether `path` is `root` or inside it.
pub fn contains(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// Whether `a` and `b` are the same path.
pub fn same_path(a: &Path, b: &Path) -> bool {
    a == b
}

/// Reject linked files and linked ancestor directories before writing notes or task files.
pub fn plain_path(path: &Path) -> Result<()> {
    for p in path.ancestors() {
        if fs::symlink_metadata(p).is_ok_and(|m| m.is_symlink()) {
            return Err(format!("Refusing to edit linked path {}", p.display()));
        }
    }
    Ok(())
}
