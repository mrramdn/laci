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

/// Where Controlled Folder Access is set up: by a policy, which comes first, and in Windows Security.
const CONTROLLED_FOLDER_ACCESS: [&str; 2] = [
    r"SOFTWARE\Policies\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access",
    r"SOFTWARE\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access",
];

/// Whether Controlled Folder Access blocks changes to protected folders, as a policy sets it or else Windows Security:
/// EnableControlledFolderAccess is 1 then, while 2 only audits. None when neither says, as when the setting can't be
/// read.
pub fn controlled_folder_access() -> Option<bool> {
    let name = wide(Path::new("EnableControlledFolderAccess")).ok()?;
    CONTROLLED_FOLDER_ACCESS.iter().find_map(|key| {
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

/// The folders a policy or Windows Security adds to those Controlled Folder Access protects: the names of the values
/// under its ProtectedFolders keys. A key that can't be read adds none.
pub fn protected_folders() -> Vec<std::path::PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::System::Registry::{HKEY, KEY_QUERY_VALUE, RegCloseKey, RegEnumValueW, RegOpenKeyExW};
    let mut folders = Vec::new();
    // The longest name a value can have, 16,383 characters, and its NUL.
    let mut name = vec![0u16; 16_384];
    for key in CONTROLLED_FOLDER_ACCESS {
        let Ok(key) = wide(&Path::new(key).join("ProtectedFolders")) else { continue };
        let mut handle: HKEY = ptr::null_mut();
        // SAFETY: `key` is a NUL-terminated UTF-16 buffer that lives until the call returns, which only reads it, and
        // `handle` is an HKEY that lives until it returns, where the call puts the key it opened.
        if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, key.as_ptr(), 0, KEY_QUERY_VALUE, &mut handle) } != 0 {
            continue;
        }
        for index in 0.. {
            let mut length = name.len() as u32;
            // SAFETY: `handle` is the key opened above, still open. `name` lives until the call returns and holds
            // `length` UTF-16 units, the most the call writes, its NUL included; `length` is a u32 that lives until it
            // returns, where the call puts how many it wrote. Nothing else is asked for, so the other pointers are
            // null.
            let status = unsafe {
                RegEnumValueW(
                    handle,
                    index,
                    name.as_mut_ptr(),
                    &mut length,
                    ptr::null(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            // ERROR_NO_MORE_ITEMS ends the list, and so does any error.
            if status != 0 {
                break;
            }
            let written = name.get(..length as usize).unwrap_or_default();
            folders.push(OsString::from_wide(written).into());
        }
        // SAFETY: `handle` is the key opened above, closed once here and not used after.
        unsafe { RegCloseKey(handle) };
    }
    folders
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

use std::{
    ffi::OsString,
    fs::OpenOptions,
    os::windows::{
        ffi::OsStringExt,
        fs::OpenOptionsExt,
        io::{FromRawHandle, OwnedHandle},
    },
    path::PathBuf,
};
use windows_sys::{
    Wdk::Storage::FileSystem::{FileProcessIdsUsingFileInformation, NtQueryInformationFile},
    Win32::{
        Foundation::{
            ERROR_INVALID_PARAMETER, STATUS_BUFFER_OVERFLOW, STATUS_INFO_LENGTH_MISMATCH, STATUS_SUCCESS, WAIT_OBJECT_0,
        },
        Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        },
        System::{
            IO::IO_STATUS_BLOCK,
            Threading::{
                OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                QueryFullProcessImageNameW, WaitForSingleObject,
            },
        },
    },
};

/// The processes that have the file at `path` open, reading or writing alike, as NTFS lists them
/// (FileProcessIdsUsingFileInformation). The file is opened only to read its attributes and shares everything, so it
/// is the file `path` names, a link itself rather than where it leads, and no other program's open, read or write
/// fails because of the question. NTFS still counts that open as any other while it lasts, which is one query: a
/// program that replaces the file meanwhile by renaming another file onto it, or that creates it anew after deleting
/// it without POSIX semantics, can fail with ERROR_ACCESS_DENIED. A file system that can't list them, as some network
/// shares can't, is an error.
pub fn processes_using(path: &Path) -> io::Result<Vec<u32>> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    // Room for this many processes at first, and four times as many again after an answer that doesn't fit, a few
    // times at most.
    let mut room = 64;
    for _ in 0..4 {
        // FILE_PROCESS_IDS_USING_FILE_INFORMATION: a u32 count, then the ids, a usize each, from the second usize on.
        // The count starts as all ones, more than there is room for, so an answer that doesn't write it is refused.
        let mut found = vec![0usize; 1 + room];
        found[0] = usize::MAX;
        let size =
            u32::try_from(size_of_val(found.as_slice())).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut status = IO_STATUS_BLOCK::default();
        // SAFETY: the handle stays open while `file` lives, past the call. `found` lives until the call returns, is
        // aligned for usize as the structure needs and `size` bytes long, so the call writes inside it, and `status`
        // is an IO_STATUS_BLOCK that lives until it returns. The handle isn't open for overlapped I/O, so nothing is
        // written once the call has returned.
        let answer = unsafe {
            NtQueryInformationFile(
                file.as_raw_handle(),
                &mut status,
                found.as_mut_ptr().cast(),
                size,
                FileProcessIdsUsingFileInformation,
            )
        };
        match answer {
            STATUS_SUCCESS => {
                let [a, b, c, d, ..] = found[0].to_ne_bytes();
                let count = usize::try_from(u32::from_ne_bytes([a, b, c, d])).unwrap_or(usize::MAX);
                let ids =
                    found.get(1..=count).ok_or_else(|| io::Error::other("NTFS listed more processes than fit"))?;
                return ids
                    .iter()
                    .map(|&id| u32::try_from(id).map_err(|_| io::Error::other("Not a process id")))
                    .collect();
            }
            STATUS_INFO_LENGTH_MISMATCH | STATUS_BUFFER_OVERFLOW => room *= 4,
            answer => {
                return Err(io::Error::other(format!(
                    "NTFS couldn't list the processes using a file ({answer:#010x})"
                )));
            }
        }
    }
    Err(io::Error::other("The list of processes using a file kept growing"))
}

/// What Windows tells of the program a process runs, in [`process_program`].
pub enum Program {
    /// The program, as Windows recorded it when the process started.
    Known(PathBuf),
    /// No process has the id any more, or the one that has it has ended.
    Ended,
    /// The process hasn't ended but doesn't tell its program: one that is ending no longer can for a while, before
    /// Windows marks it ended, and some of Windows' own processes never can.
    Untold,
}

/// What Windows tells of the program process `pid` runs. The handle it is asked through keeps the id from going to
/// another process meanwhile. A process Laci may not open, as it may not one of another user's, is an error.
pub fn process_program(pid: u32) -> io::Result<Program> {
    // SAFETY: OpenProcess reads no memory of Laci's: it takes the rights wanted, whether the handle is inherited (no)
    // and the id.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        // ERROR_INVALID_PARAMETER: no process has this id now.
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(Program::Ended)
        } else {
            Err(error)
        };
    }
    // SAFETY: `handle` is the process handle OpenProcess just opened, which nothing else has, so `process` owns it and
    // closes it once, when dropped.
    let process = unsafe { OwnedHandle::from_raw_handle(handle) };
    // The longest path Windows has, in UTF-16 units.
    let mut length: u32 = 32_768;
    let mut name = vec![0u16; length as usize];
    // SAFETY: the handle stays open while `process` lives, past the call. `name` lives until the call returns and holds
    // `length` UTF-16 units, the most the call writes, its NUL included; `length` is a u32 that lives until it returns,
    // and the call puts there how many units it wrote.
    let read = unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), PROCESS_NAME_WIN32, name.as_mut_ptr(), &mut length)
    };
    // Asked after the program, so a process that ended meanwhile counts as ended, whatever it told.
    // SAFETY: the handle stays open while `process` lives and has SYNCHRONIZE, which waiting on it needs. The wait
    // takes no time: it only tells whether the process has ended.
    if unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
        return Ok(Program::Ended);
    }
    if read == 0 {
        return Ok(Program::Untold);
    }
    name.truncate(length as usize);
    Ok(Program::Known(PathBuf::from(OsString::from_wide(&name))))
}

use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS, ERROR_UNSUPPORTED_TYPE, LPARAM},
    System::Registry::{
        HKEY_CURRENT_USER, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
        RegSetKeyValueW,
    },
    UI::WindowsAndMessaging::{HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE},
};

/// The key under HKEY_CURRENT_USER that holds the user's environment variables.
pub const ENVIRONMENT: &str = "Environment";
/// The Path's name in such a key.
const PATH: &str = "Path";

/// How the registry keeps the user's Path: REG_EXPAND_SZ, whose %VARIABLES% Windows fills in when it builds the
/// environment, as Windows writes it, or REG_SZ.
pub type PathKind = REG_VALUE_TYPE;
/// The kind a Path Laci makes gets.
pub const EXPANDABLE: PathKind = REG_EXPAND_SZ;

/// The Path in `key`, a key under HKEY_CURRENT_USER ([`ENVIRONMENT`] for the user's), as the registry keeps it: in
/// UTF-16 without its ending NUL, with its kind; None when there is none. Its %VARIABLES% stay as written. A Path that
/// isn't text is an error.
pub fn read_path(key: &str) -> io::Result<Option<(Vec<u16>, PathKind)>> {
    let (key, name) = (wide(Path::new(key))?, wide(Path::new(PATH))?);
    // RRF_NOEXPAND, or the call would fill the variables in; text only.
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    let failed = |status| match status {
        ERROR_UNSUPPORTED_TYPE => io::Error::new(io::ErrorKind::InvalidData, "it isn't text"),
        status => io::Error::from_raw_os_error(status as i32),
    };
    // A Path that grows between asking its size and reading it is asked for again.
    for _ in 0..4 {
        let (mut kind, mut size) = (0, 0u32);
        // SAFETY: `key` and `name` are NUL-terminated UTF-16 buffers that live until the call returns, which only reads
        // them. Without a buffer the call writes nothing but the value's kind into `kind` and its size in bytes into
        // `size`, a REG_VALUE_TYPE and a u32 that live until it returns.
        let status = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), flags, &mut kind, ptr::null_mut(), &mut size)
        };
        match status {
            ERROR_SUCCESS => {}
            ERROR_FILE_NOT_FOUND => return Ok(None),
            status => return Err(failed(status)),
        }
        // One more unit, for the ending NUL the call adds to a value stored without one.
        let mut value = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut room =
            u32::try_from(size_of_val(value.as_slice())).map_err(|_| io::Error::other("The Path is too long"))?;
        // SAFETY: as above, and `value` lives until the call returns and holds `room` bytes, the most the call writes.
        // The call puts the bytes it wrote, the ending NUL among them, into `room`.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                &mut kind,
                value.as_mut_ptr().cast(),
                &mut room,
            )
        };
        match status {
            ERROR_SUCCESS => {
                value.truncate(room as usize / 2);
                while value.last() == Some(&0) {
                    value.pop();
                }
                return Ok(Some((value, kind)));
            }
            ERROR_MORE_DATA => continue,
            ERROR_FILE_NOT_FOUND => return Ok(None),
            status => return Err(failed(status)),
        }
    }
    Err(io::Error::other("The Path kept changing while Laci read it"))
}

/// Writes `value` as the Path in `key`, a key under HKEY_CURRENT_USER, of the kind `kind`: REG_EXPAND_SZ or REG_SZ.
/// The key is made when it isn't there.
pub fn write_path(key: &str, value: &str, kind: PathKind) -> io::Result<()> {
    if ![REG_EXPAND_SZ, REG_SZ].contains(&kind) || value.contains('\0') {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let (key, name) = (wide(Path::new(key))?, wide(Path::new(PATH))?);
    let data: Vec<u16> = value.encode_utf16().chain(iter::once(0)).collect();
    let size = u32::try_from(size_of_val(data.as_slice())).map_err(|_| io::Error::other("The Path is too long"))?;
    // SAFETY: `key`, `name` and `data` are NUL-terminated UTF-16 buffers that live until the call returns, which only
    // reads them; `size` is `data`'s length in bytes, its NUL included, as REG_SZ and REG_EXPAND_SZ values hold it.
    let status =
        unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), kind, data.as_ptr().cast(), size) };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}

/// Tells the running programs, Explorer among them, that the user's environment changed, so the programs they start
/// from now on get the new Path. Each window gets 5 seconds, and one that hangs is passed over.
pub fn environment_changed() -> io::Result<()> {
    let area = wide(Path::new(ENVIRONMENT))?;
    let mut answer = 0usize;
    // SAFETY: `area` is a NUL-terminated UTF-16 buffer, the text WM_SETTINGCHANGE takes as its lParam, that lives until
    // the call returns; Windows copies it for windows of other programs, and the call returns only after each window
    // has answered, hung or waited out its time. `answer` is a usize that lives until the call returns.
    let sent = unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            area.as_ptr() as LPARAM,
            SMTO_ABORTIFHUNG,
            5000,
            &mut answer,
        )
    };
    if sent == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CreateProcessW, DETACHED_PROCESS, PROCESS_INFORMATION, STARTUPINFOW,
};

/// See [`crate::platform::start_detached`]; `args` are plain words already. std's Command can't do this: it always
/// lets a new process inherit every handle of this one's that may be inherited, among them the pipes a caller gave
/// this one for its output, which the new process would then hold open as long as it runs.
pub fn start_detached(program: &Path, args: &[&str], dir: &Path) -> io::Result<()> {
    let (application, dir) = (wide(program)?, wide(dir)?);
    // The program in quotes, which no Windows path holds, then the words.
    let mut line: Vec<u16> = iter::once(u16::from(b'"'))
        .chain(program.as_os_str().encode_wide())
        .chain(iter::once(u16::from(b'"')))
        .chain(args.iter().flat_map(|arg| iter::once(u16::from(b' ')).chain(arg.encode_utf16())))
        .chain(iter::once(0))
        .collect();
    let startup = STARTUPINFOW {
        cb: u32::try_from(size_of::<STARTUPINFOW>()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?,
        ..Default::default()
    };
    let mut started = PROCESS_INFORMATION::default();
    // SAFETY: `application` and `dir` are NUL-terminated UTF-16 buffers that live until the call returns, which only
    // reads them; `line` is one too, and mutable, as the call may write inside it. No security attributes and no
    // environment of its own: it gets this process's. bInheritHandles is FALSE, so the new process gets no handle of
    // this one's, and `startup` gives it none either (dwFlags 0). DETACHED_PROCESS: no console, neither this one's nor
    // a new one; CREATE_NEW_PROCESS_GROUP: Ctrl+C here doesn't reach it. `startup` is a STARTUPINFOW whose size `cb`
    // gives, and `started` a PROCESS_INFORMATION; both live until the call returns, which fills in only `started`.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            ptr::null(),
            dir.as_ptr(),
            &startup,
            &mut started,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateProcessW opened both handles for this process alone, and nothing else has them: each is owned here
    // once, and closed when dropped. Laci doesn't wait for the process, and closing them doesn't end it.
    drop(unsafe { (OwnedHandle::from_raw_handle(started.hProcess), OwnedHandle::from_raw_handle(started.hThread)) });
    Ok(())
}
