//! The Trash, and opening files, folders and links in the app macOS picks.
use super::not_yet;
use crate::Result;
use std::path::Path;

pub fn trash(_path: &Path) -> Result<()> {
    not_yet("move files to the Trash")
}

pub fn open(_target: &str, _cwd: &Path) -> Result<()> {
    not_yet("open files and links")
}
