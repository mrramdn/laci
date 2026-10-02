mod terminal;
mod watch;
use laci_core::{
    Result, config,
    env::Env,
    paths, scan,
    service::{Service, array, string},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, ipc::Channel};
use terminal::{Info, Output, Terminals};
use watch::Watches;

struct AppState {
    engine: Mutex<Service>,
    latest: Mutex<Option<Value>>,
    busy: AtomicBool,
    handle: tauri::AppHandle,
    terminals: Terminals,
    watches: Option<Watches>,
    listings: Mutex<BTreeSet<PathBuf>>,
}
type Shared = Arc<AppState>;
impl AppState {
    fn notice(&self, v: Value) {
        let _ = self.handle.emit("laci", v);
    }
    fn sync(&self, service: &Service) {
        if let Some(snapshot) = &service.current {
            for node in snapshot["nodes"].as_object().into_iter().flatten().map(|(_, n)| n) {
                if node["kind"] == "project" {
                    let _ = self.handle.asset_protocol_scope().allow_directory(string(node, "path"), true);
                }
            }
        }
        if let Some(watch) = &self.watches
            && let Some(s) = &service.current
        {
            let listings = self.listings.lock().map(|l| l.clone()).unwrap_or_default();
            watch.sync(&service.env, s, &listings);
        }
    }
    fn rescan(&self) -> Result<Value> {
        self.busy.store(true, Ordering::Relaxed);
        self.notice(json!({"type":"status","busy":true}));
        let result = (|| {
            let mut service = self.engine.lock().map_err(|e| e.to_string())?;
            let snapshot = service.rescan()?;
            *self.latest.lock().map_err(|e| e.to_string())? = Some(snapshot.clone());
            self.sync(&service);
            Ok(snapshot)
        })();
        self.busy.store(false, Ordering::Relaxed);
        self.notice(json!({"type":"status","busy":false}));
        if result.is_ok() {
            self.notice(json!({"type":"snapshot"}));
        }
        result
    }
    fn request(&self, name: &str, body: &Value) -> Result<Value> {
        if name == "snapshot" {
            if let Some(s) = self.latest.lock().map_err(|e| e.to_string())?.clone() {
                return Ok(s);
            }
            return self.rescan();
        }
        if name == "status" {
            return Ok(json!({"busy":self.busy.load(Ordering::Relaxed)}));
        }
        if name == "rescan" {
            return self.rescan();
        }
        let mut service = self.engine.lock().map_err(|e| e.to_string())?;
        let reply = service.request(name, body);
        if let Err(e) = &reply {
            service.debug(&format!("{name}: {e}"));
        }
        if reply.is_ok() {
            *self.latest.lock().map_err(|e| e.to_string())? = service.current.clone();
            if name == "ls" {
                let path = paths::home_path(string(body, "path"), &service.env)?;
                self.listings.lock().map_err(|e| e.to_string())?.insert(path);
                self.sync(&service);
            }
            if !matches!(
                name,
                "ls" | "ls/newest"
                    | "apps"
                    | "setup/info"
                    | "new/info"
                    | "log"
                    | "log/open"
                    | "open"
                    | "open/url"
                    | "theme"
            ) {
                self.sync(&service);
                self.notice(json!({"type":"snapshot"}));
                self.notice(json!({"type":"log"}));
            }
        }
        reply
    }
    fn changed(&self, changed: Vec<PathBuf>) {
        let cached = self.latest.lock().ok().and_then(|s| s.clone());
        let Some(snapshot) = cached else {
            let _ = self.rescan();
            return;
        };
        let mut projects = BTreeSet::new();
        let mut all = false;
        let mut log = false;
        let config = self.engine.lock().ok().map(|s| s.env.clone());
        let Some(env) = config else {
            return;
        };
        if std::env::var_os("LACI_DEBUG").is_some()
            && let Ok(service) = self.engine.lock()
        {
            service.debug(&format!("watch: {} changed paths", changed.len()));
        }
        for path in &changed {
            if path == &env.data_dir.join("activity.jsonl") {
                log = true;
                continue;
            }
            if path.starts_with(&env.data_dir) {
                continue;
            }
            if path.starts_with(&env.config_dir) {
                all = true;
                continue;
            }
            if array(&snapshot["connectors"]).iter().any(|c| {
                c["link"]["dir"]
                    .as_str()
                    .is_some_and(|d| path.starts_with(d) || std::path::Path::new(d).starts_with(path))
            }) {
                all = true;
                continue;
            }
            let owner = snapshot["nodes"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(_, n)| n)
                .filter(|n| n["kind"] == "project" && path.starts_with(string(n, "path")))
                .max_by_key(|n| string(n, "path").len());
            if let Some(n) = owner {
                projects.insert(string(n, "id").to_owned());
            } else if array(&snapshot["roots"]).iter().filter_map(Value::as_str).any(|r| path.starts_with(r)) {
                all = true;
            }
        }
        if all {
            let _ = self.rescan();
        } else if !projects.is_empty() {
            let updated = (|| -> Result<()> {
                let mut service = self.engine.lock().map_err(|e| e.to_string())?;
                let env = service.env.clone();
                if let Some(snapshot) = service.current.as_mut() {
                    for id in projects {
                        scan::refresh(&env, snapshot, &id)?;
                    }
                }
                *self.latest.lock().map_err(|e| e.to_string())? = service.current.clone();
                self.sync(&service);
                Ok(())
            })();
            if updated.is_err() {
                let _ = self.rescan();
            } else {
                self.notice(json!({"type":"snapshot"}));
            }
        }
        if log {
            self.notice(json!({"type":"log"}));
        }
        let listings = self.listings.lock().map(|l| l.clone()).unwrap_or_default();
        for listing in listings {
            if changed.iter().any(|p| p.starts_with(&listing)) {
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
        let mut service = state.engine.lock().map_err(|e| e.to_string())?;
        let (cwd, title, command, run) = if let Some(id) = id {
            let what = what.as_deref().unwrap_or("shell");
            let node = if what == "shell" { service.place(&id)? } else { service.node(&id)? };
            let (cmd, run, title) = service.action(&node, what, arg.as_deref().unwrap_or(""))?;
            (paths::home_path(string(&node, "path"), &service.env)?, title, cmd, run)
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
            let latest = service.current.clone();
            let state = Arc::new(AppState {
                engine: Mutex::new(service), latest: Mutex::new(latest),
                busy: AtomicBool::new(false), handle: app.handle().clone(),
                terminals: Terminals::default(), watches,
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
            thread::spawn(move || { let _ = state.rescan(); });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            request, term_open, term_list, term_attach, term_input, term_resize, term_close
        ])
        .build(tauri::generate_context!())
        .map_err(|e| e.to_string())?
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                handle.state::<Shared>().terminals.close_all();
            }
        });
    Ok(())
}
