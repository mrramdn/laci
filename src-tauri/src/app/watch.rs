use laci_core::{
    agents,
    env::Env,
    files, paths,
    platform::path::{FOLDS_CASE, canonical, resolve_existing},
    reports,
    service::{Refresh, array, string},
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
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

/// How Laci watches folders. Linux's inotify watches one folder per watch, and a watch costs little, so there Laci
/// watches each folder it reads, within a budget. FSEvents (macOS) and ReadDirectoryChangesW (Windows) see a whole tree
/// through one watch, and a watch per folder costs a lot: macOS starts its event stream again for every folder added,
/// and Windows keeps every watched folder open, which stops the folders above it from being renamed, as when a project
/// moves to the archive. There Laci watches whole trees and drops the events it has no use for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Design {
    Folders,
    Trees,
}
const DESIGN: Design = if cfg!(target_os = "linux") { Design::Folders } else { Design::Trees };

/// Whether this OS watches whole trees. There laci.log also has how many watches are set up.
pub const TREES: bool = matches!(DESIGN, Design::Trees);

/// What a folder watched as a whole tree holds, which decides the events below it that are dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tree {
    /// A scan root. Nothing inside a HEAVY or hidden folder matters, as the scan, the project readers and Linux's
    /// watches never look there. Tools write there all the time: .vs, .idea, .build, a nested repository's .git.
    Root,
    /// An agent's history.
    Store,
    /// A Git folder. Its objects and logs change with every commit, and so does a ref or HEAD, which tells the same.
    /// Git's file system monitor, where a repository turns it on, writes in fsmonitor--daemon for every Git command
    /// another program runs.
    Git,
}

/// The folders [`Watches::desired`] asks to watch, and on macOS and Windows how to read what they report.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Wanted {
    /// Folders watched for what is directly in them.
    single: BTreeSet<PathBuf>,
    /// Folders watched as whole trees (macOS and Windows).
    trees: BTreeSet<PathBuf>,
    /// The folders whose kind decides the events dropped below them: the trees, and those of their kinds inside them.
    kinds: BTreeMap<PathBuf, Tree>,
    /// The folders Laci reads what is directly in, each watched on its own or taken in by a tree.
    open: BTreeSet<PathBuf>,
    /// Every folder the snapshot names, each with where it really is when that was looked up (see [`Spellings`]).
    known: BTreeMap<PathBuf, Option<PathBuf>>,
}
impl Wanted {
    /// Whether what is directly in `folder` is seen: it is watched, or it is inside a tree that is.
    #[cfg(test)]
    pub fn contains(&self, folder: &Path) -> bool {
        self.single.contains(folder) || self.trees.iter().any(|tree| folder.starts_with(tree))
    }
}

/// How many watches are set up, for laci.log.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Count {
    pub watches: usize,
    /// Those of them that watch a whole tree.
    pub trees: usize,
    /// Folders asked for that couldn't be watched.
    pub failed: usize,
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
    refresh_with(DESIGN, env, snapshot, changes)
}

fn refresh_with(design: Design, env: &Env, snapshot: &Value, changes: &Changes) -> Refresh {
    let trees = design == Design::Trees;
    let mut refresh = Refresh::default();
    let projects: Vec<_> = snapshot["nodes"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, node)| node)
        .filter(|node| node["kind"] == "project")
        .collect();
    let mut git_owners = None;
    let reports_dir = snapshot["reportsDir"]["path"].as_str().map(Path::new);
    let roots: Vec<&Path> =
        snapshot["roots"].as_array().into_iter().flatten().filter_map(Value::as_str).map(Path::new).collect();
    // The folders outside projects that Linux watches on their own (see `shallow`).
    let watched: BTreeSet<&Path> = if trees {
        let folders = snapshot["nodes"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, node)| node)
            .filter(|node| node["kind"] == "folder")
            .map(|node| Path::new(string(node, "path")));
        roots.iter().copied().chain(folders).chain(reports_dir).collect()
    } else {
        BTreeSet::new()
    };
    for path in &changes.paths {
        if path.starts_with(&env.data_dir) {
            continue;
        }
        if path.starts_with(&env.config_dir) {
            if !trees || setting(env, path) {
                refresh.merge(Refresh::full());
            }
            continue;
        }
        if let Some(dir) = reports_dir {
            if path.parent() == Some(dir)
                && path.file_name().and_then(|n| n.to_str()).is_some_and(reports::is_report_name)
            {
                // A report never changes which projects exist, so it never costs a full scan. The folder can
                // be a project of its own too, for example under the archive folder.
                refresh.merge(Refresh::reports());
                if let Some(node) = projects
                    .iter()
                    .filter(|node| path.starts_with(string(node, "path")))
                    .max_by_key(|node| string(node, "path").len())
                {
                    refresh.projects.insert(string(node, "id").to_owned());
                }
                continue;
            }
            if path == dir {
                refresh.merge(Refresh::reports());
            }
        }
        if array(&snapshot["connectors"]).iter().any(|connector| {
            agents::metadata_paths(env, connector).iter().any(|metadata| path == metadata || metadata.starts_with(path))
                || connector["link"]["dir"]
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
            // A tree's watch already sees a folder new in it.
            refresh.watches |= changes.structural && !trees;
            continue;
        }
        let owner = projects
            .iter()
            .filter(|node| path.starts_with(string(node, "path")))
            .max_by_key(|node| string(node, "path").len());
        if let Some(node) = owner {
            refresh.projects.insert(string(node, "id").to_owned());
            refresh.watches |= changes.structural && !trees;
        } else if let Some(root) =
            roots.iter().filter(|root| path.starts_with(root)).max_by_key(|root| root.components().count())
        {
            if !trees || shallow(&watched, path) {
                refresh.merge(Refresh::full());
            } else if changes.structural && !in_hidden(root, path) {
                // Deeper down, a file or folder that comes or goes can make a project or end one, and looking for
                // projects again finds it. The scan never looks inside a hidden folder.
                refresh.merge(Refresh::agents());
            }
        }
    }
    refresh
}

/// Whether `path`, in Laci's config folder, holds settings: config.json, the templates, or the folder itself. On
/// Windows the folder also holds Laci's data and cache, an empty folder for Git's hooks, and WebView2's EBWebView,
/// whose files change all the time.
fn setting(env: &Env, path: &Path) -> bool {
    path == env.config_dir
        || path == env.config_dir.join("config.json")
        || path.starts_with(env.config_dir.join("templates"))
}

/// Whether Linux's watches see a change at `path`, outside every project: they watch the roots, the folders of
/// projects and the reports folder, which are `watched`, so they see a change to one of those or directly in one.
fn shallow(watched: &BTreeSet<&Path>, path: &Path) -> bool {
    watched.contains(&path) || path.parent().is_some_and(|parent| watched.contains(&parent))
}

/// Whether a folder between `root` and `path` is hidden.
fn in_hidden(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(Path::parent)
        .is_some_and(|between| between.iter().any(|name| name.as_encoded_bytes().starts_with(b".")))
}

/// How the snapshot spells the folders it names, so that an event names a path as the snapshot does before anything is
/// decided from it. FSEvents (macOS) reports where a path really is: /var as /private/var, and a folder reached through
/// a link where the link leads. Below the folder it watches, Windows names what changed as the program that changed it
/// did, which can be in another case or an 8.3 short name, and macOS can name a folder in another case too. Unlike
/// `platform::path`, a name in another case isn't checked with the file system: this only decides what is read again,
/// and it runs for every event.
#[derive(Debug, Default)]
struct Spellings {
    /// Each folder by the snapshot's spelling and by where it really is, with the snapshot's spelling.
    exact: BTreeMap<PathBuf, PathBuf>,
    /// The same by [`lowered`] names, where names that differ only in case name one folder (macOS and Windows). `None`
    /// where two folders that the snapshot spells apart have one key, as in a case-sensitive folder: neither is guessed.
    folded: Option<BTreeMap<PathBuf, Option<PathBuf>>>,
    /// Whether a name can be the 8.3 short name of another (Windows).
    short_names: bool,
}
impl Spellings {
    fn new(known: BTreeMap<PathBuf, Option<PathBuf>>, fold: bool, short_names: bool) -> Self {
        let mut exact: BTreeMap<PathBuf, PathBuf> = known.keys().map(|ours| (ours.clone(), ours.clone())).collect();
        for (ours, real) in known {
            if let Some(real) = real {
                exact.entry(real).or_insert(ours);
            }
        }
        let folded = fold.then(|| {
            let mut folded: BTreeMap<PathBuf, Option<PathBuf>> = BTreeMap::new();
            for (spelling, ours) in &exact {
                folded
                    .entry(lowered(spelling))
                    .and_modify(|found| {
                        if found.as_ref() != Some(ours) {
                            *found = None;
                        }
                    })
                    .or_insert_with(|| Some(ours.clone()));
            }
            folded
        });
        Self { exact, folded, short_names }
    }
    /// `path` with its deepest folder that the snapshot names spelled as the snapshot spells it, and how many parts that
    /// spelling has; `None` when the snapshot names no folder of `path`.
    fn respell(&self, path: &Path) -> Option<(PathBuf, usize)> {
        path.ancestors().find_map(|folder| {
            let ours = self.exact.get(folder).or_else(|| self.folded.as_ref()?.get(&lowered(folder))?.as_ref())?;
            let rest = path.strip_prefix(folder).ok()?;
            let spelled = if rest.as_os_str().is_empty() { ours.clone() } else { ours.join(rest) };
            Some((spelled, ours.components().count()))
        })
    }
    /// [`Spellings::respell`], once more when it changed something: a folder named where it really is, as FSEvents
    /// names it, can hold a folder named in another case.
    fn deepest(&self, path: PathBuf) -> (PathBuf, usize) {
        match self.respell(&path) {
            Some((spelled, _)) if spelled != path => self.respell(&spelled).unwrap_or((spelled, 0)),
            Some(found) => found,
            None => (path, 0),
        }
    }
    /// `path` spelled as the snapshot spells the folders it names. The names below the deepest of them keep the event's
    /// spelling, but for an 8.3 short name, which is looked up while the file is there to look up.
    fn spell(&self, path: PathBuf) -> PathBuf {
        let (spelled, depth) = self.deepest(path);
        if self.short_names
            && spelled.components().skip(depth).any(|name| short_name(name.as_os_str()))
            && let Ok(long) = resolve_existing(&spelled)
        {
            return self.deepest(long).0;
        }
        spelled
    }
}

/// `path` with its names in lower case, by which macOS and Windows find a folder whatever its case.
fn lowered(path: &Path) -> PathBuf {
    path.components().map(|part| part.as_os_str().to_string_lossy().to_lowercase()).collect()
}

/// Whether `name` has the form of an 8.3 short name, such as `PROGRA~1` or `REPORT~2.MD`: at most eight characters
/// ending in `~` and a number, then at most three after a dot, and none in lower case. A backup such as `notes.txt~`
/// doesn't.
fn short_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let (base, extension) = name.rsplit_once('.').unwrap_or((name, ""));
    base.chars().count() <= 8
        && extension.chars().count() <= 3
        && base
            .rsplit_once('~')
            .is_some_and(|(_, number)| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
        && !name.chars().any(char::is_lowercase)
}

/// What the event handler reads events by on macOS and Windows.
#[derive(Debug, Default)]
struct Plan {
    spellings: Spellings,
    kinds: BTreeMap<PathBuf, Tree>,
    open: BTreeSet<PathBuf>,
}
impl Plan {
    /// Whether an event at `path` can matter. Finder's .DS_Store never does: Laci never reads it, and Finder writes one
    /// whenever it keeps how a folder is shown. One in a folder Laci reads directly in always can, as Linux watches such
    /// a folder on its own, even one open in Browse inside node_modules. Elsewhere the kind of the deepest folder of
    /// `kinds` that `path` is in decides (see [`Tree`]).
    fn keeps(&self, path: &Path) -> bool {
        if path.file_name().is_some_and(|name| name == ".DS_Store") {
            return false;
        }
        if self.open.contains(path) || path.parent().is_some_and(|parent| self.open.contains(parent)) {
            return true;
        }
        let Some((folder, kind)) =
            path.ancestors().find_map(|folder| self.kinds.get(folder).map(|kind| (folder, *kind)))
        else {
            return true;
        };
        // The folders between that one and the path's own name.
        let between: Vec<&OsStr> = path
            .strip_prefix(folder)
            .ok()
            .and_then(Path::parent)
            .map(|names| names.iter().collect())
            .unwrap_or_default();
        match kind {
            Tree::Root => !between.iter().any(|name| {
                name.as_encoded_bytes().starts_with(b".")
                    || name.to_str().is_some_and(|name| files::HEAVY.contains(&name))
            }),
            Tree::Git => {
                // A linked worktree's own Git folder, in the `worktrees` of its main one, is read the same way.
                let own = match between.as_slice() {
                    [worktrees, _, rest @ ..] if *worktrees == "worktrees" => rest,
                    all => all,
                };
                !own.first().is_some_and(|&name| name == "objects" || name == "logs" || name == "fsmonitor--daemon")
            }
            Tree::Store => true,
        }
    }
}

/// Names written in passing: temporary files, locks and Laci's own log.
fn passing(path: &Path) -> bool {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    name.starts_with(".tmp")
        || name.ends_with(".laci-tmp")
        || name.ends_with(".lock")
        || name == "laci.log"
        || name == "laci.log.1"
        || name == "lock"
}

/// Turns the watcher's events into [`Changes`] for the thread that batches them.
#[derive(Clone)]
struct Handler {
    design: Design,
    plan: Arc<RwLock<Plan>>,
    lost: Arc<AtomicBool>,
    sender: mpsc::Sender<Changes>,
}
impl Handler {
    /// A watcher whose events this reads.
    fn watcher(&self) -> Result<RecommendedWatcher, String> {
        let handler = self.clone();
        notify::recommended_watcher(move |result| handler.handle(result)).map_err(|e| e.to_string())
    }
    fn handle(&self, result: notify::Result<notify::Event>) {
        let Ok(event) = result else {
            self.lose();
            return;
        };
        let trees = self.design == Design::Trees;
        // FSEvents asks for a rescan when it dropped events.
        if trees && event.need_rescan() {
            self.lose();
            return;
        }
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
        // Windows says a folder changed whenever what is in it did, and that comes as events of its own.
        let touched = trees && event.kind == notify::EventKind::Modify(notify::event::ModifyKind::Any);
        let plan = trees.then(|| self.plan.read().unwrap_or_else(|e| e.into_inner()));
        let paths: BTreeSet<_> = event
            .paths
            .into_iter()
            .map(|path| match &plan {
                Some(plan) => plan.spellings.spell(path),
                None => path,
            })
            .filter(|path| !passing(path))
            .filter(|path| plan.as_ref().is_none_or(|plan| plan.keeps(path)))
            .filter(|path| !(touched && path.is_dir()))
            .collect();
        drop(plan);
        if !paths.is_empty() {
            let _ = self.sender.send(Changes { paths, structural });
        }
    }
    /// The watcher lost events or failed, so anything may have changed: macOS and Windows then refresh everything.
    /// Linux has always let both pass.
    fn lose(&self) {
        if self.design == Design::Trees {
            self.lost.store(true, Ordering::Release);
            // Wakes the thread that batches changes, which asks for the refresh.
            let _ = self.sender.send(Changes::default());
        }
    }
}

pub struct Watches {
    inner: Mutex<Inner>,
    /// What the watcher's events go through, and those of the one [`Watches::renew`] makes.
    handler: Handler,
}
struct Inner {
    watcher: RecommendedWatcher,
    /// What is watched now, and how.
    current: BTreeMap<PathBuf, RecursiveMode>,
    /// What the last install asked for.
    wanted: BTreeMap<PathBuf, RecursiveMode>,
}
impl Inner {
    fn new(watcher: RecommendedWatcher) -> Self {
        Self { watcher, current: BTreeMap::new(), wanted: BTreeMap::new() }
    }
    /// Watches what `want` names and nothing else.
    fn set(&mut self, want: BTreeMap<PathBuf, RecursiveMode>) -> Count {
        let stale: Vec<PathBuf> = self
            .current
            .iter()
            .filter(|&(dir, mode)| want.get(dir) != Some(mode))
            .map(|(dir, _)| dir.clone())
            .collect();
        let new: Vec<(PathBuf, RecursiveMode)> = want
            .iter()
            .filter(|&(dir, mode)| self.current.get(dir) != Some(mode))
            .map(|(dir, mode)| (dir.clone(), *mode))
            .collect();
        if !stale.is_empty() || !new.is_empty() {
            // macOS starts its event stream again once for all of these, not once for each.
            let mut paths = self.watcher.paths_mut();
            for dir in &stale {
                let _ = paths.remove(dir);
                self.current.remove(dir);
            }
            for (dir, mode) in new {
                if paths.add(&dir, mode).is_ok() {
                    self.current.insert(dir, mode);
                }
            }
            let _ = paths.commit();
        }
        self.wanted = want;
        self.count()
    }
    fn count(&self) -> Count {
        Count {
            watches: self.current.len(),
            trees: self.current.values().filter(|mode| **mode == RecursiveMode::Recursive).count(),
            failed: self.wanted.keys().filter(|dir| !self.current.contains_key(*dir)).count(),
        }
    }
}
impl Watches {
    pub fn new(sender: mpsc::Sender<Changes>) -> Result<Self, String> {
        Self::with(sender, DESIGN)
    }
    fn with(sender: mpsc::Sender<Changes>, design: Design) -> Result<Self, String> {
        let handler = Handler { design, plan: Arc::default(), lost: Arc::default(), sender };
        Ok(Self { inner: Mutex::new(Inner::new(handler.watcher()?)), handler })
    }
    pub fn desired(env: &Env, snapshot: &Value, listings: &BTreeSet<PathBuf>) -> Wanted {
        Self::desired_for(DESIGN, env, snapshot, listings)
    }
    fn desired_for(design: Design, env: &Env, snapshot: &Value, listings: &BTreeSet<PathBuf>) -> Wanted {
        match design {
            Design::Folders => Wanted { single: folders(env, snapshot, listings), ..Wanted::default() },
            Design::Trees => trees(env, snapshot, listings),
        }
    }
    pub fn install(&self, want: Wanted) -> Count {
        let modes = want
            .single
            .iter()
            .map(|dir| (dir.clone(), RecursiveMode::NonRecursive))
            .chain(want.trees.iter().map(|dir| (dir.clone(), RecursiveMode::Recursive)))
            .collect();
        if self.handler.design == Design::Trees {
            // In place before the new watches start, so that their first events are read by it too.
            let spellings = Spellings::new(want.known, FOLDS_CASE, cfg!(windows));
            let plan = Plan { spellings, kinds: want.kinds, open: want.open };
            *self.handler.plan.write().unwrap_or_else(|e| e.into_inner()) = plan;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return Count::default();
        };
        inner.set(modes)
    }
    /// Sets every watch up again, also those asked for that failed. On Windows a watch can stop without a word: notify
    /// drops the folder when a read of its changes fails, as when more changed at once than its buffer holds. A new
    /// watcher takes up every folder before the old one stops, so no change falls between the two; one that both
    /// report merges with itself in [`batch`]. The lock is held only to swap them: an install doesn't wait while the
    /// new watcher starts.
    pub fn renew(&self) -> Count {
        let Ok(want) = self.inner.lock().map(|inner| inner.wanted.clone()) else {
            return Count::default();
        };
        let Ok(watcher) = self.handler.watcher() else {
            return self.inner.lock().map(|inner| inner.count()).unwrap_or_default();
        };
        let mut renewed = Inner::new(watcher);
        renewed.set(want);
        let Ok(mut inner) = self.inner.lock() else {
            return Count::default();
        };
        // What an install asked for in the meantime.
        let want = inner.wanted.clone();
        let old = std::mem::replace(&mut *inner, renewed);
        let count = inner.set(want);
        drop(inner);
        drop(old);
        count
    }
    /// Whether the watcher lost events or failed since the last call, so anything may have changed. Only macOS and
    /// Windows tell.
    pub fn take_lost(&self) -> bool {
        self.handler.lost.swap(false, Ordering::AcqRel)
    }
}

/// Linux: each folder Laci reads, on its own and within a budget.
fn folders(env: &Env, snapshot: &Value, listings: &BTreeSet<PathBuf>) -> BTreeSet<PathBuf> {
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
        for metadata in agents::metadata_paths(env, &c) {
            if let Some(parent) = metadata.parent() {
                want.insert(parent.to_owned());
            }
        }
        if let Some(dir) = c["link"]["dir"].as_str() {
            let mut parent = PathBuf::from(dir);
            while !parent.is_dir() && parent.pop() {}
            want.insert(parent);
            for e in files::walk(std::path::Path::new(dir), false).filter(|e| e.file_type().is_dir()).take(4000) {
                want.insert(e.path().to_owned());
            }
        }
    }
    let mut want: BTreeSet<PathBuf> = want.into_iter().filter(|p| p.is_dir()).take(12_000).collect();
    // Added after the limit, so a reports folder that sorts late is still watched.
    if let Some(dir) = snapshot["reportsDir"]["path"].as_str().filter(|_| snapshot["reportsDir"]["error"].is_null()) {
        want.insert(PathBuf::from(dir));
    }
    want
}

/// macOS and Windows: whole trees for the scan roots (the archive folder among them, as the scan lists it with the
/// roots), the agents' history folders and the Git folders outside the roots, each once; and on its own each other
/// folder Laci reads, unless a tree takes it in. So on Windows no folder inside a project is held open.
fn trees(env: &Env, snapshot: &Value, listings: &BTreeSet<PathBuf>) -> Wanted {
    let mut kinds = Vec::new();
    let mut single = vec![env.config_dir.clone(), env.data_dir.clone()];
    for root in array(&snapshot["roots"]).iter().filter_map(Value::as_str) {
        kinds.push((PathBuf::from(root), Tree::Root));
    }
    for c in array(&snapshot["connectors"]) {
        for metadata in agents::metadata_paths(env, &c) {
            single.extend(metadata.parent().map(Path::to_owned));
        }
        if let Some(dir) = c["link"]["dir"].as_str().map(PathBuf::from) {
            if dir.is_dir() {
                kinds.push((dir, Tree::Store));
            } else {
                // Until it is made, the folder it will be made in.
                let mut parent = dir;
                while !parent.is_dir() && parent.pop() {}
                single.push(parent);
            }
        }
    }
    let nodes: Vec<&Value> = snapshot["nodes"].as_object().into_iter().flatten().map(|(_, node)| node).collect();
    for node in nodes.iter().filter(|node| node["kind"] == "project") {
        for git in git_directories(Path::new(string(node, "path"))) {
            kinds.push((git, Tree::Git));
        }
    }
    if let Some(dir) = snapshot["reportsDir"]["path"].as_str().filter(|_| snapshot["reportsDir"]["error"].is_null()) {
        single.push(PathBuf::from(dir));
    }
    single.extend(listings.iter().cloned());
    let open = single.iter().cloned().collect();
    // Where each folder to watch really is, looked up once. The projects and folders of the snapshot are named only by
    // its spelling: they are inside a root, and an event reaches them through the root.
    let mut known: BTreeMap<PathBuf, Option<PathBuf>> =
        nodes.iter().map(|node| (PathBuf::from(string(node, "path")), None)).collect();
    for dir in kinds.iter().map(|(dir, _)| dir).chain(&single) {
        if known.get(dir).is_none_or(Option::is_none) {
            known.insert(dir.clone(), canonical(dir).ok().filter(|real| real.is_dir()));
        }
    }
    let real = |dir: &PathBuf| Some((dir.clone(), known.get(dir)?.clone()?));
    let trees = outermost(kinds.iter().filter_map(|(dir, _)| real(dir)).collect());
    let single = single
        .iter()
        .filter_map(real)
        .filter(|(_, real)| !trees.values().any(|tree| real.starts_with(tree)))
        .map(|(dir, _)| dir)
        .collect();
    let mut by_folder = BTreeMap::new();
    for (dir, kind) in kinds {
        // A folder of two kinds keeps the first: a root's.
        by_folder.entry(dir).or_insert(kind);
    }
    Wanted { single, trees: trees.into_keys().collect(), kinds: by_folder, open, known }
}

/// The folders to watch as whole trees: each of `trees`, a folder and where it really is, unless it is inside another
/// where they really are, since one watch sees both. Of two that are the same folder, the first stays.
fn outermost(mut trees: Vec<(PathBuf, PathBuf)>) -> BTreeMap<PathBuf, PathBuf> {
    // In the order of where they really are, a folder comes right before those inside it, and equal ones keep theirs.
    trees.sort_by(|a, b| a.1.cmp(&b.1));
    let mut kept: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (dir, real) in trees {
        if kept.last().is_none_or(|(_, outer)| !real.starts_with(outer)) {
            kept.push((dir, real));
        }
    }
    kept.into_iter().collect()
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
    fn codex_title_index_is_watched_and_refreshes_only_agent_metadata() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let root = env.home.join(".codex");
        fs::create_dir_all(root.join("sessions")).unwrap();
        let snapshot = json!({"connectors":[{"id":"codex","provider":"codex","link":{"dir":root.join("sessions")}}],"nodes":{},"roots":[]});
        let desired = Watches::desired(&env, &snapshot, &BTreeSet::new());
        assert!(desired.contains(&root));
        let changes = Changes { paths: BTreeSet::from([root.join("session_index.jsonl")]), structural: false };
        assert_eq!(refresh_for(&env, &snapshot, &changes), Refresh::agents());
    }
    #[test]
    fn report_files_refresh_only_the_reports_and_their_folder_is_watched() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let archive = home.path().join("archive");
        let reports = archive.join("reports");
        fs::create_dir_all(&reports).unwrap();
        let mut snapshot =
            json!({"roots":[archive],"connectors":[],"nodes":{},"reportsDir":{"path":reports,"total":0}});
        let report = Changes { paths: BTreeSet::from([reports.join("2026-10-14-x.md")]), structural: true };
        assert_eq!(refresh_for(&env, &snapshot, &report), Refresh::reports(), "a new report is no new project");
        let other = Changes { paths: BTreeSet::from([reports.join("notes.swp")]), structural: true };
        assert!(refresh_for(&env, &snapshot, &other).full, "other files keep their usual handling");
        let folder = Changes { paths: BTreeSet::from([reports.clone()]), structural: true };
        assert!(refresh_for(&env, &snapshot, &folder).full);
        assert!(Watches::desired(&env, &snapshot, &BTreeSet::new()).contains(&reports));
        // The folder can be a project too, as under an archive folder: its own details refresh with it.
        snapshot["nodes"] = json!({"docs":{"id":"docs","kind":"project","path":reports,"archived":true}});
        let refresh = refresh_for(&env, &snapshot, &report);
        assert!(refresh.reports && !refresh.full && !refresh.agents);
        assert_eq!(refresh.projects, BTreeSet::from(["docs".to_owned()]));
        snapshot["nodes"] = json!({});
        snapshot["reportsDir"]["error"] = json!("Folder not found");
        // Only on Linux: macOS and Windows watch the archive folder as a whole tree, and that takes in the reports
        // folder in it whatever its state.
        #[cfg(target_os = "linux")]
        assert!(!Watches::desired(&env, &snapshot, &BTreeSet::new()).contains(&reports));
    }
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

    /// Every change received until `done` holds for them together, and those that follow within half a second.
    fn received(receiver: &mpsc::Receiver<Changes>, done: impl Fn(&Changes) -> bool) -> Changes {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut all = Changes::default();
        while !done(&all) {
            let remaining = deadline.checked_duration_since(Instant::now()).expect("no event in time");
            all.merge(receiver.recv_timeout(remaining).expect("no event in time"));
        }
        batch(receiver, all, Duration::from_millis(500))
    }

    /// Writes `marker` and waits for its event, dropping what came before: FSEvents can still report a folder that a
    /// test made just before the stream started.
    fn settle(receiver: &mpsc::Receiver<Changes>, marker: &Path) {
        fs::write(marker, "").unwrap();
        received(receiver, |changes| changes.paths.contains(marker));
    }

    #[test]
    fn trees_are_watched_once_by_where_they_really_are() {
        let p = |text: &str| PathBuf::from(text);
        let trees = outermost(vec![
            (p("/u/projects"), p("/u/projects")),
            // A root inside another, and a project's Git folder.
            (p("/u/projects/work"), p("/u/projects/work")),
            (p("/u/projects/app/.git"), p("/u/projects/app/.git")),
            // Inside a root as spelled, but elsewhere really, as through a link: the root's watch doesn't see it.
            (p("/u/projects/history"), p("/disk/history")),
            // /var is /private/var on macOS: one folder twice, so the first stays.
            (p("/var/folders/t"), p("/private/var/folders/t")),
            (p("/private/var/folders/t"), p("/private/var/folders/t")),
            // A name that only starts like another isn't inside it.
            (p("/u/projects-old"), p("/u/projects-old")),
        ]);
        assert_eq!(
            trees,
            BTreeMap::from([
                (p("/u/projects"), p("/u/projects")),
                (p("/u/projects/history"), p("/disk/history")),
                (p("/var/folders/t"), p("/private/var/folders/t")),
                (p("/u/projects-old"), p("/u/projects-old")),
            ])
        );
    }

    #[test]
    fn below_a_tree_what_nothing_reads_is_dropped() {
        let p = |text: &str| PathBuf::from(text);
        let plan = Plan {
            // The root sits in folders named like a HEAVY one and a hidden one; only the names below it count.
            kinds: BTreeMap::from([
                (p("/u/build/.work/projects"), Tree::Root),
                (p("/u/build/.work/projects/app/.git"), Tree::Git),
                (p("/u/build/.work/projects/.history"), Tree::Store),
                (p("/elsewhere/repo.git"), Tree::Git),
            ]),
            // Folders open in Browse, and the reports folder.
            open: BTreeSet::from([
                p("/u/build/.work/projects/app/node_modules/pkg"),
                p("/u/build/.work/projects/app/.github/workflows"),
                p("/u/build/.work/projects/out/reports"),
            ]),
            ..Plan::default()
        };
        for kept in [
            "/u/build/.work/projects/app/src/main.rs",
            "/u/build/.work/projects/app/node_modules",
            // A hidden folder or file directly in a project, as Linux sees it come and go in the project's folder.
            "/u/build/.work/projects/app/.vs",
            "/u/build/.work/projects/app/.laci.md",
            "/u/build/.work/projects/app/.git/refs/heads/main",
            "/u/build/.work/projects/app/.git/refs/heads/logs/today",
            "/u/build/.work/projects/app/.git/index",
            "/u/build/.work/projects/app/.git/objects",
            "/u/build/.work/projects/app/.git/fsmonitor--daemon.ipc",
            // An agent's history in a hidden folder: its own kind decides.
            "/u/build/.work/projects/.history/target/session.jsonl",
            "/elsewhere/repo.git/HEAD",
            "/elsewhere/repo.git/refs/heads/main",
            "/elsewhere/repo.git/worktrees/review/HEAD",
            "/elsewhere/other/node_modules/x/y",
            // What is directly in a folder Laci reads always counts, wherever it is.
            "/u/build/.work/projects/app/node_modules/pkg",
            "/u/build/.work/projects/app/node_modules/pkg/index.js",
            "/u/build/.work/projects/app/.github/workflows/ci.yml",
            "/u/build/.work/projects/out/reports/2026-10-19-watch.md",
        ] {
            assert!(plan.keeps(Path::new(kept)), "{kept}");
        }
        for dropped in [
            "/u/build/.work/projects/app/node_modules/other/index.js",
            "/u/build/.work/projects/app/node_modules/pkg/lib/index.js",
            "/u/build/.work/projects/app/target/debug/app",
            "/u/build/.work/projects/scratch/dist/x/y",
            "/u/build/.work/projects/out/reports/old/2025-01-01-x.md",
            // Inside a hidden folder, as Visual Studio, SwiftPM and a nested repository write.
            "/u/build/.work/projects/app/.vs/app/v17/.suo",
            "/u/build/.work/projects/app/.build/debug/app",
            "/u/build/.work/projects/app/.github/dependabot.yml",
            "/u/build/.work/projects/vendored/.git/HEAD",
            "/u/build/.work/projects/.config/code/settings.json",
            "/u/build/.work/projects/app/.git/objects/ab/cdef",
            "/u/build/.work/projects/app/.git/logs/HEAD",
            // Git's file system monitor, for each Git command another program runs.
            "/u/build/.work/projects/app/.git/fsmonitor--daemon/cookies/4242-7",
            "/elsewhere/repo.git/objects/ab/cdef",
            "/elsewhere/repo.git/logs/refs/heads/main",
            "/elsewhere/repo.git/worktrees/review/logs/HEAD",
            "/elsewhere/repo.git/worktrees/review/fsmonitor--daemon/cookies/4242-8",
            // Finder's, even in a folder Laci reads.
            "/u/build/.work/projects/.DS_Store",
            "/u/build/.work/projects/app/src/.DS_Store",
            "/u/build/.work/projects/out/reports/.DS_Store",
        ] {
            assert!(!plan.keeps(Path::new(dropped)), "{dropped}");
        }
    }

    #[test]
    fn event_paths_are_spelled_as_the_snapshot_spells_its_folders() {
        let p = |text: &str| PathBuf::from(text);
        let known = BTreeMap::from([
            // macOS reports /var as /private/var, and a folder reached through a link where the link leads.
            (p("/var/folders/t/projects"), Some(p("/private/var/folders/t/projects"))),
            (p("/var/folders/t/projects/App"), None),
            (p("/Users/me/notes"), Some(p("/Volumes/Data/notes"))),
            // A root typed in another case than the disk's, with a project and the archive in it.
            (p("/Users/me/Projects"), Some(p("/Users/me/projects"))),
            (p("/Users/me/Projects/Site"), None),
            (p("/Users/me/Projects/archive"), Some(p("/Users/me/projects/archive"))),
            // Two projects whose names differ only in case, as in a case-sensitive folder.
            (p("/Users/me/Projects/Lab"), None),
            (p("/Users/me/Projects/lab"), None),
            // A folder that isn't there: what it should be is all there is.
            (p("/Users/me/Downloads"), None),
        ]);
        let spellings = Spellings::new(known.clone(), true, false);
        let spell = |text: &str| spellings.spell(p(text));
        assert_eq!(spell("/private/var/folders/t/projects/App/main.rs"), p("/var/folders/t/projects/App/main.rs"));
        assert_eq!(spell("/private/var/folders/t/projects"), p("/var/folders/t/projects"));
        assert_eq!(spell("/var/folders/t/projects/App/x"), p("/var/folders/t/projects/App/x"), "spelled so already");
        // A project named in another case, below a folder named where it really is, or as a program typed it.
        assert_eq!(spell("/private/var/folders/t/projects/APP/src/x.rs"), p("/var/folders/t/projects/App/src/x.rs"));
        assert_eq!(spell("/var/folders/t/projects/app/x"), p("/var/folders/t/projects/App/x"));
        assert_eq!(spell("/Volumes/Data/notes/today.md"), p("/Users/me/notes/today.md"));
        assert_eq!(spell("/Users/me/projects/site/README.md"), p("/Users/me/Projects/Site/README.md"));
        assert_eq!(spell("/Users/me/projects/archive/old/x"), p("/Users/me/Projects/archive/old/x"), "the deepest");
        assert_eq!(spell("/users/ME/downloads/file.zip"), p("/Users/me/Downloads/file.zip"));
        // Of two that differ only in case, each is found as spelled and neither is guessed.
        assert_eq!(spell("/Users/me/Projects/Lab/x"), p("/Users/me/Projects/Lab/x"));
        assert_eq!(spell("/Users/me/Projects/lab/x"), p("/Users/me/Projects/lab/x"));
        assert_eq!(spell("/Users/me/projects/LAB/x"), p("/Users/me/Projects/LAB/x"), "only the root is spelled");
        assert_eq!(spell("/elsewhere/x"), p("/elsewhere/x"), "nothing known there");
        // Where names keep their case, as on Linux, only the spellings themselves count.
        let exact = Spellings::new(known, false, false);
        assert_eq!(exact.spell(p("/var/folders/t/projects/app/x")), p("/var/folders/t/projects/app/x"));
        assert_eq!(exact.spell(p("/private/var/folders/t/projects/App")), p("/var/folders/t/projects/App"));
    }

    #[test]
    fn only_names_shaped_like_short_ones_are_looked_up() {
        for short in ["PROGRA~1", "NODE_M~1", "REPORT~2.MD", "AB12C3~1", "A~10", "LONGNA~1.TXT"] {
            assert!(short_name(OsStr::new(short)), "{short}");
        }
        for long in
            ["notes.txt~", "~$report.docx", "~$REPORT.DOC", "Program Files", "progra~1", "ABCDEFGHI~1", "A~1.HTML"]
        {
            assert!(!short_name(OsStr::new(long)), "{long}");
        }
    }

    /// Not on Windows, which has real 8.3 names (see `a_short_name_in_an_event_is_spelled_long`) and makes a link only
    /// with Developer Mode or as an administrator. Here a link stands in for a short name: both are looked up by where
    /// they lead.
    #[cfg(unix)]
    #[test]
    fn a_short_name_is_looked_up_while_it_is_there() {
        let home = tempfile::tempdir().unwrap();
        let root = canonical(home.path()).unwrap().join("projects");
        let long = root.join("A project with a long name");
        fs::create_dir_all(long.join("src")).unwrap();
        std::os::unix::fs::symlink(&long, root.join("APROJE~1")).unwrap();
        let spellings = Spellings::new(BTreeMap::from([(root.clone(), Some(root.clone()))]), false, true);
        // A file that is gone still gets its folder's long name.
        assert_eq!(spellings.spell(root.join("APROJE~1/src/gone.rs")), long.join("src/gone.rs"));
        // Nothing is looked up for a name of another shape, nor for one that isn't there.
        assert_eq!(spellings.spell(root.join("notes.txt~")), root.join("notes.txt~"));
        assert_eq!(spellings.spell(root.join("OTHER~1/x")), root.join("OTHER~1/x"));
    }

    #[test]
    fn with_trees_only_settings_and_templates_count_in_the_config_folder() {
        let home = tempfile::tempdir().unwrap();
        let mut env = Env::for_home(home.path().to_owned());
        // As on Windows: data and cache inside the config folder, next to WebView2's EBWebView.
        env.data_dir = env.config_dir.join("data");
        env.cache_dir = env.config_dir.join("cache");
        let snapshot = json!({"roots":[],"connectors":[],"nodes":{}});
        let at = |path: PathBuf| Changes { paths: BTreeSet::from([path]), structural: true };
        for setting in [
            env.config_dir.clone(),
            env.config_dir.join("config.json"),
            env.config_dir.join("templates"),
            env.config_dir.join("templates/site/index.html"),
        ] {
            let refresh = refresh_with(Design::Trees, &env, &snapshot, &at(setting.clone()));
            assert_eq!(refresh, Refresh::full(), "{}", setting.display());
        }
        for other in [
            env.config_dir.join("EBWebView"),
            env.config_dir.join("EBWebView/Default/Cache/data_1"),
            env.config_dir.join("cache"),
            env.cache_dir.join("snapshot-v2.json"),
            env.config_dir.join("no-git-hooks"),
            env.data_dir.join("journal.jsonl"),
        ] {
            let refresh = refresh_with(Design::Trees, &env, &snapshot, &at(other.clone()));
            assert_eq!(refresh, Refresh::default(), "{}", other.display());
        }
        // Linux reads any change there as one of the settings, as it always has.
        let refresh = refresh_with(Design::Folders, &env, &snapshot, &at(env.config_dir.join("EBWebView")));
        assert_eq!(refresh, Refresh::full());
    }

    #[test]
    fn with_trees_a_change_outside_projects_rescans_where_linux_would_see_it() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let root = home.path().join("projects");
        let clients = root.join("clients");
        let site = clients.join("site");
        let reports = root.join("reports");
        // Roots inside another, one of them below a hidden folder.
        let work = root.join("work");
        let hidden = root.join(".config/code");
        let snapshot = json!({"roots":[root, work, hidden],"connectors":[],"reportsDir":{"path":reports},"nodes":{
            "clients":{"id":"clients","kind":"folder","path":clients},
            "site":{"id":"site","kind":"project","path":site}
        }});
        let at = |path: PathBuf, structural| Changes { paths: BTreeSet::from([path]), structural };
        let trees = |changes: Changes| refresh_with(Design::Trees, &env, &snapshot, &changes);
        // Linux watches the roots, the folders of projects and the reports folder, and sees what is directly in them.
        for seen in [
            root.clone(),
            root.join("notes.md"),
            clients.clone(),
            clients.join("README.md"),
            reports.join("a.txt"),
            work.join("notes.md"),
            hidden.join("notes.md"),
        ] {
            assert_eq!(trees(at(seen.clone(), false)), Refresh::full(), "{}", seen.display());
        }
        // Deeper down, only a file or folder that comes or goes can make a project.
        assert_eq!(trees(at(root.join("scratch/new-app/.git"), true)), Refresh::agents());
        assert_eq!(trees(at(root.join("scratch/new-app/notes.txt"), false)), Refresh::default());
        assert_eq!(trees(at(root.join("scratch/.tox/env/lib"), true)), Refresh::default(), "never scanned");
        assert_eq!(trees(at(hidden.join("new-app/.git"), true)), Refresh::agents(), "the root itself is scanned");
        let linux = refresh_with(Design::Folders, &env, &snapshot, &at(root.join("scratch/new-app/notes.txt"), false));
        assert_eq!(linux, Refresh::full(), "Linux scans again for whatever its watches see there");
        // In a project: its own refresh. A tree needs no new watch for a new folder in it.
        let inside = at(site.join("src/new.rs"), true);
        assert_eq!(
            trees(inside.clone()),
            Refresh { projects: BTreeSet::from(["site".to_owned()]), ..Refresh::default() }
        );
        assert!(refresh_with(Design::Folders, &env, &snapshot, &inside).watches);
    }

    #[test]
    fn trees_take_in_the_roots_stores_and_outside_git_folders_once() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let root = home.path().join("projects");
        let nested = root.join("work");
        let app = nested.join("app");
        let linked = root.join("linked");
        let main = home.path().join("elsewhere").join("main");
        let private = main.join(".git").join("worktrees").join("review");
        let store = home.path().join(".claude").join("projects");
        let reports = home.path().join("reports");
        let browsed = home.path().join("Downloads");
        for dir in [&app.join(".git"), &app.join("src"), &linked, &private, &store, &reports, &browsed] {
            fs::create_dir_all(dir).unwrap();
        }
        for dir in [&env.config_dir, &env.data_dir] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(linked.join(".git"), "gitdir: ../../elsewhere/main/.git/worktrees/review\n").unwrap();
        fs::write(private.join("commondir"), "../..\n").unwrap();
        let codex = home.path().join(".codex").join("sessions");
        let snapshot = json!({
            "roots":[root, nested],
            "connectors":[{"id":"claude","link":{"dir":store}},{"id":"codex","provider":"codex","link":{"dir":codex}}],
            "nodes":{
                "work":{"id":"work","kind":"folder","path":nested},
                "app":{"id":"app","kind":"project","path":app},
                "linked":{"id":"linked","kind":"project","path":linked}
            },
            "reportsDir":{"path":reports}
        });
        let listings = BTreeSet::from([app.join("src"), browsed.clone()]);
        let wanted = Watches::desired_for(Design::Trees, &env, &snapshot, &listings);
        assert_eq!(wanted.trees, BTreeSet::from([root.clone(), store.clone(), main.join(".git")]));
        // Codex's history folder isn't there yet: the folder it will be made in is watched until then.
        let expected: BTreeSet<_> = [&env.config_dir, &env.data_dir, &reports, &browsed]
            .into_iter()
            .cloned()
            .chain([home.path().into()])
            .collect();
        assert_eq!(wanted.single, expected);
        assert!(wanted.contains(&app.join("src")), "a folder open in Browse inside a root is seen through the root");
        assert!(wanted.open.contains(&app.join("src")), "and what is directly in it always counts");
        assert_eq!(wanted.kinds.get(&private), Some(&Tree::Git), "read by its kind inside the tree it is in");
        assert_eq!(wanted.kinds.get(&store), Some(&Tree::Store));
        assert_eq!(wanted.kinds.get(&nested), Some(&Tree::Root));
        // Events are spelled back by every folder the snapshot names: where it really is, when it was looked up.
        assert_eq!(wanted.known.get(&app), Some(&None));
        assert_eq!(wanted.known.get(&nested), Some(&Some(canonical(&nested).unwrap())));
        assert_eq!(wanted.known.get(&private), Some(&Some(canonical(&private).unwrap())));
        assert_eq!(wanted.known.get(&codex), None, "the snapshot names no folder there");
    }

    #[test]
    fn a_tree_watch_drops_events_in_folders_nothing_reads() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let root = home.path().join("projects");
        let project = root.join("app");
        let unread = ["node_modules/pkg", ".vs/v17", ".git/objects/ab", ".git/fsmonitor--daemon/cookies"];
        for dir in unread.iter().chain(&["src", ".git/refs/heads"]) {
            fs::create_dir_all(project.join(dir)).unwrap();
        }
        let snapshot =
            json!({"roots":[root],"connectors":[],"nodes":{"app":{"id":"app","kind":"project","path":project}}});
        let (sender, receiver) = mpsc::channel();
        let watcher = Watches::with(sender, Design::Trees).unwrap();
        let count = watcher.install(Watches::desired_for(Design::Trees, &env, &snapshot, &BTreeSet::new()));
        assert_eq!(count, Count { watches: 1, trees: 1, failed: 0 }, "the project's Git folder is inside the root");
        assert_eq!(watcher.renew(), count, "the same watches, set up again");
        settle(&receiver, &root.join("ready"));
        let unread = unread.map(|dir| project.join(dir));
        for dir in &unread {
            fs::write(dir.join("file"), "x").unwrap();
        }
        let source = project.join("src/main.rs");
        fs::write(&source, "fn main() {}\n").unwrap();
        let changes = received(&receiver, |changes| changes.paths.contains(&source));
        assert!(!changes.paths.iter().any(|path| unread.iter().any(|dir| path.starts_with(dir))), "{changes:?}");
        let refresh = refresh_with(Design::Trees, &env, &snapshot, &changes);
        assert_eq!(refresh.projects, BTreeSet::from(["app".to_owned()]));
        assert!(!refresh.full, "{changes:?}");
    }

    /// Windows sets its watches up again every minute. The new ones start before the old ones stop, so a change made
    /// meanwhile is still seen.
    #[test]
    fn a_change_made_while_the_watches_are_set_up_again_is_seen() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let root = home.path().join("projects");
        let project = root.join("app");
        fs::create_dir_all(project.join("src")).unwrap();
        let snapshot =
            json!({"roots":[root],"connectors":[],"nodes":{"app":{"id":"app","kind":"project","path":project}}});
        let (sender, receiver) = mpsc::channel();
        let watcher = Watches::with(sender, Design::Trees).unwrap();
        let count = watcher.install(Watches::desired_for(Design::Trees, &env, &snapshot, &BTreeSet::new()));
        settle(&receiver, &root.join("ready"));
        let written: Vec<PathBuf> = (0..40).map(|n| project.join("src").join(format!("{n}.rs"))).collect();
        let writer = {
            let written = written.clone();
            thread::spawn(move || {
                for file in written {
                    fs::write(file, "").unwrap();
                    thread::sleep(Duration::from_millis(5));
                }
            })
        };
        let mut renewed = 0;
        while renewed == 0 || !writer.is_finished() {
            assert_eq!(watcher.renew(), count);
            renewed += 1;
            thread::sleep(Duration::from_millis(10));
        }
        writer.join().unwrap();
        let mut seen = Changes::default();
        let deadline = Instant::now() + Duration::from_secs(10);
        while let Some(remaining) = deadline.checked_duration_since(Instant::now())
            && !written.iter().all(|file| seen.paths.contains(file))
            && let Ok(changes) = receiver.recv_timeout(remaining)
        {
            seen.merge(changes);
        }
        let missed: Vec<_> = written.iter().filter(|file| !seen.paths.contains(*file)).collect();
        assert!(missed.is_empty(), "set up again {renewed} times, missed {missed:?}");
    }

    #[test]
    fn with_trees_an_event_is_spelled_first_then_what_has_no_use_is_dropped() {
        use notify::event::{CreateKind, EventKind, ModifyKind};
        let temp = tempfile::tempdir().unwrap();
        let root = canonical(temp.path()).unwrap().join("projects");
        let app = root.join("App");
        fs::create_dir_all(app.join("src")).unwrap();
        let plan = Plan {
            spellings: Spellings::new(
                BTreeMap::from([(root.clone(), Some(root.clone())), (app.clone(), None)]),
                true,
                false,
            ),
            kinds: BTreeMap::from([(root.clone(), Tree::Root)]),
            open: BTreeSet::new(),
        };
        let (sender, receiver) = mpsc::channel();
        let handler =
            Handler { design: Design::Trees, plan: Arc::new(RwLock::new(plan)), lost: Arc::default(), sender };
        let event = |kind, path: PathBuf| Ok(notify::Event::new(kind).add_path(path));
        let created = EventKind::Create(CreateKind::File);
        // Named in another case: dropped or kept by the snapshot's spelling.
        handler.handle(event(created, root.join("APP/src/new.rs")));
        handler.handle(event(created, root.join("APP/node_modules/pkg/index.js")));
        handler.handle(event(created, root.join("APP/.vs/App/v17/.suo")));
        handler.handle(event(created, app.join("src/.tmp-save")));
        handler.handle(event(created, app.join("src/.DS_Store")));
        handler.handle(event(EventKind::Access(notify::event::AccessKind::Any), app.join("src/main.rs")));
        // Windows says a folder changed when what is in it did; a file's own change counts.
        handler.handle(event(EventKind::Modify(ModifyKind::Any), app.join("src")));
        handler.handle(event(EventKind::Modify(ModifyKind::Any), app.join("src/main.rs")));
        let sent: Vec<Changes> = receiver.try_iter().collect();
        let paths: Vec<_> = sent.iter().map(|changes| (changes.paths.clone(), changes.structural)).collect();
        assert_eq!(
            paths,
            [(BTreeSet::from([app.join("src/new.rs")]), true), (BTreeSet::from([app.join("src/main.rs")]), false)]
        );
        // Linux reads every name as it always has.
        let (sender, receiver) = mpsc::channel();
        let linux = Handler { design: Design::Folders, plan: Arc::default(), lost: Arc::default(), sender };
        linux.handle(event(created, app.join("src/.DS_Store")));
        linux.handle(event(created, app.join(".vs/App/v17/.suo")));
        assert_eq!(receiver.try_iter().count(), 2);
    }

    #[test]
    fn with_trees_a_lost_event_or_a_failed_watcher_asks_for_everything() {
        let rescan = || notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan);
        for design in [Design::Folders, Design::Trees] {
            let (sender, receiver) = mpsc::channel();
            let handler = Handler { design, plan: Arc::default(), lost: Arc::default(), sender };
            handler.handle(Ok(rescan()));
            handler.handle(Err(notify::Error::generic("the watch stopped")));
            let trees = design == Design::Trees;
            assert_eq!(handler.lost.load(Ordering::Acquire), trees, "{design:?}");
            // Each wakes the thread that batches changes, with no change of its own.
            let woken: Vec<_> = receiver.try_iter().collect();
            assert_eq!(woken.len(), if trees { 2 } else { 0 }, "{design:?}");
            assert!(woken.iter().all(|changes| changes.paths.is_empty() && !changes.structural));
        }
        // FSEvents names the folder to look at again; that is no change in it.
        let (sender, receiver) = mpsc::channel();
        let watches = Watches::with(sender, Design::Trees).unwrap();
        watches.handler.handle(Ok(rescan().add_path(PathBuf::from("/u/projects"))));
        assert!(receiver.try_iter().all(|changes| changes.paths.is_empty()));
        assert!(watches.take_lost() && !watches.take_lost(), "told once");
    }

    /// macOS and Windows find a name in any case, and a program can change a file through a path typed in another case
    /// than the disk's. Whichever case the event names, it reaches the project as the snapshot spells it.
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn a_change_made_through_another_case_reaches_the_project() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let root = home.path().join("projects");
        let project = root.join("App");
        fs::create_dir_all(project.join("src")).unwrap();
        let snapshot =
            json!({"roots":[root],"connectors":[],"nodes":{"app":{"id":"app","kind":"project","path":project}}});
        let (sender, receiver) = mpsc::channel();
        let watcher = Watches::new(sender).unwrap();
        watcher.install(Watches::desired(&env, &snapshot, &BTreeSet::new()));
        settle(&receiver, &root.join("ready"));
        fs::write(root.join("APP").join("src").join("main.rs"), "fn main() {}\n").unwrap();
        let named = |changes: &Changes| changes.paths.iter().any(|path| path.ends_with("main.rs"));
        let changes = received(&receiver, named);
        assert!(changes.paths.iter().all(|path| path.starts_with(&project)), "{changes:?}");
        let refresh = refresh_for(&env, &snapshot, &changes);
        assert_eq!(refresh.projects, BTreeSet::from(["app".to_owned()]));
        assert!(!refresh.full, "{changes:?}");
    }

    /// /var is a link to /private/var, and FSEvents reports where a path really is.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_event_under_private_var_reaches_the_project_spelled_with_var() {
        let temp = tempfile::Builder::new().prefix("laci-watch").tempdir_in("/var/tmp").unwrap();
        let root = temp.path().join("projects");
        let project = root.join("app");
        fs::create_dir_all(project.join("src")).unwrap();
        assert!(root.starts_with("/var/tmp") && canonical(&root).unwrap().starts_with("/private/var/tmp"));
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let snapshot =
            json!({"roots":[root],"connectors":[],"nodes":{"app":{"id":"app","kind":"project","path":project}}});
        let (sender, receiver) = mpsc::channel();
        let watcher = Watches::new(sender).unwrap();
        watcher.install(Watches::desired(&env, &snapshot, &BTreeSet::new()));
        settle(&receiver, &root.join("ready"));
        let source = project.join("src/main.rs");
        fs::write(&source, "fn main() {}\n").unwrap();
        let changes = received(&receiver, |changes| changes.paths.contains(&source));
        assert!(changes.paths.iter().all(|path| path.starts_with(&project)), "{changes:?}");
        let refresh = refresh_for(&env, &snapshot, &changes);
        assert_eq!(refresh.projects, BTreeSet::from(["app".to_owned()]));
        assert!(!refresh.full, "{changes:?}");
    }

    /// NTFS refuses to rename a folder while a folder inside it is open, and Windows keeps a watched folder open: a
    /// watch inside a project would stop Laci from moving it. The root's watch sees the rename.
    #[cfg(windows)]
    #[test]
    fn renaming_a_project_under_a_watched_root_is_seen() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let root = home.path().join("projects");
        let project = root.join("app");
        fs::create_dir_all(project.join(".git").join("refs").join("heads")).unwrap();
        fs::create_dir_all(project.join("src")).unwrap();
        let snapshot =
            json!({"roots":[root],"connectors":[],"nodes":{"app":{"id":"app","kind":"project","path":project}}});
        // A folder of the project open in Browse is seen through the root's watch, with no watch of its own.
        let listings = BTreeSet::from([project.join("src")]);
        let (sender, receiver) = mpsc::channel();
        let watcher = Watches::new(sender).unwrap();
        let count = watcher.install(Watches::desired(&env, &snapshot, &listings));
        assert_eq!(count, Count { watches: 1, trees: 1, failed: 0 });
        let renamed = root.join("renamed");
        // Tried again for a moment, as a scan by Defender or Search can hold a folder that briefly; a watch never lets go.
        laci_core::platform::retry(|| fs::rename(&project, &renamed)).expect("no watch holds the project open");
        let changes =
            received(&receiver, |changes| changes.paths.contains(&project) && changes.paths.contains(&renamed));
        assert!(changes.structural);
        assert!(refresh_for(&env, &snapshot, &changes).full, "a project left the scan");
    }

    /// ReadDirectoryChangesW can name a file or folder by its 8.3 short name; the snapshot has the long one.
    #[cfg(windows)]
    #[test]
    fn a_short_name_in_an_event_is_spelled_long() {
        use std::os::windows::process::CommandExt;
        let home = tempfile::tempdir().unwrap();
        let root = canonical(home.path()).unwrap().join("projects");
        let long = root.join("A project with a long name");
        fs::create_dir_all(long.join("src")).unwrap();
        // The 8.3 form of the project's path, as cmd gives it. A volume that makes no short names gives the long one.
        let out = std::process::Command::new("cmd")
            .raw_arg(format!(r#"/d /c for %I in ("{}") do @echo %~sI"#, long.display()))
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let short = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        let Some(name) = short.file_name().filter(|name| Some(*name) != long.file_name()) else {
            eprintln!("This volume makes no 8.3 names; nothing to spell.");
            return;
        };
        assert!(short_name(name), "{}", short.display());
        let spellings = Spellings::new(BTreeMap::from([(root.clone(), canonical(&root).ok())]), true, true);
        // A file that is gone still gets its folder's long name.
        assert_eq!(spellings.spell(root.join(name).join("src").join("gone.rs")), long.join("src").join("gone.rs"));
    }
}
