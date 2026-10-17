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
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
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
    /// When agent history was last read because a log changed, and whether a later read is already due.
    agents_read: Mutex<(Option<Instant>, bool)>,
    /// The folder picker is open. On Linux it doesn't hold the window, so a second click could open another.
    picking: AtomicBool,
}
type Shared = Arc<AppState>;
/// While an agent works its log changes every second. Its history is read again at most this often, so a
/// long session does not keep Laci busy; a new session or a removed one is still read at once.
const AGENT_SETTLE: Duration = Duration::from_secs(15);
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
        // A reports folder that was chosen, cleared or came back needs its watch and image access.
        let folder = |s: &Value| (s["reportsDir"]["path"].clone(), s["reportsDir"]["error"].is_null());
        let reports_changed = prepared.current.as_ref().map(folder) != Some(folder(&snapshot));
        let desired = if topology || prepared.refresh.watches || reports_changed {
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
                "refresh full={} agents={} reports={} projects={} read={read_ms}ms watches={watches_ms}ms config={config_ms}ms cache={cache_ms}ms",
                prepared.refresh.full || topology,
                prepared.refresh.agents,
                prepared.refresh.reports,
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
        if (topology || reports_changed)
            && snapshot["reportsDir"]["error"].is_null()
            && let Some(dir) = snapshot["reportsDir"]["path"].as_str()
        {
            // Images a report shows from its own folder.
            let _ = self.handle.asset_protocol_scope().allow_directory(dir, true);
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
    /// The system's folder picker over the main window: `{path}`, or `{path: null}` when the user cancels.
    fn pick_folder(&self, body: &Value) -> Result<Value> {
        use tauri_plugin_dialog::DialogExt;
        // The dialog runs on the main thread while this thread waits for it. Requests arrive on a blocking worker
        // (see `request`); waiting on the main thread itself would freeze the app.
        if thread::current().name() == Some("main") {
            return Err("The folder picker can't open from the main thread".into());
        }
        let home = self.engine.lock().map_err(|e| e.to_string())?.service.env.home.clone();
        let mut picker = self.handle.dialog().file();
        if let Some(window) = self.handle.get_webview_window("main") {
            picker = picker.set_parent(&window);
        }
        if let Some(title) = body["title"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
            picker = picker.set_title(title.chars().take(100).collect::<String>());
        }
        let start = paths::expand(string(body, "defaultPath").trim(), &home);
        if start.is_absolute() && start.is_dir() {
            picker = picker.set_directory(start);
        }
        if self.picking.swap(true, Ordering::AcqRel) {
            return Err("The folder picker is already open".into());
        }
        let picked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| picker.blocking_pick_folder()));
        self.picking.store(false, Ordering::Release);
        let Some(picked) = picked.map_err(|_| "The folder picker closed unexpectedly".to_owned())? else {
            return Ok(json!({"path":null}));
        };
        let path = picked.simplified().into_path().map_err(|e| e.to_string())?;
        let path = path.to_str().ok_or("Laci can't use a folder whose name isn't valid text. Rename it first.")?;
        Ok(json!({"path":path}))
    }
    fn request(self: &Arc<Self>, name: &str, body: &Value) -> Result<Value> {
        match name {
            // The picker waits for the user, so it never holds the engine lock.
            "pick/folder" => return self.pick_folder(body),
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
            // Reading, searching or opening a report waits for no refresh and blocks none.
            "reports/read" | "reports/search" | "reports/open" => {
                let snapshot = self.snapshot()?;
                let (env, apps) = {
                    let engine = self.engine.lock().map_err(|e| e.to_string())?;
                    (engine.service.env.clone(), engine.service.apps())
                };
                return laci_core::reports::request(&env, &snapshot, &apps, name, body);
            }
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
    fn read_agents_soon(self: &Arc<Self>) {
        let mut read = self.agents_read.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        match read.0 {
            Some(at) if now < at + AGENT_SETTLE => {
                if !read.1 {
                    read.1 = true;
                    let wait = at + AGENT_SETTLE - now;
                    let weak = Arc::downgrade(self);
                    thread::spawn(move || {
                        thread::sleep(wait);
                        if let Some(state) = weak.upgrade() {
                            *state.agents_read.lock().unwrap_or_else(|e| e.into_inner()) =
                                (Some(Instant::now()), false);
                            state.queue.request(Refresh::agents());
                        }
                    });
                }
            }
            _ => {
                *read = (Some(now), false);
                self.queue.request(Refresh::agents());
            }
        }
    }
    fn changed(self: &Arc<Self>, changed: Changes) {
        let (env, snapshot) = {
            let engine = self.engine.lock().unwrap_or_else(|e| e.into_inner());
            (engine.service.env.clone(), engine.service.current.clone())
        };
        let Some(snapshot) = snapshot else {
            self.queue.request(Refresh::full());
            return;
        };
        let refresh = watch::refresh_for(&env, &snapshot, &changed);
        if refresh == Refresh::agents() {
            self.read_agents_soon();
        } else {
            self.queue.request(refresh);
        }
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
    // Every request runs on a blocking worker, never on the main thread: a long action or the folder picker
    // waits here while the window keeps drawing.
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

/// The design a new install opens in. It stays Detailed until the Simple shell ships; first run then asks, with
/// Simple preselected.
const NEW_INSTALL_DESIGN: &str = "detailed";

/// The design a window opens in: the saved one, else Detailed for a setup made before designs existed and
/// NEW_INSTALL_DESIGN for a new one.
fn startup_design(design: &str, configured: bool) -> &'static str {
    match design {
        "simple" => "simple",
        "detailed" => "detailed",
        _ if configured => "detailed",
        _ => NEW_INSTALL_DESIGN,
    }
}

/// Sets `data-theme`, `data-design`, `data-design-offer` and `data-os` on the page before it paints. A value from
/// config.json is only compared, never copied into the script. Tauri keeps this script from when the window was
/// built, so after a switch and a reload it is stale: the page asks for `prefs` to know the saved choices.
fn init_script(theme: &str, design: &str, configured: bool, os: &str) -> String {
    let mut set = Vec::new();
    if let Some(theme) = ["light", "dark"].into_iter().find(|t| *t == theme) {
        set.push(("theme", theme));
    }
    set.push(("design", startup_design(design, configured)));
    // Set up before designs existed: it stays Detailed, and the page can offer Simple until a design is saved.
    if configured && !["simple", "detailed"].contains(&design) {
        set.push(("designOffer", "1"));
    }
    if let Some(os) = ["linux", "macos", "windows"].into_iter().find(|o| *o == os) {
        set.push(("os", os));
    }
    let apply: String = set.iter().map(|(key, value)| format!("d.{key}='{value}';")).collect();
    format!(
        "(()=>{{const apply=()=>{{const d=document.documentElement.dataset;{apply}}};\
         document.addEventListener('DOMContentLoaded',apply);if(document.documentElement)apply();}})();"
    )
}

/// The window's colour before the page paints, to match the design and theme it opens in.
fn background(design: &str, light: bool) -> tauri::webview::Color {
    let (r, g, b) = match (design, light) {
        ("simple", true) => (0xFB, 0xF8, 0xF3),
        ("simple", false) => (0x18, 0x15, 0x12),
        (_, true) => (250, 250, 250),
        (_, false) => (12, 12, 13),
    };
    tauri::webview::Color(r, g, b, 255)
}

/// Room for the title bar when a new window is kept inside the work area. Tauri counts it itself on Windows.
const TITLE_BAR: f64 = if cfg!(windows) { 0.0 } else { 32.0 };

pub fn run(env: Env) -> Result<()> {
    let saved = config::load(&env);
    let (theme, configured) = (string(&saved, "theme").to_owned(), saved["roots"].is_array());
    let design = startup_design(string(&saved, "design"), configured);
    let script = init_script(&theme, string(&saved, "design"), configured, std::env::consts::OS);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Only Rust opens the folder picker; the window has no dialog permission. The plugin also replaces
        // window.alert and window.confirm in the page with calls that are refused, so the UI never uses them.
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let (sender, receiver) = mpsc::channel();
            let watches = Watches::new(sender).ok();
            let service = Service::new(env);
            let queue = Arc::new(RefreshQueue::default());
            let state = Arc::new(AppState {
                engine: Mutex::new(Engine::new(service)),
                queue: Arc::clone(&queue),
                handle: app.handle().clone(),
                terminals: Terminals::default(),
                watches,
                creations: creation::Creations::default(),
                listings: Mutex::new(BTreeSet::new()),
                agents_read: Mutex::new((None, false)),
                picking: AtomicBool::new(false),
            });
            app.manage(Arc::clone(&state));
            // 1440×900 shrinks to fit the main screen's work area, title bar included, and opens centred on it.
            // Wayland names no main screen and no work area, so there it fits the smallest screen with room for
            // panels, and the compositor places it.
            let (mut width, mut height) = (1440.0_f64, 900.0_f64);
            if app.primary_monitor().ok().flatten().is_none() {
                for monitor in app.available_monitors().unwrap_or_default() {
                    let screen = monitor.work_area().size.to_logical::<f64>(monitor.scale_factor());
                    width = width.min(screen.width - 64.0);
                    height = height.min(screen.height - TITLE_BAR - 64.0);
                }
            }
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Laci")
                .inner_size(width.max(720.0), height.max(560.0))
                .min_inner_size(720.0, 560.0)
                .prevent_overflow_with_margin(tauri::LogicalSize::new(0.0, TITLE_BAR))
                .center()
                .visible(false)
                .initialization_script(script)
                .build()?;
            let light = theme == "light" || (theme.is_empty() && window.theme().ok() == Some(tauri::Theme::Light));
            window.set_background_color(Some(background(design, light)))?;
            window.show()?;
            let weak = Arc::downgrade(&state);
            thread::spawn(move || {
                while let Ok(first) = receiver.recv() {
                    let changed = watch::batch(&receiver, first, Duration::from_millis(900));
                    let Some(state) = weak.upgrade() else {
                        break;
                    };
                    state.changed(changed);
                }
            });
            let weak = Arc::downgrade(&state);
            thread::spawn(move || {
                loop {
                    let work = queue.take();
                    let Some(state) = weak.upgrade() else {
                        break;
                    };
                    state.refresh(work);
                }
            });
            state.queue.request(Refresh::full());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            request,
            term_open,
            term_list,
            term_attach,
            term_input,
            term_resize,
            term_close
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_design_wins_and_an_earlier_setup_stays_detailed_with_an_offer() {
        assert_eq!([startup_design("simple", true), startup_design("detailed", false)], ["simple", "detailed"]);
        assert_eq!([startup_design("", true), startup_design("", false)], ["detailed", NEW_INSTALL_DESIGN]);
        let upgraded = init_script("", "", true, "linux");
        assert!(upgraded.contains("dataset;d.design='detailed';d.designOffer='1';d.os='linux';}"), "{upgraded}");
        let fresh = init_script("dark", "", false, "macos");
        assert!(
            fresh.contains(&format!("dataset;d.theme='dark';d.design='{NEW_INSTALL_DESIGN}';d.os='macos';}}")),
            "{fresh}"
        );
        let chosen = init_script("light", "simple", true, "windows");
        assert!(chosen.contains("dataset;d.theme='light';d.design='simple';d.os='windows';}"), "{chosen}");
        // Set before the first paint when the page already has a root, and again once the document is parsed.
        assert!(
            chosen.contains("document.addEventListener('DOMContentLoaded',apply);if(document.documentElement)apply();")
        );
    }

    #[test]
    fn the_startup_script_copies_no_text_from_the_config() {
        let hostile = [
            "dark';alert(1);'",
            "</script><script>alert(1)</script>",
            "x'+fetch('//example.com')+'",
            "\"};alert(1);//",
            "simple\\",
            "detailed\u{2028}",
            "Light",
            " simple",
        ];
        for value in hostile {
            for configured in [false, true] {
                assert_eq!(
                    init_script(value, value, configured, value),
                    init_script("", "", configured, ""),
                    "{value}"
                );
            }
        }
    }

    #[test]
    fn the_window_colour_follows_design_and_theme() {
        use tauri::webview::Color;
        assert_eq!(background("simple", true), Color(0xFB, 0xF8, 0xF3, 255));
        assert_eq!(background("simple", false), Color(0x18, 0x15, 0x12, 255));
        assert_eq!(background("detailed", true), Color(250, 250, 250, 255));
        assert_eq!(background("detailed", false), Color(12, 12, 13, 255));
    }
}
