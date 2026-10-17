use crate::{Result, platform::exited};
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
pub fn host_env_overrides() -> Vec<(&'static str, Option<OsString>)> {
    host_env_overrides_from(|key| std::env::var_os(key))
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

pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    for (key, value) in host_env_overrides() {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    command
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
    // Files avoid pipe backpressure and reader threads surviving a child with inherited descriptors.
    let output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let errors = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut command = command(program);
    command
        .args(args)
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
            let mut text = String::new();
            file.take(16_000_000).read_to_string(&mut text).map_err(|e| e.to_string())?;
            return if status.success() {
                Ok(text.trim_end().into())
            } else {
                Err(format!("{program} failed: {}", text.trim()))
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
