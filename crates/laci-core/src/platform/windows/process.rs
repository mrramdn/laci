//! Processes on Windows: whether one still runs, which work in a folder or have a file open, and the programs Laci
//! starts and stops. sysinfo lists the processes and reads their working folders, NTFS tells which have a file open,
//! and Windows' record of a process tells which program it runs.
use super::ffi;
use crate::{Result, platform::Holder};
use holders::Verdict;
use process_wrap::std::{ChildWrapper, CommandWrap, CreationFlags, JobObject};
use std::{
    ffi::OsString,
    fs, io,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus},
    thread,
    time::{Duration, Instant},
};
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use windows::Win32::System::Threading::CREATE_NO_WINDOW;
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};

mod holders;

/// How long the history check waits for another Laci process to let go of a log, such as the desktop app's scan while
/// `laci mcp` cleans up. A scan's read is over in moments; a Laci process that still has the log open after this keeps
/// the history in use. A process that is ending gets as long.
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

/// Refuses while a program works inside `sources` or has a file there open, and when that can't be checked. NTFS lists
/// the processes that have each file open, reading or writing alike: stricter than the writers-only check on Linux and
/// macOS, and right for Windows, where a file another program holds open often can't be moved. This process and the
/// helpers it runs are left out, as its own scan may be reading a log meanwhile. Another process that runs one of
/// Laci's programs, such as the desktop app's scan while `laci mcp` cleans up, gets up to [`LACI_WAIT`] to let go of a
/// file, and one that has ended since NTFS listed it, or is ending, is asked about again; any other program refuses at
/// once. NTFS is asked through a handle that may only read the file's attributes and shares everything, so no open,
/// read or append of an agent's fails because of the check. What that handle can make fail, for the moment it is
/// open, is in [`ffi::processes_using`].
pub fn ensure_idle(sources: &[PathBuf]) -> Result<()> {
    if !processes_in(sources)?.is_empty() {
        return Err("History is in use by a running process. Close it first.".into());
    }
    let failed = || holders::FAILED.to_owned();
    let laci = laci_programs();
    for source in sources {
        // Skipped only when neither it nor the folder it would be in is there. A drive or share that doesn't answer
        // goes on to the walk, which fails.
        if fs::symlink_metadata(source)
            .is_err_and(|e| matches!(code(&e), Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)))
        {
            continue;
        }
        // Walked in the `\\?\` spelling, each file is opened by its very name, however long or odd.
        let root = holders::verbatim(&source.as_os_str().encode_wide().collect::<Vec<_>>())?;
        for entry in walkdir::WalkDir::new(OsString::from_wide(&root)).follow_links(false) {
            let entry = entry.map_err(|_| failed())?;
            if entry.file_type().is_file() {
                let_go(entry.path(), &laci)?;
            }
        }
    }
    Ok(())
}

/// Waits, as [`ensure_idle`] says, until nothing but this process and its helpers has the file at `path` open. A file
/// removed since the walk holds nothing. Not so one whose folder is gone too, which may have moved with it to where
/// the walk never looked, or one on a drive or share that stopped answering: the check fails for those.
fn let_go(path: &Path, laci: &[PathBuf]) -> Result<()> {
    let me = std::process::id();
    let own = |pid| pid == me || crate::process::is_own_child(pid);
    let asked = Instant::now();
    loop {
        let mut pids = match ffi::processes_using(path) {
            Ok(pids) => pids,
            Err(e) if code(&e) == Some(ERROR_FILE_NOT_FOUND) => return Ok(()),
            Err(_) => return Err(holders::FAILED.into()),
        };
        // A process that has the file open more than once is looked up once.
        pids.sort_unstable();
        pids.dedup();
        match holders::verdict(pids, own, |pid| looked_up(pid, laci)) {
            Verdict::Idle => return Ok(()),
            Verdict::Refuse(why) => return Err(why.into()),
            Verdict::Wait if asked.elapsed() >= LACI_WAIT => return Err(holders::OPEN.into()),
            Verdict::Wait => thread::sleep(Duration::from_millis(100)),
        }
    }
}

/// The Windows error behind `error`. The check tells errors apart by it rather than by std's kind: std's NotFound also
/// stands for a drive or share that doesn't answer, where the files may well be open.
fn code(error: &io::Error) -> Option<u32> {
    error.raw_os_error().map(|code| code as u32)
}

/// What the process `pid` that NTFS listed turned out to be. Each answer is asked afresh: an id that went to another
/// process is judged by that process. One that has ended is gone, and so is one that is ending and no longer tells its
/// program: a process lets go of its files before Windows marks it ended, so NTFS, asked again, tells. One that never
/// tells, as some of Windows' own don't, still has the file open when the wait is over, and the check refuses.
fn looked_up(pid: u32, laci: &[PathBuf]) -> holders::Process {
    match ffi::process_program(pid) {
        Ok(ffi::Program::Known(program)) if runs_laci(&program, laci) => holders::Process::Laci,
        Ok(ffi::Program::Known(_)) | Err(_) => holders::Process::Other,
        Ok(ffi::Program::Ended | ffi::Program::Untold) => holders::Process::Gone,
    }
}

/// Whether `program` is one of Laci's programs (`laci`, canonical), compared canonical and, as Windows compares names,
/// without case. A program that can't be found on the disk isn't taken for Laci.
fn runs_laci(program: &Path, laci: &[PathBuf]) -> bool {
    fs::canonicalize(program).is_ok_and(|program| laci.iter().any(|ours| spelling(ours) == spelling(&program)))
}

/// Laci's programs (see [`holders::programs`]), canonical: the one running and the other of its install, when that
/// is on the disk. Empty when this program can't be found: another Laci then counts as any other program.
fn laci_programs() -> Vec<PathBuf> {
    let Ok(exe) = std::env::current_exe().and_then(fs::canonicalize) else {
        return Vec::new();
    };
    holders::programs(&exe).iter().filter_map(|program| fs::canonicalize(program).ok()).collect()
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

/// The program starts suspended and runs only once it is in the job, so nothing it starts can slip out. The job sets
/// the creation flags itself, so CREATE_NO_WINDOW goes through it too, as `process::command` gives it to every other
/// child: a generator such as `pnpm create` would otherwise open a console window.
pub fn spawn_group(command: Command) -> io::Result<Group> {
    let mut command = CommandWrap::from(command);
    command.wrap(CreationFlags(CREATE_NO_WINDOW));
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

    #[test]
    fn the_window_and_the_console_program_of_an_install_both_run_laci() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("Laci");
        fs::create_dir_all(install.join("bin")).unwrap();
        let (window, console, agent) =
            (install.join("laci.exe"), install.join("bin").join("laci.exe"), temp.path().join("agent.exe"));
        for program in [&window, &console, &agent] {
            fs::write(program, "").unwrap();
        }
        for running in [&window, &console] {
            let laci: Vec<PathBuf> = holders::programs(running).iter().map(|p| fs::canonicalize(p).unwrap()).collect();
            assert!(runs_laci(&window, &laci) && runs_laci(&console, &laci), "{}", running.display());
            assert!(runs_laci(&install.join("BIN").join("LACI.EXE"), &laci), "Windows ignores case");
            assert!(!runs_laci(&agent, &laci), "another program");
            assert!(!runs_laci(&install.join("gone.exe"), &laci), "a program that isn't on the disk");
        }
        let this = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
        assert!(laci_programs().contains(&this));
    }

    /// A process NTFS lists is looked up as it is then: this one runs Laci's program, `cmd` another, and one that has
    /// ended is gone. Its handle, held here, keeps its id from going to another process.
    #[test]
    fn a_listed_process_is_laci_another_program_or_gone() {
        use std::process::Stdio;
        let laci = laci_programs();
        assert_eq!(looked_up(std::process::id(), &laci), holders::Process::Laci);
        let mut cmd = Command::new("cmd").stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap();
        assert_eq!(looked_up(cmd.id(), &laci), holders::Process::Other);
        cmd.kill().unwrap();
        cmd.wait().unwrap();
        assert!(matches!(ffi::process_program(cmd.id()), Ok(ffi::Program::Ended)));
        assert_eq!(looked_up(cmd.id(), &laci), holders::Process::Gone);
    }

    /// A file removed since the walk holds nothing. One whose folder is gone as well may have moved with it to where
    /// the walk never looked, so the check fails.
    #[test]
    fn a_file_gone_since_the_walk_passes_but_not_one_whose_folder_went() {
        let temp = tempfile::tempdir().unwrap();
        let laci = laci_programs();
        let_go(&temp.path().join("gone.jsonl"), &laci).unwrap();
        assert_eq!(let_go(&temp.path().join("moved").join("session.jsonl"), &laci).unwrap_err(), holders::FAILED);
    }
}
