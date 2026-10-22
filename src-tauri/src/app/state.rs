use laci_core::{
    Result,
    env::Env,
    ops::COPYING,
    service::{Refresh, RequestOutcome, Service, changes_history, mutates, runs_long},
};
use serde_json::{Value, json};
use std::sync::{Condvar, Mutex};

pub struct Engine {
    pub service: Service,
    pub revision: u64,
    pub history_pending: bool,
    history_refresh: Refresh,
    creation_running: bool,
    /// How many backups and moves of the copy of AI chats run outside the engine lock now (`service::runs_long`).
    pub long_running: u32,
}
impl Engine {
    pub fn new(mut service: Service) -> Self {
        let history_pending = service.current.is_some();
        if let Some(snapshot) = service.current.as_mut() {
            // A crash can leave the cache older than an already committed filesystem change.
            snapshot["proposals"] = json!([]);
        }
        Self {
            service,
            revision: 0,
            history_pending,
            creation_running: false,
            long_running: 0,
            history_refresh: if history_pending { Refresh::full() } else { Refresh::default() },
        }
    }
    pub fn snapshot(&self) -> Option<Value> {
        self.service.current.clone().map(|mut snapshot| {
            self.stamp(&mut snapshot);
            snapshot
        })
    }
    fn stamp(&self, value: &mut Value) {
        value["revision"] = json!(self.revision);
        value["historyPending"] = json!(self.history_pending);
    }
    pub fn execute(&mut self, name: &str, body: &Value) -> Result<RequestOutcome> {
        self.admit(name)?;
        let mut outcome = self.service.execute(name, body, "app")?;
        self.committed(name, &mut outcome);
        Ok(outcome)
    }
    /// Whether `name` may run now. Also asked of the actions that run outside the engine lock.
    pub fn admit(&self, name: &str) -> Result<()> {
        // A change waits for the change lock, which the backup or move holds, and would hold the engine meanwhile.
        if self.long_running > 0 && (mutates(name) || runs_long(name) || name == "new/start") {
            return Err(COPYING.into());
        }
        if self.creation_running && mutates(name) {
            return Err("A project is being created. Wait before changing files or settings.".into());
        }
        if self.history_pending && changes_history(name) {
            return Err("History is refreshing. Wait before changing files again.".into());
        }
        Ok(())
    }
    /// Takes in what `name` changed, whether it ran under the engine lock or outside it.
    pub fn committed(&mut self, name: &str, outcome: &mut RequestOutcome) {
        if mutates(name) {
            self.revision += 1;
            if changes_history(name) {
                self.history_pending = true;
                self.history_refresh.merge(outcome.refresh.clone());
            }
            if self.history_pending
                && let Some(snapshot) = self.service.current.as_mut()
            {
                snapshot["proposals"] = json!([]);
            }
            self.stamp(&mut outcome.value);
        }
    }
    pub fn begin_creation(&mut self) -> Result<()> {
        if self.long_running > 0 {
            return Err(COPYING.into());
        }
        if self.creation_running || self.history_pending {
            return Err(
                "History is refreshing or a project is being created. Wait before creating another project.".into()
            );
        }
        self.creation_running = true;
        self.fence_creation();
        Ok(())
    }
    pub fn finish_creation(&mut self, result: &mut Result<Value>) {
        self.creation_running = false;
        // Failed and cancelled generators also leave partial filesystem changes.
        self.fence_creation();
        if let Ok(value) = result {
            self.stamp(value);
        }
    }
    fn fence_creation(&mut self) {
        self.revision += 1;
        self.history_pending = true;
        self.history_refresh.merge(Refresh::full());
        if let Some(snapshot) = self.service.current.as_mut() {
            snapshot["proposals"] = json!([]);
        }
    }
    pub fn prepare(&self, mut refresh: Refresh) -> Prepared {
        refresh.merge(self.history_refresh.clone());
        Prepared {
            env: self.service.env.clone(),
            current: self.service.current.clone(),
            revision: self.revision,
            refresh,
        }
    }
    pub fn install(&mut self, prepared: &Prepared, mut snapshot: Value) -> bool {
        if self.revision != prepared.revision {
            return false;
        }
        self.revision += 1;
        if self.creation_running {
            snapshot["proposals"] = json!([]);
        }
        self.service.current = Some(snapshot);
        self.history_pending = self.creation_running;
        if !self.creation_running {
            self.history_refresh = Refresh::default();
        }
        true
    }
}

pub struct Prepared {
    pub env: Env,
    pub current: Option<Value>,
    pub revision: u64,
    pub refresh: Refresh,
}
impl Prepared {
    pub fn read(&self) -> Result<(Value, bool)> {
        self.refresh.read(&self.env, self.current.clone())
    }
}

#[derive(Default)]
struct Pending {
    refresh: Refresh,
    requested: u64,
    completed: u64,
    running: bool,
    error: Option<String>,
}
#[derive(Default)]
pub struct RefreshQueue {
    state: Mutex<Pending>,
    wake: Condvar,
}
pub struct Work {
    pub refresh: Refresh,
    ticket: u64,
}
impl RefreshQueue {
    pub fn request(&self, refresh: Refresh) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if refresh.needed() {
            state.refresh.merge(refresh);
            state.requested += 1;
            self.wake.notify_all();
        }
        state.requested
    }
    pub fn take(&self) -> Work {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while !state.refresh.needed() {
            state = self.wake.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.running = true;
        Work { refresh: std::mem::take(&mut state.refresh), ticket: state.requested }
    }
    pub fn retry(&self, work: Work, refresh: Refresh) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.refresh.merge(work.refresh);
        state.refresh.merge(refresh);
        state.running = false;
        self.wake.notify_all();
    }
    pub fn finish(&self, work: Work, error: Option<String>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.completed = work.ticket;
        state.error = error;
        state.running = false;
        self.wake.notify_all();
    }
    pub fn wait(&self, ticket: u64) -> Result<()> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        while state.completed < ticket {
            state = self.wake.wait(state).map_err(|e| e.to_string())?;
        }
        state.error.clone().map_or(Ok(()), Err)
    }
    pub fn busy(&self) -> bool {
        self.state.lock().map(|s| s.running || s.refresh.needed()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{Arc, mpsc},
        thread,
        time::Duration,
    };

    fn engine() -> (tempfile::TempDir, Engine, String) {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let orphan = home.path().join(".claude/projects/orphan");
        fs::create_dir_all(&orphan).unwrap();
        fs::write(orphan.join("session.jsonl"), "original history").unwrap();
        let id = "orphan:test".to_owned();
        let mut service = Service::new(env);
        service.current = Some(json!({"nodes":{},"proposals":[{
            "id":id,"title":"Quarantine test history","action":{"type":"quarantine",
                "moves":[{"from":orphan,"to":"claude/orphan"}]}
        }]}));
        let snapshot = service.current.clone().unwrap();
        let mut engine = Engine::new(service);
        let initial = engine.prepare(Refresh::full());
        assert!(engine.install(&initial, snapshot));
        (home, engine, id)
    }

    #[test]
    fn creation_fences_mutations_and_prevents_failure_or_running_scans_from_restoring_proposals() {
        let (_home, mut engine, _) = engine();
        let before = engine.prepare(Refresh::full());
        engine.begin_creation().unwrap();
        assert!(!engine.install(&before, json!({"nodes":{},"proposals":[{"id":"stale"}]})));
        assert!(engine.begin_creation().is_err());
        // This must fail before entering the global file-change lock held by the generator.
        assert!(engine.execute("theme", &json!({"theme":"dark"})).unwrap_err().contains("being created"));
        assert!(engine.execute("design", &json!({"design":"simple"})).unwrap_err().contains("being created"));
        assert!(engine.execute("log", &json!({})).is_ok());
        assert!(engine.execute("prefs", &json!({})).is_ok());
        let running = engine.prepare(Refresh::full());
        assert!(engine.install(&running, json!({"nodes":{},"proposals":[{"id":"partial"}]})));
        assert!(engine.history_pending);
        assert_eq!(engine.snapshot().unwrap()["proposals"], json!([]));
        let partial = engine.prepare(Refresh::full());
        engine.finish_creation(&mut Err("Generator failed after writing partial output".into()));
        assert!(!engine.install(&partial, json!({"nodes":{},"proposals":[]})));
        let complete = engine.prepare(Refresh::full());
        assert!(engine.install(&complete, json!({"nodes":{},"proposals":[]})));
        assert!(!engine.history_pending);
        assert!(engine.begin_creation().is_ok());
    }

    /// A backup or a move of the copy of AI chats holds the change lock for minutes, outside the engine. A change
    /// asked for meanwhile is refused at once instead of waiting for that lock with the engine held.
    #[test]
    fn changes_are_refused_at_once_while_the_copy_of_ai_chats_is_copied() {
        let (_home, mut engine, _) = engine();
        engine.long_running = 1;
        for name in ["theme", "todo", "setup/save", "backup/move", "backup"] {
            assert_eq!(engine.admit(name), Err(laci_core::ops::COPYING.into()), "{name}");
        }
        assert!(engine.execute("theme", &json!({"theme":"dark"})).unwrap_err().contains("copying your AI chats"));
        assert_eq!(engine.begin_creation(), Err(laci_core::ops::COPYING.into()));
        assert!(engine.execute("log", &json!({})).is_ok());
        engine.long_running = 0;
        assert!(engine.admit("theme").is_ok());
    }

    #[test]
    fn cached_startup_preserves_read_views_but_fences_history_until_a_full_refresh() {
        let (_home, previous, id) = engine();
        let snapshot = previous.service.current.clone().unwrap();
        let mut restarted = Engine::new(previous.service);
        assert_eq!(restarted.snapshot().unwrap()["nodes"], snapshot["nodes"]);
        assert!(restarted.history_pending);
        assert!(restarted.execute("log", &json!({})).is_ok());
        assert!(restarted.execute("apply", &json!({"id":id})).is_err());
        let refresh = restarted.prepare(Refresh::agents());
        assert!(refresh.refresh.full, "a narrow refresh cannot validate the cached project graph");
        assert!(restarted.install(&refresh, snapshot));
        assert!(!restarted.history_pending);
        assert!(restarted.execute("apply", &json!({"id":id})).is_ok());
    }

    #[test]
    fn a_committed_action_does_not_wait_for_background_scan_and_stale_results_cannot_restore_proposals() {
        let (_home, engine, id) = engine();
        let shared = Arc::new(Mutex::new(engine));
        let worker = Arc::clone(&shared);
        let (ready, started) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let background = thread::spawn(move || {
            let prepared = worker.lock().unwrap().prepare(Refresh::full());
            ready.send(()).unwrap();
            wait.recv().unwrap();
            let old = prepared.current.clone().unwrap();
            worker.lock().unwrap().install(&prepared, old)
        });
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let result = shared.lock().unwrap().execute("apply", &json!({"id":id})).unwrap();
        assert_eq!(result.value["journal"]["state"], "applied");
        assert!(result.value.get("snapshot").is_none());
        assert_eq!(result.value["historyPending"], true);
        release.send(()).unwrap();
        assert!(!background.join().unwrap(), "old scan replaced a committed action");
        let mut engine = shared.lock().unwrap();
        assert!(engine.service.current.as_ref().unwrap()["proposals"].as_array().unwrap().is_empty());
        assert!(engine.execute("apply", &json!({"id":id})).unwrap_err().contains("History is refreshing"));
        let fresh = engine.prepare(Refresh::agents());
        assert!(engine.install(&fresh, json!({"nodes":{},"proposals":[]})));
        assert!(!engine.history_pending);
    }

    #[test]
    fn pending_events_coalesce_without_invalidating_a_useful_scan() {
        let (_home, mut engine, _) = engine();
        let queue = RefreshQueue::default();
        queue.request(Refresh::agents());
        let first = queue.take();
        let prepared = engine.prepare(first.refresh.clone());
        for _ in 0..100 {
            queue.request(Refresh::agents());
        }
        assert!(engine.install(&prepared, json!({"nodes":{},"proposals":[]})));
        queue.finish(first, None);
        let next = queue.take();
        assert_eq!(next.refresh, Refresh::agents());
        queue.finish(next, None);
        assert!(!queue.busy());
    }

    #[test]
    fn a_failed_refresh_keeps_the_history_fence_until_a_successful_retry() {
        let (_home, mut engine, id) = engine();
        engine.execute("apply", &json!({"id":id})).unwrap();
        let queue = RefreshQueue::default();
        let ticket = queue.request(Refresh::agents());
        let failed = queue.take();
        queue.finish(failed, Some("Cannot read history".into()));
        assert!(queue.wait(ticket).is_err());
        assert!(engine.history_pending);
        let retry = engine.prepare(Refresh::full());
        assert!(engine.install(&retry, json!({"nodes":{},"proposals":[]})));
        assert!(!engine.history_pending);
    }
}
