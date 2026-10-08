mod creation;
mod state;
mod terminal;
mod watch;
use laci_core::{
    Result, config,
    env::Env,
    paths,
    service::{Refresh, Service, mutates, string},
};
use serde_json::{Value, json};
use state::{Engine, RefreshQueue, Work};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, ipc::Channel};
use terminal::{Info, Output, Terminals};
use watch::{Changes, Watches};

struct AppState {
    engine: Mutex<Engine>,
    queue: Arc<RefreshQueue>,
    handle: tauri::AppHandle,
    terminals: Terminals,
    creations: creation::Creations,
    watches: Option<Watches>,
    listings: Mutex<BTreeSet<PathBuf>>,
}
type Shared = Arc<AppState>;
impl AppState {
    fn notice(&self, v: Value) {
        let _ = self.handle.emit("laci", v);
    }
    fn status(&self) -> Value {
        let engine = self.engine.lock().unwrap_or_else(|e| e.into_inner());
        json!({"type":"status","busy":self.queue.busy(),"revision":engine.revision,"historyPending":engine.history_pending})
    }
    fn snapshot(&self) -> Result<Value> {
        if let Some(snapshot) = self.engine.lock().map_err(|e| e.to_string())?.snapshot() {
            return Ok(snapshot);
        }
        self.rescan()
    }
    fn rescan(&self) -> Result<Value> {
        let ticket = self.queue.request(Refresh::full());
        self.notice(self.status());
        self.queue.wait(ticket)?;
        self.engine.lock().map_err(|e| e.to_string())?.snapshot().ok_or("No scan is available".into())
    }
    fn refresh(&self, work: Work) {
        let started = Instant::now();
        let prepared = self.engine.lock().unwrap_or_else(|e| e.into_inner()).prepare(work.refresh.clone());
        self.notice(self.status());
        let config_before = config::load(&prepared.env);
        let read = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| prepared.read()))
            .unwrap_or_else(|_| Err("The refresh was interrupted. Try Scan again.".into()));
        let (snapshot, topology) = match read {
            Ok(result) => result,
            Err(error) => {
                if self.engine.lock().is_ok_and(|e| e.revision != prepared.revision) {
                    self.queue.retry(work, prepared.refresh);
                    return;
                }
                if let Ok(engine) = self.engine.lock() {
                    engine.service.debug(&format!("refresh failed: {error}"));
                }
                self.queue.finish(work, Some(error.clone()));
                self.notice(json!({"type":"refresh-error","error":error,"revision":prepared.revision}));
                self.notice(self.status());
                return;
            }
        };
        let read_ms = started.elapsed().as_millis();
        let watches_started = Instant::now();
        let desired = if topology || prepared.refresh.watches {
            let listings = self.listings.lock().map(|l| l.clone()).unwrap_or_default();
            self.watches.as_ref().map(|_| Watches::desired(&prepared.env, &snapshot, &listings))
        } else {
            None
        };
        let watches_ms = watches_started.elapsed().as_millis();
        let config_started = Instant::now();
        if config::load(&prepared.env) != config_before {
            self.queue.retry(work, Refresh::full());
            return;
        }
        let config_ms = config_started.elapsed().as_millis();
        let revision = {
            let mut engine = self.engine.lock().unwrap_or_else(|e| e.into_inner());
            if !engine.install(&prepared, snapshot.clone()) {
                self.queue.retry(work, prepared.refresh);
                return;
            }
            let cache_started = Instant::now();
            engine.service.cache_snapshot(&snapshot);
            let cache_ms = cache_started.elapsed().as_millis();
            engine.service.debug(&format!(
                "refresh full={} agents={} projects={} read={read_ms}ms watches={watches_ms}ms config={config_ms}ms cache={cache_ms}ms",
                prepared.refresh.full || topology,
                prepared.refresh.agents,
                prepared.refresh.projects.len()
            ));
            engine.revision
        };
        self.notice(json!({"type":"snapshot"}));
        if topology {
            for node in snapshot["nodes"].as_object().into_iter().flatten().map(|(_, n)| n) {
                if node["kind"] == "project" {
                    let _ = self.handle.asset_protocol_scope().allow_directory(string(node, "path"), true);
                }
            }
        }
        if let (Some(watch), Some(desired)) = (&self.watches, desired) {
            // Watch enumeration and OS registration never hold the service lock.
            if self.engine.lock().is_ok_and(|e| e.revision == revision) {
                watch.install(desired);
            }
            if self.engine.lock().is_ok_and(|e| e.revision != revision) {
                self.queue.request(Refresh { watches: true, ..Refresh::default() });
            }
        }
        self.queue.finish(work, None);
        self.notice(self.status());
    }
    fn launch_agent(&self, body: &Value) -> Result<Value> {
        let (env, request, session, apps) = {
            let mut engine = self.engine.lock().map_err(|e| e.to_string())?;
            let (request, session) = engine.service.agent_context(body)?;
            (engine.service.env.clone(), request, session, engine.service.apps())
        };
        let command = laci_core::launch::resolve(&env, &request, session.as_ref())?;
        // A choice that could not be saved must not stop the agent from starting.
        let _ = laci_core::launch::remember(&env, &request);
        if command.target == "external" {
            laci_core::launch::external(string(&apps, "terminal"), &command)?;
            return Ok(json!({"target":"external"}));
        }
        Ok(json!({"target":"internal","terminal":self.terminals.open_launch(&command)?}))
    }
    fn request(self: &Arc<Self>, name: &str, body: &Value) -> Result<Value> {
        match name {
            "agent/models" => {
                let env = self.engine.lock().map_err(|e| e.to_string())?.service.env.clone();
                if body["passive"] == true {
                    return laci_core::launch::known(&env, string(body, "provider"));
                }
                return laci_core::launch::capabilities(
                    &env,
                    string(body, "provider"),
                    body["refresh"].as_bool().unwrap_or(false),
                );
            }
            // The agent's own program can take a while; it never runs under the engine lock.
            "agent/mcp" | "agent/mcp/apply" => {
                let env = self.engine.lock().map_err(|e| e.to_string())?.service.env.clone();
                if name == "agent/mcp" {
                    return Ok(json!({"agents":laci_core::mcp_setup::statuses(&env)}));
                }
                let result =
                    laci_core::mcp_setup::change(&env, string(body, "provider"), body["remove"] == true, "app")?;
                self.notice(json!({"type":"log"}));
                return Ok(result);
            }
            "agent/launch" => return self.launch_agent(body),
            "new/start" => {
                let env = {
                    let mut engine = self.engine.lock().map_err(|e| e.to_string())?;
                    engine.begin_creation()?;
                    engine.service.env.clone()
                };
                self.notice(self.status());
                let record_env = env.clone();
                let weak = Arc::downgrade(self);
                let project_name = string(body, "name").to_owned();
                let started = self.creations.start(env, body.clone(), move |result| {
                    if let Ok(value) = result.as_ref() {
                        laci_core::activity::record(&record_env, json!({"by":"app","title":format!("Created {project_name}"),"path":value["path"],"detail":value["warnings"]}));
                    }
                    if let Some(state) = weak.upgrade() {
                        state.engine.lock().unwrap_or_else(|e| e.into_inner()).finish_creation(result);
                        state.queue.request(Refresh::full());
                        state.notice(json!({"type":"log"}));
                        state.notice(state.status());
                    }
                });
                if let Err(error) = &started {
                    self.engine.lock().unwrap_or_else(|e| e.into_inner()).finish_creation(&mut Err(error.clone()));
                    self.queue.request(Refresh::full());
                    self.notice(self.status());
                }
                return started;
            }
            "new/status" => return self.creations.status(string(body, "id")),
            "new/cancel" => return self.creations.cancel(string(body, "id")),
            "new/current" => return self.creations.current(),
            "new/ack" => return self.creations.acknowledge(string(body, "id")),
            "new/continue" => {
                return self.creations.continue_agent(
                    string(body, "id"),
                    body["retryAttempt"].as_u64(),
                    body.get("agent"),
                    |request| self.launch_agent(request),
                );
            }
            "snapshot" => return self.snapshot(),
            "status" => return Ok(self.status()),
            "rescan" => return self.rescan(),
            "delete/plan" => {
                let (env, node) = {
                    let mut engine = self.engine.lock().map_err(|e| e.to_string())?;
                    (engine.service.env.clone(), engine.service.node(string(body, "id"))?)
                };
                // Remote verification can take time; browsing and watcher updates stay responsive.
                return laci_core::deletion::plan(&env, &node);
            }
            _ => {}
        }
        let started = Instant::now();
        let mut engine = self.engine.lock().map_err(|e| e.to_string())?;
        let waited = started.elapsed().as_millis();
        let result = engine.execute(name, body);
        if let Err(error) = &result {
            engine.service.debug(&format!("{name}: {error}"));
        }
        let outcome = result?;
        let env = engine.service.env.clone();
        if mutates(name) {
            engine.service.debug(&format!(
                "{name} committed wait={waited}ms action={}ms",
                started.elapsed().as_millis().saturating_sub(waited)
            ));
        }
        drop(engine);
        self.queue.request(outcome.refresh);
        if name == "ls" {
            let path = paths::workspace_path(string(body, "path"), &env)?;
            if self.listings.lock().map_err(|e| e.to_string())?.insert(path) {
                self.queue.request(Refresh { watches: true, ..Refresh::default() });
            }
        }
        if mutates(name) {
            self.notice(json!({"type":"snapshot"}));
            self.notice(json!({"type":"log"}));
            self.notice(self.status());
        }
        Ok(outcome.value)
    }
    fn changed(&self, changed: Changes) {
        let (env, snapshot) = {
            let engine = self.engine.lock().unwrap_or_else(|e| e.into_inner());
            (engine.service.env.clone(), engine.service.current.clone())
        };
        let Some(snapshot) = snapshot else {
            self.queue.request(Refresh::full());
            return;
        };
        let refresh = watch::refresh_for(&env, &snapshot, &changed);
        self.queue.request(refresh);
        if changed.paths.contains(&env.data_dir.join("activity.jsonl")) {
            self.notice(json!({"type":"log"}));
        }
        let listings = self.listings.lock().map(|l| l.clone()).unwrap_or_default();
        for listing in listings {
            if changed.paths.iter().any(|p| p.starts_with(&listing)) {
                self.notice(json!({"type":"ls","path":listing}));
            }
        }
    }
}
#[tauri::command]
async fn request(state: State<'_, Shared>, name: String, body: Option<Value>) -> Result<Value> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.request(&name, &body.unwrap_or_else(|| json!({}))))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn term_open(
    state: State<'_, Shared>,
    id: Option<String>,
    what: Option<String>,
    arg: Option<String>,
) -> Result<Info> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut engine = state.engine.lock().map_err(|e| e.to_string())?;
        let service = &mut engine.service;
        let (cwd, title, command, run) = if let Some(id) = id {
            let what = what.as_deref().unwrap_or("shell");
            let node = if what == "shell" { service.place(&id)? } else { service.node(&id)? };
            let (cmd, run, title) = service.action(&node, what, arg.as_deref().unwrap_or(""))?;
            (paths::workspace_path(string(&node, "path"), &service.env)?, title, cmd, run)
        } else {
            (service.env.home.clone(), "~".into(), None, false)
        };
        state.terminals.open(&cwd, &title, command, run)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn term_list(state: State<'_, Shared>) -> Vec<Info> {
    state.terminals.list()
}
#[tauri::command]
fn term_attach(state: State<'_, Shared>, id: String, output: Channel<Output>) -> Result<()> {
    state.terminals.attach(&id, output)
}
#[tauri::command]
fn term_input(state: State<'_, Shared>, id: String, data: String) -> Result<()> {
    state.terminals.input(&id, &data)
}
#[tauri::command]
fn term_resize(state: State<'_, Shared>, id: String, cols: u16, rows: u16) -> Result<()> {
    state.terminals.resize(&id, cols, rows)
}
#[tauri::command]
fn term_close(state: State<'_, Shared>, id: String) {
    state.terminals.close(&id);
}

pub fn run(env: Env) -> Result<()> {
    let theme = config::load(&env)["theme"].as_str().unwrap_or("").to_owned();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let (sender, receiver) = mpsc::channel();
            let watches = Watches::new(sender).ok();
            let service = Service::new(env);
            let queue = Arc::new(RefreshQueue::default());
            let state = Arc::new(AppState {
                engine: Mutex::new(Engine::new(service)), queue: Arc::clone(&queue),
                handle: app.handle().clone(),
                terminals: Terminals::default(), watches,
                creations: creation::Creations::default(),
                listings: Mutex::new(BTreeSet::new()),
            });
            app.manage(Arc::clone(&state));
            let script = if ["light", "dark"].contains(&theme.as_str()) {
                format!("document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.theme='{theme}'); if(document.documentElement)document.documentElement.dataset.theme='{theme}';")
            } else { String::new() };
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("laci").inner_size(1440.0, 900.0).min_inner_size(880.0, 540.0)
                .visible(false).initialization_script(script).build()?;
            let light = theme == "light" || (theme.is_empty() && window.theme().ok() == Some(tauri::Theme::Light));
            let color = if light {
                tauri::webview::Color(250, 250, 250, 255)
            } else { tauri::webview::Color(12, 12, 13, 255) };
            window.set_background_color(Some(color))?;
            window.show()?;
            let weak = Arc::downgrade(&state);
            thread::spawn(move || {
                while let Ok(first) = receiver.recv() {
                    let changed = watch::batch(&receiver, first, Duration::from_millis(900));
                    let Some(state) = weak.upgrade() else { break; };
                    state.changed(changed);
                }
            });
            let weak = Arc::downgrade(&state);
            thread::spawn(move || {
                loop {
                    let work = queue.take();
                    let Some(state) = weak.upgrade() else { break; };
                    state.refresh(work);
                }
            });
            state.queue.request(Refresh::full());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            request, term_open, term_list, term_attach, term_input, term_resize, term_close
        ])
        .build(tauri::generate_context!())
        .map_err(|e| e.to_string())?
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                handle.state::<Shared>().creations.cancel_all();
                handle.state::<Shared>().terminals.close_all();
            }
        });
    Ok(())
}
