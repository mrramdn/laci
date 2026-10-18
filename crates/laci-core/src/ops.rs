//! Journaled disk changes. The journal and PID lock remain readable by Laci v1.
use crate::{
    Result,
    env::Env,
    files, paths,
    platform::{
        self,
        path::{below, contains, may_contain, relocate, renames_case, rewrite_prefix, same_path, stays_below},
        preserve,
    },
    process, sidecar,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

static SEQ: AtomicU64 = AtomicU64::new(0);
static IN_PROCESS: Mutex<()> = Mutex::new(());
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
    let checked = value_path(env, &entry[key]);
    if checked.is_err()
        && key == "from"
        && entry["kind"] == "move"
        && let (Some(volume), Some(file)) =
            (entry["parentDevice"].as_u64(), platform::Identity::file_from_json(&entry["parentInode"]))
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
    let _serial = IN_PROCESS.lock().map_err(|_| "File-change lock was interrupted".to_owned())?;
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
            if skip_git && e.file_name() == ".git" {
                continue;
            }
            copy_tree_inner(&e.path(), &dest.join(e.file_name()), skip_git)?;
        }
        preserve(&meta, dest)?;
    } else if meta.is_file() {
        let mut input = File::open(src).map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new().write(true).create_new(true).open(dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all()).map_err(|e| e.to_string())?;
        preserve(&meta, dest)?;
    } else {
        return Err(format!("Unsupported special file {}", src.display()));
    }
    Ok(())
}
fn remove(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) { fs::remove_dir_all(path) } else { fs::remove_file(path) }
        .map_err(|e| e.to_string())
}
fn rename(src: &Path, dest: &Path) -> Result<()> {
    match platform::rename_noreplace(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && renames_case(src, dest) => rename_case(src, dest),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            // Copy into a private sibling first, then publish atomically. A failed copy leaves the source intact.
            let staged = tempfile::Builder::new()
                .prefix(".laci-move-")
                .tempdir_in(dest.parent().ok_or("Missing destination parent")?)
                .map_err(|e| e.to_string())?;
            let payload = staged.path().join("payload");
            copy_tree(src, &payload)?;
            platform::rename_noreplace(&payload, dest).map_err(|e| e.to_string())?;
            remove(src)
        }
        Err(e) => Err(e.to_string()),
    }
}
/// A rename that only changes the case of a name, where the file system counts the new name as taken by the old one.
/// It goes by a free name in the same folder, and back if the second step fails.
fn rename_case(src: &Path, dest: &Path) -> Result<()> {
    let parent = src.parent().ok_or("Missing parent")?;
    let staged =
        parent.join(format!(".laci-rename-{:x}-{:x}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    platform::rename_noreplace(src, &staged).map_err(|e| e.to_string())?;
    platform::rename_noreplace(&staged, dest).map_err(|e| {
        let _ = platform::rename_noreplace(&staged, src);
        e.to_string()
    })
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
/// Git for Windows' `git.exe` runs Git in a second process, which isn't Laci's helper even when the first is, so
/// Laci's own Git can be waited for there too.
const GIT_WAIT: Duration = Duration::from_secs(3);
/// [`busy_in`] for checks that decide something. A process counts only if it is still in the folder a moment
/// later, so one that is just passing through, such as a helper of another Laci still starting, doesn't make the
/// folder busy. While Git (`git…`, as `git.exe` on Windows) is all that stays, it looks again for up to
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
    fn new(env: &'a Env, title: &str) -> Result<Self> {
        let id = id();
        let file = data(env, "journal")?.join(format!("{id}.json"));
        let tx = Self {
            env,
            journal: json!({"id":id,"at":files::now(),"title":title,"state":"running","entries":[]}),
            file,
            n: 0,
        };
        tx.save()?;
        Ok(tx)
    }
    fn save(&self) -> Result<()> {
        files::replace(&self.file, serde_json::to_vec_pretty(&self.journal).map_err(|e| e.to_string())?.as_slice())
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
        sidecar::plain_path(src)?;
        sidecar::plain_path(dest)?;
        // Where case doesn't matter, the name in its new case already finds the folder itself.
        let recased = renames_case(src, dest);
        if exists(dest) && !recased {
            return Err(format!("{} already exists", paths::tilde(dest, &self.env.home)));
        }
        if !exists(src) {
            return Err(format!("{} is gone", paths::tilde(src, &self.env.home)));
        }
        if contains(src, dest) && !recased {
            return Err("Can't move a folder into itself".into());
        }
        if src.is_dir() {
            guard(&[src.to_owned()])?;
        }
        let mut entry = json!({"kind":"move","from":src,"to":dest});
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
        self.log(entry)?;
        rename(src, dest)
    }
    fn merge(&mut self, src: &Path, dest: &Path) -> Result<()> {
        if src == dest {
            return Ok(());
        }
        if !exists(dest) || renames_case(src, dest) {
            return self.move_to(src, dest);
        }
        // Another spelling of the same folder, on macOS and Windows: there is nothing to merge.
        if same_path(src, dest) {
            return Ok(());
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
        let mut cfg = crate::config::load(self.env);
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
        let file = paths::config_file(self.env)?;
        cfg["roots"] = json!(
            roots
                .iter()
                .map(|root| paths::tilde(root, &self.env.home))
                .chain(std::iter::once(paths::tilde(dest, &self.env.home)))
                .collect::<Vec<_>>()
        );
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
        fs::remove_dir_all(path).map_err(|e| e.to_string())
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
fn transact(env: &Env, title: &str, work: impl FnOnce(&mut Tx<'_>) -> Result<()>) -> Result<Value> {
    with_lock(env, || {
        let mut tx = Tx::new(env, title)?;
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
                                "{error} · Reversible changes were rolled back. Check system Trash for any files already moved there."
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
    })
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
                    "Settings changed after this archive. Restore those settings before undoing it.".into()
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
        if exists(&from) && exists(&to) && !renames_case(&to, &from) {
            return Err(format!("{} already exists; undo would overwrite it", from.display()));
        }
    }
    for e in entries.iter().rev() {
        match e["kind"].as_str().unwrap_or("") {
            "move" => {
                let from = journal_path(env, e, "from")?;
                let to = journal_path(env, e, "to")?;
                if exists(&to) {
                    if exists(&from) && !renames_case(&to, &from) {
                        return Err(format!("{} already exists; undo would overwrite it", from.display()));
                    }
                    fs::create_dir_all(from.parent().ok_or("Missing parent")?).map_err(|e| e.to_string())?;
                    rename(&to, &from)?;
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

pub fn recovery(journal: &Value) -> Option<&'static str> {
    let trashed = journal["entries"].as_array().into_iter().flatten().any(|e| e["kind"] == "trash");
    let cleared = journal["entries"].as_array().into_iter().flatten().any(|e| e["kind"] == "cleared");
    if cleared && !trashed {
        return Some(if can_undo(journal) {
            "Undo restores moves and edits; deleted build output comes back with the next install or build."
        } else {
            "Deleted build output comes back with the next install or build."
        });
    }
    trashed.then(|| {
        if can_undo(journal) {
            "Laci Undo restores moves and edits only. Restore trashed files separately through system Trash."
        } else {
            "Restore these files through system Trash; Laci Undo is unavailable."
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
    with_lock(env, || undo_unlocked(env, id))
}
pub(crate) fn undo_unlocked(env: &Env, id: &str) -> Result<Value> {
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        return Err("Invalid journal id".into());
    }
    let file = data(env, "journal")?.join(format!("{id}.json"));
    let mut journal = read_journal(&file)?;
    if journal["state"] != "applied" {
        return Err(format!("This change is {}, nothing to undo", journal["state"].as_str().unwrap_or("invalid")));
    }
    if journal["copiesRemoved"] == true {
        return Err("The copies this undo needs were removed to free space".into());
    }
    if !can_undo(&journal) {
        return Err("Restore these files through system Trash; there is no Laci Undo".into());
    }
    let entries = journal["entries"].as_array().ok_or("Invalid journal")?;
    validate_entries(env, entries)?;
    guard(
        &entries
            .iter()
            .filter(|e| e["kind"] == "move")
            .map(|e| value_path(env, &e["to"]))
            .collect::<Result<Vec<_>>>()?,
    )?;
    undo_entries(env, entries)?;
    journal["state"] = json!("undone");
    files::replace(&file, &serde_json::to_vec_pretty(&journal).map_err(|e| e.to_string())?)?;
    Ok(journal)
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
    if contains(&src, &dest) && !renames_case(&src, &dest) {
        return Err("Can't move a folder into itself".into());
    }
    let title = opts["title"].as_str().map(str::to_owned).unwrap_or_else(|| {
        format!("Move {} → {}", node["name"].as_str().unwrap_or("project"), paths::tilde(&dest, &env.home))
    });
    transact(env, &title, |tx| {
        guard(std::slice::from_ref(&src))?;
        if opts["status"] == "archived" {
            crate::scan::check_archive_destination(env, &dest)?;
        }
        // Which history belongs to the folder is asked while it is still there: on macOS and Windows another
        // spelling of it counts only as long as the file system can confirm it.
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
    let node = &snap["nodes"][id];
    move_project(
        env,
        snap,
        id,
        plan["dest"].as_str().ok_or("Missing archive destination")?,
        &json!({"status":"archived","trashHeavy":trash_heavy,"title":format!("Archive {}",node["name"].as_str().unwrap_or("project"))}),
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
        &proposal["action"],
        Some((proposal, recovery)),
    )
}

pub fn apply_action(env: &Env, snap: &Value, title: &str, a: &Value) -> Result<Value> {
    apply_action_checked(env, snap, title, a, None)
}

fn apply_action_checked(
    env: &Env,
    snap: &Value,
    title: &str,
    a: &Value,
    reviewed: Option<(&Value, &str)>,
) -> Result<Value> {
    if a["type"] == "archive" {
        return archive_project(env, snap, a["nodeId"].as_str().ok_or("Missing project")?, false);
    }
    transact(env, title, |tx| {
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
pub fn backup_history(env: &Env, snap: &Value) -> Result<Value> {
    with_lock(env, || {
        let dest = data(env, "history")?;
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
            // On Windows a `C:` in front would make the join below start over on that drive.
            if connector.is_empty()
                || connector.contains(['/', '\\'])
                || connector == ".."
                || (cfg!(windows) && connector.contains(':'))
            {
                return Err("Invalid connector id".into());
            }
            if dest.starts_with(&src) {
                return Err("History backup cannot be inside its source".into());
            }
            for item in walkdir::WalkDir::new(&src)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                if !item.path().extension().is_some_and(|e| ["jsonl", "json", "md"].iter().any(|ext| e == *ext)) {
                    continue;
                }
                let target = dest.join(connector).join(item.path().strip_prefix(&src).map_err(|e| e.to_string())?);
                sidecar::plain_path(&target)?;
                let metadata = fs::metadata(item.path()).map_err(|e| e.to_string())?;
                if fs::metadata(&target).is_ok_and(|m| m.len() == metadata.len()) {
                    continue;
                }
                let content = fs::read(item.path()).map_err(|e| e.to_string())?;
                files::replace(&target, &content)?;
                preserve(&metadata, &target)?;
                copied += 1;
                bytes += metadata.len();
            }
        }
        // What the backup holds now, including sessions their tool has since deleted.
        let (mut sessions, mut kept, mut total) = (0u64, 0u64, 0u64);
        for item in walkdir::WalkDir::new(&dest).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            if item.file_type().is_file() {
                kept += 1;
                total += item.metadata().map_or(0, |m| m.len());
                sessions += u64::from(item.path().extension().is_some_and(|e| e == "jsonl"));
            }
        }
        let state = json!({"at":files::now(),"copied":copied,"sessions":sessions,"files":kept,"bytes":total});
        files::replace(&data(env, BACKUP_STATE)?, state.to_string().as_bytes())?;
        Ok(
            json!({"copied":copied,"bytes":bytes,"size":bytes,"dest":dest,"sessions":sessions,"files":kept,"total":total}),
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
        let kept = data(env, "history")?.join(connector["id"].as_str().ok_or("Missing connector")?);
        let source = value_path(env, &session["file"])?;
        let relative = source.strip_prefix(&kept).map_err(|_| "That file is not part of the backup".to_owned())?;
        let target = value_path(env, &connector["link"]["dir"])?.join(relative);
        if session["restoreTo"].as_str() != target.to_str() {
            return Err("That session no longer matches the backup; refresh history".into());
        }
        sidecar::plain_path(&target)?;
        if exists(&target) {
            return Err("That session is already back in place".into());
        }
        let content = fs::read(&source).map_err(|e| e.to_string())?;
        files::replace(&target, &content)?;
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
        // On Windows `\` and a drive's `:` would lead the joins below out of the quarantine.
        let id = connector["id"]
            .as_str()
            .filter(|id| !id.is_empty() && !id.contains(['/', '.']) && !(cfg!(windows) && id.contains(['\\', ':'])))
            .ok_or("Unknown agent")?;
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
    let title = match plan.as_slice() {
        [(.., one)] => format!("Deleted the session “{one}”"),
        _ => format!("Deleted {} sessions", plan.len()),
    };
    transact(env, &title, |tx| {
        let id = tx.journal["id"].as_str().unwrap_or("removed").to_owned();
        let removed = data(env, "orphans")?.join("sessions").join(&id);
        let history = data(env, "history")?;
        for (connector, claude, store, relative, _) in &plan {
            let source = store.join(relative);
            tx.move_to(&source, &removed.join(connector).join(relative))?;
            // Claude Code keeps a session's subagent logs and tool output in a folder named after it.
            let folder = source.with_extension("");
            if *claude && fs::symlink_metadata(&folder).is_ok_and(|m| m.is_dir()) {
                tx.move_to(&folder, &removed.join(connector).join(relative.with_extension("")))?;
            }
            // Otherwise the backup's copy would bring it straight back as "In backup only".
            let copy = history.join(connector).join(relative);
            if fs::symlink_metadata(&copy).is_ok_and(|m| m.is_file()) {
                tx.move_to(&copy, &removed.join("backup").join(connector).join(relative))?;
            }
        }
        Ok(())
    })
}
const BACKUP_STATE: &str = "backup.json";
/// When agent history was last backed up and what the backup holds, or nothing if it never ran.
pub fn backup_state(env: &Env) -> Option<Value> {
    let mut state: Value = serde_json::from_str(&files::text(&data(env, BACKUP_STATE).ok()?)?).ok()?;
    state["at"].as_str()?;
    state["dest"] = json!(data(env, "history").ok()?);
    Some(state)
}

/// What macOS and Windows add to a move: a new case for a name.
#[cfg(all(test, not(target_os = "linux")))]
mod elsewhere {
    use super::*;

    #[test]
    fn a_file_renamed_to_another_case_is_renamed_and_undo_renames_it_back() {
        let temp = tempfile::tempdir().unwrap();
        let env = Env::for_home(platform::path::canonical(temp.path()).unwrap().join("home"));
        fs::create_dir_all(&env.home).unwrap();
        let (src, dest) = (env.home.join("Notes.md"), env.home.join("notes.md"));
        fs::write(&src, "kept").unwrap();
        if !exists(&dest) {
            eprintln!("This volume tells case apart; there is no such rename.");
            return;
        }
        let names = || {
            let mut names: Vec<_> =
                files::entries(&env.home).iter().map(|e| e.file_name()).filter(|n| n != ".local").collect();
            names.sort();
            names
        };
        let journal = transact(&env, "Rename", |tx| tx.move_to(&src, &dest)).unwrap();
        assert_eq!(names(), ["notes.md"]);
        undo_entries(&env, journal["entries"].as_array().unwrap()).unwrap();
        assert_eq!(names(), ["Notes.md"]);
        assert_eq!(fs::read_to_string(&src).unwrap(), "kept");
        // A name that another file has is still taken, in any case.
        fs::write(env.home.join("other.md"), "other").unwrap();
        assert!(transact(&env, "Rename", |tx| tx.move_to(&src, &env.home.join("OTHER.md"))).is_err());
        assert_eq!(fs::read_to_string(env.home.join("other.md")).unwrap(), "other");
    }

    /// A history folder merged into itself, spelled with a folder above it in another case, stays as it is.
    #[test]
    fn a_folder_merged_into_itself_under_another_spelling_is_left_as_it_is() {
        let temp = tempfile::tempdir().unwrap();
        let env = Env::for_home(platform::path::canonical(temp.path()).unwrap().join("home"));
        let store = env.home.join("store");
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("session.jsonl"), "{}\n").unwrap();
        let other = env.home.with_file_name("HOME").join("store");
        if !exists(&other) {
            eprintln!("This volume tells case apart; there is nothing to merge.");
            return;
        }
        let journal = transact(&env, "Merge", |tx| tx.merge(&store, &other)).unwrap();
        assert_eq!(journal["entries"], json!([]));
        assert_eq!(files::entries(&store).iter().map(|e| e.file_name()).collect::<Vec<_>>(), ["session.jsonl"]);
        assert_eq!(fs::read_to_string(store.join("session.jsonl")).unwrap(), "{}\n");
    }
}

/// These run on every OS. This test binary stands in for Git and the other programs: started again under their names,
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

    /// A project folder, and this test binary as each program in `names`. Linux gets links, as a program written
    /// here could fail to start with "Text file busy" while another test starts a process; macOS and Windows get
    /// copies, so each is listed under its own name. Each runs once first, as Windows can make a new program wait
    /// while Defender looks at it.
    fn fixture<const N: usize>(names: [&str; N]) -> (tempfile::TempDir, PathBuf, [PathBuf; N]) {
        let temp = tempfile::tempdir().unwrap();
        // Linux and macOS name working folders with links resolved; Windows keeps the spelling it was given.
        let root = if cfg!(windows) { temp.path().to_owned() } else { temp.path().canonicalize().unwrap() };
        let (project, bin) = (root.join("project"), root.join("bin"));
        fs::create_dir(&project).unwrap();
        fs::create_dir(&bin).unwrap();
        let programs = names.map(|name| {
            let (this, program) = (std::env::current_exe().unwrap(), bin.join(name));
            let program = program.with_extension(std::env::consts::EXE_EXTENSION);
            #[cfg(target_os = "linux")]
            std::os::unix::fs::symlink(this, &program).unwrap();
            #[cfg(not(target_os = "linux"))]
            fs::copy(this, &program).unwrap();
            let ran = Command::new(&program).args(STAND_IN).env(ROLE, "stay 0").stdout(Stdio::null()).status();
            assert!(ran.unwrap().success(), "{name} runs");
            program
        });
        (temp, project, programs)
    }

    /// The name the OS lists `program` under: `git`, or `git.exe` on Windows.
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
}
