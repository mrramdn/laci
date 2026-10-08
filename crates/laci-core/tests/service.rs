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

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn fixture() -> (tempfile::TempDir, Env, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let project = env.home.join("project/demo");
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
    assert!(outcome.value.get("snapshot").is_none());
    assert!(outcome.refresh.agents && !outcome.refresh.full);
    assert!(!history.exists());
    assert_eq!(service.current.as_ref().unwrap()["scannedAt"], snapshot["scannedAt"]);
    assert!(service.current.as_ref().unwrap()["proposals"].as_array().unwrap().is_empty());
    let restored = service.request_as("undo", &json!({"id":outcome.value["journal"]["id"]}), "agent").unwrap();
    assert!(restored["snapshot"].is_object());
    assert_eq!(restored["journal"]["state"], "undone");
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

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}
#[cfg(unix)]
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
#[cfg(unix)]
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

#[cfg(unix)]
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
    assert!(entry["detail"].as_str().unwrap().starts_with("1 session kept · "));

    service.request("backup", &json!({})).unwrap();
    assert_eq!(activity::read_log(&env, 10)[0]["title"], "Agent history backup is up to date");

    std::thread::sleep(std::time::Duration::from_millis(20));
    write(&session, &format!("{}\n{}\n", json!({"type":"user","cwd":project,"sessionId":"s1"}), json!({"more":1})));
    service.request("backup/auto", &json!({"on":true})).unwrap();
    let snap = service.rescan().unwrap();
    assert_eq!((&snap["backup"]["pending"], &snap["backup"]["auto"]), (&json!(1), &json!(true)));
    let warning = snap["warnings"].as_array().unwrap().iter().find(|w| w["code"] == "claude-cleanup").unwrap();
    assert!(warning["detail"].as_str().unwrap().ends_with("1 session has changed since the last backup."));
    // An automatic run waits an hour after the last one, however much has changed.
    assert_eq!(service.request("backup", &json!({"auto":true})).unwrap(), json!({"skipped":true}));
}
