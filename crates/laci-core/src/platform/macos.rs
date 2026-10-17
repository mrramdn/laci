//! macOS. What POSIX gives comes from `unix`; the rest isn't written for macOS yet and fails with a plain message.
pub use super::unix::{
    Group, Lock, change_stamp, exited, file_change_stamp, home_dir, identity, lock, preserve, rename_noreplace,
    spawn_group,
};
use super::{Apps, Dirs, Holder};
use crate::Result;
use std::path::{Path, PathBuf};

fn not_yet<T>(what: &str) -> Result<T> {
    Err(format!("Laci can't {what} on macOS yet"))
}

pub fn user_dirs(_home: &Path) -> Result<Dirs> {
    not_yet("choose where to keep its settings and data")
}

pub fn pid_alive(_pid: u32) -> Result<bool> {
    not_yet("check whether a process is still running")
}

pub fn processes_in(_paths: &[PathBuf]) -> Result<Vec<Holder>> {
    not_yet("check which programs are using a folder")
}

pub fn ensure_idle(_sources: &[PathBuf]) -> Result<()> {
    not_yet("check which programs are using this history")
}

pub fn trash(_path: &Path) -> Result<()> {
    not_yet("move files to the Trash")
}

pub fn open(_target: &str, _cwd: &Path) -> Result<()> {
    not_yet("open files and links")
}

/// Linux's choices, until Laci has its own for macOS.
pub const DEFAULT_APPS: Apps = Apps { terminal: "kitty", editor: "code", files: "dolphin" };

pub const KNOWN_APPS: [(&str, &[&str]); 3] = [("terminal", &[]), ("editor", &[]), ("files", &[])];

pub fn terminal_args(
    _app: &str,
    _cwd: &Path,
    _executable: &str,
    _argv: &[String],
    _quote: fn(&str) -> String,
) -> Result<Vec<String>> {
    not_yet("open an external terminal")
}

pub fn terminal_script_args(_app: &str, _cwd: &Path, _cmd: Option<&str>, _confirm: bool) -> Result<Vec<String>> {
    not_yet("open an external terminal")
}
