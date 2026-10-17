//! Which programs are running, and which work inside a folder or write to a file there.
use super::not_yet;
use crate::{Result, platform::Holder};
use std::path::PathBuf;

pub fn pid_alive(_pid: u32) -> Result<bool> {
    not_yet("check whether a process is still running")
}

pub fn processes_in(_paths: &[PathBuf]) -> Result<Vec<Holder>> {
    not_yet("check which programs are using a folder")
}

pub fn ensure_idle(_sources: &[PathBuf]) -> Result<()> {
    not_yet("check which programs are using this history")
}
