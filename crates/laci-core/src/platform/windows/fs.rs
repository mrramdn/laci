//! Files on Windows: which file a path names and when it changed, the change lock, renames and copies that keep a
//! file's times, a moment's wait for programs that hold a file, and what Explorer hides or keeps only online.
use super::{ffi, not_yet};
use crate::{
    Result,
    platform::{
        Identity, Stamp,
        path::{contains, plain_path},
    },
};
use file_id::FileId;
use std::{
    ffi::OsStr,
    fs::{self, File, FileTimes, Metadata, OpenOptions, TryLockError},
    io,
    os::windows::fs::{FileTimesExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_WRITE_ATTRIBUTES,
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

/// What a copy says on meeting the junctions that pnpm and npm workspaces fill node_modules with, as a move of such a
/// project to another drive does first.
const NODE_MODULES_LINKS: &str = "Laci can't copy the links in node_modules to another drive. Delete the project's \
                                  dependencies and build output first, and reinstall them after the move.";

/// Copies refuse links: Windows lets only Developer Mode or an administrator make a symlink, and a junction can't
/// stand in for every link.
pub fn copy_link(src: &Path, _dest: &Path) -> Result<()> {
    if src.components().any(|part| part.as_os_str().eq_ignore_ascii_case("node_modules")) {
        return Err(NODE_MODULES_LINKS.into());
    }
    Err(not_yet(&format!("copy the link {}", src.display())))
}

/// Times and attributes are written with FILE_WRITE_ATTRIBUTES alone, which a read-only file allows too, and a folder
/// opens only with FILE_FLAG_BACKUP_SEMANTICS. Permissions are the read-only attribute: set by path, Windows keeps the
/// file's other attributes as they are, even when none is left.
pub fn preserve(meta: &Metadata, dest: &Path) -> Result<()> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(dest)
        .map_err(|e| e.to_string())?;
    let mut times = FileTimes::new();
    if let Ok(at) = meta.accessed() {
        times = times.set_accessed(at);
    }
    if let Ok(at) = meta.modified() {
        times = times.set_modified(at);
    }
    if let Ok(at) = meta.created() {
        times = times.set_created(at);
    }
    file.set_times(times).map_err(|e| e.to_string())?;
    let mut permissions = file.metadata().map_err(|e| e.to_string())?.permissions();
    if permissions.readonly() != meta.permissions().readonly() {
        permissions.set_readonly(meta.permissions().readonly());
        fs::set_permissions(dest, permissions).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// ERROR_ACCESS_DENIED, which a file being deleted gives too until the last program lets go of it.
const ACCESS_DENIED: i32 = 5;
/// ERROR_SHARING_VIOLATION: another program has the file open.
const SHARING_VIOLATION: i32 = 32;
/// ERROR_LOCK_VIOLATION: another program has locked part of the file.
const LOCK_VIOLATION: i32 = 33;

/// Antivirus scans, Search and OneDrive open files for a moment, and a change then fails with ERROR_ACCESS_DENIED or
/// ERROR_SHARING_VIOLATION. Trying again after growing pauses gets past them within about two seconds.
pub fn retry<T>(mut step: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let started = Instant::now();
    let mut pause = Duration::from_millis(10);
    loop {
        match step() {
            Err(e)
                if matches!(e.raw_os_error(), Some(ACCESS_DENIED | SHARING_VIOLATION))
                    && started.elapsed() < Duration::from_secs(2) =>
            {
                thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_millis(250));
            }
            done => return done,
        }
    }
}

/// Access stays denied when Controlled Folder Access keeps Laci out of a protected folder, such as Documents, and
/// otherwise mostly while a program has a file open there.
pub fn explain(error: &io::Error, path: &Path) -> String {
    let name = path.file_name().unwrap_or(path.as_os_str()).to_string_lossy();
    match error.raw_os_error() {
        Some(SHARING_VIOLATION | LOCK_VIOLATION) => {
            format!("{name} is open in another program. Close it and try again.")
        }
        Some(ACCESS_DENIED) if ffi::controlled_folder_access() == Some(true) => {
            "Windows Security blocks Laci from changing this folder. Allow Laci in Windows Security › Virus & threat \
             protection › Ransomware protection."
                .into()
        }
        Some(ACCESS_DENIED) => {
            format!("Windows denied access to {name}. If it is open in another program, close it and try again.")
        }
        Some(code) if cloud_error(code) => format!(
            "The app that syncs {name}, such as OneDrive, didn't let Laci change it. Make sure that app is running, \
             choose Always keep on this device for the folder in File Explorer, and try again."
        ),
        _ => error.to_string(),
    }
}

/// The ERROR_CLOUD_FILE_… codes, which OneDrive and other apps that keep files online give through Windows, as when a
/// folder that is partly online moves out of OneDrive.
fn cloud_error(code: i32) -> bool {
    matches!(code, 358 | 362..=366 | 374..=383 | 386..=398 | 404 | 426 | 434 | 475)
}

/// The variables OneDrive sets to its folders: the personal one, and the one for work or school.
const ONEDRIVE: [&str; 3] = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"];

/// A junction holds the full path of where it leads, so the links pnpm and npm workspaces make in node_modules keep
/// leading to the old place. A folder that leaves OneDrive is downloaded first where it is only online, and one that
/// goes into OneDrive is uploaded.
pub fn move_notes(from: &Path, to: &Path) -> Vec<(&'static str, &'static str)> {
    let mut notes = Vec::new();
    if has_links(&from.join("node_modules"), true) {
        notes.push(("Reinstall dependencies after the move", "Links in node_modules still lead to the old place"));
    }
    let onedrive: Vec<PathBuf> =
        ONEDRIVE.into_iter().filter_map(std::env::var_os).map(PathBuf::from).filter(|p| p.is_absolute()).collect();
    let inside = |path: &Path| onedrive.iter().any(|root| contains(root, path));
    match (inside(from), inside(to)) {
        (true, false) => notes.push(("Leaves OneDrive", "Windows first downloads the files that are only online")),
        (false, true) => notes.push(("Goes into OneDrive", "OneDrive uploads it after the move")),
        _ => {}
    }
    notes
}

/// Whether `dir` holds a link or junction, with `scopes` also in a scope folder such as `@types`.
fn has_links(dir: &Path, scopes: bool) -> bool {
    fs::read_dir(dir).into_iter().flatten().flatten().take(5000).any(|entry| {
        entry.file_type().is_ok_and(|kind| kind.is_symlink())
            || (scopes && entry.file_name().as_encoded_bytes().starts_with(b"@") && has_links(&entry.path(), false))
    })
}

pub fn hidden_flag(meta: &Metadata) -> bool {
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

/// OneDrive marks a file that is only online with FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, or RECALL_ON_OPEN, and
/// FILE_ATTRIBUTE_OFFLINE marks one that other storage keeps elsewhere.
pub fn placeholder(meta: &Metadata) -> bool {
    meta.file_attributes()
        & (FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_OFFLINE)
        != 0
}

/// AppData holds apps' own files, and a Recycle Bin what was deleted.
pub fn system_folder(name: &OsStr) -> bool {
    name.eq_ignore_ascii_case("AppData") || name.eq_ignore_ascii_case("$Recycle.Bin")
}

/// FILE_FLAG_OPEN_REPARSE_POINT opens a link itself instead of what it leads to, and a link is refused. Other reparse
/// points, such as OneDrive's files, read right only through the driver that handles them, so such a file opens again
/// the usual way and counts only while it is still the same file.
pub fn open_nofollow(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
    let meta = file.metadata()?;
    if meta.is_symlink() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Laci doesn't read a file through a link"));
    }
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(file);
    }
    let again = OpenOptions::new().read(true).open(path)?;
    let (first, second) = (ffi::file_info(&file)?, ffi::file_info(&again)?);
    if (first.volume, first.file) != (second.volume, second.file) {
        return Err(io::Error::other("The file changed while Laci opened it"));
    }
    Ok(again)
}
