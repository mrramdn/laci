//! In-app updates. Only this module talks to the updater: the window asks through the `update/*` requests and keeps
//! `core:default`. Laci looks for a new version by itself only when config.json says `updates: "daily"`, at most once
//! a day, and it downloads and installs one only after a click. A copy that a package manager, a script or a portable
//! folder put in place gets a link to the release instead.
use super::{AppState, creation::Creations, state::Engine};
use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use laci_core::{Result, config, env::Env, files, service::mutates};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    Manager,
    utils::{config::BundleType, platform::bundle_type},
};
use tauri_plugin_updater::{Error as UpdaterError, Update, Updater, UpdaterExt};

/// Where each version's notes are, for the link the window shows.
const RELEASES: &str = "https://github.com/mrramdn/laci/releases";
/// Replaces the feed of tauri.conf.json, to try a release candidate.
const ENDPOINT: &str = "LACI_UPDATE_ENDPOINT";
/// The first look waits for the first scan to settle. Later ones come every hour and go out once a day has passed.
const FIRST_LOOK: Duration = Duration::from_secs(20);
const LOOK_AGAIN: Duration = Duration::from_secs(60 * 60);
/// How long an update or a restart waits for a change to finish before it refuses.
const BUSY_WAIT: Duration = Duration::from_secs(2);
/// Every progress event carries the notes, so very long ones are cut.
const NOTES_LIMIT: usize = 20_000;
const OFFLINE: &str = "Laci couldn't reach the update server. Check the connection and try again.";
const BUSY: &str = "Laci is busy with a change. Update when it's done.";
const CLOSING: &str = "Laci is restarting to finish an update.";
const LINK_ONLY: &str = "This copy of Laci can't install updates itself. Get the new version from the release page.";

/// How this copy of Laci gets a new version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Install {
    /// Laci downloads and installs it after a click.
    Click,
    /// The window links to the release: a package manager, a script or a portable folder owns this copy, or macOS
    /// runs it from a place Laci can't replace.
    Notice,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    /// Installed, or on Windows downloaded and checked: a restart finishes it.
    Ready,
    Error,
}

/// What `update/status` answers, and what the `update` event carries.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    enabled: bool,
    state: Phase,
    current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
    install: Install,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked_at: Option<String>,
}

/// A newer version a check found.
struct Found {
    version: String,
    notes: Option<String>,
    date: Option<String>,
    /// What downloads and installs it. The state tests' releases have none.
    update: Option<Update>,
}
impl Found {
    fn new(update: Update) -> Self {
        let date = update.raw_json["pub_date"]
            .as_str()
            .and_then(|date| DateTime::parse_from_rfc3339(date).ok())
            .map(|date| date.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Secs, true));
        let notes = update.body.as_deref().map(|notes| {
            let mut cut = notes.len().min(NOTES_LIMIT);
            while !notes.is_char_boundary(cut) {
                cut -= 1;
            }
            if cut < notes.len() { format!("{}…", &notes[..cut]) } else { notes.to_owned() }
        });
        Self { version: update.version.clone(), notes, date, update: Some(update) }
    }
}

/// What a check learned.
enum Outcome {
    /// Boxed: the plugin's update is large next to the other answers.
    Newer(Box<Found>),
    /// Nothing newer. The plugin answers a 404, or any status that isn't a success, with ReleaseNotFound, and a
    /// feed with no build for this computer with TargetsNotFound: there is nothing to install either way. Release
    /// candidates come before `releases/latest` has a feed at all.
    Latest,
    /// No answer reached Laci.
    Offline,
    /// The answer couldn't be used.
    Failed(String),
}
fn outcome(result: std::result::Result<Option<Update>, UpdaterError>) -> Outcome {
    match result {
        Ok(Some(update)) => Outcome::Newer(Box::new(Found::new(update))),
        Ok(None)
        | Err(UpdaterError::ReleaseNotFound | UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_)) => {
            Outcome::Latest
        }
        Err(UpdaterError::Reqwest(error)) if error.is_connect() || error.is_timeout() || error.is_request() => {
            Outcome::Offline
        }
        Err(error) => Outcome::Failed(error.to_string()),
    }
}

#[derive(Default)]
struct Inner {
    phase: Phase,
    found: Option<Found>,
    progress: Option<u8>,
    error: Option<String>,
    checked_at: Option<String>,
    /// Windows: the checked installer. It runs at the restart, because it ends Laci.
    installer: Option<Vec<u8>>,
}

pub struct Updates {
    env: Env,
    /// When Laci last looked. A cache file and not config.json, so a look adds nothing to the Log.
    cache: PathBuf,
    current: String,
    install: Install,
    inner: Mutex<Inner>,
    /// One check at a time. It holds when the last one ended and whether the user asked for it: a check that waited
    /// for another one takes that answer, unless it would hide a failure the user should see.
    checking: Mutex<Option<(Instant, bool)>>,
    /// Wakes the daily look at once: the user just chose it.
    wake: Arc<(Mutex<bool>, Condvar)>,
    /// The restart that finishes an update is under way: no change may start now.
    closing: AtomicBool,
}

impl Updates {
    pub fn new(env: &Env, current: String, install: Install) -> Self {
        let cache = env.cache_dir.join("updates.json");
        let checked_at = files::text(&cache)
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|saved| saved["checkedAt"].as_str().map(str::to_owned))
            .filter(|at| DateTime::parse_from_rfc3339(at).is_ok());
        Self {
            env: env.clone(),
            cache,
            current,
            install,
            inner: Mutex::new(Inner { checked_at, ..Inner::default() }),
            checking: Mutex::new(None),
            wake: Arc::new((Mutex::new(false), Condvar::new())),
            closing: AtomicBool::new(false),
        }
    }
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn status(&self) -> Value {
        let enabled = consent(&config::load(&self.env));
        let inner = self.lock();
        let found = inner.found.as_ref();
        let status = Status {
            enabled,
            state: inner.phase,
            current: self.current.clone(),
            version: found.map(|f| f.version.clone()),
            notes: found.and_then(|f| f.notes.clone()),
            date: found.and_then(|f| f.date.clone()),
            install: self.install,
            url: found.map(|f| format!("{RELEASES}/tag/v{}", f.version)),
            progress: inner.progress.filter(|_| inner.phase == Phase::Downloading),
            error: inner.error.clone().filter(|_| inner.phase == Phase::Error),
            checked_at: inner.checked_at.clone(),
        };
        serde_json::to_value(status).unwrap_or_default()
    }
    fn event(&self) -> Value {
        let mut event = self.status();
        event["type"] = json!("update");
        event
    }
    /// Refuses a change while the restart that finishes an update is under way. The desktop asks with the engine
    /// held, and the restart begins with it held, so no change can slip in between.
    pub fn admit(&self, name: &str) -> Result<()> {
        if self.closing.load(Ordering::SeqCst) && (mutates(name) || name == "new/start") {
            return Err(CLOSING.into());
        }
        Ok(())
    }
    /// Whether the daily look is due: the user chose it, and a day has passed since the last one.
    fn wants_check(&self, now: DateTime<Utc>) -> bool {
        consent(&config::load(&self.env)) && due(self.lock().checked_at.as_deref(), now)
    }
    /// Marks a check as running. False while an update downloads or waits for its restart: there is nothing to
    /// look for then.
    fn begin_check(&self) -> bool {
        let mut inner = self.lock();
        if matches!(inner.phase, Phase::Downloading | Phase::Ready) {
            return false;
        }
        inner.phase = Phase::Checking;
        true
    }
    /// Takes in what a check learned, and returns what goes to the debug log. A look Laci made by itself never
    /// shows an error; a check the user asked for says why nothing came. Being offline isn't a look, so the next
    /// hour tries again.
    fn finish(&self, manual: bool, outcome: Outcome, now: DateTime<Utc>) -> Option<String> {
        let mut inner = self.lock();
        let looked = !matches!(outcome, Outcome::Offline);
        let quiet = |inner: &mut Inner| {
            inner.phase = if inner.found.is_some() { Phase::Available } else { Phase::Idle };
        };
        let logged = match outcome {
            Outcome::Newer(found) => {
                inner.found = Some(*found);
                inner.phase = Phase::Available;
                None
            }
            Outcome::Latest => {
                inner.found = None;
                inner.phase = Phase::Idle;
                None
            }
            Outcome::Offline if !manual => {
                quiet(&mut inner);
                None
            }
            Outcome::Offline => {
                inner.phase = Phase::Error;
                inner.error = Some(OFFLINE.into());
                None
            }
            Outcome::Failed(error) => {
                if manual {
                    inner.phase = Phase::Error;
                    inner.error = Some(format!("Laci couldn't read the update information: {error}"));
                } else {
                    quiet(&mut inner);
                }
                Some(error)
            }
        };
        if looked {
            let at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
            inner.checked_at = Some(at.clone());
            drop(inner);
            let saved = format!("{}\n", json!({"checkedAt":at}));
            if let Err(error) =
                files::private_dir(&self.env.cache_dir).and_then(|()| files::replace(&self.cache, saved.as_bytes()))
            {
                let note = format!("the time of this look wasn't saved: {error}");
                return Some(logged.map_or(note.clone(), |first| format!("{first}; {note}")));
            }
        }
        logged
    }
    /// Starts downloading the version found: the update, or None when its download already runs.
    fn begin_download(&self) -> Result<Option<Update>> {
        if self.install == Install::Notice {
            return Err(LINK_ONLY.into());
        }
        let mut inner = self.lock();
        match inner.phase {
            Phase::Downloading => return Ok(None),
            Phase::Ready => return Err("The update is ready. Restart Laci to finish it.".into()),
            Phase::Checking => return Err("Laci is looking for updates. Try again in a moment.".into()),
            _ => {}
        }
        let update = inner
            .found
            .as_ref()
            .and_then(|found| found.update.clone())
            .ok_or("There is no new version to install. Check for updates first.")?;
        inner.phase = Phase::Downloading;
        inner.progress = None;
        inner.error = None;
        Ok(Some(update))
    }
    /// Records how much has arrived; true when the whole percent changed and the window should hear of it.
    fn progress(&self, received: u64, total: Option<u64>) -> bool {
        let percent = total.filter(|total| *total > 0).map(|total| (received.min(total) * 100 / total) as u8);
        let mut inner = self.lock();
        if inner.phase != Phase::Downloading || inner.progress == percent {
            return false;
        }
        inner.progress = percent;
        true
    }
    /// The end of a download: the installer Windows runs at the restart, nothing when it is installed already, or
    /// why it failed. The version found stays, so the user can try again.
    fn downloaded(&self, result: std::result::Result<Option<Vec<u8>>, String>) {
        let mut inner = self.lock();
        inner.progress = None;
        match result {
            Ok(installer) => {
                inner.phase = Phase::Ready;
                inner.installer = installer;
            }
            Err(error) => {
                inner.phase = Phase::Error;
                inner.error = Some(error);
                inner.installer = None;
            }
        }
    }
    fn wake(&self) {
        let (woken, signal) = &*self.wake;
        *woken.lock().unwrap_or_else(|e| e.into_inner()) = true;
        signal.notify_all();
    }
}

/// The user's consent to the daily look.
fn consent(config: &Value) -> bool {
    config["updates"] == "daily"
}

/// Whether a day has passed since the last look. A last look ahead of the clock was written while the clock ran
/// ahead; it holds the next one back for an hour at most.
fn due(checked_at: Option<&str>, now: DateTime<Utc>) -> bool {
    let Some(last) = checked_at.and_then(|at| DateTime::parse_from_rfc3339(at).ok()) else {
        return true;
    };
    let last = last.with_timezone(&Utc);
    last > now + TimeDelta::hours(1) || now - last >= TimeDelta::days(1)
}

/// How this copy gets a new version, from where it runs. Decided once, when Laci starts.
pub fn install_kind() -> Install {
    let exe = std::env::current_exe().ok();
    // The portable zip says so in a file next to laci.exe. Checked first: its laci.exe may carry the bundle type
    // of the installer it was taken from.
    let portable = exe.as_deref().and_then(Path::parent).is_some_and(|dir| dir.join("PORTABLE").is_file());
    let appimage = exe.as_deref().is_some_and(|exe| {
        runs_from_appimage(exe, std::env::var_os("APPIMAGE").as_deref(), std::env::var_os("APPDIR").as_deref())
    });
    decide(portable, bundle_type(), exe.as_deref(), appimage)
}

/// Whether `exe` runs from the AppImage `appimage` names: from inside the folder the AppImage runtime mounted or
/// unpacked it to (`appdir`, named `.mount_*` or `appimage_extracted_*`). A program started from another AppImage,
/// such as a terminal, inherits both variables, and Laci must never put itself in that program's file.
fn runs_from_appimage(exe: &Path, appimage: Option<&std::ffi::OsStr>, appdir: Option<&std::ffi::OsStr>) -> bool {
    let (Some(image), Some(dir)) = (appimage.map(Path::new), appdir.map(Path::new)) else {
        return false;
    };
    let runtime = dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".mount_") || name.starts_with("appimage_extracted_"));
    // An AppImage keeps Laci at usr/bin/laci in its folder.
    image.is_absolute() && image.is_file() && runtime && exe.ancestors().nth(3) == Some(dir)
}

/// A deb or an rpm belongs to the package manager, and a copy with no bundle type was put in place by
/// install-desktop.sh, a build or the portable zip. An AppImage is replaced through `$APPIMAGE`, so one that runs
/// unpacked can't be. On macOS only an app inside its own `.app` that macOS didn't move can be replaced: not a
/// translocated copy, which disappears when Laci quits, nor one on a disk image.
fn decide(portable: bool, bundle: Option<BundleType>, exe: Option<&Path>, appimage: bool) -> Install {
    let replaceable_app = |exe: &Path| {
        exe.parent().is_some_and(|dir| dir.ends_with("Contents/MacOS"))
            && exe.ancestors().nth(3).is_some_and(|app| app.extension().is_some_and(|e| e == "app"))
            && !exe.components().any(|part| part.as_os_str() == "AppTranslocation")
            && !exe.starts_with("/Volumes")
    };
    match bundle {
        _ if portable => Install::Notice,
        Some(BundleType::Nsis | BundleType::Msi) => Install::Click,
        Some(BundleType::AppImage) if appimage => Install::Click,
        Some(BundleType::App) if exe.is_some_and(replaceable_app) => Install::Click,
        _ => Install::Notice,
    }
}

/// LACI_UPDATE_ENDPOINT when it is set, which must be an https address: the feed of a release candidate is read
/// the way the real one is.
fn endpoint(value: Option<OsString>) -> std::result::Result<Option<tauri::Url>, String> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let refused = || format!("{ENDPOINT} must be an https:// address");
    let url = value.to_str().and_then(|value| tauri::Url::parse(value.trim()).ok()).ok_or_else(refused)?;
    if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
        return Err(refused());
    }
    Ok(Some(url))
}

/// The lock, if it comes free within `wait`. A change can hold the engine for minutes, and an update should say so
/// rather than wait that long.
fn lock_within<T>(mutex: &Mutex<T>, wait: Duration) -> Option<MutexGuard<'_, T>> {
    let deadline = Instant::now() + wait;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Err(TryLockError::WouldBlock) => return None,
        }
    }
}

fn quiet_engine(state: &AppState) -> Result<MutexGuard<'_, Engine>> {
    quiet(&state.engine, &state.creations, BUSY_WAIT)
}

/// The engine, once no change runs: refused while one holds the engine for longer than `wait`, while a project is
/// being created or its agent started, and while history is read again after a change (a creation sets that too,
/// before its job shows).
fn quiet<'a>(engine: &'a Mutex<Engine>, creations: &Creations, wait: Duration) -> Result<MutexGuard<'a, Engine>> {
    let engine = lock_within(engine, wait).ok_or_else(|| BUSY.to_owned())?;
    let job = creations.current()?;
    if engine.history_pending || job["status"] == "running" || job["continuation"]["status"] == "running" {
        return Err(BUSY.into());
    }
    Ok(engine)
}

/// The plugin's updater with Laci's limits: an answer within 30 s and a download that may not stall for a minute.
/// `endpoint` replaces the feed of tauri.conf.json. `before_exit` runs on Windows just before the installer starts,
/// which ends Laci.
fn updater<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    endpoint: Option<tauri::Url>,
    before_exit: impl Fn() + Send + Sync + 'static,
) -> std::result::Result<Updater, String> {
    let mut builder = handle
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .configure_client(|client| {
            client.connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(60))
        })
        .on_before_exit(before_exit);
    if let Some(endpoint) = endpoint {
        builder = builder.endpoints(vec![endpoint]).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())
}

/// Asks the feed whether a newer version is out.
fn look(updater: std::result::Result<Updater, String>) -> Outcome {
    match updater {
        Ok(updater) => outcome(tauri::async_runtime::block_on(updater.check())),
        Err(error) => Outcome::Failed(error),
    }
}

/// What Windows runs just before the installer starts and ends Laci: the terminals and the agents in them close, as
/// at any exit, and the window goes. No creation runs then, nor can one start: the restart holds the engine and
/// found none (`quiet_engine`). It replaces the plugin's own hook, which clears Tauri's state for good: the plugin
/// runs this before it knows the installer started, and if it didn't, `restart` shows the window again and Laci
/// goes on.
fn before_exit(state: &Arc<AppState>) -> impl Fn() + Send + Sync + 'static {
    let weak = Arc::downgrade(state);
    move || {
        if let Some(state) = weak.upgrade() {
            state.terminals.close_all();
            if let Some(window) = state.handle.get_webview_window("main") {
                let _ = window.hide();
            }
        }
    }
}

/// A failed download or install, in the user's words.
fn install_error(error: &UpdaterError) -> String {
    match error {
        UpdaterError::Minisign(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_) => {
            "The download doesn't carry Laci's signature, so nothing was installed.".into()
        }
        UpdaterError::Reqwest(e) if e.is_connect() || e.is_timeout() || e.is_request() || e.is_body() => {
            "The download stopped. Check the connection and try again.".into()
        }
        error => format!("The update couldn't be installed: {error}"),
    }
}

/// Adds a line to the debug log. A change can hold the engine for minutes, so then a thread of its own writes the
/// line once the engine is free, and the caller goes on.
fn debug(state: &Arc<AppState>, message: String) {
    if let Ok(engine) = state.engine.try_lock() {
        engine.service.debug(&message);
        return;
    }
    let weak = Arc::downgrade(state);
    let _ = thread::Builder::new().name("laci-update-log".into()).spawn(move || {
        if let Some(state) = weak.upgrade() {
            state.engine.lock().unwrap_or_else(|e| e.into_inner()).service.debug(&message);
        }
    });
}

/// The `update/*` requests.
pub(super) fn request(state: &Arc<AppState>, name: &str) -> Result<Value> {
    match name {
        "update/status" => Ok(state.updates.status()),
        "update/check" => Ok(check(state, true)),
        "update/install" => install(state),
        "update/restart" => restart(state),
        _ => Err(format!("Unknown action: {name}")),
    }
}

/// After the `updates` request: the window shows the choice, and a daily look that is due now goes out now.
pub(super) fn consent_changed(state: &AppState) {
    state.updates.wake();
    state.notice(state.updates.event());
}

/// The daily look, on a thread of its own for as long as Laci runs.
pub(super) fn watch(state: &Arc<AppState>) {
    let weak = Arc::downgrade(state);
    let wake = Arc::clone(&state.updates.wake);
    let _ = thread::Builder::new().name("laci-updates".into()).spawn(move || {
        let mut wait = FIRST_LOOK;
        loop {
            {
                let (woken, signal) = &*wake;
                let mut woken = woken.lock().unwrap_or_else(|e| e.into_inner());
                if !*woken {
                    woken = signal.wait_timeout(woken, wait).unwrap_or_else(|e| e.into_inner()).0;
                }
                *woken = false;
            }
            let Some(state) = weak.upgrade() else {
                break;
            };
            check(&state, false);
            wait = LOOK_AGAIN;
        }
    });
}

/// `update/check`, or with `manual` false the daily look when it is due. Answers the status after it.
fn check(state: &Arc<AppState>, manual: bool) -> Value {
    let updates = &state.updates;
    let asked = Instant::now();
    let mut last = updates.checking.lock().unwrap_or_else(|e| e.into_inner());
    let answered = last.is_some_and(|(ended, by_user)| ended > asked && (by_user || !manual));
    if answered || (!manual && !updates.wants_check(Utc::now())) || !updates.begin_check() {
        return updates.status();
    }
    state.notice(updates.event());
    let found =
        endpoint(std::env::var_os(ENDPOINT)).and_then(|endpoint| updater(&state.handle, endpoint, before_exit(state)));
    if let Some(error) = updates.finish(manual, look(found), Utc::now()) {
        debug(state, format!("update check: {error}"));
    }
    *last = Some((Instant::now(), manual));
    drop(last);
    state.notice(updates.event());
    updates.status()
}

/// `update/install`: downloads the version found and checks its signature. Linux and macOS install it at once;
/// Windows keeps the installer for the restart, because it ends Laci.
fn install(state: &Arc<AppState>) -> Result<Value> {
    let updates = &state.updates;
    // A second click while the download runs changes nothing. A copy that only links is refused below.
    if updates.install == Install::Click && updates.lock().phase != Phase::Downloading {
        drop(quiet_engine(state)?);
    }
    let Some(update) = updates.begin_download()? else {
        return Ok(json!({"started":true}));
    };
    state.notice(updates.event());
    let weak = Arc::downgrade(state);
    let spawned = thread::Builder::new().name("laci-update".into()).spawn(move || {
        let mut received = 0;
        let result = tauri::async_runtime::block_on(update.download(
            |chunk, total| {
                received += chunk as u64;
                if let Some(state) = weak.upgrade()
                    && state.updates.progress(received, total)
                {
                    state.notice(state.updates.event());
                }
            },
            || {},
        ))
        .and_then(|bytes| if cfg!(windows) { Ok(Some(bytes)) } else { update.install(&bytes).map(|()| None) });
        if let Some(state) = weak.upgrade() {
            if let Err(error) = &result {
                debug(&state, format!("update download: {error}"));
            }
            state.updates.downloaded(result.map_err(|e| install_error(&e)));
            state.notice(state.updates.event());
        }
    });
    if let Err(error) = spawned {
        updates.downloaded(Err(format!("The download couldn't start: {error}")));
        state.notice(updates.event());
    }
    Ok(json!({"started":true}))
}

/// `update/restart`: starts the new version once no change runs. Terminals and agents in them close, as at any exit.
fn restart(state: &AppState) -> Result<Value> {
    let updates = &state.updates;
    if updates.lock().phase != Phase::Ready {
        return Err("Install the update first.".into());
    }
    let engine = quiet_engine(state)?;
    updates.closing.store(true, Ordering::SeqCst);
    if cfg!(windows) {
        // The installer replaces Laci and starts it again. `install` ends this process once the installer runs, so it
        // returns only when that failed.
        let ready = {
            let inner = updates.lock();
            inner.found.as_ref().and_then(|found| found.update.clone()).zip(inner.installer.clone())
        };
        let error = match ready {
            Some((update, installer)) => match update.install(installer) {
                Ok(()) => "The installer didn't start. Try the update again.".to_owned(),
                Err(error) => {
                    // This thread holds the engine.
                    engine.service.debug(&format!("update install: {error}"));
                    install_error(&error)
                }
            },
            None => "Download the update again.".to_owned(),
        };
        // `before_exit` may have hidden it.
        if let Some(window) = state.handle.get_webview_window("main") {
            let _ = window.show();
        }
        updates.closing.store(false, Ordering::SeqCst);
        drop(engine);
        updates.downloaded(Err(error.clone()));
        state.notice(updates.event());
        return Err(error);
    }
    drop(engine);
    // A moment for this answer to reach the window. The exit then closes terminals and creations as usual.
    let handle = state.handle.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        handle.request_restart();
    });
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use laci_core::service::Service;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
    };
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    fn updates(install: Install) -> (tempfile::TempDir, Updates) {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        (home, Updates::new(&env, "3.0.0".into(), install))
    }
    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
    }
    fn found(version: &str) -> Outcome {
        Outcome::Newer(Box::new(Found {
            version: version.into(),
            notes: Some("Fixes".into()),
            date: None,
            update: None,
        }))
    }
    /// Why a download didn't start.
    fn refusal(started: Result<Option<Update>>) -> String {
        started.err().expect("the download was refused")
    }

    /// A feed on 127.0.0.1 that answers every request with `status` and `body`.
    fn feed(status: &str, body: &str) -> String {
        let answer = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut head = Vec::new();
                let mut byte = [0];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).is_ok_and(|read| read == 1) {
                    head.push(byte[0]);
                }
                let _ = stream.write_all(answer.as_bytes());
            }
        });
        format!("http://{address}/latest.json")
    }
    /// An address where nothing listens.
    fn nowhere() -> String {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        format!("http://127.0.0.1:{port}/latest.json")
    }
    /// The real updater of an app at version 0.1.0 on Tauri's mock runtime, reading `feed`. Plain http is allowed
    /// here only, for the feeds above.
    fn app_reading(feed: &str) -> tauri::App<MockRuntime> {
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({"pubkey":"unused: nothing is downloaded","endpoints":[feed],"dangerousInsecureTransportProtocol":true}),
        );
        mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap()
    }
    /// What Laci learns from a feed, through the plugin and the limits Laci sets on it.
    fn look_at(feed: &str) -> Outcome {
        look(updater(app_reading(feed).handle(), None, || {}))
    }
    /// A release of `version` with a build for this computer.
    fn release(version: &str, more: Value) -> String {
        let target = tauri_plugin_updater::target().unwrap();
        let mut release = json!({
            "version":version,
            "platforms":{target:{"url":"https://example.com/laci.AppImage","signature":"unchecked until a download"}}
        });
        for (key, value) in more.as_object().unwrap() {
            release[key] = value.clone();
        }
        release.to_string()
    }

    #[test]
    fn laci_looks_at_most_once_a_day() {
        let now = at("2026-10-18T12:00:00Z");
        assert!(due(None, now));
        assert!(!due(Some("2026-10-18T09:00:00Z"), now));
        assert!(!due(Some("2026-10-17T12:00:01Z"), now));
        assert!(due(Some("2026-10-17T12:00:00Z"), now));
        assert!(due(Some("yesterday"), now));
        // A clock that ran ahead holds the next look back for an hour at most.
        assert!(!due(Some("2026-10-18T12:30:00Z"), now));
        assert!(due(Some("2027-01-01T00:00:00Z"), now));
    }

    #[test]
    fn only_the_daily_choice_lets_laci_look_by_itself() {
        let (_home, updates) = updates(Install::Click);
        let now = at("2026-10-18T12:00:00Z");
        assert!(!updates.wants_check(now), "nothing chosen yet");
        assert_eq!(updates.status()["enabled"], false);
        for (saved, wanted) in
            [(json!("daily"), true), (json!("off"), false), (json!("weekly"), false), (json!(1), false)]
        {
            config::save(&updates.env, &json!({"roots":[],"updates":saved})).unwrap();
            assert_eq!(updates.wants_check(now), wanted, "{saved}");
            assert_eq!(updates.status()["enabled"], wanted, "{saved}");
        }
        // With consent, a look today holds the next one back until tomorrow, also after a restart.
        config::save(&updates.env, &json!({"roots":[],"updates":"daily"})).unwrap();
        assert!(updates.begin_check());
        assert_eq!(updates.finish(false, Outcome::Latest, now), None);
        assert!(!updates.wants_check(now + TimeDelta::hours(23)));
        assert!(updates.wants_check(now + TimeDelta::hours(24)));
        let restarted = Updates::new(&updates.env, "3.0.0".into(), Install::Click);
        assert_eq!(restarted.status()["checkedAt"], "2026-10-18T12:00:00Z");
        assert!(!restarted.wants_check(now + TimeDelta::hours(23)));
        // The look leaves nothing in the Log.
        assert!(laci_core::activity::read_log(&updates.env, 10).is_empty());
    }

    #[test]
    fn packages_scripts_and_portable_copies_get_a_link_and_the_others_a_button() {
        use BundleType::*;
        use Install::*;
        let app = "/Applications/Laci.app/Contents/MacOS/laci";
        let cases: [(bool, Option<BundleType>, &str, bool, Install); 16] = [
            (false, Some(Deb), "/usr/bin/laci", false, Notice),
            (false, Some(Rpm), "/usr/bin/laci", false, Notice),
            // install-desktop.sh, or a build of its own.
            (false, None, "/home/me/.local/bin/laci", false, Notice),
            (false, None, "C:/Users/me/AppData/Local/Laci/laci.exe", false, Notice),
            (true, Some(Nsis), "D:/Tools/Laci/laci.exe", false, Notice),
            (true, None, "D:/Tools/Laci/laci.exe", false, Notice),
            (false, Some(Nsis), "C:/Users/me/AppData/Local/Laci/laci.exe", false, Click),
            (false, Some(Msi), "C:/Program Files/Laci/laci.exe", false, Click),
            (false, Some(AppImage), "/tmp/.mount_laciAbC/usr/bin/laci", true, Click),
            (false, Some(AppImage), "/home/me/squashfs-root/usr/bin/laci", false, Notice),
            (false, Some(App), app, false, Click),
            (false, Some(App), "/Users/me/Applications/Laci.app/Contents/MacOS/laci", false, Click),
            (
                false,
                Some(App),
                "/private/var/folders/x/T/AppTranslocation/0F1E/d/Laci.app/Contents/MacOS/laci",
                false,
                Notice,
            ),
            (false, Some(App), "/Volumes/Laci/Laci.app/Contents/MacOS/laci", false, Notice),
            (false, Some(App), "/Users/me/laci/target/debug/laci", false, Notice),
            (false, Some(Dmg), app, false, Notice),
        ];
        for (portable, bundle, exe, appimage, expected) in cases {
            let case = format!("{bundle:?} {exe}");
            assert_eq!(decide(portable, bundle, Some(Path::new(exe)), appimage), expected, "{case}");
        }
        assert_eq!(decide(false, Some(App), None, false), Notice);
        // An AppImage replaces itself only when Laci runs from it, never another program's AppImage that started it.
        let image = tempfile::NamedTempFile::new().unwrap();
        let image = Some(image.path().as_os_str());
        let laci = Path::new("/tmp/.mount_LaciAbC/usr/bin/laci");
        for (exe, appimage, appdir, expected) in [
            (laci, image, Some("/tmp/.mount_LaciAbC"), true),
            (Path::new("/tmp/appimage_extracted_9f2/usr/bin/laci"), image, Some("/tmp/appimage_extracted_9f2"), true),
            // Started from a terminal that is an AppImage: both variables are the terminal's.
            (Path::new("/home/me/squashfs-root/usr/bin/laci"), image, Some("/tmp/.mount_kittyXy"), false),
            (laci, image, Some("/tmp/.mount_kittyXy"), false),
            (laci, image, Some("/home/me/apps/laci"), false),
            (laci, image, None, false),
            (laci, None, Some("/tmp/.mount_LaciAbC"), false),
            (laci, Some(std::ffi::OsStr::new("/nowhere/Laci.AppImage")), Some("/tmp/.mount_LaciAbC"), false),
        ] {
            let appdir = appdir.map(std::ffi::OsStr::new);
            assert_eq!(runs_from_appimage(exe, appimage, appdir), expected, "{exe:?} {appdir:?}");
        }
        let (_home, notice) = updates(Notice);
        assert_eq!(notice.status()["install"], "notice");
        notice.finish(true, found("3.1.0"), Utc::now());
        assert_eq!(notice.status()["url"], format!("{RELEASES}/tag/v3.1.0"));
        // A copy that only links never downloads, whatever it found.
        assert_eq!(refusal(notice.begin_download()), LINK_ONLY);
        assert_eq!(notice.status()["state"], "available");
    }

    #[test]
    fn a_feed_that_answers_404_says_nothing_and_counts_as_a_look() {
        let not_found = feed("404 Not Found", "Not Found");
        // Asked as the desktop asks: on one of the async runtime's blocking threads, which waits for the answer.
        let asked = {
            let not_found = not_found.clone();
            tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(move || look_at(&not_found)))
        };
        assert!(matches!(asked.unwrap(), Outcome::Latest));
        let (_home, updates) = updates(Install::Click);
        let now = at("2026-10-18T12:00:00Z");
        for manual in [false, true] {
            assert!(updates.begin_check());
            assert_eq!(updates.status()["state"], "checking");
            assert_eq!(updates.finish(manual, look_at(&not_found), now), None);
            let status = updates.status();
            assert_eq!(status["state"], "idle", "{status}");
            assert!(status.get("error").is_none() && status.get("version").is_none(), "{status}");
            assert_eq!(status["checkedAt"], "2026-10-18T12:00:00Z");
        }
        // A version found earlier is dropped once the feed has none.
        updates.finish(true, found("3.1.0"), now);
        assert_eq!(updates.status()["version"], "3.1.0");
        updates.finish(false, look_at(&not_found), now);
        assert!(updates.status().get("version").is_none());
    }

    #[test]
    fn a_feed_with_nothing_newer_for_this_computer_says_nothing() {
        let quiet = [
            feed("204 No Content", ""),
            feed("500 Internal Server Error", "{}"),
            feed("200 OK", &release("0.1.0", json!({}))),
            feed("200 OK", &release("0.0.9", json!({}))),
            feed(
                "200 OK",
                &json!({"version":"0.2.0","platforms":{"plan9-mips":{"url":"https://example.com","signature":"x"}}})
                    .to_string(),
            ),
        ];
        for feed in quiet {
            assert!(matches!(look_at(&feed), Outcome::Latest), "{feed}");
        }
    }

    #[test]
    fn a_newer_release_is_offered_with_its_notes_and_date() {
        // 11 bytes before the two-byte letters, so the limit falls inside one.
        let notes = format!("### Fixed:\n{}", "é".repeat(NOTES_LIMIT));
        let newer = feed("200 OK", &release("0.2.0", json!({"notes":notes,"pub_date":"2026-10-18T19:30:00+07:00"})));
        let Outcome::Newer(found) = look_at(&newer) else { panic!("no update found") };
        assert_eq!((found.version.as_str(), found.date.as_deref()), ("0.2.0", Some("2026-10-18T12:30:00Z")));
        // Very long notes are cut on a character, not inside one.
        let shown = found.notes.as_deref().unwrap();
        assert!(shown.starts_with("### Fixed:\né") && shown.ends_with("é…"));
        assert_eq!(shown.len(), NOTES_LIMIT - 1 + "…".len());
        // LACI_UPDATE_ENDPOINT replaces the feed of tauri.conf.json.
        let not_found = tauri::Url::parse(&feed("404 Not Found", "")).unwrap();
        assert!(matches!(look(updater(app_reading(&newer).handle(), Some(not_found), || {})), Outcome::Latest));
        let (_home, updates) = updates(Install::Click);
        updates.begin_check();
        updates.finish(false, Outcome::Newer(found), Utc::now());
        let status = updates.status();
        assert_eq!((status["state"].as_str(), status["version"].as_str()), (Some("available"), Some("0.2.0")));
        assert_eq!(status["url"], format!("{RELEASES}/tag/v0.2.0"));
    }

    #[test]
    fn being_offline_is_quiet_unless_the_user_asked_and_is_not_a_look() {
        let offline = || look_at(&nowhere());
        assert!(matches!(offline(), Outcome::Offline));
        let (_home, updates) = updates(Install::Click);
        let now = at("2026-10-18T12:00:00Z");
        assert!(updates.begin_check());
        assert_eq!(updates.finish(false, offline(), now), None);
        let status = updates.status();
        assert_eq!(status["state"], "idle");
        assert!(status.get("error").is_none() && status.get("checkedAt").is_none(), "{status}");
        // A version found before stays on offer.
        updates.finish(true, found("3.1.0"), now);
        updates.begin_check();
        updates.finish(false, offline(), now + TimeDelta::days(1));
        assert_eq!(
            (updates.status()["state"].as_str(), updates.status()["version"].as_str()),
            (Some("available"), Some("3.1.0"))
        );
        // Asked for, the window says why nothing came.
        updates.begin_check();
        updates.finish(true, offline(), now);
        assert_eq!(
            (updates.status()["state"].as_str(), updates.status()["error"].as_str()),
            (Some("error"), Some(OFFLINE))
        );
    }

    #[test]
    fn a_broken_answer_reaches_the_window_only_when_asked_and_the_debug_log_always() {
        let broken = look_at(&feed("200 OK", "<html>Sign in to the Wi-Fi</html>"));
        let Outcome::Failed(error) = broken else { panic!("a page that isn't a feed was taken as one") };
        let (_home, updates) = updates(Install::Click);
        updates.finish(true, found("3.1.0"), Utc::now());
        updates.begin_check();
        assert_eq!(updates.finish(false, Outcome::Failed(error.clone()), Utc::now()), Some(error.clone()));
        assert_eq!(updates.status()["state"], "available");
        updates.begin_check();
        assert_eq!(updates.finish(true, Outcome::Failed(error.clone()), Utc::now()), Some(error.clone()));
        let status = updates.status();
        assert_eq!(status["state"], "error");
        assert!(status["error"].as_str().unwrap().ends_with(&error), "{status}");
    }

    #[test]
    fn a_download_shows_whole_percents_and_ends_ready_or_with_its_reason() {
        let (_home, updates) = updates(Install::Click);
        updates.finish(true, found("3.1.0"), Utc::now());
        // The state tests' releases can't be downloaded; the window is told so instead of waiting.
        assert!(refusal(updates.begin_download()).contains("no new version"));
        updates.lock().phase = Phase::Downloading;
        assert!(updates.progress(0, Some(1000)));
        assert!(!updates.progress(5, Some(1000)), "still 0 %");
        assert!(updates.progress(500, Some(1000)));
        assert_eq!(updates.status()["progress"], 50);
        assert!(!updates.begin_check(), "no look while it downloads");
        assert!(updates.begin_download().unwrap().is_none(), "one download at a time");
        updates.downloaded(Err("The download stopped.".into()));
        let status = updates.status();
        assert_eq!(
            (status["state"].as_str(), status["error"].as_str()),
            (Some("error"), Some("The download stopped."))
        );
        assert_eq!(status["version"], "3.1.0");
        assert!(status.get("progress").is_none());
        updates.lock().phase = Phase::Downloading;
        updates.downloaded(Ok(None));
        assert_eq!(updates.status()["state"], "ready");
        assert!(!updates.begin_check(), "nothing to look for until the restart");
        assert!(refusal(updates.begin_download()).contains("Restart"));
    }

    #[test]
    fn the_status_and_its_event_carry_the_agreed_fields() {
        let (_home, updates) = updates(Install::Click);
        assert_eq!(updates.status(), json!({"enabled":false,"state":"idle","current":"3.0.0","install":"click"}));
        updates.begin_check();
        assert_eq!(updates.status()["state"], "checking");
        let found = Found {
            version: "3.1.0".into(),
            notes: Some("### Fixed".into()),
            date: Some("2026-10-18T10:00:00Z".into()),
            update: None,
        };
        updates.finish(true, Outcome::Newer(Box::new(found)), at("2026-10-18T12:00:00Z"));
        let available = json!({
            "enabled":false,"state":"available","current":"3.0.0","version":"3.1.0","notes":"### Fixed",
            "date":"2026-10-18T10:00:00Z","install":"click","url":format!("{RELEASES}/tag/v3.1.0"),
            "checkedAt":"2026-10-18T12:00:00Z"
        });
        assert_eq!(updates.status(), available);
        let mut event = available.clone();
        event["type"] = json!("update");
        assert_eq!(updates.event(), event);
        // The progress only while it downloads, the reason only after a failure.
        updates.lock().phase = Phase::Downloading;
        updates.progress(250, Some(1000));
        let mut downloading = available.clone();
        downloading["state"] = json!("downloading");
        downloading["progress"] = json!(25);
        assert_eq!(updates.status(), downloading);
        updates.downloaded(Err("The download stopped.".into()));
        let mut failed = available.clone();
        failed["state"] = json!("error");
        failed["error"] = json!("The download stopped.");
        assert_eq!(updates.status(), failed);
        // A later look doesn't show the earlier failure.
        updates.begin_check();
        let mut checking = available;
        checking["state"] = json!("checking");
        assert_eq!(updates.status(), checking);
    }

    #[test]
    fn no_capability_lets_the_window_drive_the_updater_or_the_webdriver_server() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut read = 0;
        for file in std::fs::read_dir(folder).unwrap().map(|entry| entry.unwrap().path()) {
            let capability: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                let name = permission.as_str().or_else(|| permission["identifier"].as_str()).unwrap();
                let plugin = name.split(':').next().unwrap();
                assert!(!["updater", "wdio-webdriver"].contains(&plugin), "{}: {name}", file.display());
            }
            read += 1;
        }
        assert!(read > 0, "no capability was read");
    }

    #[test]
    fn a_test_feed_must_be_https() {
        assert_eq!(endpoint(None), Ok(None));
        assert_eq!(endpoint(Some("".into())), Ok(None));
        let rc = "https://github.com/mrramdn/laci/releases/download/v3.0.0-rc.2/latest.json";
        assert_eq!(endpoint(Some(rc.into())).unwrap().map(|url| url.to_string()).as_deref(), Some(rc));
        for refused in
            ["http://example.com/latest.json", "file:///tmp/latest.json", "ftp://example.com/x", "latest.json", " "]
        {
            assert_eq!(
                endpoint(Some(refused.into())),
                Err(format!("{ENDPOINT} must be an https:// address")),
                "{refused}"
            );
        }
    }

    #[test]
    fn the_shipped_feed_is_signed_https_and_never_goes_back() {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let conf: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let config: tauri_plugin_updater::Config = serde_json::from_value(conf["plugins"]["updater"].clone()).unwrap();
        assert!(config.require_signed_version);
        assert!(!config.allow_downgrades);
        assert!(!config.dangerous_insecure_transport_protocol);
        assert!(!config.dangerous_accept_invalid_certs && !config.dangerous_accept_invalid_hostnames);
        let feeds: Vec<_> = config.endpoints.iter().map(tauri::Url::as_str).collect();
        assert_eq!(feeds, ["https://github.com/mrramdn/laci/releases/latest/download/latest.json"]);
        // Windows shows the installer's progress and needs no click.
        assert_eq!(config.windows.map(|w| w.install_mode.to_string()).as_deref(), Some("passive"));
        // The public half of the key `tauri signer generate` made: the private one starts with another comment.
        let key = String::from_utf8(STANDARD.decode(&config.pubkey).unwrap()).unwrap();
        assert!(key.starts_with("untrusted comment: minisign public key: "), "not a public key");
    }

    #[test]
    fn an_update_refuses_while_a_change_runs_and_waits_a_moment_for_one_to_end() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let engine = Mutex::new(Engine::new(Service::new(env.clone())));
        let creations = Creations::default();
        let wait = Duration::from_millis(200);
        let update = |wait| quiet(&engine, &creations, wait).map(drop);
        assert_eq!(update(wait), Ok(()));
        // A change holds the engine for longer than the update waits.
        let change = engine.lock().unwrap();
        let started = Instant::now();
        thread::scope(|scope| assert_eq!(scope.spawn(|| update(wait)).join().unwrap(), Err(BUSY.into())));
        assert!(started.elapsed() >= wait);
        // A read that ends while the update waits doesn't refuse it.
        thread::scope(|scope| {
            let asked = scope.spawn(|| update(Duration::from_secs(5)));
            thread::sleep(Duration::from_millis(50));
            drop(change);
            assert_eq!(asked.join().unwrap(), Ok(()));
        });
        // History is read again after a change.
        engine.lock().unwrap().history_pending = true;
        assert_eq!(update(wait), Err(BUSY.into()));
        engine.lock().unwrap().history_pending = false;
        // A project is being created: its name is refused, but the job runs until this test lets it end.
        let (entered, running) = mpsc::channel();
        let (release, held) = mpsc::channel::<()>();
        creations
            .start(env, json!({"name":"invalid/name"}), move |_| {
                entered.send(()).unwrap();
                held.recv().unwrap();
            })
            .unwrap();
        running.recv().unwrap();
        assert_eq!(update(wait), Err(BUSY.into()));
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while creations.current().unwrap()["status"] == "running" {
            assert!(Instant::now() < deadline, "the creation never ended");
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(update(wait), Ok(()));
    }

    #[test]
    fn no_change_starts_once_the_restart_for_an_update_began() {
        let (_home, updates) = updates(Install::Click);
        for name in ["move", "design", "updates", "new/start", "snapshot", "update/status"] {
            assert!(updates.admit(name).is_ok(), "{name}");
        }
        updates.closing.store(true, Ordering::SeqCst);
        for name in ["move", "delete", "design", "updates", "new/start"] {
            assert_eq!(updates.admit(name), Err(CLOSING.into()), "{name}");
        }
        for name in ["snapshot", "log", "prefs", "update/status"] {
            assert!(updates.admit(name).is_ok(), "{name}");
        }
    }
}
