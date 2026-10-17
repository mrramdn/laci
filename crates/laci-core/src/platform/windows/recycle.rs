//! The Recycle Bin. A delete that wouldn't land there must be refused, never done for good.
use super::not_yet;
use crate::Result;
use std::path::Path;

pub fn trash(_path: &Path) -> Result<()> {
    Err(not_yet("move files to the Recycle Bin"))
}
