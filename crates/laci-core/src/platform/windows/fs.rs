//! Files on Windows: which file a path names and when it changed, the change lock and renames.
use super::{ffi, not_yet};
use crate::{
    Result,
    platform::{Identity, Stamp, path::plain_path},
};
use file_id::FileId;
use std::{
    fs::{File, Metadata, OpenOptions, TryLockError},
    io,
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES};

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

/// The write and change times from FILE_BASIC_INFO, which stable std doesn't give, and the file's identity from the
/// same open handle. Opening a folder takes FILE_FLAG_BACKUP_SEMANTICS, and reading attributes only never stands in
/// another program's way. As with [`identity`], a link itself is refused: opening it would read what it leads to.
pub fn change_stamp(path: &Path, meta: &Metadata) -> Result<Stamp> {
    if meta.is_symlink() {
        return Err(not_yet("tell links apart"));
    }
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|e| e.to_string())?;
    stamp(&file)
}

pub fn file_change_stamp(file: &File, _meta: &Metadata) -> Result<Stamp> {
    stamp(file)
}

fn stamp(file: &File) -> Result<Stamp> {
    let info = ffi::file_info(file).map_err(|e| e.to_string())?;
    Ok(Stamp {
        identity: Identity { volume: info.volume, file: info.file },
        modified: since_1970(info.written),
        changed: since_1970(info.changed),
    })
}

/// Seconds and nanoseconds since 1970 from Windows' 100-nanosecond steps since 1601.
fn since_1970(steps: i64) -> (i64, i64) {
    const STEPS_TO_1970: i64 = 116_444_736_000_000_000;
    let steps = steps.saturating_sub(STEPS_TO_1970);
    (steps.div_euclid(10_000_000), steps.rem_euclid(10_000_000) * 100)
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
