//! What the platform layer promises. Linux keeps every promise; where a check isn't written for an OS yet, it must
//! fail there instead of answering.
use laci_core::platform;

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        fs::{self, File},
        io::{self, Write},
        os::unix::fs::symlink,
        path::{Path, PathBuf},
        thread,
        time::Duration,
    };

    fn id(path: &Path) -> platform::Identity {
        platform::identity(path, &fs::metadata(path).unwrap()).unwrap()
    }
    fn stamp(path: &Path) -> platform::Stamp {
        platform::change_stamp(path, &fs::metadata(path).unwrap()).unwrap()
    }
    /// A temporary folder, spelled without links: on macOS it sits below /var, which is one.
    fn folder() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        (temp, root)
    }

    /// A folder on another device than `near`, when this machine has one: a tmpfs in /dev/shm, or Cargo's target
    /// folder.
    fn elsewhere(near: &Path) -> Option<tempfile::TempDir> {
        let device = |p: &Path| Some(platform::identity(p, &fs::metadata(p).ok()?).ok()?.volume);
        let here = device(near)?;
        ["/dev/shm", env!("CARGO_TARGET_TMPDIR")]
            .into_iter()
            .map(Path::new)
            .filter(|p| device(p).is_some_and(|d| d != here))
            .find_map(|p| tempfile::tempdir_in(p).ok())
    }

    #[test]
    fn identity_is_one_per_file() {
        let (_temp, root) = folder();
        let (a, b, link) = (root.join("a"), root.join("b"), root.join("link"));
        fs::write(&a, "same bytes").unwrap();
        fs::write(&b, "same bytes").unwrap();
        fs::hard_link(&a, root.join("hard")).unwrap();
        symlink(&a, &link).unwrap();
        assert_eq!(id(&a), id(&a));
        assert_eq!(id(&a), id(&root.join("hard")), "a second name of the same file");
        assert_eq!(id(&a), id(&link), "a link is followed");
        assert_ne!(id(&a), id(&b), "another file, even with the same bytes");
        assert_eq!(id(&a).volume, id(&b).volume);
        assert_ne!(
            platform::identity(&link, &fs::symlink_metadata(&link).unwrap()).unwrap(),
            id(&a),
            "the link itself"
        );
        let before = id(&a);
        fs::rename(&a, root.join("moved")).unwrap();
        assert_eq!(id(&root.join("moved")), before, "a file keeps its identity when renamed");
    }

    #[test]
    fn a_change_stamp_moves_when_a_file_is_written_or_replaced() {
        let (_temp, root) = folder();
        let log = root.join("log.jsonl");
        fs::write(&log, "{}\n").unwrap();
        let before = stamp(&log);
        assert_eq!(stamp(&log), before);
        let file = File::open(&log).unwrap();
        assert_eq!(platform::file_change_stamp(&file, &file.metadata().unwrap()).unwrap(), before, "open or not");
        // File times tick at the kernel's clock, which can be a few milliseconds coarse.
        let mut written = before;
        for _ in 0..100 {
            fs::OpenOptions::new().append(true).open(&log).unwrap().write_all(b"{}\n").unwrap();
            written = stamp(&log);
            if written.changed != before.changed {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_ne!(written.changed, before.changed, "a write moves the change time");
        assert_eq!(written.identity, before.identity, "still the same file");
        let replacement = root.join("new");
        fs::write(&replacement, "{}\n").unwrap();
        fs::rename(&replacement, &log).unwrap();
        assert_ne!(stamp(&log).identity, before.identity, "another file in its place");
    }

    #[test]
    fn the_change_lock_is_exclusive_until_dropped() {
        let (_temp, root) = folder();
        let path = root.join("lock");
        let held = platform::lock(path.clone()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), std::process::id().to_string(), "the PID Laci v1 reads");
        let Err(error) = platform::lock(path.clone()) else { panic!("a second holder") };
        assert_eq!(error, "Another laci window or agent is changing files right now. Try again in a moment.");
        drop(held);
        assert!(!path.exists(), "the lock file goes with the lock");
        drop(platform::lock(path.clone()).unwrap());
        // A lock file in a linked folder is never trusted.
        fs::create_dir(root.join("real")).unwrap();
        symlink(root.join("real"), root.join("linked")).unwrap();
        fs::write(root.join("real/lock"), "").unwrap();
        let Err(error) = platform::lock(root.join("linked/lock")) else { panic!("a lock in a linked folder") };
        assert!(error.starts_with("Refusing to edit linked path"), "{error}");
    }

    #[test]
    fn a_rename_never_replaces_and_never_copies() {
        let (_temp, root) = folder();
        let (src, taken, dest) = (root.join("src"), root.join("taken"), root.join("dest"));
        fs::create_dir(&src).unwrap();
        fs::write(src.join("file"), "moved").unwrap();
        fs::write(&taken, "kept").unwrap();
        let error = platform::rename_noreplace(&src, &taken).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists, "{error}");
        assert_eq!(fs::read_to_string(&taken).unwrap(), "kept");
        assert!(src.join("file").is_file());
        platform::rename_noreplace(&src, &dest).unwrap();
        assert!(!src.exists());
        assert_eq!(fs::read_to_string(dest.join("file")).unwrap(), "moved");
        let Some(other) = elsewhere(&root) else {
            eprintln!("No second device here; the rename across devices is not checked.");
            return;
        };
        let there = other.path().join("dest");
        let error = platform::rename_noreplace(&dest, &there).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::CrossesDevices, "{error}");
        assert!(dest.join("file").is_file() && !there.exists(), "nothing copied, nothing removed");
    }

    /// The copy across devices is Laci's own: it stages the copy beside the destination and removes the source only
    /// once the copy is in place. Undo goes back the same way. Linux only until macOS can tell which programs work in
    /// a folder (the archive checks that first).
    #[cfg(target_os = "linux")]
    #[test]
    fn an_archive_on_another_device_is_copied_over_and_undone() {
        use laci_core::{config, env::Env, service::Service};
        use serde_json::json;
        let (_temp, root) = folder();
        let Some(drive) = elsewhere(&root) else {
            eprintln!("No second device here; the move across devices is not checked.");
            return;
        };
        let env = Env::for_home(root.join("home"));
        let project = env.home.join("project/demo");
        let archive = drive.path().canonicalize().unwrap().join("archive");
        fs::create_dir_all(project.join("src")).unwrap();
        fs::write(project.join("package.json"), "{\"name\":\"demo\"}").unwrap();
        fs::write(project.join("src/main.js"), "console.log(1)\n").unwrap();
        symlink("main.js", project.join("src/link.js")).unwrap();
        fs::create_dir_all(&archive).unwrap();
        let archive_dir = config::validate_archive_dir(&env, &json!(archive)).unwrap();
        config::save(&env, &json!({"roots":["~/project"],"presets":[],"archiveDir":archive_dir})).unwrap();
        let mut service = Service::new(env.clone());
        service.snapshot().unwrap();
        let id = project.to_str().unwrap();
        let dest = archive.join("demo");
        let change = service.request("archive", &json!({"id":id,"destination":dest})).unwrap();
        assert!(!project.exists());
        assert_eq!(fs::read_to_string(dest.join("src/main.js")).unwrap(), "console.log(1)\n");
        assert_eq!(fs::read_link(dest.join("src/link.js")).unwrap(), Path::new("main.js"), "links stay links");
        let names = |dir: &Path| fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name()).collect::<Vec<_>>();
        assert_eq!(names(&archive), ["demo"], "no staging folder is left");
        service.request("undo", &json!({"id":change["journal"]["id"]})).unwrap();
        assert!(!dest.exists());
        assert_eq!(fs::read_to_string(project.join("package.json")).unwrap(), "{\"name\":\"demo\"}");
        assert_eq!(fs::read_link(project.join("src/link.js")).unwrap(), Path::new("main.js"));
    }

    #[test]
    fn a_linked_ancestor_is_never_plain() {
        let (_temp, root) = folder();
        let (real, link) = (root.join("real"), root.join("link"));
        fs::create_dir(&real).unwrap();
        symlink(&real, &link).unwrap();
        platform::path::plain_path(&real.join("missing/notes.md")).unwrap();
        let error = platform::path::plain_path(&link.join("notes.md")).unwrap_err();
        assert_eq!(error, format!("Refusing to edit linked path {}", link.display()));
        assert!(platform::path::plain_path(&link).is_err(), "the link itself");
    }

    #[test]
    fn laci_home_keeps_the_layout_of_laci_v1() {
        let dirs = platform::Dirs::inside(Path::new("/home/someone"));
        assert_eq!(dirs.config, Path::new("/home/someone/.config/laci"));
        assert_eq!(dirs.data, Path::new("/home/someone/.local/share/laci"));
        assert_eq!(dirs.cache, Path::new("/home/someone/.cache/laci"));
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::{
        fs::{self, File, OpenOptions},
        path::{Path, PathBuf},
        process::{Child, Command},
        thread,
        time::{Duration, Instant},
    };

    /// Waits up to five seconds for `found` to give something.
    fn soon<T>(what: &str, mut found: impl FnMut() -> Option<T>) -> T {
        let since = Instant::now();
        loop {
            if let Some(value) = found() {
                return value;
            }
            assert!(since.elapsed() < Duration::from_secs(5), "{what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Whether `pid` has stopped running: gone, or a zombie nobody has reaped yet.
    fn stopped(pid: u32) -> bool {
        fs::read_to_string(format!("/proc/{pid}/stat"))
            .map_or(true, |stat| stat.rsplit_once(") ").is_some_and(|(_, rest)| rest.starts_with(['Z', 'X'])))
    }

    /// Killed and reaped when the test ends, also when it fails.
    struct Running(Child);
    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn a_process_working_inside_a_folder_is_found() {
        let temp = tempfile::tempdir().unwrap();
        // /proc names working folders with links resolved.
        let root = temp.path().canonicalize().unwrap();
        let (project, beside) = (root.join("project"), root.join("project-old"));
        fs::create_dir_all(project.join("src")).unwrap();
        fs::create_dir(&beside).unwrap();
        let child = Running(Command::new("sleep").arg("30").current_dir(project.join("src")).spawn().unwrap());
        let pid = child.0.id();
        // Right after a spawn, the child can still carry its parent's name for a moment.
        let found = soon("the sleep in the folder is found", || {
            platform::processes_in(std::slice::from_ref(&project))
                .unwrap()
                .into_iter()
                .find(|h| h.pid == pid && h.name == "sleep")
        });
        assert_eq!(found.cwd, project.join("src"));
        assert!(
            platform::processes_in(&[beside]).unwrap().iter().all(|h| h.pid != pid),
            "a folder whose name only begins the same"
        );
        let everything = platform::processes_in(&[PathBuf::from("/")]).unwrap();
        assert!(everything.iter().any(|h| h.pid == pid));
        assert!(everything.iter().all(|h| h.pid != std::process::id()), "never this process");
        drop(child);
        assert!(platform::processes_in(&[project]).unwrap().iter().all(|h| h.pid != pid), "gone once stopped");
    }

    #[test]
    fn history_with_a_writer_or_a_process_inside_is_not_idle() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().canonicalize().unwrap().join("history");
        fs::create_dir(&history).unwrap();
        let log = history.join("session.jsonl");
        fs::write(&log, "{}\n").unwrap();
        let sources = std::slice::from_ref(&history);
        platform::ensure_idle(sources).unwrap();
        let reader = File::open(&log).unwrap();
        platform::ensure_idle(sources).unwrap();
        drop(reader);
        let writer = OpenOptions::new().append(true).open(&log).unwrap();
        let error = platform::ensure_idle(sources).unwrap_err();
        assert_eq!(error, "History has an open writer. Stop the session before cleaning it up.");
        drop(writer);
        // A program another test starts holds this process's open files until it runs, so the writer can linger
        // there for a moment.
        let inside = "History is in use by a running process. Close it first.";
        let child = Running(Command::new("sleep").arg("30").current_dir(&history).spawn().unwrap());
        soon("the process inside is found", || platform::ensure_idle(sources).err().filter(|e| e == inside));
        drop(child);
        soon("idle once it stopped", || platform::ensure_idle(sources).ok());
    }

    #[test]
    fn a_process_id_is_alive_while_its_process_runs() {
        assert!(platform::pid_alive(std::process::id()).unwrap());
        assert!(!platform::pid_alive(u32::MAX).unwrap());
    }

    #[test]
    fn a_lock_left_by_a_process_that_is_gone_is_taken_over() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("lock");
        fs::write(&path, std::process::id().to_string()).unwrap();
        assert!(platform::lock(path.clone()).is_err(), "a v1 lock of a running Laci");
        fs::write(&path, u32::MAX.to_string()).unwrap();
        // A program another test starts holds this process's open files until it runs, so for a moment it can
        // still hold the lock the check above took.
        drop(soon("the lock is taken over", || platform::lock(path.clone()).ok()));
        assert!(!path.exists());
    }

    #[test]
    fn a_finished_child_stays_unreaped_until_waited_for() {
        let mut child = Command::new("true").spawn().unwrap();
        soon("true finishes", || platform::exited(&mut child).unwrap().then_some(()));
        assert!(platform::exited(&mut child).unwrap(), "asking again changes nothing");
        assert!(platform::pid_alive(child.id()).unwrap(), "its process id is still taken");
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn stopping_a_group_stops_what_its_program_started() {
        let temp = tempfile::tempdir().unwrap();
        let pidfile = temp.path().join("pid");
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & echo $! > \"$0\"; wait"]).arg(&pidfile);
        let mut group = platform::spawn_group(command).unwrap();
        let started: u32 = soon("the shell starts sleep", || fs::read_to_string(&pidfile).ok()?.trim().parse().ok());
        assert!(!group.exited().unwrap());
        group.stop();
        assert!(!group.wait().unwrap().success());
        soon("the sleep it started stops too", || stopped(started).then_some(()));

        let mut command = Command::new("sh");
        command.args(["-c", "exit 3"]);
        let mut group = platform::spawn_group(command).unwrap();
        soon("the shell finishes", || group.exited().unwrap().then_some(()));
        group.stop();
        assert_eq!(group.wait().unwrap().code(), Some(3));
    }

    #[test]
    fn settings_and_cache_follow_xdg_and_data_stays_where_v1_kept_it() {
        const CHILD: &str = "LACI_PLATFORM_XDG_TEST";
        let home = Path::new("/home/someone");
        if let Some(case) = std::env::var_os(CHILD) {
            let dirs = platform::user_dirs(home).unwrap();
            let (config, cache) = if case == "absolute" {
                (PathBuf::from("/xdg/config/laci"), PathBuf::from("/xdg/cache/laci"))
            } else {
                (home.join(".config/laci"), home.join(".cache/laci"))
            };
            assert_eq!((dirs.config, dirs.data, dirs.cache), (config, home.join(".local/share/laci"), cache));
            return;
        }
        // XDG_* are read by the process, so each case runs in a fresh one.
        for (case, base) in [("absolute", "/xdg"), ("relative", "xdg")] {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "linux::settings_and_cache_follow_xdg_and_data_stays_where_v1_kept_it"])
                .env(CHILD, case)
                .env("XDG_CONFIG_HOME", format!("{base}/config"))
                .env("XDG_CACHE_HOME", format!("{base}/cache"))
                .env("XDG_DATA_HOME", format!("{base}/data"))
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(output.status.success() && stdout.contains("1 passed"), "{case}: {stdout}");
        }
    }
}

/// Until macOS and Windows have their own, these checks fail there: a folder must never pass as "not in use".
#[cfg(not(target_os = "linux"))]
#[test]
fn checks_not_written_for_this_os_fail_instead_of_answering() {
    let here = std::env::temp_dir();
    assert!(platform::processes_in(std::slice::from_ref(&here)).is_err());
    assert!(platform::ensure_idle(std::slice::from_ref(&here)).is_err());
    assert!(platform::pid_alive(std::process::id()).is_err());
    assert!(platform::trash(&here.join("missing")).is_err());
}
