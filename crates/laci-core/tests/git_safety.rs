//! A scanned folder is not trusted. Reading its Git state must not start anything its own settings name.
use laci_core::readers::git_info;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.test")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.test")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}
fn repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "--initial-branch=main"]);
    fs::write(dir.join("notes.txt"), "first\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", "initial"]);
}
/// A program that only records that it was started.
fn helper(home: &Path) -> (PathBuf, String) {
    let marker = home.join("started");
    let program = home.join("helper.sh");
    fs::write(&program, format!("#!/bin/sh\necho started >> '{}'\n", marker.display())).unwrap();
    // Git for Windows runs a script by its first line; there is no mode to set.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    }
    (marker, program.to_string_lossy().into_owned())
}
/// Every setting a folder can use to name a program for the commands a scan runs.
fn name_helper_everywhere(dir: &Path, program: &str) {
    for key in [
        "core.fsmonitor",
        "core.pager",
        "gpg.program",
        "filter.pack.clean",
        "filter.pack.smudge",
        "filter.pack.process",
        "filter.with space.clean",
    ] {
        git(dir, &["config", key, program]);
    }
    git(dir, &["config", "filter.pack.required", "true"]);
    git(dir, &["config", "log.showSignature", "true"]);
    let hooks = Path::new(program).with_extension("hooks");
    fs::create_dir_all(&hooks).unwrap();
    for hook in ["post-index-change", "reference-transaction"] {
        fs::copy(program, hooks.join(hook)).unwrap();
    }
    git(dir, &["config", "core.hooksPath", &hooks.to_string_lossy()]);
}

#[test]
fn reading_a_folder_starts_nothing_its_git_settings_name() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("project/copied-in");
    repo(&dir);
    let (marker, program) = helper(home.path());
    fs::write(dir.join(".gitattributes"), "*.txt filter=pack\n*.md filter=with space\n").unwrap();
    fs::write(dir.join("notes.txt"), "changed since the commit\n").unwrap();
    fs::write(dir.join("new.md"), "untracked\n").unwrap();
    name_helper_everywhere(&dir, &program);

    let info = git_info(&dir).expect("still read as a repository");
    assert!(!marker.exists(), "a program named by the folder's settings was started");
    assert_eq!(info["commits"], 1);
    assert_eq!(info["branch"], "main");
    // .gitattributes, new.md and the edited notes.txt.
    assert_eq!(info["dirty"], 3);
}

#[test]
fn a_changed_submodule_counts_once_and_its_settings_start_nothing() {
    let home = tempfile::tempdir().unwrap();
    let library = home.path().join("library");
    let dir = home.path().join("project/parent");
    repo(&library);
    repo(&dir);
    git(&dir, &["-c", "protocol.file.allow=always", "submodule", "-q", "add", &library.to_string_lossy(), "lib"]);
    git(&dir, &["commit", "-qm", "add library"]);
    assert_eq!(git_info(&dir).unwrap()["dirty"], 0);

    let (marker, program) = helper(home.path());
    fs::write(dir.join("lib/.gitattributes"), "*.txt filter=pack\n").unwrap();
    fs::write(dir.join("lib/notes.txt"), "changed inside the submodule\n").unwrap();
    name_helper_everywhere(&dir.join("lib"), &program);

    assert_eq!(git_info(&dir).unwrap()["dirty"], 1);
    assert!(!marker.exists(), "a program named by the submodule's settings was started");
}

#[test]
fn an_untracked_notes_file_is_not_a_change() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("project/demo");
    repo(&dir);
    fs::write(dir.join(".laci.md"), "---\npriority: high\n---\n").unwrap();
    assert_eq!(git_info(&dir).unwrap()["dirty"], 0);
    fs::write(dir.join("draft.txt"), "real work\n").unwrap();
    assert_eq!(git_info(&dir).unwrap()["dirty"], 1);
}
