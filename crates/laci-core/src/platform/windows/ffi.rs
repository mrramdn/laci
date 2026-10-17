//! Calls into the Windows API that std doesn't make. Besides `recycle`, this is the only place for unsafe code, and
//! every unsafe block says why it is sound.
#![allow(unsafe_code)]
#![deny(clippy::undocumented_unsafe_blocks)]

use std::{io, iter, os::windows::ffi::OsStrExt, path::Path};
use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

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
