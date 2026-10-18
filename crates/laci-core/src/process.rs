use crate::{
    Result,
    platform::{self, exited},
};
use std::{
    collections::BTreeSet,
    ffi::{OsStr, OsString},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

/// AppRun's bundled libraries belong to Laci, not the host tools it launches.
/// Return child-only overrides so WebKit keeps the parent process environment.
/// On macOS the PATH is the one the user's login shell sets up ([`platform::child_path`]).
pub fn host_env_overrides() -> Vec<(&'static str, Option<OsString>)> {
    let mut overrides = host_env_overrides_from(|key| std::env::var_os(key));
    if let Some(path) = platform::child_path() {
        overrides.retain(|(key, _)| *key != "PATH");
        overrides.push(("PATH", Some(path)));
    }
    overrides
}

fn absolute_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            _ => normalized.push(component.as_os_str()),
        }
    }
    Some(normalized)
}

fn host_env_overrides_from(get: impl Fn(&str) -> Option<OsString>) -> Vec<(&'static str, Option<OsString>)> {
    let Some(appdir) = get("APPDIR").and_then(|value| absolute_path(Path::new(&value))) else {
        return Vec::new();
    };
    if appdir.parent().is_none() {
        return Vec::new();
    }
    let bundled = |path: &Path| absolute_path(path).is_some_and(|path| path.starts_with(&appdir));
    let mut overrides = Vec::new();
    for key in [
        "PATH",
        "LD_LIBRARY_PATH",
        "PYTHONPATH",
        "PERLLIB",
        "XDG_DATA_DIRS",
        "GSETTINGS_SCHEMA_DIR",
        "QT_PLUGIN_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GI_TYPELIB_PATH",
        "GTK_PATH",
    ] {
        let Some(value) = get(key) else { continue };
        let paths: Vec<_> = std::env::split_paths(&value).collect();
        let kept: Vec<_> = paths.iter().filter(|path| !bundled(path)).collect();
        if kept.len() != paths.len() {
            // AppRun appends an empty entry when the original variable was unset.
            let value = if kept.iter().all(|path| path.as_os_str().is_empty()) {
                None
            } else {
                std::env::join_paths(kept).ok()
            };
            overrides.push((key, value));
        }
    }
    for key in ["PYTHONHOME", "GTK_DATA_PREFIX", "GTK_EXE_PREFIX", "GIO_MODULE_DIR", "GTK_IM_MODULE_FILE"] {
        if get(key).is_some_and(|value| bundled(Path::new(&value))) {
            overrides.push((key, None));
        }
    }
    overrides
}

/// Windows' CREATE_NO_WINDOW: a console program gets no console window. Laci's window has no console to share, so
/// each `git` of a scan would flash one.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    for (key, value) in host_env_overrides() {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
    command
}

/// What starts `program` with `args`, found on the PATH children get ([`platform::program`]): on Windows the file
/// itself, and node for an npm script; elsewhere the program by name.
pub fn program(program: &str, args: Vec<OsString>) -> Result<(PathBuf, Vec<OsString>)> {
    platform::program(program, args, &host_path())
}

/// [`command`] for `program` with `args`, started as [`program`] says, so Windows' rules for batch files hold for the
/// child too.
pub(crate) fn start(program: &str, args: &[impl AsRef<OsStr>]) -> Result<Command> {
    let (program, args) = self::program(program, args.iter().map(|arg| arg.as_ref().to_owned()).collect())?;
    let mut command = command(program);
    command.args(args);
    Ok(command)
}

/// What cmd.exe can read as part of a command in a batch file's arguments, however they are quoted: quotes, variables
/// (`%`, and `!` where delayed expansion is on), its escape character, pipes, redirections, the command separator and
/// line breaks (BatBadBut).
const BATCH_UNSAFE: [char; 10] = ['"', '%', '!', '^', '&', '|', '<', '>', '\r', '\n'];

/// Fails when an argument in `args` holds something cmd.exe could read as part of a command. Windows starts the batch
/// file `script` (`.cmd` or `.bat`) through cmd.exe, which reads the arguments again after any quoting Laci can do.
pub fn batch_args(script: &Path, args: &[OsString]) -> Result<()> {
    let name = script.file_name().unwrap_or(script.as_os_str()).to_string_lossy();
    for arg in args {
        if let Some(found) = arg.to_string_lossy().chars().find(|c| BATCH_UNSAFE.contains(c)) {
            let what =
                if matches!(found, '\r' | '\n') { "a line break".to_owned() } else { format!("the character {found}") };
            return Err(format!(
                "Laci won't pass {what} to {name}: Windows runs a .cmd or .bat file through cmd.exe, which could read it as part of a command"
            ));
        }
    }
    Ok(())
}

/// The script that `shim`, the `.cmd` file npm, pnpm or yarn writes for a program it installs, runs with node: as the
/// shim names it after its own folder (`%~dp0`). Started as node with the script, Laci's arguments reach the program
/// as they are, where the shim would put them through cmd.exe ([`batch_args`]). `None` for any other batch file, and
/// for a shim with lines these don't write, such as a variable set for the program, which node alone would miss.
pub fn npm_shim(shim: &str) -> Option<String> {
    // Trimmed, without the leading `@`, in lower case. npm 7 and later write the first eleven; pnpm, yarn and older
    // npm test for node.exe with `%~dp0`.
    const KNOWN: [&str; 16] = [
        "echo off",
        "goto start",
        ":find_dp0",
        "set dp0=%~dp0",
        "exit /b",
        ":start",
        "setlocal",
        "call :find_dp0",
        r#"if exist "%dp0%\node.exe" ("#,
        r#"set "_prog=%dp0%\node.exe""#,
        r#"set "_prog=node""#,
        r#"if exist "%~dp0\node.exe" ("#,
        "set pathext=%pathext:;.js;=;%",
        ") else (",
        ")",
        "if not defined node_path (",
    ];
    let mut seen = BTreeSet::new();
    let mut needs = BTreeSet::new();
    let mut script: Option<String> = None;
    for line in shim.lines() {
        let line = line.trim();
        let line = line.strip_prefix('@').unwrap_or(line);
        let lower = line.to_ascii_lowercase();
        // pnpm's NODE_PATH names where it hoisted modules, which only a package using modules it doesn't declare
        // needs: node finds a package's own modules without it.
        if line.is_empty() || (lower.starts_with(r#"set "node_path="#) && lower.ends_with('"')) {
            continue;
        }
        if let Some(known) = KNOWN.iter().find(|known| **known == lower) {
            seen.insert(*known);
            continue;
        }
        let (program, dir, named) = shim_run(line)?;
        // Without the lines that set them, cmd.exe would read %_prog% and %dp0% as empty.
        if program == r#""%_prog%""# {
            needs.insert(r#"set "_prog=node""#);
        }
        if dir == r"%dp0%\" {
            needs.extend(["set dp0=%~dp0", "call :find_dp0"]);
        }
        if *script.get_or_insert_with(|| named.clone()) != named {
            return None;
        }
    }
    needs.is_subset(&seen).then_some(script?)
}

/// The program, the folder and the script in a shim's line that starts node on the script with the shim's own
/// arguments: `node  "%~dp0\cli.js" %*`, or npm's `"%_prog%"  "%dp0%\cli.js" %*` after what keeps cmd.exe from asking
/// whether to stop.
fn shim_run(line: &str) -> Option<(&'static str, &'static str, String)> {
    let mut rest = line;
    for part in ["endlocal & goto #_undefined_# 2>nul || title %comspec% & ", "set pathext=%pathext:;.js;=;% & "] {
        rest = strip_prefix_ignoring_case(rest, part).unwrap_or(rest);
    }
    let (program, rest) = rest.split_once(' ')?;
    let program =
        ["node", r#""%~dp0\node.exe""#, r#""%_prog%""#].into_iter().find(|p| p.eq_ignore_ascii_case(program))?;
    // Without a space before %*, cmd.exe would join the first argument to the script's name.
    let path = rest.trim_start().strip_suffix(" %*")?.trim_end().strip_prefix('"')?.strip_suffix('"')?;
    let (dir, script) =
        [r"%~dp0\", r"%dp0%\"].into_iter().find_map(|dir| Some((dir, strip_prefix_ignoring_case(path, dir)?)))?;
    // cmd.exe would read a % in the name as a variable.
    let plain = !script.is_empty() && !script.contains(['"', '%']) && !script.contains(char::is_control);
    plain.then(|| (program, dir, script.to_owned()))
}

fn strip_prefix_ignoring_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &text[prefix.len()..])
}

/// Marks the PATH in what [`login_shell_path`] reads from the shell, among whatever its startup files print.
#[cfg(unix)]
const PATH_MARK: &str = "__laci_path__";

/// The PATH that `shell`, started as an interactive login shell, sets up: where the user's own programs are found,
/// which macOS doesn't give an app started from the Dock. `None` when the shell prints none; one still running after
/// `timeout` is stopped, with whatever it started.
#[cfg(unix)]
pub fn login_shell_path(shell: &Path, timeout: Duration) -> Option<OsString> {
    use std::io::{Read, Seek, SeekFrom};
    let mut output = tempfile::tempfile().ok()?;
    let mut command = Command::new(shell);
    // printenv writes PATH as the shell exports it, also from a shell such as fish that keeps it as a list.
    command
        .args(["-ilc", &format!("echo {PATH_MARK}; /usr/bin/printenv PATH; echo {PATH_MARK}")])
        .stdin(Stdio::null())
        .stdout(output.try_clone().ok()?)
        .stderr(Stdio::null());
    let mut group = platform::spawn_group(command).ok()?;
    let started = Instant::now();
    while !group.exited().unwrap_or(true) {
        if started.elapsed() >= timeout {
            group.stop();
            let _ = group.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = group.wait();
    output.seek(SeekFrom::Start(0)).ok()?;
    let mut text = Vec::new();
    output.take(1_000_000).read_to_end(&mut text).ok()?;
    marked_path(&text)
}

/// What stands between the first two [`PATH_MARK`]s in `output`.
#[cfg(unix)]
fn marked_path(output: &[u8]) -> Option<OsString> {
    use std::os::unix::ffi::OsStrExt;
    let mark = PATH_MARK.as_bytes();
    let find = |text: &[u8]| text.windows(mark.len()).position(|window| window == mark);
    let rest = &output[find(output)? + mark.len()..];
    let path = rest[..find(rest)?].trim_ascii();
    (!path.is_empty()).then(|| OsStr::from_bytes(path).to_owned())
}

pub(crate) fn host_path() -> OsString {
    host_env_overrides()
        .into_iter()
        .find(|(key, _)| *key == "PATH")
        .map(|(_, value)| value.unwrap_or_default())
        .unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default())
}

/// Helpers [`run_env`] has started and not yet reaped. They never make a folder busy: a scan's `git status` must not
/// stop Laci from moving it. Terminals and apps Laci opens are started elsewhere and still count.
static HELPERS: Mutex<BTreeSet<u32>> = Mutex::new(BTreeSet::new());

fn helpers() -> MutexGuard<'static, BTreeSet<u32>> {
    HELPERS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether `pid` is a helper [`run_env`] is still running.
pub(crate) fn is_own_child(pid: u32) -> bool {
    helpers().contains(&pid)
}

/// Keeps a helper's pid in [`HELPERS`] until dropped, which also happens on every early return.
struct Listed(u32);
impl Listed {
    fn new(child: &Child) -> Self {
        let pid = child.id();
        helpers().insert(pid);
        Self(pid)
    }
}
impl Drop for Listed {
    fn drop(&mut self) {
        helpers().remove(&self.0);
    }
}

pub fn run(program: &str, args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Result<String> {
    run_env(program, args, cwd, timeout, &[])
}

/// Like [`run`], with variables set (`Some`) or removed (`None`) for the child only.
pub(crate) fn run_env(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
    env: &[(&str, Option<&str>)],
) -> Result<String> {
    let bytes = run_env_bytes(program, args, cwd, timeout, env)?;
    let text = String::from_utf8(bytes).map_err(|_| "stream did not contain valid UTF-8".to_owned())?;
    Ok(text.trim_end().into())
}

/// Like [`run_env`], with the output as the program wrote it, for lists of names that may not be valid text.
pub(crate) fn run_env_bytes(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
    env: &[(&str, Option<&str>)],
) -> Result<Vec<u8>> {
    // Files avoid pipe backpressure and reader threads surviving a child with inherited descriptors.
    let output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let errors = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut command = start(program, args)?;
    command
        .stdin(Stdio::null())
        .stdout(output.try_clone().map_err(|e| e.to_string())?)
        .stderr(errors.try_clone().map_err(|e| e.to_string())?)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    for (key, value) in env {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(|e| format!("Couldn't start {program}: {e}"))?;
    let listed = Listed::new(&child);
    let started = Instant::now();
    loop {
        if exited(&mut child)? {
            use std::io::{Read, Seek, SeekFrom};
            // Forgotten before the pid is freed, so a listed pid never names a newer process.
            drop(listed);
            let status = child.wait().map_err(|e| e.to_string())?;
            let mut file = if status.success() { output } else { errors };
            file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
            let mut bytes = Vec::new();
            file.take(16_000_000).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            return if status.success() {
                Ok(bytes)
            } else {
                Err(format!("{program} failed: {}", String::from_utf8_lossy(&bytes).trim()))
            };
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            drop(listed);
            let _ = child.wait();
            return Err(format!("{program} took too long"));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

// AppImage is Linux's, and these paths and lists are written as Unix writes them.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn overrides(values: &[(&str, &str)]) -> BTreeMap<&'static str, Option<OsString>> {
        host_env_overrides_from(|key| values.iter().find(|(name, _)| *name == key).map(|(_, v)| v.into()))
            .into_iter()
            .collect()
    }

    #[test]
    fn appimage_environment_preserves_host_paths_and_settings() {
        let changes = overrides(&[
            ("APPDIR", "/tmp/laci/./"),
            ("PATH", "/tmp/laci//usr/bin:/tmp/laci-other/bin:/tmp/laci/../host/bin::/usr/bin"),
            ("PYTHONPATH", "/tmp/laci/usr/share/pyshared:/home/user/modules:"),
            ("PYTHONHOME", "/tmp/laci/usr/"),
            ("LD_LIBRARY_PATH", "/tmp/laci/usr/lib:"),
            ("XDG_DATA_DIRS", "/tmp/laci/usr/share:/usr/local/share:/usr/share"),
            ("GIO_MODULE_DIR", "/tmp/laci//usr/lib/gio/modules"),
            ("GTK_PATH", "/tmp/laci/usr/lib/gtk-3.0:/home/user/gtk"),
            ("GTK_THEME", "Adwaita:dark"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
            ("CUSTOM_SETTING", "keep-me"),
        ]);
        assert_eq!(
            changes,
            BTreeMap::from([
                ("PATH", Some("/tmp/laci-other/bin:/tmp/laci/../host/bin::/usr/bin".into())),
                ("PYTHONPATH", Some("/home/user/modules:".into())),
                ("PYTHONHOME", None),
                ("LD_LIBRARY_PATH", None),
                ("XDG_DATA_DIRS", Some("/usr/local/share:/usr/share".into())),
                ("GIO_MODULE_DIR", None),
                ("GTK_PATH", Some("/home/user/gtk".into())),
            ])
        );
    }

    #[test]
    fn host_environment_is_unchanged_without_bundled_paths() {
        for appdir in [None, Some(""), Some("relative"), Some("/"), Some("/tmp/.."), Some("/tmp/laci")] {
            let mut values = vec![
                ("PATH", "/home/user/bin:/usr/bin"),
                ("PYTHONHOME", "/home/user/python"),
                ("PYTHONPATH", ":/home/user/modules"),
                ("LD_LIBRARY_PATH", ""),
                ("GIO_MODULE_DIR", "/home/user/gio"),
            ];
            if let Some(appdir) = appdir {
                values.push(("APPDIR", appdir));
            }
            assert!(overrides(&values).is_empty(), "APPDIR={appdir:?}");
        }
        assert!(overrides(&[("PYTHONHOME", "/tmp/laci/usr"), ("PATH", "/tmp/laci/usr/bin")]).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn appimage_environment_preserves_non_utf8_host_paths() {
        use std::os::unix::ffi::OsStringExt;
        let changes = host_env_overrides_from(|key| match key {
            "APPDIR" => Some("/tmp/laci".into()),
            "PATH" => Some(OsString::from_vec(b"/tmp/laci/usr/bin:/home/user/\xff/bin:/usr/bin".to_vec())),
            _ => None,
        });
        assert_eq!(changes, vec![("PATH", Some(OsString::from_vec(b"/home/user/\xff/bin:/usr/bin".to_vec())))]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_host_python_starts_with_host_paths() {
        use std::{fs, os::unix::fs::PermissionsExt};
        const CHILD: &str = "LACI_TEST_APPIMAGE_PYTHON_CHILD";
        const SCRIPT: &str = "import encodings, laci_host_probe; print(laci_host_probe.marker)";
        if std::env::var_os(CHILD).is_some() {
            let before: BTreeMap<_, _> = std::env::vars_os().collect();
            assert_eq!(run("python3", &["-c", SCRIPT], None, Duration::from_secs(5)).unwrap(), "host-python-ok");
            assert_eq!(before, std::env::vars_os().collect());
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let appdir = dir.path().join("AppDir");
        let bundled_bin = appdir.join("usr/bin");
        let host_modules = dir.path().join("host-modules");
        fs::create_dir_all(&bundled_bin).unwrap();
        fs::create_dir(&host_modules).unwrap();
        fs::write(bundled_bin.join("python3"), "#!/bin/sh\nexit 99\n").unwrap();
        fs::set_permissions(bundled_bin.join("python3"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(host_modules.join("laci_host_probe.py"), "marker = 'host-python-ok'\n").unwrap();
        let packaged = [
            ("APPDIR", appdir.clone().into_os_string()),
            ("PYTHONHOME", appdir.join("usr").into_os_string()),
            ("PATH", std::env::join_paths([bundled_bin.as_path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap()),
            ("PYTHONPATH", std::env::join_paths([appdir.join("usr/share/pyshared"), host_modules]).unwrap()),
            ("LD_LIBRARY_PATH", std::env::join_paths([appdir.join("usr/lib"), PathBuf::new()]).unwrap()),
        ];
        let broken = Command::new("/usr/bin/python3").args(["-c", SCRIPT]).envs(packaged.clone()).output().unwrap();
        assert!(!broken.status.success());
        assert!(String::from_utf8_lossy(&broken.stderr).contains("encodings"));

        // An isolated test process exercises the actual factory without changing this process's env.
        let fixed = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process::tests::appimage_host_python_starts_with_host_paths", "--nocapture"])
            .envs(packaged)
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            fixed.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&fixed.stdout),
            String::from_utf8_lossy(&fixed.stderr)
        );
    }
}
