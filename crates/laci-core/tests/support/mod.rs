//! What the tests need from the OS: temporary folders, links, and programs to start.
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
    /// The folder as Laci spells the paths it finds on the disk: canonical.
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

/// Makes `link` a link to the folder `target`.
pub fn link_dir(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// Makes `link` a link to the file `target`.
pub fn link_file(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// Removes the link [`link_dir`] made, and nothing it leads to.
pub fn unlink_dir(link: &Path) {
    std::fs::remove_file(link).unwrap();
}

const ROLE: &str = "LACI_TEST_ROLE";

/// The part a run of this test binary started by [`program`] plays, or `None` in the run `cargo test` started.
pub fn role() -> Option<String> {
    std::env::var(ROLE).ok()
}

/// This test binary started again as a program. It runs only the test named `test` (in full, as
/// `cargo test -- --list` names it), which reads `role` from [`role`] first and plays that part instead of testing.
pub fn program(test: &str, role: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", test, "--nocapture", "--test-threads=1"]).env(ROLE, role);
    command
}

/// Writes `body` to `path` as a program that can run. A child writes it, so this process never has the file open for
/// writing: such a file goes along into every program another test thread starts meanwhile, and Linux won't start a
/// program that any process has open for writing ("Text file busy").
pub fn script(path: &Path, body: &str) {
    use std::{io::Write, process::Stdio};
    let mut writer = Command::new("/bin/sh")
        .args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "sh"])
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    writer.stdin.take().unwrap().write_all(body.as_bytes()).unwrap();
    assert!(writer.wait().unwrap().success(), "couldn't write {}", path.display());
}
