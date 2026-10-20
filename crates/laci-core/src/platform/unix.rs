//! What Linux and macOS share: the home folder from HOME, settings and cache in the XDG folders, files told apart by
//! device and inode, the `flock` change lock, renames that never replace, links copied as links, and the programs Laci
//! finds, starts and stops.
use super::{Dirs, Identity, Stamp};
use crate::Result;
use rustix::{
    fs::{CWD, FlockOperation, OFlags, RenameFlags, flock, renameat_with},
    process::{Pid, Signal, WaitId, WaitIdOptions, kill_process_group, waitid},
};
use std::{
    ffi::OsStr,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus},
    thread,
    time::Duration,
};

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Settings and cache honour XDG_CONFIG_HOME and XDG_CACHE_HOME; data stays where Laci v1 kept it.
pub fn user_dirs(home: &Path) -> Result<Dirs> {
    let mut dirs = Dirs::inside(home);
    for (key, dest) in [("XDG_CONFIG_HOME", &mut dirs.config), ("XDG_CACHE_HOME", &mut dirs.cache)] {
        if let Some(base) = std::env::var_os(key).map(PathBuf::from).filter(|p| p.is_absolute()) {
            *dest = base.join("laci");
        }
    }
    Ok(dirs)
}

/// Laci v1's names for the device and the inode.
pub const IDENTITY_FIELDS: [&str; 2] = ["device", "inode"];

pub fn identity(_path: &Path, meta: &Metadata) -> Result<Identity> {
    Ok(Identity { volume: meta.dev(), file: meta.ino().into() })
}
pub fn change_stamp(_path: &Path, meta: &Metadata) -> Result<Stamp> {
    Ok(stamp(meta))
}
pub fn file_change_stamp(_file: &File, meta: &Metadata) -> Result<Stamp> {
    Ok(stamp(meta))
}
fn stamp(meta: &Metadata) -> Stamp {
    Stamp {
        identity: Identity { volume: meta.dev(), file: meta.ino().into() },
        modified: (meta.mtime(), meta.mtime_nsec()),
        changed: (meta.ctime(), meta.ctime_nsec()),
    }
}

pub struct Lock {
    file: File,
    path: PathBuf,
}
impl Drop for Lock {
    fn drop(&mut self) {
        if let (Ok(a), Ok(b)) = (self.file.metadata(), fs::symlink_metadata(&self.path))
            && a.dev() == b.dev()
            && a.ino() == b.ino()
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}
pub fn lock(path: PathBuf) -> Result<Lock> {
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
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                super::path::plain_path(&path)?;
                let Ok(mut stale) = OpenOptions::new().read(true).write(true).open(&path) else {
                    continue;
                };
                flock(&stale, FlockOperation::NonBlockingLockExclusive).map_err(|_| busy.to_owned())?;
                let mut pid = String::new();
                stale.read_to_string(&mut pid).map_err(|e| e.to_string())?;
                if let Ok(pid) = pid.trim().parse::<u32>()
                    && pid > 0
                    && super::pid_alive(pid)?
                {
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

pub fn rename_noreplace(src: &Path, dest: &Path) -> io::Result<()> {
    renameat_with(CWD, src, CWD, dest, RenameFlags::NOREPLACE).map_err(io::Error::from)
}

pub fn preserve(meta: &Metadata, dest: &Path) -> Result<()> {
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

/// A link isn't a folder here, so it is unlinked and nothing it leads to is touched.
pub fn remove_all(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}

pub fn copy_link(src: &Path, dest: &Path) -> Result<()> {
    std::os::unix::fs::symlink(fs::read_link(src).map_err(|e| e.to_string())?, dest).map_err(|e| e.to_string())
}

/// Nothing holds a file here in a way that a moment's wait would end.
pub fn retry<T>(mut step: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    step()
}

pub fn explain(error: &io::Error, _paths: &[&Path]) -> String {
    error.to_string()
}

/// Links that pnpm makes lead to their target by a relative path, so they move along with the folder.
pub fn move_notes(_from: &Path, _to: &Path) -> Vec<(&'static str, &'static str)> {
    Vec::new()
}

/// O_NOFOLLOW refuses a link, and O_NONBLOCK keeps a FIFO from blocking the open.
pub fn open_nofollow(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).custom_flags((OFlags::NOFOLLOW | OFlags::NONBLOCK).bits() as i32).open(path)
}

pub fn which(program: &str, path: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|p| p.join(program))
        .find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

pub fn exited(child: &mut Child) -> Result<bool> {
    let options = WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT;
    Ok(waitid(WaitId::Pid(Pid::from_child(child)), options).map_err(|e| e.to_string())?.is_some())
}

pub struct Group {
    child: Child,
    leader: Pid,
}
pub fn spawn_group(mut command: Command) -> io::Result<Group> {
    let child = command.process_group(0).spawn()?;
    let leader = Pid::from_raw(child.id() as i32).ok_or_else(|| io::Error::other("Invalid generator process"))?;
    Ok(Group { child, leader })
}
impl Group {
    pub fn exited(&mut self) -> Result<bool> {
        exited(&mut self.child)
    }
    pub fn stop(&mut self) {
        let _ = kill_process_group(self.leader, Signal::TERM);
        thread::sleep(Duration::from_millis(150));
        let _ = kill_process_group(self.leader, Signal::KILL);
    }
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }
}
