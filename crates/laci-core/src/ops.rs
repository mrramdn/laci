//! Journaled disk changes. The journal and PID lock remain readable by Laci v1.
use crate::{
    Result,
    env::Env,
    files, paths,
    platform::{
        self,
        path::{below, contains, git_dir_name, may_contain, relocate, rewrite_prefix, same_path, stays_below},
        preserve,
    },
    process, sidecar,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        Mutex, TryLockError,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

static SEQ: AtomicU64 = AtomicU64::new(0);
static IN_PROCESS: Mutex<()> = Mutex::new(());
/// The data folders of the backups and moves of the copy of AI chats that run in this process ([`LongRun`]).
static LONG_RUNS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
thread_local! {
    /// This thread runs a backup or a move of the copy of AI chats, so it may wait for the change lock.
    static IN_LONG_RUN: Cell<bool> = const { Cell::new(false) };
}
/// What a change asked for while a backup or a move of the copy of AI chats runs is told.
pub const COPYING: &str = "Laci is copying your AI chats. Try again when it's done.";

/// A backup or a move of the copy of AI chats, which can take minutes, runs on this thread until this is dropped.
/// Meanwhile a change of the same Laci data on another thread that would wait for the change lock is refused at once
/// ([`with_lock`]).
pub struct LongRun(PathBuf);
impl LongRun {
    pub fn start(env: &Env) -> Self {
        LONG_RUNS.lock().unwrap_or_else(|e| e.into_inner()).push(env.data_dir.clone());
        IN_LONG_RUN.with(|long| long.set(true));
        Self(env.data_dir.clone())
    }
}
impl Drop for LongRun {
    fn drop(&mut self) {
        IN_LONG_RUN.with(|long| long.set(false));
        let mut runs = LONG_RUNS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(at) = runs.iter().position(|dir| *dir == self.0) {
            runs.remove(at);
        }
    }
}
/// Whether a backup or a move of the copy of the Laci data in `env` runs on another thread now.
fn long_run_elsewhere(env: &Env) -> bool {
    !IN_LONG_RUN.with(Cell::get) && LONG_RUNS.lock().unwrap_or_else(|e| e.into_inner()).contains(&env.data_dir)
}
fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}
fn path(env: &Env, raw: &str) -> Result<PathBuf> {
    let p = paths::workspace_path(raw, env)?;
    sidecar::plain_path(&p)?;
    Ok(p)
}
fn value_path(env: &Env, v: &Value) -> Result<PathBuf> {
    path(env, v.as_str().ok_or("Missing file path")?)
}
fn journal_path(env: &Env, entry: &Value, key: &str) -> Result<PathBuf> {
    if key == "path" && entry["kind"] == "file" && entry["scope"] == "config" {
        let file = paths::config_file(env)?;
        if entry[key].as_str() != file.to_str() {
            return Err("Invalid configuration journal path".into());
        }
        return Ok(file);
    }
    // The copy of AI chats can be in a folder outside home, on a drive that may be gone: a move of its files names
    // the copy folders it touches, and a path in one of those is checked against that folder as it was recorded.
    if entry["scope"] == "copy"
        && entry["kind"] == "move"
        && let Some(path) =
            crate::backup::journal_path(env, entry[key].as_str().ok_or("Missing file path")?, &entry["roots"])?
    {
        return Ok(path);
    }
    let checked = value_path(env, &entry[key]);
    if checked.is_err()
        && key == "from"
        && entry["kind"] == "move"
        && let (Some(volume), Some(file)) = (entry["parentDevice"].as_u64(), entry["parentInode"].as_u64())
    {
        let parent = platform::Identity { volume, file };
        return paths::restore_workspace_root(entry[key].as_str().ok_or("Missing source path")?, env, parent);
    }
    checked
}

pub(crate) fn data(env: &Env, name: &str) -> Result<PathBuf> {
    let path = paths::home_path(&env.data_dir.join(name).to_string_lossy(), env)?;
    sidecar::plain_path(&path)?;
    Ok(path)
}
/// Whether `id` can name a journal file: no folder in it.
pub(crate) fn valid_id(id: &str) -> bool {
    !(id.is_empty() || id.contains(['/', '\\']) || id == "." || id == "..")
}
fn id() -> String {
    format!(
        "{}-{:x}-{:x}",
        files::now().replace([':', '.'], "-"),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}
fn lock(env: &Env) -> Result<platform::Lock> {
    let path = data(env, "lock")?;
    files::private_dir(&env.data_dir)?;
    platform::lock(path)
}
pub fn with_lock<T>(env: &Env, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let interrupted = || "File-change lock was interrupted".to_owned();
    let _serial = match IN_PROCESS.try_lock() {
        Ok(serial) => serial,
        // A backup or a move of the copy holds it for minutes: waiting would hold up whoever asked, as the window.
        Err(TryLockError::WouldBlock) if long_run_elsewhere(env) => return Err(COPYING.into()),
        Err(TryLockError::WouldBlock) => IN_PROCESS.lock().map_err(|_| interrupted())?,
        Err(TryLockError::Poisoned(_)) => return Err(interrupted()),
    };
    let _lock = lock(env)?;
    work()
}

/// Copies without following links or overwriting anything; used by cross-device moves and templates.
pub(crate) fn copy_tree(src: &Path, dest: &Path) -> Result<()> {
    copy_tree_inner(src, dest, false)
}
pub(crate) fn copy_template(src: &Path, dest: &Path) -> Result<()> {
    copy_tree_inner(src, dest, true)
}
fn copy_tree_inner(src: &Path, dest: &Path, skip_git: bool) -> Result<()> {
    let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    if meta.is_symlink() {
        platform::copy_link(src, dest)?;
    } else if meta.is_dir() {
        fs::create_dir(dest).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let e = entry.map_err(|e| e.to_string())?;
            if skip_git && git_dir_name(&e.file_name()) {
                continue;
            }
            copy_tree_inner(&e.path(), &dest.join(e.file_name()), skip_git)?;
        }
        preserve(&meta, dest)?;
    } else if meta.is_file() {
        let mut input = File::open(src).map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new().write(true).create_new(true).open(dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all()).map_err(|e| e.to_string())?;
        drop(output);
        preserve(&meta, dest)?;
    } else {
        return Err(format!("Unsupported special file {}", src.display()));
    }
    Ok(())
}
/// Removes a file or a folder with everything in it ([`platform::remove_all`]), read-only files included.
pub(crate) fn remove(path: &Path) -> Result<()> {
    platform::remove_all(path).map_err(|e| e.to_string())
}
fn rename(src: &Path, dest: &Path) -> Result<()> {
    match platform::rename_noreplace(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => rename_across(src, dest),
        Err(e) => Err(e.to_string()),
    }
}
/// A move to another volume: a copy, made in a private sibling of `dest` and published there in one step, and then
/// the source is deleted. Whether the source can leave its folder is asked first, by setting it aside under a free name
/// beside it and back: that fails when its folder can't be changed, so nothing is copied for a move that couldn't
/// finish. The source stays in its place while
/// it is copied, so a copy that stops part-way, as when Laci is closed, leaves it there. It is set aside again just
/// before the copy is published, put back if that fails, and deleted only once the copy is in place. NFS, 9p
/// (as WSL's /mnt/c), eCryptfs and FUSE file systems without RENAME2, such as sshfs, can't rename without replacing,
/// so a source there is never set aside: its copy is published and then it is deleted where it is.
fn rename_across(src: &Path, dest: &Path) -> Result<()> {
    rename_across_with(src, dest, platform::rename_noreplace)
}
/// [`rename_across`] with `beside`, the rename in the source's own folder that sets it aside and puts it back.
fn rename_across_with(src: &Path, dest: &Path, beside: impl Fn(&Path, &Path) -> std::io::Result<()>) -> Result<()> {
    let staged = tempfile::Builder::new()
        .prefix(".laci-move-")
        .tempdir_in(dest.parent().ok_or("Missing destination parent")?)
        .map_err(|e| e.to_string())?;
    let aside = src.parent().ok_or("Missing parent")?.join(format!(
        ".laci-move-{:x}-{:x}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    across(src, dest, &beside, &aside, staged.path())
}
/// The move of [`rename_across`] in the folder `staged`, made beside `dest`, with the source set aside as `aside`.
fn across(
    src: &Path,
    dest: &Path,
    beside: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
    aside: &Path,
    staged: &Path,
) -> Result<()> {
    let name = src.file_name().unwrap_or_default().to_string_lossy();
    let payload = staged.join("payload");
    let set_aside = || beside(src, aside).map_err(|e| e.to_string());
    let put_back = || {
        beside(aside, src)
            .map_err(|e| format!("Laci couldn't put {name} back, so it is at {} now: {e}", aside.display()))
    };
    let settable = match beside(src, aside) {
        Ok(()) => put_back().map(|()| true)?,
        // EINVAL: the file system can't rename without replacing, and nothing was renamed.
        Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => false,
        Err(e) => return Err(e.to_string()),
    };
    // The copy keeps read-only files, which the staging folder has to lose too. Its folders are on the disk before
    // the source goes, as its files are.
    if let Err(error) = copy_tree(src, &payload)
        .and_then(|()| sync_folders(&payload))
        .and_then(|()| if settable { set_aside() } else { Ok(()) })
    {
        let _ = remove(&payload);
        return Err(error);
    }
    // The source is out of its place on its own drive before its copy takes a place on the other one: each drive keeps
    // its own order, so without this a power cut could leave both, whole.
    if settable && let Err(error) = crate::backup::sync_dir(src.parent().ok_or("Missing parent")?) {
        let back = put_back();
        let _ = remove(&payload);
        return Err(match back {
            Ok(()) => error,
            Err(e) => format!("{error} · {e}"),
        });
    }
    if let Err(error) = platform::rename_noreplace(&payload, dest).map_err(|e| e.to_string()) {
        let back = if settable { put_back() } else { Ok(()) };
        let _ = remove(&payload);
        return Err(match back {
            Ok(()) => error,
            Err(e) => format!("{error} · {e}"),
        });
    }
    // The copy is in its place on the disk before anything of the source is deleted: a power cut can't take both.
    crate::backup::sync_dir(dest.parent().ok_or("Missing destination parent")?)?;
    let left = if settable { aside } else { src };
    remove(left).map_err(|e| {
        format!(
            "Laci couldn't delete {}, what is left of {name} after the copy, so delete that folder by hand: {e}",
            left.display()
        )
    })
}
/// Writes to the disk what each folder in `root`, and `root` itself when it is one, lists.
fn sync_folders(root: &Path) -> Result<()> {
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_dir() {
            crate::backup::sync_dir(entry.path())?;
        }
    }
    Ok(())
}
/// What a move of the copy of AI chats from `src` to `dest` sets aside and copies into when it crosses drives, named
/// by the `token` its journal entry records, so that a move that stopped part-way can be finished
/// ([`repair_copy_move`]): `(aside, staged)`.
fn copy_move_names(src: &Path, dest: &Path, token: &str) -> Result<(PathBuf, PathBuf)> {
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("Invalid move in the journal".into());
    }
    let aside = src.parent().ok_or("Missing parent")?.join(format!("{}{token}-aside", crate::backup::MOVE));
    let staged =
        dest.parent().ok_or("Missing destination parent")?.join(format!("{}{token}-stage", crate::backup::MOVE));
    Ok((aside, staged))
}
/// [`rename`] for a file or folder of the copy of AI chats, which leaves, when it stops part-way on another drive,
/// what [`repair_copy_move`] knows by `token`.
fn rename_copy(src: &Path, dest: &Path, token: &str) -> Result<()> {
    match platform::rename_noreplace(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            let (aside, staged) = copy_move_names(src, dest, token)?;
            fs::create_dir(&staged).map_err(|e| format!("{}: {e}", staged.display()))?;
            let moved = across(src, dest, &platform::rename_noreplace, &aside, &staged);
            let _ = fs::remove_dir(&staged);
            moved
        }
        Err(e) => Err(e.to_string()),
    }
}
/// Puts right what a move of the copy from `src` to `dest` left if it stopped part-way: a copy whose source went
/// is published, a source that was set aside goes back, and what is left of a source whose copy is in place goes.
/// Afterwards `src` or `dest` is there, whole, and nothing set aside or staged. Changes nothing for a move that
/// finished or never started.
fn repair_copy_move(src: &Path, dest: &Path, token: &str) -> Result<()> {
    let (aside, staged) = copy_move_names(src, dest, token)?;
    let payload = staged.join("payload");
    if exists(dest) {
        if exists(src) {
            return Err(format!(
                "Both {} and {} are there, so Laci stopped: keep the one that is complete and remove the other.",
                src.display(),
                dest.display()
            ));
        }
        // The copy was published, and on the disk, before anything of the source went.
        for left in [&aside, &staged] {
            if exists(left) {
                remove(left)?;
            }
        }
        return Ok(());
    }
    if !exists(src) && !exists(&aside) && exists(&payload) {
        // The source goes only once its copy is complete: that copy is all there is now.
        platform::rename_noreplace(&payload, dest).map_err(|e| e.to_string())?;
        crate::backup::sync_dir(dest.parent().ok_or("Missing destination parent")?)?;
        let _ = fs::remove_dir(&staged);
        return Ok(());
    }
    if exists(&staged) {
        remove(&staged)?;
    }
    if !exists(src) && exists(&aside) {
        platform::rename_noreplace(&aside, src).map_err(|e| e.to_string())?;
    }
    Ok(())
}
/// The processes working inside `paths`, as messages and the UI show them. Fails where Laci can't list processes.
pub(crate) fn busy_in(paths: &[PathBuf]) -> Result<Vec<Value>> {
    Ok(platform::processes_in(paths)?
        .into_iter()
        // Laci's own helpers, such as a scan's `git status`, don't hold the folder; terminals and apps it opens
        // still do. Checked after the read: a helper's pid is unlisted before it can be reused.
        .filter(|h| !process::is_own_child(h.pid))
        // A folder name that isn't UTF-8 must not stop the message being written.
        .map(|h| json!({"pid":h.pid,"name":h.name,"cwd":h.cwd.to_string_lossy()}))
        .collect())
}
/// How long a change waits for Git that another program runs in the folder, such as a second Laci or an editor.
/// Such a read is over in moments; Git that is still there after this, or anything else, keeps the folder in use.
const GIT_WAIT: Duration = Duration::from_secs(3);
/// [`busy_in`] for checks that decide something. A process counts only if it is still in the folder a moment
/// later, so one that is just passing through, such as a helper of another Laci still starting, doesn't make the
/// folder busy. While Git (`git…`) is all that stays, it looks again for up to
/// [`GIT_WAIT`].
pub(crate) fn still_busy(paths: &[PathBuf]) -> Result<Vec<Value>> {
    let started = Instant::now();
    let mut seen = busy_in(paths)?;
    while !seen.is_empty() {
        thread::sleep(Duration::from_millis(100));
        let lasting: Vec<Value> =
            busy_in(paths)?.into_iter().filter(|b| seen.iter().any(|s| s["pid"] == b["pid"])).collect();
        let git = |b: &Value| b["name"].as_str().is_some_and(|name| name.starts_with("git"));
        if lasting.is_empty() || !lasting.iter().all(git) || started.elapsed() >= GIT_WAIT {
            return Ok(lasting);
        }
        seen = lasting;
    }
    Ok(seen)
}
/// What holds a folder, for an error: "name (pid N), …".
pub(crate) fn holders(busy: &[Value]) -> String {
    busy.iter()
        .map(|b| format!("{} (pid {})", b["name"].as_str().unwrap_or("process"), b["pid"]))
        .collect::<Vec<_>>()
        .join(", ")
}
fn guard(paths: &[PathBuf]) -> Result<()> {
    let busy = still_busy(paths)?;
    if busy.is_empty() { Ok(()) } else { Err(format!("In use by {}. Close it first.", holders(&busy))) }
}

struct Tx<'a> {
    env: &'a Env,
    journal: Value,
    file: PathBuf,
    n: usize,
}
impl<'a> Tx<'a> {
    /// `say` is the change in parts, which the Log's readers tell in their own words (activity.rs `record`).
    fn new(env: &'a Env, title: &str, say: Value) -> Result<Self> {
        let id = id();
        let file = data(env, "journal")?.join(format!("{id}.json"));
        let mut journal = json!({"id":id,"at":files::now(),"title":title,"state":"running","entries":[]});
        if say.is_object() {
            journal["say"] = say;
        }
        let tx = Self { env, journal, file, n: 0 };
        tx.save()?;
        Ok(tx)
    }
    /// A journal that a move of the copy of AI chats that stopped part-way goes on with ([`settle_copy`]).
    fn resume(env: &'a Env, journal: Value, file: PathBuf) -> Self {
        let n = journal["entries"].as_array().map_or(0, Vec::len) + 1;
        Self { env, journal, file, n }
    }
    fn save(&self) -> Result<()> {
        files::replace(&self.file, serde_json::to_vec_pretty(&self.journal).map_err(|e| e.to_string())?.as_slice())
    }
    /// [`Tx::save`], on the disk before anything that comes after it: a move of the copy of AI chats can cross to
    /// another drive, which keeps its own order.
    fn save_durably(&self) -> Result<()> {
        self.save()?;
        crate::backup::sync_dir(self.file.parent().ok_or("Missing folder")?)
    }
    fn log(&mut self, entry: Value) -> Result<()> {
        self.journal["entries"].as_array_mut().unwrap().push(entry);
        self.save()
    }
    fn mkdirs(&mut self, dir: &Path) -> Result<()> {
        sidecar::plain_path(dir)?;
        let mut missing = vec![];
        let mut cur = dir;
        while !exists(cur) {
            missing.push(cur.to_path_buf());
            cur = cur.parent().ok_or("Invalid folder")?;
        }
        if !cur.is_dir() {
            return Err("Parent is not a folder".into());
        }
        for p in missing.into_iter().rev() {
            fs::create_dir(&p).map_err(|e| e.to_string())?;
            self.log(json!({"kind":"mkdir","path":p}))?;
        }
        Ok(())
    }
    fn move_to(&mut self, src: &Path, dest: &Path) -> Result<()> {
        self.move_journaled(src, dest, Value::Null)
    }
    /// [`Tx::move_to`] for a file or folder of the copy of AI chats, which may be outside home: the entry names the
    /// copy folders it touches (`backup::journal_root`), so Undo can check them.
    fn move_copy(&mut self, src: &Path, dest: &Path, roots: &Value) -> Result<()> {
        self.move_journaled(src, dest, roots.clone())
    }
    fn move_journaled(&mut self, src: &Path, dest: &Path, roots: Value) -> Result<()> {
        sidecar::plain_path(src)?;
        sidecar::plain_path(dest)?;
        if exists(dest) {
            return Err(format!("{} already exists", paths::tilde(dest, &self.env.home)));
        }
        if !exists(src) {
            return Err(format!("{} is gone", paths::tilde(src, &self.env.home)));
        }
        if contains(src, dest) {
            return Err("Can't move a folder into itself".into());
        }
        if src.is_dir() {
            guard(&[src.to_owned()])?;
        }
        let mut entry = json!({"kind":"move","from":src,"to":dest});
        let token =
            roots.is_array().then(|| format!("{:x}-{:x}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        if let Some(token) = &token {
            entry["scope"] = json!("copy");
            entry["roots"] = roots;
            entry["token"] = json!(token);
        }
        if !src.starts_with(&self.env.home) && paths::workspace_roots(self.env).iter().any(|root| root == src) {
            let parent = src.parent().ok_or("Missing workspace parent")?;
            let id = platform::identity(parent, &fs::metadata(parent).map_err(|e| e.to_string())?)?;
            if platform::identity(src, &fs::metadata(src).map_err(|e| e.to_string())?)?.volume != id.volume {
                return Err("Can't move the mounted workspace root itself; select a project inside it".into());
            }
            entry["parentDevice"] = json!(id.volume);
            entry["parentInode"] = id.file_json();
        }
        self.mkdirs(dest.parent().ok_or("Missing parent")?)?;
        self.journal["entries"].as_array_mut().unwrap().push(entry);
        match &token {
            Some(token) => {
                // The entry names what a stop on the way leaves, so it is on the disk before anything moves.
                self.save_durably()?;
                rename_copy(src, dest, token)
            }
            None => {
                self.save()?;
                rename(src, dest)
            }
        }
    }
    fn merge(&mut self, src: &Path, dest: &Path) -> Result<()> {
        if src == dest {
            return Ok(());
        }
        if !exists(dest) {
            return self.move_to(src, dest);
        }
        sidecar::plain_path(src)?;
        sidecar::plain_path(dest)?;
        if !src.is_dir() || !dest.is_dir() {
            return Err("History destination is not a folder".into());
        }
        guard(&[src.to_owned()])?;
        for e in files::entries(src) {
            let from = e.path();
            let mut to = dest.join(e.file_name());
            if exists(&to) {
                if e.file_type().is_ok_and(|t| t.is_dir()) && fs::symlink_metadata(&to).is_ok_and(|m| m.is_dir()) {
                    self.merge(&from, &to)?;
                    continue;
                }
                let stem = from.file_stem().unwrap_or_default().to_string_lossy();
                let suffix = src.file_name().unwrap_or_default().to_string_lossy();
                let ext = from.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
                to = dest.join(format!("{stem}.from-{suffix}{ext}"));
            }
            self.move_to(&from, &to)?;
        }
        self.log(json!({"kind":"rmdir","path":src}))?;
        fs::remove_dir(src).map_err(|e| e.to_string())
    }
    fn backup(&mut self, file: &Path) -> Result<PathBuf> {
        self.n += 1;
        let backup = data(self.env, "backup")?.join(self.journal["id"].as_str().unwrap()).join(format!(
            "{}-{}",
            self.n,
            file.file_name().unwrap_or_default().to_string_lossy()
        ));
        fs::create_dir_all(backup.parent().unwrap()).map_err(|e| e.to_string())?;
        copy_tree(file, &backup)?;
        Ok(backup)
    }
    fn rewrite(&mut self, file: &Path, pairs: &[(String, String)], field: &str) -> Result<()> {
        sidecar::plain_path(file)?;
        let meta = fs::metadata(file).map_err(|e| e.to_string())?;
        let source = fs::read_to_string(file).map_err(|e| e.to_string())?;
        let re = regex::Regex::new(&format!(r#"("{}"\s*:\s*)("(?:[^"\\]|\\.)*")"#, regex::escape(field)))
            .map_err(|e| e.to_string())?;
        let mut pairs = pairs.to_owned();
        pairs.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
        let output = re.replace_all(&source, |c: &regex::Captures<'_>| {
            let Ok(old) = serde_json::from_str::<String>(&c[2]) else {
                return c[0].to_owned();
            };
            let replacement = pairs.iter().find_map(|(from, to)| rewrite_prefix(&old, from, to));
            replacement
                .map(|new| format!("{}{}", &c[1], serde_json::to_string(&new).unwrap()))
                .unwrap_or_else(|| c[0].into())
        });
        if output == source {
            return Ok(());
        }
        let backup = self.backup(file)?;
        preserve(&meta, &backup)?;
        self.log(json!({"kind":"rewrite","path":file,"backup":backup}))?;
        files::replace(file, output.as_bytes())?;
        preserve(&meta, file)
    }
    fn keep(&mut self, file: &Path) -> Result<()> {
        sidecar::plain_path(file)?;
        let existed = exists(file);
        let backup = if existed { Some(self.backup(file)?) } else { None };
        self.log(json!({"kind":"file","path":file,"existed":existed,"backup":backup}))
    }
    fn sidecar_status(&mut self, dir: &Path, status: &str) -> Result<()> {
        self.keep(&dir.join(sidecar::SIDECAR))?;
        if let Some(file) = sidecar::exclude_file(dir) {
            let file = path(self.env, &file.to_string_lossy())?;
            self.keep(&file)?;
        }
        sidecar::set_meta(dir, "status", status)
    }
    fn remember_archive(&mut self, dest: &Path) -> Result<()> {
        let cfg = crate::config::load(self.env);
        let roots: Vec<_> = if let Some(roots) = cfg["roots"].as_array() {
            roots.iter().filter_map(Value::as_str).map(|raw| paths::expand(raw, &self.env.home)).collect()
        } else {
            Vec::new()
        };
        let archived = cfg["archiveDir"]
            .as_str()
            .filter(|raw| !raw.is_empty())
            .is_some_and(|raw| dest.starts_with(paths::expand(raw, &self.env.home)));
        if archived || roots.iter().any(|root| dest.starts_with(root)) {
            return Ok(());
        }
        let home = &self.env.home;
        let roots: Vec<_> = roots
            .iter()
            .map(|root| paths::tilde(root, home))
            .chain(std::iter::once(paths::tilde(dest, home)))
            .collect();
        self.config(|cfg| cfg["roots"] = json!(roots))
    }
    /// Changes the settings in config.json, keeping a copy first, so Undo puts them back unless they changed since.
    fn config(&mut self, change: impl FnOnce(&mut Value)) -> Result<()> {
        let mut cfg = crate::config::load(self.env);
        change(&mut cfg);
        let file = paths::config_file(self.env)?;
        let existed = exists(&file);
        let backup = if existed { Some(self.backup(&file)?) } else { None };
        self.log(json!({"kind":"file","scope":"config","path":file,"existed":existed,"backup":backup}))?;
        crate::config::save(self.env, &cfg)?;
        let after = fs::read(&file).map_err(|e| e.to_string())?;
        self.journal["entries"].as_array_mut().unwrap().last_mut().unwrap()["afterHash"] =
            json!(format!("{:x}", Sha256::digest(after)));
        self.save()
    }
    /// Deletes dependencies or build output for good. They are rebuilt by the next install or build, and
    /// moving them to the Trash would free nothing while the Trash is on the same disk.
    fn clear(&mut self, path: &Path) -> Result<()> {
        sidecar::plain_path(path)?;
        let Ok(meta) = fs::symlink_metadata(path) else { return Ok(()) };
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !meta.is_dir() || !files::HEAVY.contains(&name) {
            return Err(format!("{} is not build output", paths::tilde(path, &self.env.home)));
        }
        guard(&[path.to_owned()])?;
        let bytes = files::size(path);
        self.log(json!({"kind":"cleared","path":path,"bytes":bytes}))?;
        remove(path)
    }
    fn trash(&mut self, path: &Path) -> Result<()> {
        sidecar::plain_path(path)?;
        if !exists(path) {
            return Ok(());
        }
        guard(&[path.to_owned()])?;
        self.log(json!({"kind":"trash","path":path}))?;
        platform::trash(path)
    }
}
fn transact(env: &Env, title: &str, say: Value, work: impl FnOnce(&mut Tx<'_>) -> Result<()>) -> Result<Value> {
    with_lock(env, || transact_unlocked(env, title, say, work))
}
/// [`transact`] for a caller that holds the change lock.
fn transact_unlocked(
    env: &Env,
    title: &str,
    say: Value,
    work: impl FnOnce(&mut Tx<'_>) -> Result<()>,
) -> Result<Value> {
    let mut tx = Tx::new(env, title, say)?;
    match work(&mut tx).and_then(|_| {
        tx.journal["state"] = json!("applied");
        tx.save()
    }) {
        Ok(()) => {
            tx.journal["canUndo"] = json!(can_undo(&tx.journal));
            if let Some(detail) = recovery(&tx.journal) {
                tx.journal["recovery"] = json!(detail);
            }
            Ok(tx.journal)
        }
        Err(error) => {
            tx.journal["error"] = json!(error);
            match undo_entries(env, tx.journal["entries"].as_array().unwrap()) {
                Ok(()) => {
                    if recovery(&tx.journal).is_some() {
                        tx.journal["state"] = json!("failed");
                        tx.journal["error"] = json!(format!(
                            "{error} · Reversible changes were rolled back. Check {} for any files already moved there.",
                            platform::BIN.bare
                        ));
                    } else {
                        tx.journal["state"] = json!("undone");
                    }
                }
                Err(rollback) => {
                    tx.journal["state"] = json!("failed");
                    tx.journal["error"] = json!(format!("{error} · rollback failed: {rollback}"));
                }
            }
            let _ = tx.save();
            Err(error)
        }
    }
}
fn validate_entries(env: &Env, entries: &[Value]) -> Result<()> {
    for e in entries {
        for key in ["from", "to", "path", "backup"] {
            if e[key].is_string() {
                journal_path(env, e, key)?;
            }
        }
        let required: &[&str] = match e["kind"].as_str() {
            Some("move") => &["from", "to"],
            Some("rewrite") => &["path", "backup"],
            Some("file") if e["existed"].as_bool() == Some(true) => &["path", "backup"],
            Some("file") if e["existed"].as_bool() == Some(false) => &["path"],
            Some("mkdir" | "rmdir" | "trash" | "cleared") => &["path"],
            _ => return Err("Unknown or incomplete journal entry".into()),
        };
        for key in required {
            journal_path(env, e, key)?;
        }
    }
    Ok(())
}
fn undo_entries(env: &Env, entries: &[Value]) -> Result<()> {
    validate_entries(env, entries)?;
    // A file changed after the change, by hand, by an agent or by Laci, or gone with a folder that moved, keeps what
    // it has now: putting back the older bytes would lose that, or bring back the folder.
    for entry in entries {
        if let Some(expected) = entry["afterHash"].as_str() {
            let file = journal_path(env, entry, "path")?;
            if !fs::read(&file).is_ok_and(|bytes| format!("{:x}", Sha256::digest(bytes)) == expected) {
                return Err(if entry["scope"] == "config" {
                    "Settings changed after this. Restore those settings before undoing it.".into()
                } else {
                    format!(
                        "{} changed after this, or its folder moved, so Undo would lose that. Edit it by hand.",
                        paths::tilde(&file, &env.home)
                    )
                });
            }
        }
    }
    // Refuse collisions before changing any content during undo.
    for e in entries.iter().filter(|e| e["kind"] == "move") {
        let from = journal_path(env, e, "from")?;
        let to = journal_path(env, e, "to")?;
        if exists(&from) && exists(&to) {
            return Err(format!("{} already exists; undo would overwrite it", from.display()));
        }
    }
    for e in entries.iter().rev() {
        match e["kind"].as_str().unwrap_or("") {
            "move" => {
                let from = journal_path(env, e, "from")?;
                let to = journal_path(env, e, "to")?;
                if exists(&to) {
                    if exists(&from) {
                        return Err(format!("{} already exists; undo would overwrite it", from.display()));
                    }
                    fs::create_dir_all(from.parent().ok_or("Missing parent")?).map_err(|e| e.to_string())?;
                    match e["token"].as_str() {
                        Some(token) => rename_copy(&to, &from, token)?,
                        None => rename(&to, &from)?,
                    }
                }
            }
            "rewrite" => {
                let backup = journal_path(env, e, "backup")?;
                let dest = journal_path(env, e, "path")?;
                if exists(&backup) {
                    restore(&backup, &dest)?;
                }
            }
            "file" => {
                let dest = journal_path(env, e, "path")?;
                if e["existed"].as_bool() == Some(true) {
                    restore(&journal_path(env, e, "backup")?, &dest)?;
                } else if exists(&dest) {
                    if !dest.is_file() {
                        return Err("Refusing to remove a folder in file undo".into());
                    }
                    fs::remove_file(dest).map_err(|e| e.to_string())?;
                }
            }
            "mkdir" => {
                let dest = journal_path(env, e, "path")?;
                let _ = fs::remove_dir(dest);
            }
            "rmdir" => {
                fs::create_dir_all(journal_path(env, e, "path")?).map_err(|e| e.to_string())?;
            }
            "trash" => {}   // The system trash owns recovery, as in v1.
            "cleared" => {} // Build output comes back with the next install or build.
            _ => return Err("Unknown journal entry".into()),
        }
    }
    Ok(())
}
fn restore(src: &Path, dest: &Path) -> Result<()> {
    sidecar::plain_path(src)?;
    sidecar::plain_path(dest)?;
    let meta = fs::metadata(src).map_err(|e| e.to_string())?;
    let bytes = fs::read(src).map_err(|e| e.to_string())?;
    files::replace(dest, &bytes)?;
    preserve(&meta, dest)
}
pub(crate) fn read_journal(path: &Path) -> Result<Value> {
    sidecar::plain_path(path)?;
    let file = File::open(path).map_err(|e| e.to_string())?;
    serde_json::from_reader(std::io::BufReader::new(file)).map_err(|e| e.to_string())
}
pub fn can_undo(journal: &Value) -> bool {
    journal["copiesRemoved"] != true
        && journal["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|e| matches!(e["kind"].as_str(), Some("move" | "rewrite" | "file" | "rmdir")))
}

pub fn recovery(journal: &Value) -> Option<String> {
    let trashed = journal["entries"].as_array().into_iter().flatten().any(|e| e["kind"] == "trash");
    let cleared = journal["entries"].as_array().into_iter().flatten().any(|e| e["kind"] == "cleared");
    if cleared && !trashed {
        return Some(if can_undo(journal) {
            "Undo restores moves and edits; deleted build output comes back with the next install or build.".into()
        } else {
            "Deleted build output comes back with the next install or build.".into()
        });
    }
    trashed.then(|| {
        if can_undo(journal) {
            format!(
                "Laci Undo restores moves and edits only. Restore trashed files separately through {}.",
                platform::BIN.bare
            )
        } else {
            format!("Restore these files through {}; Laci Undo is unavailable.", platform::BIN.bare)
        }
    })
}

pub fn journals(env: &Env, limit: usize) -> Vec<Value> {
    let Ok(dir) = data(env, "journal") else {
        return vec![];
    };
    files::entries(&dir)
        .into_iter()
        .rev()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .take(limit)
        .filter_map(|e| read_journal(&e.path()).ok())
        .collect()
}
pub fn undo(env: &Env, id: &str) -> Result<Value> {
    with_lock(env, || undo_unlocked(env, id, &mut None))
}
/// [`undo`], which puts in `settled` the journal of a move of the copy of AI chats that stopped part-way and that it
/// finished first ([`settle_copy`]), also when the Undo itself is then refused: the Log hasn't told that move yet.
pub fn undo_settling(env: &Env, id: &str, settled: &mut Option<Value>) -> Result<Value> {
    with_lock(env, || undo_unlocked(env, id, settled))
}
/// [`undo_settling`] under the change lock the caller holds.
pub(crate) fn undo_unlocked(env: &Env, id: &str, settled: &mut Option<Value>) -> Result<Value> {
    if !valid_id(id) {
        return Err("Invalid journal id".into());
    }
    let file = data(env, "journal")?.join(format!("{id}.json"));
    let mut journal = read_journal(&file)?;
    if journal["copyMove"].is_object() {
        return undo_copy_move(env, id, file, settled);
    }
    if journal["state"] != "applied" {
        return Err(format!("This change is {}, nothing to undo", journal["state"].as_str().unwrap_or("invalid")));
    }
    if journal["copiesRemoved"] == true {
        return Err("The copies this undo needs were removed to free space".into());
    }
    if !can_undo(&journal) {
        return Err(format!("Restore these files through {}; there is no Laci Undo", platform::BIN.bare));
    }
    let entries = journal["entries"].as_array().ok_or("Invalid journal")?;
    validate_entries(env, entries)?;
    guard(
        &entries
            .iter()
            .filter(|e| e["kind"] == "move")
            .map(|e| journal_path(env, e, "to"))
            .collect::<Result<Vec<_>>>()?,
    )?;
    undo_entries(env, entries)?;
    journal["state"] = json!("undone");
    files::replace(&file, &serde_json::to_vec_pretty(&journal).map_err(|e| e.to_string())?)?;
    Ok(journal)
}
/// Undo of a move of the copy of AI chats, from the journal `file`: the setting goes back to the folder the copy came
/// from, on the disk before anything moves, and then all the copy holds goes back there, also what it gained since,
/// as the folder of an agent first backed up after the move. Only `backupDir` changes, so other settings changed since
/// don't stand in the way, and whatever can refuse the Undo is asked before anything changes. An Undo that stops
/// part-way is finished the way the setting points ([`settle_copy`]); one that fails puts the copy back whole where it
/// was, so backups go on and the Undo can be asked again. A move this finished first is put in `settled`.
fn undo_copy_move(env: &Env, id: &str, file: PathBuf, settled: &mut Option<Value>) -> Result<Value> {
    // A move of the copy that stopped part-way, this one, its Undo or another one, is finished first.
    let finishing = crate::backup::moving(env).is_some_and(|(journal, undo)| undo && journal["id"] == id);
    *settled = settle_copy_unlocked(env)?;
    let journal = read_journal(&file)?;
    if journal["state"] != "applied" {
        if finishing && journal["state"] == "undone" {
            return Ok(journal);
        }
        return Err(format!("This change is {}, nothing to undo", journal["state"].as_str().unwrap_or("invalid")));
    }
    validate_entries(env, journal["entries"].as_array().ok_or("Invalid journal")?)?;
    let (from, to, roots) = copy_halves(env, &journal)?;
    if !same_path(&configured_copy(env)?, &to) {
        return Err("The copy of AI chats moved again after this. Undo that move first.".into());
    }
    let going: Vec<PathBuf> = movable(&to).into_iter().map(|name| to.join(name)).collect();
    for there in &going {
        let back = from.join(there.file_name().unwrap_or_default());
        if exists(&back) {
            return Err(format!("{} already exists; undo would overwrite it", back.display()));
        }
    }
    guard(&going)?;
    crate::backup::begin_moving(env, id, true)?;
    let mut tx = Tx::resume(env, journal, file);
    let mut moved = Vec::new();
    let undone = point_copy(env, &from)
        .and_then(|()| crate::backup::mark(&from))
        .and_then(|()| shift(&mut tx, &to, &from, &roots, &mut moved));
    if let Err(error) = undone {
        return match point_copy(env, &to).and_then(|()| shift_back(&mut tx, &to, &from, &roots, &moved)) {
            Ok(()) => {
                tx.save()?;
                crate::backup::end_moving(env)?;
                Err(error)
            }
            Err(rollback) => {
                // The next backup finishes it, the way the setting points, once what stopped it is put right.
                let _ = tx.save();
                Err(format!("{error} · rollback failed: {rollback}"))
            }
        };
    }
    tx.journal["state"] = json!("undone");
    tx.save()?;
    crate::backup::end_moving(env)?;
    Ok(tx.journal)
}
fn pairs(value: &Value) -> Result<Vec<(String, String)>> {
    value
        .as_array()
        .ok_or("Missing path mapping")?
        .iter()
        .map(|p| Ok((p[0].as_str().ok_or("Invalid old path")?.into(), p[1].as_str().ok_or("Invalid new path")?.into())))
        .collect()
}
fn jsonl(dir: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|s| s == "jsonl"))
        .map(|e| e.into_path())
        .collect()
}
fn roots(mut paths: Vec<String>) -> Vec<String> {
    paths.sort_by_key(String::len);
    let mut out: Vec<String> = vec![];
    for p in paths {
        if !out.iter().any(|r| Path::new(&p).starts_with(r)) {
            out.push(p);
        }
    }
    out
}
pub fn move_project(env: &Env, snap: &Value, id: &str, dest: &str, opts: &Value) -> Result<Value> {
    let node = &snap["nodes"][id];
    if !node.is_object() {
        return Err("Unknown project. Rescan and try again.".into());
    }
    let src = value_path(env, &node["path"])?;
    let dest = path(env, dest)?;
    if same_path(&src, &env.home) || same_path(&dest, &env.home) {
        return Err("Can't move the home folder".into());
    }
    if [&env.config_dir, &env.data_dir, &env.cache_dir].iter().any(|owned| {
        let owned = platform::path::canonical(owned).unwrap_or_else(|_| paths::normalize(owned));
        may_contain(&src, &owned) || may_contain(&owned, &dest)
    }) {
        return Err("Can't move Laci's settings, history, cache or recovery data".into());
    }
    if let Some(copy) = crate::backup::chosen(env, &crate::config::load(env)) {
        let copy = platform::path::canonical(&copy).unwrap_or_else(|_| paths::normalize(&copy));
        if may_contain(&src, &copy) {
            return Err(
                "This folder holds Laci's copy of AI chats. Move the copy somewhere else in Settings first.".into()
            );
        }
        if may_contain(&copy, &dest) {
            return Err("That place is inside Laci's copy of AI chats. Choose another one.".into());
        }
    }
    if contains(&src, &dest) {
        return Err("Can't move a folder into itself".into());
    }
    let name = node["name"].as_str().unwrap_or("project");
    let title = opts["title"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Move {name} → {}", paths::tilde(&dest, &env.home)));
    let say = if opts["say"].is_object() { opts["say"].clone() } else { json!({"form":"moved","name":name}) };
    transact(env, &title, say, |tx| {
        guard(std::slice::from_ref(&src))?;
        if opts["status"] == "archived" {
            crate::scan::check_archive_destination(env, &dest)?;
        }
        // Which history belongs to the folder is asked while it is still there.
        let claude: Vec<(&Value, &Path, PathBuf)> = snap["claude"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(_, c)| {
                let old = Path::new(c["path"].as_str()?);
                Some((c, old, relocate(&src, &dest, old)?))
            })
            .collect();
        // So is whether a tool's log file is kept inside the folder.
        let items: Vec<(&Value, String, Option<PathBuf>)> = snap["items"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, item)| item)
            .filter(|item| item["cleanupCapability"] != "unsupported")
            .filter_map(|item| {
                let newcwd = platform::path::moved_text(&src, &dest, item["cwd"].as_str()?)?;
                let inside = item["file"].as_str().and_then(|file| below(&src, &paths::expand(file.trim(), &env.home)));
                Some((item, newcwd, inside))
            })
            .collect();
        tx.move_to(&src, &dest)?;
        for (c, old, now) in claude {
            let from = value_path(env, &c["dir"])?;
            let target = from.parent().ok_or("Invalid Claude store")?.join(paths::enc(&now.to_string_lossy()));
            tx.merge(&from, &target)?;
            let gone = c["gone"].as_array().cloned().unwrap_or_default();
            let stale = roots(
                c["sessions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| s["cwd"].as_str())
                    .filter(|s| gone.iter().any(|g| g.as_str() == Some(*s)) && !may_contain(old, Path::new(s)))
                    .map(str::to_owned)
                    .collect(),
            );
            let mut pairs = vec![(src.to_string_lossy().into_owned(), dest.to_string_lossy().into_owned())];
            pairs.extend(stale.into_iter().map(|s| (s, now.to_string_lossy().into_owned())));
            for f in jsonl(&target) {
                tx.rewrite(&f, &pairs, "cwd")?;
            }
        }
        let connectors = snap["connectors"].as_array().cloned().unwrap_or_default();
        let mut moved = std::collections::HashSet::new();
        for (item, newcwd, inside) in items {
            let Some(c) = connectors.iter().find(|c| c["id"] == item["connector"]) else {
                continue;
            };
            let link = &c["link"];
            if link["kind"] == "cwd" {
                let mut file = value_path(env, &item["file"])?;
                if let Some(rest) = inside {
                    file = dest.join(rest);
                }
                tx.rewrite(
                    &file,
                    &[(src.to_string_lossy().into_owned(), dest.to_string_lossy().into_owned())],
                    link["field"].as_str().unwrap_or("cwd"),
                )?;
            } else if link["kind"] == "named" {
                let from = value_path(env, &item["file"])?;
                if !moved.insert(from.clone()) {
                    continue;
                }
                // The tool names the folder after the text of its working folder, so that text is moved as written.
                let target = value_path(env, &link["dir"])?.join(crate::agents::store_name(link, &newcwd));
                tx.merge(&from, &target)?;
            }
            // Inside history travels with the folder. Mention documents retain their original wording.
        }
        if let Some(status) = opts["status"].as_str().filter(|s| !s.is_empty()) {
            tx.sidecar_status(&dest, status)?;
            if status == "archived" {
                tx.remember_archive(&dest)?;
            }
        }
        if opts["trashHeavy"].as_bool() == Some(true) {
            for part in node["size"]["parts"].as_array().into_iter().flatten() {
                let raw = part["path"].as_str().ok_or("Invalid heavy folder")?;
                if !stays_below(Path::new(raw)) {
                    return Err("Invalid heavy folder".into());
                }
                tx.clear(&path(env, &dest.join(raw).to_string_lossy())?)?;
            }
        }
        Ok(())
    })
}
pub fn archive_project(env: &Env, snap: &Value, id: &str, trash_heavy: bool) -> Result<Value> {
    archive_project_to(env, snap, id, None, trash_heavy)
}

pub fn archive_project_to(
    env: &Env,
    snap: &Value,
    id: &str,
    destination: Option<&str>,
    trash_heavy: bool,
) -> Result<Value> {
    let plan = crate::scan::archive_plan(env, snap, id, destination)?;
    let name = snap["nodes"][id]["name"].as_str().unwrap_or("project");
    move_project(
        env,
        snap,
        id,
        plan["dest"].as_str().ok_or("Missing archive destination")?,
        &json!({"status":"archived","trashHeavy":trash_heavy,"title":format!("Archive {name}"),
            "say":{"form":"archived","name":name}}),
    )
}
pub fn apply_proposal(env: &Env, snap: &Value, proposal: &Value, recovery: &str) -> Result<Value> {
    if !["quarantine", "trash"].contains(&recovery) {
        return Err("Unknown history recovery method".into());
    }
    apply_action_checked(
        env,
        snap,
        proposal["title"].as_str().unwrap_or("Clean up history"),
        proposal["say"].clone(),
        &proposal["action"],
        Some((proposal, recovery)),
    )
}

pub fn apply_action(env: &Env, snap: &Value, title: &str, a: &Value) -> Result<Value> {
    apply_action_checked(env, snap, title, Value::Null, a, None)
}

/// `apply_action` with the parts the Log tells the change by (Tx::new).
pub fn apply_action_saying(env: &Env, snap: &Value, title: &str, say: Value, a: &Value) -> Result<Value> {
    apply_action_checked(env, snap, title, say, a, None)
}

fn apply_action_checked(
    env: &Env,
    snap: &Value,
    title: &str,
    say: Value,
    a: &Value,
    reviewed: Option<(&Value, &str)>,
) -> Result<Value> {
    if a["type"] == "archive" {
        return archive_project(env, snap, a["nodeId"].as_str().ok_or("Missing project")?, false);
    }
    transact(env, title, say, |tx| {
        let mut checked = a.clone();
        if let Some((proposal, recovery)) = reviewed.filter(|(p, _)| p["category"] == "orphan") {
            let fresh = crate::scan::scan(env)?;
            let current = fresh["proposals"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|p| p["id"] == proposal["id"])
                .ok_or("This history no longer matches the reviewed proposal. Rescan first.")?;
            crate::orphan::revalidate(env, proposal, current)?;
            checked = current["action"].clone();
            if recovery == "trash" {
                checked = json!({"type":"trash","paths":checked["moves"].as_array().ok_or("Missing checked paths")?.iter().map(|m|m["from"].clone()).collect::<Vec<_>>()});
            }
        }
        let a = &checked;
        match a["type"].as_str().unwrap_or("") {
            "reconnect-claude" => {
                let from = value_path(env, &a["dir"])?;
                let target = value_path(env, &a["target"])?;
                guard(std::slice::from_ref(&from))?;
                tx.merge(&from, &target)?;
                let mapping = pairs(&a["pairs"])?;
                for f in jsonl(&target) {
                    tx.rewrite(&f, &mapping, "cwd")?;
                }
            }
            "rewrite-claude" => {
                for item in a["items"].as_array().ok_or("Missing history")? {
                    let dir = value_path(env, &item["dir"])?;
                    let mapping = pairs(&item["pairs"])?;
                    for f in jsonl(&dir) {
                        tx.rewrite(&f, &mapping, "cwd")?;
                    }
                }
            }
            "rewrite-logs" => {
                let mapping = pairs(&a["pairs"])?;
                for f in a["files"].as_array().ok_or("Missing log files")? {
                    tx.rewrite(&value_path(env, f)?, &mapping, a["field"].as_str().unwrap_or("cwd"))?;
                }
            }
            "quarantine" => {
                let quarantine = data(env, "orphans")?;
                for m in a["moves"].as_array().ok_or("Missing moves")? {
                    let rel = m["to"].as_str().ok_or("Missing destination")?;
                    if !stays_below(Path::new(rel)) {
                        return Err("Bad quarantine path".into());
                    }
                    let from = value_path(env, &m["from"])?;
                    guard(std::slice::from_ref(&from))?;
                    tx.move_to(&from, &quarantine.join(rel))?;
                }
            }
            "trash" => {
                for p in a["paths"].as_array().ok_or("Missing paths")? {
                    tx.trash(&value_path(env, p)?)?;
                }
            }
            "clear" => {
                for p in a["paths"].as_array().ok_or("Missing paths")? {
                    tx.clear(&value_path(env, p)?)?;
                }
            }
            _ => return Err("Unknown action".into()),
        }
        Ok(())
    })
}
/// Copies agent histories into the copy of AI chats (`backup::dir`), each file packed with zstd, and says what the
/// copy holds. Only files that grew since their last copy are copied again.
/// A move of the copy that stopped part-way is finished first: the result names its journal as `settled`. What the
/// plain files from before 3.1 that it packed first took before and take now is its `packing`.
pub fn backup_history(env: &Env, snap: &Value) -> Result<Value> {
    with_lock(env, || {
        let settled = settle_copy_unlocked(env)?;
        let dest = crate::backup::ready(env)?;
        // What runs that stopped part-way left goes first, and plain files from before 3.1 are packed.
        crate::backup::remove_leftovers(env, &dest);
        let packing = crate::backup::convert(env, &dest);
        let mut copied = 0u64;
        let mut bytes = 0u64;
        for c in snap["connectors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["link"]["dir"].is_string() && c["link"]["kind"] != "mentions")
        {
            let src = value_path(env, &c["link"]["dir"])?;
            let connector = c["id"].as_str().ok_or("Missing connector")?;
            if connector.is_empty() || connector.contains(['/', '\\']) || connector == ".." {
                return Err("Invalid connector id".into());
            }
            let real = platform::path::canonical(&src).unwrap_or_else(|_| src.clone());
            if [&src, &real].iter().any(|src| may_contain(src, &dest)) {
                return Err("History backup cannot be inside its source".into());
            }
            if [&src, &real].iter().any(|src| may_contain(&dest, src)) {
                return Err(format!(
                    "The history of {} is inside the copy of AI chats. Choose another folder for the copy.",
                    c["name"].as_str().unwrap_or(connector)
                ));
            }
            for item in walkdir::WalkDir::new(&src)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                if !item.path().extension().is_some_and(|e| crate::backup::KINDS.iter().any(|ext| e == *ext)) {
                    continue;
                }
                let relative = item.path().strip_prefix(&src).map_err(|e| e.to_string())?;
                let target = crate::backup::packed(&dest.join(connector).join(relative));
                sidecar::plain_path(&target)?;
                let listed = fs::metadata(item.path()).map_err(|e| e.to_string())?;
                // The packed copy records how long the log was, and a tool only adds to a log it writes.
                if crate::backup::content_size(&target) == Some(listed.len()) {
                    continue;
                }
                fs::create_dir_all(target.parent().ok_or("Missing folder")?).map_err(|e| e.to_string())?;
                // What is packed is the file as it is opened. One that got shorter while it was read keeps its last
                // copy; the next run copies it again.
                let Some(metadata) = crate::backup::pack(item.path(), &target)? else {
                    continue;
                };
                preserve(&metadata, &target)?;
                copied += 1;
                bytes += metadata.len();
            }
        }
        // What the backup holds now, including sessions their tool has since deleted.
        let (sessions, kept, total) = crate::backup::count(&dest);
        // Every file is packed after a run, so `bytes` is what a move of the copy carries.
        let state =
            json!({"at":files::now(),"copied":copied,"sessions":sessions,"files":kept,"bytes":total,"packed":true});
        files::replace(&data(env, BACKUP_STATE)?, state.to_string().as_bytes())?;
        Ok(
            json!({"copied":copied,"bytes":bytes,"size":bytes,"dest":dest,"sessions":sessions,"files":kept,"total":total,
            "settled":settled,"packing":{"files":packing.files,"before":packing.before,"after":packing.after}}),
        )
    })
}
/// Puts a session the backup still holds back where its tool keeps it. `id` names a session of the
/// current scan, so both paths come from the engine and are checked again here.
pub fn restore_backup(env: &Env, snap: &Value, id: &str) -> Result<Value> {
    with_lock(env, || {
        let session = snap["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["backup"] == true && s["id"] == id)
            .ok_or("That session is no longer in the backup; refresh history")?;
        let connector = snap["connectors"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|c| c["id"] == session["connector"])
            .ok_or("Connect this agent before restoring its sessions")?;
        let connector_id = connector["id"].as_str().ok_or("Missing connector")?;
        let source = PathBuf::from(session["file"].as_str().ok_or("Missing file path")?);
        // Part of the copy can still be in the folder a move that stopped left it in.
        let halves = crate::backup::dirs(env);
        if halves.is_empty() {
            crate::backup::dir(env)?;
        }
        let kept = halves
            .into_iter()
            .map(|dir| dir.join(connector_id))
            .find(|kept| crate::backup::inside(kept, &source))
            .ok_or("That file is not part of the backup")?;
        let log = crate::backup::original(&source);
        let relative = log.strip_prefix(&kept).map_err(|_| "That file is not part of the backup".to_owned())?;
        let target = value_path(env, &connector["link"]["dir"])?.join(relative);
        if session["restoreTo"].as_str() != target.to_str() {
            return Err("That session no longer matches the backup; refresh history".into());
        }
        sidecar::plain_path(&target)?;
        if exists(&target) {
            return Err("That session is already back in place".into());
        }
        crate::backup::unpack(&source, &target)?;
        // The file keeps today's date on purpose: a tool that deletes old logs would remove it again at once.
        Ok(json!({"restored":target,"title":session["title"],"provider":session["provider"]}))
    })
}
/// Moves the sessions the user chose out of their tool's history and into Laci's quarantine, in one
/// journal, so Undo in the Log puts them back. `files` name sessions of the current scan; the rest is
/// checked again here: only whole Claude Code and Codex sessions, never one that is kept, still being
/// written, or only a copy in the backup.
pub fn delete_sessions(env: &Env, snap: &Value, files: &[String]) -> Result<Value> {
    if files.is_empty() {
        return Err("Choose at least one session".into());
    }
    let kept = crate::agents::kept(env);
    let mut plan = Vec::new();
    for file in files {
        let session = snap["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["file"].as_str() == Some(file.as_str()) && s["backup"] != true)
            .ok_or("A session is no longer in the list. Refresh history and try again.")?;
        let title = session["title"].as_str().unwrap_or("This session");
        let provider = session["provider"].as_str().unwrap_or("");
        if !matches!(provider, "claude" | "codex")
            || session["cleanupCapability"] == "unsupported"
            || session["sourceKind"] == "subagent"
        {
            return Err(format!("“{title}” can't be deleted from Laci"));
        }
        if kept.contains(&crate::agents::kept_key(session)) {
            return Err(format!("“{title}” is kept. Unkeep it first."));
        }
        let connector = snap["connectors"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|c| c["id"] == session["connector"])
            .ok_or("Connect this agent before deleting its sessions")?;
        let id =
            connector["id"].as_str().filter(|id| !id.is_empty() && !id.contains(['/', '.'])).ok_or("Unknown agent")?;
        let store = value_path(env, &connector["link"]["dir"])?;
        let source = value_path(env, &session["file"])?;
        let relative = source
            .strip_prefix(&store)
            .map_err(|_| format!("“{title}” is not in its agent's history folder"))?
            .to_owned();
        if relative.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err("Bad session path".into());
        }
        let meta = fs::symlink_metadata(&source).map_err(|_| format!("“{title}” is already gone"))?;
        if !meta.is_file() {
            return Err(format!("“{title}” is not a plain file"));
        }
        let recent = meta.modified().ok().and_then(|m| m.elapsed().ok()).is_none_or(|age| age.as_secs() < 120);
        if recent {
            return Err(format!("“{title}” is still being written. Close it first, or try again in two minutes."));
        }
        plan.push((id.to_owned(), provider == "claude", store, relative, title.to_owned()));
    }
    let (title, say) = match plan.as_slice() {
        [(.., one)] => (format!("Deleted the session “{one}”"), json!({"form":"deletedChat","title":one})),
        _ => (format!("Deleted {} sessions", plan.len()), json!({"form":"deletedChats","chats":plan.len()})),
    };
    transact(env, &title, say, |tx| {
        let id = tx.journal["id"].as_str().unwrap_or("removed").to_owned();
        let removed = data(env, "orphans")?.join("sessions").join(&id);
        // Asked under the lock, so a move of the copy can't come in between. A copy whose drive isn't connected
        // keeps its copies of them, and one never made has none. Part of it can still be where a move that stopped
        // left it.
        let copies: Vec<PathBuf> = crate::backup::dirs(env).into_iter().filter(|dir| dir.is_dir()).collect();
        let roots =
            Value::Array(copies.iter().map(|dir| crate::backup::journal_root(dir)).collect::<Result<Vec<_>>>()?);
        for (connector, claude, store, relative, _) in &plan {
            let source = store.join(relative);
            tx.move_to(&source, &removed.join(connector).join(relative))?;
            // Claude Code keeps a session's subagent logs and tool output in a folder named after it.
            let folder = source.with_extension("");
            if *claude && fs::symlink_metadata(&folder).is_ok_and(|m| m.is_dir()) {
                tx.move_to(&folder, &removed.join(connector).join(relative.with_extension("")))?;
            }
            // Otherwise the backup's copy would bring it straight back as "In backup only": packed, or still plain.
            for history in &copies {
                let kept = history.join(connector).join(relative);
                for file in [crate::backup::packed(&kept), kept] {
                    if fs::symlink_metadata(&file).is_ok_and(|m| m.is_file()) {
                        let name = file.strip_prefix(history).map_err(|e| e.to_string())?;
                        tx.move_copy(&file, &removed.join("backup").join(name), &roots)?;
                    }
                }
            }
        }
        Ok(())
    })
}
const BACKUP_STATE: &str = "backup.json";
/// When agent history was last backed up and what the backup holds, or nothing if it never ran. Where the copy is
/// comes from `backup::dir`.
pub fn backup_state(env: &Env) -> Option<Value> {
    let state: Value = serde_json::from_str(&files::text(&data(env, BACKUP_STATE).ok()?)?).ok()?;
    state["at"].as_str()?;
    Some(state)
}
/// Moves the copy of AI chats to the folder `raw` names (`""`: back to the default in Laci's data folder), in one
/// journal, so Undo in the Log moves it back and sets the setting back. Plain files from before 3.1 are packed first,
/// so less crosses disks. The folder it leaves stays, empty: Laci never removes a folder the user chose. A copy that
/// holds no chat moves nothing: the copy is kept in the new folder from then on, which may hold a copy Laci made
/// before. A copy Laci can't reach now, as on a drive that isn't connected, isn't left behind unless `fresh` says to
/// start a new copy in the new folder: the old one then stays where it is. `moved` says whether anything moved.
pub fn move_backup(env: &Env, raw: &str, fresh: bool) -> Result<Value> {
    // Where the copy is now, and so what moves, is the setting's to say, also for a new copy.
    crate::backup::settings(env)?;
    let chosen = crate::config::validate_backup_dir(env, &json!(raw))?;
    let dest = match &chosen {
        Some(dir) => dir.clone(),
        None => data(env, "history")?,
    };
    let shown = paths::tilde(&dest, &env.home);
    let own = chosen.is_none();
    with_lock(env, || {
        let settled = settle_copy_unlocked(env)?;
        let current = match crate::backup::dir(env) {
            Ok(dir) => Some(dir),
            Err(_) if fresh => None,
            Err(error) => return Err(format!("Connect the drive first, so Laci can move the copy. {error}")),
        };
        if current.as_ref().is_some_and(|now| same_path(now, &dest)) {
            return Err("The copy of AI chats is in that folder already".into());
        }
        // Only the default folder is ever made.
        if own {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        if !fs::symlink_metadata(&dest).is_ok_and(|m| m.is_dir()) {
            return Err(format!("{shown} isn't there"));
        }
        sidecar::plain_path(&dest)?;
        let source = current.filter(|now| !crate::backup::empty(now));
        if let Some(now) = &source
            && (may_contain(now, &dest) || may_contain(&dest, now))
        {
            return Err("Choose a folder outside the copy of AI chats that doesn't hold it either".into());
        }
        if !crate::backup::empty(&dest) && !(source.is_none() && crate::backup::marked(&dest)) {
            return Err(
                "That folder already holds files. Choose an empty folder, or one that holds a copy Laci made.".into()
            );
        }
        // The new folder is known as a copy before anything points to it.
        crate::backup::mark(&dest)?;
        let journal = match &source {
            Some(now) => move_copy_into(env, now, &dest, &shown, own)?,
            None => transact_unlocked(
                env,
                &format!("The copy of AI chats is kept in {shown} from now on"),
                json!({"form":"keptCopyIn","dir":shown,"own":own}),
                |tx| {
                    let identity = crate::backup::journal_root(&dest)?;
                    tx.config(|cfg| choose_copy(cfg, &copy_setting(env, &dest), &dest, &identity))
                },
            )?,
        };
        let moved = source.is_some();
        if !moved {
            // What the last backup said is of the copy it made, not of this folder: the next run says what this one
            // holds, and an automatic one runs at once.
            if let Err(e) = fs::remove_file(data(env, BACKUP_STATE)?)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                return Err(e.to_string());
            }
        }
        let bytes = if moved { files::size(&dest) } else { 0 };
        Ok(json!({"journal":journal,"dest":dest,"moved":moved,"bytes":bytes,"settled":settled}))
    })
}
/// The copy in `from`, which holds chats, moved into the empty copy folder `to`, in one journal: the setting points
/// to `to` first, on the disk before anything moves, and then each top-level entry moves. While it moves, a file names
/// the journal, so a move that stops part-way, as when Laci is closed, is finished the way the setting points before
/// the copy is used again ([`settle_copy`]). One that fails is put back the same way round.
fn move_copy_into(env: &Env, from: &Path, to: &Path, shown: &str, own: bool) -> Result<Value> {
    crate::backup::remove_leftovers(env, from);
    crate::backup::convert(env, from);
    let roots = json!([crate::backup::journal_root(from)?, crate::backup::journal_root(to)?]);
    let mut tx = Tx::new(
        env,
        &format!("Moved the copy of AI chats to {shown}"),
        json!({"form":"movedCopy","dir":shown,"own":own}),
    )?;
    tx.journal["copyMove"] = json!({"from":from,"to":to,"roots":roots});
    tx.save_durably()?;
    crate::backup::begin_moving(env, tx.journal["id"].as_str().unwrap_or_default(), false)?;
    let mut moved = Vec::new();
    if let Err(error) = point_copy(env, to).and_then(|()| shift(&mut tx, from, to, &roots, &mut moved)) {
        let back = point_copy(env, from).and_then(|()| shift_back(&mut tx, from, to, &roots, &moved));
        tx.journal["state"] = json!(if back.is_ok() { "undone" } else { "failed" });
        // A rollback that stopped says why, so what stands in its way can be put right.
        let told = match &back {
            Ok(()) => error,
            Err(rollback) => format!("{error} · rollback failed: {rollback}"),
        };
        tx.journal["error"] = json!(told);
        // One whose rollback failed is finished by the next backup, the way the setting points.
        if tx.save().is_ok() && back.is_ok() {
            crate::backup::end_moving(env)?;
        }
        return Err(told);
    }
    tx.journal["state"] = json!("applied");
    tx.save()?;
    crate::backup::end_moving(env)?;
    tx.journal["canUndo"] = json!(can_undo(&tx.journal));
    Ok(tx.journal)
}
/// How the setting names the copy folder `dir`: `""` for the default in Laci's data folder.
fn copy_setting(env: &Env, dir: &Path) -> String {
    if same_path(dir, &env.data_dir.join("history")) { String::new() } else { paths::tilde(dir, &env.home) }
}
/// The folder the setting names for the copy, unchecked. Refused while the settings can't be read
/// ([`crate::backup::settings`]): the copy moves only the way the user's setting points.
fn configured_copy(env: &Env) -> Result<PathBuf> {
    Ok(crate::backup::chosen(env, &crate::backup::settings(env)?).unwrap_or_else(|| env.data_dir.join("history")))
}
/// Points the setting in `cfg` to the copy folder `dest`, saved as `setting` (`""` for the default), with the identity
/// it has now.
fn choose_copy(cfg: &mut Value, setting: &str, dest: &Path, identity: &Value) {
    cfg["backupDir"] = json!(setting);
    if !setting.is_empty() {
        if !cfg["rootIdentities"].is_object() {
            cfg["rootIdentities"] = json!({});
        }
        // Chosen again, as when its drive came back as another one, it is known as it is now.
        cfg["rootIdentities"][dest.to_string_lossy().as_ref()] =
            json!({"device":identity["device"],"inode":identity["inode"]});
    }
}
/// Points the setting for the copy to the folder `dir`, on the disk before anything of the copy moves: where it points
/// is where a move that stopped part-way is finished. Only `backupDir` and the folder's identity change.
fn point_copy(env: &Env, dir: &Path) -> Result<()> {
    let identity = crate::backup::journal_root(dir)?;
    let mut cfg = crate::config::load(env);
    choose_copy(&mut cfg, &copy_setting(env, dir), dir, &identity);
    crate::config::save(env, &cfg)?;
    crate::backup::sync_dir(paths::config_file(env)?.parent().ok_or("Missing folder")?)
}
/// The top-level entries of the copy in `dir` that move with it: all but its marker, which each folder keeps, and what
/// a move to another drive set aside or copied into, which [`repair_copy_move`] puts right.
fn movable(dir: &Path) -> Vec<std::ffi::OsString> {
    files::entries(dir)
        .into_iter()
        .map(|entry| entry.file_name())
        .filter(|name| name != crate::backup::MARKER && !name.to_string_lossy().starts_with(crate::backup::MOVE))
        .collect()
}
/// Moves what the copy in `from` holds ([`movable`]) into `to`, journaled, and adds the name of each to `moved` as it
/// starts.
fn shift(tx: &mut Tx<'_>, from: &Path, to: &Path, roots: &Value, moved: &mut Vec<std::ffi::OsString>) -> Result<()> {
    for name in movable(from) {
        moved.push(name.clone());
        tx.move_copy(&from.join(&name), &to.join(&name), roots)?;
    }
    Ok(())
}
/// Moves what [`shift`] moved from `from` into `to` back, the last first. One that is in both folders was copied to
/// another drive whose file system can't rename without replacing, as NFS, sshfs or 9p, and its source couldn't be
/// deleted afterwards ([`across`]): only the user can tell which half is complete, so it stops there and names both.
fn shift_back(tx: &mut Tx<'_>, from: &Path, to: &Path, roots: &Value, moved: &[std::ffi::OsString]) -> Result<()> {
    for name in moved.iter().rev() {
        let (there, back) = (to.join(name), from.join(name));
        match (exists(&there), exists(&back)) {
            (true, false) => tx.move_copy(&there, &back, roots)?,
            (true, true) => {
                return Err(format!(
                    "{} is both in {} and in {}, so Laci stopped: keep the one that is complete, remove the other, \
                     and back up again.",
                    name.to_string_lossy(),
                    paths::tilde(to, &tx.env.home),
                    paths::tilde(from, &tx.env.home)
                ));
            }
            _ => {}
        }
    }
    Ok(())
}
/// The folders the move of the copy in `journal` moved it from and to, each checked to be there as the journal
/// recorded it, and that record.
fn copy_halves(env: &Env, journal: &Value) -> Result<(PathBuf, PathBuf, Value)> {
    let halves = &journal["copyMove"];
    let roots = halves["roots"].clone();
    let half = |key: &str| -> Result<PathBuf> {
        let raw = halves[key].as_str().ok_or("Invalid journal")?;
        crate::backup::journal_path(env, raw, &roots)?.ok_or_else(|| "Invalid journal".to_owned())
    };
    Ok((half("from")?, half("to")?, roots))
}

/// Finishes a move of the copy of AI chats, or an Undo of one, that stopped part-way, as when Laci was closed or the
/// power went, the way the setting points: the setting changes first and is on the disk before anything moves, so all
/// of the copy goes into the folder it names. What a move to another drive left on the way is put right first. The
/// copy is then in one folder again, and the journal says whether the move happened. Gives the journal of a move it
/// finished, which the Log hasn't told yet; one put back, or an Undo, is not told.
pub fn settle_copy(env: &Env) -> Result<Option<Value>> {
    with_lock(env, || settle_copy_unlocked(env))
}
fn settle_copy_unlocked(env: &Env) -> Result<Option<Value>> {
    let Some((journal, _)) = crate::backup::moving(env) else {
        crate::backup::end_moving(env)?;
        return Ok(None);
    };
    let id = journal["id"].as_str().filter(|id| valid_id(id)).ok_or("Invalid journal id")?.to_owned();
    let state = journal["state"].as_str().unwrap_or_default().to_owned();
    if !journal["copyMove"].is_object() || !matches!(state.as_str(), "running" | "failed" | "applied") {
        crate::backup::end_moving(env)?;
        return Ok(None);
    }
    let (from, to, roots) = copy_halves(env, &journal)?;
    let target = configured_copy(env)?;
    // A setting edited by hand meanwhile to name neither folder: the move goes on as it started.
    let forward = !same_path(&target, &from);
    if forward && !same_path(&target, &to) {
        point_copy(env, &to)?;
    }
    let entries = journal["entries"].as_array().cloned().unwrap_or_default();
    let mut tx = Tx::resume(env, journal, data(env, "journal")?.join(format!("{id}.json")));
    // Each entry names the way its file went, forward, back or forward again.
    for e in entries.iter().filter(|e| e["kind"] == "move") {
        if let Some(token) = e["token"].as_str() {
            repair_copy_move(&journal_path(env, e, "from")?, &journal_path(env, e, "to")?, token)?;
        }
    }
    let (src, dest) = if forward { (&from, &to) } else { (&to, &from) };
    crate::backup::mark(dest)?;
    shift(&mut tx, src, dest, &roots, &mut Vec::new())?;
    tx.journal["state"] = json!(if forward { "applied" } else { "undone" });
    if let Some(fields) = tx.journal.as_object_mut() {
        fields.remove("error");
    }
    tx.save()?;
    crate::backup::end_moving(env)?;
    tx.journal["canUndo"] = json!(can_undo(&tx.journal));
    Ok((forward && state != "applied").then_some(tx.journal))
}

/// This test binary stands in for Git and the other programs: started again under their names,
/// it runs only [`tests::stand_in`].
#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};

    /// What [`stand_in`] does in a program these tests start: `stay <seconds>` works in its folder that long, and
    /// `pass <file>` writes the file and ends a moment later.
    const ROLE: &str = "LACI_OPS_TEST_ROLE";
    /// The arguments that make this test binary run [`stand_in`] alone.
    const STAND_IN: [&str; 4] = ["--exact", "ops::tests::stand_in", "--test-threads=1", "--quiet"];

    /// Not a test: what this binary does when a test starts it as another program. As a test it does nothing.
    #[test]
    fn stand_in() {
        let Ok(role) = std::env::var(ROLE) else { return };
        match role.split_once(' ') {
            Some(("stay", seconds)) => thread::sleep(Duration::from_secs_f64(seconds.parse().unwrap())),
            Some(("pass", file)) => {
                fs::write(file, "").unwrap();
                thread::sleep(Duration::from_millis(20));
            }
            _ => panic!("No part called {role}"),
        }
    }

    /// A project folder, and this test binary as each program in `names`: links, as a program written here could fail
    /// to start with "Text file busy" while another test starts a process. Each runs once first.
    fn fixture<const N: usize>(names: [&str; N]) -> (tempfile::TempDir, PathBuf, [PathBuf; N]) {
        let temp = tempfile::tempdir().unwrap();
        // Linux names working folders with links resolved.
        let root = temp.path().canonicalize().unwrap();
        let (project, bin) = (root.join("project"), root.join("bin"));
        fs::create_dir(&project).unwrap();
        fs::create_dir(&bin).unwrap();
        let programs = names.map(|name| {
            let (this, program) = (std::env::current_exe().unwrap(), bin.join(name));
            std::os::unix::fs::symlink(this, &program).unwrap();
            let ran = Command::new(&program).args(STAND_IN).env(ROLE, "stay 0").stdout(Stdio::null()).status();
            assert!(ran.unwrap().success(), "{name} runs");
            program
        });
        (temp, project, programs)
    }

    /// The name the OS lists `program` under, such as `git`.
    fn name(program: &Path) -> String {
        program.file_name().unwrap().to_string_lossy().into_owned()
    }

    /// Runs `program` in `dir` as Laci runs Git, as one of its helpers.
    fn helper(program: &Path, role: &str, dir: &Path, timeout: Duration) -> Result<String> {
        process::run_env(program.to_str().unwrap(), &STAND_IN, Some(dir), timeout, &[(ROLE, Some(role))])
    }

    /// Every process working in `dir` but this one, Laci's own helpers included, with its name.
    fn inside(dir: &Path) -> Vec<(u32, String)> {
        platform::processes_in(&[dir.to_owned()]).unwrap().into_iter().map(|h| (h.pid, h.name)).collect()
    }

    /// Waits up to twenty seconds for `found` to give something.
    fn soon<T>(what: &str, mut found: impl FnMut() -> Option<T>) -> T {
        let since = Instant::now();
        loop {
            if let Some(value) = found() {
                return value;
            }
            assert!(since.elapsed() < Duration::from_secs(20), "{what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// The pid of the process in `dir` that `pick` accepts, once it is listed under `name`. Right after a spawn,
    /// Linux can still list the child under its parent's name for a moment.
    fn started(dir: &Path, name: &str, pick: impl Fn(u32) -> bool) -> u32 {
        soon(&format!("{name} starts in {}", dir.display()), || {
            inside(dir).into_iter().find(|(pid, found)| found == name && pick(*pid)).map(|(pid, _)| pid)
        })
    }

    /// Started without [`process::run_env`], like Git from another Laci or a terminal. Killed and reaped when the
    /// test ends, also when it fails.
    struct Outside(Child);
    impl Outside {
        fn start(program: &Path, role: &str, cwd: &Path) -> Self {
            let mut command = Command::new(program);
            command.args(STAND_IN).env(ROLE, role).current_dir(cwd).stdout(Stdio::null());
            Self(command.spawn().unwrap())
        }
    }
    impl Drop for Outside {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn git_that_laci_runs_itself_never_makes_a_folder_busy() {
        let (_temp, project, [git]) = fixture(["git"]);
        let folder = std::slice::from_ref(&project);
        let scan = || helper(&git, "stay 2", &project, Duration::from_secs(30));
        thread::scope(|scope| {
            let scan = scope.spawn(scan);
            let pid = started(&project, &name(&git), process::is_own_child);
            assert!(busy_in(folder).unwrap().iter().all(|b| b["pid"] != pid));
            let checked = Instant::now();
            guard(folder).unwrap();
            assert!(checked.elapsed() < Duration::from_secs(1), "nothing waits for Laci's own Git");
            assert!(process::is_own_child(pid), "it was still running");
            scan.join().unwrap().unwrap();
            assert!(!process::is_own_child(pid), "a finished helper is forgotten");
        });
    }

    #[test]
    fn a_helper_is_forgotten_when_it_runs_out_of_time() {
        let (_temp, project, [git]) = fixture(["git"]);
        let slow = || helper(&git, "stay 60", &project, Duration::from_secs(3));
        thread::scope(|scope| {
            let slow = scope.spawn(slow);
            let pid = started(&project, &name(&git), process::is_own_child);
            assert!(slow.join().unwrap().unwrap_err().contains("took too long"));
            assert!(!process::is_own_child(pid));
            assert!(inside(&project).is_empty(), "killed and reaped");
        });
    }

    #[test]
    fn a_change_waits_a_moment_for_git_that_another_program_runs() {
        let (_temp, project, [git]) = fixture(["git"]);
        let folder = std::slice::from_ref(&project);
        // Another Laci's scan: Git in the folder that is not a helper of this process.
        let mut other = Outside::start(&git, "stay 0.5", &project);
        let pid = other.0.id();
        started(&project, &name(&git), |found| found == pid);
        assert!(busy_in(folder).unwrap().iter().any(|b| b["pid"] == pid && b["name"] == name(&git)));
        guard(folder).unwrap();
        assert!(other.0.try_wait().unwrap().is_some(), "the change went ahead once that Git was done");
    }

    #[test]
    fn a_process_passing_through_does_not_make_a_folder_busy() {
        let (temp, project, [shell]) = fixture(["shell"]);
        let passed = temp.path().join("passed");
        let _brief = Outside::start(&shell, &format!("pass {}", passed.display()), &project);
        soon("the program runs", || passed.exists().then_some(()));
        let checked = Instant::now();
        guard(std::slice::from_ref(&project)).unwrap();
        assert!(checked.elapsed() < Duration::from_secs(1), "{:?}", checked.elapsed());
    }

    #[test]
    fn anything_besides_git_in_the_folder_makes_it_busy_at_once() {
        let (_temp, project, [git, shell]) = fixture(["git", "shell"]);
        // Stands for a terminal Laci opened there: its own child, but not a helper. Git beside it changes nothing.
        let terminal = Outside::start(&shell, "stay 60", &project);
        let other = Outside::start(&git, "stay 60", &project);
        started(&project, &name(&shell), |pid| pid == terminal.0.id());
        started(&project, &name(&git), |pid| pid == other.0.id());
        let checked = Instant::now();
        let error = guard(std::slice::from_ref(&project)).unwrap_err();
        assert!(checked.elapsed() < GIT_WAIT / 3, "no wait while something besides Git is there");
        assert!(error.starts_with("In use by ") && error.ends_with(". Close it first."), "{error}");
        assert!(error.contains(&format!("{} (pid {})", name(&shell), terminal.0.id())), "{error}");
    }

    /// A home in a fresh temporary folder, spelled as the file system spells it, with the folders a move needs.
    fn home() -> (tempfile::TempDir, Env, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let env = Env::for_home(platform::path::canonical(temp.path()).unwrap().join("home"));
        let (src, dest) = (env.home.join("project").join("demo"), env.home.join("archive").join("demo"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(src.join("README.md"), "# demo\n").unwrap();
        (temp, env, src, dest)
    }

    /// A move to another volume as [`Tx::move_to`] journals it, made on the volume the test runs on.
    fn move_across(env: &Env, src: &Path, dest: &Path) -> Result<Value> {
        move_across_by(env, src, dest, platform::rename_noreplace)
    }

    /// [`move_across`], with `beside` setting the source aside.
    fn move_across_by(
        env: &Env,
        src: &Path,
        dest: &Path,
        beside: impl Fn(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<Value> {
        transact(env, "Move", Value::Null, |tx| {
            tx.log(json!({"kind":"move","from":src,"to":dest}))?;
            rename_across_with(src, dest, beside)
        })
    }

    /// The names in `dir`, sorted.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn make_read_only(path: &Path) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions).unwrap();
    }

    /// Git makes its objects read-only. A move to another volume takes them along as they are, deletes them where they
    /// were, and leaves nothing set aside or staged on either side; Undo brings the project back.
    #[test]
    fn a_move_across_volumes_takes_read_only_files_along_and_leaves_nothing_behind() {
        let (_temp, env, src, dest) = home();
        let objects = src.join(".git").join("objects").join("ab");
        fs::create_dir_all(&objects).unwrap();
        fs::write(objects.join("cdef"), "object").unwrap();
        make_read_only(&objects.join("cdef"));
        let journal = move_across(&env, &src, &dest).unwrap();
        assert!(!src.exists());
        let object = dest.join(".git").join("objects").join("ab").join("cdef");
        assert_eq!(fs::read_to_string(&object).unwrap(), "object");
        assert!(fs::metadata(&object).unwrap().permissions().readonly());
        assert_eq!(names(&env.home.join("project")), Vec::<String>::new(), "nothing set aside is left");
        assert_eq!(names(&env.home.join("archive")), ["demo"], "no staging folder is left");
        undo(&env, journal["id"].as_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(src.join("README.md")).unwrap(), "# demo\n");
    }

    /// A copy that fails partway, here at a socket no copy can take, removes what it copied. The source was copied
    /// where it is, so a copy that stops there, as when Laci is closed, leaves it in its place too.
    #[test]
    fn a_move_across_volumes_that_cannot_copy_everything_leaves_the_source_in_its_place() {
        let (_temp, env, src, dest) = home();
        fs::write(src.join("LICENSE"), "MIT\n").unwrap();
        make_read_only(&src.join("LICENSE"));
        let _socket = std::os::unix::net::UnixListener::bind(src.join("socket")).unwrap();
        let error = move_across(&env, &src, &dest).unwrap_err();
        assert_eq!(error, format!("Unsupported special file {}", src.join("socket").display()));
        assert!(!dest.exists());
        assert_eq!(names(&env.home.join("archive")), Vec::<String>::new(), "the staging folder is gone");
        assert_eq!(names(&env.home.join("project")), ["demo"], "nothing is set aside");
        assert_eq!(names(&src), ["LICENSE", "README.md", "socket"]);
    }

    /// A source that can't leave its folder, here as that folder is read-only, stops the move before anything is
    /// copied. Before, the copy was published, the source emptied, and the two together blocked the rollback.
    #[test]
    fn a_source_that_cannot_leave_its_folder_is_never_copied() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, env, src, dest) = home();
        let parent = env.home.join("project");
        let mode = |mode: u32| fs::set_permissions(&parent, fs::Permissions::from_mode(mode)).unwrap();
        mode(0o555);
        if fs::write(parent.join("probe"), "").is_ok() {
            eprintln!("Nothing is read-only to this user, as to root; nothing to check.");
            mode(0o755);
            return;
        }
        let moved = move_across(&env, &src, &dest);
        mode(0o755);
        let error = moved.unwrap_err();
        assert!(error.contains("ermission denied"), "{error}");
        assert_eq!(names(&env.home.join("archive")), Vec::<String>::new(), "nothing was copied or staged");
        assert_eq!(names(&parent), ["demo"]);
        assert_eq!(fs::read_to_string(src.join("README.md")).unwrap(), "# demo\n");
    }

    /// A source that can't be deleted once the copy is in place, here as a folder in it is read-only, is named in the
    /// error, and the rollback brings the copy back. Before, the source stayed half deleted beside the copy, and the
    /// two together blocked the rollback and every Undo.
    #[test]
    fn a_source_left_after_a_move_across_volumes_is_named_and_the_move_rolls_back() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path, mode: u32| fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        let (_temp, env, src, dest) = home();
        let locked = src.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("kept"), "kept").unwrap();
        mode(&locked, 0o555);
        if fs::remove_file(locked.join("kept")).is_ok() {
            eprintln!("Nothing is read-only to this user, as to root; nothing to check.");
            mode(&locked, 0o755);
            return;
        }
        let error = move_across(&env, &src, &dest).unwrap_err();
        let parent = env.home.join("project");
        let left: Vec<PathBuf> =
            names(&parent).iter().filter(|n| n.starts_with(".laci-move-")).map(|n| parent.join(n)).collect();
        // So the temporary folder can go.
        for dir in left.iter().map(|aside| aside.join("locked")).chain([locked.clone(), dest.join("locked")]) {
            if dir.exists() {
                mode(&dir, 0o755);
            }
        }
        let [aside] = left.as_slice() else { panic!("one folder set aside: {left:?}") };
        assert!(error.contains(&format!("Laci couldn't delete {}", aside.display())), "{error}");
        assert!(error.contains("delete that folder by hand"), "{error}");
        assert!(!dest.exists());
        assert_eq!(fs::read_to_string(locked.join("kept")).unwrap(), "kept", "the copy came back");
        assert_eq!(fs::read_to_string(src.join("README.md")).unwrap(), "# demo\n");
    }

    /// How NFS, 9p (as WSL's /mnt/c), eCryptfs and FUSE file systems without RENAME2 answer a rename that mustn't
    /// replace anything, on Linux: EINVAL, with nothing renamed.
    fn refused(_: &Path, _: &Path) -> std::io::Result<()> {
        Err(rustix::io::Errno::INVAL.into())
    }

    /// A source on such a file system can't be set aside, and still moves to another volume: its copy is published, it
    /// is deleted where it is, and nothing is left on either side. Before, the move stopped at "Invalid argument"
    /// without copying anything, where it used to work.
    #[test]
    fn a_source_that_cannot_be_set_aside_still_moves_across_volumes() {
        let (_temp, env, src, dest) = home();
        let journal = move_across_by(&env, &src, &dest, refused).unwrap();
        assert!(!src.exists());
        assert_eq!(fs::read_to_string(dest.join("README.md")).unwrap(), "# demo\n");
        assert_eq!(names(&env.home.join("project")), Vec::<String>::new(), "nothing set aside is left");
        assert_eq!(names(&env.home.join("archive")), ["demo"], "no staging folder is left");
        undo(&env, journal["id"].as_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(src.join("README.md")).unwrap(), "# demo\n");
    }

    /// Such a source that can't be deleted once its copy is in place, here as a folder in it is read-only, is named in
    /// the error, so what is left of it can be deleted by hand: the copy holds everything.
    #[test]
    fn a_source_that_cannot_be_set_aside_or_deleted_is_named() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path, mode: u32| fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        let (_temp, env, src, dest) = home();
        let locked = src.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("kept"), "kept").unwrap();
        mode(&locked, 0o555);
        if fs::remove_file(locked.join("kept")).is_ok() {
            eprintln!("Nothing is read-only to this user, as to root; nothing to check.");
            mode(&locked, 0o755);
            return;
        }
        let error = move_across_by(&env, &src, &dest, refused).unwrap_err();
        // So the temporary folder can go.
        for dir in [locked.clone(), dest.join("locked")] {
            if dir.exists() {
                mode(&dir, 0o755);
            }
        }
        let named = format!(
            "Laci couldn't delete {}, what is left of demo after the copy, so delete that folder",
            src.display()
        );
        assert!(error.starts_with(&named) && error.contains("ermission denied"), "{error}");
        assert_eq!(fs::read_to_string(dest.join("locked").join("kept")).unwrap(), "kept", "the copy holds everything");
        assert_eq!(names(&env.home.join("archive")), ["demo"], "no staging folder is left");
        assert_eq!(names(&env.home.join("project")), ["demo"], "nothing is set aside");
    }

    /// A home and, beside it, a folder that stands for another drive, spelled as the file system spells them.
    fn copy_home() -> (tempfile::TempDir, Env, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = platform::path::canonical(temp.path()).unwrap();
        let env = Env::for_home(root.join("home"));
        fs::create_dir_all(&env.home).unwrap();
        let disk = root.join("disk");
        fs::create_dir_all(&disk).unwrap();
        (temp, env, disk)
    }

    /// The copy in Laci's data folder, holding a chat of each of `agents`, and an empty folder on the other drive.
    fn copy_of(env: &Env, disk: &Path, agents: &[&str]) -> (PathBuf, PathBuf) {
        let (from, to) = (env.data_dir.join("history"), disk.join("ai-chats"));
        for agent in agents {
            fs::create_dir_all(from.join(agent)).unwrap();
            fs::write(from.join(agent).join("a.jsonl.zst"), agent).unwrap();
        }
        crate::backup::mark(&from).unwrap();
        fs::create_dir_all(&to).unwrap();
        (from, to)
    }
    /// Whether the copy at `dir` holds the chat of `agent` that [`copy_of`] made.
    fn holds(dir: &Path, agent: &str) -> bool {
        fs::read_to_string(dir.join(agent).join("a.jsonl.zst")).is_ok_and(|text| text == agent)
    }

    /// A move of the copy that stopped part-way, as when Laci was closed after the first of its folders moved, leaves
    /// both folders listed until the next backup finishes it; Undo then moves all of it back.
    #[test]
    fn a_move_of_the_copy_that_stopped_part_way_is_finished_and_undone_whole() {
        let (_temp, env, disk) = copy_home();
        let (from, to) = copy_of(&env, &disk, &["claude", "codex"]);
        // What `move_copy_into` does, up to where it stopped: the setting points to the new folder, and only `claude`
        // moved.
        crate::backup::mark(&to).unwrap();
        let mut tx = Tx::new(&env, "Moved the copy of AI chats", Value::Null).unwrap();
        let roots = json!([crate::backup::journal_root(&from).unwrap(), crate::backup::journal_root(&to).unwrap()]);
        tx.journal["copyMove"] = json!({"from":from,"to":to,"roots":roots});
        tx.save().unwrap();
        let id = tx.journal["id"].as_str().unwrap().to_owned();
        crate::backup::begin_moving(&env, &id, false).unwrap();
        point_copy(&env, &to).unwrap();
        tx.move_copy(&from.join("claude"), &to.join("claude"), &roots).unwrap();
        drop(tx);
        assert_eq!(crate::backup::dirs(&env), [to.clone(), from.clone()], "both halves are listed meanwhile");

        let settled = settle_copy(&env).unwrap().expect("the move is finished");
        assert_eq!(settled["state"], "applied");
        assert!(holds(&to, "claude") && holds(&to, "codex"));
        assert!(!from.join("claude").exists() && !from.join("codex").exists());
        assert!(crate::backup::moving(&env).is_none());
        assert_eq!(crate::backup::dirs(&env), [to.as_path()]);
        assert_eq!(settle_copy(&env).unwrap(), None, "nothing is left to finish");

        undo(&env, &id).unwrap();
        assert!(holds(&from, "claude") && holds(&from, "codex"));
        assert!(!to.join("claude").exists() && !to.join("codex").exists());
        assert_eq!(crate::config::load(&env)["backupDir"], "");
        assert!(crate::backup::moving(&env).is_none());
    }

    /// A move of the copy that stopped part-way and that an Undo of an older move finishes first is told in the Log
    /// with its own Undo, as a backup or another move tells it, also when that Undo is then refused.
    #[test]
    fn a_move_of_the_copy_that_an_undo_finishes_is_told_in_the_log() {
        let (_temp, env, disk) = copy_home();
        let (from, to) = copy_of(&env, &disk, &["claude", "codex"]);
        let mut service = crate::service::Service::new(env.clone());
        service.request_as("backup/move", &json!({"dir":to}), "test").unwrap();
        let log = || crate::activity::read_log(&env, 50);
        let first = log().into_iter().find(|e| e["say"]["form"] == "movedCopy").unwrap();
        // A second move, to a third folder, stopped after `claude` moved.
        let next = disk.join("next");
        fs::create_dir_all(&next).unwrap();
        crate::backup::mark(&next).unwrap();
        let say = json!({"form":"movedCopy","dir":next,"own":false});
        let mut tx = Tx::new(&env, "Moved the copy of AI chats", say).unwrap();
        let roots = json!([crate::backup::journal_root(&to).unwrap(), crate::backup::journal_root(&next).unwrap()]);
        tx.journal["copyMove"] = json!({"from":to,"to":next,"roots":roots});
        tx.save().unwrap();
        let id = tx.journal["id"].as_str().unwrap().to_owned();
        crate::backup::begin_moving(&env, &id, false).unwrap();
        point_copy(&env, &next).unwrap();
        tx.move_copy(&to.join("claude"), &next.join("claude"), &roots).unwrap();
        drop(tx);

        // The Undo of the first move finishes the second one, which then stands in its way.
        let refused = service.request_as("log/undo", &json!({"id":first["id"]}), "test").unwrap_err();
        assert!(refused.contains("moved again after this"), "{refused}");
        assert!(holds(&next, "claude") && holds(&next, "codex"));
        let told = log().into_iter().find(|e| e["journal"] == id.as_str()).expect("the finished move is in the Log");
        assert_eq!((&told["by"], &told["state"], &told["canUndo"]), (&json!("test"), &json!("applied"), &json!(true)));
        assert!(!told["id"].as_str().unwrap().starts_with("j:"), "a line of its own: {told}");

        // Its Undo, and then the first one's, take the copy back where it started.
        service.request_as("log/undo", &json!({"id":told["id"]}), "test").unwrap();
        service.request_as("log/undo", &json!({"id":first["id"]}), "test").unwrap();
        assert!(holds(&from, "claude") && holds(&from, "codex"));
        assert_eq!(crate::config::load(&env)["backupDir"], "");
    }

    /// While config.json is there but can't be read, as when the app that syncs it can't download it, nothing moves the
    /// copy: the defaults would name the folder the move started from, and finishing it that way would hide the chats
    /// from the setting once it is back. Once it is back, the move is finished the way it points.
    #[test]
    fn nothing_moves_the_copy_while_the_settings_cant_be_read() {
        let (_temp, env, disk) = copy_home();
        let (from, to) = copy_of(&env, &disk, &["claude", "codex"]);
        crate::backup::mark(&to).unwrap();
        let mut tx = Tx::new(&env, "Moved the copy of AI chats", Value::Null).unwrap();
        let roots = json!([crate::backup::journal_root(&from).unwrap(), crate::backup::journal_root(&to).unwrap()]);
        tx.journal["copyMove"] = json!({"from":from,"to":to,"roots":roots});
        tx.save().unwrap();
        let id = tx.journal["id"].as_str().unwrap().to_owned();
        crate::backup::begin_moving(&env, &id, false).unwrap();
        point_copy(&env, &to).unwrap();
        tx.move_copy(&from.join("claude"), &to.join("claude"), &roots).unwrap();
        drop(tx);
        let file = env.config_dir.join("config.json");
        let saved = fs::read(&file).unwrap();
        fs::write(&file, b"\0\0\0\0").unwrap();

        let unreadable = |error: String| {
            assert!(error.starts_with("Laci couldn't read your settings in "), "{error}");
            assert!(error.contains("doesn't know where the copy of AI chats is kept"), "{error}");
        };
        unreadable(settle_copy(&env).unwrap_err());
        unreadable(backup_history(&env, &json!({"connectors":[]})).unwrap_err());
        unreadable(move_backup(&env, "", true).unwrap_err());
        unreadable(undo(&env, &id).unwrap_err());
        assert!(holds(&to, "claude") && holds(&from, "codex"), "nothing moved");
        assert!(crate::backup::moving(&env).is_some(), "the move is still to be finished");
        assert_eq!(fs::read(&file).unwrap(), b"\0\0\0\0", "the settings are as they were");

        fs::write(&file, saved).unwrap();
        assert_eq!(settle_copy(&env).unwrap().expect("the move is finished")["state"], "applied");
        assert!(holds(&to, "claude") && holds(&to, "codex"));
    }

    /// A move of the copy that is put back stops at a folder of it that is in both places, as a move to sshfs leaves one
    /// whose source it couldn't delete after its copy was published, and names both folders: it isn't counted as put
    /// back, so the copy isn't left whole in the folder the setting no longer names.
    #[test]
    fn putting_a_move_of_the_copy_back_stops_at_a_part_that_is_in_both_folders() {
        let (_temp, env, disk) = copy_home();
        let (from, to) = copy_of(&env, &disk, &["claude", "codex"]);
        let roots = json!([crate::backup::journal_root(&from).unwrap(), crate::backup::journal_root(&to).unwrap()]);
        let mut tx = Tx::new(&env, "Moved the copy of AI chats", Value::Null).unwrap();
        // `codex` moved first; `claude` was copied in full, and then its source couldn't be deleted.
        fs::rename(from.join("codex"), to.join("codex")).unwrap();
        copy_tree(&from.join("claude"), &to.join("claude")).unwrap();
        let moved = ["codex", "claude"].map(std::ffi::OsString::from);
        let error = shift_back(&mut tx, &from, &to, &roots, &moved).unwrap_err();
        let both =
            format!("claude is both in {} and in {}, so Laci stopped", to.display(), paths::tilde(&from, &env.home));
        assert!(error.starts_with(&both), "{error}");
        assert!(holds(&from, "claude") && holds(&to, "claude"), "neither half is removed");
        assert!(holds(&to, "codex") && !from.join("codex").exists(), "nothing after it moved back");
        // Without such a part, as on ext4, everything moves back.
        fs::remove_dir_all(to.join("claude")).unwrap();
        shift_back(&mut tx, &from, &to, &roots, &moved).unwrap();
        assert!(holds(&from, "claude") && holds(&from, "codex"));
        assert!(!to.join("claude").exists() && !to.join("codex").exists());
    }

    /// An Undo of a move of the copy that is refused changes nothing, so backups go on. Settings changed since, as the
    /// theme, don't stand in its way, and what the copy gained since, as the folder of another agent, goes back too.
    #[test]
    fn an_undo_of_a_move_of_the_copy_refuses_before_anything_changes_and_takes_all_of_it_back() {
        let (_temp, env, disk) = copy_home();
        let (from, to) = copy_of(&env, &disk, &["claude"]);
        let moved = move_backup(&env, to.to_str().unwrap(), false).unwrap();
        let id = moved["journal"]["id"].as_str().unwrap().to_owned();
        assert!(holds(&to, "claude") && !from.join("claude").exists());
        let mut cfg = crate::config::load(&env);
        cfg["theme"] = json!("dark");
        crate::config::save(&env, &cfg).unwrap();
        fs::create_dir_all(to.join("codex")).unwrap();
        fs::write(to.join("codex/a.jsonl.zst"), "codex").unwrap();

        // The old folder holds something Undo would write over: refused, and nothing started that a backup must finish.
        fs::create_dir_all(from.join("codex")).unwrap();
        let refused = undo(&env, &id).unwrap_err();
        assert!(refused.ends_with("already exists; undo would overwrite it"), "{refused}");
        assert!(crate::backup::moving(&env).is_none());
        assert_eq!(settle_copy(&env).unwrap(), None);
        backup_history(&env, &json!({"connectors":[]})).unwrap();
        assert_eq!(crate::backup::dir(&env).unwrap(), to);
        assert!(holds(&to, "claude"));

        fs::remove_dir(from.join("codex")).unwrap();
        assert_eq!(undo(&env, &id).unwrap()["state"], "undone");
        assert!(holds(&from, "claude") && holds(&from, "codex"));
        assert!(!to.join("claude").exists() && !to.join("codex").exists() && crate::backup::marked(&to));
        let cfg = crate::config::load(&env);
        assert_eq!((&cfg["backupDir"], &cfg["theme"]), (&json!(""), &json!("dark")));
        assert!(crate::backup::moving(&env).is_none());
        assert_eq!(
            read_journal(&data(&env, "journal").unwrap().join(format!("{id}.json"))).unwrap()["state"],
            "undone"
        );
    }

    /// An Undo of a move of the copy that was done but stopped before its journal said so, and a move that failed and
    /// stopped while it was put back, are finished the way the setting points: the whole copy is in the folder it
    /// names, the journal says what happened, and nothing is left for the next backup to finish.
    #[test]
    fn a_move_of_the_copy_that_stopped_is_finished_the_way_the_setting_points() {
        let (_temp, env, disk) = copy_home();
        let (from, to) = copy_of(&env, &disk, &["claude", "codex"]);
        let moved = move_backup(&env, to.to_str().unwrap(), false).unwrap();
        let id = moved["journal"]["id"].as_str().unwrap().to_owned();
        let file = data(&env, "journal").unwrap().join(format!("{id}.json"));
        let journal = read_journal(&file).unwrap();
        let roots = journal["copyMove"]["roots"].clone();

        // The Undo moved everything back, but its journal still says the move is applied.
        crate::backup::begin_moving(&env, &id, true).unwrap();
        point_copy(&env, &from).unwrap();
        let mut tx = Tx::resume(&env, journal.clone(), file.clone());
        shift(&mut tx, &to, &from, &roots, &mut Vec::new()).unwrap();
        drop(tx);
        assert_eq!(settle_copy(&env).unwrap(), None, "an Undo is in the Log already");
        assert_eq!(read_journal(&file).unwrap()["state"], "undone");
        assert!(crate::backup::moving(&env).is_none());
        assert!(holds(&from, "claude") && holds(&from, "codex"));
        backup_history(&env, &json!({"connectors":[]})).unwrap();

        // A move that failed was put back: the setting is back, but only `codex` is.
        let mut journal = journal;
        journal["state"] = json!("running");
        files::replace(&file, journal.to_string().as_bytes()).unwrap();
        fs::rename(from.join("claude"), to.join("claude")).unwrap();
        crate::backup::begin_moving(&env, &id, false).unwrap();
        assert_eq!(settle_copy(&env).unwrap(), None, "a move that was put back isn't told");
        assert_eq!(read_journal(&file).unwrap()["state"], "undone");
        assert!(holds(&from, "claude") && holds(&from, "codex") && !to.join("claude").exists());
        assert!(crate::backup::moving(&env).is_none());
        assert_eq!(crate::backup::dirs(&env), [from.as_path()]);
    }

    /// What a move of the copy to another drive leaves when it stops, named by its journal entry, is put right: the
    /// source comes back, or its complete copy is published, and nothing that may be the only copy is removed.
    #[test]
    fn a_cross_drive_move_of_the_copy_that_stopped_is_put_right_from_what_it_left() {
        let temp = tempfile::tempdir().unwrap();
        let (src, dest) = (temp.path().join("from").join("claude"), temp.path().join("to").join("claude"));
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        let token = "1a-2b";
        let (aside, staged) = copy_move_names(&src, &dest, token).unwrap();
        let make = |dir: &Path| {
            fs::create_dir_all(dir).unwrap();
            fs::write(dir.join("a.jsonl.zst"), "chat").unwrap();
        };
        // Stopped while copying: the source is in place, and the half copy goes.
        make(&src);
        make(&staged.join("payload"));
        repair_copy_move(&src, &dest, token).unwrap();
        assert!(src.is_dir() && !staged.exists() && !dest.exists());
        // Stopped with the source set aside: it comes back.
        fs::rename(&src, &aside).unwrap();
        make(&staged.join("payload"));
        repair_copy_move(&src, &dest, token).unwrap();
        assert!(src.is_dir() && !aside.exists() && !staged.exists() && !dest.exists());
        // The source went after its copy was complete, but the copy never took its place: it does now.
        fs::remove_dir_all(&src).unwrap();
        make(&staged.join("payload"));
        repair_copy_move(&src, &dest, token).unwrap();
        assert_eq!(fs::read_to_string(dest.join("a.jsonl.zst")).unwrap(), "chat");
        assert!(!staged.exists());
        // The copy is in its place, and what is left of the source set aside goes.
        make(&aside);
        repair_copy_move(&src, &dest, token).unwrap();
        assert!(!aside.exists() && dest.is_dir());
        // Both are there: Laci can't tell which is whole, and removes neither.
        make(&src);
        assert!(repair_copy_move(&src, &dest, token).unwrap_err().starts_with("Both "));
        assert!(src.is_dir() && dest.is_dir());
        assert!(copy_move_names(&src, &dest, "../x").is_err(), "a journal can't name another folder");
    }

    /// While a backup holds the change lock for minutes, another change of the same data is refused at once rather
    /// than wait; the backup itself, and a change of other data, wait as before.
    #[test]
    fn a_change_is_refused_at_once_while_a_backup_holds_the_change_lock() {
        let (_temp, env, _) = copy_home();
        let env = &env;
        let (held, holding) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        thread::scope(|scope| {
            let long = scope.spawn(move || {
                let _long = LongRun::start(env);
                with_lock(env, || {
                    held.send(()).unwrap();
                    released.recv().unwrap();
                    Ok(())
                })
            });
            holding.recv().unwrap();
            let asked = Instant::now();
            assert_eq!(with_lock(env, || Ok(())), Err(COPYING.to_owned()));
            assert!(asked.elapsed() < Duration::from_secs(1));
            release.send(()).unwrap();
            long.join().unwrap().unwrap();
        });
        assert_eq!(with_lock(env, || Ok(1)), Ok(1));
    }
}
