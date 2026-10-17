//! What differs between Linux, macOS and Windows. The rest of Laci calls these functions and types, never the OS
//! itself. What isn't written for an OS yet fails there with a plain message instead of guessing, so a change Laci
//! can't check is refused.
//!
//! `linux`, `macos` and `windows` each answer every call here; `unix` holds what Linux and macOS share, and `path`
//! the rules for paths.
use crate::Result;
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    fs::{File, Metadata},
    io,
    path::{Path, PathBuf},
    process::{Child, Command},
};

pub mod path;

#[cfg(unix)]
mod unix;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as os;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as os;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as os;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
compile_error!("Laci runs on Linux, macOS and Windows");

/// A program started by [`spawn_group`] at the head of its own group of processes, so stopping the group stops what
/// the program started too. `exited` tells whether the program has finished, and leaves it unreaped so its process
/// id can't go to another process while the group is stopped; `stop` stops every process in the group, and `wait`
/// reaps the program.
pub use os::Group;
/// Holds the change lock from [`lock`] until dropped.
pub use os::Lock;

/// Where Laci keeps its settings, its data (journals, Undo copies, the history backup) and its cache.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dirs {
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
}
impl Dirs {
    /// The folders inside `home` where Laci v1 kept them. `LACI_HOME`, demos and tests use these on every OS.
    pub fn inside(home: &Path) -> Self {
        Self {
            config: home.join(".config").join("laci"),
            data: home.join(".local").join("share").join("laci"),
            cache: home.join(".cache").join("laci"),
        }
    }
}

/// Which file a path names: the same for every path to that file, and different for any other file that exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Identity {
    /// The device or volume that holds the file.
    pub volume: u64,
    /// The file on that volume: its inode, or on Windows its 128-bit file ID.
    pub file: u128,
}
impl Identity {
    /// The file number as JSON: a number, as Laci v1 wrote inodes, and text when it needs more than 64 bits, as a
    /// file ID on ReFS can.
    pub fn file_json(&self) -> Value {
        u64::try_from(self.file).map_or_else(|_| Value::from(self.file.to_string()), Value::from)
    }
    /// The file number [`Identity::file_json`] wrote, if `value` is one.
    pub fn file_from_json(value: &Value) -> Option<u128> {
        match value {
            Value::String(text) => text.parse().ok().filter(|file| u64::try_from(*file).is_err()),
            value => value.as_u64().map(u128::from),
        }
    }
    /// The identity as config.json keeps it for a scan location: `{"device", "inode"}` on Linux and macOS, as Laci
    /// v1 wrote it, and `{"volume", "file"}` on Windows.
    pub fn to_json(&self) -> Value {
        let [volume, file] = os::IDENTITY_FIELDS;
        json!({volume: self.volume, file: self.file_json()})
    }
    /// Whether `recorded`, as [`Identity::to_json`] wrote it, names this file.
    pub fn matches(&self, recorded: &Value) -> bool {
        let [volume, file] = os::IDENTITY_FIELDS;
        recorded[volume].as_u64() == Some(self.volume) && Self::file_from_json(&recorded[file]) == Some(self.file)
    }
}

/// When a file last changed, as exactly as the OS records it, in seconds and nanoseconds. Writing moves `modified`;
/// writing, a new owner or mode, or another file put in its place moves `changed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Stamp {
    pub identity: Identity,
    pub modified: (i64, i64),
    pub changed: (i64, i64),
}

/// A process working inside a folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Holder {
    pub pid: u32,
    /// The program's name as the OS reports it, such as `git`.
    pub name: String,
    /// Its working folder.
    pub cwd: PathBuf,
}

/// The programs Laci starts as the terminal, the editor and the file manager.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Apps {
    pub terminal: &'static str,
    pub editor: &'static str,
    pub files: &'static str,
}

/// The signed-in user's home folder, as the OS gives it.
pub fn home_dir() -> Option<PathBuf> {
    os::home_dir()
}

/// Where Laci keeps its files for the user whose home is `home`, following that user's settings for such folders.
pub fn user_dirs(home: &Path) -> Result<Dirs> {
    os::user_dirs(home)
}

/// Which file `path` names. `meta` is what std read for `path` just before, with or without following a link; where
/// it already holds the answer, nothing is read again.
pub fn identity(path: &Path, meta: &Metadata) -> Result<Identity> {
    os::identity(path, meta)
}

/// When the file `path` names last changed. `meta` as for [`identity`].
pub fn change_stamp(path: &Path, meta: &Metadata) -> Result<Stamp> {
    os::change_stamp(path, meta)
}

/// [`change_stamp`] for a file that is open. `meta` is what std read from it just before.
pub fn file_change_stamp(file: &File, meta: &Metadata) -> Result<Stamp> {
    os::file_change_stamp(file, meta)
}

/// Takes the change lock in the file at `path`, which Laci v1 reads too on Linux: one window, command or agent changes
/// files at a time. While another holds it, this fails at once with a message for the user.
pub fn lock(path: PathBuf) -> Result<Lock> {
    os::lock(path)
}

/// Whether process `pid` is still running.
pub fn pid_alive(pid: u32) -> Result<bool> {
    os::pid_alive(pid)
}

/// Renames `src` to `dest`, and fails if `dest` exists. On another device it fails with
/// [`io::ErrorKind::CrossesDevices`] and changes nothing: copying instead is up to the caller.
pub fn rename_noreplace(src: &Path, dest: &Path) -> io::Result<()> {
    os::rename_noreplace(src, dest)
}

/// Gives `dest` the permissions and the access and modification times in `meta`.
pub fn preserve(meta: &Metadata, dest: &Path) -> Result<()> {
    os::preserve(meta, dest)
}

/// Makes `dest` a link to where the link `src` leads, as a copy of a folder keeps its links.
pub fn copy_link(src: &Path, dest: &Path) -> Result<()> {
    os::copy_link(src, dest)
}

/// Where `path`, a list of folders as in PATH, finds the program `program`: the first folder with it as a file that
/// can run. On Windows the name may also end in one of PATHEXT's extensions.
pub fn which(program: &str, path: &OsStr) -> Option<PathBuf> {
    os::which(program, path)
}

/// Whether `child`, a program Laci started, has finished. It stays unreaped, so its process id can't go to another
/// process while Laci still counts the child as its own.
pub fn exited(child: &mut Child) -> Result<bool> {
    os::exited(child)
}

/// Starts `command` at the head of a new group of processes. See [`Group`].
pub fn spawn_group(command: Command) -> io::Result<Group> {
    os::spawn_group(command)
}

/// The processes other than this one whose working folder is one of `paths` or inside one.
pub fn processes_in(paths: &[PathBuf]) -> Result<Vec<Holder>> {
    os::processes_in(paths)
}

/// Fails while a process works inside `sources` or has a file there open for writing, and when that can't be checked.
pub fn ensure_idle(sources: &[PathBuf]) -> Result<()> {
    os::ensure_idle(sources)
}

/// Moves `path` to the system Trash, where the user can restore it.
pub fn trash(path: &Path) -> Result<()> {
    os::trash(path)
}

/// Opens a file, a folder or a web address in the app the system picks for it, started in `cwd`, without waiting for
/// that app.
pub fn open(target: &str, cwd: &Path) -> Result<()> {
    os::open(target, cwd)
}

/// The apps Laci starts until the user picks others in Settings.
pub const DEFAULT_APPS: Apps = os::DEFAULT_APPS;

/// For each kind of app (`terminal`, `editor`, `files`), the programs Laci knows how to start, most common first.
pub const KNOWN_APPS: [(&str, &[&str]); 3] = os::KNOWN_APPS;

/// The arguments that open terminal `app` in `cwd`, running `executable` with `argv` passed on as they are. A
/// terminal that takes one command line instead gets them joined, each made one word by `quote`.
pub fn terminal_args(
    app: &str,
    cwd: &Path,
    executable: &str,
    argv: &[String],
    quote: fn(&str) -> String,
) -> Result<Vec<String>> {
    os::terminal_args(app, cwd, executable, argv, quote)
}

/// The arguments that open terminal `app` in `cwd` running the shell command `cmd`, then a shell. With `confirm`, the
/// terminal shows the command and runs it only after Enter. Without a command it only opens.
pub fn terminal_script_args(app: &str, cwd: &Path, cmd: Option<&str>, confirm: bool) -> Result<Vec<String>> {
    os::terminal_script_args(app, cwd, cmd, confirm)
}
