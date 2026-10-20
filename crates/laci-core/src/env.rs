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
            .ok_or(if cfg!(windows) {
                "Set USERPROFILE to an absolute folder path"
            } else {
                "Set HOME to an absolute folder path"
            })?;
        // On macOS and Windows one folder has more than one spelling (/var is /private/var; a Windows folder can go by
        // a short 8.3 name), and the paths Laci reads from the disk come spelled as the disk spells them, so home is
        // spelled that way too. Linux keeps home as given, as it always has.
        #[cfg(not(target_os = "linux"))]
        let home = platform::path::canonical(&home)
            .map_err(|e| format!("Couldn't open the home folder {}: {e}", home.display()))?;
        let mut env = Self::for_home(home);
        if let Ok(exe) = std::env::current_exe() {
            let (image, appdir) = (std::env::var_os("APPIMAGE"), std::env::var_os("APPDIR"));
            let runs = runs_from_appimage(&exe, image.as_deref(), appdir.as_deref());
            env.program = program_for(SYSTEM, exe, image.filter(|_| runs).map(PathBuf::from));
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

    /// Whether Laci runs from a place macOS doesn't keep: the copy macOS made of a download, or a disk image. An agent
    /// told to start it there would find nothing once Laci quits or the disk is ejected. Always false on Linux and
    /// Windows.
    pub fn translocated(&self) -> bool {
        SYSTEM == System::Mac && unstable(&self.program)
    }

    /// Why no agent may be told to start [`Env::program`], which would be gone once Laci quits: macOS runs Laci from
    /// where it doesn't stay ([`Env::translocated`]), or Linux from the folder of an AppImage it couldn't make sure of
    /// ([`runs_from_appimage`]). None when the program stays.
    pub fn fleeting(&self) -> Option<&'static str> {
        if self.translocated() {
            Some("Move Laci to Applications first, then connect it again.")
        } else if SYSTEM == System::Linux && self.program.ancestors().nth(3).is_some_and(appimage_folder) {
            Some(
                "Laci can't tell which AppImage file it runs from, and the folder it runs in is gone once it quits. \
                 Start Laci from its AppImage file, then connect it again.",
            )
        } else {
            None
        }
    }
}

/// Whose rules [`program_for`] follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum System {
    Linux,
    Mac,
    Windows,
}
const SYSTEM: System = if cfg!(windows) {
    System::Windows
} else if cfg!(target_os = "macos") {
    System::Mac
} else {
    System::Linux
};

/// What agents start as Laci's MCP server, for the Laci program running from `exe`.
/// - Linux: `appimage`, the AppImage Laci runs from ([`runs_from_appimage`]): the folder it runs in is gone once it
///   closes, the file stays. Else `exe`.
/// - macOS: `exe` with its links followed, so the program inside Laci.app, also when the command line tool's link
///   started it.
/// - Windows: the console program, bin\laci.exe beside the window's laci.exe, when it is there: an agent talks to Laci
///   through a console, which a window's program doesn't get. Else `exe`: a build, or bin\laci.exe itself.
fn program_for(system: System, exe: PathBuf, appimage: Option<PathBuf>) -> PathBuf {
    match system {
        System::Linux => appimage.unwrap_or(exe),
        System::Mac => fs::canonicalize(&exe).unwrap_or(exe),
        System::Windows => {
            let console = exe.parent().map(|dir| dir.join("bin").join("laci.exe")).filter(|console| console.is_file());
            console.unwrap_or(exe)
        }
    }
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

/// Whether macOS runs the program `program` from where it doesn't stay: a copy it moved under AppTranslocation
/// because Laci was opened straight from the download, or a disk image or another drive under /Volumes.
fn unstable(program: &Path) -> bool {
    program.components().any(|part| part.as_os_str() == "AppTranslocation") || program.starts_with("/Volumes")
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
    fn agents_start_the_appimage_the_app_s_program_or_the_console_program() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        // Linux: the AppImage Laci runs from, else the program itself.
        let mounted = root.join(".mount_LaciAbC").join("usr").join("bin").join("laci");
        let image = root.join("Laci.AppImage");
        assert_eq!(program_for(System::Linux, mounted.clone(), Some(image.clone())), image);
        assert_eq!(program_for(System::Linux, mounted.clone(), None), mounted);
        // macOS: the program inside Laci.app, with any link on the way followed.
        let app = file(&root.join("Applications").join("Laci.app").join("Contents").join("MacOS").join("laci"));
        assert_eq!(program_for(System::Mac, app.clone(), None), app);
        let gone = root.join("gone").join("laci");
        assert_eq!(program_for(System::Mac, gone.clone(), None), gone, "a program that can't be read stays as it is");
        #[cfg(unix)]
        {
            let link = root.join("home").join(".local").join("bin").join("laci");
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&app, &link).unwrap();
            assert_eq!(program_for(System::Mac, link, None), app, "started through the command line tool");
        }
        // Windows: the console program bin\laci.exe beside the window's laci.exe, else the program itself.
        let install = root.join("Laci");
        let (window, console) = (file(&install.join("laci.exe")), file(&install.join("bin").join("laci.exe")));
        assert_eq!(program_for(System::Windows, window, None), console);
        assert_eq!(program_for(System::Windows, console.clone(), None), console, "the console program itself");
        let build = root.join("target").join("debug");
        let (debug, cli) = (file(&build.join("laci.exe")), file(&build.join("laci-cli.exe")));
        assert_eq!(program_for(System::Windows, debug.clone(), None), debug, "a build");
        assert_eq!(program_for(System::Windows, cli.clone(), None), cli);
        // An AppImage's variables mean nothing outside Linux.
        assert_eq!(program_for(System::Windows, cli.clone(), Some(image)), cli);
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

    #[cfg(unix)]
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

    #[test]
    fn only_macos_counts_the_download_and_disk_images_as_translocated() {
        let mut env = Env::for_home(PathBuf::from("/Users/me"));
        for (program, expected) in [
            ("/private/var/folders/x/T/AppTranslocation/0F1E/d/Laci.app/Contents/MacOS/laci", true),
            ("/Volumes/Laci/Laci.app/Contents/MacOS/laci", true),
            ("/Volumes/Backup/Apps/Laci.app/Contents/MacOS/laci", true),
            ("/Applications/Laci.app/Contents/MacOS/laci", false),
            ("/Users/me/Applications/Laci.app/Contents/MacOS/laci", false),
            ("/VolumesOfNotes/Laci.app/Contents/MacOS/laci", false),
            ("/Users/me/laci/target/debug/laci", false),
        ] {
            assert_eq!(unstable(Path::new(program)), expected, "{program}");
            env.program = PathBuf::from(program);
            assert_eq!(env.translocated(), expected && cfg!(target_os = "macos"), "{program}");
        }
    }
}
