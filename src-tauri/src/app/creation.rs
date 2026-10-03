//! Creation jobs do not hold the snapshot mutex while a generator runs.
use laci_core::{Result, create, env::Env, files};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

struct Job {
    state: Value,
    cancel: Arc<AtomicBool>,
}
#[derive(Default)]
pub struct Creations {
    jobs: Arc<Mutex<Vec<Job>>>,
    workers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    stopping: AtomicBool,
}
impl Creations {
    pub fn start(
        &self,
        env: Env,
        request: Value,
        finished: impl FnOnce(&mut Result<Value>) + Send + 'static,
    ) -> Result<Value> {
        let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
        if self.stopping.load(Ordering::Relaxed) {
            return Err("Laci is closing".into());
        }
        if jobs.iter().any(|j| j.state["status"] == "running") {
            return Err("A project is already being created. Wait for it to finish.".into());
        }
        let id = format!(
            "create-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let state = json!({"id":id,"status":"running","output":"","from":request["from"],"startedAt":files::now()});
        jobs.retain(|j| j.state["status"] == "running");
        jobs.push(Job { state: state.clone(), cancel: Arc::clone(&cancel) });
        // Register the worker while holding the jobs lock so shutdown cannot miss it.
        let mut workers = self.workers.lock().map_err(|e| e.to_string())?;
        let worker_jobs = Arc::clone(&self.jobs);
        let worker_id = id.clone();
        let worker = std::thread::Builder::new().name("laci-create".into()).spawn(move || {
            let jobs = worker_jobs;
            let id = worker_id;
            let mut result = create::create_with_progress(&env, &request, &cancel, &|line| {
                if let Ok(mut jobs) = jobs.lock()
                    && let Some(job) = jobs.iter_mut().find(|j| j.state["id"] == id)
                {
                    let mut output = job.state["output"].as_str().unwrap_or("").to_owned();
                    output.push_str(line);
                    if output.len() > 65_536 {
                        let mut cut = output.len() - 65_536;
                        while !output.is_char_boundary(cut) {
                            cut += 1;
                        }
                        output.drain(..cut);
                    }
                    job.state["output"] = json!(output);
                }
            });
            finished(&mut result);
            let value = match result {
                Ok(result) => json!({"status":"completed","result":result}),
                Err(error) => {
                    json!({"status":if cancel.load(Ordering::Relaxed) {"cancelled"} else {"failed"},"error":error})
                }
            };
            if let Ok(mut jobs) = jobs.lock()
                && let Some(job) = jobs.iter_mut().find(|j| j.state["id"] == id)
            {
                for (key, value) in value.as_object().unwrap() {
                    job.state[key] = value.clone();
                }
            }
        });
        let worker = match worker {
            Ok(worker) => worker,
            Err(error) => {
                jobs.retain(|j| j.state["id"] != id);
                return Err(format!("Couldn't start creation: {error}"));
            }
        };
        workers.retain(|worker| !worker.is_finished());
        workers.push(worker);
        Ok(state)
    }
    pub fn status(&self, id: &str) -> Result<Value> {
        self.jobs
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .find(|j| j.state["id"] == id)
            .map(|j| j.state.clone())
            .ok_or("That creation job is no longer available".into())
    }
    pub fn cancel(&self, id: &str) -> Result<Value> {
        let jobs = self.jobs.lock().map_err(|e| e.to_string())?;
        let job = jobs.iter().find(|j| j.state["id"] == id).ok_or("Unknown creation job")?;
        if job.state["status"] == "running" && job.state["from"] == "generator" {
            job.cancel.store(true, Ordering::Relaxed);
        }
        Ok(job.state.clone())
    }
    pub fn cancel_all(&self) {
        self.stopping.store(true, Ordering::Relaxed);
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.iter() {
                job.cancel.store(true, Ordering::Relaxed);
            }
        }
        // Let the owner reap its process group before the desktop process exits.
        if let Ok(mut workers) = self.workers.lock() {
            for worker in workers.drain(..) {
                let _ = worker.join();
            }
        }
    }
}
