//! Linux, where Laci has run since v1. Processes are read from /proc, the Trash is gio's, files open with xdg-open,
//! and settings and cache follow the XDG folders.
pub use super::unix::{
    Group, Lock, change_stamp, exited, file_change_stamp, home_dir, identity, lock, preserve, rename_noreplace,
    spawn_group,
};
use super::{Apps, Dirs, Holder};
use crate::{Result, files};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

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

pub fn pid_alive(pid: u32) -> Result<bool> {
    Ok(Path::new("/proc").join(pid.to_string()).exists())
}

pub fn processes_in(paths: &[PathBuf]) -> Result<Vec<Holder>> {
    Ok(files::entries(Path::new("/proc"))
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
            // A process that is gone by now no longer holds the folder.
            let name = fs::read_to_string(e.path().join("comm")).ok()?.trim().to_owned();
            Some(Holder { pid, name, cwd })
        })
        .collect())
}

pub fn ensure_idle(sources: &[PathBuf]) -> Result<()> {
    for process in fs::read_dir("/proc").map_err(|_| "Could not check running history writers".to_owned())? {
        let process = process.map_err(|e| e.to_string())?;
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
