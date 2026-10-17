//! Processes on Windows: whether one still runs, which work in a folder or write to a file, and the programs Laci
//! starts and stops.
use super::not_yet;
use crate::{Result, platform::Holder};
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

pub fn exited(_child: &mut Child) -> Result<bool> {
    Err(not_yet("tell when a program it started has finished"))
}

/// Never made: [`spawn_group`] fails.
pub struct Group {
    _never: (),
}

pub fn spawn_group(_command: Command) -> io::Result<Group> {
    Err(io::Error::other(not_yet("stop what a program it starts runs in turn")))
}

impl Group {
    pub fn exited(&mut self) -> Result<bool> {
        Err(not_yet("tell when a program it started has finished"))
    }
    pub fn stop(&self) {}
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        Err(io::Error::other(not_yet("tell when a program it started has finished")))
    }
}
