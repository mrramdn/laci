//! Finding and starting programs: Windows' PATHEXT, the shims npm, pnpm and yarn write, and the arguments a batch
//! file can't take; the PATH a login shell sets up and the stand-in Git on macOS; Git's own settings; and the home an
//! agent started on a demo home is given.
use laci_core::{env::Env, platform, process, service::Service};
use serde_json::Value;
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

mod support;

/// What npm 7 and later (its cmd-shim 5 to 8) write for `claude`.
const NPM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";
/// cmd-shim 9, which sets PATHEXT on the line that runs node.
const NPM_9: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";
/// Yarn 1 and npm before 7.
const YARN: &str = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\..\\Data\\global\\node_modules\\agy\\cli.js\" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  \"%~dp0\\..\\Data\\global\\node_modules\\agy\\cli.js\" %*\r\n)";
/// pnpm, for a program it installed globally.
const PNPM: &str = "@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET \"NODE_PATH=C:\\Users\\Me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules\"\r\n) ELSE (\r\n  @SET \"NODE_PATH=C:\\Users\\Me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules;%NODE_PATH%\"\r\n)\r\n@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\global\\5\\node_modules\\pnpm\\bin\\pnpm.cjs\" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  \"%~dp0\\global\\5\\node_modules\\pnpm\\bin\\pnpm.cjs\" %*\r\n)\r\n";

#[test]
fn the_shims_npm_pnpm_and_yarn_write_name_the_script_node_runs() {
    assert_eq!(process::npm_shim(NPM).as_deref(), Some(r"node_modules\@anthropic-ai\claude-code\cli.js"));
    assert_eq!(process::npm_shim(NPM_9).as_deref(), Some(r"node_modules\@openai\codex\bin\codex.js"));
    assert_eq!(process::npm_shim(YARN).as_deref(), Some(r"..\Data\global\node_modules\agy\cli.js"));
    assert_eq!(process::npm_shim(PNPM).as_deref(), Some(r"global\5\node_modules\pnpm\bin\pnpm.cjs"));
    assert_eq!(process::npm_shim(&NPM.replace("\r\n", "\n")), process::npm_shim(NPM), "line ends don't matter");
}

#[test]
fn a_batch_file_that_does_more_than_a_shim_is_no_shim() {
    let not_shims = [
        String::new(),
        "@echo off\r\ncalc.exe %*\r\n".into(),
        // A variable set for the program, which node alone would miss.
        NPM.replace("SETLOCAL\r\n", "SETLOCAL\r\n@SET NODE_ENV=production\r\n"),
        // A PATH of its own, as pnpm writes for some programs.
        PNPM.replace("@SETLOCAL\r\n", "@SETLOCAL\r\n@SET \"PATH=C:\\tools;%PATH%\"\r\n"),
        // %_prog% and %dp0% that nothing sets.
        NPM.replace("  SET \"_prog=node\"\r\n", ""),
        NPM.replace("SET dp0=%~dp0\r\n", ""),
        // Two scripts.
        YARN.replacen("agy\\cli.js", "other\\cli.js", 1),
        // A % in the script's name, which cmd.exe reads as a variable.
        YARN.replace("agy\\cli.js", "%AGY%\\cli.js"),
        // Another program than node, and an argument before the script.
        YARN.replace("node.exe", "bun.exe").replace("node  ", "bun  "),
        YARN.replace("node  \"", "node --preserve-symlinks \""),
        // An extra command after the script, and arguments joined to the script's name.
        YARN.replace(" %*\r\n", " %* & calc.exe\r\n"),
        YARN.replace(" %*\r\n", "%*\r\n"),
        // No line that starts node.
        "@ECHO off\r\nSETLOCAL\r\n".into(),
    ];
    for text in not_shims {
        assert_eq!(process::npm_shim(&text), None, "{text}");
    }
}

#[test]
fn a_batch_file_gets_no_argument_cmd_could_read_as_a_command() {
    let script = Path::new(r"C:\Users\Me\AppData\Roaming\npm\agy.cmd");
    let fine: Vec<OsString> = ["plain words", "C:\\Users\\Me\\R and D", "(a), b; c = d", "it's 雨", ""]
        .into_iter()
        .map(OsString::from)
        .collect();
    assert_eq!(process::batch_args(script, &fine), Ok(()));
    for (text, named) in [
        ("say \"hi\"", "the character \""),
        ("100%", "the character %"),
        ("wow!", "the character !"),
        ("a^b", "the character ^"),
        ("a & b", "the character &"),
        ("a | b", "the character |"),
        ("<in", "the character <"),
        (">out", "the character >"),
        ("first\nsecond", "a line break"),
        ("first\rsecond", "a line break"),
    ] {
        let error = process::batch_args(script, &[OsString::from("fine"), text.into()]).unwrap_err();
        assert!(error.contains(named) && error.contains("agy.cmd"), "{error}");
    }
}

/// Linux finds a program as it always has: in PATH's order, a file that can run, also through a link.
#[cfg(unix)]
#[test]
fn which_finds_the_first_file_that_can_run_in_path_order() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let temp = tempfile::tempdir().unwrap();
    let (first, second) = (temp.path().join("first"), temp.path().join("second"));
    for dir in [&first, &second] {
        fs::create_dir(dir).unwrap();
    }
    let file = |path: &Path, mode: u32| {
        fs::write(path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    };
    file(&first.join("tool"), 0o755);
    file(&second.join("tool"), 0o755);
    file(&first.join("plain"), 0o644);
    file(&second.join("plain"), 0o755);
    fs::create_dir(first.join("folder")).unwrap();
    symlink(first.join("tool"), second.join("linked")).unwrap();
    let path = std::env::join_paths([&first, &second]).unwrap();
    assert_eq!(platform::which("tool", &path), Some(first.join("tool")));
    assert_eq!(platform::which("plain", &path), Some(second.join("plain")), "a file that can't run is passed over");
    assert_eq!(platform::which("folder", &path), None);
    assert_eq!(platform::which("linked", &path), Some(second.join("linked")));
    assert_eq!(platform::which("missing", &path), None);
    // A path names the file itself, as an agent's command may.
    let tool = first.join("tool");
    assert_eq!(platform::which(tool.to_str().unwrap(), "/nowhere".as_ref()), Some(tool.clone()));
    // Elsewhere a program starts by name, and std finds it on the child's PATH.
    if cfg!(target_os = "linux") {
        let args = vec![OsString::from("a & b\n")];
        assert_eq!(process::program("tool", args.clone()), Ok((PathBuf::from("tool"), args)));
    }
}

/// A fake login shell: it prints what startup files may print around the command it was given, which it runs with
/// `PATH` set.
#[cfg(unix)]
fn shell(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    support::script(&path, &format!("#!/bin/sh\n{body}\n"));
    path
}

#[cfg(unix)]
#[test]
fn the_login_shell_path_is_read_between_what_its_startup_files_print() {
    use std::time::{Duration, Instant};
    let temp = tempfile::tempdir().unwrap();
    let wait = Duration::from_secs(10);
    // $1 is -ilc, $2 the command.
    let chatty = shell(
        temp.path(),
        "chatty",
        "echo 'Last login: Mon Oct 19 09:41:00 on ttys000'\nprintf 'no line end'\nPATH='/opt/fake/bin:/usr/bin:/bin' /bin/sh -c \"$2\"\necho 'zsh: done'",
    );
    assert_eq!(process::login_shell_path(&chatty, wait), Some("/opt/fake/bin:/usr/bin:/bin".into()));
    let silent = shell(temp.path(), "silent", "echo 'nothing for you'");
    assert_eq!(process::login_shell_path(&silent, wait), None);
    let cut = shell(temp.path(), "cut", "/bin/sh -c \"$2\" | /usr/bin/head -n 2");
    assert_eq!(process::login_shell_path(&cut, wait), None, "the PATH needs its end mark");
    let empty = shell(temp.path(), "empty", "PATH= /bin/sh -c \"$2\"");
    assert_eq!(process::login_shell_path(&empty, wait), None);
    assert_eq!(process::login_shell_path(&temp.path().join("missing"), wait), None);
    let slow = shell(temp.path(), "slow", "/bin/sleep 30");
    let started = Instant::now();
    assert_eq!(process::login_shell_path(&slow, Duration::from_millis(300)), None);
    assert!(started.elapsed() < Duration::from_secs(5), "a shell that takes too long is stopped");
}

/// An agent Laci asks for its models, or tells about Laci's MCP server, works in the home Laci reads, also on a demo
/// home: HOME on Linux and macOS, USERPROFILE on Windows. The code is the same on every OS; on macOS a codex or agy
/// on the login shell's PATH would come before these stand-ins.
#[cfg(target_os = "linux")]
#[test]
fn an_agent_started_for_a_demo_home_gets_it_as_home_and_as_userprofile() {
    use laci_core::{launch, mcp_setup, providers};
    use serde_json::json;
    const TEST: &str = "an_agent_started_for_a_demo_home_gets_it_as_home_and_as_userprofile";
    if support::role().as_deref() == Some("agents") {
        let home = PathBuf::from(std::env::var_os("LACI_TEST_HOME").unwrap());
        let mut env = Env::for_home(home.clone());
        // MCP registration needs Laci's own program.
        env.program = home.join("laci");
        fs::write(&env.program, "").unwrap();
        // Neither stand-in answers as the agent would, so each start fails after it has written what it got.
        for provider in ["codex", "antigravity"] {
            let _ = launch::capabilities(&env, provider, true);
        }
        let mcp = json!({"file":"~/.agent/mcp.json","add":"add {laci} mcp","remove":"remove"});
        let agent = providers::validate_agent(&env, &json!({"command":"agent","mcp":mcp})).unwrap();
        let provider = providers::from_spec(&json!({"id":"custom-agent","name":"Agent","agent":agent})).unwrap();
        let _ = mcp_setup::apply(&env, &provider, false);
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let (home, bin) = (temp.path().join("home"), temp.path().join("bin"));
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&bin).unwrap();
    for program in ["codex", "agy", "agent"] {
        support::script(
            &bin.join(program),
            &format!("#!/bin/sh\nprintf '%s\\n%s\\n' \"$HOME\" \"$USERPROFILE\" > \"$HOME/{program}-env\"\n"),
        );
    }
    let path = std::env::join_paths(
        std::iter::once(bin.clone()).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())),
    )
    .unwrap();
    let run = support::program(TEST, "agents").env("PATH", path).env("LACI_TEST_HOME", &home).output().unwrap();
    assert!(run.status.success(), "{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
    let seen = ["codex", "agy", "agent"].map(|program| fs::read_to_string(home.join(format!("{program}-env"))).ok());
    assert_eq!(seen, [(); 3].map(|_| Some(format!("{h}\n{h}\n", h = home.display()))));
}

/// What a scan's Git calls get, read from Git's own trace in a run of this test with GIT_TRACE2_EVENT set: hooks
/// switched off, on Windows through an empty folder of Laci's own, and long paths on Windows.
#[test]
fn every_git_call_switches_hooks_off_and_windows_allows_long_paths() {
    const TEST: &str = "every_git_call_switches_hooks_off_and_windows_allows_long_paths";
    if support::role().as_deref() == Some("scan") {
        let repo = PathBuf::from(std::env::var_os("LACI_TEST_REPO").unwrap());
        assert!(laci_core::readers::git_info(&repo).is_some());
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    for args in [
        &["init", "-q"][..],
        &["-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "first"],
    ] {
        let made = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
    }
    let trace = temp.path().join("trace.json");
    let run =
        support::program(TEST, "scan").env("GIT_TRACE2_EVENT", &trace).env("LACI_TEST_REPO", &repo).output().unwrap();
    assert!(run.status.success(), "{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));

    let hooks = if cfg!(windows) {
        let folder = platform::user_dirs(Path::new("")).unwrap().config.join("no-git-hooks");
        assert!(
            fs::read_dir(&folder).map_or(true, |mut entries| entries.next().is_none()),
            "the hooks folder is empty"
        );
        format!("core.hooksPath={}", folder.display())
    } else {
        "core.hooksPath=/dev/null".into()
    };
    let mut calls = 0;
    for line in fs::read_to_string(&trace).unwrap().lines() {
        let event: Value = serde_json::from_str(line).unwrap();
        let argv: Vec<&str> = event["argv"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        // Laci's own calls, not a Git that Git started.
        if event["event"] != "start" || argv.get(1) != Some(&"--no-pager") {
            continue;
        }
        let settings: Vec<&str> = argv.windows(2).filter(|pair| pair[0] == "-c").map(|pair| pair[1]).collect();
        assert!(settings.contains(&hooks.as_str()), "{argv:?}");
        assert_eq!(settings.contains(&"core.longpaths=true"), cfg!(windows), "{argv:?}");
        calls += 1;
    }
    assert!(calls > 0, "no Git call was traced");
}

/// The first run asks to install Git when it doesn't run. A run of this test without Git on PATH must hear so;
/// macOS isn't asked, as there the login shell's PATH comes back.
#[test]
fn the_first_run_knows_whether_git_runs() {
    const TEST: &str = "the_first_run_knows_whether_git_runs";
    let home = tempfile::tempdir().unwrap();
    let info = Service::new(Env::for_home(home.path().to_owned())).setup_info().unwrap();
    if support::role().as_deref() == Some("no-git") {
        assert_eq!(info["git"], false);
        return;
    }
    assert_eq!(info["git"], true);
    if !cfg!(target_os = "macos") {
        let empty = tempfile::tempdir().unwrap();
        let run = support::program(TEST, "no-git").env("PATH", empty.path()).output().unwrap();
        assert!(
            run.status.success(),
            "{}{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        );
    }
}

#[cfg(windows)]
mod windows {
    use super::*;

    fn folders() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let (first, second) = (temp.path().join("first"), temp.path().join("second"));
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        (temp, first, second)
    }

    #[test]
    fn path_order_comes_first_and_only_programs_and_batch_files_count() {
        let (_temp, first, second) = folders();
        let path = std::env::join_paths([&first, &second]).unwrap();
        fs::write(first.join("tool.cmd"), "@echo off\r\n").unwrap();
        fs::write(second.join("tool.exe"), "").unwrap();
        assert_eq!(platform::which("tool", &path), Some(first.join("tool.cmd")));
        // npm's sh script beside its .cmd, and a kind PATHEXT lists that Laci doesn't start.
        fs::write(first.join("other"), "#!/bin/sh\n").unwrap();
        fs::write(first.join("other.js"), "").unwrap();
        fs::write(second.join("other.com"), "").unwrap();
        assert_eq!(platform::which("other", &path), Some(second.join("other.com")));
        assert_eq!(platform::which("other.exe", &path), None);
        fs::create_dir(first.join("sub")).unwrap();
        fs::write(first.join("sub").join("deep.exe"), "").unwrap();
        assert_eq!(platform::which(r"sub\deep", &path), None, "a name with a folder in it is no program name");
        assert_eq!(platform::which("tool", r"first;\second".as_ref()), None, "folders without a drive are skipped");
    }

    #[test]
    fn an_npm_shim_starts_as_node_with_its_script_whatever_the_arguments() {
        let (_temp, first, second) = folders();
        let path = std::env::join_paths([&first, &second]).unwrap();
        fs::write(first.join("claude.cmd"), NPM).unwrap();
        let script = first.join(r"node_modules\@anthropic-ai\claude-code\cli.js");
        fs::create_dir_all(script.parent().unwrap()).unwrap();
        fs::write(&script, "").unwrap();
        fs::write(second.join("node.exe"), "").unwrap();
        let prompt = OsString::from("Review this:\r\n\"quotes\" & 100% ^ | < > !");
        assert_eq!(
            platform::program("claude", vec![prompt.clone()], &path),
            Ok((second.join("node.exe"), vec![script.clone().into_os_string(), prompt]))
        );
        // A node.exe beside the shim comes first, as the shim itself has it.
        fs::write(first.join("node.exe"), "").unwrap();
        assert_eq!(platform::program("claude", vec![], &path).unwrap().0, first.join("node.exe"));
        // Without its script, the shim is only a batch file.
        fs::remove_file(&script).unwrap();
        assert_eq!(
            platform::program("claude", vec!["plain".into()], &path),
            Ok((first.join("claude.cmd"), vec!["plain".into()]))
        );
        assert!(platform::program("claude", vec!["a & b".into()], &path).is_err());
    }

    #[test]
    fn another_batch_file_is_refused_text_cmd_could_run_and_a_program_takes_anything() {
        let (_temp, first, second) = folders();
        let path = std::env::join_paths([&first, &second]).unwrap();
        fs::write(first.join("tool.bat"), "@echo off\r\necho %*\r\n").unwrap();
        let fine = vec![OsString::from("words, (with) commas; and = signs")];
        assert_eq!(platform::program("tool", fine.clone(), &path), Ok((first.join("tool.bat"), fine)));
        for text in ["a & b", "100%", "\"q\"", "line\nbreak", "x | y", "<in", ">out", "a^b", "!v!"] {
            let error = platform::program("tool", vec![text.into()], &path).unwrap_err();
            assert!(error.contains("tool.bat"), "{error}");
        }
        fs::write(second.join("prog.exe"), "").unwrap();
        let any = vec![OsString::from("a & b\n\"%PATH%\"")];
        assert_eq!(platform::program("prog", any.clone(), &path), Ok((second.join("prog.exe"), any)));
        assert!(platform::program("missing", vec![], &path).unwrap_err().contains("not installed"));
    }

    /// A multi-line prompt full of what cmd.exe reads reaches an npm-installed agent unchanged, through Laci's own
    /// start. Needs Node.js, which CI's Windows runners have.
    #[test]
    fn a_prompt_reaches_an_npm_installed_agent_as_it_is() {
        const TEST: &str = "windows::a_prompt_reaches_an_npm_installed_agent_as_it_is";
        const PROMPT: &str = "Review this:\r\n\"quotes\" & 100% ^ | < > ! %PATH% 雨";
        if support::role().as_deref() == Some("start") {
            let said = process::run("agent", &[PROMPT], None, std::time::Duration::from_secs(30)).unwrap();
            assert_eq!(serde_json::from_str::<Value>(&said).unwrap(), serde_json::json!([PROMPT]));
            return;
        }
        let path = std::env::var_os("PATH").unwrap_or_default();
        let node = platform::which("node", &path).expect("Node.js on PATH");
        let (_temp, first, _) = folders();
        fs::write(first.join("agent.cmd"), NPM.replace(r"@anthropic-ai\claude-code\cli.js", r"agent\cli.js")).unwrap();
        fs::create_dir_all(first.join(r"node_modules\agent")).unwrap();
        fs::write(
            first.join(r"node_modules\agent\cli.js"),
            "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
        )
        .unwrap();
        let path = std::env::join_paths([first, node.parent().unwrap().to_owned()]).unwrap();
        let run = support::program(TEST, "start").env("PATH", path).output().unwrap();
        assert!(
            run.status.success(),
            "{}{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        );
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::OsStr;

    /// A stand-in xcode-select that writes to `asked` each time it runs.
    fn xcode_select(dir: &Path, name: &str, asked: &Path, answer: &str) -> PathBuf {
        shell(dir, name, &format!("echo asked >> '{}'\n{answer}", asked.display()))
    }

    #[test]
    fn the_stand_in_git_counts_only_with_the_command_line_tools() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().canonicalize().unwrap();
        let asked = dir.join("asked");
        let missing = "echo 'xcode-select: error: unable to get active developer directory' >&2\nexit 2";
        let usr = OsStr::new("/usr/bin");
        let none = xcode_select(&dir, "none", &asked, missing);
        assert!(platform::git(usr, &none).unwrap_err().contains("xcode-select --install"));
        let tools = xcode_select(&dir, "tools", &asked, &format!("echo '{}'", dir.display()));
        assert_eq!(platform::git(usr, &tools), Ok(PathBuf::from("/usr/bin/git")));
        let gone = xcode_select(&dir, "gone", &asked, "echo /Library/Developer/NoSuchTools");
        assert!(platform::git(usr, &gone).is_err(), "a developer folder that isn't there counts as none");

        // Another Git counts without asking when it comes first, and in place of the stand-in when it comes after.
        let brew = dir.join("brew");
        fs::create_dir(&brew).unwrap();
        shell(&brew, "git", "exit 0");
        let first = xcode_select(&dir, "first", &dir.join("asked-first"), missing);
        let before = std::env::join_paths([brew.as_path(), Path::new("/usr/bin")]).unwrap();
        assert_eq!(platform::git(&before, &first), Ok(brew.join("git")));
        assert!(!dir.join("asked-first").exists(), "xcode-select was asked although another Git comes first");
        let after = std::env::join_paths([Path::new("/usr/bin"), brew.as_path()]).unwrap();
        assert_eq!(platform::git(&after, &none), Ok(brew.join("git")));
    }

    #[test]
    fn children_get_the_login_shell_path_and_the_usual_folders() {
        let path = platform::child_path().expect("children get a PATH of their own");
        assert_eq!(process::host_env_overrides(), vec![("PATH", Some(path.clone()))]);
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert!(dirs.iter().all(|dir| dir.is_absolute()), "{dirs:?}");
        let unique: std::collections::BTreeSet<_> = dirs.iter().collect();
        assert_eq!(unique.len(), dirs.len(), "{dirs:?}");
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        let own = std::env::split_paths(&inherited).filter(|dir| dir.is_absolute());
        let usual = ["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from).into_iter().filter(|dir| dir.is_dir());
        for dir in own.chain(usual) {
            assert!(dirs.contains(&dir), "{} is missing from {dirs:?}", dir.display());
        }
    }
}
