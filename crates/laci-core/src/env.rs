use crate::platform::{self, Dirs};
use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
};

/// Locations owned by one installation, injectable for demos and tests.
#[derive(Debug, Clone)]
pub struct Env {
    pub home: PathBuf,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    /// One-run app overrides (`terminal`, `editor`, `files`), from LACI_TERMINAL, LACI_EDITOR and LACI_FILES.
    pub app_overrides: std::collections::HashMap<&'static str, String>,
    /// The installed Laci program: what an agent is told to run as its MCP server (see `program_for`).
    pub program: PathBuf,
}

impl Env {
    pub fn for_home(home: PathBuf) -> Self {
        let Dirs { config, data, cache } = Dirs::inside(&home);
        Self {
            config_dir: config,
            data_dir: data,
            cache_dir: cache,
            app_overrides: Default::default(),
            program: PathBuf::from("laci"),
            home,
        }
    }

    pub fn from_process() -> crate::Result<Self> {
        let home = std::env::var_os("LACI_HOME")
            .map(PathBuf::from)
            .or_else(platform::home_dir)
            .filter(|p| p.is_absolute())
            .ok_or("Set HOME to an absolute folder path")?;
        // Home is kept as given, as it always has been.
        let mut env = Self::for_home(home);
        if let Ok(exe) = std::env::current_exe() {
            let (image, appdir) = (std::env::var_os("APPIMAGE"), std::env::var_os("APPDIR"));
            let runs = runs_from_appimage(&exe, image.as_deref(), appdir.as_deref());
            env.program = program_for(exe, image.filter(|_| runs).map(PathBuf::from));
        }
        for (key, var) in [("terminal", "LACI_TERMINAL"), ("editor", "LACI_EDITOR"), ("files", "LACI_FILES")] {
            if let Some(v) = std::env::var(var).ok().filter(|s| !s.is_empty()) {
                env.app_overrides.insert(key, v);
            }
        }
        // LACI_HOME isolates a demo without changing the caller's HOME or XDG settings.
        if std::env::var_os("LACI_HOME").is_none() {
            let Dirs { config, data, cache } = platform::user_dirs(&env.home)?;
            (env.config_dir, env.data_dir, env.cache_dir) = (config, data, cache);
        }
        Ok(env)
    }

    /// Why no agent may be told to start [`Env::program`], which would be gone once Laci quits: Laci runs from the
    /// folder of an AppImage it couldn't make sure of ([`runs_from_appimage`]). None when the program stays.
    pub fn fleeting(&self) -> Option<&'static str> {
        self.program.ancestors().nth(3).is_some_and(appimage_folder).then_some(
            "Laci can't tell which AppImage file it runs from, and the folder it runs in is gone once it quits. \
             Start Laci from its AppImage file, then connect it again.",
        )
    }
}

/// What agents start as Laci's MCP server, for the Laci program running from `exe`: `appimage`, the AppImage Laci
/// runs from ([`runs_from_appimage`]), since the folder it runs in is gone once it closes and the file stays. Else
/// `exe`.
fn program_for(exe: PathBuf, appimage: Option<PathBuf>) -> PathBuf {
    appimage.unwrap_or(exe)
}

/// Whether `exe` runs from the AppImage `appimage` names: from inside the folder the AppImage runtime mounted or
/// unpacked it to (`appdir`, named `.mount_*` or `appimage_extracted_*`). A program started from another AppImage,
/// such as a terminal, inherits both variables, and Laci must never put itself in that program's file, nor tell an
/// agent to start that program as Laci.
pub fn runs_from_appimage(exe: &Path, appimage: Option<&OsStr>, appdir: Option<&OsStr>) -> bool {
    let (Some(image), Some(dir)) = (appimage.map(Path::new), appdir.map(Path::new)) else {
        return false;
    };
    // An AppImage keeps Laci at usr/bin/laci in its folder. The runtime names that folder as TMPDIR spells it, and Linux
    // names the running program with every link followed, so a TMPDIR that leads through a link is followed too.
    let folder = exe.ancestors().nth(3);
    let inside = folder == Some(dir) || fs::canonicalize(dir).is_ok_and(|dir| folder == Some(dir.as_path()));
    image.is_absolute() && image.is_file() && appimage_folder(dir) && inside
}

/// Whether `dir` is named as the AppImage runtime names the folder it mounts an AppImage at, or unpacks it to: a
/// folder that is gone once the program in it quits.
fn appimage_folder(dir: &Path) -> bool {
    dir.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".mount_") || name.starts_with("appimage_extracted_"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file at `path`, with its folders.
    fn file(path: &Path) -> PathBuf {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
        path.to_owned()
    }

    #[test]
    fn agents_start_the_appimage_or_the_program_itself() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        // The AppImage Laci runs from, else the program itself.
        let mounted = root.join(".mount_LaciAbC").join("usr").join("bin").join("laci");
        let image = root.join("Laci.AppImage");
        assert_eq!(program_for(mounted.clone(), Some(image.clone())), image);
        assert_eq!(program_for(mounted.clone(), None), mounted);
    }

    #[test]
    fn only_the_appimage_laci_runs_from_counts() {
        let image = tempfile::NamedTempFile::new().unwrap();
        let image = Some(image.path().as_os_str());
        let laci = Path::new("/tmp/.mount_LaciAbC/usr/bin/laci");
        for (exe, appimage, appdir, expected) in [
            (laci, image, Some("/tmp/.mount_LaciAbC"), true),
            (Path::new("/tmp/appimage_extracted_9f2/usr/bin/laci"), image, Some("/tmp/appimage_extracted_9f2"), true),
            // Started from a terminal that is an AppImage: both variables are the terminal's.
            (Path::new("/home/me/squashfs-root/usr/bin/laci"), image, Some("/tmp/.mount_kittyXy"), false),
            (laci, image, Some("/tmp/.mount_kittyXy"), false),
            (laci, image, Some("/home/me/apps/laci"), false),
            (laci, image, None, false),
            (laci, None, Some("/tmp/.mount_LaciAbC"), false),
            (laci, Some(OsStr::new("/nowhere/Laci.AppImage")), Some("/tmp/.mount_LaciAbC"), false),
        ] {
            let appdir = appdir.map(OsStr::new);
            assert_eq!(runs_from_appimage(exe, appimage, appdir), expected, "{exe:?} {appdir:?}");
        }
    }

    #[test]
    fn an_appimage_folder_reached_through_a_link_is_the_one_laci_runs_from() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        // TMPDIR=$HOME/tmp where /home leads to /var/home: the runtime names the folder through the link, Linux names
        // the program without it.
        let mounted = root.join("var").join("tmp").join(".mount_LaciAbC");
        let exe = file(&mounted.join("usr").join("bin").join("laci"));
        std::os::unix::fs::symlink(root.join("var"), root.join("home")).unwrap();
        let image = file(&root.join("Laci.AppImage"));
        let image = Some(image.as_os_str());
        let through = root.join("home").join("tmp").join(".mount_LaciAbC");
        assert!(runs_from_appimage(&exe, image, Some(through.as_os_str())));
        assert!(runs_from_appimage(&exe, image, Some(mounted.as_os_str())));
        // A link to another AppImage's folder is still another folder.
        let other = root.join("var").join("tmp").join(".mount_kittyXy");
        fs::create_dir_all(&other).unwrap();
        let through_other = root.join("home").join("tmp").join(".mount_kittyXy");
        assert!(!runs_from_appimage(&exe, image, Some(through_other.as_os_str())));
        // A folder that isn't there leads nowhere.
        assert!(!runs_from_appimage(&exe, image, Some(root.join("gone").join(".mount_LaciAbC").as_os_str())));
    }
}
