//! Processes on Windows: whether one still runs, which work in a folder or have a file open, and the programs Laci
//! starts and stops. sysinfo lists the processes and reads their working folders and programs, and Restart Manager
//! tells which have a file open.
use super::ffi::RestartSession;
use crate::{Result, platform::Holder};
use process_wrap::std::{ChildWrapper, CommandWrap, JobObject};
use restart_manager::{Name, Verdict};
use std::{
    fs::{self, File},
    io,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use windows_sys::Win32::{Foundation::MAX_PATH, System::RestartManager::RmRebootReasonDetectedSelf};

mod restart_manager;

// restart_manager builds on every OS, so it spells out what it reads of Windows; it must be Windows' own.
const _: () = assert!(restart_manager::DETECTED_SELF == RmRebootReasonDetectedSelf as u32);
const _: () = assert!(restart_manager::MAX_PATH == MAX_PATH as usize);

/// How long the history check waits for another Laci process to let go of a log, such as the desktop app's scan while
/// `laci mcp` cleans up. A scan's read is over in moments; a Laci process that still has the log open after this keeps
/// the history in use.
const LACI_WAIT: Duration = Duration::from_secs(3);

/// Looked up in a fresh list of processes, which must show this one too.
pub fn pid_alive(pid: u32) -> Result<bool> {
    let (asked, me) = (Pid::from_u32(pid), Pid::from_u32(std::process::id()));
    // sysinfo drops a pid listed twice, so this one would go missing when asked about itself.
    let both = [asked, me];
    let pids = if asked == me { &both[1..] } else { &both[..] };
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::Some(pids), true, ProcessRefreshKind::nothing());
    if system.process(me).is_none() {
        return Err("Could not check whether a process is still running".into());
    }
    Ok(system.process(asked).is_some())
}

pub fn processes_in(paths: &[PathBuf]) -> Result<Vec<Holder>> {
    let mut system = System::new();
    let read = ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always);
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, read);
    let me = Pid::from_u32(std::process::id());
    // A list without this process, or without its working folder, is no list of what runs.
    if system.process(me).and_then(Process::cwd).is_none() {
        return Err("Could not check which programs are using this folder".into());
    }
    let roots = Roots::new(paths);
    let mut holders: Vec<Holder> = system
        .processes()
        .iter()
        .filter(|&(&pid, _)| pid != me)
        .filter_map(|(&pid, process)| {
            // Windows shows a working folder only to a program that may read the process's memory: another user's
            // isn't shown, and neither is one that runs as administrator while Laci doesn't. Those are skipped, as
            // Linux skips what /proc doesn't show.
            let cwd = process.cwd()?;
            roots.contain(cwd).then(|| Holder {
                pid: pid.as_u32(),
                name: process.name().to_string_lossy().into_owned(),
                cwd: cwd.to_owned(),
            })
        })
        .collect();
    holders.sort_by_key(|h| h.pid);
    Ok(holders)
}

/// The folders asked about, as given and with links and short 8.3 names resolved, spelled for comparing. A working
/// folder keeps the spelling it was given, in any case and maybe with short names, and Windows ignores case: matching
/// without case can only make a folder count as in use, never let one pass.
struct Roots(Vec<String>);
impl Roots {
    fn new(paths: &[PathBuf]) -> Self {
        let spelled = paths.iter().flat_map(|p| [Some(p.clone()), fs::canonicalize(p).ok()]).flatten();
        Self(spelled.map(|p| spelling(&p)).collect())
    }
    /// Whether `cwd` is one of the folders or inside one. A working folder spelled otherwise is resolved, but only on
    /// a drive or share where one of the folders lies: one on a network drive that stopped answering would hang the
    /// check.
    fn contain(&self, cwd: &Path) -> bool {
        let spelled = spelling(cwd);
        let inside = |cwd: &str| self.0.iter().any(|root| within(cwd, root));
        inside(&spelled)
            || (self.0.iter().any(|root| volume(root) == volume(&spelled))
                && fs::canonicalize(cwd).is_ok_and(|resolved| inside(&spelling(&resolved))))
    }
}

/// Whether the spelled `path` is the spelled `root` or inside it.
fn within(path: &str, root: &str) -> bool {
    path.strip_prefix(root).is_some_and(|rest| rest.is_empty() || rest.starts_with('\\'))
}

/// `path` in lower case, with `\` between names and none at the end, and without the `\\?\` that resolved paths begin
/// with.
fn spelling(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = match text.strip_prefix(r"\\?\UNC\") {
        Some(share) => format!(r"\\{share}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned(),
    };
    text.trim_end_matches('\\').to_lowercase()
}

/// The drive, as `c:`, or the share, as `\\server\share`, that a spelled path lies on.
fn volume(spelled: &str) -> &str {
    let end = match spelled.strip_prefix(r"\\") {
        Some(share) => share.match_indices('\\').nth(1).map_or(spelled.len(), |(i, _)| i + 2),
        None => spelled.find('\\').unwrap_or(spelled.len()),
    };
    &spelled[..end]
}

/// Refuses while a program works inside `sources` or has a file there open, and when that can't be checked. Restart
/// Manager reports every process that has a file open, reading or writing alike: stricter than the writers-only check
/// on Linux and macOS, and right for Windows, where a file another program holds open often can't be moved. This
/// process and the helpers it runs are left out, as its own scan may be reading a log meanwhile. Another process that
/// runs Laci's program, such as the desktop app's scan while `laci mcp` cleans up, gets up to [`LACI_WAIT`] to let
/// go; any other program refuses at once. Restart Manager asks Windows who has each file open without opening it for
/// reading or writing, so an agent appending to its log can't fail because of the check.
pub fn ensure_idle(sources: &[PathBuf]) -> Result<()> {
    if !processes_in(sources)?.is_empty() {
        return Err("History is in use by a running process. Close it first.".into());
    }
    let failed = || restart_manager::FAILED.to_owned();
    let (mut names, mut long) = (Vec::new(), None);
    for source in sources {
        if fs::symlink_metadata(source).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) {
            continue;
        }
        for entry in walkdir::WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(|_| failed())?;
            if !entry.file_type().is_file() {
                continue;
            }
            match restart_manager::name(&entry.path().as_os_str().encode_wide().collect::<Vec<_>>())? {
                Name::Plain(name) => names.push(name),
                Name::Long(name) if *long.get_or_insert_with(reads_long_paths) => names.push(name),
                Name::Long(_) => return Err(restart_manager::TOO_LONG.into()),
            }
        }
    }
    if names.is_empty() {
        return Ok(());
    }
    let mut session = RestartSession::start().map_err(|_| failed())?;
    for batch in restart_manager::batches(&names) {
        session.register(batch).map_err(|_| failed())?;
    }
    let me = std::process::id();
    let own = |pid| pid == me || crate::process::is_own_child(pid);
    let asked = Instant::now();
    loop {
        let found = session.list().map_err(|_| failed())?;
        match restart_manager::verdict(found.processes.iter().map(|p| p.dwProcessId), found.reasons, own, runs_laci) {
            Verdict::Idle => return Ok(()),
            Verdict::Refuse(why) => return Err(why.into()),
            Verdict::Wait if asked.elapsed() >= LACI_WAIT => return Err(restart_manager::OPEN.into()),
            Verdict::Wait => thread::sleep(Duration::from_millis(100)),
        }
    }
}

/// Whether `pid` runs Laci's own program, as the desktop app and each `laci mcp` do. A process whose program can't be
/// read isn't taken for Laci.
fn runs_laci(pid: u32) -> bool {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    let read = ProcessRefreshKind::nothing().with_exe(UpdateKind::Always);
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, read);
    let theirs = system.process(pid).and_then(Process::exe).map(fs::canonicalize);
    let mine = std::env::current_exe().and_then(fs::canonicalize);
    matches!((theirs, mine), (Some(Ok(theirs)), Ok(mine)) if theirs == mine)
}

/// Whether Restart Manager reads a name in the `\\?\` spelling as long as [`restart_manager::LONGEST`], which its
/// documentation doesn't say. It is asked the first time a history needs it, and the answer is kept; an attempt that
/// fails before Restart Manager answers is made again next time, and until it answers yes, such a path is refused.
fn reads_long_paths() -> bool {
    static READS: OnceLock<bool> = OnceLock::new();
    if let Some(&reads) = READS.get() {
        return reads;
    }
    long_path_found().is_ok_and(|reads| *READS.get_or_init(|| reads))
}

/// Whether Restart Manager finds this process holding a file named in the `\\?\` spelling, at least
/// [`restart_manager::LONGEST`] long, deep in a folder of its own in the temporary folder.
fn long_path_found() -> io::Result<bool> {
    let temp = tempfile::tempdir()?;
    let mut deep = fs::canonicalize(temp.path())?;
    while deep.as_os_str().encode_wide().count() < restart_manager::LONGEST {
        deep.push("l".repeat(100));
    }
    fs::create_dir_all(&deep)?;
    let held = deep.join("held");
    let _file = File::create(&held)?;
    let mut session = RestartSession::start()?;
    session.register(&[held.as_os_str().encode_wide().collect()])?;
    let found = session.list()?;
    let me = std::process::id();
    Ok(found.reasons & restart_manager::DETECTED_SELF != 0 || found.processes.iter().any(|p| p.dwProcessId == me))
}

/// While Laci holds the child's handle, Windows keeps its process id from going to another process, so asking needs
/// nothing more than `try_wait`.
pub fn exited(child: &mut Child) -> Result<bool> {
    Ok(child.try_wait().map_err(|e| e.to_string())?.is_some())
}

/// The program and everything it starts run in a Job Object, which `stop` ends as a whole.
pub struct Group {
    child: Box<dyn ChildWrapper>,
}

/// The program starts suspended and runs only once it is in the job, so nothing it starts can slip out.
pub fn spawn_group(command: Command) -> io::Result<Group> {
    let mut command = CommandWrap::from(command);
    command.wrap(JobObject);
    Ok(Group { child: command.spawn()? })
}

impl Group {
    pub fn exited(&mut self) -> Result<bool> {
        Ok(self.child.try_wait().map_err(|e| e.to_string())?.is_some())
    }
    pub fn stop(&mut self) {
        let _ = self.child.start_kill();
    }
    /// Waits for the program alone, as on Linux and macOS. The job's own wait also takes a message from the job's
    /// queue, and could wait forever once `exited` has taken the last one.
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.inner_mut().wait()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_working_folder_matches_in_any_spelling_windows_gives_it() {
        let roots = Roots::new(&[PathBuf::from(r"C:\Users\Me\Project")]);
        for cwd in [r"C:\Users\Me\Project", r"c:\users\me\project\src\", r"\\?\C:\Users\Me\Project\src"] {
            assert!(roots.contain(Path::new(cwd)), "{cwd}");
        }
        for cwd in [r"C:\Users\Me\Project-old", r"C:\Users\Me", r"D:\Users\Me\Project"] {
            assert!(!roots.contain(Path::new(cwd)), "{cwd}");
        }
        let share = Roots::new(&[PathBuf::from(r"\\?\UNC\Server\Share\Folder")]);
        assert!(share.contain(Path::new(r"\\server\share\folder\src\")));
        assert_eq!(volume(&spelling(Path::new(r"\\Server\Share\Folder"))), r"\\server\share");
        assert_eq!(volume(&spelling(Path::new(r"C:\"))), "c:");
    }
}
