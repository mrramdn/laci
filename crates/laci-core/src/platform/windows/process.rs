//! Processes on Windows: whether one still runs, which work in a folder or write to a file, and the programs Laci
//! starts and stops. sysinfo lists the processes and reads their working folders.
use crate::{Result, platform::Holder};
use process_wrap::std::{ChildWrapper, CommandWrap, JobObject};
use std::{
    fs::{self, OpenOptions},
    io,
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus},
};
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// ERROR_SHARING_VIOLATION: another program has the file open.
const SHARING_VIOLATION: i32 = 32;

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

pub fn ensure_idle(sources: &[PathBuf]) -> Result<()> {
    if !processes_in(sources)?.is_empty() {
        return Err("History is in use by a running process. Close it first.".into());
    }
    let failed = || "Could not check running history writers".to_owned();
    for source in sources {
        if fs::symlink_metadata(source).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) {
            continue;
        }
        for entry in walkdir::WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(|_| failed())?;
            if !entry.file_type().is_file() {
                continue;
            }
            // Opening a file without sharing it fails while any other program has it open, reading or writing alike.
            // That is stricter than on Linux and macOS, and right for Windows, where a file another program holds
            // open often can't be moved.
            match OpenOptions::new().read(true).share_mode(0).open(entry.path()) {
                Ok(_) => {}
                Err(e) if e.raw_os_error() == Some(SHARING_VIOLATION) => {
                    return Err("History is open in another program. Stop the session before cleaning it up.".into());
                }
                Err(_) => return Err(failed()),
            }
        }
    }
    Ok(())
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
