//! What differs between Linux, macOS and Windows. The rest of Laci calls these functions and types, never the OS
//! itself. What isn't written for an OS yet fails there with a plain message instead of guessing, so a change Laci
//! can't check is refused.
//!
//! `linux`, `macos` and `windows` each answer every call here; `unix` holds what Linux and macOS share, and `path`
//! the rules for paths.
use crate::Result;
use serde_json::{Value, json};
use std::{
    ffi::{OsStr, OsString},
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

/// Gives `dest` the permissions and the access and modification times in `meta`. On Windows the permissions are the
/// read-only attribute, and the creation time comes along too.
pub fn preserve(meta: &Metadata, dest: &Path) -> Result<()> {
    os::preserve(meta, dest)
}

/// Removes `path`, and in a folder everything in it. A link is removed itself, never what it leads to. On Windows a
/// read-only file goes too, also on FAT32 and exFAT, as on USB sticks, where std's delete refuses one.
pub fn remove_all(path: &Path) -> io::Result<()> {
    os::remove_all(path)
}

/// Runs `step`, a change to files such as a rename, a copy or a removal. On Windows it tries again for about two
/// seconds while another program, such as an antivirus scan, Search or OneDrive, holds the file for a moment.
/// Elsewhere it runs once.
pub fn retry<T>(step: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    os::retry(step)
}

/// What the user is told when changing `path` failed with `error`. On Windows it says what to do, such as closing the
/// program that has the file open; elsewhere it is the system's message.
pub fn explain(error: &io::Error, path: &Path) -> String {
    os::explain(error, path)
}

/// What else comes with moving the folder `from` to `to`, for the move's preview, as a label and a detail each: on
/// Windows, links in node_modules that keep leading to the old place and a move into or out of OneDrive.
pub fn move_notes(from: &Path, to: &Path) -> Vec<(&'static str, &'static str)> {
    os::move_notes(from, to)
}

/// Whether a file manager hides the file `name`: a name that starts with a dot, and on macOS and Windows a file the
/// system marks hidden, such as ~/Library or AppData. `meta` is the file's own, as a folder listing reads it.
pub fn hidden(name: &OsStr, meta: Option<&Metadata>) -> bool {
    name.as_encoded_bytes().starts_with(b".") || meta.is_some_and(os::hidden_flag)
}

/// Whether the file stands in for one in the cloud, as OneDrive and iCloud leave files that are only online: its
/// content isn't on this computer, and reading it would download it.
pub fn placeholder(meta: &Metadata) -> bool {
    os::placeholder(meta)
}

/// Whether a folder in the home folder named `name` holds the system's or apps' own files rather than projects, such
/// as ~/Library and apps on macOS or AppData on Windows. Folder suggestions and a scan of home don't look inside,
/// which on macOS would also ask for access to other apps' data.
pub fn system_folder(name: &OsStr) -> bool {
    os::system_folder(name)
}

/// Opens the file `path` for reading, but not through a link in its last name, even one put there after the file was
/// listed: a link fails to open. A FIFO doesn't block the open.
pub fn open_nofollow(path: &Path) -> io::Result<File> {
    os::open_nofollow(path)
}

/// The computer's name: on Linux what /etc/hostname says, as Laci v1 read it, elsewhere what the system reports.
pub fn host_name() -> Option<String> {
    os::host_name()
}

/// Makes `dest` a link to where the link `src` leads, as a copy of a folder keeps its links.
pub fn copy_link(src: &Path, dest: &Path) -> Result<()> {
    os::copy_link(src, dest)
}

/// Where `path`, a list of folders as in PATH, finds the program `program`: the first folder with it as a file that
/// can run. On Windows the name may also end in one of PATHEXT's extensions, and only a program (.exe, .com) or a
/// batch file (.cmd, .bat) counts, in a folder named with its drive.
pub fn which(program: &str, path: &OsStr) -> Option<PathBuf> {
    os::which(program, path)
}

/// What starts `program` with `args`, found on `path`. Linux starts a program by name, as it always has; so does
/// macOS, apart from the stand-in Git that asks to install Apple's Command Line Tools (see `git`). Windows starts the
/// file [`which`] finds: a shim npm, pnpm or yarn wrote as node with its script, and any other batch file only with
/// arguments cmd.exe can't read as a command.
pub fn program(program: &str, args: Vec<OsString>, path: &OsStr) -> Result<(PathBuf, Vec<OsString>)> {
    #[cfg(target_os = "linux")]
    {
        let _ = path;
        Ok((program.into(), args))
    }
    #[cfg(not(target_os = "linux"))]
    {
        os::program(program, args, path)
    }
}

/// The PATH the programs Laci starts get in place of Laci's own, where that isn't the user's: macOS gives an app
/// started from the Dock launchd's short one, so there it is the one the user's login shell sets up, taken once.
/// `None` elsewhere.
pub fn child_path() -> Option<OsString> {
    #[cfg(target_os = "macos")]
    {
        Some(os::login_path())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// The PATH a terminal gets on macOS, the one the user's login shell sets up, without the folders [`child_path`] adds
/// to it: where the command line tool's folder must be for typing `laci` to work. Empty when the login shell couldn't
/// tell. `None` elsewhere.
pub fn shell_path() -> Option<OsString> {
    #[cfg(target_os = "macos")]
    {
        Some(os::shell_path())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// The Git that macOS starts when `path` is the PATH: the first one there, except that the stand-in /usr/bin/git
/// counts only while `xcode_select -p` names the developer folder Apple's Command Line Tools or Xcode put in place.
/// Without them it would ask the user to install them, from a scan. [`program`] asks /usr/bin/xcode-select.
#[cfg(target_os = "macos")]
pub fn git(path: &OsStr, xcode_select: &Path) -> Result<PathBuf> {
    os::git(path, xcode_select)
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

/// Moves `path` to the system's bin ([`BIN`]), where the user can restore it. Where it can't go there, it stays where
/// it is and this fails: nothing is deleted for good.
pub fn trash(path: &Path) -> Result<()> {
    os::trash(path)
}

/// The system's bin, in the words the UI uses for it too (`BIN` in ui/src/dialogs.tsx).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bin {
    /// At the start of a sentence: "System Trash", on Windows "Recycle Bin".
    pub name: &'static str,
    /// Inside a sentence: "system Trash", on Windows "the Recycle Bin".
    pub bare: &'static str,
}

/// Where [`trash`] moves things: the Trash on Linux and macOS, the Recycle Bin on Windows.
pub const BIN: Bin = if cfg!(windows) {
    Bin { name: "Recycle Bin", bare: "the Recycle Bin" }
} else {
    Bin { name: "System Trash", bare: "system Trash" }
};

/// Opens a file, a folder or a web address in the app the system picks for it, started in `cwd` (on Windows in
/// Laci's own working folder), without waiting for that app.
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

/// Starts `program` with the plain words `args` (no spaces or quotes), working in `dir`, in a process group of its own
/// so that Ctrl+C here doesn't reach it, and returns without waiting for it. It gets nothing of this process's input
/// and output, so a caller that reads everything this process prints, as an agent's shell reads a command's output,
/// is done once this process exits, however long that program runs. On Windows it gets none of this process's handles
/// at all, nor a console; elsewhere its input and output are /dev/null.
pub fn start_detached(program: &Path, args: &[&str], dir: &Path) -> io::Result<()> {
    if args.iter().any(|arg| arg.is_empty() || arg.contains(|c: char| c == '"' || c.is_whitespace())) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "An argument there must be a plain word"));
    }
    #[cfg(windows)]
    {
        os::start_detached(program, args, dir)
    }
    #[cfg(unix)]
    {
        use std::{os::unix::process::CommandExt, process::Stdio};
        let mut command = Command::new(program);
        command.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        command.process_group(0).spawn().map(drop)
    }
}

/// Puts the folder `dir` on the user's Path, or takes it off, as Windows keeps the Path in the registry: Laci's
/// installer puts the console program's folder there with `laci __path add`, and the uninstaller takes it off. Answers
/// whether the Path changed. Only Windows keeps such a Path; elsewhere this fails.
pub fn edit_user_path(dir: &Path, add: bool) -> Result<bool> {
    #[cfg(windows)]
    {
        os::edit_user_path(dir, add)
    }
    #[cfg(not(windows))]
    {
        let _ = (dir, add);
        Err("Only Windows keeps a Path for Laci's installer to change".into())
    }
}

/// The longest value Windows gives an environment variable, in UTF-16 units.
const PATH_LIMIT: usize = 32_767;

/// The user's Path, `path` as Windows keeps it, with the folder `dir` added at its end; None when `dir` is on it
/// already, in any case and with or without a trailing backslash or quotes. Every entry stays as it was written,
/// %VARIABLES% unexpanded, and a Path that ends in `;`, as Windows' own does, still ends in one, so [`path_without`]
/// gives back exactly what was there. A folder whose name holds `;`, `"` or `%` is refused: Windows would split it, or
/// read a variable in it.
pub fn path_with(path: &str, dir: &str) -> Result<Option<String>> {
    if dir.is_empty() {
        return Err("Laci can't put a folder without a name on the Path".into());
    }
    if dir.contains([';', '"', '%']) {
        return Err(format!("Laci can't put {dir} on the Path: a folder there can't hold ; \" or %"));
    }
    let same = |entry: &str| {
        let plain = |text: &str| text.trim().trim_matches('"').trim_end_matches(['\\', '/']).to_lowercase();
        !entry.trim().is_empty() && plain(entry) == plain(dir)
    };
    if path.split(';').any(same) {
        return Ok(None);
    }
    let edited = if path.is_empty() {
        dir.to_owned()
    } else if path.ends_with(';') {
        format!("{path}{dir};")
    } else {
        format!("{path};{dir}")
    };
    if edited.encode_utf16().count() > PATH_LIMIT {
        return Err("The user's Path would grow longer than Windows allows, so Laci left it as it was".into());
    }
    Ok(Some(edited))
}

/// `path` without the entries that are exactly `dir`, as [`path_with`] added it; None when there is none. Every other
/// entry stays as it was written, also one that names the same folder another way, which Laci didn't add.
pub fn path_without(path: &str, dir: &str) -> Option<String> {
    let entries: Vec<&str> = path.split(';').collect();
    let kept: Vec<&str> = entries.iter().copied().filter(|entry| dir.is_empty() || *entry != dir).collect();
    (kept.len() != entries.len()).then(|| kept.join(";"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LACI: &str = r"C:\Users\me\AppData\Local\Laci\bin";

    #[test]
    fn the_installer_adds_its_folder_to_the_path_once_and_keeps_the_rest_as_written() {
        let with = |path: &str| path_with(path, LACI).unwrap();
        assert_eq!(with(""), Some(LACI.to_owned()), "no Path yet");
        assert_eq!(with(r"C:\Tools"), Some(format!(r"C:\Tools;{LACI}")));
        // Windows' own user Path ends in a ;, and keeps ending in one.
        let windows = r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;";
        assert_eq!(with(windows), Some(format!("{windows}{LACI};")));
        assert_eq!(with(r"C:\Tools;;D:\bin;"), Some(format!(r"C:\Tools;;D:\bin;{LACI};")));
        // There already, however it is written.
        for there in [
            LACI.to_owned(),
            format!(r"C:\Tools;{LACI};D:\bin"),
            format!(r"C:\Tools;{}", LACI.to_uppercase()),
            format!(r"{}\;C:\Tools", LACI.to_lowercase()),
            format!(r"C:\Tools;{LACI}\\"),
            format!(r#"C:\Tools;"{LACI}""#),
            format!(r"C:\Tools; {LACI} "),
        ] {
            assert_eq!(with(&there), None, "{there}");
        }
        // %VARIABLES% stay unexpanded, and an entry spelled with one is the user's own.
        let profile = r"%USERPROFILE%\.cargo\bin;%USERPROFILE%\AppData\Local\Laci\bin;%LOCALAPPDATA%\Programs\x";
        assert_eq!(with(profile), Some(format!("{profile};{LACI}")));
        // Windows would split the folder at a ; and read a variable in a %.
        for refused in ["", r"C:\a;b\bin", r"C:\100%\bin", r#"C:\"x"\bin"#] {
            assert!(path_with(r"C:\Tools", refused).is_err(), "{refused}");
        }
        let long = "x".repeat(PATH_LIMIT - LACI.len() - 1);
        assert_eq!(path_with(&long, LACI).unwrap().map(|path| path.len()), Some(PATH_LIMIT));
        assert!(path_with(&format!("{long}x"), LACI).is_err(), "longer than Windows allows");
        // UTF-16 units count, not bytes: each 雨 is one.
        assert!(path_with(&"雨".repeat(PATH_LIMIT - LACI.len() - 1), LACI).unwrap().is_some());
    }

    #[test]
    fn the_uninstaller_takes_off_only_the_entry_the_installer_added() {
        let without = |path: &str| path_without(path, LACI);
        assert_eq!(without(LACI), Some(String::new()));
        assert_eq!(without(&format!(r"C:\Tools;{LACI}")), Some(r"C:\Tools".to_owned()));
        assert_eq!(without(&format!(r"{LACI};C:\Tools")), Some(r"C:\Tools".to_owned()));
        assert_eq!(without(&format!(r"C:\Tools;{LACI};D:\bin;")), Some(r"C:\Tools;D:\bin;".to_owned()));
        assert_eq!(without(&format!(r"C:\Tools;{LACI};;{LACI}")), Some(r"C:\Tools;".to_owned()), "each copy");
        assert_eq!(without(""), None);
        assert_eq!(without(r"C:\Tools;D:\bin"), None);
        // Another spelling of the folder, or one with a %VARIABLE%, is the user's own and stays.
        for kept in [
            format!(r"C:\Tools;{}", LACI.to_uppercase()),
            format!(r"C:\Tools;{LACI}\"),
            r"C:\Tools;%USERPROFILE%\AppData\Local\Laci\bin".to_owned(),
            format!(r"C:\Tools;{LACI}2"),
        ] {
            assert_eq!(without(&kept), None, "{kept}");
        }
        let profile = format!(r"%USERPROFILE%\.cargo\bin;{LACI};%LOCALAPPDATA%\x");
        assert_eq!(without(&profile), Some(r"%USERPROFILE%\.cargo\bin;%LOCALAPPDATA%\x".to_owned()));
        assert_eq!(path_without(r"C:\Tools;;D:\bin", ""), None, "an empty folder names no entry");
    }

    #[test]
    fn installing_and_uninstalling_gives_back_the_path_as_it_was() {
        for path in [
            "",
            ";",
            r"C:\Tools",
            r"C:\Tools;",
            r"C:\Tools;;",
            r";C:\Tools",
            r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;",
            r"%USERPROFILE%\.cargo\bin;C:\Program Files\Git\cmd",
        ] {
            let with = path_with(path, LACI).unwrap().unwrap();
            assert_eq!(path_without(&with, LACI).as_deref(), Some(path), "{path:?}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn only_windows_keeps_a_path_for_the_installer() {
        assert!(edit_user_path(Path::new("/opt/laci/bin"), true).is_err());
        assert!(edit_user_path(Path::new("/opt/laci/bin"), false).is_err());
    }
}
