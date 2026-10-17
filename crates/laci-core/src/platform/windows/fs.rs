//! Files on Windows: which file a path names, the change lock and renames.
use super::{ffi, not_yet};
use crate::{
    Result,
    platform::{Identity, Stamp, path::plain_path},
};
use file_id::FileId;
use std::{
    fs::{File, Metadata, OpenOptions, TryLockError},
    io,
    path::{Path, PathBuf},
};

/// The names config.json keeps an identity under: the volume's serial number and the file's ID.
pub const IDENTITY_FIELDS: [&str; 2] = ["volume", "file"];

/// The volume serial number and the file ID from FILE_ID_INFO, whose 128 bits tell files on ReFS and Dev Drives apart
/// too. Volumes without it give the 64-bit file index. file-id reads through a link, so asking about a link itself
/// fails.
pub fn identity(path: &Path, meta: &Metadata) -> Result<Identity> {
    if meta.is_symlink() {
        return Err(not_yet("tell links apart"));
    }
    Ok(match file_id::get_file_id(path).map_err(|e| e.to_string())? {
        FileId::HighRes { volume_serial_number, file_id } => Identity { volume: volume_serial_number, file: file_id },
        FileId::LowRes { volume_serial_number, file_index } => {
            Identity { volume: volume_serial_number.into(), file: file_index.into() }
        }
        FileId::Inode { device_id, inode_number } => Identity { volume: device_id, file: inode_number.into() },
    })
}

/// Not yet: the change time is in FILE_BASIC_INFO, which stable std doesn't give, and the ID of a file that is open
/// takes a call file-id doesn't make.
pub fn change_stamp(_path: &Path, _meta: &Metadata) -> Result<Stamp> {
    Err(not_yet("tell when a file changed"))
}

pub fn file_change_stamp(_file: &File, _meta: &Metadata) -> Result<Stamp> {
    Err(not_yet("tell when a file changed"))
}

/// The lock is on the open file, so Windows lets it go when the file closes, also when Laci stops unexpectedly. The
/// file itself stays: one that is being deleted can't be opened, which would fail with "Access is denied" instead of
/// the busy message.
pub struct Lock {
    _file: File,
}

pub fn lock(path: PathBuf) -> Result<Lock> {
    let busy = "Another laci window or agent is changing files right now. Try again in a moment.";
    plain_path(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| e.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(Lock { _file: file }),
        Err(TryLockError::WouldBlock) => Err(busy.into()),
        Err(TryLockError::Error(e)) => Err(e.to_string()),
    }
}

/// ERROR_NOT_SAME_DEVICE: `dest` is on another volume.
const NOT_SAME_DEVICE: i32 = 17;

pub fn rename_noreplace(src: &Path, dest: &Path) -> io::Result<()> {
    ffi::move_file(src, dest).map_err(|e| {
        if e.raw_os_error() == Some(NOT_SAME_DEVICE) { io::Error::new(io::ErrorKind::CrossesDevices, e) } else { e }
    })
}

/// Copies refuse links: Windows lets only Developer Mode or an administrator make a symlink, and a junction can't
/// stand in for every link.
pub fn copy_link(src: &Path, _dest: &Path) -> Result<()> {
    Err(not_yet(&format!("copy the link {}", src.display())))
}

pub fn preserve(_meta: &Metadata, _dest: &Path) -> Result<()> {
    Err(not_yet("keep a file's times and permissions"))
}
