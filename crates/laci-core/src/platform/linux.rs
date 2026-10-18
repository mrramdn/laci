//! Linux, where Laci has run since v1. Processes are read from /proc, the Trash is gio's, files open with xdg-open,
//! and settings and cache follow the XDG folders.
pub use super::unix::{
    Group, IDENTITY_FIELDS, Lock, change_stamp, copy_link, exited, file_change_stamp, home_dir, identity, lock,
    preserve, rename_noreplace, spawn_group, user_dirs, which,
};
pub use super::unix::{explain, move_notes, open_nofollow, retry};
use super::{Apps, Holder};
use crate::Result;
use std::{
    ffi::OsStr,
    fs::{self, Metadata},
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};

const PROC: &str = "/proc";

/// Linux marks no file hidden besides its name, and keeps every file's content on the computer.
pub fn hidden_flag(_meta: &Metadata) -> bool {
    false
}
pub fn placeholder(_meta: &Metadata) -> bool {
    false
}
/// The home folder holds no folder of the system's own, beside the dotted ones that are hidden anyway.
pub fn system_folder(_name: &OsStr) -> bool {
    false
}
pub fn host_name() -> Option<String> {
    let mut name = String::new();
    fs::File::open("/etc/hostname").ok()?.take(256).read_to_string(&mut name).ok()?;
    Some(name)
}

/// What `proc` lists, sorted by name. None when it can't be listed or doesn't list this process, as where it isn't
/// mounted or a sandbox puts an empty folder there: that is no list of what runs, and nothing may pass as unused.
fn listed(proc: &Path) -> Option<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(proc).ok()?.collect::<io::Result<Vec<_>>>().ok()?;
    entries.sort_by_key(|e| e.file_name());
    let me = std::process::id().to_string();
    entries.iter().any(|e| e.file_name() == me.as_str()).then_some(entries)
}

pub fn pid_alive(pid: u32) -> Result<bool> {
    alive_at(Path::new(PROC), pid)
}

/// A /proc without this process can't tell a process that is gone from one it doesn't show.
fn alive_at(proc: &Path, pid: u32) -> Result<bool> {
    if proc.join(pid.to_string()).exists() {
        return Ok(true);
    }
    if !proc.join(std::process::id().to_string()).exists() {
        return Err("Could not check whether a process is still running".into());
    }
    Ok(false)
}

pub fn processes_in(paths: &[PathBuf]) -> Result<Vec<Holder>> {
    processes_at(Path::new(PROC), paths)
}

fn processes_at(proc: &Path, paths: &[PathBuf]) -> Result<Vec<Holder>> {
    Ok(listed(proc)
        .ok_or("Could not check which programs are using this folder")?
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
            // A process that is gone by now no longer holds the folder. The kernel cuts the name at 15 bytes, even
            // inside a character, so it is read as bytes: a name that isn't UTF-8 must not hide the process.
            let name = String::from_utf8_lossy(&fs::read(e.path().join("comm")).ok()?).trim().to_owned();
            Some(Holder { pid, name, cwd })
        })
        .collect())
}

pub fn ensure_idle(sources: &[PathBuf]) -> Result<()> {
    idle_at(Path::new(PROC), sources)
}

fn idle_at(proc: &Path, sources: &[PathBuf]) -> Result<()> {
    for process in listed(proc).ok_or("Could not check running history writers")? {
        if process.file_name().to_string_lossy().parse::<u32>().is_err() {
            continue;
        }
        if fs::read_link(process.path().join("cwd")).is_ok_and(|cwd| sources.iter().any(|p| cwd.starts_with(p))) {
            return Err("History is in use by a running process. Close it first.".into());
        }
        let Ok(fds) = fs::read_dir(process.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = fs::read_link(fd.path()) else {
                continue;
            };
            if !sources.iter().any(|p| target.starts_with(p)) {
                continue;
            }
            let info = fs::read_to_string(process.path().join("fdinfo").join(fd.file_name()))
                .map_err(|_| "Could not verify a process using this history".to_owned())?;
            let flags = info
                .lines()
                .find_map(|l| l.strip_prefix("flags:").and_then(|n| u32::from_str_radix(n.trim(), 8).ok()))
                .ok_or("Could not verify a process using this history")?;
            if flags & 3 != 0 {
                return Err("History has an open writer. Stop the session before cleaning it up.".into());
            }
        }
    }
    Ok(())
}

pub fn trash(path: &Path) -> Result<()> {
    crate::process::run("gio", &["trash", "--", &path.to_string_lossy()], None, Duration::from_secs(120)).map(|_| ())
}

pub fn open(target: &str, cwd: &Path) -> Result<()> {
    crate::service::detach("xdg-open", &[target.into()], cwd)
}

pub const DEFAULT_APPS: Apps = Apps { terminal: "kitty", editor: "code", files: "dolphin" };

pub const KNOWN_APPS: [(&str, &[&str]); 3] = [
    (
        "terminal",
        &["kitty", "konsole", "alacritty", "wezterm", "foot", "ghostty", "gnome-terminal", "xfce4-terminal", "xterm"],
    ),
    ("editor", &["code", "cursor", "zed", "codium", "windsurf", "subl", "kate", "gnome-text-editor"]),
    ("files", &["dolphin", "nautilus", "thunar", "nemo", "pcmanfm", "caja"]),
];

/// Desktop terminal transports receive executable + argv directly. xfce accepts a
/// single command string, so only that boundary uses POSIX quoting (never eval).
pub fn terminal_args(
    app: &str,
    cwd: &Path,
    executable: &str,
    argv: &[String],
    quote: fn(&str) -> String,
) -> Result<Vec<String>> {
    let cwd = cwd.to_string_lossy().into_owned();
    let mut args: Vec<String> = match app {
        "kitty" => vec!["--directory".into(), cwd, "--".into()],
        "konsole" => vec!["--workdir".into(), cwd, "-e".into()],
        "alacritty" => vec!["--working-directory".into(), cwd, "-e".into()],
        "wezterm" => vec!["start".into(), "--cwd".into(), cwd, "--".into()],
        "gnome-terminal" => vec![format!("--working-directory={cwd}"), "--".into()],
        "foot" => vec![format!("--working-directory={cwd}"), "--".into()],
        "ghostty" => vec![format!("--working-directory={cwd}"), "-e".into()],
        "xterm" => vec!["-e".into()],
        "xfce4-terminal" => {
            return Ok(vec![
                format!("--working-directory={cwd}"),
                format!(
                    "--command={}",
                    std::iter::once(executable)
                        .chain(argv.iter().map(String::as_str))
                        .map(quote)
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
            ]);
        }
        _ => return Err("Choose a supported external terminal in Settings".into()),
    };
    args.push(executable.into());
    args.extend(argv.iter().cloned());
    Ok(args)
}

/// A command runs through bash's login shell, then the user's shell stays open in the terminal.
pub fn terminal_script_args(app: &str, cwd: &Path, cmd: Option<&str>, confirm: bool) -> Result<Vec<String>> {
    let d = cwd.to_string_lossy().into_owned();
    let mut args = match app {
        "kitty" => vec!["--directory".into(), d],
        "konsole" => vec!["--workdir".into(), d],
        "alacritty" => vec!["--working-directory".into(), d],
        "wezterm" => vec!["start".into(), "--cwd".into(), d],
        _ => Vec::new(),
    };
    if let Some(cmd) = cmd {
        args.push(if app == "wezterm" || app == "gnome-terminal" { "--" } else { "-e" }.into());
        let script = if confirm {
            "printf '$ %s\\n' \"$0\"; read -r -p 'Press Enter to run, Ctrl+C to cancel ' _ && eval \"$0\"; exec \"${SHELL:-bash}\""
        } else {
            "eval \"$0\"; exec \"${SHELL:-bash}\""
        };
        args.extend(["bash".into(), "-lc".into(), script.into(), cmd.into()]);
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where /proc isn't mounted, or a sandbox puts an empty folder there, nothing is found running; the checks
    /// refuse instead of answering "not in use".
    #[test]
    fn a_proc_that_does_not_list_this_process_answers_nothing() {
        let empty = tempfile::tempdir().unwrap();
        let everywhere = [PathBuf::from("/")];
        for proc in [Path::new("/no/proc/here"), empty.path()] {
            let error = processes_at(proc, &everywhere).unwrap_err();
            assert_eq!(error, "Could not check which programs are using this folder");
            let error = idle_at(proc, &everywhere).unwrap_err();
            assert_eq!(error, "Could not check running history writers");
            assert!(alive_at(proc, 1).is_err(), "{}", proc.display());
        }
        let proc = Path::new(PROC);
        assert!(processes_at(proc, &everywhere).is_ok());
        idle_at(proc, &[empty.path().to_owned()]).unwrap();
        assert!(alive_at(proc, std::process::id()).unwrap());
        assert!(!alive_at(proc, u32::MAX).unwrap());
    }
}
