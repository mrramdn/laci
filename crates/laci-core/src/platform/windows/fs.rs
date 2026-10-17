//! Files on Windows: where Laci keeps its own, which file a path names, the change lock, renames and the Recycle Bin.
use super::not_yet;
use crate::{
    Result,
    platform::{Dirs, Identity, Stamp},
};
use std::{
    fs::{File, Metadata},
    io,
    path::{Path, PathBuf},
};

/// Windows has no HOME of its own, and the one Git Bash sets is a POSIX path.
pub fn home_dir() -> Option<PathBuf> {
    None
}

pub fn user_dirs(_home: &Path) -> Result<Dirs> {
    Err(not_yet("choose where to keep its settings and data"))
}

pub fn identity(_path: &Path, _meta: &Metadata) -> Result<Identity> {
    Err(not_yet("tell files apart"))
}

pub fn change_stamp(_path: &Path, _meta: &Metadata) -> Result<Stamp> {
    Err(not_yet("tell when a file changed"))
}

pub fn file_change_stamp(_file: &File, _meta: &Metadata) -> Result<Stamp> {
    Err(not_yet("tell when a file changed"))
}

/// Never made: [`lock`] fails.
pub struct Lock {
    _never: (),
}

pub fn lock(_path: PathBuf) -> Result<Lock> {
    Err(not_yet("keep two windows from changing files at once"))
}

pub fn rename_noreplace(_src: &Path, _dest: &Path) -> io::Result<()> {
    Err(io::Error::other(not_yet("move files without replacing others")))
}

pub fn preserve(_meta: &Metadata, _dest: &Path) -> Result<()> {
    Err(not_yet("keep a file's times and permissions"))
}

pub fn trash(_path: &Path) -> Result<()> {
    Err(not_yet("move files to the Recycle Bin"))
}
