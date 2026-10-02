//! Journaled disk changes. The journal and PID lock remain readable by Laci v1.
use crate::{Result, env::Env, files, paths, process, sidecar};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

static SEQ: AtomicU64 = AtomicU64::new(0);
static IN_PROCESS: Mutex<()> = Mutex::new(());
fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}
fn path(env: &Env, raw: &str) -> Result<PathBuf> {
    let p = paths::home_path(raw, env)?;
    sidecar::plain_path(&p)?;
    Ok(p)
}
fn value_path(env: &Env, v: &Value) -> Result<PathBuf> {
    path(env, v.as_str().ok_or("Missing file path")?)
}
fn data(env: &Env, name: &str) -> Result<PathBuf> {
    path(env, &env.data_dir.join(name).to_string_lossy())
}
fn id() -> String {
    format!(
        "{}-{:x}-{:x}",
        files::now().replace([':', '.'], "-"),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}
fn alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

struct Lock {
    file: File,
    path: PathBuf,
}
impl Drop for Lock {
    fn drop(&mut self) {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(a), Ok(b)) = (self.file.metadata(), fs::symlink_metadata(&self.path))
            && a.dev() == b.dev()
            && a.ino() == b.ino()
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn lock(env: &Env) -> Result<Lock> {
    use rustix::fs::{FlockOperation, flock};
    use std::os::unix::fs::MetadataExt;
    let path = data(env, "lock")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let busy = "Another laci window or agent is changing files right now. Try again in a moment.";
    for _ in 0..3 {
        match OpenOptions::new().write(true).read(true).create_new(true).open(&path) {
            Ok(file) => {
                let mut guard = Lock { file, path };
                flock(&guard.file, FlockOperation::NonBlockingLockExclusive).map_err(|_| busy.to_owned())?;
                guard
                    .file
                    .write_all(std::process::id().to_string().as_bytes())
                    .and_then(|_| guard.file.sync_all())
                    .map_err(|e| e.to_string())?;
                return Ok(guard);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                sidecar::plain_path(&path)?;
                let Ok(mut stale) = OpenOptions::new().read(true).write(true).open(&path) else {
                    continue;
                };
                flock(&stale, FlockOperation::NonBlockingLockExclusive).map_err(|_| busy.to_owned())?;
                let mut pid = String::new();
                stale.read_to_string(&mut pid).map_err(|e| e.to_string())?;
                if pid.trim().parse::<u32>().is_ok_and(|pid| pid > 0 && alive(pid)) {
                    return Err(busy.into());
                }
                // An empty v1 lock can be between exclusive creation and its PID write.
                if pid.trim().is_empty()
                    && stale
                        .metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age < Duration::from_secs(1))
                {
                    return Err(busy.into());
                }
                let a = stale.metadata().map_err(|e| e.to_string())?;
                if let Ok(b) = fs::symlink_metadata(&path)
                    && a.dev() == b.dev()
                    && a.ino() == b.ino()
                {
                    fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(busy.into())
}
pub fn with_lock<T>(env: &Env, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let _serial = IN_PROCESS.lock().map_err(|_| "File-change lock was interrupted".to_owned())?;
    let _lock = lock(env)?;
    work()
}

fn preserve(meta: &fs::Metadata, dest: &Path) -> Result<()> {
    let file = File::open(dest).map_err(|e| e.to_string())?;
    file.set_permissions(meta.permissions()).map_err(|e| e.to_string())?;
    let mut times = fs::FileTimes::new();
    if let Ok(atime) = meta.accessed() {
        times = times.set_accessed(atime);
    }
    if let Ok(mtime) = meta.modified() {
        times = times.set_modified(mtime);
    }
    file.set_times(times).map_err(|e| e.to_string())
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
        std::os::unix::fs::symlink(fs::read_link(src).map_err(|e| e.to_string())?, dest).map_err(|e| e.to_string())?;
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
    use rustix::fs::{CWD, RenameFlags, renameat_with};
    match renameat_with(CWD, src, CWD, dest, RenameFlags::NOREPLACE) {
        Ok(()) => Ok(()),
        Err(rustix::io::Errno::XDEV) => {
            // Copy into a private sibling first, then publish atomically. A failed copy leaves the source intact.
            let staged = tempfile::Builder::new()
                .prefix(".laci-move-")
                .tempdir_in(dest.parent().ok_or("Missing destination parent")?)
                .map_err(|e| e.to_string())?;
            let payload = staged.path().join("payload");
            copy_tree(src, &payload)?;
            renameat_with(CWD, &payload, CWD, dest, RenameFlags::NOREPLACE).map_err(|e| e.to_string())?;
            remove(src)
        }
        Err(e) => Err(e.to_string()),
    }
}
pub(crate) fn busy_in(paths: &[PathBuf]) -> Vec<Value> {
    files::entries(Path::new("/proc"))
        .into_iter()
        .filter_map(|e| {
            let pid = e.file_name().to_string_lossy().parse::<u32>().ok()?;
            if pid == std::process::id() {
                return None;
            }
            let cwd = fs::read_link(e.path().join("cwd")).ok()?;
            if !paths.iter().any(|p| cwd.starts_with(p)) {
                return None;
            }
            let name = fs::read_to_string(e.path().join("comm")).unwrap_or_default().trim().to_owned();
            Some(json!({"pid":pid,"name":name,"cwd":cwd}))
        })
        .collect()
}
fn guard(paths: &[PathBuf]) -> Result<()> {
    let busy = busy_in(paths);
    if busy.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "In use by {}. Close it first.",
            busy.iter()
                .map(|b| format!("{} (pid {})", b["name"].as_str().unwrap_or("process"), b["pid"]))
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }
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
        if exists(dest) {
            return Err(format!("{} already exists", paths::tilde(dest, &self.env.home)));
        }
        if !exists(src) {
            return Err(format!("{} is gone", paths::tilde(src, &self.env.home)));
        }
        if dest.starts_with(src) {
            return Err("Can't move a folder into itself".into());
        }
        if src.is_dir() {
            guard(&[src.to_owned()])?;
        }
        self.mkdirs(dest.parent().ok_or("Missing parent")?)?;
        self.log(json!({"kind":"move","from":src,"to":dest}))?;
        rename(src, dest)
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
            let replacement = pairs.iter().find_map(|(from, to)| {
                old.strip_prefix(from)
                    .filter(|rest| rest.is_empty() || rest.starts_with('/'))
                    .map(|rest| format!("{to}{rest}"))
            });
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
    fn trash(&mut self, path: &Path) -> Result<()> {
        sidecar::plain_path(path)?;
        if !exists(path) {
            return Ok(());
        }
        guard(&[path.to_owned()])?;
        self.log(json!({"kind":"trash","path":path}))?;
        process::run("gio", &["trash", "--", &path.to_string_lossy()], None, Duration::from_secs(120)).map(|_| ())
    }
}
fn transact(env: &Env, title: &str, work: impl FnOnce(&mut Tx<'_>) -> Result<()>) -> Result<Value> {
    with_lock(env, || {
        let mut tx = Tx::new(env, title)?;
        match work(&mut tx).and_then(|_| {
            tx.journal["state"] = json!("applied");
            tx.save()
        }) {
            Ok(()) => Ok(tx.journal),
            Err(error) => {
                tx.journal["error"] = json!(error);
                match undo_entries(env, tx.journal["entries"].as_array().unwrap()) {
                    Ok(()) => tx.journal["state"] = json!("undone"),
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
                value_path(env, &e[key])?;
            }
        }
        let required: &[&str] = match e["kind"].as_str() {
            Some("move") => &["from", "to"],
            Some("rewrite") => &["path", "backup"],
            Some("file") if e["existed"].as_bool() == Some(true) => &["path", "backup"],
            Some("file") if e["existed"].as_bool() == Some(false) => &["path"],
            Some("mkdir" | "rmdir" | "trash") => &["path"],
            _ => return Err("Unknown or incomplete journal entry".into()),
        };
        for key in required {
            value_path(env, &e[*key])?;
        }
    }
    Ok(())
}
fn undo_entries(env: &Env, entries: &[Value]) -> Result<()> {
    validate_entries(env, entries)?;
    // Refuse collisions before changing any content during undo.
    for e in entries.iter().filter(|e| e["kind"] == "move") {
        let from = value_path(env, &e["from"])?;
        let to = value_path(env, &e["to"])?;
        if exists(&from) && exists(&to) {
            return Err(format!("{} already exists; undo would overwrite it", from.display()));
        }
    }
    for e in entries.iter().rev() {
        match e["kind"].as_str().unwrap_or("") {
            "move" => {
                let from = value_path(env, &e["from"])?;
                let to = value_path(env, &e["to"])?;
                if exists(&to) {
                    if exists(&from) {
                        return Err(format!("{} already exists; undo would overwrite it", from.display()));
                    }
                    fs::create_dir_all(from.parent().ok_or("Missing parent")?).map_err(|e| e.to_string())?;
                    rename(&to, &from)?;
                }
            }
            "rewrite" => {
                let backup = value_path(env, &e["backup"])?;
                let dest = value_path(env, &e["path"])?;
                if exists(&backup) {
                    restore(&backup, &dest)?;
                }
            }
            "file" => {
                let dest = value_path(env, &e["path"])?;
                if e["existed"].as_bool() == Some(true) {
                    restore(&value_path(env, &e["backup"])?, &dest)?;
                } else if exists(&dest) {
                    if !dest.is_file() {
                        return Err("Refusing to remove a folder in file undo".into());
                    }
                    fs::remove_file(dest).map_err(|e| e.to_string())?;
                }
            }
            "mkdir" => {
                let dest = value_path(env, &e["path"])?;
                let _ = fs::remove_dir(dest);
            }
            "rmdir" => {
                fs::create_dir_all(value_path(env, &e["path"])?).map_err(|e| e.to_string())?;
            }
            "trash" => {} // The system trash owns recovery, as in v1.
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
fn read_journal(path: &Path) -> Result<Value> {
    sidecar::plain_path(path)?;
    let file = File::open(path).map_err(|e| e.to_string())?;
    serde_json::from_reader(std::io::BufReader::new(file)).map_err(|e| e.to_string())
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
fn relocated(from: &Path, to: &Path, old: &Path) -> PathBuf {
    let relative = old.strip_prefix(from).expect("validated project prefix");
    if relative.as_os_str().is_empty() { to.to_owned() } else { to.join(relative) }
}

pub fn move_project(env: &Env, snap: &Value, id: &str, dest: &str, opts: &Value) -> Result<Value> {
    let node = &snap["nodes"][id];
    if !node.is_object() {
        return Err("Unknown project. Rescan and try again.".into());
    }
    let src = value_path(env, &node["path"])?;
    let dest = path(env, dest)?;
    if src == env.home || dest == env.home {
        return Err("Can't move the home folder".into());
    }
    if env.data_dir.starts_with(&src) || dest.starts_with(&env.data_dir) {
        return Err("Can't move Laci's own history and journals".into());
    }
    if dest.starts_with(&src) {
        return Err("Can't move a folder into itself".into());
    }
    let title = opts["title"].as_str().map(str::to_owned).unwrap_or_else(|| {
        format!("Move {} → {}", node["name"].as_str().unwrap_or("project"), paths::tilde(&dest, &env.home))
    });
    transact(env, &title, |tx| {
        guard(std::slice::from_ref(&src))?;
        tx.move_to(&src, &dest)?;
        if let Some(claude) = snap["claude"].as_object() {
            for c in claude.values() {
                let Some(old) = c["path"].as_str().map(Path::new).filter(|p| p.starts_with(&src)) else {
                    continue;
                };
                let now = relocated(&src, &dest, old);
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
                        .filter(|s| gone.iter().any(|g| g.as_str() == Some(*s)) && !Path::new(s).starts_with(old))
                        .map(str::to_owned)
                        .collect(),
                );
                let mut pairs = vec![(src.to_string_lossy().into_owned(), dest.to_string_lossy().into_owned())];
                pairs.extend(stale.into_iter().map(|s| (s, now.to_string_lossy().into_owned())));
                for f in jsonl(&target) {
                    tx.rewrite(&f, &pairs, "cwd")?;
                }
            }
        }
        let connectors = snap["connectors"].as_array().cloned().unwrap_or_default();
        let mut moved = std::collections::HashSet::new();
        if let Some(items) = snap["items"].as_object() {
            for item in items.values() {
                let Some(cwd) = item["cwd"].as_str().map(Path::new).filter(|p| p.starts_with(&src)) else {
                    continue;
                };
                let Some(c) = connectors.iter().find(|c| c["id"] == item["connector"]) else {
                    continue;
                };
                let link = &c["link"];
                if link["kind"] == "cwd" {
                    let mut file = value_path(env, &item["file"])?;
                    if file.starts_with(&src) {
                        file = dest.join(file.strip_prefix(&src).unwrap());
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
                    let newcwd = relocated(&src, &dest, cwd);
                    let target =
                        value_path(env, &link["dir"])?.join(crate::agents::store_name(link, &newcwd.to_string_lossy()));
                    tx.merge(&from, &target)?;
                }
                // Inside history travels with the folder. Mention documents retain their original wording.
            }
        }
        if let Some(status) = opts["status"].as_str().filter(|s| !s.is_empty()) {
            tx.sidecar_status(&dest, status)?;
        }
        if opts["trashHeavy"].as_bool() == Some(true) {
            for part in node["size"]["parts"].as_array().into_iter().flatten() {
                let raw = part["path"].as_str().ok_or("Invalid heavy folder")?;
                if Path::new(raw).is_absolute()
                    || Path::new(raw).components().any(|c| matches!(c, std::path::Component::ParentDir))
                {
                    return Err("Invalid heavy folder".into());
                }
                tx.trash(&path(env, &dest.join(raw).to_string_lossy())?)?;
            }
        }
        Ok(())
    })
}
pub fn archive_project(env: &Env, snap: &Value, id: &str, trash_heavy: bool) -> Result<Value> {
    let node = &snap["nodes"][id];
    let src = value_path(env, &node["path"])?;
    let root = snap["roots"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.as_str())
        .filter_map(|r| path(env, r).ok())
        .find(|r| src.starts_with(r))
        .unwrap_or_else(|| src.parent().unwrap_or(&env.home).to_owned());
    let mut parent = src.parent().ok_or("Invalid project")?;
    let dest;
    loop {
        if parent.join("_archive").is_dir() || parent == root || !parent.starts_with(&root) {
            dest = parent.join("_archive").join(src.strip_prefix(parent).map_err(|e| e.to_string())?);
            break;
        }
        parent = parent.parent().ok_or("Invalid archive root")?;
    }
    move_project(
        env,
        snap,
        id,
        &dest.to_string_lossy(),
        &json!({"status":"archived","trashHeavy":trash_heavy,"title":format!("Archive {}",node["name"].as_str().unwrap_or("project"))}),
    )
}
pub fn apply_action(env: &Env, snap: &Value, title: &str, a: &Value) -> Result<Value> {
    if a["type"] == "archive" {
        return archive_project(env, snap, a["nodeId"].as_str().ok_or("Missing project")?, false);
    }
    transact(env, title, |tx| {
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
                    if Path::new(rel).is_absolute()
                        || Path::new(rel).components().any(|c| matches!(c, std::path::Component::ParentDir))
                    {
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
            if connector.is_empty() || connector.contains(['/', '\\']) || connector == ".." {
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
        Ok(json!({"copied":copied,"bytes":bytes,"size":bytes,"dest":dest}))
    })
}
