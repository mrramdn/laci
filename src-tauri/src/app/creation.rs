//! Creation jobs do not hold the snapshot mutex while a generator runs.
use laci_core::{Result, create, env::Env, files};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

fn agent_request(draft: &Value, path: &Value) -> Result<Value> {
    if !draft.is_object() {
        return Err("Choose an agent to launch".into());
    }
    let mut request = draft.clone();
    if request["model"] == "custom" {
        let model = request["customModel"].as_str().unwrap_or("").trim();
        if model.is_empty() {
            return Err("Enter a custom model ID or choose Default.".into());
        }
        request["model"] = json!(model);
    }
    request["projectPath"] = path.clone();
    request["sessionId"] = Value::Null;
    laci_core::launch::LaunchRequest::from_value(&request)?;
    Ok(request)
}

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
        let continuation = if request["agent"].is_null() {
            Value::Null
        } else {
            let agent = agent_request(&request["agent"], &Value::Null)?;
            // A project is not created for an agent that cannot be started afterwards.
            laci_core::providers::get(&env, agent["provider"].as_str().unwrap_or(""))?;
            json!({"status":"pending","attempt":0})
        };
        let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
        if self.stopping.load(Ordering::Relaxed) {
            return Err("Laci is closing".into());
        }
        if jobs.iter().any(|j| j.state["acknowledged"] != true) {
            return Err("Finish or dismiss the previous creation before starting another project.".into());
        }
        let id = format!(
            "create-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let state = json!({"id":id,"status":"running","output":"","from":request["from"],"startedAt":files::now(),"request":request,"continuation":continuation,"acknowledged":false});
        jobs.clear();
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
    pub fn current(&self) -> Result<Value> {
        Ok(self
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .find(|j| j.state["acknowledged"] != true)
            .map(|j| j.state.clone())
            .unwrap_or(Value::Null))
    }
    pub fn acknowledge(&self, id: &str) -> Result<Value> {
        let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
        let job = jobs.iter_mut().find(|j| j.state["id"] == id).ok_or("Unknown creation job")?;
        if job.state["status"] == "running" || job.state["continuation"]["status"] == "running" {
            return Err("Wait for creation and agent launch to finish first".into());
        }
        job.state["acknowledged"] = json!(true);
        Ok(job.state.clone())
    }
    pub fn continue_agent(
        &self,
        id: &str,
        retry_attempt: Option<u64>,
        agent: Option<&Value>,
        launch: impl FnOnce(&Value) -> Result<Value>,
    ) -> Result<Value> {
        let request = {
            let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
            let job = jobs.iter_mut().find(|j| j.state["id"] == id).ok_or("Unknown creation job")?;
            let continuation = &job.state["continuation"];
            let retry = continuation["status"] == "failed"
                && retry_attempt.is_some()
                && retry_attempt == continuation["attempt"].as_u64();
            if job.state["acknowledged"] == true
                || job.state["status"] != "completed"
                || (continuation["status"] != "pending" && !retry)
            {
                return Ok(job.state.clone());
            }
            let draft =
                if retry { agent.unwrap_or(&job.state["request"]["agent"]) } else { &job.state["request"]["agent"] };
            let request = agent_request(draft, &job.state["result"]["path"])?;
            let draft = draft.clone();
            let attempt = continuation["attempt"].as_u64().unwrap_or(0) + 1;
            job.state["request"]["agent"] = draft;
            // Claim before releasing the lock; WebView reloads can repeat this request.
            job.state["continuation"] = json!({"status":"running","attempt":attempt});
            request
        };
        let result = launch(&request);
        let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
        let job = jobs.iter_mut().find(|j| j.state["id"] == id).ok_or("Unknown creation job")?;
        let continuation = &mut job.state["continuation"];
        match result {
            Ok(value) => {
                continuation["status"] = json!("completed");
                continuation["result"] = value;
            }
            Err(error) => {
                continuation["status"] = json!("failed");
                continuation["error"] = json!(error);
            }
        }
        Ok(job.state.clone())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn completed() -> Creations {
        let jobs = Creations::default();
        jobs.jobs.lock().unwrap().push(Job {
            state: json!({
                "id":"test", "status":"completed", "acknowledged":false,
                "request":{"name":"project","agent":{"provider":"codex","prompt":"literal\n$HOME","target":"internal"}},
                "result":{"path":"/fixture/project"},
                "continuation":{"status":"pending","attempt":0}
            }),
            cancel: Arc::new(AtomicBool::new(false)),
        });
        jobs
    }

    #[test]
    fn reload_discovers_request_until_explicit_acknowledgement() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let jobs = Creations::default();
        let (entered, running) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let request =
            json!({"name":"invalid/name","from":"generator","agent":{"provider":"codex","prompt":"preserve this"}});
        let started = jobs
            .start(env.clone(), request.clone(), move |_| {
                entered.send(()).unwrap();
                wait.recv().unwrap();
            })
            .unwrap();
        running.recv().unwrap();
        let id = started["id"].as_str().unwrap();
        assert_eq!(jobs.current().unwrap()["request"], request);
        assert_eq!(jobs.current().unwrap()["id"], id);
        assert!(jobs.acknowledge(id).is_err());
        assert!(jobs.start(env.clone(), request.clone(), |_| {}).is_err());
        jobs.cancel(id).unwrap();
        assert!(jobs.jobs.lock().unwrap()[0].cancel.load(Ordering::Relaxed));
        release.send(()).unwrap();
        for worker in jobs.workers.lock().unwrap().drain(..) {
            worker.join().unwrap();
        }
        assert_eq!(jobs.current().unwrap()["status"], "cancelled");
        assert!(jobs.start(env, request, |_| {}).is_err());
        jobs.acknowledge(id).unwrap();
        assert!(jobs.current().unwrap().is_null());

        let pending = completed();
        pending.acknowledge("test").unwrap();
        pending.continue_agent("test", None, None, |_| panic!("dismissed continuation must not launch")).unwrap();
    }

    #[test]
    fn concurrent_continuation_claims_launch_once_and_caches_terminal() {
        let jobs = Arc::new(completed());
        let (entered, running) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let worker_jobs = Arc::clone(&jobs);
        let worker = std::thread::spawn(move || {
            worker_jobs
                .continue_agent("test", None, None, |request| {
                    assert_eq!(request["projectPath"], "/fixture/project");
                    assert_eq!(request["prompt"], "literal\n$HOME");
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok(json!({"target":"internal","terminal":{"id":"pty-once"}}))
                })
                .unwrap()
        });
        running.recv().unwrap();
        assert_eq!(jobs.current().unwrap()["continuation"]["status"], "running");
        assert!(jobs.acknowledge("test").is_err());
        let duplicate = jobs.continue_agent("test", None, None, |_| panic!("duplicate launch")).unwrap();
        assert_eq!(duplicate["continuation"]["status"], "running");
        let home = tempfile::tempdir().unwrap();
        assert!(jobs.start(Env::for_home(home.path().to_owned()), json!({}), |_| {}).is_err());
        release.send(()).unwrap();
        let result = worker.join().unwrap();
        for retry in [None, Some(1)] {
            let cached = jobs.continue_agent("test", retry, None, |_| panic!("completed launch repeated")).unwrap();
            assert_eq!(cached, result);
            assert_eq!(cached["continuation"]["result"]["terminal"]["id"], "pty-once");
        }
        assert_eq!(jobs.current().unwrap(), result);
    }

    #[test]
    fn retry_requires_failed_attempt_and_keeps_created_project() {
        let jobs = completed();
        let failed = jobs.continue_agent("test", None, None, |_| Err("CLI missing".into())).unwrap();
        for retry in [None, Some(0)] {
            assert_eq!(jobs.continue_agent("test", retry, None, |_| panic!("implicit retry")).unwrap(), failed);
        }
        let agent = json!({"provider":"claude","model":"custom","customModel":"a-model","projectPath":"/untrusted","sessionId":"untrusted"});
        let failed_again = jobs
            .continue_agent("test", Some(1), Some(&agent), |request| {
                assert_eq!(request["projectPath"], "/fixture/project");
                assert!(request["sessionId"].is_null());
                assert_eq!(request["model"], "a-model");
                Err("still missing".into())
            })
            .unwrap();
        assert_eq!(failed_again["continuation"]["attempt"], 2);
        assert_eq!(failed_again["result"], failed["result"]);
        assert_eq!(failed_again["request"]["agent"], agent);
        assert_eq!(jobs.continue_agent("test", Some(1), None, |_| panic!("stale retry")).unwrap(), failed_again);
        let done = jobs.continue_agent("test", Some(2), None, |_| Ok(json!({"target":"external"}))).unwrap();
        assert_eq!(done["continuation"]["status"], "completed");
        assert_eq!(done["continuation"]["attempt"], 3);
        assert_eq!(done["result"], failed["result"]);
        let home = tempfile::tempdir().unwrap();
        assert!(jobs.start(Env::for_home(home.path().to_owned()), json!({}), |_| {}).is_err());
    }
}
