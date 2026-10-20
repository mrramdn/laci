//! The checks Simple's safety card and Delete dialog rest on, against real Git repositories in an isolated home: files
//! that look like secrets, keeping them out of Git with Undo, the limits in "Ask AI to fix it" prompts, and the files
//! a Trash plan names because only this computer has them.
use laci_core::{
    activity, assistant, config, deletion,
    env::Env,
    secrets,
    service::{Service, changes_history, mutates},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

mod support;

fn run(dir: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.test")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.test")
        .output()
        .unwrap()
}
fn git(dir: &Path, args: &[&str]) -> String {
    let out = run(dir, args);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().into()
}
fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
/// A home whose `project` folder Laci reads, with one Git project in it. Laci's own Git calls read the user's Git
/// settings, so the project names an empty ignore list in place of the user's.
fn fixture() -> (support::TempDir, Env, PathBuf) {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    // A name at a time, as the scan spells the paths it finds: on Windows a `/` given to `join` stays in the text.
    let dir = env.home.join("project").join("demo");
    fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "--initial-branch=main"]);
    let none = temp.path().join("no-ignores");
    write(&none, "");
    git(&dir, &["config", "core.excludesFile", none.to_str().unwrap()]);
    config::save(&env, &json!({"roots":["~/project"],"presets":[],"custom":[],"apps":{}})).unwrap();
    (temp, env, dir)
}
fn node(dir: &Path) -> Value {
    json!({"kind":"project","path":dir,"name":"demo","label":"demo"})
}
fn listed(env: &Env, dir: &Path) -> Vec<(String, bool)> {
    let check = secrets::check(env, &node(dir)).unwrap();
    assert_eq!(check["more"], 0);
    check["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| (file["path"].as_str().unwrap().to_owned(), file["tracked"].as_bool().unwrap()))
        .collect()
}
fn pairs(list: &[(&str, bool)]) -> Vec<(String, bool)> {
    list.iter().map(|(path, tracked)| ((*path).to_owned(), *tracked)).collect()
}
fn loaded(env: &Env) -> Service {
    let mut service = Service::new(env.clone());
    service.snapshot().unwrap();
    service
}
fn keep_out(service: &mut Service, dir: &Path, files: Value) -> Result<Value, String> {
    service.request("secrets/keep-out", &json!({"id":dir,"files":files}))
}
fn entry(env: &Env, change: &Value) -> Value {
    activity::read_log(env, 50).into_iter().find(|entry| entry["journal"] == change["journal"]["id"]).unwrap()
}

#[test]
fn secrets_are_found_by_name_whether_tracked_or_not_but_not_when_ignored() {
    let (_temp, env, dir) = fixture();
    write(&dir.join(".gitignore"), "ignored.key\n");
    write(&dir.join("config/credentials.json"), "{}");
    git(&dir, &["add", ".gitignore", "config/credentials.json"]);
    git(&dir, &["commit", "-qm", "first"]);
    for name in [
        ".env",
        ".env.local",
        ".env.example",
        "deploy.pem",
        "Service-Account-prod.json",
        "keys/id_ed25519",
        "keys/id_ed25519.pub",
        "ignored.key",
        "notes.txt",
        // A package's test keys and a certificate bundle are someone else's, and stay off the list.
        "node_modules/pkg/test/key.pem",
        ".venv/lib/certifi/cacert.pem",
        // Build output is made from the project, often with copies of its secrets, and Git would add it here.
        "dist/.env.production",
        "build/certs/server.key",
    ] {
        write(&dir.join(name), "not read");
    }
    assert_eq!(
        listed(&env, &dir),
        pairs(&[
            ("config/credentials.json", true),
            (".env", false),
            (".env.local", false),
            ("Service-Account-prod.json", false),
            ("deploy.pem", false),
            ("dist/.env.production", false),
            ("keys/id_ed25519", false),
            ("build/certs/server.key", false),
        ])
    );
    // Staged counts as tracked: the next saved version takes it.
    git(&dir, &["add", ".env"]);
    assert_eq!(listed(&env, &dir)[..2], pairs(&[(".env", true), ("config/credentials.json", true)]));
}

#[test]
fn a_secret_in_a_saved_version_that_isnt_online_yet_is_listed() {
    let (temp, env, dir) = fixture();
    let remote = temp.path().join("online.git");
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "--initial-branch=main"]);
    write(&dir.join("README.md"), "x");
    git(&dir, &["add", "README.md"]);
    git(&dir, &["commit", "-qm", "first"]);
    git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&dir, &["push", "-q", "-u", "origin", "main"]);
    // .env is saved, then no longer tracked and ignored, all before the upload, which would still take it.
    write(&dir.join(".env"), "x");
    git(&dir, &["add", ".env"]);
    git(&dir, &["commit", "-qm", "oops"]);
    git(&dir, &["rm", "-q", "--cached", ".env"]);
    write(&dir.join(".gitignore"), ".env\n");
    git(&dir, &["add", ".gitignore"]);
    git(&dir, &["commit", "-qm", "untrack"]);
    // A stash is never uploaded.
    write(&dir.join("deploy.pem"), "x");
    git(&dir, &["stash", "push", "-q", "--include-untracked"]);
    assert_eq!(listed(&env, &dir), pairs(&[(".env", true)]));
    // Once it is online, the next upload doesn't take it.
    git(&dir, &["push", "-q"]);
    assert_eq!(listed(&env, &dir), pairs(&[]));
}

#[cfg(target_os = "linux")]
#[test]
fn a_name_that_isnt_valid_text_is_listed_but_never_written_to_gitignore() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    let (_temp, env, dir) = fixture();
    fs::write(dir.join(OsStr::from_bytes(b"caf\xe9.pem")), "x").unwrap();
    write(&dir.join(".env"), "x");
    assert_eq!(listed(&env, &dir), pairs(&[(".env", false), ("caf\u{FFFD}.pem", false)]));
    let mut service = loaded(&env);
    let refused = keep_out(&mut service, &dir, json!(["caf\u{FFFD}.pem"])).unwrap_err();
    assert!(refused.contains("isn't valid text"), "{refused}");
    assert!(!dir.join(".gitignore").exists());
}

#[test]
fn a_file_in_the_middle_of_a_merge_is_listed_once() {
    let (_temp, env, dir) = fixture();
    write(&dir.join(".env"), "a");
    git(&dir, &["add", ".env"]);
    git(&dir, &["commit", "-qm", "a"]);
    git(&dir, &["checkout", "-qb", "other"]);
    write(&dir.join(".env"), "b");
    git(&dir, &["commit", "-qam", "b"]);
    git(&dir, &["checkout", "-q", "main"]);
    write(&dir.join(".env"), "c");
    git(&dir, &["commit", "-qam", "c"]);
    assert!(!run(&dir, &["merge", "-q", "other"]).status.success(), "the merge stops at the conflict");
    assert_eq!(listed(&env, &dir), pairs(&[(".env", true)]));
}

#[test]
fn a_folder_without_git_is_checked_as_a_new_repository_there_would_see_it() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let root = env.home.join("project");
    let dir = root.join("plain");
    // A repository in the folder above tracks the project's .env, and must not answer for the project.
    write(&dir.join(".env"), "x");
    git(&root, &["init", "-q"]);
    git(&root, &["add", "plain/.env"]);
    git(&root, &["commit", "-qm", "parent"]);
    // The negations keep the user's own ignore list from hiding the test's files; the project's rules still count.
    write(&dir.join(".gitignore"), "/ignored.pem\n!/.env\n!/deploy.pem\n");
    write(&dir.join("deploy.pem"), "x");
    write(&dir.join("ignored.pem"), "x");
    assert_eq!(listed(&env, &dir), pairs(&[(".env", false), ("deploy.pem", false)]));
    assert!(!dir.join(".git").exists());
}

#[test]
fn a_long_list_shows_fifty_and_counts_the_rest() {
    let (_temp, env, dir) = fixture();
    for n in 0..55 {
        write(&dir.join(format!("keys/k{n:02}.pem")), "x");
    }
    write(&dir.join(".env"), "x");
    let check = secrets::check(&env, &node(&dir)).unwrap();
    let files = check["files"].as_array().unwrap();
    assert_eq!((files.len(), &check["more"]), (50, &json!(6)));
    assert_eq!(files[0], json!({"path":".env","tracked":false}), "the shallowest come first");
    assert!(secrets::check(&env, &json!({"kind":"folder","path":dir})).is_err());
}

#[test]
fn keep_out_adds_one_anchored_line_each_and_undo_puts_the_old_bytes_back() {
    for (before, after) in [
        (None, "/.env\n/my\\[1].pem\n"),
        (Some("dist\n*.log\n"), "dist\n*.log\n/.env\n/my\\[1].pem\n"),
        (Some("dist\r\n*.log"), "dist\r\n*.log\r\n/.env\r\n/my\\[1].pem\r\n"),
    ] {
        let (_temp, env, dir) = fixture();
        if let Some(text) = before {
            write(&dir.join(".gitignore"), text);
        }
        // An unescaped `[1]` would also match my1.pem.
        for name in [".env", "my[1].pem", "my1.pem"] {
            write(&dir.join(name), "x");
        }
        let mut service = loaded(&env);
        let change = keep_out(&mut service, &dir, json!([".env", "my[1].pem", ".env"])).unwrap();
        assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), after);
        assert_eq!((&change["journal"]["canUndo"], &change["warnings"]), (&json!(true), &json!([])));
        assert!(change["snapshot"].is_object(), "the project is read again");
        assert_eq!(listed(&env, &dir), pairs(&[("my1.pem", false)]), "each line matches its file alone");
        let logged = entry(&env, &change);
        assert_eq!(logged["title"], "Added 2 files to .gitignore in demo");
        assert_eq!((&logged["detail"], &logged["canUndo"]), (&json!(".env, my[1].pem"), &json!(true)));
        // The Activity entry and the toast's journal Undo restore the same bytes.
        if before.is_some() {
            service.request("log/undo", &json!({"id":logged["id"]})).unwrap();
        } else {
            service.request("undo", &json!({"id":change["journal"]["id"]})).unwrap();
        }
        match before {
            Some(text) => assert_eq!(fs::read(dir.join(".gitignore")).unwrap(), text.as_bytes()),
            None => assert!(!dir.join(".gitignore").exists()),
        }
        assert_eq!(listed(&env, &dir).len(), 3);
        assert_eq!(entry(&env, &change)["state"], "undone");
    }
}

#[cfg(unix)]
#[test]
fn keep_out_escapes_wildcards_and_keeps_the_file_mode() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    let (_temp, env, dir) = fixture();
    // Unescaped, `*` and `?` would also match odd-x.pem.
    for name in ["odd*?.pem", "odd-x.pem", "deploy.key", "plain.txt"] {
        write(&dir.join(name), "x");
    }
    let file = dir.join(".gitignore");
    let mut service = loaded(&env);
    keep_out(&mut service, &dir, json!(["odd*?.pem"])).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "/odd\\*\\?.pem\n");
    assert_eq!(listed(&env, &dir), pairs(&[("deploy.key", false), ("odd-x.pem", false)]));
    assert_eq!(mode(&file), mode(&dir.join("plain.txt")), "a new .gitignore gets the usual permissions");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    let change = keep_out(&mut service, &dir, json!(["deploy.key"])).unwrap();
    assert_eq!((fs::read_to_string(&file).unwrap(), mode(&file)), ("/odd\\*\\?.pem\n/deploy.key\n".into(), 0o640));
    service.request("undo", &json!({"id":change["journal"]["id"]})).unwrap();
    assert_eq!((fs::read_to_string(&file).unwrap(), mode(&file)), ("/odd\\*\\?.pem\n".into(), 0o640));
}

#[test]
fn an_older_keep_out_waits_until_the_newer_one_is_undone() {
    let (_temp, env, dir) = fixture();
    write(&dir.join(".gitignore"), "dist\n");
    write(&dir.join(".env"), "x");
    write(&dir.join("deploy.pem"), "x");
    let mut service = loaded(&env);
    let first = entry(&env, &keep_out(&mut service, &dir, json!([".env"])).unwrap());
    let second = entry(&env, &keep_out(&mut service, &dir, json!(["deploy.pem"])).unwrap());
    assert_eq!(first["title"], "Added .env to .gitignore in demo");
    assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "dist\n/.env\n/deploy.pem\n");
    assert!(
        service.request("log/undo", &json!({"id":first["id"]})).unwrap_err().contains("Undo the newer change first")
    );
    service.request("log/undo", &json!({"id":second["id"]})).unwrap();
    assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "dist\n/.env\n");
    service.request("log/undo", &json!({"id":first["id"]})).unwrap();
    assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "dist\n");
}

#[test]
fn undo_keeps_a_gitignore_that_changed_after_keep_out() {
    for existed in [true, false] {
        let (_temp, env, dir) = fixture();
        if existed {
            write(&dir.join(".gitignore"), "dist\n");
        }
        write(&dir.join(".env"), "x");
        let mut service = loaded(&env);
        let change = keep_out(&mut service, &dir, json!([".env"])).unwrap();
        // The agent then adds lines of its own, as the fix prompt asks it to.
        let text = fs::read_to_string(dir.join(".gitignore")).unwrap() + "node_modules/\n.env.production\n";
        write(&dir.join(".gitignore"), &text);
        let logged = entry(&env, &change);
        for refused in [
            service.request("log/undo", &json!({"id":logged["id"]})).unwrap_err(),
            service.request("undo", &json!({"id":change["journal"]["id"]})).unwrap_err(),
        ] {
            assert!(refused.contains("~/project/demo/.gitignore changed after this"), "{refused}");
        }
        assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), text, "nothing is lost");
        assert_eq!(entry(&env, &change)["state"], "applied");
    }
}

#[test]
fn undo_after_the_project_moved_brings_back_no_folder() {
    let (_temp, env, dir) = fixture();
    write(&dir.join(".gitignore"), "dist\n");
    write(&dir.join(".env"), "x");
    let mut service = loaded(&env);
    let change = keep_out(&mut service, &dir, json!([".env"])).unwrap();
    let moved = env.home.join("project/moved");
    let move_change = service.request("move", &json!({"id":dir,"destination":moved})).unwrap();
    let refused = service.request("log/undo", &json!({"id":entry(&env, &change)["id"]})).unwrap_err();
    assert!(refused.contains("or its folder moved"), "{refused}");
    assert!(!dir.exists(), "the old folder isn't made again");
    assert_eq!(fs::read_to_string(moved.join(".gitignore")).unwrap(), "dist\n/.env\n");
    // Another project in the old place keeps its own .gitignore too.
    write(&dir.join(".gitignore"), "target/\n");
    assert!(service.request("undo", &json!({"id":change["journal"]["id"]})).is_err());
    assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "target/\n");
    fs::remove_dir_all(&dir).unwrap();
    service.request("undo", &json!({"id":move_change["journal"]["id"]})).unwrap();
    assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "dist\n/.env\n", "the move still undoes");
}

#[test]
fn keep_out_refuses_anything_the_check_did_not_list() {
    let (_temp, env, dir) = fixture();
    write(&dir.join(".gitignore"), "ignored.key\n");
    for name in [".env", "notes.txt", "ignored.key", "config/.env"] {
        write(&dir.join(name), "x");
    }
    let mut service = loaded(&env);
    for (files, error) in [
        (json!([]), "Choose the files to keep out"),
        (json!(".env"), "Choose the files to keep out"),
        (json!([1]), "Invalid file name"),
        (json!([""]), "isn't inside the project"),
        (json!(["../outside.pem"]), "isn't inside the project"),
        (json!(["config/../.env"]), "isn't inside the project"),
        (json!(["/etc/ssl/private/site.key"]), "isn't inside the project"),
        (json!(["line\nbreak.pem"]), "line break"),
        (json!(["notes.txt"]), "isn't on the list"),
        (json!(["ignored.key"]), "isn't on the list"),
        (json!(["gone.pem"]), "isn't on the list"),
        (json!(["config"]), "isn't on the list"),
        (json!([".env", "notes.txt"]), "isn't on the list"),
    ] {
        let refused = keep_out(&mut service, &dir, files.clone()).unwrap_err();
        assert!(refused.contains(error), "{files}: {refused}");
    }
    assert!(service.request("secrets/keep-out", &json!({"id":dir.join("missing"),"files":[".env"]})).is_err());
    assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "ignored.key\n");
    assert!(activity::read_log(&env, 50).is_empty());
    // Like the other changes to files, it waits for a refresh of history and for a project being made.
    assert!(mutates("secrets/keep-out") && changes_history("secrets/keep-out"));
    assert!(!mutates("secrets/check") && !changes_history("secrets/check"));
}

#[cfg(unix)]
#[test]
fn keep_out_waits_for_the_change_lock_and_never_follows_a_link() {
    let (temp, env, dir) = fixture();
    write(&dir.join(".env"), "x");
    let mut service = loaded(&env);
    write(&env.data_dir.join("lock"), &std::process::id().to_string());
    assert!(keep_out(&mut service, &dir, json!([".env"])).unwrap_err().contains("changing files right now"));
    assert!(!dir.join(".gitignore").exists());
    fs::remove_file(env.data_dir.join("lock")).unwrap();
    // A .gitignore that is a link is never written through, wherever it leads.
    for (target, refused) in
        [(temp.path().join("elsewhere"), "outside your home folder"), (env.home.join("shared-ignore"), "linked")]
    {
        write(&target, "kept\n");
        let _ = fs::remove_file(dir.join(".gitignore"));
        std::os::unix::fs::symlink(&target, dir.join(".gitignore")).unwrap();
        let error = keep_out(&mut service, &dir, json!([".env"])).unwrap_err();
        assert!(error.contains(refused), "{error}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "kept\n");
    }
    assert!(activity::read_log(&env, 50).is_empty());
}

#[test]
fn a_tracked_secret_gets_its_line_and_a_warning_that_git_still_has_it() {
    let (_temp, env, dir) = fixture();
    write(&dir.join(".env"), "x");
    git(&dir, &["add", ".env"]);
    git(&dir, &["commit", "-qm", "oops"]);
    let mut service = loaded(&env);
    let change = keep_out(&mut service, &dir, json!([".env"])).unwrap();
    assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "/.env\n");
    assert_eq!(
        change["warnings"],
        json!(["Git still tracks .env, so the saved versions keep it. Ask your AI to stop tracking it without \
deleting it."])
    );
    assert_eq!(listed(&env, &dir), pairs(&[(".env", true)]));
    let again = keep_out(&mut service, &dir, json!([".env"])).unwrap_err();
    assert!(again.starts_with(".env is already in .gitignore, but Git still tracks it."), "{again}");
    // With a file Git can still add, the line goes in and the warning still names the tracked one.
    write(&dir.join("deploy.pem"), "x");
    let change = keep_out(&mut service, &dir, json!([".env", "deploy.pem"])).unwrap();
    assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "/.env\n/deploy.pem\n");
    assert!(change["warnings"][0].as_str().unwrap().starts_with("Git still tracks .env,"), "{change}");
    assert_eq!(entry(&env, &change)["title"], "Added deploy.pem to .gitignore in demo");
}

#[test]
fn a_rule_that_lets_a_file_back_in_is_reported() {
    let (_temp, env, dir) = fixture();
    write(&dir.join("config/.gitignore"), "!credentials.json\n");
    write(&dir.join("config/credentials.json"), "{}");
    let mut service = loaded(&env);
    let change = keep_out(&mut service, &dir, json!(["config/credentials.json"])).unwrap();
    assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "/config/credentials.json\n");
    assert_eq!(
        change["warnings"],
        json!(["Git can still add config/credentials.json: another .gitignore lets it in."])
    );
}

#[test]
fn fix_prompts_carry_the_limits() {
    let env = Env::for_home("/home/u".into());
    let mut node = json!({"label":"shop","name":"shop","path":"/home/u/project/shop","git":{
        "branch":"main","upstream":"origin/main","ahead":2,"behind":1,"remotes":[{"name":"origin"}]}});
    for code in ["no-remote", "no-commits", "no-git", "dirty", "unpushed", "diverged", "stash"] {
        let prompt = assistant::fix(&env, &node, code).unwrap();
        assert!(prompt.contains("shop (~/project/shop)"), "{code}: {prompt}");
        for limit in [
            "Show each command",
            "Never force-push and never rewrite history",
            "Never delete files or branches, and never throw away changes: no reset --hard",
            "listed in .gitignore and were never committed",
            "If one was committed, stop and tell me",
        ] {
            assert!(prompt.contains(limit), "{code} lacks {limit:?}");
        }
    }
    let backup = assistant::fix(&env, &node, "no-remote").unwrap();
    assert!(backup.contains("gh repo create shop --private --source . --remote origin --push"), "{backup}");
    assert!(backup.contains("glab repo create shop --private"));
    for code in ["no-git", "no-commits"] {
        let first = assistant::fix(&env, &node, code).unwrap();
        assert!(first.contains("first saved version") && first.contains(".gitignore keeps out"), "{first}");
    }
    assert!(assistant::fix(&env, &node, "no-git").unwrap().contains("Run git init in this folder."));
    let combine = assistant::fix(&env, &node, "diverged").unwrap();
    assert!(combine.contains("this computer has 2 saved versions that origin/main doesn't have"), "{combine}");
    assert!(combine.contains("origin/main has 1 saved version that") && combine.contains("--no-rebase"));
    assert!(combine.contains("Then push, without force."));
    assert!(assistant::fix(&env, &node, "unpushed").unwrap().contains("tracks origin/main, so push it with: git push"));
    assert!(assistant::fix(&env, &node, "stash").unwrap().contains("Don't apply, pop or drop a stash until I say so"));
    node["name"] = json!("My Shop");
    node["git"]["upstream"] = json!("");
    assert!(assistant::fix(&env, &node, "no-remote").unwrap().contains("gh repo create 'My Shop' --private"));
    assert!(
        assistant::fix(&env, &node, "unpushed")
            .unwrap()
            .contains("(no upstream), so push it with: git push -u -- origin main")
    );
    // A remote the repository named like an option stays a name.
    node["git"]["remotes"][0]["name"] = json!("--receive-pack=touch pwned");
    assert!(
        assistant::fix(&env, &node, "unpushed")
            .unwrap()
            .contains("so push it with: git push -u -- '--receive-pack=touch pwned' main")
    );
    node["git"]["branch"] = json!("");
    assert!(assistant::fix(&env, &node, "unpushed").unwrap().contains("No branch is checked out."));
    assert_eq!(assistant::fix(&env, &node, "behind").unwrap_err(), "Unknown fix");
}

#[test]
fn the_fix_prompt_answers_like_the_other_prompts() {
    let (_temp, env, dir) = fixture();
    let mut service = loaded(&env);
    let reply = service.request("assistant/prompt", &json!({"kind":"fix","id":dir,"code":"no-commits"})).unwrap();
    let mut keys: Vec<&String> = reply.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["projectPath", "prompt"]);
    assert_eq!(reply["projectPath"], json!(dir));
    assert!(reply["prompt"].as_str().unwrap().starts_with("Make the first saved version of demo (~/project/demo)."));
    assert!(service.request("assistant/prompt", &json!({"kind":"fix","id":dir,"code":"push"})).is_err());
    assert!(service.request("assistant/prompt", &json!({"kind":"fix","id":"/elsewhere","code":"dirty"})).is_err());
}

/// A project whose commits are all on a local backup, so a Trash plan allows removal.
fn backed_up() -> (support::TempDir, Env, PathBuf, Value) {
    let (temp, env, dir) = fixture();
    let remote = temp.path().join("backup.git");
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "--initial-branch=main"]);
    write(&dir.join(".gitignore"), ".env\n*.db\nnode_modules/\ndist/\n.next/\nuploads/\nlogs/\n.DS_Store\n");
    write(&dir.join("data/.gitkeep"), "");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "first"]);
    git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&dir, &["push", "-q", "-u", "origin", "main"]);
    let node = node(&dir);
    (temp, env, dir, node)
}

#[cfg(target_os = "linux")]
#[test]
fn a_trash_plan_names_ignored_files_whose_names_arent_valid_text() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    let (_temp, env, dir, node) = backed_up();
    fs::write(dir.join(".git/info/exclude"), "*.old/\n").unwrap();
    fs::write(dir.join(OsStr::from_bytes(b"caf\xe9.db")), "x").unwrap();
    // Each folder is looked into by its own name: one holds work, the other only system clutter.
    for (folder, file) in [(&b"\xe8.old"[..], "notes.txt"), (b"\xe9.old", ".DS_Store")] {
        let folder = dir.join(OsStr::from_bytes(folder));
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join(file), "x").unwrap();
    }
    let plan = deletion::plan(&env, &node).unwrap();
    assert_eq!(plan["allowed"], true, "{plan}");
    assert_eq!(plan["unbacked"], json!({"files":["caf\u{FFFD}.db","\u{FFFD}.old/"],"more":0}));
}

#[test]
fn a_trash_plan_names_what_only_this_computer_has_but_not_dependencies() {
    let (_temp, env, dir, node) = backed_up();
    for name in [
        ".env",
        "data/local.db",
        "uploads/photo.png",
        "node_modules/pkg/index.js",
        "dist/app.js",
        ".DS_Store",
        // Git names these folders whole, since everything in them is ignored. Only the first holds work.
        "backups/site.db",
        "web/.next/cache.json",
        "web/.DS_Store",
    ] {
        write(&dir.join(name), "x");
    }
    // An ignored folder with nothing in it loses nothing.
    fs::create_dir(dir.join("logs")).unwrap();
    write(&dir.join(".laci.md"), "## Notes\n");
    fs::write(dir.join(".git/info/exclude"), ".laci.md\n").unwrap();
    let plan = deletion::plan(&env, &node).unwrap();
    assert_eq!(plan["allowed"], true, "{plan}");
    assert_eq!(plan["unbacked"], json!({"files":[".env",".laci.md","backups/","data/local.db","uploads/"],"more":0}));
    assert_eq!(plan["checks"][1]["code"], "ignored-files");
    for n in 0..50 {
        write(&dir.join(format!("data/cache-{n:02}.db")), "x");
    }
    let plan = deletion::plan(&env, &node).unwrap();
    assert_eq!((plan["unbacked"]["files"].as_array().unwrap().len(), &plan["unbacked"]["more"]), (50, &json!(5)));
    let plain = env.home.join("project/plain");
    write(&plain.join(".env"), "x");
    let plan = deletion::plan(&env, &json!({"kind":"project","path":plain})).unwrap();
    assert_eq!((&plan["allowed"], &plan["unbacked"]), (&json!(false), &json!({"files":[],"more":0})));
}
