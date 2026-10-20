//! Laci's command line, which both of its programs answer: `laci`, the window's program, and `laci-cli`, the console
//! program Windows' installer ships as bin\laci.exe, since a window's program there has no console to print to or to
//! talk to an agent through. Without a command, `laci` opens the window and `laci-cli` starts `laci` and returns.
mod mcp;

use clap::{Parser, Subcommand, ValueEnum};
use laci_core::{
    env::Env,
    platform,
    service::{Service, array, string},
};
use serde_json::Value;
use std::{
    ffi::OsString,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(version, about = "Projects, agent history and safe moves")]
struct Cli {
    #[command(subcommand)]
    command: Option<Action>,
}
#[derive(Subcommand)]
enum Action {
    Ls,
    Doctor,
    Json,
    Mcp,
}

/// The commands only Laci and its installer run. They have a parser of their own, picked by their leading `__`, so
/// the command line people use never names them: not in its help, nor as the tip for a mistyped command.
#[derive(Parser)]
#[command(name = "laci")]
struct Internal {
    #[command(subcommand)]
    command: Hidden,
}
#[derive(Subcommand)]
enum Hidden {
    /// Runs the steps of an action, in a terminal Laci opened. Laci starts it, people don't.
    #[command(name = "__action")]
    Steps {
        /// The steps, as Laci wrote them.
        #[arg(long)]
        file: PathBuf,
    },
    /// Puts a folder on the user's Path or takes it off: Windows' installer and uninstaller run it.
    #[command(name = "__path")]
    UserPath { change: Change, dir: PathBuf },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Change {
    Add,
    Remove,
}

/// What the command line asks for.
enum Asked {
    /// One of the commands people use, or none.
    Public(Option<Action>),
    /// One of the commands only Laci and its installer run.
    Internal(Hidden),
}

/// Reads the command line `args`, the program's own name first.
fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Asked, clap::Error> {
    let args: Vec<OsString> = args.into_iter().collect();
    if args.get(1).is_some_and(|word| word.as_encoded_bytes().starts_with(b"__")) {
        Internal::try_parse_from(args).map(|internal| Asked::Internal(internal.command))
    } else {
        Cli::try_parse_from(args).map(|cli| Asked::Public(cli.command))
    }
}

/// Which of Laci's programs runs, and so what it does without a command.
pub enum Program {
    /// The window's program, `laci`: it opens the window with this.
    Window(fn(Env) -> laci_core::Result<()>),
    /// The console program, `laci-cli`: it starts the window's program and returns.
    Console,
}

/// Does what the command line asks, and exits with 1 after saying why when that fails.
pub fn main(program: Program) {
    let asked = parse(std::env::args_os()).unwrap_or_else(|error| error.exit());
    if let Err(error) = run(asked, program) {
        eprintln!("laci: {error}");
        std::process::exit(1);
    }
}

fn run(asked: Asked, program: Program) -> laci_core::Result<()> {
    let action = match asked {
        // Neither reads Laci's folders: the installer puts bin on the Path before Laci ever ran.
        Asked::Internal(Hidden::Steps { .. }) => {
            return Err("This Laci can't run actions from the command line yet.".into());
        }
        Asked::Internal(Hidden::UserPath { change, dir }) => return user_path(change, &dir),
        Asked::Public(action) => action,
    };
    match action {
        None => match program {
            Program::Window(open) => {
                #[cfg(target_os = "macos")]
                if let Some(app) = linked_app() {
                    return open_app(&app);
                }
                open(Env::from_process()?)
            }
            Program::Console => start_window(
                &std::env::current_exe().map_err(|e| format!("Laci couldn't tell where its own program is: {e}"))?,
            ),
        },
        Some(Action::Mcp) => mcp::run(Env::from_process()?),
        Some(action) => {
            let snapshot = Service::new(Env::from_process()?).rescan()?;
            let mut out = io::stdout().lock();
            let written = match action {
                Action::Json => writeln!(out, "{snapshot:#}"),
                Action::Doctor => doctor(&snapshot, &mut out),
                _ => list(&snapshot, &mut out),
            };
            match written {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
    }
}

fn user_path(change: Change, dir: &Path) -> laci_core::Result<()> {
    let add = change == Change::Add;
    let said = match (add, platform::edit_user_path(dir, add)?) {
        (true, true) => "added it to the user's Path",
        (true, false) => "it was on the user's Path already",
        (false, true) => "took it off the user's Path",
        (false, false) => "it wasn't on the user's Path",
    };
    println!("{}: {said}", dir.display());
    Ok(())
}

/// Starts the window's program for the console program `exe` ([`window_program`]) and returns without waiting for it.
/// The window gets nothing of this terminal ([`platform::start_detached`]): a caller that reads everything `laci`
/// prints, as an agent's shell does, is done when this returns, and Ctrl+C here doesn't close the window. It works in
/// its own folder, so it holds no project folder in use, which on Windows would keep that folder from moving.
fn start_window(exe: &Path) -> laci_core::Result<()> {
    let window = window_program(exe, cfg!(windows))
        .ok_or_else(|| format!("Laci couldn't find its window program beside {}", exe.display()))?;
    if !window.is_file() {
        return Err(format!("Laci's window program isn't at {}", window.display()));
    }
    let dir = window.parent().ok_or_else(|| format!("Laci's window program {} has no folder", window.display()))?;
    platform::start_detached(&window, &[], dir).map_err(|e| format!("Couldn't start {}: {e}", window.display()))
}

/// Where the window's program is for the console program at `exe`: on Windows, where the installer puts the console
/// program in bin, the laci.exe one folder up; else, as a build leaves them, the one beside it. None when that is
/// `exe` itself, which would only start itself again.
fn window_program(exe: &Path, windows: bool) -> Option<PathBuf> {
    let dir = exe.parent()?;
    let name = if windows { "laci.exe" } else { "laci" };
    let installed = windows && dir.file_name().is_some_and(|folder| folder.eq_ignore_ascii_case("bin"));
    if installed {
        return Some(dir.parent()?.join(name));
    }
    let itself = exe.file_name().is_some_and(|own| if windows { own.eq_ignore_ascii_case(name) } else { own == name });
    (!itself).then(|| dir.join(name))
}

/// The app macOS should open in place of this program, which was started through a link: the command line tool's
/// ~/.local/bin/laci, when `laci` is typed without a command.
#[cfg(target_os = "macos")]
fn linked_app() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    app_to_open(&exe, &std::fs::canonicalize(&exe).ok()?)
}

/// The app to open for the window's program started as `exe` (as macOS names it, links and all) whose real path is
/// `real`: the Laci.app it is in, when a link from outside any app started it. A window opened from there would never
/// update, as Tauri refuses a program path with a link in it, and it would close with the terminal. Opened as an app,
/// it starts from its own place, as from the Dock. None when `exe` is inside an app already, as when macOS starts it:
/// opening that app would only find this Laci running, which then quits. None too for a program outside any app.
#[cfg(any(target_os = "macos", test))]
fn app_to_open(exe: &Path, real: &Path) -> Option<PathBuf> {
    let app = |program: &Path| {
        let app = program.ancestors().nth(3)?;
        let inside = program.parent().is_some_and(|dir| dir.ends_with("Contents/MacOS"))
            && app.extension().is_some_and(|extension| extension == "app");
        inside.then(|| app.to_owned())
    };
    if app(exe).is_some() { None } else { app(real) }
}

/// Opens `app` as Finder would, which brings the window forward when Laci runs already.
#[cfg(target_os = "macos")]
fn open_app(app: &Path) -> laci_core::Result<()> {
    let opened = std::process::Command::new("/usr/bin/open")
        .arg(app)
        .status()
        .map_err(|e| format!("Couldn't open {}: {e}", app.display()))?;
    if !opened.success() {
        return Err(format!("macOS couldn't open {}", app.display()));
    }
    Ok(())
}

fn list(s: &Value, out: &mut impl Write) -> io::Result<()> {
    let mut nodes: Vec<_> =
        s["nodes"].as_object().into_iter().flatten().map(|(_, v)| v).filter(|n| n["kind"] == "project").collect();
    nodes.sort_by_key(|n| std::cmp::Reverse(string(&n["lastActivity"], "at")));
    for n in nodes {
        writeln!(out, "{:<9} {:<30} {}", string(&n["status"], "value"), string(n, "label"), string(n, "path"))?;
    }
    Ok(())
}
fn doctor(s: &Value, out: &mut impl Write) -> io::Result<()> {
    for n in s["nodes"].as_object().into_iter().flatten().map(|(_, n)| n) {
        let issues = array(&n["issues"]);
        let open: Vec<_> = array(&n["tasks"]).into_iter().filter(|t| t["done"] == false).collect();
        if issues.is_empty() && open.is_empty() {
            continue;
        }
        // A project line of its own, so a project without issues doesn't list its to-dos under the one before.
        writeln!(out, "{}  {}", string(n, "label"), string(n, "path"))?;
        for issue in issues {
            writeln!(out, "  ! {}", string(&issue, "title"))?;
        }
        for task in open {
            writeln!(out, "  [ ] {} ({}:{})", string(&task, "text"), string(&task, "file"), task["line"])?;
        }
    }
    for proposal in array(&s["proposals"]) {
        writeln!(out, "Tidy: {}", string(&proposal, "title"))?;
    }
    if let Some(error) = s["reportsDir"]["error"].as_str() {
        writeln!(out, "Reports folder {}: {error}", string(&s["reportsDir"], "path"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    fn asked(args: &[&str]) -> Asked {
        parse(args.iter().map(OsString::from)).unwrap_or_else(|e| panic!("{args:?}: {e}"))
    }
    fn public(args: &[&str]) -> Option<Action> {
        let Asked::Public(action) = asked(args) else { panic!("{args:?} is a command people use") };
        action
    }
    fn internal(args: &[&str]) -> Hidden {
        let Asked::Internal(hidden) = asked(args) else { panic!("{args:?} is a command only Laci runs") };
        hidden
    }
    /// What the command line says to `args` it can't read.
    fn refused(args: &[&str]) -> String {
        match parse(args.iter().map(OsString::from)) {
            Ok(_) => panic!("{args:?} was read"),
            Err(error) => error.render().to_string(),
        }
    }

    #[test]
    fn both_programs_read_the_same_commands_and_help_leaves_out_the_hidden_ones() {
        // The window's program, the console program as a build names it, and as the installer does.
        for program in ["laci", "laci-cli", r"C:\Program Files\Laci\bin\laci.exe"] {
            assert!(public(&[program]).is_none());
            assert!(matches!(public(&[program, "ls"]), Some(Action::Ls)));
            assert!(matches!(public(&[program, "doctor"]), Some(Action::Doctor)));
            assert!(matches!(public(&[program, "json"]), Some(Action::Json)));
            assert!(matches!(public(&[program, "mcp"]), Some(Action::Mcp)));
            let Hidden::Steps { file } = internal(&[program, "__action", "--file", r"C:\Temp\steps.json"]) else {
                panic!("__action");
            };
            assert_eq!(file, Path::new(r"C:\Temp\steps.json"));
            for (word, change) in [("add", Change::Add), ("remove", Change::Remove)] {
                let Hidden::UserPath { change: read, dir } =
                    internal(&[program, "__path", word, r"C:\Program Files\Laci\bin"])
                else {
                    panic!("__path {word}");
                };
                assert_eq!((read, dir), (change, PathBuf::from(r"C:\Program Files\Laci\bin")));
            }
            for wrong in [
                &[program, "__action"][..],
                &[program, "__path", "add"],
                &[program, "__path", "toggle", "C:\\x"],
                &[program, "__path", "add", "C:\\x", "C:\\y"],
                &[program, "__nothing"],
                &[program, "nothing"],
                &[program, "ls", "__path"],
            ] {
                refused(wrong);
            }
        }
        let help = Cli::command().render_long_help().to_string();
        for shown in ["ls", "doctor", "json", "mcp"] {
            assert!(help.contains(shown), "{help}");
        }
        for hidden in ["__action", "__path", "steps of an action", "user's Path"] {
            assert!(!help.contains(hidden), "{help}");
        }
        // Both print the version as `laci 3.0.0`, whatever their file is called; package-smoke reads it.
        assert_eq!(Cli::command().render_version(), format!("laci {}\n", env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn a_mistyped_command_is_never_pointed_at_a_hidden_one() {
        for (typed, hidden) in
            [("path", "__path"), ("action", "__action"), ("_path", "__path"), ("_action", "__action")]
        {
            let said = refused(&["laci", typed]);
            assert!(!said.contains(hidden), "{typed}: {said}");
        }
        // The commands people use still get their tip.
        assert!(refused(&["laci", "doctr"]).contains("doctor"));
    }

    #[test]
    fn the_hidden_commands_answer_without_laci_s_folders() {
        for program in [Program::Console, Program::Window(|_| Err("no window in a test".into()))] {
            let steps = asked(&["laci", "__action", "--file", "steps.json"]);
            assert_eq!(run(steps, program).unwrap_err(), "This Laci can't run actions from the command line yet.");
        }
        if !cfg!(windows) {
            let path = asked(&["laci", "__path", "add", "/opt/laci/bin"]);
            assert_eq!(
                run(path, Program::Console).unwrap_err(),
                "Only Windows keeps a Path for Laci's installer to change"
            );
        }
    }

    #[test]
    fn the_console_program_starts_the_window_s_program_beside_it_or_one_folder_up_from_bin() {
        let path = |parts: &[&str]| parts.iter().collect::<PathBuf>();
        // Windows: the installer's bin\laci.exe starts the laci.exe of the install folder.
        let install = ["C:", "Users", "me", "AppData", "Local", "Laci"];
        let window = |folder: &[&str]| Some(path(&[folder, &["laci.exe"]].concat()));
        assert_eq!(window_program(&path(&[&install[..], &["bin", "laci.exe"]].concat()), true), window(&install));
        assert_eq!(window_program(&path(&[&install[..], &["BIN", "laci.exe"]].concat()), true), window(&install));
        // A build leaves laci-cli.exe beside laci.exe.
        let debug = ["laci", "target", "debug"];
        assert_eq!(window_program(&path(&[&debug[..], &["laci-cli.exe"]].concat()), true), window(&debug));
        // A console program called laci.exe outside bin would be the window's program itself.
        assert_eq!(window_program(&path(&["D:", "Tools", "laci.exe"]), true), None);
        assert_eq!(window_program(&path(&["D:", "Tools", "LACI.EXE"]), true), None);
        // Linux and macOS: beside it, never itself; a folder named bin means nothing there.
        assert_eq!(
            window_program(Path::new("/home/me/laci/target/debug/laci-cli"), false),
            Some(PathBuf::from("/home/me/laci/target/debug/laci"))
        );
        assert_eq!(
            window_program(Path::new("/opt/laci/bin/laci-cli"), false),
            Some(PathBuf::from("/opt/laci/bin/laci"))
        );
        assert_eq!(window_program(Path::new("/usr/bin/laci"), false), None);
    }

    #[test]
    fn laci_started_through_the_command_line_tool_s_link_opens_its_app() {
        let app = Path::new("/Applications/Laci.app");
        let real = app.join("Contents/MacOS/laci");
        let link = Path::new("/Users/me/.local/bin/laci");
        assert_eq!(app_to_open(link, &real), Some(app.to_owned()));
        assert_eq!(app_to_open(Path::new("/usr/local/bin/laci"), &real), Some(app.to_owned()));
        // Started from its own place, as from the Dock or Finder: the window opens here.
        assert_eq!(app_to_open(&real, &real), None);
        // Started inside an app, even through a folder that is a link, as macOS starts apps: opening the app would only
        // find this Laci.
        let linked = Path::new("/Users/me/Apps/Laci.app/Contents/MacOS/laci");
        assert_eq!(app_to_open(linked, &real), None);
        // A link to a build, which no app holds: the window opens here.
        let build = Path::new("/Users/me/laci/target/debug/laci");
        assert_eq!(app_to_open(link, build), None);
        assert_eq!(app_to_open(link, Path::new("/Applications/Laci/Contents/MacOS/laci")), None);
        assert_eq!(app_to_open(link, Path::new("/laci")), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_window_starts_on_its_own_with_nothing_of_the_terminal() {
        let temp = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(temp.path()).unwrap();
        let console = dir.join("laci-cli");
        std::fs::write(&console, "").unwrap();
        // A stand-in for the window's program: it writes down where it works, its arguments, its input, its process
        // id and its group's. A child writes it, so this test never has a program open for writing: Linux won't start
        // one that a process another test starts meanwhile took along ("Text file busy").
        let window = dir.join("laci");
        let mut writer = Command::new("/bin/sh")
            .args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "sh"])
            .arg(&window)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        writer
            .stdin
            .take()
            .unwrap()
            .write_all(
                b"#!/bin/sh\n{ pwd -P; echo \"$#\"; readlink /proc/$$/fd/0 || echo unknown; echo $$; ps -o pgid= -p $$; } \
                  > told.tmp 2>/dev/null\nmv told.tmp told\n",
            )
            .unwrap();
        assert!(writer.wait().unwrap().success());
        start_window(&console).unwrap();
        let told = dir.join("told");
        let started = Instant::now();
        while !told.exists() && started.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let told = std::fs::read_to_string(told).unwrap();
        let lines: Vec<&str> = told.lines().map(str::trim).collect();
        let [cwd, args, input, pid, group] = lines[..] else { panic!("{told}") };
        assert_eq!((Path::new(cwd), args), (dir.as_path(), "0"), "in its own folder, without arguments");
        if cfg!(target_os = "linux") {
            assert_eq!(input, "/dev/null");
        }
        assert_eq!(group, pid, "a process group of its own");
        // The window's program missing, or the console program in its place, is said plainly.
        std::fs::remove_file(&window).unwrap();
        assert!(start_window(&console).unwrap_err().contains("isn't at"));
        assert!(start_window(&window).unwrap_err().contains("couldn't find"));
    }

    /// The console program, its output a pipe its caller reads to the end, as an agent's shell reads a command's,
    /// starts a program that keeps running, as the window does. That program must not hold the pipe open: Windows
    /// would hand it every handle this one may pass on, the pipe among them, and the caller would wait until the window
    /// closes. This test runs itself again as that console program, with ROLE set.
    #[test]
    fn a_caller_reading_all_the_console_program_prints_is_done_when_it_returns() {
        const ROLE: &str = "LACI_TEST_CONSOLE_PROGRAM";
        const NAME: &str = "tests::a_caller_reading_all_the_console_program_prints_is_done_when_it_returns";
        // Something that keeps running for 20 seconds, for the window.
        let (keeps_running, args): (PathBuf, &[&str]) = if cfg!(windows) {
            let root = std::env::var_os("SystemRoot").expect("SystemRoot");
            (Path::new(&root).join("System32").join("PING.EXE"), &["-n", "21", "127.0.0.1"])
        } else {
            (PathBuf::from("/bin/sleep"), &["20"])
        };
        if std::env::var_os(ROLE).is_some() {
            let dir = keeps_running.parent().unwrap();
            platform::start_detached(&keeps_running, args, dir).unwrap();
            println!("started {}", keeps_running.display());
            return;
        }
        let started = Instant::now();
        let console = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
            .env(ROLE, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // Reads its output and its errors to their end, then waits for it.
        let done = console.wait_with_output().unwrap();
        let took = started.elapsed();
        let said = String::from_utf8_lossy(&done.stdout);
        assert!(done.status.success(), "{said}{}", String::from_utf8_lossy(&done.stderr));
        assert!(said.contains("started"), "{said}");
        assert!(took < Duration::from_secs(12), "the output ended only after {took:?}: {said}");
    }
}
