//! Files on macOS: what Finder hides, what iCloud keeps only online, and the folders that hold no projects.
use std::{ffi::OsStr, fs::Metadata, os::macos::fs::MetadataExt};

/// UF_HIDDEN in <sys/stat.h>: Finder doesn't show the file, as with ~/Library.
const UF_HIDDEN: u32 = 0x8000;
/// SF_DATALESS in <sys/stat.h>: the file's content is in iCloud, and reading it downloads it first.
const SF_DATALESS: u32 = 0x4000_0000;

pub fn hidden_flag(meta: &Metadata) -> bool {
    meta.st_flags() & UF_HIDDEN != 0
}

pub fn placeholder(meta: &Metadata) -> bool {
    meta.st_flags() & SF_DATALESS != 0
}

/// ~/Library, apps and the Photos library: looking inside asks for access to other apps' data.
pub fn system_folder(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_lowercase();
    name == "library" || name.ends_with(".app") || name.ends_with(".photoslibrary")
}
