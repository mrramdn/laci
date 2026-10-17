//! Processes on Windows: whether one still runs, which work in a folder or write to a file, and the programs Laci
//! starts and stops.
use super::not_yet;
use crate::{Result, platform::Holder};
use process_wrap::std::{ChildWrapper, CommandWrap, JobObject};
use std::{
    io,
    path::PathBuf,
    process::{Child, Command, ExitStatus},
};

pub fn pid_alive(_pid: u32) -> Result<bool> {
    Err(not_yet("check whether a process is still running"))
}

pub fn processes_in(_paths: &[PathBuf]) -> Result<Vec<Holder>> {
    Err(not_yet("check which programs are using a folder"))
}

pub fn ensure_idle(_sources: &[PathBuf]) -> Result<()> {
    Err(not_yet("check which programs are using this history"))
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
