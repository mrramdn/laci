use laci_core::{deletion, env::Env};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

mod support;

fn git(dir: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&out.stdout).trim().into()
}
fn fixture() -> (tempfile::TempDir, Env, PathBuf, Value) {
    let home = tempfile::tempdir().unwrap();
    let env = Env::for_home(home.path().to_owned());
    let dir = home.path().join("project/demo");
    let remote = home.path().join("backup.git");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--bare", "--initial-branch=main"]);
    git(&dir, &["init", "--initial-branch=main"]);
    fs::write(dir.join("README.md"), "backed up\n").unwrap();
    git(&dir, &["add", "README.md"]);
    git(&dir, &["commit", "-m", "initial"]);
    git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&dir, &["push", "-u", "origin", "main"]);
    let node = json!({"kind":"project", "path":dir, "name":"demo"});
    (home, env, dir, node)
}
fn blocked(env: &Env, node: &Value) -> String {
    let plan = deletion::plan(env, node).unwrap();
    assert_eq!(plan["allowed"], false);
    plan["checks"][0]["detail"].as_str().unwrap().into()
}

#[test]
fn live_remote_refs_allow_trash_but_ignored_files_remain_explicit() {
    let (_home, env, dir, node) = fixture();
    fs::write(dir.join(".git/info/exclude"), "secret.env\n").unwrap();
    fs::write(dir.join("secret.env"), "not in Git\n").unwrap();
    let plan = deletion::plan(&env, &node).unwrap();
    assert_eq!(plan["allowed"], true);
    assert_eq!(plan["checks"][1]["code"], "ignored-files");
    assert_eq!(plan["ops"][1]["kind"], "keep");
    assert!(dir.join("secret.env").exists());
    git(&dir, &["tag", "-a", "v1", "-m", "release"]);
    assert!(blocked(&env, &node).contains("refs/tags/v1"));
    git(&dir, &["push", "origin", "v1"]);
    assert_eq!(deletion::plan(&env, &node).unwrap()["allowed"], true);
}

#[test]
fn stale_remote_tracking_refs_and_other_local_branches_cannot_authorize_removal() {
    let (_home, env, dir, node) = fixture();
    fs::write(dir.join("README.md"), "new work\n").unwrap();
    git(&dir, &["commit", "-am", "local only"]);
    git(&dir, &["branch", "unpublished"]);
    git(&dir, &["checkout", "main~1", "--detach"]);
    assert!(blocked(&env, &node).contains("refs/heads/"));
    git(&dir, &["checkout", "main"]);
    git(&dir, &["push", "origin", "main"]);
    assert_eq!(deletion::plan(&env, &node).unwrap()["allowed"], true);
    let remote = env.home.join("backup.git");
    git(&remote, &["update-ref", "-d", "refs/heads/main"]);
    assert!(blocked(&env, &node).contains("current commit"));
    assert!(dir.exists());
}

#[test]
fn dirty_untracked_stash_and_unreachable_remote_are_refused_again_at_execution() {
    let (_home, env, dir, node) = fixture();
    assert_eq!(deletion::plan(&env, &node).unwrap()["allowed"], true);
    fs::write(dir.join("README.md"), "changed after review\n").unwrap();
    assert!(deletion::trash(&env, &node).unwrap_err().contains("local changes"));
    assert!(dir.exists());
    git(&dir, &["stash", "push", "-m", "keep"]);
    assert!(blocked(&env, &node).contains("stashes"));
    git(&dir, &["stash", "pop"]);
    git(&dir, &["restore", "README.md"]);
    fs::write(dir.join("new.txt"), "untracked\n").unwrap();
    assert!(blocked(&env, &node).contains("untracked"));
    fs::remove_file(dir.join("new.txt")).unwrap();
    fs::remove_dir_all(env.home.join("backup.git")).unwrap();
    assert!(blocked(&env, &node).contains("remote backup is unavailable"));
}

// The program working in the folder is `sleep`, and the links are Unix links.
#[cfg(unix)]
#[test]
fn worktrees_in_use_paths_and_symlinks_are_refused() {
    let (home, env, dir, node) = fixture();
    let linked = home.path().join("linked");
    git(&dir, &["worktree", "add", "--detach", linked.to_str().unwrap()]);
    assert!(blocked(&env, &node).contains("other worktrees"));
    let linked_node = json!({"kind":"project", "path":linked});
    assert!(blocked(&env, &linked_node).contains("standalone"));
    git(&dir, &["worktree", "remove", linked.to_str().unwrap()]);
    let mut process = Command::new("sleep").arg("30").current_dir(&dir).spawn().unwrap();
    let result = blocked(&env, &node);
    process.kill().unwrap();
    process.wait().unwrap();
    assert!(result.contains("in use"));
    let link = home.path().join("alias");
    std::os::unix::fs::symlink(&dir, &link).unwrap();
    assert!(deletion::plan(&env, &json!({"kind":"project", "path":link})).is_err());
    assert!(deletion::plan(&env, &json!({"kind":"folder", "path":dir})).is_err());
}

#[test]
fn a_project_cannot_use_itself_as_a_remote_backup() {
    let (_home, env, dir, node) = fixture();
    for url in [
        dir.join(".git").to_string_lossy().into_owned(),
        format!("file://localhost{}/.git", dir.display()),
        format!("file://{}/.git", dir.display()),
    ] {
        git(&dir, &["remote", "set-url", "origin", &url]);
        assert_eq!(deletion::plan(&env, &node).unwrap()["allowed"], false);
        assert!(deletion::trash(&env, &node).is_err());
        assert!(dir.join("README.md").exists());
    }
}

// A Windows file name can't hold a colon.
#[cfg(unix)]
#[test]
fn colons_in_local_paths_cannot_bypass_the_self_backup_guard() {
    let (_home, env, dir, mut node) = fixture();
    let renamed = dir.with_file_name("project:colon");
    fs::rename(&dir, &renamed).unwrap();
    node["path"] = json!(renamed);
    for url in [renamed.join(".git").to_string_lossy().into_owned(), "./relative:repo".into()] {
        if url.starts_with("./") {
            std::os::unix::fs::symlink(renamed.join(".git"), renamed.join("relative:repo")).unwrap();
            fs::write(renamed.join(".git/info/exclude"), "relative:repo\n").unwrap();
        }
        git(&renamed, &["remote", "set-url", "origin", &url]);
        assert!(blocked(&env, &node).contains("inside this project"));
    }
}

// The stand-in for git-upload-pack is a shell script.
#[cfg(unix)]
#[test]
fn local_work_created_while_the_remote_answers_prevents_trash() {
    use std::os::unix::fs::PermissionsExt;
    let (_home, env, dir, node) = fixture();
    let upload = env.home.join("slow-upload-pack");
    fs::write(
        &upload,
        format!(
            "#!/bin/sh\nprintf 'local work during verification\\n' > '{}/new.txt'\nexec git-upload-pack \"$@\"\n",
            dir.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&upload, fs::Permissions::from_mode(0o700)).unwrap();
    git(&dir, &["config", "remote.origin.uploadpack", upload.to_str().unwrap()]);
    assert!(blocked(&env, &node).contains("untracked"));
    fs::remove_file(dir.join("new.txt")).unwrap();
    assert!(deletion::trash(&env, &node).unwrap_err().contains("untracked"));
    assert!(dir.join("new.txt").exists());
}

#[test]
fn hidden_tracked_changes_cannot_pass_the_trash_guard() {
    for flag in ["--skip-worktree", "--assume-unchanged"] {
        let (_home, env, dir, node) = fixture();
        git(&dir, &["update-index", flag, "README.md"]);
        fs::write(dir.join("README.md"), "local bytes absent from the remote\n").unwrap();
        assert!(git(&dir, &["status", "--porcelain=v1", "--untracked-files=all"]).is_empty());
        assert!(blocked(&env, &node).contains("skip-worktree or assume-unchanged"));
        assert!(deletion::trash(&env, &node).is_err());
        assert_eq!(fs::read_to_string(dir.join("README.md")).unwrap(), "local bytes absent from the remote\n");
    }
}

#[test]
fn shared_local_backups_must_be_independent_before_trash() {
    let (_home, env, dir, node) = fixture();
    let backup = env.home.join("backup.git");
    fs::remove_dir_all(&backup).unwrap();
    git(&env.home, &["clone", "--shared", "--bare", dir.to_str().unwrap(), backup.to_str().unwrap()]);
    assert!(backup.join("objects/info/alternates").is_file());
    assert!(blocked(&env, &node).contains("borrows Git objects"));
    assert!(deletion::trash(&env, &node).is_err());
    assert!(dir.join("README.md").is_file());
    git(&backup, &["repack", "-a", "-d"]);
    fs::remove_file(backup.join("objects/info/alternates")).unwrap();
    assert_eq!(deletion::plan(&env, &node).unwrap()["allowed"], true);
}

#[test]
fn a_remote_object_store_linked_into_the_project_is_not_a_backup() {
    let (_home, env, dir, node) = fixture();
    let objects = env.home.join("backup.git/objects");
    fs::remove_dir_all(&objects).unwrap();
    support::link_dir(&dir.join(".git/objects"), &objects);
    assert!(blocked(&env, &node).contains("Git data inside this project"));
    assert!(deletion::trash(&env, &node).is_err());
    assert!(dir.join("README.md").is_file());
}

// The stand-in for git-upload-pack is a shell script.
#[cfg(unix)]
#[test]
fn hidden_changes_created_during_remote_verification_are_rechecked() {
    use std::os::unix::fs::PermissionsExt;
    let (_home, env, dir, node) = fixture();
    let upload = env.home.join("hide-change-upload-pack");
    fs::write(&upload, format!(
        "#!/bin/sh\ngit -C '{}' update-index --skip-worktree README.md\nprintf 'hidden local work\\n' > '{}/README.md'\nexec git-upload-pack \"$@\"\n",
        dir.display(), dir.display()
    )).unwrap();
    fs::set_permissions(&upload, fs::Permissions::from_mode(0o700)).unwrap();
    git(&dir, &["config", "remote.origin.uploadpack", upload.to_str().unwrap()]);
    assert!(blocked(&env, &node).contains("skip-worktree or assume-unchanged"));
    assert_eq!(fs::read_to_string(dir.join("README.md")).unwrap(), "hidden local work\n");
}

#[test]
fn local_backups_cannot_borrow_pack_or_loose_object_subdirectories() {
    for packed in [true, false] {
        let (_home, env, dir, node) = fixture();
        let backup = env.home.join("backup.git");
        let borrowed = if packed {
            git(&dir, &["repack", "-a", "-d"]);
            git(&backup, &["repack", "-a", "-d"]);
            "pack".to_owned()
        } else {
            git(&dir, &["rev-parse", "HEAD"])[..2].to_owned()
        };
        let linked = backup.join("objects").join(&borrowed);
        fs::remove_dir_all(&linked).unwrap();
        support::link_dir(&dir.join(".git/objects").join(&borrowed), &linked);
        git(&backup, &["cat-file", "-e", "HEAD"]);
        assert!(blocked(&env, &node).contains("linked object storage"));
        assert!(deletion::trash(&env, &node).is_err());
        assert!(dir.join("README.md").exists());
    }
}
