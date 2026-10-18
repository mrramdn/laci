//! Finding programs on macOS. An app started from the Dock gets launchd's PATH, /usr/bin:/bin:/usr/sbin:/sbin, which
//! leaves out Homebrew, the agents' own installers and Node's version managers, so the programs Laci starts get the
//! PATH the user's login shell sets up. And /usr/bin/git only stands in for Git: until Apple's Command Line Tools are
//! installed it asks to install them, which a scan must never make it do.
use crate::{Result, process};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

/// Where tools often sit that a login shell may still leave out: Homebrew's on Apple silicon and on Intel, and the
/// folders the Claude Code installer, Volta and Bun put programs in.
const KNOWN: [&str; 5] = ["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin", "~/.volta/bin", "~/.bun/bin"];

/// Taken the first time a program starts.
static PATH: LazyLock<OsString> = LazyLock::new(|| {
    // With a terminal, Laci was started from a shell and has its PATH already. An interactive shell would also take
    // that terminal over from the program in it, such as the agent that started `laci mcp`.
    let probed = if std::fs::OpenOptions::new().read(true).write(true).open("/dev/tty").is_ok() {
        None
    } else {
        let shell = std::env::var_os("SHELL").map(PathBuf::from).filter(|shell| shell.is_absolute());
        process::login_shell_path(&shell.unwrap_or_else(|| "/bin/zsh".into()), Duration::from_secs(3))
    };
    merged(probed, std::env::var_os("PATH"), super::home_dir())
});

pub fn login_path() -> OsString {
    PATH.clone()
}

/// The folders of `probed`, then those of `inherited`, then the [`KNOWN`] ones that exist, each once. A folder named
/// relative to the working folder is left out, since a project folder would then hold programs Laci starts.
fn merged(probed: Option<OsString>, inherited: Option<OsString>, home: Option<PathBuf>) -> OsString {
    let known = KNOWN
        .iter()
        .filter_map(|dir| match dir.strip_prefix("~/") {
            Some(rest) => Some(home.as_ref()?.join(rest)),
            None => Some(PathBuf::from(dir)),
        })
        .filter(|dir| dir.is_dir());
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in probed.iter().chain(&inherited).flat_map(|path| std::env::split_paths(path)).chain(known) {
        // A ':' would split the folder in two.
        if dir.is_absolute() && !dir.as_os_str().as_encoded_bytes().contains(&b':') && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// The stand-in Git, which works only once Apple's Command Line Tools or Xcode are installed.
const STAND_IN: &str = "/usr/bin/git";
/// Names the developer folder those put in place, and fails without one, never asking anything.
const XCODE_SELECT: &str = "/usr/bin/xcode-select";

/// Programs start by name, found on the PATH children get, apart from Git ([`git`]).
pub fn program(program: &str, args: Vec<OsString>, path: &OsStr) -> Result<(PathBuf, Vec<OsString>)> {
    if program == "git" {
        return Ok((git(path, Path::new(XCODE_SELECT))?, args));
    }
    Ok((program.into(), args))
}

pub fn git(path: &OsStr, xcode_select: &Path) -> Result<PathBuf> {
    let found = std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("git"))
        .filter(|git| git.metadata().is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0));
    for git in found {
        // A link to the stand-in, or a file that can't be told from it, counts as the stand-in.
        let another = git.canonicalize().is_ok_and(|real| real != Path::new(STAND_IN));
        if another || developer_tools(xcode_select) {
            return Ok(git);
        }
    }
    Err("Git isn't on this Mac yet. macOS installs it with Apple's command line tools: open Terminal and run xcode-select --install".into())
}

/// Whether `xcode_select -p` names a developer folder that is there. The answer is kept ten seconds, so a scan asks
/// once and Git installed while Laci runs is still found.
fn developer_tools(xcode_select: &Path) -> bool {
    static ASKED: Mutex<BTreeMap<PathBuf, (Instant, bool)>> = Mutex::new(BTreeMap::new());
    let mut asked = ASKED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, answer)) = asked.get(xcode_select)
        && at.elapsed() < Duration::from_secs(10)
    {
        return *answer;
    }
    let answer = process::run(&xcode_select.to_string_lossy(), &["-p"], None, Duration::from_secs(5))
        .is_ok_and(|dir| Path::new(dir.trim()).is_dir());
    asked.insert(xcode_select.to_owned(), (Instant::now(), answer));
    answer
}
