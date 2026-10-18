//! Which programs are running, and which work inside a folder or write to a file there. sysinfo lists the processes
//! and their working folders; lsof, which macOS ships, finds the files they hold open for writing. macOS shows a
//! process's working folder and files only to its own user and to root, as Linux's /proc does, so another user's
//! processes are skipped on both.
use crate::{Result, platform::Holder};
use rustix::{io::Errno, process::test_kill_process};
use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// How long lsof may take. It can hang on a network volume that stopped answering.
const LSOF_WAIT: Duration = Duration::from_secs(10);

/// `kill(pid, 0)` asks without sending anything. A process this user may not signal, as another user's, answers
/// EPERM: it runs all the same.
pub fn pid_alive(pid: u32) -> Result<bool> {
    // kill would read 0, or an id past i32::MAX, as a group of processes. Neither is a Laci's, which is all this is
    // asked about (0 is the kernel), and Linux answers no for both too.
    let Some(pid) = i32::try_from(pid).ok().and_then(rustix::process::Pid::from_raw) else {
        return Ok(false);
    };
    match test_kill_process(pid) {
        Ok(()) | Err(Errno::PERM) => Ok(true),
        Err(Errno::SRCH) => Ok(false),
        Err(_) => Err("Could not check whether a process is still running".into()),
    }
}

/// Reads the working folder of each process in `which`, and who runs it.
fn refresh(system: &mut System, which: ProcessesToUpdate<'_>) {
    let read = ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always).with_user(UpdateKind::Always);
    system.refresh_processes_specifics(which, true, read);
}

pub fn processes_in(paths: &[PathBuf]) -> Result<Vec<Holder>> {
    let failed = || "Could not check which programs are using this folder".to_owned();
    let mut system = System::new();
    refresh(&mut system, ProcessesToUpdate::All);
    let me = Pid::from_u32(std::process::id());
    // A list without this process, or without its working folder, is no list of what runs.
    let own = system.process(me).filter(|own| own.cwd().is_some()).ok_or_else(failed)?;
    let user = own.effective_user_id().ok_or_else(failed)?.clone();
    let roots = Roots::new(paths);
    let mut holders = Vec::new();
    let mut unread = Vec::new();
    for (&pid, process) in system.processes() {
        // Process 0 is the kernel, which works in no folder.
        if pid == me || pid.as_u32() == 0 {
            continue;
        }
        match process.cwd() {
            Some(cwd) => holders.extend(holder(pid, process, cwd, &roots)),
            // macOS shows this user's working folders, unless the process has just ended. Of another user's process
            // it shows little more than the name, not even whose it is.
            None if process.effective_user_id() == Some(&user) => unread.push(pid),
            None => {}
        }
    }
    if !unread.is_empty() {
        // Asked again: a process that has ended since is gone from the list; one still unread fails the check.
        refresh(&mut system, ProcessesToUpdate::Some(&unread));
        for pid in unread {
            let Some(process) = system.process(pid) else { continue };
            let Some(cwd) = process.cwd() else {
                let name = process.name().to_string_lossy();
                return Err(format!("Could not check which folder {name} (pid {pid}) works in"));
            };
            holders.extend(holder(pid, process, cwd, &roots));
        }
    }
    holders.sort_by_key(|h| h.pid);
    Ok(holders)
}

/// `process` as a holder, if it works inside `roots`.
fn holder(pid: Pid, process: &Process, cwd: &Path, roots: &Roots) -> Option<Holder> {
    roots.contain(cwd).then(|| Holder {
        pid: pid.as_u32(),
        name: process.name().to_string_lossy().into_owned(),
        cwd: cwd.to_owned(),
    })
}

/// The folders asked about, as given and with links resolved, spelled for comparing. macOS names a working folder
/// with links resolved, as /private/var for /var, and its disks ignore case unless formatted to keep it: matching
/// without case can only make a folder count as in use, never let one pass.
struct Roots(Vec<String>);
impl Roots {
    fn new(paths: &[PathBuf]) -> Self {
        let spelled = paths.iter().flat_map(|p| [Some(p.clone()), fs::canonicalize(p).ok()]).flatten();
        Self(spelled.map(|p| spelling(&p)).collect())
    }
    /// Whether `cwd` is one of the folders or inside one. A working folder without a path was deleted, and nothing
    /// gone is inside a folder that is here.
    fn contain(&self, cwd: &Path) -> bool {
        let spelled = spelling(cwd);
        cwd.is_absolute() && self.0.iter().any(|root| within(&spelled, root))
    }
}

/// `path` in lower case, without a trailing `/`, and without the data volume's own prefix for the folders macOS also
/// shows at `/`, such as /System/Volumes/Data/Users for /Users.
fn spelling(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = text.strip_prefix("/System/Volumes/Data").filter(|rest| rest.starts_with('/')).unwrap_or(&text);
    text.trim_end_matches('/').to_lowercase()
}

/// Whether the spelled `path` is the spelled `root` or inside it.
fn within(path: &str, root: &str) -> bool {
    path.strip_prefix(root).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

pub fn ensure_idle(sources: &[PathBuf]) -> Result<()> {
    if !processes_in(sources)?.is_empty() {
        return Err("History is in use by a running process. Close it first.".into());
    }
    if writing(sources)? {
        return Err("History has an open writer. Stop the session before cleaning it up.".into());
    }
    Ok(())
}

/// Whether a process of this user holds a file in `sources` open for writing: lsof lists its access as `w` or `u`.
fn writing(sources: &[PathBuf]) -> Result<bool> {
    let failed = || "Could not check running history writers".to_owned();
    let (mut folders, mut files) = (Vec::new(), Vec::new());
    for source in sources {
        // Through a link, as lsof looks: what the link leads to is what is checked.
        match fs::metadata(source) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(failed()),
            Ok(meta) if meta.is_dir() => folders.push(source),
            Ok(_) => files.push(source),
        }
    }
    if folders.is_empty() && files.is_empty() {
        return Ok(false);
    }
    // lsof looks through each folder itself and, with its warnings off, passes over what it can't read there. So
    // everything in them is read here first: what can't be read fails the check instead of going unseen.
    for folder in &folders {
        for entry in walkdir::WalkDir::new(folder) {
            entry.map_err(|_| failed())?.metadata().map_err(|_| failed())?;
        }
    }
    // A file this process holds open for writing, which lsof must list too.
    let canary = tempfile::NamedTempFile::new().map_err(|_| failed())?;
    // -w: lsof would also warn about any volume it can't look at, such as a share that stopped answering, which says
    // nothing about these files.
    let mut args: Vec<OsString> = ["-n", "-P", "-w", "-Fpfa"].map(OsString::from).into();
    for folder in folders {
        args.extend(["+D".into(), folder.into()]);
    }
    args.extend(["--".into(), canary.path().into()]);
    args.extend(files.into_iter().map(OsString::from));
    let listed = lsof(&args).ok_or_else(failed)?;
    let (me, fd) = (std::process::id().to_string(), canary.as_file().as_raw_fd().to_string());
    writer_listed(&listed, (&me, &fd)).ok_or_else(failed)
}

/// Whether lsof's fields in `listed` show a file open for writing, besides the `canary` (this process's id and the
/// file descriptor it holds the canary on). None when the canary isn't listed: an answer without it is no answer.
fn writer_listed(listed: &str, canary: (&str, &str)) -> Option<bool> {
    let (mut pid, mut fd, mut seen, mut writer) = ("", "", false, false);
    // A field a line: `p` starts a process, `f` one of its files, and `a` says how that file is open.
    for line in listed.lines() {
        match line.split_at_checked(1) {
            Some(("p", value)) => (pid, fd) = (value, ""),
            Some(("f", value)) => fd = value,
            Some(("a", "w" | "u")) if (pid, fd) == canary => seen = true,
            Some(("a", "w" | "u")) => writer = true,
            _ => {}
        }
    }
    seen.then_some(writer)
}

/// What lsof writes for `args`, or None when it fails, writes anything on stderr (with its warnings off, what is left
/// there is an error) or takes longer than [`LSOF_WAIT`]. It exits with 1 when a file it was asked about isn't open,
/// so 0 and 1 are both answers.
fn lsof(args: &[OsString]) -> Option<String> {
    // Files, not pipes: lsof can't stall on a full pipe while it is waited for.
    let (output, errors) = (tempfile::tempfile().ok()?, tempfile::tempfile().ok()?);
    let mut child = Command::new("/usr/sbin/lsof")
        .args(args)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(output.try_clone().ok()?)
        .stderr(errors.try_clone().ok()?)
        .spawn()
        .ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < LSOF_WAIT => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let read = |mut file: File| -> Option<String> {
        file.seek(SeekFrom::Start(0)).ok()?;
        let mut text = String::new();
        file.read_to_string(&mut text).ok()?;
        Some(text)
    };
    let (output, errors) = (read(output)?, read(errors)?);
    (matches!(status.code(), Some(0 | 1)) && errors.trim().is_empty()).then_some(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_working_folder_matches_in_any_case_and_through_the_data_volume() {
        let roots = Roots::new(&[PathBuf::from("/Users/me/Project")]);
        for cwd in ["/Users/me/Project", "/users/me/project/src/", "/System/Volumes/Data/Users/me/Project"] {
            assert!(roots.contain(Path::new(cwd)), "{cwd}");
        }
        for cwd in ["/Users/me/Project-old", "/Users/me", "Users/me/Project", ""] {
            assert!(!roots.contain(Path::new(cwd)), "{cwd}");
        }
        assert!(Roots::new(&[PathBuf::from("/")]).contain(Path::new("/")));
    }

    #[test]
    fn a_file_open_for_writing_counts_once_lsof_has_listed_the_canary() {
        let canary = ("100", "7");
        let listed = |rest: &str| format!("p100\nf7\nau\n{rest}");
        assert_eq!(writer_listed(&listed(""), canary), Some(false));
        assert_eq!(writer_listed(&listed("p200\nfcwd\na \nf3\nar\n"), canary), Some(false), "a folder and a reader");
        assert_eq!(writer_listed(&listed("p200\nf3\naw\n"), canary), Some(true));
        assert_eq!(writer_listed(&listed("p200\nf3\nau\n"), canary), Some(true), "read and write");
        assert_eq!(writer_listed(&listed("f9\naw\n"), canary), Some(true), "this process's own, as on Linux");
        assert_eq!(writer_listed("p200\nf3\naw\n", canary), None, "no canary, no answer");
        assert_eq!(writer_listed("p100\nf8\nau\n", canary), None, "another file of this process is no canary");
        assert_eq!(writer_listed("", canary), None);
    }

    /// lsof passes over what it can't read, so the check reads every folder first.
    #[test]
    fn a_folder_that_cannot_be_read_fails_the_writer_check() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let (history, closed) = (temp.path().join("history"), temp.path().join("history/closed"));
        fs::create_dir_all(&closed).unwrap();
        fs::write(history.join("session.jsonl"), "{}\n").unwrap();
        fs::set_permissions(&closed, fs::Permissions::from_mode(0o000)).unwrap();
        let refused = writing(std::slice::from_ref(&history));
        fs::set_permissions(&closed, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(refused, Err("Could not check running history writers".into()));
        assert_eq!(writing(&[history]), Ok(false));
    }
}
