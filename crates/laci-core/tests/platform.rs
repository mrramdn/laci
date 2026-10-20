//! What the platform layer promises. Linux keeps every promise; where a check isn't written for an OS yet, it must
//! fail there instead of answering.
use laci_core::platform;

mod support;

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
    /// once the copy is in place. Undo goes back the same way.
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
        assert!(names(project.parent().unwrap()).is_empty(), "nothing set aside is left");
        service.request("undo", &json!({"id":change["journal"]["id"]})).unwrap();
        assert!(!dest.exists());
        assert_eq!(fs::read_to_string(project.join("package.json")).unwrap(), "{\"name\":\"demo\"}");
        assert_eq!(fs::read_link(project.join("src/link.js")).unwrap(), Path::new("main.js"));
        assert_eq!(names(project.parent().unwrap()), ["demo"]);
    }

    /// A project that can't leave its folder, as in a folder this user may only read, isn't copied to another
    /// device at all. Before, the copy was published there, the project emptied, and the two blocked the rollback.
    #[test]
    fn a_project_that_cannot_leave_its_folder_is_not_copied_to_another_device() {
        use laci_core::{config, env::Env, service::Service};
        use serde_json::json;
        use std::os::unix::fs::PermissionsExt;
        let (_temp, root) = folder();
        let Some(drive) = elsewhere(&root) else {
            eprintln!("No second device here; the move across devices is not checked.");
            return;
        };
        let env = Env::for_home(root.join("home"));
        let shared = env.home.join("project/shared");
        let project = shared.join("demo");
        let archive = drive.path().canonicalize().unwrap().join("archive");
        fs::create_dir_all(project.join("src")).unwrap();
        fs::write(project.join("package.json"), "{\"name\":\"demo\"}").unwrap();
        fs::write(project.join("src/main.js"), "console.log(1)\n").unwrap();
        fs::create_dir_all(&archive).unwrap();
        let archive_dir = config::validate_archive_dir(&env, &json!(archive)).unwrap();
        config::save(&env, &json!({"roots":["~/project"],"presets":[],"archiveDir":archive_dir})).unwrap();
        let mode = |mode: u32| fs::set_permissions(&shared, fs::Permissions::from_mode(mode)).unwrap();
        mode(0o555);
        if fs::write(shared.join("probe"), "").is_ok() {
            eprintln!("Nothing is read-only to this user, as to root; nothing to check.");
            mode(0o755);
            return;
        }
        let mut service = Service::new(env.clone());
        service.snapshot().unwrap();
        let moved = service.request("archive", &json!({"id":project,"destination":archive.join("demo")}));
        mode(0o755);
        let error = moved.unwrap_err();
        assert!(error.contains("ermission denied"), "{error}");
        let names = |dir: &Path| fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name()).collect::<Vec<_>>();
        assert!(names(&archive).is_empty(), "nothing was copied or published there");
        assert_eq!(names(&shared), ["demo"]);
        assert_eq!(fs::read_to_string(project.join("src/main.js")).unwrap(), "console.log(1)\n");
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

    #[test]
    fn a_program_is_the_first_on_the_path_that_can_run() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, root) = folder();
        let (first, second) = (root.join("first"), root.join("second"));
        fs::create_dir_all(first.join("folder")).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(first.join("tool"), "#!/bin/sh\n").unwrap();
        fs::write(second.join("tool"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(second.join("tool"), fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(platform::which("tool", &path), Some(second.join("tool")), "the first one can't run");
        assert_eq!(platform::which("folder", &path), None, "a folder is no program");
        assert_eq!(platform::which("missing", &path), None);
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

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        fs::{self, OpenOptions},
        io,
        os::windows::fs::OpenOptionsExt,
        path::Path,
        process::Stdio,
        thread,
        time::{Duration, Instant},
    };

    fn id(path: &Path) -> platform::Identity {
        platform::identity(path, &fs::metadata(path).unwrap()).unwrap()
    }

    /// Waits up to twenty seconds for `found` to give something: a program can be slow to start on Windows, where
    /// Defender looks at it first.
    fn soon<T>(what: &str, mut found: impl FnMut() -> Option<T>) -> T {
        let since = Instant::now();
        loop {
            if let Some(value) = found() {
                return value;
            }
            assert!(since.elapsed() < Duration::from_secs(20), "{what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// A folder on another volume than `near`, when this machine has one: Cargo's target folder can be.
    fn elsewhere(near: &Path) -> Option<tempfile::TempDir> {
        let volume = |p: &Path| Some(platform::identity(p, &fs::metadata(p).ok()?).ok()?.volume);
        let target = Path::new(env!("CARGO_TARGET_TMPDIR"));
        if volume(target)? == volume(near)? {
            return None;
        }
        tempfile::tempdir_in(target).ok()
    }

    #[test]
    fn identity_is_one_per_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let (a, b) = (root.join("a"), root.join("b"));
        fs::write(&a, "same bytes").unwrap();
        fs::write(&b, "same bytes").unwrap();
        fs::hard_link(&a, root.join("hard")).unwrap();
        assert_eq!(id(&a), id(&a));
        assert_eq!(id(&a), id(&root.join("hard")), "a second name of the same file");
        assert_ne!(id(&a), id(&b), "another file, even with the same bytes");
        assert_eq!(id(&a).volume, id(&b).volume);
        let before = id(&a);
        fs::rename(&a, root.join("moved")).unwrap();
        assert_eq!(id(&root.join("moved")), before, "a file keeps its identity when renamed");
        let (dir, link, junction) = (root.join("dir"), root.join("link"), root.join("junction"));
        fs::create_dir(&dir).unwrap();
        support::link_dir(&dir, &link);
        // pnpm's links, which need no privilege.
        support::junction(&dir, &junction);
        // The link itself, as `symlink_metadata` reads it, and never what it leads to.
        let own = |path: &Path| platform::identity(path, &fs::symlink_metadata(path).unwrap()).unwrap();
        for link in [&link, &junction] {
            assert_eq!(id(link), id(&dir), "a link is followed");
            assert_ne!(own(link), id(&dir), "the link itself");
            assert_eq!(own(link), own(link));
            let stamp = platform::change_stamp(link, &fs::symlink_metadata(link).unwrap()).unwrap();
            assert_eq!(stamp.identity, own(link), "the link's own times come with its identity");
        }
        assert_ne!(own(&link), own(&junction));
    }

    #[test]
    fn the_change_lock_is_exclusive_until_dropped_and_its_file_stays() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("lock");
        let held = platform::lock(path.clone()).unwrap();
        let Err(error) = platform::lock(path.clone()) else { panic!("a second holder") };
        assert_eq!(error, "Another laci window or agent is changing files right now. Try again in a moment.");
        drop(held);
        assert!(path.is_file(), "a lock file that is being deleted can't be opened, so it stays");
        drop(platform::lock(path.clone()).unwrap());
        // A lock file in a linked folder is never trusted.
        let (real, linked) = (temp.path().join("real"), temp.path().join("linked"));
        fs::create_dir(&real).unwrap();
        support::link_dir(&real, &linked);
        fs::write(real.join("lock"), "").unwrap();
        let Err(error) = platform::lock(linked.join("lock")) else { panic!("a lock in a linked folder") };
        assert!(error.starts_with("Refusing to edit linked path"), "{error}");
    }

    #[test]
    fn a_rename_never_replaces_and_never_copies() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
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
        let Some(other) = elsewhere(root) else {
            eprintln!("No second volume here; the rename across volumes is not checked.");
            return;
        };
        let there = other.path().join("dest");
        let error = platform::rename_noreplace(&dest, &there).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::CrossesDevices, "{error}");
        assert!(dest.join("file").is_file() && !there.exists(), "nothing copied, nothing removed");
    }

    #[test]
    fn a_link_is_never_copied() {
        let temp = tempfile::tempdir().unwrap();
        let (dir, link) = (temp.path().join("dir"), temp.path().join("link"));
        fs::create_dir(&dir).unwrap();
        support::link_dir(&dir, &link);
        let error = platform::copy_link(&link, &temp.path().join("copy")).unwrap_err();
        assert!(error.starts_with("Laci can't copy the link "), "{error}");
        assert!(!temp.path().join("copy").exists());
    }

    #[test]
    fn a_program_is_found_with_an_extension_from_pathext() {
        let path = std::env::var_os("PATH").unwrap();
        let found = platform::which("cmd", &path).unwrap();
        assert!(found.file_name().unwrap().eq_ignore_ascii_case("cmd.exe"), "{}", found.display());
        assert!(platform::which("laci-no-such-program", &path).is_none());
    }

    const FINISHED: &str = "windows::a_finished_child_is_seen_and_can_still_be_waited_for";

    #[test]
    fn a_finished_child_is_seen_and_can_still_be_waited_for() {
        if support::role().is_some() {
            return;
        }
        let mut child = support::program(FINISHED, "finish").stdout(Stdio::null()).spawn().unwrap();
        soon("the child finishes", || platform::exited(&mut child).unwrap().then_some(()));
        assert!(platform::exited(&mut child).unwrap(), "asking again changes nothing");
        assert!(child.wait().unwrap().success());
    }

    const GROUP: &str = "windows::stopping_a_group_stops_what_its_program_started";
    /// The file that the child of the group's program holds open.
    const HELD: &str = "LACI_TEST_HELD";

    #[test]
    fn stopping_a_group_stops_what_its_program_started() {
        match support::role().as_deref() {
            // The group's program: starts a child, then waits for it.
            Some("parent") => {
                let _ = support::program(GROUP, "child").status();
                return;
            }
            // Its child: holds a file open that nobody else may open, until it is stopped.
            Some("child") => {
                let path = std::env::var_os(HELD).unwrap();
                let _held = OpenOptions::new().write(true).create_new(true).share_mode(0).open(path).unwrap();
                thread::sleep(Duration::from_secs(30));
                return;
            }
            Some("exit") => std::process::exit(3),
            _ => {}
        }
        let temp = tempfile::tempdir().unwrap();
        let held = temp.path().join("held");
        // ERROR_SHARING_VIOLATION: the child still runs.
        let in_use = || fs::File::open(&held).is_err_and(|e| e.raw_os_error() == Some(32));
        let mut command = support::program(GROUP, "parent");
        command.env(HELD, &held).stdout(Stdio::null());
        let mut group = platform::spawn_group(command).unwrap();
        soon("the program starts its child", || in_use().then_some(()));
        assert!(!group.exited().unwrap());
        group.stop();
        assert!(!group.wait().unwrap().success());
        soon("the child it started stops too", || (!in_use()).then_some(()));

        let mut command = support::program(GROUP, "exit");
        command.stdout(Stdio::null());
        let mut group = platform::spawn_group(command).unwrap();
        soon("the program finishes", || group.exited().unwrap().then_some(()));
        group.stop();
        assert_eq!(group.wait().unwrap().code(), Some(3));
    }
}

/// Until macOS and Windows have their own, these checks fail there: a folder must never pass as "not in use".
#[cfg(not(target_os = "linux"))]
#[test]
fn the_bin_refuses_what_isnt_there() {
    assert!(platform::trash(&std::env::temp_dir().join("laci-missing-entry")).is_err());
}
