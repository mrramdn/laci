//! Calls into the Windows API that std doesn't make. Besides `recycle`, this is the only place for unsafe code, and
//! every unsafe block says why it is sound.
#![allow(unsafe_code)]
#![deny(clippy::undocumented_unsafe_blocks)]

use std::{
    fs::File,
    io, iter,
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::Path,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FILE_ID_INFO, FileBasicInfo, FileIdInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx, MoveFileExW,
};

/// `path` as the Windows API reads it: UTF-16 ending in a NUL.
fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "A path can't hold a NUL character"));
    }
    Ok(wide.into_iter().chain(iter::once(0)).collect())
}

/// Renames `src` to `dest`. Without MOVEFILE_REPLACE_EXISTING it fails when `dest` exists, and without
/// MOVEFILE_COPY_ALLOWED it never copies: on another volume it fails with ERROR_NOT_SAME_DEVICE.
pub fn move_file(src: &Path, dest: &Path) -> io::Result<()> {
    let (src, dest) = (wide(src)?, wide(dest)?);
    // SAFETY: both pointers come from NUL-terminated UTF-16 buffers that live until the call returns, and
    // MoveFileExW only reads them. The flags are 0: a plain rename.
    if unsafe { MoveFileExW(src.as_ptr(), dest.as_ptr(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// What Windows records about an open file: when it was last written and last changed, in 100-nanosecond steps since
/// 1601, and which file it is, as the volume serial number and file ID that the file-id crate reads.
pub struct FileInfo {
    pub written: i64,
    pub changed: i64,
    pub volume: u64,
    pub file: u128,
}

/// [`FileInfo`] for `file`, from FILE_BASIC_INFO and FILE_ID_INFO. A volume without FILE_ID_INFO gives the 64-bit file
/// index instead, as file-id does there too.
pub fn file_info(file: &File) -> io::Result<FileInfo> {
    let handle = file.as_raw_handle();
    let mut basic = FILE_BASIC_INFO::default();
    // SAFETY: `handle` stays open while `file` is borrowed, past the call. `basic` is the FILE_BASIC_INFO that
    // FileBasicInfo asks for, it lives until the call returns, and its exact size is passed, so the call writes inside
    // it. Every bit pattern is a valid FILE_BASIC_INFO.
    let read = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            (&raw mut basic).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut id = FILE_ID_INFO::default();
    // SAFETY: as above, with the FILE_ID_INFO that FileIdInfo asks for.
    let read = unsafe {
        GetFileInformationByHandleEx(handle, FileIdInfo, (&raw mut id).cast(), size_of::<FILE_ID_INFO>() as u32)
    };
    let (volume, index) = if read != 0 {
        (id.VolumeSerialNumber, u128::from_le_bytes(id.FileId.Identifier))
    } else {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: `handle` stays open as above, and `info` is a BY_HANDLE_FILE_INFORMATION that lives until the call
        // returns, which fills it in and nothing else.
        if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        (info.dwVolumeSerialNumber.into(), (u128::from(info.nFileIndexHigh) << 32) | u128::from(info.nFileIndexLow))
    };
    Ok(FileInfo { written: basic.LastWriteTime, changed: basic.ChangeTime, volume, file: index })
}
