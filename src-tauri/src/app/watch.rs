use laci_core::{
    env::Env,
    files, paths,
    service::{Refresh, array, string},
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Default)]
pub struct Changes {
    pub paths: BTreeSet<PathBuf>,
    pub structural: bool,
}
impl Changes {
    fn merge(&mut self, other: Self) {
        self.paths.extend(other.paths);
        self.structural |= other.structural;
    }
}

pub fn batch(receiver: &mpsc::Receiver<Changes>, mut first: Changes, window: Duration) -> Changes {
    let deadline = Instant::now() + window;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(remaining) {
            Ok(paths) => first.merge(paths),
            Err(_) => break,
        }
    }
    first
}

fn git_directories(project: &Path) -> Vec<PathBuf> {
    let git = project.join(".git");
    if git.is_dir() {
        return vec![git];
    }
    let Some(dir) = files::text(&git).and_then(|text| text.strip_prefix("gitdir: ").map(|s| s.trim().to_owned()))
    else {
        return vec![];
    };
    let dir = paths::normalize(&project.join(dir));
    let mut directories = vec![dir.clone()];
    if let Some(common) = files::text(&dir.join("commondir")) {
        let common = paths::normalize(&dir.join(common.trim()));
        if common != dir {
            directories.push(common);
        }
    }
    directories
}

/// Session content changes do not invalidate unrelated project metadata.
pub fn refresh_for(env: &Env, snapshot: &Value, changes: &Changes) -> Refresh {
    let mut refresh = Refresh::default();
    let projects: Vec<_> = snapshot["nodes"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, node)| node)
        .filter(|node| node["kind"] == "project")
        .collect();
    let mut git_owners = None;
    for path in &changes.paths {
        if path.starts_with(&env.data_dir) {
            continue;
        }
        if path.starts_with(&env.config_dir) {
            refresh.merge(Refresh::full());
            continue;
        }
        if array(&snapshot["connectors"]).iter().any(|connector| {
            connector["link"]["dir"]
                .as_str()
                .is_some_and(|dir| path.starts_with(dir) || std::path::Path::new(dir).starts_with(path))
        }) {
            refresh.merge(Refresh { watches: changes.structural, ..Refresh::agents() });
            continue;
        }
        if changes.structural
            && projects.iter().any(|node| {
                path == Path::new(string(node, "path")) || path == &Path::new(string(node, "path")).join(".git")
            })
        {
            refresh.merge(Refresh::full());
            continue;
        }
        let owners = git_owners.get_or_insert_with(|| {
            projects.iter().map(|node| (*node, git_directories(Path::new(string(node, "path"))))).collect::<Vec<_>>()
        });
        // A worktree HEAD belongs to that worktree; shared refs affect every checkout using them.
        let git_depth = owners
            .iter()
            .flat_map(|(_, dirs)| dirs)
            .filter(|dir| path.starts_with(dir))
            .map(|dir| dir.components().count())
            .max();
        if let Some(depth) = git_depth {
            for (node, dirs) in owners.iter() {
                if dirs.iter().any(|dir| dir.components().count() == depth && path.starts_with(dir)) {
                    refresh.projects.insert(string(node, "id").to_owned());
                }
            }
            refresh.watches |= changes.structural;
            continue;
        }
        let owner = projects
            .iter()
            .filter(|node| path.starts_with(string(node, "path")))
            .max_by_key(|node| string(node, "path").len());
        if let Some(node) = owner {
            refresh.projects.insert(string(node, "id").to_owned());
            refresh.watches |= changes.structural;
        } else if array(&snapshot["roots"]).iter().filter_map(Value::as_str).any(|root| path.starts_with(root)) {
            refresh.merge(Refresh::full());
        }
    }
    refresh
}

pub struct Watches {
    inner: Mutex<(RecommendedWatcher, BTreeSet<PathBuf>)>,
}
impl Watches {
    pub fn new(sender: mpsc::Sender<Changes>) -> Result<Self, String> {
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            if let Ok(event) = result {
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                let structural = matches!(
                    event.kind,
                    notify::EventKind::Create(_)
                        | notify::EventKind::Remove(_)
                        | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                        | notify::EventKind::Any
                );
                let paths: BTreeSet<_> = event
                    .paths
                    .into_iter()
                    .filter(|p| {
                        let name = p.file_name().unwrap_or_default().to_string_lossy();
                        !name.starts_with(".tmp")
                            && !name.ends_with(".laci-tmp")
                            && !name.ends_with(".lock")
                            && name != "laci.log"
                            && name != "laci.log.1"
                            && name != "lock"
                    })
                    .collect();
                if !paths.is_empty() {
                    let _ = sender.send(Changes { paths, structural });
                }
            }
        })
        .map_err(|e| e.to_string())?;
        Ok(Self { inner: Mutex::new((watcher, BTreeSet::new())) })
    }
    pub fn desired(env: &Env, snapshot: &Value, listings: &BTreeSet<PathBuf>) -> BTreeSet<PathBuf> {
        let mut want = listings.clone();
        want.insert(env.config_dir.clone());
        want.insert(env.data_dir.clone());
        for root in array(&snapshot["roots"]).iter().filter_map(Value::as_str) {
            want.insert(PathBuf::from(root));
        }
        for node in snapshot["nodes"].as_object().into_iter().flatten().map(|(_, n)| n) {
            let path = PathBuf::from(string(node, "path"));
            if node["kind"] == "folder" {
                want.insert(path);
                continue;
            }
            if node["archived"] == true {
                want.insert(path.clone());
            } else {
                for e in files::walk(&path, false).filter(|e| e.file_type().is_dir()).take(1500) {
                    want.insert(e.path().to_owned());
                }
            }
            for git in git_directories(&path) {
                for relative in ["", "refs", "refs/heads", "refs/tags", "refs/remotes"] {
                    want.insert(git.join(relative));
                }
                // Object directories can consume the general walk budget before refs are reached.
                for e in files::walk(&git.join("refs"), false).filter(|e| e.file_type().is_dir()).take(100) {
                    want.insert(e.path().to_owned());
                }
                for e in files::walk(&git, false).filter(|e| e.file_type().is_dir()).take(100) {
                    want.insert(e.path().to_owned());
                }
            }
        }
        for c in array(&snapshot["connectors"]) {
            if let Some(dir) = c["link"]["dir"].as_str() {
                let mut parent = PathBuf::from(dir);
                while !parent.is_dir() && parent.pop() {}
                want.insert(parent);
                for e in files::walk(std::path::Path::new(dir), false).filter(|e| e.file_type().is_dir()).take(4000) {
                    want.insert(e.path().to_owned());
                }
            }
        }
        want.into_iter().filter(|p| p.is_dir()).take(12_000).collect()
    }
    pub fn install(&self, want: BTreeSet<PathBuf>) {
        if let Ok(mut inner) = self.inner.lock() {
            let (watcher, current) = &mut *inner;
            for old in current.difference(&want) {
                let _ = watcher.unwatch(old);
            }
            let mut accepted = BTreeSet::new();
            for dir in want {
                if current.contains(&dir) || watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
                    accepted.insert(dir);
                }
            }
            *current = accepted;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
    };

    #[test]
    fn continuous_changes_flush_at_the_batch_deadline() {
        let (sender, receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let producer_stop = Arc::clone(&stop);
        let repeated = PathBuf::from("project/session.jsonl");
        let streamed = repeated.clone();
        let producer = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !producer_stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                if sender.send(Changes { paths: BTreeSet::from([streamed.clone()]), structural: false }).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
        });
        let started = Instant::now();
        let changed = batch(
            &receiver,
            Changes { paths: BTreeSet::from([repeated.clone()]), structural: false },
            Duration::from_millis(80),
        );
        let elapsed = started.elapsed();
        stop.store(true, Ordering::Relaxed);
        producer.join().unwrap();
        assert!(elapsed < Duration::from_secs(1), "continuous writes postponed the batch: {elapsed:?}");
        assert_eq!(changed.paths, BTreeSet::from([repeated]));
        assert!(!changed.structural);
    }

    #[test]
    fn appended_sessions_request_only_history_and_structural_events_keep_watch_updates() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let store = home.path().join(".claude/projects");
        let project = home.path().join("projects/app");
        let snapshot = json!({"connectors":[{"link":{"dir":store}}],
        "roots":[home.path().join("projects")],"nodes":{
            "app":{"id":"app","kind":"project","path":project}
        }});
        let changes = Changes { paths: BTreeSet::from([store.join("example/session.jsonl")]), structural: false };
        assert_eq!(refresh_for(&env, &snapshot, &changes), Refresh::agents());
        let changes = Changes { structural: true, ..changes };
        let refresh = refresh_for(&env, &snapshot, &changes);
        assert!(refresh.agents && refresh.watches && !refresh.full);
        let config = Changes { paths: BTreeSet::from([env.config_dir.join("config.json")]), structural: false };
        assert!(refresh_for(&env, &snapshot, &config).full);
        let metadata = Changes { paths: BTreeSet::from([project.join("README.md")]), structural: false };
        let refresh = refresh_for(&env, &snapshot, &metadata);
        assert_eq!(refresh.projects, BTreeSet::from(["app".to_owned()]));
        assert!(!refresh.full && !refresh.agents && !refresh.watches);
    }

    #[test]
    fn linked_worktree_git_events_refresh_the_checkout_and_shared_refs_refresh_all_owners() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let main = home.path().join("main");
        let linked = home.path().join("linked");
        let private = main.join(".git/worktrees/review");
        let heads = main.join(".git/refs/heads");
        fs::create_dir_all(&private).unwrap();
        for index in 0..128 {
            fs::create_dir_all(main.join(format!(".git/objects/{index:02x}"))).unwrap();
        }
        fs::create_dir_all(&heads).unwrap();
        let namespaced = heads.join("feature");
        fs::create_dir_all(&namespaced).unwrap();
        fs::create_dir_all(&linked).unwrap();
        fs::write(linked.join(".git"), "gitdir: ../main/.git/worktrees/review\n").unwrap();
        fs::write(private.join("commondir"), "../..\n").unwrap();
        let mut snapshot = json!({"roots":[linked],"connectors":[],"nodes":{
            "main":{"id":"main","kind":"project","path":main},
            "linked":{"id":"linked","kind":"project","path":linked}
        }});
        let private_change = Changes { paths: BTreeSet::from([private.join("HEAD")]), structural: false };
        assert_eq!(refresh_for(&env, &snapshot, &private_change).projects, BTreeSet::from(["linked".to_owned()]));
        let shared_change = Changes { paths: BTreeSet::from([heads.join("topic")]), structural: false };
        assert_eq!(
            refresh_for(&env, &snapshot, &shared_change).projects,
            BTreeSet::from(["main".to_owned(), "linked".to_owned()])
        );
        snapshot["nodes"].as_object_mut().unwrap().remove("main");
        assert_eq!(refresh_for(&env, &snapshot, &private_change).projects, BTreeSet::from(["linked".to_owned()]));
        assert_eq!(refresh_for(&env, &snapshot, &shared_change).projects, BTreeSet::from(["linked".to_owned()]));
        let desired = Watches::desired(&env, &snapshot, &BTreeSet::new());
        assert!(desired.contains(&private));
        assert!(desired.contains(&heads), "a standalone linked checkout still needs its shared refs watched");
        assert!(desired.contains(&namespaced), "large object stores cannot displace branch namespace watches");
    }

    #[test]
    fn archived_projects_still_receive_git_branch_changes() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let project = home.path().join("archive/project");
        let heads = project.join(".git/refs/heads");
        fs::create_dir_all(&heads).unwrap();
        let snapshot = json!({
            "nodes": { "archived": { "kind":"project", "path":project, "archived":true } },
            "roots": [], "connectors": []
        });
        let (sender, receiver) = mpsc::channel();
        let watcher = Watches::new(sender).unwrap();
        watcher.install(Watches::desired(&env, &snapshot, &BTreeSet::new()));
        let branch = heads.join("topic");
        fs::write(&branch, "0123456789012345678901234567890123456789\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let remaining = deadline.checked_duration_since(Instant::now()).expect("no archived Git event");
            let paths = receiver.recv_timeout(remaining).expect("no archived Git event");
            if paths.paths.contains(&branch) {
                break;
            }
        }
    }
}
