use laci_core::{deletion, env::Env};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

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
