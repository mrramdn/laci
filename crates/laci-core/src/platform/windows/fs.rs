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
    os::windows::fs::{FileTimesExt, FileTypeExt, MetadataExt, OpenOptionsExt},
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
/// too. Volumes without it give the 64-bit file index. file-id reads through a link, so a link itself, as `meta` from
/// `symlink_metadata` shows it, is read by [`link_stamp`].
pub fn identity(path: &Path, meta: &Metadata) -> Result<Identity> {
    if meta.is_symlink() {
        return Ok(link_stamp(path)?.identity);
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
/// another program's way. As with [`identity`], a link itself is read by [`link_stamp`].
pub fn change_stamp(path: &Path, meta: &Metadata) -> Result<Stamp> {
    if meta.is_symlink() {
        return link_stamp(path);
    }
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|e| e.to_string())?;
    stamp(&file)
}

/// The stamp of the link at `path` itself, a symlink or a junction such as pnpm fills node_modules with, as Linux and
/// macOS read a link's own inode. FILE_FLAG_OPEN_REPARSE_POINT opens the link, not what it leads to, and only its
/// attributes are read. A path that is no link by the time it opens was replaced after it was looked at, and is
/// refused.
fn link_stamp(path: &Path) -> Result<Stamp> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_symlink() {
        return Err("The link changed while Laci read it".into());
    }
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

/// std deletes a read-only file or folder only by the delete that ignores the attribute, which NTFS takes and FAT32
/// and exFAT refuse; Git makes its objects read-only. When that refusal stops the removal, the attribute comes off
/// whatever is left and the removal runs again.
pub fn remove_all(path: &Path) -> io::Result<()> {
    remove_with(path, |path, meta| {
        // Windows removes a link to a folder as a folder.
        if meta.is_dir() || meta.file_type().is_symlink_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
    })
}

/// [`remove_all`] by `remove`, the removal that FAT32 and exFAT stop at a read-only file. The walk passes links and
/// junctions by: a link is removed itself, and nothing it leads to is changed.
fn remove_with(path: &Path, remove: impl Fn(&Path, &Metadata) -> io::Result<()>) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    match remove(path, &meta) {
        Err(e) if e.raw_os_error() == Some(ACCESS_DENIED) && !meta.is_symlink() => {
            for entry in walkdir::WalkDir::new(path).follow_links(false) {
                let entry = entry?;
                let found = entry.metadata()?;
                if !found.is_symlink() && found.permissions().readonly() {
                    let mut permissions = found.permissions();
                    // Windows has no modes to widen: this takes off the read-only attribute alone.
                    #[allow(clippy::permissions_set_readonly_false)]
                    permissions.set_readonly(false);
                    fs::set_permissions(entry.path(), permissions)?;
                }
            }
            remove(path, &meta)
        }
        done => done,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_read_only(path: &Path) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions).unwrap();
    }

    /// FAT32 and exFAT, as on USB sticks, refuse to delete what is read-only, and std's delete then stops with
    /// ERROR_ACCESS_DENIED. NTFS doesn't, so a stand-in removes as they do. Git's objects are read-only, and here a folder
    /// too. A junction in the folder is removed itself: what it leads to keeps its attribute.
    #[test]
    fn what_is_read_only_goes_too_where_the_file_system_refuses_to_delete_it() {
        let temp = tempfile::tempdir().unwrap();
        let (tree, outside) = (temp.path().join("demo"), temp.path().join("outside"));
        let objects = tree.join(".git").join("objects").join("ab");
        fs::create_dir_all(&objects).unwrap();
        fs::create_dir(&outside).unwrap();
        for file in [objects.join("cdef"), outside.join("kept")] {
            fs::write(&file, "object").unwrap();
            make_read_only(&file);
        }
        make_read_only(&objects);
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(tree.join("linked"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        let fat = |path: &Path, _: &Metadata| -> io::Result<()> {
            for entry in walkdir::WalkDir::new(path) {
                if entry?.metadata()?.permissions().readonly() {
                    return Err(io::Error::from_raw_os_error(ACCESS_DENIED));
                }
            }
            fs::remove_dir_all(path)
        };
        let refused = fat(&tree, &fs::metadata(&tree).unwrap()).unwrap_err();
        assert_eq!(refused.raw_os_error(), Some(ACCESS_DENIED), "the stand-in refuses as FAT does");
        remove_with(&tree, fat).unwrap();
        assert!(!tree.exists());
        assert!(fs::metadata(outside.join("kept")).unwrap().permissions().readonly());
    }
}
