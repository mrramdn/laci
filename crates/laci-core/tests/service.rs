//! Exercise the public desktop/MCP service against a real isolated home.
use laci_core::{
    activity, config,
    env::Env,
    files, readers,
    service::{Service, shell_quote},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

mod support;

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn fixture() -> (support::TempDir, Env, PathBuf) {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    // A name at a time, as the scan spells the paths it finds.
    let project = env.home.join("project").join("demo");
    write(&project.join("package.json"), r#"{"name":"demo","scripts":{"safe":"node -e 'console.log(1)'"}}"#);
    write(&project.join("README.md"), "# Demo\n\n## TODO\n\n- [ ] Read the guide\n");
    write(
        &project.join(".laci.md"),
        "---\nstatus: active\n---\n\n## Next\n\n- [ ] Write docs\n\n## Notes\n\nbase notes\n",
    );
    config::save(&env, &json!({"roots":["~/project"],"presets":[],"custom":[],"apps":{}})).unwrap();
    (temp, env, project)
}
fn loaded(env: &Env, project: &Path) -> Service {
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    assert!(snap["nodes"][project.to_str().unwrap()].is_object());
    service
}
fn latest(env: &Env, key: &str) -> Value {
    activity::read_log(env, 100).into_iter().find(|e| e["key"] == key && e["canUndo"] == true).unwrap()
}
fn undo_latest(service: &mut Service, key: &str) {
    let a = latest(&service.env, key);
    service.request("log/undo", &json!({"id":a["id"]})).unwrap();
}
/// The parts the newest Log entry tells its change by.
fn said(env: &Env) -> Value {
    activity::read_log(env, 5)[0]["say"].clone()
}
fn todo_key(project: &Path, file: &str, text: &str, occurrence: usize) -> String {
    format!("todo:{}:{file}:{text}:{occurrence}", project.display())
}
fn task_states(project: &Path, file: &str, text: &str) -> Vec<bool> {
    readers::tasks(project)["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|task| task["file"] == file && task["text"] == text && task["kind"] == "check")
        .map(|task| task["done"].as_bool().unwrap())
        .collect()
}
fn meta(dir: &Path) -> Value {
    readers::parse_meta(&fs::read_to_string(dir.join(".laci.md")).unwrap())
}
fn notes(dir: &Path) -> String {
    readers::section(&fs::read_to_string(dir.join(".laci.md")).unwrap(), "Notes").unwrap_or_default()
}

#[test]
fn matching_cache_is_reused_but_other_home_or_configuration_is_rejected() {
    let (_temp, env, project) = fixture();
    let mut first = loaded(&env, &project);
    let snap = first.snapshot().unwrap();
    let cache = env.cache_dir.join("snapshot-v2.json");
    assert!(Service::new(env.clone()).current.is_some());
    files::replace(
        &cache,
        json!({"home":env.home.join("other"),"config":config::load(&env),"snapshot":snap}).to_string().as_bytes(),
    )
    .unwrap();
    let mut changed_home = Service::new(env.clone());
    assert!(changed_home.current.is_none());
    assert_eq!(changed_home.snapshot().unwrap()["home"], json!(env.home));
    files::replace(
        &cache,
        json!({"home":env.home,"config":{"roots":["~/other"]},"snapshot":snap}).to_string().as_bytes(),
    )
    .unwrap();
    let mut changed_config = Service::new(env.clone());
    assert!(changed_config.current.is_none());
    assert!(changed_config.snapshot().unwrap()["nodes"][project.to_str().unwrap()].is_object());
}
#[test]
fn unknown_session_script_fix_and_connector_requests_do_not_change_history() {
    let (_temp, env, project) = fixture();
    let mut service = loaded(&env, &project);
    let node = service.node(project.to_str().unwrap()).unwrap();
    let before = activity::read_log(&env, 100);
    for (what, arg) in [("resume", "missing-session"), ("script", "safe; touch escaped"), ("fix", "not-an-issue")] {
        assert!(service.action(&node, what, arg).is_err(), "{what} {arg}");
    }
    assert!(service.request("connector/add", &json!({"preset":"unknown"})).is_err());
    assert!(service.request("does/not/exist", &json!({})).is_err());
    assert_eq!(activity::read_log(&env, 100), before);
    let (cmd, run, _) = service.action(&node, "script", "safe").unwrap();
    assert!(run);
    assert!(cmd.unwrap().contains("'safe'"));
    assert_eq!(shell_quote("a' && b"), "'a'\\'' && b'");
}
/// The push that a branch without an upstream gets names the remote and the branch the repository chose: after
/// `--end-of-options`, Git can't read one as an option, such as `--receive-pack`, which names a program to run, and the
/// branch is a full ref.
#[test]
fn the_push_of_a_new_branch_never_reads_a_name_as_an_option() {
    let (_temp, env, project) = fixture();
    let mut service = Service::new(env);
    let node = |remote: &str, branch: &str| {
        json!({"name":"demo","path":project,"issues":[{"code":"unpushed"}],
            "git":{"upstream":"","branch":branch,"remotes":[{"name":remote}]}})
    };
    let (cmd, run, _) = service.action(&node("origin", "main"), "fix", "unpushed").unwrap();
    assert_eq!(cmd.as_deref(), Some("git push -u --end-of-options 'origin' 'refs/heads/main'"));
    assert!(!run, "the terminal shows it before it runs");
    let (cmd, _, _) = service.action(&node("--receive-pack=touch pwned", "--force"), "fix", "unpushed").unwrap();
    assert_eq!(cmd.as_deref(), Some("git push -u --end-of-options '--receive-pack=touch pwned' 'refs/heads/--force'"));
}
#[test]
fn a_script_whose_name_begins_with_a_dash_is_not_started() {
    let (_temp, env, project) = fixture();
    write(
        &project.join("package.json"),
        r#"{"name":"demo","scripts":{"safe":"node -e 'console.log(1)'","-dash":"node -e 'console.log(2)'"}}"#,
    );
    let mut service = loaded(&env, &project);
    let node = service.node(project.to_str().unwrap()).unwrap();
    // The scan lists it like any other script; only starting it is refused.
    assert!(node["stack"]["scripts"].as_array().unwrap().iter().any(|s| s["name"] == "-dash"));
    assert!(service.action(&node, "script", "-dash").unwrap_err().contains("begins with a dash"));
    let (cmd, run, _) = service.action(&node, "script", "safe").unwrap();
    assert!(run);
    assert!(cmd.unwrap().contains("'safe'"));
}
/// Runs `program` in `dir` with Git kept to the test's own settings and identity, and returns what it printed.
fn run_in(dir: &Path, program: &str, args: &[&str]) -> String {
    let out = std::process::Command::new(program)
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.test")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.test")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(out.status.success(), "{program} {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}
/// The command a fix suggests for `dir`, which waits in the terminal until the user runs it.
fn suggested_fix(service: &mut Service, dir: &Path, code: &str) -> String {
    let node = service.node(dir.to_str().unwrap()).unwrap();
    let (cmd, run, _) = service.action(&node, "fix", code).unwrap();
    assert!(!run, "a suggested fix waits for the user to run it");
    cmd.unwrap()
}
/// A first push and a new GitHub repository are suggested as commands. The names in them come from the project:
/// its folder, its remote and its branch. Each reaches the program as a name, also one that begins with a dash,
/// and the suggested push still sets the upstream.
#[test]
fn suggested_fixes_pass_folder_remote_and_branch_names_as_names() {
    let (temp, env, project) = fixture();
    let bare = |name: &str| {
        let dir = temp.path().join(name);
        fs::create_dir(&dir).unwrap();
        run_in(&dir, "git", &["init", "-q", "--bare", "--initial-branch=main"]);
        dir
    };
    let first = |dir: &Path| {
        run_in(dir, "git", &["init", "-q", "--initial-branch=main"]);
        run_in(dir, "git", &["add", "-A"]);
        run_in(dir, "git", &["commit", "-qm", "feat: first"]);
    };
    // An ordinary project: commits, a remote, and no upstream yet.
    let backup = bare("backup.git");
    first(&project);
    run_in(&project, "git", &["remote", "add", "origin", backup.to_str().unwrap()]);
    // A project whose folder and branch names begin with a dash, without a remote so far.
    let dashed = env.home.join("project/-draft");
    write(&dashed.join("notes.md"), "draft\n");
    first(&dashed);
    run_in(&dashed, "git", &["update-ref", "refs/heads/-topic", "HEAD"]);
    run_in(&dashed, "git", &["symbolic-ref", "HEAD", "refs/heads/-topic"]);
    run_in(&dashed, "git", &["update-ref", "-d", "refs/heads/main"]);

    let mut service = loaded(&env, &project);
    let push = suggested_fix(&mut service, &project, "unpushed");
    assert_eq!(push, "git push -u --end-of-options 'origin' 'refs/heads/main'");
    run_in(&project, "bash", &["--noprofile", "--norc", "-c", &push]);
    assert_eq!(run_in(&project, "git", &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/main");
    assert_eq!(
        suggested_fix(&mut service, &dashed, "no-remote"),
        "gh repo create --private --source . --remote origin --push -- '-draft'"
    );

    // Its remote's name begins with a dash too.
    let other = bare("other.git");
    run_in(&dashed, "git", &["config", "remote.-backup.url", other.to_str().unwrap()]);
    run_in(&dashed, "git", &["config", "remote.-backup.fetch", "+refs/heads/*:refs/remotes/-backup/*"]);
    service.rescan().unwrap();
    let push = suggested_fix(&mut service, &dashed, "unpushed");
    assert_eq!(push, "git push -u --end-of-options '-backup' 'refs/heads/-topic'");
    run_in(&dashed, "bash", &["--noprofile", "--norc", "-c", &push]);
    assert_eq!(run_in(&dashed, "git", &["rev-parse", "--abbrev-ref", "@{upstream}"]), "-backup/-topic");
    assert_eq!(run_in(&other, "git", &["for-each-ref", "--format=%(refname)"]), "refs/heads/-topic");
}
#[test]
fn task_file_escape_is_rejected_even_if_a_cached_whitelist_mentions_it() {
    let (temp, env, project) = fixture();
    let mut service = loaded(&env, &project);
    let sibling = env.home.join("project/outside.md");
    write(&sibling, "- [ ] keep sibling\n");
    let external = temp.path().join("outside.md");
    write(&external, "- [ ] keep external\n");
    let id = project.to_str().unwrap();
    service.current.as_mut().unwrap()["nodes"][id]["taskFiles"] = json!([{"file":"../outside.md"},{"file":external}]);
    for (file, text) in [("../outside.md", "keep sibling"), (external.to_str().unwrap(), "keep external")] {
        assert!(service.request("todo", &json!({"id":id,"op":"toggle","file":file,"text":text,"done":true})).is_err());
    }
    assert_eq!(fs::read_to_string(sibling).unwrap(), "- [ ] keep sibling\n");
    assert_eq!(fs::read_to_string(external).unwrap(), "- [ ] keep external\n");
}
#[test]
fn metadata_tasks_and_notes_can_be_changed_and_undone_through_log() {
    let (_temp, env, project) = fixture();
    let mut service = loaded(&env, &project);
    let id = project.to_str().unwrap();
    service.request("meta", &json!({"id":id,"key":"status","value":"paused"})).unwrap();
    assert_eq!(meta(&project)["status"], "paused");
    undo_latest(&mut service, &format!("meta:{id}:status"));
    assert_eq!(meta(&project)["status"], "active");
    service.request("todo", &json!({"id":id,"op":"add","text":"Add tests"})).unwrap();
    assert!(fs::read_to_string(project.join(".laci.md")).unwrap().contains("Add tests"));
    undo_latest(&mut service, &todo_key(&project, ".laci.md", "Add tests", 0));
    assert!(!fs::read_to_string(project.join(".laci.md")).unwrap().contains("Add tests"));
    service.request("todo", &json!({"id":id,"op":"toggle","file":".laci.md","text":"Write docs","done":true})).unwrap();
    assert!(fs::read_to_string(project.join(".laci.md")).unwrap().contains("[x] Write docs"));
    undo_latest(&mut service, &todo_key(&project, ".laci.md", "Write docs", 0));
    assert!(fs::read_to_string(project.join(".laci.md")).unwrap().contains("[ ] Write docs"));
    service.request("notes", &json!({"id":id,"text":"updated notes"})).unwrap();
    assert_eq!(notes(&project), "updated notes");
    undo_latest(&mut service, &format!("notes:{id}"));
    assert_eq!(notes(&project), "base notes");
}
/// Each change to a project, its to-dos, its notes and the settings is told in the Log by its form and parts.
#[test]
fn fields_to_dos_notes_settings_and_connectors_say_their_form() {
    let (_temp, env, project) = fixture();
    let mut service = loaded(&env, &project);
    let id = project.to_str().unwrap();
    let mut said_after = |name: &str, body: Value| {
        service.request(name, &body).unwrap();
        said(&env)
    };
    for (key, value, say) in [
        ("status", "paused", json!({"form":"setStatus","name":"demo","status":"paused"})),
        ("status", "", json!({"form":"clearedStatus","name":"demo"})),
        ("priority", "high", json!({"form":"setPriority","name":"demo","priority":"high"})),
        ("priority", "", json!({"form":"clearedPriority","name":"demo"})),
        ("deadline", "2026-11-02", json!({"form":"setDeadline","name":"demo","deadline":"2026-11-02"})),
        ("deadline", "", json!({"form":"clearedDeadline","name":"demo"})),
        ("client", "Acme", json!({"form":"setClient","name":"demo","client":"Acme"})),
        ("client", "", json!({"form":"clearedClient","name":"demo"})),
        ("quiet", "no-git,no-readme", json!({"form":"muted","name":"demo","check":"no-git"})),
        ("quiet", "no-readme,no-git", json!({"form":"changedMuted","name":"demo"})),
        ("quiet", "", json!({"form":"unmuted","name":"demo","check":"no-git"})),
    ] {
        assert_eq!(said_after("meta", json!({"id":id,"key":key,"value":value})), say, "{key} = {value:?}");
    }
    for (op, more, form) in [
        ("add", json!({"text":"Add tests"}), "addedStep"),
        ("toggle", json!({"done":true}), "ticked"),
        ("toggle", json!({"done":false}), "unticked"),
        ("edit", json!({"to":"Write the docs"}), "editedTodo"),
        ("delete", json!({"text":"Write the docs"}), "deletedStep"),
    ] {
        let mut body = json!({"id":id,"op":op,"file":".laci.md","text":"Write docs"});
        body.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        assert_eq!(said_after("todo", body), json!({"form":form,"name":"demo"}), "{op}");
    }
    assert_eq!(said_after("notes", json!({"id":id,"text":"new notes"})), json!({"form":"editedNotes","name":"demo"}));
    assert_eq!(
        said_after("setup/save", json!({"roots":["~/project"],"presets":["claude"],"apps":{}})),
        json!({"form":"changedSettings"})
    );
    assert_eq!(said_after("backup/auto", json!({"on":true})), json!({"form":"autoBackupOn"}));
    assert_eq!(said_after("backup/auto", json!({"on":false})), json!({"form":"autoBackupOff"}));
    let claude = json!({"form":"removedHistory","ai":"Claude Code"});
    assert_eq!(said_after("connector/remove", json!({"id":"claude"})), claude);
    let claude = json!({"form":"addedHistory","ai":"Claude Code"});
    assert_eq!(said_after("connector/add", json!({"preset":"claude"})), claude);
    let undone = activity::read_log(&env, 5)[0]["id"].clone();
    assert_eq!(said_after("log/undo", json!({"id":undone})), json!({"form":"undid"}));
    let fresh = json!({"parent":"~/project","name":"fresh","from":"empty","remote":"none"});
    assert_eq!(said_after("new", fresh), json!({"form":"created","name":"fresh"}));
}

#[test]
fn a_to_do_is_rewritten_with_its_mark_and_the_log_puts_the_old_words_back() {
    let (_temp, env, project) = fixture();
    let sidecar = project.join(".laci.md");
    fs::write(&sidecar, "---\nstatus: active\n---\n\n## Next\n\n- [x] Write `docs` now\n\n## Notes\n\nbase notes\n")
        .unwrap();
    let mut service = loaded(&env, &project);
    let id = project.to_str().unwrap();
    let edit = |to: &str| json!({"id":id,"op":"edit","file":".laci.md","text":"Write docs now","to":to});
    assert!(service.request("todo", &edit("   ")).is_err());
    assert!(service.request("todo", &edit(&"x".repeat(301))).is_err());
    let node = service.request("todo", &edit("Write the user  guide")).unwrap();
    assert!(node["tasks"].as_array().unwrap().iter().any(|t| t["text"] == "Write the user guide" && t["done"] == true));
    assert!(fs::read_to_string(&sidecar).unwrap().contains("- [x] Write the user guide\n"));
    undo_latest(&mut service, &todo_key(&project, ".laci.md", "Write the user guide", 0));
    assert!(fs::read_to_string(&sidecar).unwrap().contains("- [x] Write `docs` now\n"));
}
#[test]
fn stale_service_metadata_undo_restores_latest_value_from_disk() {
    let (_temp, env, project) = fixture();
    let id = project.to_str().unwrap();
    let mut a = loaded(&env, &project);
    let mut b = loaded(&env, &project);
    a.request("meta", &json!({"id":id,"key":"status","value":"idle"})).unwrap();
    b.request("meta", &json!({"id":id,"key":"status","value":"paused"})).unwrap();
    undo_latest(&mut b, &format!("meta:{id}:status"));
    assert_eq!(meta(&project)["status"], "idle", "Undo must restore A's latest value, not B's stale active snapshot");
}
#[test]
fn stale_service_notes_undo_restores_latest_notes_from_disk() {
    let (_temp, env, project) = fixture();
    let id = project.to_str().unwrap();
    let mut a = loaded(&env, &project);
    let mut b = loaded(&env, &project);
    a.request("notes", &json!({"id":id,"text":"A's current notes"})).unwrap();
    b.request("notes", &json!({"id":id,"text":"B's new notes"})).unwrap();
    undo_latest(&mut b, &format!("notes:{id}"));
    assert_eq!(notes(&project), "A's current notes", "Undo must restore the most recent notes read under the lock");
}
#[test]
fn stale_service_delete_undo_restores_a_current_checked_task() {
    let (_temp, env, project) = fixture();
    let id = project.to_str().unwrap();
    let mut a = loaded(&env, &project);
    let mut b = loaded(&env, &project);
    a.request("todo", &json!({"id":id,"op":"toggle","file":".laci.md","text":"Write docs","done":true})).unwrap();
    b.request("todo", &json!({"id":id,"op":"delete","file":".laci.md","text":"Write docs"})).unwrap();
    undo_latest(&mut b, &todo_key(&project, ".laci.md", "Write docs", 0));
    assert!(
        fs::read_to_string(project.join(".laci.md")).unwrap().contains("[x] Write docs"),
        "Deleting via a stale snapshot must retain the actual checkbox state in undo"
    );
}
#[test]
fn repeated_checkbox_request_keeps_the_actual_prior_state_in_undo() {
    let (_temp, env, project) = fixture();
    let id = project.to_str().unwrap();
    let mut a = loaded(&env, &project);
    let mut b = loaded(&env, &project);
    let request = json!({"id":id,"op":"toggle","file":".laci.md","text":"Write docs","done":true});
    a.request("todo", &request).unwrap();
    let first = latest(&env, &todo_key(&project, ".laci.md", "Write docs", 0));
    b.request("todo", &request).unwrap();
    let latest = latest(&env, &todo_key(&project, ".laci.md", "Write docs", 0));
    if latest["id"] != first["id"] {
        assert_eq!(
            latest["undo"]["done"], true,
            "If an idempotent toggle is logged, undo must retain true instead of unchecking A's task"
        );
    }
    assert!(fs::read_to_string(project.join(".laci.md")).unwrap().contains("[x] Write docs"));
}

#[test]
fn one_app_notes_sitting_has_one_undo_record_but_other_service_edits_break_the_sitting() {
    let (_temp, env, project) = fixture();
    let id = project.to_str().unwrap();
    let mut a = loaded(&env, &project);
    let mut b = loaded(&env, &project);
    let key = format!("notes:{id}");
    a.request("notes", &json!({"id":id,"text":"A first"})).unwrap();
    let first = latest(&env, &key);
    a.request("notes", &json!({"id":id,"text":"A autosave"})).unwrap();
    assert_eq!(
        latest(&env, &key)["id"],
        first["id"],
        "App autosaves in one sitting should share their initial undo boundary"
    );
    b.request("notes", &json!({"id":id,"text":"B intervened"})).unwrap();
    let other = latest(&env, &key);
    a.request("notes", &json!({"id":id,"text":"A after B"})).unwrap();
    assert_ne!(latest(&env, &key)["id"], other["id"], "An intervening writer must create a fresh app undo boundary");
    undo_latest(&mut a, &key);
    assert_eq!(notes(&project), "B intervened");
}
#[test]
fn each_agent_notes_edit_has_its_own_undo_boundary() {
    let (_temp, env, project) = fixture();
    let id = project.to_str().unwrap();
    let mut service = loaded(&env, &project);
    let key = format!("notes:{id}");
    service.request_as("notes", &json!({"id":id,"text":"agent first"}), "agent").unwrap();
    let first = latest(&env, &key);
    service.request_as("notes", &json!({"id":id,"text":"agent second"}), "agent").unwrap();
    assert_ne!(latest(&env, &key)["id"], first["id"]);
    undo_latest(&mut service, &key);
    assert_eq!(notes(&project), "agent first");
    undo_latest(&mut service, &key);
    assert_eq!(notes(&project), "base notes");
}

#[test]
fn external_gitdir_exclude_cannot_be_written_by_service_or_activity_undo() {
    let (temp, env, project) = fixture();
    let gitdir = temp.path().join("external-git");
    let initialized = std::process::Command::new("git")
        .args(["init", "-q", "--separate-git-dir"])
        .arg(&gitdir)
        .arg(&project)
        .output()
        .unwrap();
    assert!(initialized.status.success(), "{}", String::from_utf8_lossy(&initialized.stderr));
    let exclude = gitdir.join("info/exclude");
    let before = fs::read(&exclude).unwrap();
    let sidecar_before = fs::read(project.join(".laci.md")).unwrap();
    let mut service = loaded(&env, &project);
    let id = project.to_str().unwrap();
    assert!(service.request("meta", &json!({"id":id,"key":"status","value":"paused"})).is_err());
    assert!(service.request("notes", &json!({"id":id,"text":"no external exclusion"})).is_err());
    assert!(service.request("todo", &json!({"id":id,"op":"add","text":"no external exclusion"})).is_err());
    let entry = activity::record(
        &env,
        json!({"by":"app","title":"Old meta undo","path":project,"undo":{"type":"meta","key":"status","value":"idle"}}),
    );
    assert!(activity::undo_activity(&env, entry["id"].as_str().unwrap(), "app").is_err());
    assert_eq!(fs::read(exclude).unwrap(), before);
    assert_eq!(fs::read(project.join(".laci.md")).unwrap(), sidecar_before);
}
#[test]
fn same_length_move_keeps_codex_history_attached_after_cached_rescan() {
    let (_temp, env, project) = fixture();
    let log = env.home.join(".codex/sessions/session.jsonl");
    write(
        &log,
        &format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"same-length\",\"cwd\":{}}}}}\n", json!(project)),
    );
    let mut c = config::load(&env);
    c["presets"] = json!(["codex"]);
    config::save(&env, &c).unwrap();
    let mut service = loaded(&env, &project);
    let id = project.to_str().unwrap();
    let first = service.snapshot().unwrap();
    assert_eq!(first["nodes"][id]["agents"]["items"].as_array().unwrap().len(), 1);
    let dest = project.with_file_name("dema");
    assert_eq!(project.to_string_lossy().len(), dest.to_string_lossy().len());
    let was = fs::metadata(&log).unwrap();
    let moved = service.request("move", &json!({"id":id,"destination":dest})).unwrap();
    let after = &moved["snapshot"];
    assert_eq!(fs::metadata(&log).unwrap().len(), was.len());
    assert_eq!(fs::metadata(&log).unwrap().modified().unwrap(), was.modified().unwrap());
    assert_eq!(
        after["nodes"][dest.to_str().unwrap()]["agents"]["items"].as_array().unwrap().len(),
        1,
        "A same-size path rewrite with preserved mtime must invalidate the history parse cache"
    );
    assert!(after["items"].as_object().unwrap().values().any(|item| item["cwd"] == json!(dest)));
    assert!(after["orphans"]["items"].as_array().unwrap().is_empty());
}

#[test]
fn separate_gitdir_inside_home_keeps_local_exclusions_and_undo_working() {
    let (_temp, env, project) = fixture();
    let gitdir = env.home.join(".local/git-metadata/demo");
    fs::create_dir_all(gitdir.parent().unwrap()).unwrap();
    let initialized = std::process::Command::new("git")
        .args(["init", "-q", "--separate-git-dir"])
        .arg(&gitdir)
        .arg(&project)
        .output()
        .unwrap();
    assert!(initialized.status.success());
    let mut service = loaded(&env, &project);
    let id = project.to_str().unwrap();
    service.request("meta", &json!({"id":id,"key":"status","value":"paused"})).unwrap();
    assert_eq!(meta(&project)["status"], "paused");
    assert!(fs::read_to_string(gitdir.join("info/exclude")).unwrap().lines().any(|line| line == ".laci.md"));
    undo_latest(&mut service, &format!("meta:{id}:status"));
    assert_eq!(meta(&project)["status"], "active");
}

#[test]
fn duplicate_checkbox_toggle_and_undo_target_the_requested_occurrence() {
    let (_temp, env, project) = fixture();
    let file = project.join(".laci.md");
    let source = "---\n---\n\n## Next\n\n- [x] Repeat\n- [ ] Repeat\n\n## Notes\n";
    write(&file, source);
    let mut service = loaded(&env, &project);
    service
        .request("todo", &json!({"id":project,"op":"toggle","file":".laci.md","line":7,"text":"Repeat","done":true}))
        .unwrap();
    assert_eq!(task_states(&project, ".laci.md", "Repeat"), [true, true]);
    let entry = latest(&env, &todo_key(&project, ".laci.md", "Repeat", 1));
    assert_eq!(entry["undo"]["done"], false);
    assert_eq!(entry["undo"]["line"], 7);
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert_eq!(fs::read_to_string(file).unwrap(), source);
}

#[test]
fn duplicate_checkbox_delete_undo_restores_its_own_state_and_occurrence() {
    for (first, second) in [(true, false), (false, true)] {
        let (_temp, env, project) = fixture();
        let file = project.join(".laci.md");
        let source = format!(
            "---\n---\n\n## Next\n\n- [{}] Repeat\n- [{}] Repeat\n\n## Notes\n",
            if first { "x" } else { " " },
            if second { "x" } else { " " }
        );
        write(&file, &source);
        let mut service = loaded(&env, &project);
        service
            .request("todo", &json!({"id":project,"op":"delete","file":".laci.md","line":7,"text":"Repeat"}))
            .unwrap();
        assert_eq!(task_states(&project, ".laci.md", "Repeat"), [first]);
        let entry = latest(&env, &todo_key(&project, ".laci.md", "Repeat", 1));
        assert_eq!(entry["undo"]["done"], second);
        service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
        assert_eq!(fs::read_to_string(file).unwrap(), source);
    }
}

#[test]
fn duplicate_checkbox_line_drift_keeps_identity_for_edits_and_undo() {
    let (_temp, env, project) = fixture();
    let file = project.join(".laci.md");
    let source = "---\n---\n\n## Next\n\n- [x] Repeat\n- [ ] Repeat\n\n## Notes\n";
    write(&file, source);
    let mut service = loaded(&env, &project);
    write(&file, &format!("# inserted line\n{source}"));
    service
        .request("todo", &json!({"id":project,"op":"toggle","file":".laci.md","line":7,"text":"Repeat","done":true}))
        .unwrap();
    assert_eq!(
        task_states(&project, ".laci.md", "Repeat"),
        [true, true],
        "The old line now points to the first duplicate, but the request still identifies the second"
    );
    let entry = latest(&env, &todo_key(&project, ".laci.md", "Repeat", 1));
    assert_eq!(entry["undo"]["line"], 8);
    let changed = fs::read_to_string(&file).unwrap();
    write(&file, &format!("# another inserted line\n{changed}"));
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert_eq!(task_states(&project, ".laci.md", "Repeat"), [true, false]);
    assert!(fs::read_to_string(file).unwrap().starts_with("# another inserted line\n# inserted line\n"));
}

#[test]
fn changed_duplicate_count_and_ambiguous_requests_are_refused_without_mutation() {
    let (_temp, env, project) = fixture();
    let file = project.join(".laci.md");
    let source = "---\n---\n\n## Next\n\n- [x] Repeat\n- [ ] Repeat\n\n## Notes\n";
    write(&file, source);
    let mut service = loaded(&env, &project);
    assert!(
        service
            .request("todo", &json!({"id":project,"op":"toggle","file":".laci.md","text":"Repeat","done":true}))
            .is_err()
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), source);
    let drifted = source.replace("## Next\n", "## Next\n- [ ] Repeat\n");
    write(&file, &drifted);
    for op in ["toggle", "delete"] {
        assert!(
            service
                .request("todo", &json!({"id":project,"op":op,"file":".laci.md","line":7,"text":"Repeat","done":true}))
                .is_err()
        );
    }
    assert_eq!(fs::read_to_string(file).unwrap(), drifted);
    assert!(activity::read_log(&env, 100).is_empty());
}

#[test]
fn tasks_in_different_files_and_occurrences_have_independent_undo_keys() {
    let (_temp, env, project) = fixture();
    write(&project.join(".laci.md"), "---\n---\n\n## Next\n\n- [ ] Repeat\n- [ ] Repeat\n\n## Notes\n");
    write(&project.join("TODO.md"), "- [ ] Repeat\n");
    let mut service = loaded(&env, &project);
    for (file, line) in [(".laci.md", 6), (".laci.md", 7), ("TODO.md", 1)] {
        service
            .request("todo", &json!({"id":project,"op":"toggle","file":file,"line":line,"text":"Repeat","done":true}))
            .unwrap();
    }
    let first = latest(&env, &todo_key(&project, ".laci.md", "Repeat", 0));
    let second = latest(&env, &todo_key(&project, ".laci.md", "Repeat", 1));
    let other_file = latest(&env, &todo_key(&project, "TODO.md", "Repeat", 0));
    service.request("log/undo", &json!({"id":first["id"]})).unwrap();
    assert_eq!(task_states(&project, ".laci.md", "Repeat"), [false, true]);
    assert_eq!(task_states(&project, "TODO.md", "Repeat"), [true]);
    service.request("log/undo", &json!({"id":second["id"]})).unwrap();
    service.request("log/undo", &json!({"id":other_file["id"]})).unwrap();
    assert_eq!(task_states(&project, ".laci.md", "Repeat"), [false, false]);
    assert_eq!(task_states(&project, "TODO.md", "Repeat"), [false]);
}

#[test]
fn adding_and_undoing_a_duplicate_keeps_the_existing_checkbox() {
    let (_temp, env, project) = fixture();
    let file = project.join(".laci.md");
    let source = "---\n---\n\n## Next\n\n- [x] Repeat\n\n## Notes\n";
    write(&file, source);
    let mut service = loaded(&env, &project);
    service.request("todo", &json!({"id":project,"op":"add","text":"Repeat"})).unwrap();
    assert_eq!(task_states(&project, ".laci.md", "Repeat"), [true, false]);
    undo_latest(&mut service, &todo_key(&project, ".laci.md", "Repeat", 1));
    assert_eq!(fs::read_to_string(file).unwrap(), source);
}

#[test]
fn legacy_checkbox_undo_supports_unique_text_and_refuses_duplicates() {
    let (_temp, env, project) = fixture();
    let file = project.join(".laci.md");
    let source = fs::read_to_string(&file).unwrap().replace("[ ] Write docs", "[x] Write docs");
    write(&file, &source);
    let entry = activity::record(
        &env,
        json!({"path":project,"key":format!("todo:{}:Write docs",project.display()),"undo":{"type":"check","file":".laci.md","text":"Write docs","done":false}}),
    );
    activity::undo_activity(&env, entry["id"].as_str().unwrap(), "app").unwrap();
    assert_eq!(task_states(&project, ".laci.md", "Write docs"), [false]);
    write(&file, "- [x] Repeat\n- [ ] Repeat\n");
    let entry = activity::record(
        &env,
        json!({"path":project,"key":format!("todo:{}:Repeat",project.display()),"undo":{"type":"check","file":".laci.md","text":"Repeat","done":false}}),
    );
    assert!(activity::undo_activity(&env, entry["id"].as_str().unwrap(), "app").is_err());
    assert_eq!(fs::read_to_string(file).unwrap(), "- [x] Repeat\n- [ ] Repeat\n");
}

#[test]
fn a_new_task_cycle_supersedes_legacy_text_only_activity() {
    let (_temp, env, project) = fixture();
    let file = project.join(".laci.md");
    let checked = fs::read_to_string(&file).unwrap().replace("[ ] Write docs", "[x] Write docs");
    write(&file, &checked);
    let legacy = activity::record(
        &env,
        json!({"path":project,"key":format!("todo:{}:Write docs",project.display()),"undo":{"type":"check","file":".laci.md","text":"Write docs","done":false}}),
    );
    let mut service = loaded(&env, &project);
    for done in [false, true] {
        service
            .request("todo", &json!({"id":project,"op":"toggle","file":".laci.md","text":"Write docs","done":done}))
            .unwrap();
    }
    let legacy_in_log = activity::read_log(&env, 100).into_iter().find(|entry| entry["id"] == legacy["id"]).unwrap();
    assert_eq!(legacy_in_log["canUndo"], false);
    assert_eq!(legacy_in_log["superseded"], true);
    assert!(service.request("log/undo", &json!({"id":legacy["id"]})).is_err());
    assert_eq!(task_states(&project, ".laci.md", "Write docs"), [true]);
}

#[test]
fn checkbox_undo_refuses_a_changed_duplicate_count() {
    let (_temp, env, project) = fixture();
    let file = project.join(".laci.md");
    write(&file, "---\n---\n\n## Next\n\n- [x] Repeat\n- [ ] Repeat\n\n## Notes\n");
    let mut service = loaded(&env, &project);
    service
        .request("todo", &json!({"id":project,"op":"toggle","file":".laci.md","line":7,"text":"Repeat","done":true}))
        .unwrap();
    let entry = latest(&env, &todo_key(&project, ".laci.md", "Repeat", 1));
    let changed = fs::read_to_string(&file).unwrap().replace("## Next\n", "## Next\n- [ ] Repeat\n");
    write(&file, &changed);
    assert!(service.request("log/undo", &json!({"id":entry["id"]})).is_err());
    assert_eq!(fs::read_to_string(file).unwrap(), changed);
}

#[test]
fn displayed_checkbox_identity_survives_a_newer_backend_snapshot() {
    let (_temp, env, project) = fixture();
    let file = project.join(".laci.md");
    let source = "---\n---\n\n## Next\n\n- [x] Repeat\n- [ ] Repeat\n\n## Notes\n";
    write(&file, source);
    let mut service = loaded(&env, &project);
    let displayed = json!({"id":project,"op":"toggle","file":".laci.md","line":7,"text":"Repeat","occurrence":1,"count":2,"done":true});
    write(&file, &format!("# new line\n{source}"));
    service.rescan().unwrap();
    service.request("todo", &displayed).unwrap();
    assert_eq!(task_states(&project, ".laci.md", "Repeat"), [true, true]);
    undo_latest(&mut service, &todo_key(&project, ".laci.md", "Repeat", 1));
    assert_eq!(task_states(&project, ".laci.md", "Repeat"), [true, false]);
}

#[test]
fn deleted_duplicate_undo_restores_its_original_section_and_formatting() {
    for source in [
        "---\n---\n## Next\n- [ ] Repeat\n## Notes\nContext\n- [x] Repeat\n",
        "---\n---\n## Next\n  * [ ] **Repeat**\nKeep this café paragraph.\n## Notes\nContext\n+ [X] Repeat\nEnd notes.\n",
        "---\r\n---\r\n## Next\r\n- [ ] Repeat\r\n## Notes\r\nContext\r\n- [x] Repeat\r\n",
    ] {
        for occurrence in 0..2 {
            let (_temp, env, project) = fixture();
            let file = project.join(".laci.md");
            write(&file, source);
            let mut service = loaded(&env, &project);
            let tasks = readers::tasks(&project);
            let task = tasks["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|task| task["text"] == "Repeat")
                .nth(occurrence)
                .unwrap();
            service.request("todo", &json!({"id":project,"op":"delete","file":".laci.md","line":task["line"],"text":"Repeat","occurrence":occurrence,"count":2})).unwrap();
            undo_latest(&mut service, &todo_key(&project, ".laci.md", "Repeat", occurrence));
            assert_eq!(
                fs::read_to_string(file).unwrap(),
                source,
                "Undo must restore section, exact position, marker, checked state, and Markdown formatting"
            );
        }
    }
}

#[test]
fn deleted_checkbox_undo_refuses_any_intervening_sidecar_edit() {
    for edit in 0..5 {
        let source = if edit == 1 {
            "## Next\nBefore\n- [ ] Repeat\nAfter\n## Next\nBefore\nAfter\nContext\n"
        } else {
            "## Next\nBefore\n- [ ] Repeat\nAfter\n## Notes\nBefore\nAfter\nContext\n"
        };
        let (_temp, env, project) = fixture();
        let file = project.join(".laci.md");
        write(&file, source);
        let mut service = loaded(&env, &project);
        service.request("todo", &json!({"id":project,"op":"delete","file":".laci.md","line":3,"text":"Repeat","occurrence":0,"count":1})).unwrap();
        let entry = latest(&env, &todo_key(&project, ".laci.md", "Repeat", 0));
        let remaining = fs::read_to_string(&file).unwrap();
        let changed = match edit {
            0 | 1 => remaining.replacen("Before", "Changed", 1),
            2 => remaining.replacen("## Next", "## Notes", 1),
            3 => remaining.replace("Context", "Edited unrelated notes"),
            _ => format!("# inserted line\n{remaining}"),
        };
        write(&file, &changed);
        let error = service.request("log/undo", &json!({"id":entry["id"]})).unwrap_err();
        assert!(error.contains("changed after this deletion"), "{error}");
        assert_eq!(fs::read_to_string(file).unwrap(), changed);
    }
}

#[test]
fn deleted_duplicate_without_location_context_is_not_reinserted_elsewhere() {
    let (_temp, env, project) = fixture();
    let file = project.join(".laci.md");
    let source = "---\n---\n## Next\n## Notes\nContext\n- [x] Repeat\n";
    write(&file, source);
    let entry = activity::record(
        &env,
        json!({"path":project,"undo":{"type":"add","file":".laci.md","text":"Repeat","line":4,"occurrence":0,"count":2,"done":false}}),
    );
    assert!(activity::undo_activity(&env, entry["id"].as_str().unwrap(), "app").is_err());
    assert_eq!(fs::read_to_string(file).unwrap(), source);
}

#[test]
fn deleting_and_undoing_the_only_checkbox_preserves_file_boundaries() {
    for source in ["- [ ] Repeat", "- [x] Repeat\n", "Préface\n- [ ] Repeat"] {
        let (_temp, env, project) = fixture();
        let file = project.join(".laci.md");
        write(&file, source);
        let mut service = loaded(&env, &project);
        service.request("todo", &json!({"id":project,"op":"delete","file":".laci.md","line":1,"text":"Repeat","occurrence":0,"count":1})).unwrap();
        undo_latest(&mut service, &todo_key(&project, ".laci.md", "Repeat", 0));
        assert_eq!(fs::read_to_string(file).unwrap(), source);
    }
}

#[test]
fn quarantine_execution_acknowledges_the_journal_before_refresh_and_keeps_undo_compatible() {
    let (_temp, env, project) = fixture();
    let history =
        env.home.join(".claude/projects").join(laci_core::paths::enc(&env.home.join("project/gone").to_string_lossy()));
    write(&history.join("session.jsonl"), &format!("{}\n", json!({"cwd":env.home.join("project/gone")})));
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"custom":[],"apps":{}})).unwrap();
    let mut service = loaded(&env, &project);
    let snapshot = service.snapshot().unwrap();
    let proposal =
        snapshot["proposals"].as_array().unwrap().iter().find(|p| p["action"]["type"] == "quarantine").unwrap();
    let outcome = service.execute("apply", &json!({"id":proposal["id"]}), "app").unwrap();
    assert_eq!(outcome.value["journal"]["state"], "applied");
    assert_eq!(said(&env), json!({"form":"chatsForGone"}));
    assert!(outcome.value.get("snapshot").is_none());
    assert!(outcome.refresh.agents && !outcome.refresh.full);
    assert!(!history.exists());
    assert_eq!(service.current.as_ref().unwrap()["scannedAt"], snapshot["scannedAt"]);
    assert!(service.current.as_ref().unwrap()["proposals"].as_array().unwrap().is_empty());
    let restored = service.request_as("undo", &json!({"id":outcome.value["journal"]["id"]}), "agent").unwrap();
    assert!(restored["snapshot"].is_object());
    assert_eq!(restored["journal"]["state"], "undone");
    assert_eq!(said(&env), json!({"form":"undid"}));
    assert!(history.join("session.jsonl").exists());
}

#[test]
fn agent_context_rechecks_enabled_connectors_even_with_an_older_snapshot() {
    let (_temp, env, project) = fixture();
    config::save(&env, &json!({"roots":["~/project"],"presets":["codex"]})).unwrap();
    let mut service = loaded(&env, &project);
    let launch = json!({"provider":"codex","projectPath":project});
    assert!(service.agent_context(&launch).is_ok());
    config::save(&env, &json!({"roots":["~/project"],"presets":[]})).unwrap();
    assert!(service.agent_context(&launch).unwrap_err().contains("Add this agent connector"));
}

#[test]
fn legacy_summary_uses_connected_provider_and_requires_choice_when_ambiguous() {
    let (_temp, env, project) = fixture();
    config::save(&env, &json!({"roots":["~/project"],"presets":["codex"]})).unwrap();
    let mut service = loaded(&env, &project);
    let node = service.node(project.to_str().unwrap()).unwrap();
    // Resolving a command never starts a provider conversation; installed CLIs vary by host.
    match service.action(&node, "summary", "") {
        Ok((Some(command), true, _)) => assert!(command.starts_with("'codex' ")),
        Err(error) => assert!(error.contains("codex is not installed"), "{error}"),
        result => panic!("Unexpected summary resolution: {result:?}"),
    }
    config::save(&env, &json!({"roots":["~/project"],"presets":["codex","claude"]})).unwrap();
    assert!(service.action(&node, "summary", "").unwrap_err().contains("Choose a connected agent"));
    assert!(service.action(&node, "summary", "antigravity").unwrap_err().contains("Choose a connected agent"));
}

fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}
#[test]
fn data_folder_and_logs_are_private_even_when_they_existed_wider() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, env, project) = fixture();
    let (activity_file, log) = (env.data_dir.join("activity.jsonl"), env.data_dir.join("laci.log"));
    write(&activity_file, "");
    write(&log, "");
    for p in [&activity_file, &log] {
        fs::set_permissions(p, fs::Permissions::from_mode(0o644)).unwrap();
    }
    fs::set_permissions(&env.data_dir, fs::Permissions::from_mode(0o755)).unwrap();
    activity::record(&env, json!({"by":"app","title":"Private entry"}));
    Service::new(env.clone()).debug("hello");
    assert_eq!((mode(&env.data_dir), mode(&activity_file), mode(&log)), (0o700, 0o600, 0o600));
    fs::remove_dir_all(&env.data_dir).unwrap();
    activity::record(&env, json!({"by":"app","title":"Fresh entry"}));
    Service::new(env.clone()).debug("hello");
    assert_eq!((mode(&env.data_dir), mode(&activity_file), mode(&log)), (0o700, 0o600, 0o600));
    let mut service = loaded(&env, &project);
    service.snapshot().unwrap();
    assert_eq!(mode(&env.cache_dir), 0o700);
}
#[test]
fn debug_does_not_write_through_a_linked_log() {
    let (temp, env, _project) = fixture();
    let target = temp.path().join("elsewhere.log");
    write(&target, "keep\n");
    fs::create_dir_all(&env.data_dir).unwrap();
    std::os::unix::fs::symlink(&target, env.data_dir.join("laci.log")).unwrap();
    Service::new(env.clone()).debug("secret");
    assert_eq!(fs::read_to_string(&target).unwrap(), "keep\n");
}
#[test]
fn one_run_app_overrides_are_not_saved_but_a_different_choice_is() {
    let (_temp, mut env, project) = fixture();
    config::save(&env, &json!({"roots":["~/project"],"presets":[],"custom":[],"apps":{"editor":"vim"}})).unwrap();
    env.app_overrides.insert("editor", "zed".into());
    env.app_overrides.insert("terminal", "foot".into());
    let mut service = loaded(&env, &project);
    let shown = service.request("setup/info", &json!({})).unwrap()["apps"].clone();
    assert_eq!((shown["editor"].clone(), shown["terminal"].clone()), (json!("zed"), json!("foot")));
    let save = |service: &mut Service, apps: Value| {
        service.request("setup/save", &json!({"roots":["~/project"],"presets":[],"apps":apps})).unwrap();
        config::load(&service.env)["apps"].clone()
    };
    let apps = save(&mut service, json!({"editor":"zed","terminal":"foot","files":"nautilus"}));
    assert_eq!(apps, json!({"editor":"vim","files":"nautilus"}));
    let apps = save(&mut service, json!({"editor":"helix","terminal":"foot","files":"nautilus"}));
    assert_eq!(apps, json!({"editor":"helix","files":"nautilus"}));
}
#[test]
fn log_titles_start_with_a_capital_and_settings_changes_say_what_changed() {
    let (_temp, env, project) = fixture();
    let mut service = loaded(&env, &project);
    let id = project.to_str().unwrap();
    service.request("meta", &json!({"id":id,"key":"status","value":"paused"})).unwrap();
    service.request("meta", &json!({"id":id,"key":"status","value":"idle"})).unwrap();
    let titles: Vec<_> =
        activity::read_log(&env, 100).iter().map(|e| e["title"].as_str().unwrap().to_owned()).collect();
    assert!(titles.contains(&"Status of demo set to paused".to_owned()), "{titles:?}");
    assert!(titles.iter().all(|t| t.chars().next().unwrap().is_uppercase()));
    let base = json!({"roots":["~/project"],"presets":[],"apps":{}});
    service.request("setup/save", &base).unwrap();
    assert!(activity::read_log(&env, 100).iter().all(|e| e["key"] != "settings"));
    let mut next = base.clone();
    next["presets"] = json!(["codex"]);
    next["apps"] = json!({"editor":"zed"});
    next["terminalTarget"] = json!("external");
    service.request("setup/save", &next).unwrap();
    let entry = activity::read_log(&env, 100).into_iter().find(|e| e["key"] == "settings").unwrap();
    assert_eq!(entry["detail"], "Editor: code → zed · Terminal: built-in → external · AI tools: Codex on");
}

#[test]
fn readme_links_stay_inside_the_project_and_only_documents_open() {
    use laci_core::service::{LinkTarget, link_target};
    let (temp, env, project) = fixture();
    let project = project.canonicalize().unwrap();
    write(&project.join("docs/Set Up.md"), "# guide\n");
    write(&project.join("docs/install.sh"), "#!/bin/sh\n");
    write(&project.join("LICENSE"), "MIT\n");
    write(&env.home.join("private.md"), "not part of the project\n");
    write(&temp.path().join("outside.md"), "not under home\n");
    std::os::unix::fs::symlink(env.home.join("private.md"), project.join("docs/shortcut.md")).unwrap();
    let target = |href: &str| link_target(&project, href);

    assert_eq!(target("docs/Set%20Up.md#first-run"), Ok(LinkTarget::Open(project.join("docs/Set Up.md"))));
    assert_eq!(target("/docs/Set Up.md?plain=1"), Ok(LinkTarget::Open(project.join("docs/Set Up.md"))));
    assert_eq!(target("./docs/../docs"), Ok(LinkTarget::Show(project.join("docs"))));
    // A script or a file with no type is shown in its folder, never handed to the system opener.
    assert_eq!(target("docs/install.sh"), Ok(LinkTarget::Show(project.join("docs"))));
    assert_eq!(target("LICENSE"), Ok(LinkTarget::Show(project.clone())));

    for outside in ["../../private.md", "docs/../../../private.md", "..%2F..%2Fprivate.md", "docs/shortcut.md"] {
        assert_eq!(target(outside).unwrap_err(), "That link leads outside this project", "{outside}");
    }
    assert_eq!(target("docs/missing.md").unwrap_err(), "That file is gone");
    assert_eq!(target("#top").unwrap_err(), "That link has no file to open");

    let mut service = loaded(&env, &project);
    let opened = |service: &mut Service, url: &str| service.request("open/url", &json!({"url":url}));
    for refused in ["file:///etc/hostname", "javascript:alert(1)", "ftp://example.test/x", "vscode://file/x", ""] {
        assert_eq!(opened(&mut service, refused).unwrap_err(), "Only web and mail addresses can be opened");
    }
    let escaped = service.request("open", &json!({"id":project,"what":"link","arg":"../../private.md"}));
    assert_eq!(escaped.unwrap_err(), "That link leads outside this project");
}
#[test]
fn a_badge_leaves_nothing_behind_in_a_summary() {
    let line = "Shell config. [![build](https://img.example/b.svg)](https://ci.example) See the [docs](docs/a.md).";
    assert_eq!(readers::strip_md(line), "Shell config. See the docs.");
}

#[test]
fn health_lists_what_stands_behind_the_counts() {
    let (temp, env, project) = fixture();
    let git = |dir: &Path, args: &[&str]| {
        let out = std::process::Command::new("git")
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
    };
    let remote = temp.path().join("backup.git");
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "--initial-branch=main"]);
    write(&project.join("package.json"), r#"{"name":"demo","version":"1.4.0"}"#);
    git(&project, &["init", "-q", "--initial-branch=main"]);
    git(&project, &["add", "-A"]);
    git(&project, &["commit", "-qm", "feat: first release"]);
    git(&project, &["tag", "v1.3.0"]);
    git(&project, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&project, &["push", "-q", "-u", "origin", "main"]);
    for name in ["one", "two"] {
        write(&project.join(format!("{name}.txt")), name);
        git(&project, &["add", "-A"]);
        git(&project, &["commit", "-qm", &format!("feat: {name}")]);
    }
    write(&project.join("one.txt"), "edited");
    write(&project.join("draft.txt"), "new");

    let mut service = loaded(&env, &project);
    let health = service.request("health", &json!({"id":project})).unwrap();
    assert_eq!(health["changes"], json!([{"code":"M","path":"one.txt"},{"code":"??","path":"draft.txt"}]));
    assert_eq!(health["changesMore"], 0);
    let subjects = |key: &str| -> Vec<String> {
        health[key].as_array().unwrap().iter().map(|c| c["subject"].as_str().unwrap().to_owned()).collect()
    };
    assert_eq!(subjects("unpushed"), ["feat: two", "feat: one"]);
    assert_eq!(subjects("recent"), ["feat: two", "feat: one", "feat: first release"]);
    assert_eq!(health["recent"][0]["author"], "Test");
    assert!(health["recent"][0]["at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        (&health["release"]["version"], &health["release"]["source"], &health["release"]["tag"]),
        (&json!("1.4.0"), &json!("package.json"), &json!("v1.3.0"))
    );
    assert_eq!(health["release"]["since"], 2);
    assert!(service.request("health", &json!({"id":"/nowhere"})).is_err());
}

#[test]
fn a_backup_leaves_a_trace_and_clears_the_warning_until_a_session_changes() {
    let (_temp, env, project) = fixture();
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"custom":[]})).unwrap();
    let store = env.home.join(".claude/projects").join(laci_core::paths::enc(&project.to_string_lossy()));
    let session = store.join("11111111-2222-3333-4444-555555555555.jsonl");
    write(&session, &format!("{}\n", json!({"type":"user","cwd":project,"sessionId":"s1"})));
    write(&store.join("memory/MEMORY.md"), "- note\n");
    let mut service = loaded(&env, &project);
    let warned = |snap: &Value| snap["warnings"].as_array().unwrap().iter().any(|w| w["code"] == "claude-cleanup");
    let snap = service.snapshot().unwrap();
    assert!(warned(&snap));
    assert_eq!(snap["backup"], json!({"auto":false}));

    assert_eq!(service.request("backup", &json!({"auto":true})).unwrap(), json!({"skipped":true}));
    let done = service.request("backup", &json!({})).unwrap();
    assert_eq!((&done["copied"], &done["sessions"], &done["files"]), (&json!(2), &json!(1), &json!(2)));
    assert_eq!(done["dest"], "~/.local/share/laci/history");
    let snap = done["snapshot"].clone();
    assert!(!warned(&snap), "Nothing changed since the backup, so there is nothing to warn about");
    assert_eq!((&snap["backup"]["pending"], &snap["backup"]["sessions"]), (&json!(0), &json!(1)));
    let entry = &activity::read_log(&env, 10)[0];
    assert_eq!(entry["title"], "Backed up 2 agent history files");
    assert_eq!(entry["say"], json!({"form":"backedUp","files":2}));
    assert!(entry["detail"].as_str().unwrap().starts_with("1 session kept · "));

    service.request("backup", &json!({})).unwrap();
    assert_eq!(activity::read_log(&env, 10)[0]["title"], "Agent history backup is up to date");
    assert_eq!(said(&env), json!({"form":"backupUpToDate"}));

    std::thread::sleep(std::time::Duration::from_millis(20));
    write(&session, &format!("{}\n{}\n", json!({"type":"user","cwd":project,"sessionId":"s1"}), json!({"more":1})));
    service.request("backup/auto", &json!({"on":true})).unwrap();
    assert_eq!(said(&env), json!({"form":"autoBackupOn"}));
    let snap = service.rescan().unwrap();
    assert_eq!((&snap["backup"]["pending"], &snap["backup"]["auto"]), (&json!(1), &json!(true)));
    let warning = snap["warnings"].as_array().unwrap().iter().find(|w| w["code"] == "claude-cleanup").unwrap();
    assert!(warning["detail"].as_str().unwrap().ends_with("1 session has changed since the last backup."));
    // An automatic run waits an hour after the last one, however much has changed.
    assert_eq!(service.request("backup", &json!({"auto":true})).unwrap(), json!({"skipped":true}));
}

#[test]
fn a_tool_the_user_describes_can_be_started_and_given_the_mcp_server() {
    let (_temp, mut env, project) = fixture();
    env.program = env.home.join("bin/laci");
    write(&env.program, "");
    let mut service = loaded(&env, &project);
    let snap = service
        .request(
            "connector/add",
            &json!({"name":"Aider","agent":{"command":"laci-test-aider","prompt":"--message {prompt}",
                "continue":"--restore-chat-history","mcp":{"file":"~/.aider/mcp.json"}}}),
        )
        .unwrap();
    let card = snap["connectors"].as_array().unwrap().iter().find(|c| c["id"] == "custom-aider").unwrap();
    assert_eq!(
        (&card["provider"], &card["command"], &card["where"]),
        (&json!("custom-aider"), &json!("laci-test-aider"), &json!(""))
    );
    assert_eq!(card["link"], json!({"kind":"none"}));
    assert_eq!(
        card["capabilities"],
        json!({"launch":true,"resume":false,"titles":false,"modelDiscovery":"aliases","continue":true,"mcp":true})
    );
    assert_eq!(activity::read_log(&env, 10)[0]["title"], "Added Aider");
    assert_eq!(said(&env), json!({"form":"addedTool","ai":"Aider"}));
    // A second tool without history is its own card, not a copy of the first.
    let snap = service.request("connector/add", &json!({"name":"Other","agent":{"command":"other"}})).unwrap();
    assert_eq!(snap["connectors"].as_array().unwrap().len(), 2);

    let (request, session) = service
        .agent_context(&json!({"provider":"custom-aider","projectPath":project,"prompt":"hi","continue":true}))
        .unwrap();
    assert!(session.is_none() && request.continue_last);
    let error = laci_core::launch::resolve(&env, &request, None).unwrap_err();
    assert_eq!(error, "laci-test-aider is not installed or is not on PATH");
    assert!(service.agent_context(&json!({"provider":"custom-nope","projectPath":project})).is_err());
    assert!(service.agent_context(&json!({"provider":"../claude","projectPath":project})).is_err());

    let list = service.request("agent/mcp", &json!({})).unwrap();
    assert_eq!(list["agents"].as_array().unwrap().len(), 1, "only tools that keep MCP servers are listed");
    assert_eq!(
        (&list["agents"][0]["provider"], &list["agents"][0]["state"]),
        (&json!("custom-aider"), &json!("missing"))
    );
    let done = service.request("agent/mcp/apply", &json!({"provider":"custom-aider"})).unwrap();
    assert_eq!(done["status"]["state"], "registered");
    let saved: Value = serde_json::from_str(&fs::read_to_string(env.home.join(".aider/mcp.json")).unwrap()).unwrap();
    assert_eq!(saved["mcpServers"]["laci"], json!({"command":env.program,"args":["mcp"]}));
    let entry = &activity::read_log(&env, 10)[0];
    assert_eq!(
        (&entry["title"], &entry["detail"]),
        (&json!("Added Laci's MCP server to Aider"), &json!("Edited ~/.aider/mcp.json"))
    );
    assert_eq!(entry["say"], json!({"form":"letUse","ai":"Aider"}));
    service.request("agent/mcp/apply", &json!({"provider":"custom-aider","remove":true})).unwrap();
    let entry = &activity::read_log(&env, 10)[0];
    assert_eq!(entry["title"], "Removed Laci's MCP server from Aider");
    assert_eq!(entry["say"], json!({"form":"stoppedUse","ai":"Aider"}));
    assert!(
        entry["detail"]
            .as_str()
            .unwrap()
            .contains("earlier file kept at ~/.local/share/laci/mcp-backups/custom-aider/")
    );
    assert!(service.request("agent/mcp/apply", &json!({"provider":"claude"})).is_err(), "Claude Code is not connected");

    service.request("connector/remove", &json!({"id":"custom-aider"})).unwrap();
    assert_eq!(activity::read_log(&env, 10)[0]["title"], "Removed Aider");
    assert_eq!(said(&env), json!({"form":"removedTool","ai":"Aider"}));
    assert!(laci_core::providers::get(&env, "custom-aider").is_err());
    undo_latest(&mut service, "connector:custom-aider");
    assert_eq!(laci_core::providers::get(&env, "custom-aider").unwrap().prompt, ["--message", "{prompt}"]);
}

#[test]
fn sessions_only_the_backup_holds_are_listed_and_can_be_put_back() {
    const ID: &str = "11111111-2222-3333-4444-555555555555";
    const CODEX: &str = "99999999-2222-3333-4444-555555555555";
    let (_temp, env, project) = fixture();
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude","codex"],"custom":[]})).unwrap();
    // Spelled as the place Laci puts a session back.
    let store = env.home.join(".claude").join("projects").join(laci_core::paths::enc(&project.to_string_lossy()));
    let session = store.join(format!("{ID}.jsonl"));
    write(
        &session,
        &format!(
            "{}\n",
            json!({"type":"user","cwd":project,"sessionId":ID,"message":{"role":"user","content":"Fix the login page"}})
        ),
    );
    write(
        &store.join(format!("{ID}/subagents/agent-a.jsonl")),
        &format!("{}\n", json!({"type":"user","cwd":project,"sessionId":ID})),
    );
    write(&store.join("memory/MEMORY.md"), "- note\n");
    let rollout = env.home.join(".codex/sessions/2026/rollout.jsonl");
    write(&rollout, &format!("{}\n", json!({"type":"session_meta","payload":{"id":CODEX,"cwd":project}})));
    let mut service = loaded(&env, &project);
    let snap = service.snapshot().unwrap();
    let cleanup: Vec<_> = snap["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|w| w["code"].as_str())
        .filter(|code| code.ends_with("-cleanup"))
        .collect();
    assert_eq!(cleanup, ["claude-cleanup"], "Codex keeps its history, so only Claude Code is warned about");

    let done = service.request("backup", &json!({})).unwrap();
    assert_eq!(done["snapshot"]["backup"]["pending"], 0, "Codex sessions count as backed up too");
    fs::remove_file(&session).unwrap();
    fs::remove_file(&rollout).unwrap();
    let snap = service.rescan().unwrap();
    let kept: Vec<&Value> = snap["sessions"].as_array().unwrap().iter().filter(|s| s["backup"] == true).collect();
    assert_eq!(kept.len(), 2, "one per deleted session; subagent logs and memory are not sessions");
    let lost = *kept.iter().find(|s| s["provider"] == "claude").unwrap();
    assert_eq!(
        (&lost["title"], &lost["resumeCapability"], &lost["cwd"], &lost["restoreTo"]),
        (&json!("Fix the login page"), &json!("history-only"), &json!(project), &json!(session))
    );
    assert!(Path::new(lost["file"].as_str().unwrap()).starts_with(env.data_dir.join("history/claude")));
    assert!(kept.iter().any(|s| s["provider"] == "codex" && s["sessionId"] == CODEX));
    let (request, found) =
        service.agent_context(&json!({"provider":"claude","sessionId":ID,"projectPath":project})).unwrap();
    assert!(laci_core::launch::resolve(&env, &request, found.as_ref()).is_err(), "a copy cannot be resumed");

    let done = service.request("backup/restore", &json!({"id":lost["id"]})).unwrap();
    assert!(fs::read_to_string(&session).unwrap().contains("Fix the login page"));
    let back = done["snapshot"]["sessions"].as_array().unwrap().iter().find(|s| s["sessionId"] == ID).unwrap();
    assert_eq!((&back["backup"], &back["resumeCapability"]), (&Value::Null, &json!("supported")));
    let entry = &activity::read_log(&env, 10)[0];
    assert_eq!(
        (&entry["title"], &entry["detail"]),
        (&json!("Restored a Claude Code session from the backup"), &json!("Fix the login page"))
    );
    assert_eq!(entry["say"], json!({"form":"restoredChat","ai":"Claude Code"}));
    assert!(service.request("backup/restore", &json!({"id":lost["id"]})).is_err(), "it is no longer missing");
    assert!(service.request("backup/restore", &json!({"id":"backup:claude:../../x.jsonl"})).is_err());
}

/// A Claude Code session in `project`, last written an hour ago, with a folder of subagent logs.
fn old_session(env: &Env, project: &Path, id: &str, prompt: &str) -> PathBuf {
    let store = env.home.join(".claude/projects").join(laci_core::paths::enc(&project.to_string_lossy()));
    let session = store.join(format!("{id}.jsonl"));
    write(
        &session,
        &format!(
            "{}\n",
            json!({"type":"user","cwd":project,"sessionId":id,"message":{"role":"user","content":prompt}})
        ),
    );
    write(
        &store.join(format!("{id}/subagents/agent-a.jsonl")),
        &format!("{}\n", json!({"type":"user","cwd":project,"sessionId":id})),
    );
    let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    fs::File::options().write(true).open(&session).unwrap().set_modified(hour_ago).unwrap();
    session
}

#[test]
fn deleted_sessions_go_to_the_quarantine_with_their_backup_copy_and_undo_brings_them_back() {
    const ID: &str = "11111111-2222-3333-4444-555555555555";
    const OTHER: &str = "22222222-2222-3333-4444-555555555555";
    let (_temp, env, project) = fixture();
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"custom":[]})).unwrap();
    let session = old_session(&env, &project, ID, "Fix the login page");
    let other = old_session(&env, &project, OTHER, "Write the docs");
    let mut service = loaded(&env, &project);
    service.request("backup", &json!({})).unwrap();
    let copy =
        env.data_dir.join("history/claude").join(session.strip_prefix(env.home.join(".claude/projects")).unwrap());
    assert!(copy.is_file());

    // Kept sessions, sessions still being written and unknown files are refused, and nothing moves.
    service
        .request("session/keep", &json!({"sessions":[{"provider":"claude","sessionId":OTHER}],"keep":true}))
        .unwrap();
    let snap = service.snapshot().unwrap();
    let kept = snap["sessions"].as_array().unwrap().iter().find(|s| s["sessionId"] == OTHER).unwrap();
    assert_eq!(kept["kept"], true);
    let refused = service.request("session/delete", &json!({"files":[other]})).unwrap_err();
    assert!(refused.contains("is kept"), "{refused}");
    let typed = fs::read_to_string(&other).unwrap();
    fs::write(&other, &typed).unwrap();
    service.rescan().unwrap();
    service
        .request("session/keep", &json!({"sessions":[{"provider":"claude","sessionId":OTHER}],"keep":false}))
        .unwrap();
    assert!(service.request("session/delete", &json!({"files":[other]})).unwrap_err().contains("still being written"));
    assert!(service.request("session/delete", &json!({"files":[env.home.join("x.jsonl")]})).is_err());
    assert!(other.exists());

    let done = service.request("session/delete", &json!({"files":[session]})).unwrap();
    assert_eq!(done["journal"]["title"], "Deleted the session “Fix the login page”");
    assert_eq!(said(&env), json!({"form":"deletedChat","title":"Fix the login page"}));
    assert!(!session.exists() && !session.with_extension("").exists() && !copy.exists());
    let snap = service.rescan().unwrap();
    assert!(
        !snap["sessions"].as_array().unwrap().iter().any(|s| s["sessionId"] == ID),
        "neither the session nor its backup copy is listed any more"
    );
    let entry = activity::read_log(&env, 20).into_iter().find(|e| e["journal"] == done["journal"]["id"]).unwrap();
    assert_eq!(entry["canUndo"], true);
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert_eq!(said(&env), json!({"form":"undid"}));
    assert!(session.exists() && session.with_extension("").join("subagents/agent-a.jsonl").exists() && copy.exists());

    // Emptying the quarantine makes a deletion final: the Log stops offering its Undo.
    let done = service.request("session/delete", &json!({"files":[session]})).unwrap();
    let storage = service.request("storage", &json!({})).unwrap();
    let removed = storage["parts"].as_array().unwrap().iter().find(|p| p["id"] == "removed").unwrap();
    assert!(removed["bytes"].as_u64().unwrap() > 0);
    service.request("storage/free", &json!({"part":"removed"})).unwrap();
    assert_eq!(said(&env), json!({"form":"emptiedKept"}));
    assert!(fs::read_dir(env.data_dir.join("orphans")).unwrap().next().is_none());
    let entry = activity::read_log(&env, 20).into_iter().find(|e| e["journal"] == done["journal"]["id"]).unwrap();
    assert_eq!(entry["canUndo"], false);
    assert!(service.request("undo", &json!({"id":done["journal"]["id"]})).unwrap_err().contains("free space"));
}

#[test]
fn only_files_left_by_laci_1_are_freed_from_its_config_folder() {
    let (_temp, env, project) = fixture();
    write(&env.config_dir.join("Cache/data_0"), "x".repeat(4096).as_str());
    write(&env.config_dir.join("Local State"), "{}");
    write(&env.config_dir.join("mine.txt"), "keep me");
    let mut service = loaded(&env, &project);
    let storage = service.request("storage", &json!({})).unwrap();
    let legacy = storage["parts"].as_array().unwrap().iter().find(|p| p["id"] == "legacy").unwrap();
    assert_eq!(legacy["free"], 4098);
    service.request("storage/free", &json!({"part":"legacy"})).unwrap();
    assert!(!env.config_dir.join("Cache").exists() && !env.config_dir.join("Local State").exists());
    assert!(env.config_dir.join("config.json").exists() && env.config_dir.join("mine.txt").exists());
    assert!(service.request("storage/free", &json!({"part":"history"})).is_err());
    assert_eq!(activity::read_log(&env, 5)[0]["title"], "Removed files left by Laci 1");
    assert_eq!(said(&env), json!({"form":"removedLaci1"}));
}

#[test]
fn a_dismissed_suggestion_stays_away_until_it_is_asked_back() {
    let (_temp, env, project) = fixture();
    let history =
        env.home.join(".claude/projects").join(laci_core::paths::enc(&env.home.join("project/gone").to_string_lossy()));
    write(&history.join("session.jsonl"), &format!("{}\n", json!({"cwd":env.home.join("project/gone")})));
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"custom":[],"apps":{}})).unwrap();
    let mut service = loaded(&env, &project);
    let snap = service.snapshot().unwrap();
    let id = snap["proposals"][0]["id"].clone();
    assert!(id.is_string());
    let after = service.request("proposal/dismiss", &json!({"id":id})).unwrap();
    let snap = &after["snapshot"];
    assert!(!snap["proposals"].as_array().unwrap().iter().any(|p| p["id"] == id));
    assert_eq!(snap["dismissed"][0]["id"], id);
    assert!(activity::read_log(&env, 5)[0]["title"].as_str().unwrap().starts_with("Dismissed: "));
    assert_eq!(said(&env), json!({"form":"dismissed","title":snap["dismissed"][0]["title"]}));
    // A second click on the same button finds it done, and says so without a second Log entry.
    let logged = activity::read_log(&env, 50).len();
    service.request("proposal/dismiss", &json!({"id":id})).unwrap();
    assert_eq!(activity::read_log(&env, 50).len(), logged);
    let back = service.request("proposal/dismiss", &json!({"id":id,"undo":true})).unwrap();
    assert!(back["snapshot"]["proposals"].as_array().unwrap().iter().any(|p| p["id"] == id));
    assert_eq!(said(&env)["form"], "suggestedAgain");
    service.request("proposal/dismiss", &json!({"id":id,"undo":true})).unwrap();
    assert_eq!(activity::read_log(&env, 50).len(), logged + 1);
}

#[test]
fn a_muted_check_is_marked_and_named_in_the_log() {
    let (_temp, env, project) = fixture();
    let mut service = loaded(&env, &project);
    let id = project.to_str().unwrap();
    service.request("meta", &json!({"id":id,"key":"quiet","value":"no-git"})).unwrap();
    let snap = service.snapshot().unwrap();
    let issue = snap["nodes"][id]["issues"].as_array().unwrap().iter().find(|i| i["code"] == "no-git").unwrap().clone();
    assert_eq!(issue["muted"], true);
    assert_eq!(activity::read_log(&env, 5)[0]["title"], "Muted “Not under version control” on demo");
    assert_eq!(said(&env), json!({"form":"muted","name":"demo","check":"no-git"}));
    assert!(service.request("meta", &json!({"id":id,"key":"quiet","value":"No Git!"})).is_err());
}

#[test]
fn build_output_is_deleted_for_good_and_a_linked_build_folder_is_left_alone() {
    let (_temp, env, project) = fixture();
    write(&project.join("node_modules/pkg/index.js"), &"x".repeat(1_500_000));
    let elsewhere = env.home.join("elsewhere/target");
    write(&elsewhere.join("debug/app"), &"x".repeat(1_500_000));
    support::link_dir(&elsewhere, &project.join("target"));
    let mut service = loaded(&env, &project);
    let id = project.to_str().unwrap();
    let parts = service.snapshot().unwrap()["nodes"][id]["size"]["parts"].clone();
    assert_eq!(parts.as_array().unwrap().len(), 1, "a linked build folder is not this project's: {parts}");
    let done = service.request("clean", &json!({"id":id})).unwrap();
    assert_eq!(done["journal"]["title"], "Deleted the build output of demo");
    assert!(!project.join("node_modules").exists(), "deleted, not moved to the Trash");
    assert!(elsewhere.join("debug/app").exists() && project.join("target").is_symlink());
    let entry = activity::read_log(&env, 5).into_iter().find(|e| e["journal"] == done["journal"]["id"]).unwrap();
    assert_eq!(entry["canUndo"], false);
    assert_eq!(entry["detail"], "Deleted build output comes back with the next install or build.");
    assert_eq!(entry["say"], json!({"form":"clearedBuild","name":"demo"}));
}
