//! Project removal is explicit and uses system Trash; remote names alone are not a backup.
use crate::{
    Result,
    env::Env,
    files,
    git::Repo,
    ops, paths,
    platform::{
        self,
        path::{canonical, may_contain},
    },
    service::string,
    sidecar,
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path, time::Duration};

/// How many of the files only this computer has a plan names; `more` counts the rest.
const SHOWN: usize = 50;
/// Files the system leaves in folders, in any case. They hold nothing of the user's.
const CLUTTER: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];
/// How many entries a look inside an ignored folder reads before it counts the folder as holding something.
const LOOK: usize = 10_000;

fn clutter(name: &str) -> bool {
    CLUTTER.iter().any(|known| known.eq_ignore_ascii_case(name))
}

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let mut options = vec![
        "-c",
        "core.askPass=true",
        "-c",
        "credential.interactive=false",
        "-c",
        "core.sshCommand=ssh -oBatchMode=yes -oConnectTimeout=5 -oControlMaster=no",
    ];
    options.extend_from_slice(args);
    Repo::at(dir).run(&options, Duration::from_secs(15))
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
    // Checked before `status`, which would start Git inside each submodule under that submodule's settings.
    if dir.join(".gitmodules").exists() || dir.join(".git/modules").is_dir() {
        return Err("This project contains submodules. Their work must be checked separately.".into());
    }
    // These index flags can hide modified tracked bytes from both status and diff.
    if git(dir, &["ls-files", "-v", "-z"])?
        .split('\0')
        .any(|entry| entry.as_bytes().first().is_some_and(|tag| *tag == b'S' || tag.is_ascii_lowercase()))
    {
        return Err("Tracked files use skip-worktree or assume-unchanged. Clear those flags and verify local changes before removing this project.".into());
    }
    if !git(dir, &["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])?.is_empty() {
        return Err("Commit or back up local changes and untracked files first".into());
    }
    if !git(dir, &["stash", "list"])?.is_empty() {
        return Err("This project has stashes that are only stored locally".into());
    }
    git(dir, &["rev-parse", "--verify", "HEAD"]).map_err(|_| "This project has no committed HEAD to verify".to_owned())
}

fn local_backup(dir: &Path, remote: &Path) -> Result<()> {
    let common = git(remote, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let objects = git(remote, &["rev-parse", "--path-format=absolute", "--git-path", "objects"])?;
    let common = canonical(Path::new(&common)).map_err(|e| format!("Could not verify local remote: {e}"))?;
    let objects = canonical(Path::new(&objects)).map_err(|e| format!("Could not verify local remote: {e}"))?;
    if may_contain(dir, &common) || may_contain(dir, &objects) {
        return Err("The local remote stores Git data inside this project and would lose it when removed".into());
    }
    // Git stores loose objects one fanout level down and pack files directly under objects/pack.
    // Inspect metadata only, without following links or walking an unbounded loose-object store.
    for (index, entry) in walkdir::WalkDir::new(&objects).follow_links(false).max_depth(2).into_iter().enumerate() {
        if index >= 100_000 {
            return Err("The local backup has too many object entries to verify safely. Repack it or use a network backup first.".into());
        }
        let entry = entry.map_err(|e| format!("Could not verify local remote object storage: {e}"))?;
        if entry.file_type().is_symlink() {
            return Err(
                "The local remote uses linked object storage. Use an independent backup before removing this project."
                    .into(),
            );
        }
    }
    let borrowed = "The local remote borrows Git objects. Use an independent backup before removing this project.";
    if std::env::var_os("GIT_ALTERNATE_OBJECT_DIRECTORIES").is_some_and(|value| !value.is_empty()) {
        return Err(borrowed.into());
    }
    for name in ["alternates", "http-alternates"] {
        match fs::read_to_string(objects.join("info").join(name)) {
            Ok(text) if !text.trim().is_empty() => return Err(borrowed.into()),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("Could not verify local remote object storage: {error}"));
            }
            _ => (),
        }
    }
    Ok(())
}

/// Whether Git takes the remote `url` for a path on this computer rather than an SSH address: when no colon comes
/// before its first slash, absolute paths included.
fn local_url(url: &str) -> bool {
    url.find(':').is_none_or(|colon| url.find('/').is_some_and(|slash| slash < colon))
}

fn check(dir: &Path) -> Result<String> {
    local_head(dir)?;
    let names = git(dir, &["remote"])?;
    let remote = names
        .lines()
        .find(|n| *n == "origin")
        .or_else(|| names.lines().next())
        .ok_or("This project has no remote backup")?;
    // `--end-of-options` so a remote name read from the repository is always the name argument, never an option.
    let url = git(dir, &["remote", "get-url", "--end-of-options", remote])?;
    if url.starts_with("file://") {
        return Err("File URL backups cannot be verified safely. Use a network remote or a plain local backup path outside this project.".into());
    }
    let local_remote = if local_url(&url) {
        let local = Path::new(&url);
        let local = if local.is_absolute() { local.to_owned() } else { dir.join(local) };
        let actual = canonical(&local).map_err(|_| "The local remote backup is unavailable".to_owned())?;
        if may_contain(dir, &actual) {
            return Err("The remote is inside this project and would be removed with it".into());
        }
        local_backup(dir, &actual)?;
        Some(actual)
    } else {
        None
    };
    // Read live refs, without fetching or trusting potentially stale remote-tracking refs.
    let advertised = git(dir, &["ls-remote", "--heads", "--tags", "--", remote])
        .map_err(|error| format!("Could not verify the remote. Nothing was removed. {error}"))?;
    let remote_ids: BTreeSet<&str> = advertised.lines().filter_map(|l| l.split_once('\t').map(|p| p.0)).collect();
    // A remote can take seconds to answer; reject local work created during that wait.
    let head = local_head(dir)?;
    if let Some(local) = local_remote {
        local_backup(dir, &local)?;
    }
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
    let busy = ops::still_busy(&[dir.to_owned()])?;
    if !busy.is_empty() {
        return Err(format!("This project is in use by {}. Close it first.", ops::holders(&busy)));
    }
    Ok(remote.to_owned())
}

/// Whether the ignored folder `dir` holds anything but dependencies, build output and system clutter. What can't be
/// read, or is too much to look through, counts as something.
fn holds_work(dir: &Path) -> bool {
    let walk = walkdir::WalkDir::new(dir).follow_links(false).into_iter().filter_entry(|entry| {
        entry.depth() == 0
            || !entry.file_type().is_dir()
            || !files::HEAVY.contains(&entry.file_name().to_string_lossy().as_ref())
    });
    for (seen, entry) in walk.enumerate() {
        let Ok(entry) = entry else { return true };
        if seen >= LOOK || (!entry.file_type().is_dir() && !clutter(&entry.file_name().to_string_lossy())) {
            return true;
        }
    }
    false
}

/// The ignored files and folders here, which the online copy can't have, without dependencies and build output: an
/// install or a build brings those back. A folder ignored as a whole is named once.
fn unbacked(dir: &Path) -> Result<Value> {
    // Without Git's own folder here, a repository in a folder above would answer, and removal is refused anyway.
    if !dir.join(".git").is_dir() {
        return Ok(json!({"files":[],"more":0}));
    }
    let args = ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"];
    // Names as Git wrote them: one that isn't valid text is still listed, and its folder is still looked into.
    let listed = Repo::at(dir)
        .run_bytes(&args, Duration::from_secs(15))
        .map_err(|error| format!("Could not list the ignored files. {error}"))?;
    let local: Vec<String> = crate::git::names(&listed)
        .filter(|name| {
            let (path, _) = crate::git::text(name);
            let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
            !parts.iter().any(|part| files::HEAVY.contains(part))
                && !parts.last().is_some_and(|name| clutter(name))
                // Git also names a folder whose contents are all ignored, such as one with only a site's build output.
                && (!path.ends_with('/') || holds_work(&crate::git::path(dir, name)))
        })
        .map(|name| crate::git::text(name).0)
        .collect();
    Ok(json!({"files":local.iter().take(SHOWN).collect::<Vec<_>>(),"more":local.len().saturating_sub(SHOWN)}))
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
    if [&env.home, &env.config_dir, &env.data_dir, &env.cache_dir].iter().any(|p| may_contain(&dir, p)) {
        return Err("This folder contains Laci settings or recovery data and cannot be removed".into());
    }
    // Removal also waits until it is known what only this computer has: Simple asks for more before losing it.
    let listed = unbacked(&dir);
    let verified = check(&dir).and_then(|remote| listed.clone().map(|_| remote));
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
    checks.push(json!({"code":"ignored-files","severity":"med","title":"Ignored files are not backed up by Git","detail":format!("The entire project folder, including ignored files and history inside it, moves to {}. Restore it through your file manager; there is no Log Undo.",platform::BIN.bare)}));
    let unbacked = listed.unwrap_or_else(|_| json!({"files":[],"more":0}));
    Ok(json!({"allowed":allowed,"path":dir,"checks":checks,"unbacked":unbacked,"ops":[
        {"kind":"delete","label":format!("Move the project folder to {}",platform::BIN.bare),"from":dir},
        {"kind":"keep","label":"Keep agent history outside the project","detail":"External session logs and memory are preserved. They may appear as detached history until the folder is restored."}
    ]}))
}

pub fn trash(env: &Env, node: &Value) -> Result<()> {
    ops::with_lock(env, || {
        let dir = paths::workspace_path(string(node, "path"), env)?;
        // Git that another program runs there gets a moment to finish first, so what it wrote is verified below,
        // and anything still in the folder after that makes the check refuse.
        ops::still_busy(std::slice::from_ref(&dir))?;
        let current = plan(env, node)?;
        if current["allowed"] != true {
            return Err(current["checks"][0]["detail"].as_str().unwrap_or("Project removal was blocked").to_owned());
        }
        sidecar::plain_path(&dir)?;
        platform::trash(&dir)
    })
}

#[cfg(test)]
mod tests {
    use super::local_url;

    #[test]
    fn git_reads_a_url_without_a_colon_before_its_first_slash_as_a_path() {
        for url in ["/srv/backup.git", "../backup.git", "backup.git", "./odd:name.git", r"\\server\share\repo.git", ""]
        {
            assert!(local_url(url), "{url}");
        }
        for url in ["git@github.com:me/repo.git", "host:repo", "ssh://host/repo", "https://github.com/me/repo"] {
            assert!(!local_url(url), "{url}");
        }
        for url in [r"C:\backup\repo.git", "C:/backup/repo.git", "d:repo.git"] {
            assert!(!local_url(url), "{url}");
        }
    }
}
