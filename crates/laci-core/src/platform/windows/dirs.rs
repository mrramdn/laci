//! Where Laci keeps its settings, data and cache on Windows, and where the user's home is.
use super::recycle::local_app_data;
use crate::{
    Result,
    platform::{Dirs, path::canonical},
};
use std::path::{Path, PathBuf};

/// The user's profile folder: USERPROFILE, or the profile Windows has for the user when that is unset. HOME is never
/// read: Windows doesn't set it, and the one Git Bash sets is a POSIX path such as /c/Users/me.
pub fn home_dir() -> Option<PathBuf> {
    std::env::home_dir()
}

/// The bundle identifier, which names the app's folder in Local AppData. Tauri keeps WebView2's data (EBWebView)
/// there too, and the uninstaller's "Delete app data" removes the folder.
const APP: &str = "io.github.mrramdn.laci";

/// Everything sits in the app's folder in Local AppData: config.json in it, then `data` and `cache`. Local, not
/// Roaming: the settings name this computer's folders, and the journals and Undo copies are large. `home` plays no
/// part.
pub fn user_dirs(_home: &Path) -> Result<Dirs> {
    let local = local_app_data()?;
    // Spelled as the files in it will be, without short names, so a path Laci reads there is seen as inside.
    let config = canonical(&local)
        .map_err(|e| format!("Couldn't open the Local AppData folder {}: {e}", local.display()))?
        .join(APP);
    Ok(Dirs { data: config.join("data"), cache: config.join("cache"), config })
}
