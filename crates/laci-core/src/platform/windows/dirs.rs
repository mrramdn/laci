//! Where Laci keeps its settings, data and cache on Windows, and where the user's home is.
use super::not_yet;
use crate::{Result, platform::Dirs};
use std::path::{Path, PathBuf};

/// Windows has no HOME of its own, and the one Git Bash sets is a POSIX path.
pub fn home_dir() -> Option<PathBuf> {
    None
}

pub fn user_dirs(_home: &Path) -> Result<Dirs> {
    Err(not_yet("choose where to keep its settings and data"))
}
