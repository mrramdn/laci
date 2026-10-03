//! Project removal is explicit and uses system Trash; remote names alone are not a backup.
use crate::{Result, env::Env, ops, paths, process, service::string, sidecar};
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path, time::Duration};

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let mut options = vec![
        "-c",
        "core.askPass=true",
        "-c",
        "credential.interactive=false",
        "-c",
        "core.sshCommand=ssh -oBatchMode=yes -oConnectTimeout=5",
    ];
    options.extend_from_slice(args);
    process::run("git", &options, Some(dir), Duration::from_secs(15))
}

fn local_head(dir: &Path) -> Result<String> {
    if !dir.join(".git").is_dir() {
        return Err("Only a standalone Git project can be removed here. Linked worktrees and submodules must be managed with Git.".into());
    }
    let top = git(dir, &["rev-parse", "--show-toplevel"])?;
    if Path::new(&top).canonicalize().ok() != dir.canonicalize().ok() {
        return Err("This folder is part of another repository".into());
    }
    if git(dir, &["worktree", "list", "--porcelain"])?.lines().filter(|l| l.starts_with("worktree ")).count() != 1 {
        return Err("This repository has other worktrees. Remove them with Git first.".into());
    }
    if !git(dir, &["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])?.is_empty() {
        return Err("Commit or back up local changes and untracked files first".into());
    }
    if !git(dir, &["stash", "list"])?.is_empty() {
        return Err("This project has stashes that are only stored locally".into());
    }
    if dir.join(".gitmodules").exists() || dir.join(".git/modules").is_dir() {
        return Err("This project contains submodules. Their work must be checked separately.".into());
    }
    git(dir, &["rev-parse", "--verify", "HEAD"]).map_err(|_| "This project has no committed HEAD to verify".to_owned())
}

fn check(dir: &Path) -> Result<String> {
    local_head(dir)?;
    let names = git(dir, &["remote"])?;
    let remote = names
        .lines()
        .find(|n| *n == "origin")
        .or_else(|| names.lines().next())
        .ok_or("This project has no remote backup")?;
    let url = git(dir, &["remote", "get-url", remote])?;
    if url.starts_with("file://") {
        return Err("File URL backups cannot be verified safely. Use a network remote or a plain local backup path outside this project.".into());
    }
    // Git treats a path as local when a slash precedes its first colon (including absolute paths).
    let local_path = url.find(':').is_none_or(|colon| url.find('/').is_some_and(|slash| slash < colon));
    if local_path {
        let local = Path::new(&url);
        let local = if local.is_absolute() { local.to_owned() } else { dir.join(local) };
        let actual = local.canonicalize().map_err(|_| "The local remote backup is unavailable".to_owned())?;
        if actual.starts_with(dir) {
            return Err("The remote is inside this project and would be removed with it".into());
        }
    }
    // Read live refs, without fetching or trusting potentially stale remote-tracking refs.
    let advertised = git(dir, &["ls-remote", "--heads", "--tags", "--", remote])
        .map_err(|error| format!("Could not verify the remote. Nothing was removed. {error}"))?;
    let remote_ids: BTreeSet<&str> = advertised.lines().filter_map(|l| l.split_once('\t').map(|p| p.0)).collect();
    // A remote can take seconds to answer; reject local work created during that wait.
    let head = local_head(dir)?;
    if !remote_ids.contains(head.as_str()) {
        return Err(
            "The current commit is not a branch or tag tip on the live remote. Push or verify the backup first.".into(),
        );
    }
    for line in git(dir, &["for-each-ref", "--format=%(objectname) %(refname)"])?.lines() {
        let Some((object, name)) = line.split_once(' ') else {
            return Err("Could not read local Git refs".into());
        };
        if !name.starts_with("refs/remotes/") && !remote_ids.contains(object) {
            return Err(format!(
                "{name} is not backed up as a live remote branch or tag tip. Push or back it up first."
            ));
        }
    }
    let busy = ops::busy_in(&[dir.to_owned()]);
    if !busy.is_empty() {
        return Err("This project is in use by a running process. Close it first.".into());
    }
    Ok(remote.to_owned())
}

pub fn plan(env: &Env, node: &Value) -> Result<Value> {
    if node["kind"] != "project" {
        return Err("Pick a project to remove".into());
    }
    let dir = paths::workspace_path(string(node, "path"), env)?;
    sidecar::plain_path(&dir)?;
    if !dir.is_dir() {
        return Err("That project is gone".into());
    }
    if [&env.home, &env.config_dir, &env.data_dir, &env.cache_dir].iter().any(|p| p.starts_with(&dir)) {
        return Err("This folder contains Laci settings or recovery data and cannot be removed".into());
    }
    let verified = check(&dir);
    let (allowed, mut checks) = match verified {
        Ok(remote) => (
            true,
            vec![
                json!({"code":"remote-verified","severity":"low","title":format!("Local Git refs verified on {remote}"),"detail":"The remote was contacted now. Verification is repeated before moving to Trash."}),
            ],
        ),
        Err(error) => (
            false,
            vec![
                json!({"code":"delete-blocked","severity":"high","title":"This project cannot be removed yet","detail":error}),
            ],
        ),
    };
    checks.push(json!({"code":"ignored-files","severity":"med","title":"Ignored files are not backed up by Git","detail":"The entire project folder, including ignored files and history inside it, moves to system Trash. Restore it through your file manager; there is no Log Undo."}));
    Ok(json!({"allowed":allowed,"path":dir,"checks":checks,"ops":[
        {"kind":"delete","label":"Move the project folder to system Trash","from":dir},
        {"kind":"keep","label":"Keep agent history outside the project","detail":"External session logs and memory are preserved. They may appear as detached history until the folder is restored."}
    ]}))
}

pub fn trash(env: &Env, node: &Value) -> Result<()> {
    ops::with_lock(env, || {
        let current = plan(env, node)?;
        if current["allowed"] != true {
            return Err(current["checks"][0]["detail"].as_str().unwrap_or("Project removal was blocked").to_owned());
        }
        let dir = paths::workspace_path(string(node, "path"), env)?;
        sidecar::plain_path(&dir)?;
        process::run("gio", &["trash", "--", &dir.to_string_lossy()], None, Duration::from_secs(120))?;
        Ok(())
    })
}
