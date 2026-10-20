//! The Recycle Bin. A delete that wouldn't land there must be refused, never done for good. The shell's own delete,
//! which the trash crate uses too, deletes an item for good without asking when it can't recycle it: on a network
//! drive, on a drive whose Recycle Bin is turned off, or when the item is too big for the bin. Here the shell is
//! asked through IFileOperation, and a check before every item stops any delete that wouldn't recycle. The known
//! folders Laci asks the shell for, such as Local AppData, come from here too.
//!
//! Besides `ffi`, this is the only place for unsafe code, and every unsafe block says why it is sound.
#![allow(unsafe_code)]
#![deny(clippy::undocumented_unsafe_blocks)]

use crate::Result;
use std::{
    ffi::{OsString, c_void},
    fmt::Display,
    fs,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering, fence},
    },
    thread,
};
use windows::{
    Win32::{
        Foundation::{E_ABORT, E_NOINTERFACE, E_POINTER, S_OK},
        System::Com::{
            CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance, CoInitializeEx,
            CoTaskMemFree, CoUninitialize,
        },
        UI::Shell::{
            FOF_ALLOWUNDO, FOF_NO_UI, FOFX_RECYCLEONDELETE, FOLDERID_LocalAppData, FileOperation, IFileOperation,
            IFileOperationProgressSink, IFileOperationProgressSink_Vtbl, IShellItem, KF_FLAG_DEFAULT,
            SHCreateItemFromParsingName, SHGetKnownFolderPath, TSF_DELETE_RECYCLE_IF_POSSIBLE,
        },
    },
    core::{GUID, HRESULT, HSTRING, IUnknown, IUnknown_Vtbl, Interface, PCWSTR},
};

/// The user's Local AppData folder as the shell knows it, whatever LOCALAPPDATA says: the folder Tauri keeps
/// WebView2's data in, and the one the uninstaller clears.
pub fn local_app_data() -> Result<PathBuf> {
    known_folder(&FOLDERID_LocalAppData).map_err(|e| format!("Couldn't find the Local AppData folder: {e}"))
}

/// The user's known folder `id`, as the shell knows it: where it is now, also when OneDrive has moved it.
pub fn known_folder(id: &GUID) -> windows::core::Result<PathBuf> {
    // SAFETY: the GUID outlives the call, and no token is passed, so the folder is this user's.
    let folder = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None) }?;
    // SAFETY: on success the shell gives a NUL-terminated string of its own, read once here.
    let path = PathBuf::from(OsString::from_wide(unsafe { folder.as_wide() }));
    // SAFETY: the shell made the string with CoTaskMemAlloc for the caller to free, and it isn't read after this.
    unsafe { CoTaskMemFree(Some(folder.0.cast_const().cast())) };
    Ok(path)
}

pub fn trash(path: &Path) -> Result<()> {
    // The shell reads a path up to its first NUL, and a relative one from a folder of its choosing: either could name
    // another item.
    if !path.is_absolute() || path.as_os_str().encode_wide().any(|unit| unit == 0) {
        return Err(format!("Couldn't move {} to the Recycle Bin: it isn't a full path", path.display()));
    }
    // The shell wants a single-threaded apartment, which the calling thread may have set up otherwise, or not at
    // all. A thread of its own leaves the caller's COM as it was.
    let item = path.to_owned();
    thread::Builder::new()
        .name("laci-recycle".into())
        .spawn(move || recycle(&item))
        .map_err(|e| format!("Couldn't move {} to the Recycle Bin: {e}", path.display()))?
        .join()
        .map_err(|_| format!("Couldn't move {} to the Recycle Bin", path.display()))?
}

fn recycle(path: &Path) -> Result<()> {
    let failed = |why: &dyn Display| format!("Couldn't move {} to the Recycle Bin: {why}", path.display());
    // SAFETY: the first COM call on this new thread, so no other apartment is set up on it, and the reserved
    // argument is null as required.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.ok().map_err(|e| failed(&e))?;
    let refused = Arc::new(AtomicBool::new(false));
    // The error is put into words now: it can hold a COM object of the shell's, which must go before COM does.
    let done = delete(path, &refused).map_err(|e| e.to_string());
    // SAFETY: balances the CoInitializeEx above on the same thread. Every COM object made since is released: those
    // `delete` made when it returned, and its error on the line above.
    unsafe { CoUninitialize() };
    if refused.load(Ordering::SeqCst) {
        return Err(format!(
            "Windows can't put {} in the Recycle Bin, so it stays where it is. Network and removable drives have no \
             Recycle Bin, and on other drives it can be turned off or too small for the item.",
            path.display()
        ));
    }
    match done {
        Err(e) => Err(failed(&e)),
        Ok(true) => Err(failed(&"Windows stopped it")),
        // PerformOperations has finished when it returns: an item still in its place was not moved.
        Ok(false) if fs::symlink_metadata(path).is_ok() => Err(failed(&"it is still in its place")),
        Ok(false) => Ok(()),
    }
}

/// Deletes `path` through the shell with [`Sink`] watching every item, and tells whether anything was stopped.
fn delete(path: &Path, refused: &Arc<AtomicBool>) -> windows::core::Result<bool> {
    // The shell doesn't take `\\?\` paths; where the plain spelling names the same item, it is used.
    let name = HSTRING::from(dunce::simplified(path));
    // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call, and no bind context is passed.
    let item: IShellItem = unsafe { SHCreateItemFromParsingName(&name, None) }?;
    // SAFETY: FileOperation is the shell's class for IFileOperation, made in this process; COM is set up on this
    // thread.
    let operation: IFileOperation = unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_ALL) }?;
    let sink = only_recycle(refused.clone());
    // SAFETY: calls on the live operation from the thread that made it. `sink` and `item` are live COM objects, and
    // the operation takes its own references to them for as long as it needs them.
    unsafe {
        // FOF_NO_UI answers every question the shell would ask with yes, "Delete it for good?" included; the sink
        // answers that one instead.
        operation.SetOperationFlags(FOF_ALLOWUNDO | FOF_NO_UI | FOFX_RECYCLEONDELETE)?;
        operation.Advise(&sink)?;
        operation.DeleteItem(&item, None)?;
        operation.PerformOperations()?;
        Ok(operation.GetAnyOperationsAborted()?.as_bool())
    }
}

/// The progress sink IFileOperation calls before and after each item. It lets a delete go ahead only when its item
/// goes to the Recycle Bin, and lets everything else pass. It is a COM object written out by hand, because the
/// `implement` macro would need the windows-core crate as a dependency of Laci's own: like every COM object, it
/// starts with a pointer to its table of methods, and frees itself on the last Release.
#[repr(C)]
struct Sink {
    vtable: &'static IFileOperationProgressSink_Vtbl,
    references: AtomicU32,
    /// Set once a delete was stopped because it wouldn't have recycled.
    refused: Arc<AtomicBool>,
}

/// A new [`Sink`] as IFileOperation takes it. The interface holds the one reference the sink starts with.
fn only_recycle(refused: Arc<AtomicBool>) -> IFileOperationProgressSink {
    let sink = Box::into_raw(Box::new(Sink { vtable: &VTABLE, references: AtomicU32::new(1), refused }));
    // SAFETY: `sink` points to a live Sink laid out as a COM object, with one reference, which goes to the interface;
    // dropping the interface calls Release.
    unsafe { IFileOperationProgressSink::from_raw(sink.cast()) }
}

static VTABLE: IFileOperationProgressSink_Vtbl = IFileOperationProgressSink_Vtbl {
    base__: IUnknown_Vtbl { QueryInterface: query_interface, AddRef: add_ref, Release: release },
    StartOperations: start_operations,
    FinishOperations: finish_operations,
    PreRenameItem: pre_rename_or_new_item,
    PostRenameItem: post_rename_item,
    PreMoveItem: pre_move_or_copy_item,
    PostMoveItem: post_move_or_copy_item,
    PreCopyItem: pre_move_or_copy_item,
    PostCopyItem: post_move_or_copy_item,
    PreDeleteItem: pre_delete_item,
    PostDeleteItem: post_delete_item,
    PreNewItem: pre_rename_or_new_item,
    PostNewItem: post_new_item,
    UpdateProgress: update_progress,
    ResetTimer: start_operations,
    PauseTimer: start_operations,
    ResumeTimer: start_operations,
};

/// The sink as IUnknown or IFileOperationProgressSink, the only two interfaces it has.
unsafe extern "system" fn query_interface(this: *mut c_void, iid: *const GUID, out: *mut *mut c_void) -> HRESULT {
    if iid.is_null() || out.is_null() {
        return E_POINTER;
    }
    // SAFETY: COM passes an IID to read and a place to write the interface to, both checked for null above, and
    // `this` is a live Sink.
    unsafe {
        if *iid == IUnknown::IID || *iid == IFileOperationProgressSink::IID {
            *out = this;
            add_ref(this);
            S_OK
        } else {
            *out = std::ptr::null_mut();
            E_NOINTERFACE
        }
    }
}

unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
    // SAFETY: `this` is a Sink made by `only_recycle`, alive as long as its caller holds a reference to it.
    let sink = unsafe { &*this.cast::<Sink>() };
    sink.references.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn release(this: *mut c_void) -> u32 {
    // SAFETY: as in `add_ref`.
    let left = unsafe { &*this.cast::<Sink>() }.references.fetch_sub(1, Ordering::Release) - 1;
    if left == 0 {
        fence(Ordering::Acquire);
        // SAFETY: that was the last reference, so nothing uses the Sink any more, and it came from Box::into_raw.
        drop(unsafe { Box::from_raw(this.cast::<Sink>()) });
    }
    left
}

/// The shell sets TSF_DELETE_RECYCLE_IF_POSSIBLE before a delete that recycles. Without it the item would be gone for
/// good, so the delete is stopped before it starts.
unsafe extern "system" fn pre_delete_item(this: *mut c_void, flags: u32, _item: *mut c_void) -> HRESULT {
    if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 != 0 {
        return S_OK;
    }
    // SAFETY: as in `add_ref`.
    unsafe { &*this.cast::<Sink>() }.refused.store(true, Ordering::SeqCst);
    E_ABORT
}

// The other calls only tell how things went, and each lets the operation go on.
extern "system" fn start_operations(_this: *mut c_void) -> HRESULT {
    S_OK
}
extern "system" fn finish_operations(_this: *mut c_void, _result: HRESULT) -> HRESULT {
    S_OK
}
extern "system" fn pre_rename_or_new_item(
    _this: *mut c_void,
    _flags: u32,
    _item: *mut c_void,
    _name: PCWSTR,
) -> HRESULT {
    S_OK
}
extern "system" fn post_rename_item(
    _this: *mut c_void,
    _flags: u32,
    _item: *mut c_void,
    _name: PCWSTR,
    _result: HRESULT,
    _created: *mut c_void,
) -> HRESULT {
    S_OK
}
extern "system" fn pre_move_or_copy_item(
    _this: *mut c_void,
    _flags: u32,
    _item: *mut c_void,
    _folder: *mut c_void,
    _name: PCWSTR,
) -> HRESULT {
    S_OK
}
extern "system" fn post_move_or_copy_item(
    _this: *mut c_void,
    _flags: u32,
    _item: *mut c_void,
    _folder: *mut c_void,
    _name: PCWSTR,
    _result: HRESULT,
    _created: *mut c_void,
) -> HRESULT {
    S_OK
}
extern "system" fn post_delete_item(
    _this: *mut c_void,
    _flags: u32,
    _item: *mut c_void,
    _result: HRESULT,
    _created: *mut c_void,
) -> HRESULT {
    S_OK
}
// The shell's method has these eight arguments.
#[allow(clippy::too_many_arguments)]
extern "system" fn post_new_item(
    _this: *mut c_void,
    _flags: u32,
    _folder: *mut c_void,
    _name: PCWSTR,
    _template: PCWSTR,
    _attributes: u32,
    _result: HRESULT,
    _created: *mut c_void,
) -> HRESULT {
    S_OK
}
extern "system" fn update_progress(_this: *mut c_void, _total: u32, _done: u32) -> HRESULT {
    S_OK
}
