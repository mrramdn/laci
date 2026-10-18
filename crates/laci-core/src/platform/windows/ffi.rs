//! Calls into the Windows API that std doesn't make. Besides `recycle`, this is the only place for unsafe code, and
//! every unsafe block says why it is sound.
#![allow(unsafe_code)]
#![deny(clippy::undocumented_unsafe_blocks)]

use std::{
    fs::File,
    io, iter,
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::Path,
    ptr,
};
use windows_sys::Win32::{
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FILE_ID_INFO, FileBasicInfo, FileIdInfo,
        GetFileInformationByHandle, GetFileInformationByHandleEx, MoveFileExW,
    },
    System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RegGetValueW},
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

/// Whether Controlled Folder Access blocks changes to protected folders, as a policy sets it or else Windows Security:
/// EnableControlledFolderAccess is 1 then, while 2 only audits. None when neither says, as when the setting can't be
/// read.
pub fn controlled_folder_access() -> Option<bool> {
    const KEYS: [&str; 2] = [
        r"SOFTWARE\Policies\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access",
        r"SOFTWARE\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access",
    ];
    let name = wide(Path::new("EnableControlledFolderAccess")).ok()?;
    KEYS.iter().find_map(|key| {
        let key = wide(Path::new(key)).ok()?;
        let (mut mode, mut size) = (0u32, size_of::<u32>() as u32);
        // SAFETY: `key` and `name` are NUL-terminated UTF-16 buffers that live until the call returns, which only
        // reads them. With RRF_RT_REG_DWORD the call writes nothing but a 4-byte DWORD, into `mode`, a u32 that lives
        // until it returns and whose size `size` gives; the value's type isn't asked for.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                ptr::null_mut(),
                (&raw mut mode).cast(),
                &mut size,
            )
        };
        (status == 0).then_some(mode == 1)
    })
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

use windows_sys::Win32::{
    Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS},
    System::RestartManager::{
        CCH_RM_SESSION_KEY, RM_PROCESS_INFO, RM_UNIQUE_PROCESS, RmEndSession, RmGetList, RmRegisterResources,
        RmStartSession,
    },
};

/// A Restart Manager session, which tells which processes have the files registered with it open. Windows answers
/// from what it knows of each file, without opening it for reading or writing, so a program that writes to one
/// meanwhile can't fail because of the question. Windows allows only so many sessions at once, so dropping this ends
/// it, also on every early return.
pub struct RestartSession(u32);

/// What [`RestartSession::list`] found: each process that has a registered file open, as its id and start time, and
/// Restart Manager's reboot reasons (RM_REBOOT_REASON bits), which also tell what it couldn't look into.
pub struct InUse {
    pub processes: Vec<RM_UNIQUE_PROCESS>,
    pub reasons: u32,
}

impl RestartSession {
    /// A new session. Any failure is an error, also when as many sessions run as Windows allows.
    pub fn start() -> io::Result<Self> {
        let (mut handle, mut key) = (0, [0u16; CCH_RM_SESSION_KEY as usize + 1]);
        // SAFETY: `handle` and `key` live until the call returns. `key` has room for the CCH_RM_SESSION_KEY
        // characters of the session key and its NUL, all the call writes there, and the flags must be 0.
        let error = unsafe { RmStartSession(&mut handle, 0, key.as_mut_ptr()) };
        if error != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        Ok(Self(handle))
    }

    /// Registers the files `names` name, each in UTF-16 without the NUL that ends it, in one call. Restart Manager
    /// reads each name as Windows does, so the caller spells it for that. Called again, it adds to what the session
    /// has.
    pub fn register(&mut self, names: &[Vec<u16>]) -> io::Result<()> {
        let names = names.iter().map(|name| terminated(name)).collect::<io::Result<Vec<_>>>()?;
        let pointers: Vec<*const u16> = names.iter().map(|name| name.as_ptr()).collect();
        let count = u32::try_from(pointers.len()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: `pointers` holds `count` pointers, each to a NUL-terminated UTF-16 buffer in `names`, and both live
        // until the call returns, which only reads them. No processes or services are registered, so those arrays
        // are null, with a count of 0.
        let error = unsafe { RmRegisterResources(self.0, count, pointers.as_ptr(), 0, ptr::null(), 0, ptr::null()) };
        if error != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        Ok(())
    }

    /// The processes that have a registered file open. One that opens a file between the call that counts them and
    /// the call that lists them leaves the list too small, so it is asked for again with more room, a few times at
    /// most. Called again, it looks again.
    pub fn list(&self) -> io::Result<InUse> {
        let mut room = 0;
        for _ in 0..4 {
            let mut found = vec![RM_PROCESS_INFO::default(); room as usize];
            let (mut needed, mut filled, mut reasons) = (0, room, 0);
            let buffer = if found.is_empty() { ptr::null_mut() } else { found.as_mut_ptr() };
            // SAFETY: `needed`, `filled` and `reasons` live until the call returns. `buffer` is null while `filled`
            // is 0, and otherwise points to `found`, which lives until the call returns and holds `filled`
            // RM_PROCESS_INFO, so the call writes inside it. Every bit pattern is a valid RM_PROCESS_INFO.
            let error = unsafe { RmGetList(self.0, &mut needed, &mut filled, buffer, &mut reasons) };
            match error {
                ERROR_SUCCESS => {
                    found.truncate(filled as usize);
                    return Ok(InUse { processes: found.iter().map(|info| info.Process).collect(), reasons });
                }
                ERROR_MORE_DATA => room = needed.saturating_add(8),
                error => return Err(io::Error::from_raw_os_error(error as i32)),
            }
        }
        Err(io::Error::other("The list of processes kept growing"))
    }
}

impl Drop for RestartSession {
    fn drop(&mut self) {
        // SAFETY: RmEndSession takes the handle by value and reads no memory of Laci's. The handle is the session
        // `start` began, and only this ends it.
        unsafe { RmEndSession(self.0) };
    }
}

/// `name` with the NUL that ends a string for the Windows API. An empty name names no file, and a NUL inside one would
/// end it early, so either is an error.
fn terminated(name: &[u16]) -> io::Result<Vec<u16>> {
    if name.is_empty() || name.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "A file name is empty or holds a NUL character"));
    }
    Ok(name.iter().copied().chain(iter::once(0)).collect())
}
