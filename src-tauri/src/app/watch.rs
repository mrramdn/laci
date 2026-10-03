use laci_core::{
    env::Env,
    files,
    service::{Refresh, array, string},
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::PathBuf,
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

/// Session content changes do not invalidate unrelated project metadata.
pub fn refresh_for(env: &Env, snapshot: &Value, changes: &Changes) -> Refresh {
    let mut refresh = Refresh::default();
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
        let owner = snapshot["nodes"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, n)| n)
            .filter(|node| node["kind"] == "project" && path.starts_with(string(node, "path")))
            .max_by_key(|node| string(node, "path").len());
        if let Some(node) = owner {
            if changes.structural
                && (path == std::path::Path::new(string(node, "path"))
                    || path == &std::path::Path::new(string(node, "path")).join(".git"))
            {
                refresh.merge(Refresh::full());
            } else {
                refresh.projects.insert(string(node, "id").to_owned());
                refresh.watches |= changes.structural;
            }
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
            let git = path.join(".git");
            if git.is_dir() {
                for e in files::walk(&git, false).filter(|e| e.file_type().is_dir()).take(100) {
                    want.insert(e.path().to_owned());
                }
            } else if let Some(text) =
                files::text(&git).and_then(|s| s.strip_prefix("gitdir: ").map(|s| s.trim().to_owned()))
            {
                let actual = path.join(text);
                want.insert(actual.clone());
                want.insert(actual.join("refs"));
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
