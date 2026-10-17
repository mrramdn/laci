//! Finding and starting programs on Windows, and the apps the system picks for a file or a link.
use super::not_yet;
use crate::Result;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

/// The first folder in `path` with `program` in it, also as `program` plus an extension from PATHEXT, as cmd finds it.
pub fn which(program: &str, path: &OsStr) -> Option<PathBuf> {
    ::which::which_in_global(program, Some(path)).ok()?.next()
}

pub fn open(_target: &str, _cwd: &Path) -> Result<()> {
    Err(not_yet("open files and links"))
}
