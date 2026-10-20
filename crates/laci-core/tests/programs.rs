//! Finding and starting programs: the PATH, Git's own settings, and the home an agent started on a demo home is given.
use laci_core::{env::Env, platform, service::Service};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

mod support;

/// Linux finds a program as it always has: in PATH's order, a file that can run, also through a link.
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
    assert_eq!(platform::which(tool.to_str().unwrap(), "/nowhere".as_ref()), Some(tool));
}

/// An agent Laci asks for its models, or tells about Laci's MCP server, works in the home Laci reads, also on a demo
/// home: HOME. Codex reads CODEX_HOME before it, so on a demo home it gets the demo's .codex there, over one the user
/// set; other agents keep what they inherit.
#[test]
fn an_agent_started_for_a_demo_home_gets_it_as_home() {
    use laci_core::{launch, mcp_setup, providers};
    use serde_json::json;
    const TEST: &str = "an_agent_started_for_a_demo_home_gets_it_as_home";
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
        let codex = providers::builtins().into_iter().find(|p| p.id == "codex").unwrap();
        let _ = mcp_setup::apply(&env, &codex, false);
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
            &format!("#!/bin/sh\nprintf '%s %s %s\\n' \"$1\" \"$HOME\" \"$CODEX_HOME\" >> \"$HOME/{program}-env\"\n"),
        );
    }
    let path = std::env::join_paths(
        std::iter::once(bin.clone()).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())),
    )
    .unwrap();
    // The user's own Codex folder, which a demo must not touch.
    let theirs = temp.path().join("their-codex");
    let run = support::program(TEST, "agents")
        .env("PATH", path)
        .env("LACI_TEST_HOME", &home)
        .env("CODEX_HOME", &theirs)
        .output()
        .unwrap();
    assert!(run.status.success(), "{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
    let seen = ["codex", "agy", "agent"].map(|program| fs::read_to_string(home.join(format!("{program}-env"))).ok());
    let (h, codex, theirs) = (home.display(), home.join(".codex"), theirs.display());
    assert_eq!(
        seen,
        [
            Some(format!("app-server {h} {c}\nmcp {h} {c}\n", c = codex.display())),
            Some(format!("models {h} {theirs}\n")),
            Some(format!("add {h} {theirs}\n")),
        ]
    );
    assert!(codex.is_dir(), "Codex wants its folder to be there");
}

/// What a scan's Git calls get, read from Git's own trace in a run of this test with GIT_TRACE2_EVENT set: hooks
/// switched off, and no setting for Windows' long paths.
#[test]
fn every_git_call_switches_hooks_off() {
    const TEST: &str = "every_git_call_switches_hooks_off";
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

    let hooks = "core.hooksPath=/dev/null";
    let mut calls = 0;
    for line in fs::read_to_string(&trace).unwrap().lines() {
        let event: Value = serde_json::from_str(line).unwrap();
        let argv: Vec<&str> = event["argv"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        // Laci's own calls, not a Git that Git started.
        if event["event"] != "start" || argv.get(1) != Some(&"--no-pager") {
            continue;
        }
        let settings: Vec<&str> = argv.windows(2).filter(|pair| pair[0] == "-c").map(|pair| pair[1]).collect();
        assert!(settings.contains(&hooks), "{argv:?}");
        assert!(!settings.contains(&"core.longpaths=true"), "{argv:?}");
        calls += 1;
    }
    assert!(calls > 0, "no Git call was traced");
}

/// The Git that makes a project gets what every scan's Git gets but the hooks: the file system monitor switched off,
/// and GIT_TERMINAL_PROMPT=0, so it asks nothing. The repository is the one Laci just made, so its hooks are the
/// user's own and stay on. Git's own trace, in a run of this test, shows what each call got.
#[test]
fn the_git_that_makes_a_project_keeps_its_hooks_and_asks_nothing() {
    const TEST: &str = "the_git_that_makes_a_project_keeps_its_hooks_and_asks_nothing";
    if support::role().as_deref() == Some("create") {
        let home = PathBuf::from(std::env::var_os("LACI_TEST_HOME").unwrap());
        let request = serde_json::json!({"parent":home,"name":"made","from":"empty","remote":"none"});
        laci_core::create::create_project(&Env::for_home(home), &request).unwrap();
        return;
    }
    let temp = support::tempdir();
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    let trace = temp.path().join("trace.json");
    let run = support::program(TEST, "create")
        .env("GIT_TRACE2_EVENT", &trace)
        .env("GIT_TRACE2_ENV_VARS", "GIT_TERMINAL_PROMPT")
        .env("LACI_TEST_HOME", &home)
        .env_remove("GIT_TERMINAL_PROMPT")
        .output()
        .unwrap();
    assert!(run.status.success(), "{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));

    let hooks = "core.hooksPath=/dev/null";
    let events: Vec<Value> =
        fs::read_to_string(&trace).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let mut made = Vec::new();
    for start in events.iter().filter(|event| event["event"] == "start") {
        let argv: Vec<&str> = start["argv"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        // Laci's own calls, not a Git that Git started.
        if argv.get(1) != Some(&"--no-pager") {
            continue;
        }
        let settings: Vec<&str> = argv.windows(2).filter(|pair| pair[0] == "-c").map(|pair| pair[1]).collect();
        assert!(settings.contains(&"core.fsmonitor=false"), "{argv:?}");
        let asks = events.iter().find(|event| {
            event["sid"] == start["sid"] && event["event"] == "def_param" && event["param"] == "GIT_TERMINAL_PROMPT"
        });
        assert_eq!(asks.map(|event| &event["value"]), Some(&Value::from("0")), "{argv:?}");
        // The command comes after the settings.
        let mut rest = argv[2..].iter();
        let command = loop {
            match rest.next() {
                Some(&"-c") => {
                    rest.next();
                }
                other => break other,
            }
        };
        // What makes the repository keeps its hooks; a question about it, as everywhere else, goes without.
        let making = command.is_some_and(|command| ["init", "add", "commit"].contains(command));
        assert_eq!(settings.contains(&hooks), !making, "{argv:?}");
        made.extend(command.map(|command| command.to_string()));
    }
    for command in ["init", "add", "commit"] {
        assert!(made.iter().any(|made| made == command), "{command} went without them: {made:?}");
    }
}

/// A project made from a template whose files Git LFS tracks gets the hook Git LFS puts in a new repository, and its
/// first push uploads those files, as with 2.5.2. A stand-in glab makes the GitLab repository a bare one on the disk.
/// Without Git LFS on PATH there is nothing to check.
#[test]
fn a_new_projects_first_push_uploads_its_git_lfs_files() {
    const TEST: &str = "a_new_projects_first_push_uploads_its_git_lfs_files";
    if support::role().as_deref() == Some("lfs") {
        let home = PathBuf::from(std::env::var_os("LACI_TEST_HOME").unwrap());
        let env = Env::for_home(home.clone());
        let template = home.join("template");
        laci_core::create::add_template(&env, template.to_str().unwrap()).unwrap();
        let request =
            serde_json::json!({"parent":home,"name":"made","from":"template","template":template,"remote":"gitlab"});
        let made = laci_core::create::create_project(&env, &request).unwrap();
        assert_eq!(made["warnings"], serde_json::json!([]));
        assert!(home.join("made/.git/hooks/pre-push").is_file(), "Git LFS put no pre-push hook in the new repository");
        return;
    }
    if std::process::Command::new("git-lfs").arg("version").output().is_err() {
        eprintln!("Git LFS isn't installed: nothing to check");
        return;
    }
    let temp = support::tempdir();
    let (home, bin, remotes) = (temp.path().join("home"), temp.path().join("bin"), temp.path().join("remotes"));
    let template = home.join("template");
    for dir in [&template, &bin, &remotes] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(template.join(".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n").unwrap();
    fs::write(template.join("cover.psd"), [7u8; 2048]).unwrap();
    // What `git lfs install` writes, and a name for the first commit.
    let global = temp.path().join("gitconfig");
    fs::write(
        &global,
        "[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n[user]\n\tname = Test\n\temail = test@example.test\n",
    )
    .unwrap();
    let bare = std::process::Command::new("git").args(["init", "-q", "--bare"]).arg(remotes.join("made.git")).output();
    assert!(bare.unwrap().status.success());
    support::script(
        &bin.join("glab"),
        "#!/bin/sh\nif [ \"$1\" = api ]; then printf '{\"web_url\":\"%s\"}' \"$LACI_TEST_REMOTES\"; fi\n",
    );
    let path = std::env::join_paths(
        std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())),
    )
    .unwrap();
    let run = support::program(TEST, "lfs")
        .env("PATH", path)
        .env("HOME", &home)
        .env("GIT_CONFIG_GLOBAL", &global)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("LACI_TEST_HOME", &home)
        .env("LACI_TEST_REMOTES", &remotes)
        .output()
        .unwrap();
    assert!(run.status.success(), "{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
    let uploaded = fs::read_dir(remotes.join("made.git/lfs/objects")).is_ok();
    assert!(uploaded, "the first push left the Git LFS files behind");
}

/// gh pushes a new project with Git, which must ask nothing there either. A stand-in gh notes what it was given.
#[test]
fn the_git_that_github_cli_runs_for_a_new_project_asks_nothing() {
    const TEST: &str = "the_git_that_github_cli_runs_for_a_new_project_asks_nothing";
    if support::role().as_deref() == Some("github") {
        let home = PathBuf::from(std::env::var_os("LACI_TEST_HOME").unwrap());
        let request = serde_json::json!({"parent":home,"name":"made","from":"empty","remote":"github"});
        laci_core::create::create_project(&Env::for_home(home), &request).unwrap();
        return;
    }
    let temp = support::tempdir();
    let (home, bin) = (temp.path().join("home"), temp.path().join("bin"));
    fs::create_dir(&home).unwrap();
    fs::create_dir(&bin).unwrap();
    support::script(
        &bin.join("gh"),
        "#!/bin/sh\nprintf '%s\\n' \"${GIT_TERMINAL_PROMPT-unset}\" > \"$LACI_TEST_HOME/gh-was-given\"\n",
    );
    let path = std::env::join_paths(
        std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())),
    )
    .unwrap();
    let mut command = support::program(TEST, "github");
    command.env("PATH", path).env("LACI_TEST_HOME", &home).env_remove("GIT_TERMINAL_PROMPT");
    // The first commit, which gh would push, needs a name.
    for (key, value) in [("NAME", "Test"), ("EMAIL", "test@example.test")] {
        command.env(format!("GIT_AUTHOR_{key}"), value).env(format!("GIT_COMMITTER_{key}"), value);
    }
    let run = command.output().unwrap();
    assert!(run.status.success(), "{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
    assert_eq!(fs::read_to_string(home.join("gh-was-given")).unwrap(), "0\n");
}

/// The first run asks to install Git when it doesn't run. A run of this test without Git on PATH must hear so.
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
    let empty = tempfile::tempdir().unwrap();
    let run = support::program(TEST, "no-git").env("PATH", empty.path()).output().unwrap();
    assert!(run.status.success(), "{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
}
