//! Finding and starting programs on Windows, and the apps the system picks for a file or a link.
use crate::Result;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

/// The first folder in `path` with `program` in it, also as `program` plus an extension from PATHEXT, as cmd finds it.
pub fn which(program: &str, path: &OsStr) -> Option<PathBuf> {
    ::which::which_in_global(program, Some(path)).ok()?.next()
}

/// ShellExecuteEx starts the app Windows picks, as a double click in Explorer does, and a folder opens in Explorer.
/// The target goes to it whole, never through `cmd /c start`, where a `&` in a link would start a command. The open
/// crate gives ShellExecuteEx no folder to start in, so the app starts in Laci's, not in `cwd`.
pub fn open(target: &str, _cwd: &Path) -> Result<()> {
    // The shell doesn't take `\\?\` paths; where the plain spelling names the same file, it is used. A link stays as
    // it is.
    ::open::that_detached(dunce::simplified(Path::new(target))).map_err(|e| format!("Couldn't open {target}: {e}"))
}
