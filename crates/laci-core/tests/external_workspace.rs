//! Explicit workspace selection must not grant access to adjacent disk paths or symlink targets.
use laci_core::{activity, config, env::Env, ops, paths, service::Service};
use serde_json::json;
use std::{fs, path::Path};

mod support;

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn external_selection_allows_only_selected_paths_and_rejects_symlink_escapes() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let disk = temp.path().join("disk");
    let unrelated = temp.path().join("private");
    for dir in [&env.home, &disk, &unrelated] {
        fs::create_dir_all(dir).unwrap();
    }
    assert!(paths::workspace_path(disk.to_str().unwrap(), &env).is_err());
    let roots = config::validate_roots(&env, &json!([disk])).unwrap();
    config::save(&env, &json!({"roots":roots,"presets":[]})).unwrap();
    assert_eq!(
        paths::workspace_path(disk.join("project/new").to_str().unwrap(), &env).unwrap(),
        disk.join("project/new")
    );
    assert!(paths::workspace_path(unrelated.to_str().unwrap(), &env).is_err());
    assert!(paths::home_path(disk.to_str().unwrap(), &env).is_err());
    assert!(
        config::validate_connector(&env, &json!({"name":"External store","link":{"kind":"cwd","dir":disk}})).is_err()
    );
    support::link_dir(&unrelated, &disk.join("escape"));
    assert!(paths::workspace_path(disk.join("escape/missing/file").to_str().unwrap(), &env).is_err());
    support::unlink_dir(&disk.join("escape"));
    fs::remove_dir(&disk).unwrap();
    support::link_dir(&unrelated, &disk);
    assert!(paths::workspace_path(disk.join("missing").to_str().unwrap(), &env).is_err());
}

#[test]
fn configured_external_archive_matches_preview_scan_and_undo() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let disk = temp.path().join("disk");
    let archive = temp.path().join("cold-storage");
    let project = disk.join("demo");
    write(&project.join("package.json"), "{\"name\":\"demo\"}");
    write(&project.join(".laci.md"), "---\nstatus: active\n---\n\n## Notes\n\noriginal\n");
    fs::create_dir_all(&env.home).unwrap();
    fs::create_dir_all(&archive).unwrap();
    config::save(&env, &json!({"roots":config::validate_roots(&env,&json!([disk])).unwrap(),"presets":[],"archiveDir":config::validate_archive_dir(&env,&json!(archive)).unwrap()})).unwrap();
    let mut service = Service::new(env.clone());
    let snapshot = service.snapshot().unwrap();
    let id = project.to_str().unwrap();
    assert!(snapshot["nodes"][id].is_object());
    let dest = archive.join("demo");
    let plan = service.request("archive/plan", &json!({"id":id})).unwrap();
    assert_eq!(plan["dest"], json!(dest));
    assert_eq!(snapshot["nodes"][id]["archivePlan"]["dest"], plan["dest"]);
    let change = service.request("archive", &json!({"id":id,"destination":plan["dest"]})).unwrap();
    assert!(!project.exists());
    assert!(dest.join("package.json").is_file());
    let refreshed = service.snapshot().unwrap();
    assert_eq!(refreshed["nodes"][dest.to_str().unwrap()]["archived"], true);
    assert_eq!(refreshed["nodes"][dest.to_str().unwrap()]["status"]["value"], "archived");
    service.request("undo", &json!({"id":change["journal"]["id"]})).unwrap();
    assert!(project.join("package.json").is_file());
    assert!(!dest.exists());
    assert!(fs::read_to_string(project.join(".laci.md")).unwrap().contains("status: active"));
    assert!(
        service.request("archive/plan", &json!({"id":id,"destination":temp.path().join("unselected/demo")})).is_err()
    );
    support::link_dir(temp.path(), &archive.join("escape"));
    assert!(
        service.request("archive/plan", &json!({"id":id,"destination":archive.join("escape/missing/demo")})).is_err()
    );
}

#[test]
fn archive_setting_is_optional_and_undo_restores_it() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let root = env.home.join("projects");
    let archive = temp.path().join("archive");
    write(&root.join("demo/package.json"), "{}");
    fs::create_dir_all(&archive).unwrap();
    config::save(&env, &json!({"roots":[root],"presets":[],"apps":{},"archiveDir":archive})).unwrap();
    let mut service = Service::new(env.clone());
    service.request("setup/save", &json!({"roots":[root],"presets":[],"apps":{}})).unwrap();
    assert_eq!(service.request("setup/info", &json!({})).unwrap()["archiveDir"], json!(archive));
    service.request("setup/save", &json!({"roots":[root],"presets":[],"apps":{},"archiveDir":""})).unwrap();
    assert_eq!(config::load(&env)["archiveDir"], "");
    let entry =
        activity::read_log(&env, 100).into_iter().find(|e| e["key"] == "settings" && e["canUndo"] == true).unwrap();
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert_eq!(config::load(&env)["archiveDir"], json!(archive));
}

#[test]
fn one_off_archive_keeps_only_chosen_project_visible_and_undo_restores_config_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let source = env.home.join("projects/research");
    let destination = env.home.join("cold/research");
    write(&source.join("README.md"), "# Research\nExisting documentation\n");
    let original = b"{ \"roots\": [\"~/projects\"], \"presets\": [] }\n";
    fs::create_dir_all(&env.config_dir).unwrap();
    fs::write(env.config_dir.join("config.json"), original).unwrap();
    let mut service = Service::new(env.clone());
    let id = source.to_str().unwrap();
    let plan = service.request("archive/plan", &json!({"id":id,"destination":destination})).unwrap();
    assert_eq!(plan["dest"], json!(destination));
    assert_eq!(fs::read(env.config_dir.join("config.json")).unwrap(), original);
    let change = service.request("archive", &json!({"id":id,"destination":destination})).unwrap();
    assert!(config::load(&env)["roots"].as_array().unwrap().contains(&json!("~/cold/research")));
    assert!(!config::load(&env)["roots"].as_array().unwrap().contains(&json!("~/cold")));
    let snap = service.snapshot().unwrap();
    assert_eq!(snap["nodes"][destination.to_str().unwrap()]["kind"], "project");
    assert_eq!(snap["nodes"][destination.to_str().unwrap()]["archived"], true);
    service.request("undo", &json!({"id":change["journal"]["id"]})).unwrap();
    assert_eq!(fs::read(env.config_dir.join("config.json")).unwrap(), original);
    assert!(source.join("README.md").is_file());
    assert!(!destination.exists());
}

#[test]
fn archive_undo_does_not_overwrite_later_settings() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let source = env.home.join("projects/demo");
    let destination = env.home.join("cold/demo");
    write(&source.join("package.json"), "{}");
    config::save(&env, &json!({"roots":["~/projects"],"presets":[]})).unwrap();
    let mut service = Service::new(env.clone());
    let change = service.request("archive", &json!({"id":source,"destination":destination})).unwrap();
    let mut later = config::load(&env);
    later["theme"] = json!("dark");
    config::save(&env, &later).unwrap();
    let saved = fs::read(env.config_dir.join("config.json")).unwrap();
    assert!(service.request("undo", &json!({"id":change["journal"]["id"]})).is_err());
    assert_eq!(fs::read(env.config_dir.join("config.json")).unwrap(), saved);
    assert!(destination.join("package.json").exists());
    assert!(!source.exists());
}

#[test]
fn external_project_history_and_notes_survive_archive_and_undo() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let root = temp.path().join("disk");
    let source = root.join("demo");
    let archive = temp.path().join("saved");
    fs::create_dir_all(&archive).unwrap();
    write(&source.join("package.json"), "{}");
    write(&source.join(".aider.chat.history.md"), "Existing inside history\n");
    write(&source.join(".laci.md"), "## Notes\n\nOriginal notes\n");
    let claude = env.home.join(".claude/projects").join(paths::enc(source.to_str().unwrap())).join("session.jsonl");
    let codex = env.home.join(".codex/sessions/session.jsonl");
    write(&claude, &format!("{}\n", json!({"cwd":source,"type":"ai-title","aiTitle":"External project"})));
    write(&codex, &format!("{}\n", json!({"type":"session_meta","payload":{"cwd":source}})));
    config::save(&env, &json!({"roots":[root],"archiveDir":archive,"presets":["claude","codex","aider"]})).unwrap();
    let mut service = Service::new(env.clone());
    let id = source.to_str().unwrap();
    let snap = service.snapshot().unwrap();
    assert_eq!(snap["nodes"][id]["agents"]["claude"].as_array().unwrap().len(), 1);
    assert_eq!(snap["nodes"][id]["agents"]["items"].as_array().unwrap().len(), 2);
    service.request("notes", &json!({"id":id,"text":"Edited notes"})).unwrap();
    let note = activity::read_log(&env, 100).into_iter().find(|e| e["key"] == format!("notes:{id}")).unwrap();
    service.request("log/undo", &json!({"id":note["id"]})).unwrap();
    assert!(fs::read_to_string(source.join(".laci.md")).unwrap().contains("Original notes"));
    let changed = service.request("archive", &json!({"id":id})).unwrap();
    let dest = archive.join("demo");
    let snap = service.snapshot().unwrap();
    let archived = &snap["nodes"][dest.to_str().unwrap()];
    assert_eq!(archived["agents"]["claude"].as_array().unwrap().len(), 1);
    assert_eq!(archived["agents"]["items"].as_array().unwrap().len(), 2);
    assert!(fs::read_to_string(&codex).unwrap().contains(dest.to_str().unwrap()));
    assert!(!claude.exists());
    service.request("undo", &json!({"id":changed["journal"]["id"]})).unwrap();
    assert!(claude.is_file());
    assert!(fs::read_to_string(&codex).unwrap().contains(id));
    assert!(source.join(".aider.chat.history.md").is_file());
}

fn exact_root_fixture() -> (tempfile::TempDir, Env, std::path::PathBuf, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let source = temp.path().join("disk/demo");
    let archive = temp.path().join("archive");
    write(&source.join("package.json"), "{}");
    fs::create_dir_all(&archive).unwrap();
    config::save(&env, &json!({"roots":[source],"archiveDir":archive,"presets":[]})).unwrap();
    (temp, env, source, archive)
}

#[test]
fn replaced_standalone_archive_identity_blocks_preview_and_execution() {
    let (_temp, env, source, archive) = exact_root_fixture();
    let mut service = Service::new(env.clone());
    service.request("setup/save", &json!({"roots":[source],"archiveDir":archive,"presets":[]})).unwrap();
    let cfg = config::load(&env);
    assert_eq!(cfg["roots"], json!([source]));
    assert!(cfg["rootIdentities"][archive.to_str().unwrap()].is_object());
    let original_config = fs::read(env.config_dir.join("config.json")).unwrap();
    fs::rename(&archive, archive.with_extension("original")).unwrap();
    write(&archive.join("keep.txt"), "replacement contents");

    let statuses = laci_core::scan::root_status(&env, &cfg);
    assert_eq!(statuses.iter().find(|status| status["path"] == json!(archive)).unwrap()["available"], false);
    for body in [json!({"id":source}), json!({"id":source,"destination":archive.join("demo")})] {
        for action in ["archive/plan", "archive"] {
            assert!(service.request(action, &body).unwrap_err().contains("select it again"));
        }
    }
    assert_eq!(fs::read_to_string(source.join("package.json")).unwrap(), "{}");
    assert_eq!(fs::read_to_string(archive.join("keep.txt")).unwrap(), "replacement contents");
    assert!(!archive.join("demo").exists());
    assert_eq!(fs::read(env.config_dir.join("config.json")).unwrap(), original_config);
    assert!(ops::journals(&env, 10).is_empty());
}

#[test]
fn archive_rechecks_a_replaced_destination_after_preview_and_inside_the_transaction() {
    let (_temp, env, source, archive) = exact_root_fixture();
    let mut service = Service::new(env.clone());
    service.request("setup/save", &json!({"roots":[source],"archiveDir":archive,"presets":[]})).unwrap();
    let preview = service.request("archive/plan", &json!({"id":source})).unwrap();
    let snapshot = service.snapshot().unwrap();
    fs::rename(&archive, archive.with_extension("original")).unwrap();
    fs::create_dir(&archive).unwrap();
    assert!(
        service
            .request("archive", &json!({"id":source,"destination":preview["dest"]}))
            .unwrap_err()
            .contains("select it again")
    );
    // Exercise the locked mutation independently of archive_plan's validation.
    let error = ops::move_project(
        &env,
        &snapshot,
        source.to_str().unwrap(),
        preview["dest"].as_str().unwrap(),
        &json!({"status":"archived"}),
    )
    .unwrap_err();
    assert!(error.contains("select it again"));
    let journals = ops::journals(&env, 10);
    assert_eq!(journals.len(), 1);
    assert_eq!(journals[0]["state"], "undone");
    assert_eq!(journals[0]["entries"], json!([]));
    assert!(source.join("package.json").is_file());
    assert!(!source.join(".laci.md").exists());
    assert!(fs::read_dir(&archive).unwrap().next().is_none());
}

#[test]
fn valid_alternative_and_explicit_archive_reselection_authorize_archiving() {
    let (temp, env, source, archive) = exact_root_fixture();
    let alternative = temp.path().join("other-disk");
    fs::create_dir(&alternative).unwrap();
    let mut service = Service::new(env.clone());
    let settings = json!({"roots":[source,alternative],"archiveDir":archive,"presets":[]});
    service.request("setup/save", &settings).unwrap();
    let identity = config::load(&env)["rootIdentities"][archive.to_str().unwrap()].clone();
    fs::rename(&archive, archive.with_extension("original")).unwrap();
    fs::create_dir(&archive).unwrap();
    service.request("setup/save", &settings).unwrap();
    assert_eq!(config::load(&env)["rootIdentities"][archive.to_str().unwrap()], identity);
    assert!(service.request("archive/plan", &json!({"id":source})).is_err());

    for destination in [alternative.join("demo"), env.home.join("cold/demo")] {
        let plan = service.request("archive/plan", &json!({"id":source,"destination":destination})).unwrap();
        assert_eq!(plan["dest"], json!(destination));
        let changed = service.request("archive", &json!({"id":source,"destination":destination})).unwrap();
        assert!(destination.join("package.json").is_file());
        assert!(!source.exists());
        service.request("undo", &json!({"id":changed["journal"]["id"]})).unwrap();
        assert!(source.join("package.json").is_file());
        assert!(!destination.exists());
    }

    service.request("setup/save", &json!({"roots":[source,alternative],"archiveDir":"","presets":[]})).unwrap();
    assert!(config::load(&env)["rootIdentities"].get(archive.to_str().unwrap()).is_none());
    service.request("setup/save", &settings).unwrap();
    assert_ne!(config::load(&env)["rootIdentities"][archive.to_str().unwrap()], identity);
    let changed = service.request("archive", &json!({"id":source})).unwrap();
    assert!(archive.join("demo/package.json").is_file());
    service.request("undo", &json!({"id":changed["journal"]["id"]})).unwrap();
    assert!(source.join("package.json").is_file());
}

#[test]
fn nested_archive_selection_checks_its_identity_even_when_scan_roots_are_deduplicated() {
    let (temp, env, source, _) = exact_root_fixture();
    let root = temp.path().join("saved-disk");
    let archive = root.join("archive");
    fs::create_dir_all(&archive).unwrap();
    let mut service = Service::new(env.clone());
    service.request("setup/save", &json!({"roots":[source,root],"archiveDir":archive,"presets":[]})).unwrap();
    fs::rename(&archive, archive.with_extension("original")).unwrap();
    fs::create_dir(&archive).unwrap();
    let statuses = laci_core::scan::root_status(&env, &config::load(&env));
    assert!(statuses.iter().all(|status| status["available"] == true));
    assert!(!statuses.iter().any(|status| status["path"] == json!(archive)));
    for action in ["archive/plan", "archive"] {
        assert!(service.request(action, &json!({"id":source})).unwrap_err().contains("select it again"));
    }
    let destination = root.join("alternative/demo");
    let changed = service.request("archive", &json!({"id":source,"destination":destination})).unwrap();
    assert!(destination.join("package.json").is_file());
    service.request("undo", &json!({"id":changed["journal"]["id"]})).unwrap();
    assert!(source.join("package.json").is_file());
}

#[test]
fn archive_destination_requires_the_recorded_filesystem_device() {
    let (_temp, env, source, archive) = exact_root_fixture();
    let mut service = Service::new(env.clone());
    service.request("setup/save", &json!({"roots":[source],"archiveDir":archive,"presets":[]})).unwrap();
    let mut cfg = config::load(&env);
    let device = &mut cfg["rootIdentities"][archive.to_str().unwrap()]["device"];
    *device = json!(device.as_u64().unwrap().wrapping_add(1));
    config::save(&env, &cfg).unwrap();
    for action in ["archive/plan", "archive"] {
        assert!(service.request(action, &json!({"id":source})).unwrap_err().contains("select it again"));
    }
    assert!(source.join("package.json").is_file());
    assert!(fs::read_dir(&archive).unwrap().next().is_none());
}

#[test]
fn exact_external_project_root_can_be_restored_after_archive() {
    let (_temp, env, source, archive) = exact_root_fixture();
    let mut service = Service::new(env.clone());
    let changed = service.request("archive", &json!({"id":source})).unwrap();
    assert!(
        paths::workspace_path(source.to_str().unwrap(), &env).is_err(),
        "ordinary access must still reject a missing external root"
    );
    service.request("undo", &json!({"id":changed["journal"]["id"]})).unwrap();
    assert!(source.join("package.json").is_file());
    assert!(!archive.join("demo").exists());
}

#[test]
fn failed_archive_step_rolls_back_an_exact_external_project_root() {
    let (_temp, env, source, archive) = exact_root_fixture();
    let mut service = Service::new(env.clone());
    let mut snap = service.snapshot().unwrap();
    snap["nodes"][source.to_str().unwrap()]["size"]["parts"] = json!([{"path":"../escape"}]);
    let error = laci_core::ops::archive_project_to(&env, &snap, source.to_str().unwrap(), None, true).unwrap_err();
    assert!(error.contains("Invalid heavy folder"));
    assert!(source.join("package.json").is_file());
    assert!(!source.join(".laci.md").exists());
    assert!(!archive.join("demo").exists());
    assert_eq!(laci_core::ops::journals(&env, 1)[0]["state"], "undone");
}

#[test]
fn exact_root_restore_refuses_a_replaced_parent_or_symlink() {
    let (temp, env, source, archive) = exact_root_fixture();
    let mut service = Service::new(env.clone());
    let changed = service.request("archive", &json!({"id":source})).unwrap();
    let parent = source.parent().unwrap();
    let original = temp.path().join("original-disk");
    fs::rename(parent, &original).unwrap();
    fs::create_dir(parent).unwrap();
    assert!(service.request("undo", &json!({"id":changed["journal"]["id"]})).is_err());
    assert!(archive.join("demo/package.json").is_file());
    assert!(!source.exists());
    fs::remove_dir(parent).unwrap();
    support::link_dir(&original, parent);
    assert!(service.request("undo", &json!({"id":changed["journal"]["id"]})).is_err());
    support::unlink_dir(parent);
    fs::rename(original, parent).unwrap();
    service.request("undo", &json!({"id":changed["journal"]["id"]})).unwrap();
    assert!(source.join("package.json").is_file());
}

#[test]
fn one_off_archive_honors_an_external_xdg_config_directory_without_granting_workspace_access() {
    let temp = tempfile::tempdir().unwrap();
    let mut env = Env::for_home(temp.path().join("home"));
    env.config_dir = temp.path().join("xdg/laci");
    let source = env.home.join("projects/demo");
    let destination = env.home.join("cold/demo");
    write(&source.join("package.json"), "{}");
    let original = b"{ \"roots\": [\"~/projects\"], \"presets\": [] }\n";
    fs::create_dir_all(&env.config_dir).unwrap();
    fs::write(env.config_dir.join("config.json"), original).unwrap();
    let mut service = Service::new(env.clone());
    let changed = service.request("archive", &json!({"id":source,"destination":destination})).unwrap();
    assert!(paths::workspace_path(env.config_dir.to_str().unwrap(), &env).is_err());
    service.request("undo", &json!({"id":changed["journal"]["id"]})).unwrap();
    assert_eq!(fs::read(env.config_dir.join("config.json")).unwrap(), original);
    assert!(source.join("package.json").is_file());
    assert!(!destination.exists());
}

#[test]
fn exact_root_restore_requires_the_recorded_filesystem_device() {
    let (_temp, env, source, archive) = exact_root_fixture();
    let mut service = Service::new(env.clone());
    let changed = service.request("archive", &json!({"id":source})).unwrap();
    let mut journal = changed["journal"].clone();
    let entry =
        journal["entries"].as_array_mut().unwrap().iter_mut().find(|entry| entry["from"] == json!(source)).unwrap();
    entry["parentDevice"] = json!(entry["parentDevice"].as_u64().unwrap().wrapping_add(1));
    let file = env.data_dir.join("journal").join(format!("{}.json", journal["id"].as_str().unwrap()));
    fs::write(file, serde_json::to_vec(&journal).unwrap()).unwrap();
    assert!(service.request("undo", &json!({"id":journal["id"]})).unwrap_err().contains("disk or parent"));
    assert!(archive.join("demo/package.json").is_file());
    assert!(!source.exists());
}

#[test]
fn config_journal_scope_cannot_restore_a_neighboring_file() {
    let temp = tempfile::tempdir().unwrap();
    let mut env = Env::for_home(temp.path().join("home"));
    env.config_dir = temp.path().join("xdg/laci");
    let source = env.home.join("projects/demo");
    let destination = env.home.join("cold/demo");
    let unrelated = env.config_dir.join("other.json");
    write(&source.join("package.json"), "{}");
    write(&unrelated, "untouched\n");
    config::save(&env, &json!({"roots":["~/projects"],"presets":[]})).unwrap();
    let mut service = Service::new(env.clone());
    let changed = service.request("archive", &json!({"id":source,"destination":destination})).unwrap();
    let saved = fs::read(env.config_dir.join("config.json")).unwrap();
    let mut journal = changed["journal"].clone();
    let entry = journal["entries"].as_array_mut().unwrap().iter_mut().find(|entry| entry["scope"] == "config").unwrap();
    entry["path"] = json!(unrelated);
    let file = env.data_dir.join("journal").join(format!("{}.json", journal["id"].as_str().unwrap()));
    fs::write(file, serde_json::to_vec(&journal).unwrap()).unwrap();
    assert!(service.request("undo", &json!({"id":journal["id"]})).unwrap_err().contains("configuration journal path"));
    assert_eq!(fs::read_to_string(unrelated).unwrap(), "untouched\n");
    assert_eq!(fs::read(env.config_dir.join("config.json")).unwrap(), saved);
    assert!(destination.join("package.json").is_file());
    assert!(!source.exists());
}

#[test]
fn projects_containing_laci_config_or_cache_cannot_be_archived_or_moved() {
    for folder in [".config", ".cache"] {
        let temp = tempfile::tempdir().unwrap();
        let env = Env::for_home(temp.path().join("home"));
        let source = env.home.join(folder);
        let destination = env.home.join("cold/owned");
        write(&source.join("package.json"), "{}");
        config::save(&env, &json!({"roots":[source],"presets":[],"theme":"dark","apps":{"editor":"code"}})).unwrap();
        let original = fs::read(env.config_dir.join("config.json")).unwrap();
        let mut service = Service::new(env.clone());
        assert!(
            service
                .request("archive", &json!({"id":source,"destination":destination}))
                .unwrap_err()
                .contains("Laci's settings")
        );
        assert!(service.request("move", &json!({"id":source,"destination":destination})).is_err());
        assert!(source.join("package.json").is_file());
        assert!(!destination.exists());
        assert_eq!(fs::read(env.config_dir.join("config.json")).unwrap(), original);
        assert!(laci_core::ops::journals(&env, 10).is_empty());
    }
}

#[test]
fn move_destinations_cannot_enter_laci_owned_directories() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let source = env.home.join("project/demo");
    write(&source.join("package.json"), "{}");
    config::save(&env, &json!({"roots":["~/project"],"presets":[]})).unwrap();
    let mut service = Service::new(env.clone());
    for owned in [&env.config_dir, &env.data_dir, &env.cache_dir] {
        let destination = owned.join("misplaced-project");
        assert!(service.request("move", &json!({"id":source,"destination":destination})).is_err());
        assert!(!destination.exists());
    }
    assert!(source.join("package.json").is_file());
    assert!(laci_core::ops::journals(&env, 10).is_empty());
}
