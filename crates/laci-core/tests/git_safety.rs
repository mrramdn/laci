//! A scanned folder is not trusted. Reading its Git state must not start anything its own settings name.
use laci_core::readers::{git_info, health};
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

/// One more commit on `dir`, so a later tag has something to count since.
fn commit(dir: &Path, body: &str) {
    fs::write(dir.join("notes.txt"), format!("{body}\n")).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", body]);
}

#[test]
fn a_tag_named_like_an_option_does_not_make_the_health_read_touch_a_file() {
    // A ref name cannot contain a path component that begins with a dot, so the sentinel lives under a
    // plain prefix rather than tempfile's default `.tmp…`.
    let home = tempfile::Builder::new().prefix("laci-tag").tempdir().unwrap();
    let sentinel = home.path().join("sentinel");
    fs::write(&sentinel, "ORIGINAL").unwrap();

    let dir = home.path().join("project/evil-tag");
    repo(&dir);
    git(&dir, &["tag", "v1.0.0"]);
    commit(&dir, "second");
    // The kind of tag a repository can carry: a name that begins with a dash and names a file. Made with
    // update-ref, beside the normal tag, and left as the one nearest HEAD so `describe` reports it.
    let evil = format!("refs/tags/--output={}", sentinel.display());
    git(&dir, &["update-ref", &evil, "HEAD"]);

    let out = health(&dir);
    assert_eq!(
        fs::read_to_string(&sentinel).unwrap(),
        "ORIGINAL",
        "the health read wrote to a file through a tag name"
    );
    // The read still finished and produced a release block, rather than failing.
    assert!(out["release"]["since"].is_u64(), "{:?}", out["release"]);
}

#[test]
fn a_normal_tag_is_reported_with_its_date_and_the_count_since() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("project/tagged");
    repo(&dir);
    git(&dir, &["tag", "v1.0.0"]);
    commit(&dir, "second");
    commit(&dir, "third");

    let out = health(&dir);
    assert_eq!(out["release"]["tag"], "v1.0.0");
    assert_eq!(out["release"]["since"], 2);
    assert!(out["release"]["tagAt"].as_str().is_some_and(|at| at.starts_with("20")), "{:?}", out["release"]["tagAt"]);
}
