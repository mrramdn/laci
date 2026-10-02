use laci_core::{
    env::Env,
    files,
    service::{array, string},
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Mutex, mpsc},
    time::{Duration, Instant},
};

pub fn batch(receiver: &mpsc::Receiver<Vec<PathBuf>>, first: Vec<PathBuf>, window: Duration) -> Vec<PathBuf> {
    let deadline = Instant::now() + window;
    let mut changed: BTreeSet<_> = first.into_iter().collect();
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(remaining) {
            Ok(paths) => changed.extend(paths),
            Err(_) => break,
        }
    }
    changed.into_iter().collect()
}

pub struct Watches {
    inner: Mutex<(RecommendedWatcher, BTreeSet<PathBuf>)>,
}
impl Watches {
    pub fn new(sender: mpsc::Sender<Vec<PathBuf>>) -> Result<Self, String> {
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            if let Ok(event) = result {
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                let paths: Vec<_> = event
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
                    let _ = sender.send(paths);
                }
            }
        })
        .map_err(|e| e.to_string())?;
        Ok(Self { inner: Mutex::new((watcher, BTreeSet::new())) })
    }
    pub fn sync(&self, env: &Env, snapshot: &Value, listings: &BTreeSet<PathBuf>) {
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
        want = want.into_iter().filter(|p| p.is_dir()).take(12_000).collect();
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
                if sender.send(vec![streamed.clone()]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
        });
        let started = Instant::now();
        let changed = batch(&receiver, vec![repeated.clone()], Duration::from_millis(80));
        let elapsed = started.elapsed();
        stop.store(true, Ordering::Relaxed);
        producer.join().unwrap();
        assert!(elapsed < Duration::from_secs(1), "continuous writes postponed the batch: {elapsed:?}");
        assert_eq!(changed, vec![repeated]);
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
        watcher.sync(&env, &snapshot, &BTreeSet::new());
        let branch = heads.join("topic");
        fs::write(&branch, "0123456789012345678901234567890123456789\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let remaining = deadline.checked_duration_since(Instant::now()).expect("no archived Git event");
            let paths = receiver.recv_timeout(remaining).expect("no archived Git event");
            if paths.contains(&branch) {
                break;
            }
        }
    }
}
