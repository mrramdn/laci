//! What the tests need from the OS where Linux, macOS and Windows differ: temporary folders, links, and programs to
//! start.
// Each test file uses only some of these.
#![allow(dead_code)]
use std::{
    path::{Path, PathBuf},
    process::Command,
};

/// A temporary folder, removed when this is dropped.
pub struct TempDir {
    _dir: tempfile::TempDir,
    path: PathBuf,
}
impl TempDir {
    /// The folder as Laci spells the paths it finds on the disk, and its home outside Linux: canonical. Windows' own
    /// temp path can hold an 8.3 short name such as `RUNNER~1`, and macOS's leads through the link `/var`.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// A new temporary folder for a test's home and projects.
pub fn tempdir() -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    let path = laci_core::platform::path::canonical(dir.path()).unwrap();
    TempDir { _dir: dir, path }
}

/// Makes `link` a link to the folder `target`. Windows makes symlinks only in Developer Mode or for an administrator;
/// without either, a junction stands in, which Laci must refuse the same way.
pub fn link_dir(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_err() {
            let made = Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
            assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        }
    }
}

/// Makes `link` a link to the file `target`. On Windows this needs Developer Mode or an administrator.
pub fn link_file(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(target, link).unwrap();
}

/// Removes the link [`link_dir`] made, and nothing it leads to. Windows removes a link to a folder as a folder.
pub fn unlink_dir(link: &Path) {
    #[cfg(unix)]
    std::fs::remove_file(link).unwrap();
    #[cfg(windows)]
    std::fs::remove_dir(link).unwrap();
}

const ROLE: &str = "LACI_TEST_ROLE";

/// The part a run of this test binary started by [`program`] plays, or `None` in the run `cargo test` started.
pub fn role() -> Option<String> {
    std::env::var(ROLE).ok()
}

/// This test binary started again as a program, where Linux would use a shell or `sleep` and Windows has neither. It
/// runs only the test named `test` (in full, as `cargo test -- --list` names it), which reads `role` from [`role`]
/// first and plays that part instead of testing.
pub fn program(test: &str, role: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", test, "--nocapture", "--test-threads=1"]).env(ROLE, role);
    command
}
