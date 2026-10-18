//! The Trash, and opening files, folders and links in the app macOS picks.
use crate::Result;
use std::path::Path;
use trash::{
    TrashContext,
    macos::{DeleteMethod, TrashContextExtMacos},
};

/// NSFileManager moves the item to the Trash of its volume. Asking Finder instead would first ask the user to let
/// Laci control Finder (Automation), only to add Put Back. Where a volume has no Trash, NSFileManager fails and the
/// item stays: it never deletes for good.
pub fn trash(path: &Path) -> Result<()> {
    let failed = |why: &str| format!("Couldn't move {} to the Trash: {why}", path.display());
    // The trash crate spells a path that isn't UTF-8 with %-escapes, which would name another item.
    if path.to_str().is_none() {
        return Err(failed("its name isn't valid text"));
    }
    let mut context = TrashContext::default();
    context.set_delete_method(DeleteMethod::NsFileManager);
    context.delete(path).map_err(|error| match error {
        // "While deleting '…', `trashItemAtURL` failed: " and then what macOS said.
        trash::Error::Unknown { description } => {
            failed(description.split_once("`trashItemAtURL` failed: ").map_or(description.as_str(), |(_, said)| said))
        }
        trash::Error::CanonicalizePath { .. } => failed("the folder it is in can't be opened"),
        other => failed(&format!("{other:?}")),
    })
}

/// `open` hands the target to Launch Services, which starts the app Finder would.
pub fn open(target: &str, cwd: &Path) -> Result<()> {
    crate::service::detach("/usr/bin/open", &[target.into()], cwd)
}
