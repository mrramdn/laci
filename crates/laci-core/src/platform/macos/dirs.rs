//! Where Laci keeps its settings, data and cache on macOS.
use super::not_yet;
use crate::{Result, platform::Dirs};
use std::path::Path;

pub fn user_dirs(_home: &Path) -> Result<Dirs> {
    not_yet("choose where to keep its settings and data")
}
