//! The checks that keep Laci from changing a folder a program works in, or history a program writes to. Where a check
//! can't look, it refuses instead of answering.
use laci_core::{config, deletion, env::Env, ops, paths, platform, service::Service};
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

mod support;

/// Waits up to twenty seconds for `found` to give something.
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

/// A temporary folder, spelled as the OS names working folders: with links resolved.
fn folder() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    (temp, root)
}

/// Killed and reaped when the test ends, also when it fails.
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// This test binary started again in `dir`, to play `role` in `test` (see [`support::program`]).
fn start(test: &str, role: &str, dir: &Path) -> Running {
    Running(support::program(test, role).current_dir(dir).stdout(Stdio::null()).spawn().unwrap())
}

/// The part of a started test binary that works in its folder until it is stopped.
fn stay() {
    thread::sleep(Duration::from_secs(60));
}

/// Waits until `platform::processes_in` lists `child` inside `dir`.
fn found_in(dir: &Path, child: &Running) -> platform::Holder {
    let pid = child.0.id();
    soon("the program in the folder is found", || {
        platform::processes_in(&[dir.to_owned()]).unwrap().into_iter().find(|h| h.pid == pid)
    })
}

const FOUND: &str = "a_process_working_inside_a_folder_is_found";

#[test]
fn a_process_working_inside_a_folder_is_found() {
    if support::role().is_some() {
        return stay();
    }
    let (_temp, root) = folder();
    let (project, beside) = (root.join("project"), root.join("project-old"));
    fs::create_dir_all(project.join("src")).unwrap();
    fs::create_dir(&beside).unwrap();
    let child = start(FOUND, "stay", &project.join("src"));
    let pid = child.0.id();
    let found = found_in(&project, &child);
    // Linux keeps the first 15 bytes of a program's name. The test runner can give the child's main thread the
    // test's name as it starts, and Linux then shows that instead, so either may be read.
    let program = std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().into_owned();
    assert!(program.starts_with(&found.name) || FOUND.starts_with(&found.name), "{}", found.name);
    assert_eq!(fs::canonicalize(&found.cwd).unwrap(), fs::canonicalize(project.join("src")).unwrap());
    let listed = |path: PathBuf| platform::processes_in(&[path]).unwrap().iter().any(|h| h.pid == pid);
    // As Laci keeps its folders: with links resolved.
    assert!(listed(fs::canonicalize(&project).unwrap()));
    assert!(!listed(beside), "a folder whose name only begins the same");
    let everything = platform::processes_in(&[root.ancestors().last().unwrap().to_owned()]).unwrap();
    assert!(everything.iter().any(|h| h.pid == pid));
    assert!(everything.iter().all(|h| h.pid != std::process::id()), "never this process");
    drop(child);
    assert!(!listed(project), "gone once stopped");
}

/// What `ensure_idle` says about a file another program writes to.
const WRITER: &str = "History has an open writer. Stop the session before cleaning it up.";
const IDLE: &str = "history_with_a_writer_or_a_process_inside_is_not_idle";

#[test]
fn history_with_a_writer_or_a_process_inside_is_not_idle() {
    if support::role().is_some() {
        return stay();
    }
    let (_temp, root) = folder();
    let history = root.join("history");
    fs::create_dir(&history).unwrap();
    let log = history.join("session.jsonl");
    fs::write(&log, "{}\n").unwrap();
    let sources = std::slice::from_ref(&history);
    // A program another test starts holds this process's open files until it runs, so a file this test wrote can
    // stay open there for a moment.
    let idle = || platform::ensure_idle(sources).ok();
    soon("idle while nothing holds the history", idle);
    let reader = File::open(&log).unwrap();
    // Only writers count.
    platform::ensure_idle(sources).unwrap();
    drop(reader);
    soon("idle once the reader is closed", idle);
    let writer = OpenOptions::new().append(true).open(&log).unwrap();
    assert_eq!(platform::ensure_idle(sources).unwrap_err(), WRITER);
    drop(writer);
    soon("idle once the writer is closed", idle);
    let inside = "History is in use by a running process. Close it first.";
    let child = start(IDLE, "stay", &history);
    soon("the process inside is found", || platform::ensure_idle(sources).err().filter(|e| e == inside));
    drop(child);
    soon("idle once it stopped", idle);
    let gone = [root.join("gone")];
    platform::ensure_idle(&gone).unwrap();
}

const ALIVE: &str = "a_process_id_is_alive_while_its_process_runs";

#[test]
fn a_process_id_is_alive_while_its_process_runs() {
    if support::role().is_some() {
        return stay();
    }
    assert!(platform::pid_alive(std::process::id()).unwrap());
    assert!(!platform::pid_alive(u32::MAX).unwrap());
    // Another user's: init.
    assert!(platform::pid_alive(1).unwrap());
    let mut child = Running(support::program(ALIVE, "stay").stdout(Stdio::null()).spawn().unwrap());
    let pid = child.0.id();
    assert!(platform::pid_alive(pid).unwrap());
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    // Reaped, its id is free again.
    assert!(!platform::pid_alive(pid).unwrap());
}

/// Laci v1's lock holds a process id, which Laci checks.
#[test]
fn a_lock_left_by_a_process_that_is_gone_is_taken_over() {
    let (_temp, root) = folder();
    let path = root.join("lock");
    fs::write(&path, std::process::id().to_string()).unwrap();
    assert!(platform::lock(path.clone()).is_err(), "a v1 lock of a running Laci");
    fs::write(&path, u32::MAX.to_string()).unwrap();
    // A program another test starts holds this process's open files until it runs, so for a moment it can still
    // hold the lock the check above took.
    drop(soon("the lock is taken over", || platform::lock(path.clone()).ok()));
    assert!(!path.exists());
}

const MOVE: &str = "a_move_waits_until_no_program_works_in_the_folder";

#[test]
fn a_move_waits_until_no_program_works_in_the_folder() {
    if support::role().is_some() {
        return stay();
    }
    // As Laci spells the folders it finds.
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let (from, to) = (env.home.join("project/demo"), env.home.join("project/_archive/demo"));
    fs::create_dir_all(from.join("src")).unwrap();
    fs::write(from.join("README.md"), "# demo\n").unwrap();
    let snap = json!({"nodes":{"demo":{"name":"demo","path":from,"kind":"project"}}});
    let child = start(MOVE, "stay", &from.join("src"));
    found_in(&from, &child);
    let error = ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({})).unwrap_err();
    assert!(error.starts_with("In use by ") && error.contains(&format!("(pid {})", child.0.id())), "{error}");
    assert!(from.join("README.md").is_file() && !to.exists(), "nothing moved");
    drop(child);
    ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({})).unwrap();
    assert!(to.join("README.md").is_file() && !from.exists());
}

const CLEANUP: &str = "history_cleanup_waits_for_a_writer_working_elsewhere";
/// The log the writer in [`history_cleanup_waits_for_a_writer_working_elsewhere`] opens, and the file it writes once
/// it has.
const LOG: &str = "LACI_TEST_LOG";
const READY: &str = "LACI_TEST_READY";

#[test]
fn history_cleanup_waits_for_a_writer_working_elsewhere() {
    if support::role().is_some() {
        let _writer = OpenOptions::new().append(true).open(std::env::var_os(LOG).unwrap()).unwrap();
        fs::write(std::env::var_os(READY).unwrap(), "").unwrap();
        return stay();
    }
    // As Laci spells the folders it finds, which the log records the project with.
    let temp = support::tempdir();
    let root = temp.path();
    let env = Env::for_home(root.join("home"));
    fs::create_dir_all(env.home.join("projects")).unwrap();
    config::save(&env, &json!({"roots":["~/projects"],"presets":["claude"]})).unwrap();
    let gone = env.home.join("projects/gone");
    let history = env.home.join(".claude/projects").join(paths::enc(gone.to_str().unwrap()));
    let log = history.join("session.jsonl");
    fs::create_dir_all(&history).unwrap();
    fs::write(&log, format!("{}\n", json!({"cwd":gone}))).unwrap();
    let mut service = Service::new(env.clone());
    let snapshot = service.snapshot().unwrap();
    let orphan = snapshot["proposals"].as_array().unwrap().iter().find(|p| p["category"] == "orphan").unwrap();
    let apply = json!({"id":orphan["id"]});
    let ready = root.join("ready");
    let mut writer = support::program(CLEANUP, "write");
    writer.env(LOG, &log).env(READY, &ready).current_dir(root).stdout(Stdio::null());
    let writer = Running(writer.spawn().unwrap());
    soon("the writer has the log open", || ready.exists().then_some(()));
    assert_eq!(service.request("apply", &apply).unwrap_err(), WRITER);
    assert!(log.is_file());
    drop(writer);
    service.request("apply", &apply).unwrap();
    assert!(!history.exists(), "put aside once the writer is gone");
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.test")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.test")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

const TRASH: &str = "moving_a_project_to_the_trash_waits_until_no_program_works_in_it";

#[test]
fn moving_a_project_to_the_trash_waits_until_no_program_works_in_it() {
    if support::role().is_some() {
        return stay();
    }
    // As Laci spells the folders it finds.
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let (dir, remote) = (env.home.join("project/demo"), env.home.join("backup.git"));
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "--bare", "--initial-branch=main"]);
    git(&dir, &["init", "--initial-branch=main"]);
    fs::write(dir.join("README.md"), "backed up\n").unwrap();
    git(&dir, &["add", "README.md"]);
    git(&dir, &["commit", "-m", "initial"]);
    git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&dir, &["push", "-u", "origin", "main"]);
    let node = json!({"kind":"project","path":dir,"name":"demo"});
    assert_eq!(deletion::plan(&env, &node).unwrap()["allowed"], true);
    let child = start(TRASH, "stay", &dir);
    let name = found_in(&dir, &child).name;
    let plan = deletion::plan(&env, &node).unwrap();
    assert_eq!(plan["allowed"], false);
    let held = format!("This project is in use by {name} (pid {}). Close it first.", child.0.id());
    assert_eq!(plan["checks"][0]["detail"], held.as_str());
    assert_eq!(deletion::trash(&env, &node).unwrap_err(), held);
    assert!(dir.join("README.md").is_file());
}
