//! Finding and starting programs on Windows, and the apps the system picks for a file or a link.
use super::not_yet;
use crate::Result;
use std::path::Path;

pub fn open(_target: &str, _cwd: &Path) -> Result<()> {
    Err(not_yet("open files and links"))
}
