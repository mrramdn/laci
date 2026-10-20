use crate::platform::{self, Dirs};
use serde_json::{Value, json};
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

/// Whether `path` names Laci's program inside a macOS app, an absolute `….app/Contents/MacOS/laci`. The command line
/// tool's link leads to one, so a link that leads to one is taken for one Laci made.
#[cfg(unix)]
fn app_program(path: &Path) -> bool {
    path.is_absolute()
        && path.file_name().is_some_and(|name| name == "laci")
        && path.parent().is_some_and(|dir| dir.ends_with("Contents/MacOS"))
        && path.ancestors().nth(3).is_some_and(|app| app.extension().is_some_and(|ext| ext == "app"))
}

/// Where macOS's command line tool goes: ~/.local/bin/laci, a link to the program inside Laci.app. That folder needs
/// no admin rights, as /usr/local/bin would, and Claude Code's installer puts its program there too.
pub fn cli_link(home: &Path) -> PathBuf {
    home.join(".local").join("bin").join("laci")
}

/// Whether the command line tool's link is there and leads, through any links, to this Laci's program.
fn cli_installed(env: &Env) -> bool {
    let link = cli_link(&env.home);
    let same = match (fs::canonicalize(&link), fs::canonicalize(&env.program)) {
        (Ok(found), Ok(program)) => found == program,
        _ => false,
    };
    same && fs::symlink_metadata(&link).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// What setup/info says about the command line tool on macOS: `link`, where it goes; `installed`, whether it leads to
/// this Laci; `onPath`, whether its folder is on `path`, the PATH the user's login shell sets up
/// ([`platform::shell_path`]), so typing `laci` in a terminal finds it. Not the PATH Laci's own programs get, which
/// has ~/.local/bin whenever that folder exists.
pub fn cli_status(env: &Env, path: &OsStr) -> Value {
    let link = cli_link(&env.home);
    let bin = link.parent().unwrap_or(&link);
    let real = |dir: &Path| fs::canonicalize(dir).ok();
    let on_path =
        std::env::split_paths(path).any(|dir| dir == bin || real(&dir).is_some_and(|dir| Some(dir) == real(bin)));
    json!({"link":link.to_string_lossy(),"installed":cli_installed(env),"onPath":on_path})
}

/// Makes the command line tool's link, ~/.local/bin/laci, lead to the program inside this Laci's app, and answers as
/// [`cli_status`] does. A link Laci made to another Laci's program, as a copy that has since moved left it, is
/// replaced; anything else there stays, and this fails.
#[cfg(unix)]
pub fn install_cli(env: &Env, path: &OsStr) -> crate::Result<Value> {
    if env.translocated() {
        return Err("Move Laci to Applications first, then install the command line tool.".into());
    }
    if !app_program(&env.program) {
        return Err("Laci can install the command line tool only when it runs from Laci.app.".into());
    }
    if cli_installed(env) {
        return Ok(cli_status(env, path));
    }
    let link = cli_link(&env.home);
    match fs::symlink_metadata(&link) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Couldn't read {}: {error}", link.display())),
        Ok(meta) if meta.file_type().is_symlink() && fs::read_link(&link).is_ok_and(|to| app_program(&to)) => {}
        Ok(_) => {
            return Err(
                "~/.local/bin/laci is already there and Laci didn't make it. Remove it first, then try again.".into()
            );
        }
    }
    let bin = link.parent().ok_or("The command line tool has no folder to go in")?;
    fs::create_dir_all(bin).map_err(|e| format!("Couldn't make {}: {e}", bin.display()))?;
    // Made beside it under another name, then renamed over it: an older link is replaced in one step, and stays as it
    // was when the new one can't be made.
    let made = tempfile::Builder::new()
        .prefix(".laci-")
        .make_in(bin, |temp| std::os::unix::fs::symlink(&env.program, temp))
        .map_err(|e| format!("Couldn't make a link in {}: {e}", bin.display()))?;
    made.persist(&link).map_err(|e| format!("Couldn't make {}: {}", link.display(), e.error))?;
    Ok(cli_status(env, path))
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

    #[cfg(unix)]
    #[test]
    fn a_link_to_an_app_s_program_is_one_laci_made() {
        for (path, expected) in [
            ("/Applications/Laci.app/Contents/MacOS/laci", true),
            ("/Users/me/Downloads/Laci 2.app/Contents/MacOS/laci", true),
            ("/Applications/Laci.app/Contents/MacOS/other", false),
            ("/Applications/Laci/Contents/MacOS/laci", false),
            ("/Applications/Laci.app/Contents/Resources/laci", false),
            ("/usr/local/bin/laci", false),
            ("Laci.app/Contents/MacOS/laci", false),
        ] {
            assert_eq!(app_program(Path::new(path)), expected, "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_command_line_tool_is_a_link_laci_makes_and_replaces_but_never_one_it_did_not_make() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let mut env = Env::for_home(root.join("home"));
        env.program = file(&root.join("Applications").join("Laci.app").join("Contents").join("MacOS").join("laci"));
        let link = cli_link(&env.home);
        let bin = link.parent().unwrap().to_owned();
        let path = std::env::join_paths([Path::new("/usr/bin"), bin.as_path()]).unwrap();
        let elsewhere = OsStr::new("/usr/bin:/bin");

        // Nothing there yet: ~/.local/bin is made, and the link leads to the program inside Laci.app.
        let before = cli_status(&env, &path);
        assert_eq!(before, json!({"link":link.to_string_lossy(),"installed":false,"onPath":true}));
        assert_eq!(cli_status(&env, elsewhere)["onPath"], false);
        let made = install_cli(&env, &path).unwrap();
        assert_eq!(made, json!({"link":link.to_string_lossy(),"installed":true,"onPath":true}));
        assert_eq!(fs::read_link(&link).unwrap(), env.program);
        assert!(!fs::read_dir(&bin).unwrap().any(|e| e.unwrap().file_name() != "laci"), "no temporary link is left");

        // Already there: nothing changes.
        assert_eq!(install_cli(&env, elsewhere).unwrap()["installed"], true);
        assert_eq!(fs::read_link(&link).unwrap(), env.program);
        // A folder spelled with a trailing slash on PATH is the same folder.
        let slashed = format!("/usr/bin:{}/", bin.display());
        assert_eq!(cli_status(&env, OsStr::new(&slashed))["onPath"], true);

        // A link Laci made to a Laci that has since moved, even one that is gone, is replaced.
        fs::remove_file(&link).unwrap();
        symlink("/Users/me/Downloads/Laci.app/Contents/MacOS/laci", &link).unwrap();
        assert_eq!(cli_status(&env, &path)["installed"], false);
        assert_eq!(install_cli(&env, &path).unwrap()["installed"], true);
        assert_eq!(fs::read_link(&link).unwrap(), env.program);

        // Anything else stays as it was: a file, a link to another program, a relative link, a folder.
        let foreign = "~/.local/bin/laci is already there and Laci didn't make it. Remove it first, then try again.";
        let refused = |env: &Env| assert_eq!(install_cli(env, &path).unwrap_err(), foreign);
        fs::remove_file(&link).unwrap();
        fs::write(&link, "#!/bin/sh\necho mine\n").unwrap();
        refused(&env);
        assert_eq!(fs::read_to_string(&link).unwrap(), "#!/bin/sh\necho mine\n");
        for target in [Path::new("/usr/bin/env"), Path::new("../../Applications/Laci.app/Contents/MacOS/laci")] {
            fs::remove_file(&link).unwrap();
            symlink(target, &link).unwrap();
            refused(&env);
            assert_eq!(fs::read_link(&link).unwrap(), target);
        }
        fs::remove_file(&link).unwrap();
        fs::create_dir(&link).unwrap();
        refused(&env);
        assert!(link.is_dir());

        // A build of Laci isn't the program inside an app, so it has nothing to link to.
        fs::remove_dir(&link).unwrap();
        env.program = file(&root.join("laci").join("target").join("debug").join("laci"));
        assert_eq!(
            install_cli(&env, &path).unwrap_err(),
            "Laci can install the command line tool only when it runs from Laci.app."
        );
        assert!(fs::symlink_metadata(&link).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_translocated_laci_installs_no_command_line_tool() {
        let temp = tempfile::tempdir().unwrap();
        let mut env = Env::for_home(fs::canonicalize(temp.path()).unwrap());
        env.program = PathBuf::from("/Volumes/Laci/Laci.app/Contents/MacOS/laci");
        assert_eq!(
            install_cli(&env, OsStr::new("/usr/bin")).unwrap_err(),
            "Move Laci to Applications first, then install the command line tool."
        );
        assert!(fs::symlink_metadata(cli_link(&env.home)).is_err());
    }
}
