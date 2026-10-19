//! External terminals and the default apps.
use super::not_yet;
use crate::{Result, platform::Apps};
use std::path::Path;

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
