//! The checks that keep Laci from changing a folder a program works in, or history a program writes to. They run on
//! every OS, and where a check can't look, it refuses instead of answering.
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

/// What Windows' history check makes of Restart Manager's answer. It needs no Windows, so it is built here as well, and
/// its tests run on every OS.
#[path = "../src/platform/windows/process/restart_manager.rs"]
mod restart_manager;

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

/// A temporary folder, spelled as the OS names working folders: with links resolved on Linux and macOS, where it
/// can sit below one such as /var, and as given on Windows.
fn folder() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = if cfg!(windows) { temp.path().to_owned() } else { temp.path().canonicalize().unwrap() };
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
    // As Laci keeps its folders: with links and Windows' short 8.3 names resolved.
    assert!(listed(fs::canonicalize(&project).unwrap()));
    if !cfg!(target_os = "linux") {
        assert!(listed(root.join("PROJECT")), "macOS and Windows ignore case");
    }
    assert!(!listed(beside), "a folder whose name only begins the same");
    let everything = platform::processes_in(&[root.ancestors().last().unwrap().to_owned()]).unwrap();
    assert!(everything.iter().any(|h| h.pid == pid));
    assert!(everything.iter().all(|h| h.pid != std::process::id()), "never this process");
    drop(child);
    assert!(!listed(project), "gone once stopped");
}

/// What `ensure_idle` says about a file another program writes to. Windows refuses any other holder, reader or writer
/// alike: a file another program holds open often can't be moved there.
const WRITER: &str = if cfg!(windows) {
    "History is open in another program. Stop the session before cleaning it up."
} else {
    "History has an open writer. Stop the session before cleaning it up."
};
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
    // Linux and macOS look for writers only, and Windows leaves out what Laci itself has open.
    platform::ensure_idle(sources).unwrap();
    drop(reader);
    soon("idle once the reader is closed", idle);
    let writer = OpenOptions::new().append(true).open(&log).unwrap();
    if cfg!(windows) {
        // Restart Manager doesn't tell Laci's own writer from its reader. Other programs' writers are checked in
        // `an_agent_appending_to_history_is_refused_on_windows_and_keeps_writing`.
        platform::ensure_idle(sources).unwrap();
    } else {
        assert_eq!(platform::ensure_idle(sources).unwrap_err(), WRITER);
    }
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
    // Another user's: init or launchd, which macOS doesn't let this process signal, and Windows' System.
    assert!(platform::pid_alive(if cfg!(windows) { 4 } else { 1 }).unwrap());
    let mut child = Running(support::program(ALIVE, "stay").stdout(Stdio::null()).spawn().unwrap());
    let pid = child.0.id();
    assert!(platform::pid_alive(pid).unwrap());
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    // Reaped, its id is free again. Windows hands ids out again soon, so another process could have it by now.
    if cfg!(unix) {
        assert!(!platform::pid_alive(pid).unwrap());
    }
}

/// Laci v1's lock holds a process id, which Linux and macOS check. Windows' lock is on the open file instead.
#[cfg(unix)]
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
#[cfg_attr(windows, ignore = "port:P4/P9b: Windows paths and file times aren't written yet")]
fn a_move_waits_until_no_program_works_in_the_folder() {
    if support::role().is_some() {
        return stay();
    }
    let (_temp, root) = folder();
    let env = Env::for_home(root.join("home"));
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
#[cfg_attr(windows, ignore = "port:P4/P9b: Windows paths and file times aren't written yet")]
fn history_cleanup_waits_for_a_writer_working_elsewhere() {
    if support::role().is_some() {
        let _writer = OpenOptions::new().append(true).open(std::env::var_os(LOG).unwrap()).unwrap();
        fs::write(std::env::var_os(READY).unwrap(), "").unwrap();
        return stay();
    }
    let (_temp, root) = folder();
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
    writer.env(LOG, &log).env(READY, &ready).current_dir(&root).stdout(Stdio::null());
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
#[cfg_attr(windows, ignore = "port:P4/P9b: Windows paths and file times aren't written yet")]
fn moving_a_project_to_the_trash_waits_until_no_program_works_in_it() {
    if support::role().is_some() {
        return stay();
    }
    let (_temp, root) = folder();
    let env = Env::for_home(root.join("home"));
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

#[cfg(windows)]
const APPENDING: &str = "an_agent_appending_to_history_is_refused_on_windows_and_keeps_writing";
/// The log the writer in [`an_agent_appending_to_history_is_refused_on_windows_and_keeps_writing`] appends to the way
/// an agent does, opening it for each line, and the file that tells it to stop.
#[cfg(windows)]
const AGENT_LOG: &str = "LACI_TEST_AGENT_LOG";
#[cfg(windows)]
const STOP: &str = "LACI_TEST_STOP";

/// [`support::program`] run from a copy of this test binary in `dir`: a program of its own, as an agent is. The check
/// takes this test binary for Laci's own program, and waits for it as for the desktop app.
#[cfg(windows)]
fn agent(test: &str, role: &str, dir: &Path) -> Command {
    let copy = dir.join("agent.exe");
    if !copy.exists() {
        fs::copy(std::env::current_exe().unwrap(), &copy).unwrap();
    }
    let program = support::program(test, role);
    let mut agent = Command::new(copy);
    agent.args(program.get_args());
    for (key, value) in program.get_envs() {
        if let Some(value) = value {
            agent.env(key, value);
        }
    }
    agent
}

/// Restart Manager finds a program appending to history without opening the logs: every check refuses at once, and
/// none of the program's writes fails, not even one that opens its log just then, as an exclusive open could make it.
/// A reader in Laci itself doesn't count.
#[cfg(windows)]
#[test]
fn an_agent_appending_to_history_is_refused_on_windows_and_keeps_writing() {
    if support::role().is_some() {
        return append();
    }
    let (_temp, root) = folder();
    let history = root.join("history");
    fs::create_dir(&history).unwrap();
    let (log, agent_log) = (history.join("session.jsonl"), history.join("agent.jsonl"));
    fs::write(&log, "{}\n").unwrap();
    fs::write(&agent_log, "{}\n").unwrap();
    let sources = std::slice::from_ref(&history);
    let (ready, stop) = (root.join("ready"), root.join("stop"));
    let mut writer = agent(APPENDING, "append", &root);
    writer.env(LOG, &log).env(AGENT_LOG, &agent_log).env(READY, &ready).env(STOP, &stop).current_dir(&root);
    let mut writer = Running(writer.stdout(Stdio::null()).spawn().unwrap());
    soon("the writer has the log open", || ready.exists().then_some(()));
    let before = fs::metadata(&agent_log).unwrap().len();
    for _ in 0..20 {
        let checked = Instant::now();
        assert_eq!(platform::ensure_idle(sources).unwrap_err(), WRITER);
        assert!(checked.elapsed() < Duration::from_secs(3), "refused without the wait another Laci gets");
    }
    assert!(fs::metadata(&agent_log).unwrap().len() > before, "it wrote while Laci checked");
    fs::write(&stop, "").unwrap();
    assert!(writer.0.wait().unwrap().success(), "none of its writes failed");
    let reader = File::open(&log).unwrap();
    soon("idle while only Laci reads the log", || platform::ensure_idle(sources).ok());
    drop(reader);
}

/// The writer in [`an_agent_appending_to_history_is_refused_on_windows_and_keeps_writing`] and
/// [`a_long_path_in_history_is_checked_or_refused_on_windows`]: it holds the session's log open for append and writes
/// to it, and appends to the agent's log, opening it for each line, until the stop file appears. Its run fails when a
/// write did.
#[cfg(windows)]
fn append() {
    use std::io::Write;
    let path = |name: &str| PathBuf::from(std::env::var_os(name).unwrap());
    let (agent, stop) = (path(AGENT_LOG), path(STOP));
    let mut log = OpenOptions::new().append(true).open(path(LOG)).unwrap();
    fs::write(path(READY), "").unwrap();
    let mut failed = 0;
    while !stop.exists() {
        failed += usize::from(log.write_all(b"{}\n").is_err());
        let line = OpenOptions::new().append(true).open(&agent).and_then(|mut file| file.write_all(b"{}\n"));
        failed += usize::from(line.is_err());
    }
    assert_eq!(failed, 0, "writes failed while Laci checked");
}

/// With no file to hold, history is idle: a source that is gone, and an empty folder.
#[cfg(windows)]
#[test]
fn history_without_files_is_idle_on_windows() {
    let (_temp, root) = folder();
    let empty = root.join("empty");
    fs::create_dir(&empty).unwrap();
    platform::ensure_idle(&[root.join("gone")]).unwrap();
    platform::ensure_idle(&[empty]).unwrap();
}

#[cfg(windows)]
const LONG: &str = "a_long_path_in_history_is_checked_or_refused_on_windows";

/// A file whose path is longer than MAX_PATH can be named to Restart Manager only in the `\\?\` spelling, which Laci
/// uses once it has seen Restart Manager read it. Either way a program holding such a file never lets the history
/// through: it is found, or the history is refused for its long path.
#[cfg(windows)]
#[test]
fn a_long_path_in_history_is_checked_or_refused_on_windows() {
    use std::os::windows::ffi::OsStrExt;
    if support::role().is_some() {
        return append();
    }
    let (_temp, root) = folder();
    let history = root.join("history");
    let deep = history.join("d".repeat(120)).join("e".repeat(120));
    fs::create_dir_all(&deep).unwrap();
    let log = deep.join("session.jsonl");
    assert!(log.as_os_str().encode_wide().count() >= 260, "past MAX_PATH");
    fs::write(&log, "{}\n").unwrap();
    let (agent_log, ready, stop) = (root.join("agent.jsonl"), root.join("ready"), root.join("stop"));
    fs::write(&agent_log, "{}\n").unwrap();
    let mut writer = agent(LONG, "append", &root);
    writer.env(LOG, &log).env(AGENT_LOG, &agent_log).env(READY, &ready).env(STOP, &stop).current_dir(&root);
    let mut writer = Running(writer.stdout(Stdio::null()).spawn().unwrap());
    soon("the writer has the log open", || ready.exists().then_some(()));
    let sources = std::slice::from_ref(&history);
    let held = platform::ensure_idle(sources).unwrap_err();
    assert!(held == WRITER || held == restart_manager::TOO_LONG, "{held}");
    fs::write(&stop, "").unwrap();
    assert!(writer.0.wait().unwrap().success(), "none of its writes failed");
    if held == WRITER {
        eprintln!(r"Restart Manager reads long paths in the \\?\ spelling");
        soon("idle once the writer is gone", || platform::ensure_idle(sources).ok());
    } else {
        eprintln!("Restart Manager wasn't seen reading long paths, so they are refused");
        assert_eq!(platform::ensure_idle(sources).unwrap_err(), restart_manager::TOO_LONG);
    }
}

/// A file whose name Windows changes before it opens it by the plain spelling, such as one that ends in a dot or a
/// space or is named like a device, can be made only in the `\\?\` spelling. Restart Manager would look at another
/// file in its place and find nobody holding it, so the history is refused instead.
#[cfg(windows)]
#[test]
fn a_file_windows_reads_as_another_is_refused_on_windows() {
    let (_temp, root) = folder();
    for (kind, name) in [("dot", "log."), ("space", "log "), ("device", "aux.jsonl")] {
        let history = root.join(kind);
        fs::create_dir(&history).unwrap();
        fs::write(fs::canonicalize(&history).unwrap().join(name), "{}\n").unwrap();
        assert_eq!(platform::ensure_idle(&[history]).unwrap_err(), restart_manager::ODD_NAME, "{name:?}");
    }
}

#[cfg(windows)]
const LACI: &str = "another_laci_with_history_open_is_waited_for_on_windows";

/// Another process that runs Laci's program with a log open, such as the desktop app's scan while `laci mcp` cleans
/// up, is waited for: the check passes once it lets go, and refuses if it keeps the log open past the wait. To the
/// check, this test binary is Laci's program, so that process is this test binary started again.
#[cfg(windows)]
#[test]
fn another_laci_with_history_open_is_waited_for_on_windows() {
    if support::role().is_some() {
        return hold();
    }
    let (_temp, root) = folder();
    let history = root.join("history");
    fs::create_dir(&history).unwrap();
    let log = history.join("session.jsonl");
    fs::write(&log, "{}\n").unwrap();
    let sources = std::slice::from_ref(&history);
    let reader = |ready: &Path, stop: &Path| {
        let mut reader = support::program(LACI, "hold");
        reader.env(LOG, &log).env(READY, ready).env(STOP, stop).current_dir(&root);
        let reader = Running(reader.stdout(Stdio::null()).spawn().unwrap());
        soon("the other Laci has the log open", || ready.exists().then_some(()));
        reader
    };
    let (ready, stop) = (root.join("ready"), root.join("stop"));
    let mut brief = reader(&ready, &stop);
    let letting_go = thread::spawn(move || {
        thread::sleep(Duration::from_secs(1));
        fs::write(stop, "").unwrap();
    });
    let checked = Instant::now();
    platform::ensure_idle(sources).unwrap();
    assert!(checked.elapsed() >= Duration::from_millis(900), "not idle while the other Laci had the log open");
    letting_go.join().unwrap();
    assert!(brief.0.wait().unwrap().success());
    let _lasting = reader(&root.join("ready-again"), &root.join("stop-again"));
    let checked = Instant::now();
    assert_eq!(platform::ensure_idle(sources).unwrap_err(), WRITER);
    assert!(checked.elapsed() >= Duration::from_secs(1), "refused once the wait was over");
}

/// The other Laci in [`another_laci_with_history_open_is_waited_for_on_windows`]: it holds the log open for reading,
/// as a scan does, until the stop file appears.
#[cfg(windows)]
fn hold() {
    let path = |name: &str| PathBuf::from(std::env::var_os(name).unwrap());
    let stop = path(STOP);
    let _log = File::open(path(LOG)).unwrap();
    fs::write(path(READY), "").unwrap();
    while !stop.exists() {
        thread::sleep(Duration::from_millis(10));
    }
}
