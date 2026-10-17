use laci_core::{activity, create, env::Env, ops, paths, sidecar};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime},
};

mod support;

fn home() -> (tempfile::TempDir, Env) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    let env = Env::for_home(home);
    (temp, env)
}
fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn stamp(path: &Path) {
    fs::File::open(path)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000))
                .set_accessed(SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000)),
        )
        .unwrap();
}
fn fixture(env: &Env) -> (Value, PathBuf, PathBuf, PathBuf, String) {
    let from = env.home.join("project/demo");
    let to = env.home.join("project/_archive/demo");
    write(&from.join("README.md"), "# demo\noriginal bytes\n");
    write(&from.join(".serena/memories/context.md"), "keep inside history\n");
    let store = env.home.join(".claude/projects").join(paths::enc(&from.to_string_lossy()));
    let original = format!(
        "{{\"cwd\" : {},\"message\":\"keep   whitespace\"}}\n{{\"cwd\":{}}}\n",
        json!(from),
        json!(from.join("docs"))
    );
    write(&store.join("session.jsonl"), &original);
    stamp(&store.join("session.jsonl"));
    let snapshot = json!({"roots":[env.home.join("project")],"nodes":{"demo":{"name":"demo","path":from,"kind":"project"}},"claude":{"old":{"dir":store,"path":from,"gone":[],"sessions":[{"cwd":from}]}},"items":{},"connectors":[]});
    (snapshot, from, to, store, original)
}
fn v1(env: &Env, args: &[&str]) -> Value {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v1-operations.mjs");
    let output = Command::new("node")
        .arg(script)
        .args(args)
        .env("HOME", &env.home)
        .output()
        .expect("Node is required for cross-version verification");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn rust_move_can_be_undone_by_v1_without_losing_bytes_or_time() {
    let (_temp, env) = home();
    let (snap, from, to, store, original) = fixture(&env);
    let before = fs::metadata(store.join("session.jsonl")).unwrap().modified().unwrap();
    let j = ops::move_project(&env, &snap, "demo", &to.to_string_lossy(), &json!({"status":"archived"})).unwrap();
    let target = store.parent().unwrap().join(paths::enc(&to.to_string_lossy()));
    assert!(fs::read_to_string(target.join("session.jsonl")).unwrap().contains(to.to_str().unwrap()));
    assert_eq!(fs::metadata(target.join("session.jsonl")).unwrap().modified().unwrap(), before);
    assert!(fs::read_to_string(to.join(".laci.md")).unwrap().contains("status: archived"));
    v1(&env, &["undo", j["id"].as_str().unwrap()]);
    assert_eq!(fs::read_to_string(store.join("session.jsonl")).unwrap(), original);
    assert_eq!(fs::metadata(store.join("session.jsonl")).unwrap().modified().unwrap(), before);
    assert_eq!(fs::read_to_string(from.join("README.md")).unwrap(), "# demo\noriginal bytes\n");
    assert!(!from.join(".laci.md").exists());
    assert!(!to.exists());
}
#[test]
fn v1_move_can_be_undone_by_rust_without_losing_bytes_or_time() {
    let (_temp, env) = home();
    let (_snap, from, to, store, original) = fixture(&env);
    let before = fs::metadata(store.join("session.jsonl")).unwrap().modified().unwrap();
    let target = store.parent().unwrap().join(paths::enc(&to.to_string_lossy()));
    let j = v1(
        &env,
        &["move", from.to_str().unwrap(), to.to_str().unwrap(), store.to_str().unwrap(), target.to_str().unwrap()],
    );
    let undone = ops::undo(&env, j["id"].as_str().unwrap()).unwrap();
    assert_eq!(undone["state"], "undone");
    assert_eq!(fs::read_to_string(store.join("session.jsonl")).unwrap(), original);
    assert_eq!(fs::metadata(store.join("session.jsonl")).unwrap().modified().unwrap(), before);
    assert!(from.join(".serena/memories/context.md").is_file());
    assert!(!to.exists());
}
#[test]
fn connectors_move_and_restore_while_mentions_and_inside_history_stay_intact() {
    let (_temp, env) = home();
    let (mut snap, from, to, store, original) = fixture(&env);
    let log = env.home.join(".codex/sessions/session.jsonl");
    let content = format!("{{\"project.path\":{},\"cwd\":\"unrelated\"}}\n", json!(from.join("docs")));
    write(&log, &content);
    stamp(&log);
    let named = env.home.join(".gemini/tmp/oldhash");
    write(&named.join("history.json"), "{\"message\":\"keep\"}\n");
    let mentions = env.home.join(".claude/plans/plan.md");
    write(&mentions, &from.to_string_lossy());
    snap["connectors"] = json!([{"id":"logs","link":{"kind":"cwd","field":"project.path","dir":log.parent().unwrap()}},{"id":"named","link":{"kind":"named","naming":"sha256","dir":named.parent().unwrap()}},{"id":"plans","link":{"kind":"mentions","dir":mentions.parent().unwrap()}}]);
    snap["items"] = json!({"log":{"cwd":from.join("docs"),"connector":"logs","file":log},"named":{"cwd":from,"connector":"named","file":named},"mentions":{"cwd":from,"connector":"plans","file":mentions}});
    let j = ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({})).unwrap();
    assert!(fs::read_to_string(&log).unwrap().contains(to.join("docs").to_str().unwrap()));
    assert_eq!(fs::read_to_string(&mentions).unwrap(), from.to_string_lossy());
    assert!(!named.exists());
    let expected =
        named.parent().unwrap().join(laci_core::agents::store_name(&json!({"naming":"sha256"}), to.to_str().unwrap()));
    assert!(
        expected.join("history.json").is_file(),
        "The store must use the exact destination project path, without a trailing slash"
    );
    ops::undo(&env, j["id"].as_str().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(log).unwrap(), content);
    assert_eq!(fs::read_to_string(named.join("history.json")).unwrap(), "{\"message\":\"keep\"}\n");
    assert_eq!(fs::read_to_string(store.join("session.jsonl")).unwrap(), original);
}
#[test]
fn failed_history_rewrite_rolls_back_project_and_refuses_symlinks() {
    let (temp, env) = home();
    let (mut snap, from, to, _store, _original) = fixture(&env);
    let outside = temp.path().join("outside.jsonl");
    write(&outside, "{\"cwd\":\"outside\"}\n");
    let linked = env.home.join("log.jsonl");
    support::link_file(&outside, &linked);
    snap["connectors"] = json!([{"id":"log","link":{"kind":"cwd","dir":env.home,"field":"cwd"}}]);
    snap["items"] = json!({"log":{"cwd":from,"file":linked,"connector":"log"}});
    assert!(ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({})).is_err());
    assert!(from.is_dir());
    assert!(!to.exists());
    assert_eq!(fs::read_to_string(outside).unwrap(), "{\"cwd\":\"outside\"}\n");
    let journal = ops::journals(&env, 1).remove(0);
    assert_eq!(journal["state"], "undone");
}
#[test]
fn destinations_quarantine_and_undo_reject_escape_and_overwrite() {
    let (temp, env) = home();
    let (snap, from, to, _store, _original) = fixture(&env);
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let link = env.home.join("escape");
    support::link_dir(&external, &link);
    assert!(ops::move_project(&env, &snap, "demo", link.join("demo").to_str().unwrap(), &json!({})).is_err());
    assert!(
        ops::apply_action(&env, &snap, "bad", &json!({"type":"quarantine","moves":[{"from":from,"to":"../escape"}]}))
            .is_err()
    );
    fs::create_dir_all(&to).unwrap();
    write(&to.join("keep"), "existing\n");
    assert!(ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({})).is_err());
    assert_eq!(fs::read_to_string(to.join("keep")).unwrap(), "existing\n");
    fs::remove_dir_all(&to).unwrap();
    let j = ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({})).unwrap();
    fs::create_dir_all(&from).unwrap();
    write(&from.join("keep"), "new project\n");
    assert!(ops::undo(&env, j["id"].as_str().unwrap()).is_err());
    assert_eq!(fs::read_to_string(from.join("keep")).unwrap(), "new project\n");
    assert!(to.is_dir());
    assert!(ops::undo(&env, "../escape").is_err());
}
// Laci v1's lock holds a process id, which Linux checks in /proc; the busy check reads /proc too.
#[cfg(target_os = "linux")]
#[test]
fn compatible_pid_lock_and_busy_processes_prevent_changes() {
    let (_temp, env) = home();
    let (snap, from, to, _store, _original) = fixture(&env);
    write(&env.data_dir.join("lock"), &std::process::id().to_string());
    assert!(ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({})).is_err());
    fs::remove_file(env.data_dir.join("lock")).unwrap();
    write(&env.data_dir.join("lock"), "4294967295");
    assert_eq!(ops::with_lock(&env, || Ok(42)).unwrap(), 42);
    assert!(!env.data_dir.join("lock").exists());
    let mut child = Command::new("sleep").arg("30").current_dir(&from).spawn().unwrap();
    let result = ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({}));
    let _ = child.kill();
    let _ = child.wait();
    assert!(result.unwrap_err().contains("In use"));
    assert!(from.is_dir());
}
// Linux cuts a program's name at 15 bytes, and a Unix file name can be bytes that aren't UTF-8.
#[cfg(target_os = "linux")]
#[test]
fn busy_processes_with_names_or_folders_that_are_not_utf8_still_prevent_changes() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    let (temp, env) = home();
    let (snap, from, to, _store, _original) = fixture(&env);
    let refused = |child: &mut std::process::Child| {
        let result = ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({}));
        let _ = child.kill();
        let _ = child.wait();
        result
    };
    // The kernel keeps 15 bytes of a program's name, so this one is cut inside the "é".
    let sleep = String::from_utf8(Command::new("which").arg("sleep").output().unwrap().stdout).unwrap();
    let renamed = temp.path().join("aaaaaaaaaaaaaaé");
    fs::copy(sleep.trim(), &renamed).unwrap();
    let mut child = Command::new(&renamed).arg("30").current_dir(&from).spawn().unwrap();
    assert!(refused(&mut child).unwrap_err().contains("In use"));
    assert!(from.is_dir());
    // A holder inside a folder whose name isn't UTF-8 is refused too, and later changes still run.
    let odd = from.join(OsStr::from_bytes(b"caf\xe9"));
    fs::create_dir(&odd).unwrap();
    let mut child = Command::new("sleep").arg("30").current_dir(&odd).spawn().unwrap();
    assert!(refused(&mut child).unwrap_err().contains("In use"));
    assert_eq!(ops::with_lock(&env, || Ok(7)).unwrap(), 7);
}
#[test]
fn activity_supersession_unblocks_previous_change_after_newer_undo() {
    let (_temp, env) = home();
    let dir = env.home.join("notes");
    fs::create_dir(&dir).unwrap();
    sidecar::set_notes(&dir, "first").unwrap();
    let first = activity::record(
        &env,
        json!({"by":"app","title":"First notes","path":dir,"key":format!("notes:{}",dir.display()),"undo":{"type":"notes","text":""}}),
    );
    sidecar::set_notes(&dir, "second").unwrap();
    let second = activity::record(
        &env,
        json!({"by":"agent","title":"Second notes","path":dir,"key":format!("notes:{}",dir.display()),"undo":{"type":"notes","text":"first"}}),
    );
    assert!(activity::undo_activity(&env, first["id"].as_str().unwrap(), "app").unwrap_err().contains("newer"));
    activity::undo_activity(&env, second["id"].as_str().unwrap(), "app").unwrap();
    assert!(fs::read_to_string(dir.join(".laci.md")).unwrap().contains("first"));
    activity::undo_activity(&env, first["id"].as_str().unwrap(), "app").unwrap();
    assert!(!fs::read_to_string(dir.join(".laci.md")).unwrap().contains("first"));
}
#[test]
fn project_creation_template_validation_and_sidecar_edits_preserve_other_sections() {
    let (_temp, env) = home();
    let parent = env.home.join("project");
    fs::create_dir(&parent).unwrap();
    write(&env.config_dir.join("templates/docs/README.md"), "# Template\n");
    write(&env.config_dir.join("templates/docs/.git/keep"), "skip");
    write(&env.config_dir.join("templates/docs/nested/.git/keep"), "skip nested git metadata");
    write(&env.config_dir.join("templates/docs/nested/keep.md"), "keep nested content");
    write(&env.config_dir.join("templates/docs/.laci.md"), "---\nstatus: done\n---\n");
    let made=create::create_project(&env,&json!({"name":"docs","parent":parent,"from":"template","template":"docs","summary":"A   project","remote":"none"})).unwrap();
    let dir = Path::new(made["path"].as_str().unwrap());
    assert_eq!(fs::read_to_string(dir.join("README.md")).unwrap(), "# Template\n");
    assert!(!dir.join(".git/keep").exists());
    assert!(!dir.join("nested/.git").exists());
    assert_eq!(fs::read_to_string(dir.join("nested/keep.md")).unwrap(), "keep nested content");
    let tracked = Command::new("git").args(["ls-files", "--", ".laci.md"]).current_dir(dir).output().unwrap();
    assert!(tracked.status.success());
    assert!(tracked.stdout.is_empty(), "A template's private sidecar must stay out of the initial commit");
    assert!(fs::read_to_string(dir.join(".git/info/exclude")).unwrap().contains(".laci.md"));
    sidecar::set_meta(dir, "priority", "high").unwrap();
    sidecar::add_next(dir, "Write **docs**").unwrap();
    sidecar::set_notes(dir, "Keep this\n").unwrap();
    sidecar::toggle_check(&dir.join(".laci.md"), 999, "Write docs", true).unwrap();
    let body = fs::read_to_string(dir.join(".laci.md")).unwrap();
    assert!(body.contains("## Summary\n\nA project"));
    assert!(body.contains("- [x] Write **docs**"));
    assert!(body.contains("priority: high"));
    assert!(sidecar::set_meta(dir, "deadline", "not-a-date").is_err());
    assert!(create::create_project(&env, &json!({"name":"../escape","parent":parent,"from":"empty"})).is_err());
}

#[test]
fn merging_history_restores_both_source_and_existing_destination() {
    let (_temp, env) = home();
    let (snap, from, to, store, original) = fixture(&env);
    let target = store.parent().unwrap().join(paths::enc(&to.to_string_lossy()));
    write(&target.join("session.jsonl"), "{\"cwd\":\"existing-project\"}\n");
    let j = ops::move_project(&env, &snap, "demo", to.to_str().unwrap(), &json!({})).unwrap();
    assert_eq!(fs::read_to_string(target.join("session.jsonl")).unwrap(), "{\"cwd\":\"existing-project\"}\n");
    assert!(!store.exists());
    ops::undo(&env, j["id"].as_str().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(store.join("session.jsonl")).unwrap(), original);
    assert_eq!(fs::read_to_string(target.join("session.jsonl")).unwrap(), "{\"cwd\":\"existing-project\"}\n");
    assert!(from.is_dir());
    assert!(!to.exists());
}
#[test]
fn tampered_journal_and_task_undo_cannot_edit_outside_home_or_project() {
    let (temp, env) = home();
    let project = env.home.join("project");
    fs::create_dir(&project).unwrap();
    let external = temp.path().join("secret");
    write(&external, "keep external\n");
    let backup = env.data_dir.join("backup/test/1-secret");
    write(&backup, "replacement\n");
    write(
        &env.data_dir.join("journal/tampered.json"),
        &json!({"id":"tampered","state":"applied","entries":[{"kind":"rewrite","path":external,"backup":backup}]})
            .to_string(),
    );
    assert!(ops::undo(&env, "tampered").is_err());
    assert_eq!(fs::read_to_string(&external).unwrap(), "keep external\n");
    let sibling = env.home.join("other.md");
    write(&sibling, "- [ ] keep sibling\n");
    let a = activity::record(
        &env,
        json!({"by":"app","title":"Bad task undo","path":project,"undo":{"type":"check","file":"../other.md","text":"keep sibling","done":true}}),
    );
    assert!(activity::undo_activity(&env, a["id"].as_str().unwrap(), "app").is_err());
    assert_eq!(fs::read_to_string(sibling).unwrap(), "- [ ] keep sibling\n");
}
#[test]
fn history_backup_is_incremental_preserves_time_and_ignores_links() {
    let (temp, env) = home();
    let store = env.home.join(".codex/sessions");
    let source = store.join("year/session.jsonl");
    write(&source, "original log\n");
    stamp(&source);
    let external = temp.path().join("secret.jsonl");
    write(&external, "external secret\n");
    support::link_file(&external, &store.join("linked.jsonl"));
    let snap = json!({"connectors":[{"id":"codex","link":{"kind":"cwd","dir":store}}]});
    let first = ops::backup_history(&env, &snap).unwrap();
    assert_eq!(first["copied"], 1);
    let dest = env.data_dir.join("history/codex/year/session.jsonl");
    assert_eq!(fs::read_to_string(&dest).unwrap(), "original log\n");
    assert_eq!(fs::metadata(&dest).unwrap().modified().unwrap(), fs::metadata(&source).unwrap().modified().unwrap());
    assert!(!env.data_dir.join("history/codex/linked.jsonl").exists());
    assert_eq!(ops::backup_history(&env, &snap).unwrap()["copied"], 0);
    write(&source, "a longer changed log\n");
    assert_eq!(ops::backup_history(&env, &snap).unwrap()["copied"], 1);
    assert_eq!(fs::read_to_string(dest).unwrap(), "a longer changed log\n");
}
