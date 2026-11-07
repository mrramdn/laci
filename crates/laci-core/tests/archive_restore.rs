//! The archive folder keeps each project below the scan location it came from, and Restore puts it back.
use laci_core::{activity, config, env::Env, paths, service::Service, sidecar};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

mod support;

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
/// Scan locations ~/project and ~/tugas, and an archive folder on another disk.
fn fixture() -> (support::TempDir, Env, PathBuf) {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let archive = temp.path().join("archive");
    fs::create_dir_all(&archive).unwrap();
    fs::create_dir_all(env.home.join("project")).unwrap();
    fs::create_dir_all(env.home.join("tugas")).unwrap();
    config::save(&env, &json!({"roots":["~/project","~/tugas"],"presets":["claude"],"archiveDir":archive})).unwrap();
    (temp, env, archive)
}
fn store(env: &Env, dir: &Path) -> PathBuf {
    env.home.join(".claude/projects").join(paths::enc(&dir.to_string_lossy()))
}
fn session(cwd: &Path) -> String {
    format!("{}\n", json!({"type":"user","cwd":cwd}))
}
fn sidecar_text(dir: &Path) -> String {
    fs::read_to_string(dir.join(".laci.md")).unwrap()
}

#[test]
fn archive_keeps_the_place_below_its_scan_location_and_restore_puts_it_back() {
    let (_temp, env, archive) = fixture();
    let project = env.home.join("tugas").join("venture-creation").join("pet-pals-project");
    write(&project.join("package.json"), "{}");
    write(&store(&env, &project).join("first.jsonl"), &session(&project));
    let mut service = Service::new(env.clone());
    let id = project.to_str().unwrap();
    let snap = service.snapshot().unwrap();
    let dest = archive.join("tugas").join("venture-creation").join("pet-pals-project");
    assert_eq!(snap["nodes"][id]["inArchive"], false);
    assert_eq!(snap["nodes"][id]["archivePlan"]["dest"], json!(dest));
    assert!(snap["nodes"][id]["restorePlan"].is_null());

    let archived = service.request("archive", &json!({"id":id})).unwrap();
    assert!(!project.exists());
    assert!(dest.join("package.json").is_file());
    let text = sidecar_text(&dest);
    assert!(text.contains("status: archived"), "{text}");
    assert!(text.contains("archivedFrom: ~/tugas/venture-creation/pet-pals-project"), "{text}");
    let at = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert!(text.contains(&format!("archivedAt: {at}")), "{text}");

    // An agent worked in the project while it was in the archive.
    write(&store(&env, &dest).join("later.jsonl"), &session(&dest));
    let snap = service.rescan().unwrap();
    let node = &snap["nodes"][dest.to_str().unwrap()];
    assert_eq!(node["inArchive"], true);
    assert_eq!(node["archived"], true);
    assert!(node["archivePlan"].is_null(), "a project in the archive isn't archived again");
    assert_eq!(node["restorePlan"]["dest"], json!(project));
    assert!(node["restorePlan"]["ops"].as_array().unwrap().iter().any(|op| op["label"] == "Clear status: archived"));

    let restored = service.request("restore", &json!({"id":dest})).unwrap();
    assert!(project.join("package.json").is_file());
    assert!(!dest.exists());
    let text = sidecar_text(&project);
    for key in ["status:", "archivedFrom:", "archivedAt:"] {
        assert!(!text.contains(key), "{text}");
    }
    for file in ["first.jsonl", "later.jsonl"] {
        assert_eq!(fs::read_to_string(store(&env, &project).join(file)).unwrap(), session(&project), "{file}");
    }
    assert!(!store(&env, &dest).exists());
    assert_eq!(
        activity::read_log(&env, 5)[0]["say"],
        json!({"form":"restored","name":"pet-pals-project","to":"~/tugas/venture-creation/pet-pals-project"})
    );
    let snap = service.snapshot().unwrap();
    assert_eq!(snap["nodes"][id]["archived"], false);
    assert!(snap["nodes"][id]["restorePlan"].is_null());

    service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap();
    assert!(!project.exists());
    assert!(dest.join("package.json").is_file());
    assert!(sidecar_text(&dest).contains("archivedFrom: ~/tugas/venture-creation/pet-pals-project"));
    assert_eq!(fs::read_to_string(store(&env, &dest).join("later.jsonl")).unwrap(), session(&dest));

    service.request("undo", &json!({"id":archived["journal"]["id"]})).unwrap();
    assert!(project.join("package.json").is_file());
    assert!(!project.join(".laci.md").exists());
    assert_eq!(fs::read_to_string(store(&env, &project).join("first.jsonl")).unwrap(), session(&project));
}

#[test]
fn restore_finds_the_origin_from_the_archive_layout_and_refuses_an_occupied_place() {
    let (temp, env, archive) = fixture();
    let archived = archive.join("tugas").join("course").join("old");
    write(&archived.join("package.json"), "{}");
    let loose = archive.join("loose");
    write(&loose.join("package.json"), "{}");
    let origin = env.home.join("tugas").join("course").join("old");
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let id = archived.to_str().unwrap();
    assert_eq!(snap["nodes"][id]["inArchive"], true);
    assert_eq!(snap["nodes"][id]["restorePlan"]["dest"], json!(origin));
    let unknown = &snap["nodes"][loose.to_str().unwrap()]["restorePlan"];
    let error = unknown["error"].as_str().unwrap();
    assert!(error.contains("doesn't know where this project came from"), "{error}");
    assert_eq!(unknown["reason"], "unknown");
    assert!(unknown.get("dest").is_none(), "{unknown}");
    assert_eq!((&unknown["ops"], &unknown["checks"]), (&json!([]), &json!([])));

    write(&origin.join("keep.txt"), "already here");
    let snap = service.rescan().unwrap();
    let occupied = &snap["nodes"][id]["restorePlan"];
    assert_eq!(
        (&occupied["reason"], &occupied["dest"], &occupied["ops"]),
        (&json!("occupied"), &json!(origin), &json!([]))
    );
    let plan = service.request("restore/plan", &json!({"id":id})).unwrap();
    let error = plan["error"].as_str().unwrap();
    assert!(error.contains("Something is already at ~/tugas/course/old"), "{error}");
    assert_eq!((&plan["reason"], &plan["dest"]), (&json!("occupied"), &json!(origin)));
    let error = service.request("restore", &json!({"id":id})).unwrap_err();
    assert!(error.contains("Something is already at"), "{error}");
    assert!(archived.join("package.json").is_file());
    let elsewhere = archive.join("elsewhere");
    let plan = service.request("restore/plan", &json!({"id":id,"destination":elsewhere})).unwrap();
    assert!(plan["error"].as_str().unwrap().contains("in the archive"), "{plan}");
    assert_eq!((&plan["reason"], &plan["dest"]), (&json!("inArchive"), &json!(elsewhere)));
    let inside = archived.join("sub");
    let plan = service.request("restore/plan", &json!({"id":id,"destination":inside})).unwrap();
    assert_eq!((&plan["reason"], &plan["dest"]), (&json!("inArchive"), &json!(inside)));
    let outside = temp.path().join("outside");
    let plan = service.request("restore/plan", &json!({"id":id,"destination":outside})).unwrap();
    assert_eq!((&plan["reason"], &plan["dest"], &plan["ops"]), (&json!("outside"), &json!(outside), &json!([])));
    assert!(service.request("restore", &json!({"id":id,"destination":outside})).is_err());
    fs::remove_dir_all(&origin).unwrap();

    service.request("restore", &json!({"id":id})).unwrap();
    assert!(origin.join("package.json").is_file());
    assert!(!archived.exists());
    assert!(!origin.join(".laci.md").exists(), "nothing to clear, so nothing is written");

    let chosen = env.home.join("project").join("loose");
    service.request("restore", &json!({"id":loose,"destination":chosen})).unwrap();
    assert!(chosen.join("package.json").is_file());
}

#[test]
fn restore_of_a_project_archived_by_its_status_clears_it_in_place() {
    let (_temp, env, archive) = fixture();
    let project = env.home.join("project").join("paused");
    write(&project.join("package.json"), "{}");
    let original = "---\nstatus: archived\narchivedAt: 2026-01-02\npriority: low\n---\n\n## Notes\n\nkept\n";
    write(&project.join(".laci.md"), original);
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let id = project.to_str().unwrap();
    let node = &snap["nodes"][id];
    assert_eq!((node["archived"].clone(), node["inArchive"].clone()), (json!(true), json!(false)));
    assert_eq!(node["archivePlan"]["dest"], json!(archive.join("project").join("paused")));
    assert_eq!(node["restorePlan"]["dest"], json!(project));

    let restored = service.request("restore", &json!({"id":id})).unwrap();
    let text = sidecar_text(&project);
    assert!(!text.contains("status:") && !text.contains("archivedAt:"), "{text}");
    assert!(text.contains("priority: low") && text.contains("kept"), "{text}");
    assert_eq!(
        activity::read_log(&env, 5)[0]["say"],
        json!({"form":"restored","name":"paused","to":"~/project/paused"})
    );
    assert_eq!(service.snapshot().unwrap()["nodes"][id]["archived"], false);
    service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap();
    assert_eq!(sidecar_text(&project), original);
    assert!(service.request("restore/plan", &json!({"id":env.home.join("project")})).is_err());

    // It stays where it is, so a place to put it is refused rather than ignored.
    let elsewhere = env.home.join("project").join("elsewhere");
    for name in ["restore/plan", "restore"] {
        let error = service.request(name, &json!({"id":id,"destination":elsewhere})).unwrap_err();
        assert!(error.contains("only marked archived; it stays where it is"), "{name}: {error}");
    }
    assert_eq!(sidecar_text(&project), original);
    assert!(!elsewhere.exists());
}

#[test]
fn restore_keeps_a_status_other_than_archived() {
    let (_temp, env, archive) = fixture();
    let archived = archive.join("project").join("kept");
    write(&archived.join("package.json"), "{}");
    write(
        &archived.join(".laci.md"),
        "---\nstatus: paused\narchivedFrom: ~/project/kept\narchivedAt: 2026-01-02\n---\n",
    );
    let mut service = Service::new(env.clone());
    service.snapshot().unwrap();
    service.request("restore", &json!({"id":archived})).unwrap();
    let text = sidecar_text(&env.home.join("project").join("kept"));
    assert!(text.contains("status: paused"), "{text}");
    assert!(!text.contains("archivedFrom") && !text.contains("archivedAt"), "{text}");
}

/// A project archived from ~/tugas/course/demo with a Claude session: the service, the project, the place the
/// archive keeps it and the journal id of the Archive.
fn archived_demo() -> (support::TempDir, Env, Service, PathBuf, PathBuf, String) {
    let (temp, env, archive) = fixture();
    let project = env.home.join("tugas").join("course").join("demo");
    write(&project.join("package.json"), "{}");
    write(&store(&env, &project).join("first.jsonl"), &session(&project));
    let mut service = Service::new(env.clone());
    service.snapshot().unwrap();
    let archived = service.request("archive", &json!({"id":project})).unwrap();
    let dest = archive.join("tugas").join("course").join("demo");
    assert!(dest.join("package.json").is_file());
    let id = archived["journal"]["id"].as_str().unwrap().to_owned();
    (temp, env, service, project, dest, id)
}

#[test]
fn undo_of_a_restore_keeps_a_session_line_or_a_note_added_since() {
    for edited in ["session", "notes"] {
        let (_temp, env, mut service, project, dest, _) = archived_demo();
        let restored = service.request("restore", &json!({"id":dest})).unwrap();
        let file = match edited {
            "session" => store(&env, &project).join("first.jsonl"),
            _ => project.join(".laci.md"),
        };
        let text = fs::read_to_string(&file).unwrap() + "- [ ] a line added after the restore\n";
        fs::write(&file, &text).unwrap();
        let error = service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap_err();
        let name = paths::tilde(&file, &env.home);
        assert!(error.contains(&format!("{name} changed after this")), "{edited}: {error}");
        assert_eq!(fs::read_to_string(&file).unwrap(), text, "{edited}: nothing is lost");
        assert!(project.join("package.json").is_file() && !dest.exists(), "{edited}: nothing moved");
        assert!(store(&env, &project).join("first.jsonl").is_file() && !store(&env, &dest).exists());
    }
}

#[test]
fn undo_of_an_archive_that_was_restored_since_changes_nothing() {
    let (_temp, env, mut service, project, dest, archived) = archived_demo();
    service.request("restore", &json!({"id":dest})).unwrap();
    let before = fs::read_to_string(project.join(".laci.md")).unwrap();
    let error = service.request("undo", &json!({"id":archived})).unwrap_err();
    assert!(error.contains("already reversed by a later one; undo that instead"), "{error}");
    assert!(!dest.exists(), "the archived folder isn't made again");
    assert!(!store(&env, &dest).exists());
    assert!(project.join("package.json").is_file());
    assert_eq!(fs::read_to_string(project.join(".laci.md")).unwrap(), before);
    assert_eq!(fs::read_to_string(store(&env, &project).join("first.jsonl")).unwrap(), session(&project));
}

#[test]
fn a_path_laci_md_would_read_back_otherwise_is_not_kept_as_archived_from() {
    let (_temp, env, archive) = fixture();
    let project = env.home.join("tugas").join("Lab #2").join("demo");
    write(&project.join("package.json"), "{}");
    let mut service = Service::new(env.clone());
    service.snapshot().unwrap();
    service.request("archive", &json!({"id":project})).unwrap();
    let dest = archive.join("tugas").join("Lab #2").join("demo");
    let text = sidecar_text(&dest);
    assert!(text.contains("status: archived") && !text.contains("archivedFrom"), "{text}");
    // The archive's layout still tells where it came from.
    let snap = service.rescan().unwrap();
    assert_eq!(snap["nodes"][dest.to_str().unwrap()]["restorePlan"]["dest"], json!(project));
    let error = sidecar::set_meta(&dest, "archivedFrom", "~/tugas/Lab #2/demo").unwrap_err();
    assert!(error.contains("invalid value"), "{error}");
    for value in ["~/tugas/demo ", "~/tugas/'demo'", "~/tugas/[demo]"] {
        assert!(sidecar::set_meta(&dest, "archivedFrom", value).is_err(), "{value}");
    }
}

#[test]
fn an_archive_named_folder_above_the_scan_location_does_not_count() {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let root = env.home.join("archive").join("work");
    let app = root.join("app");
    write(&app.join("package.json"), "{}");
    let old = root.join("_archive").join("old");
    write(&old.join("package.json"), "{}");
    config::save(&env, &json!({"roots":["~/archive/work"],"presets":["claude"]})).unwrap();
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let node = &snap["nodes"][app.to_str().unwrap()];
    assert_eq!((&node["archived"], &node["inArchive"]), (&json!(false), &json!(false)), "{node}");
    assert!(node["restorePlan"].is_null());
    let node = &snap["nodes"][old.to_str().unwrap()];
    assert_eq!(node["inArchive"], true);
    assert_eq!(node["restorePlan"]["dest"], json!(root.join("old")));
}

#[test]
fn the_archive_fields_of_laci_md_take_a_path_and_a_date() {
    let temp = support::tempdir();
    let dir = temp.path().join("demo");
    fs::create_dir_all(&dir).unwrap();
    for (key, value) in
        [("archivedFrom", "~/project/demo"), ("archivedFrom", "/mnt/disk/demo"), ("archivedAt", "2026-11-07")]
    {
        sidecar::set_meta(&dir, key, value).unwrap();
    }
    for (key, value) in [
        ("archivedFrom", "project/demo"),
        ("archivedFrom", "~/a\nstatus: done"),
        ("archivedAt", "7 Nov"),
        ("archivedAt", "2026-11-7"),
    ] {
        assert!(sidecar::set_meta(&dir, key, value).is_err(), "{key}: {value}");
    }
    let long = format!("/{}", "a".repeat(1024));
    assert!(sidecar::set_meta(&dir, "archivedFrom", &long).is_err());
    sidecar::set_meta(&dir, "archivedFrom", "").unwrap();
    let text = sidecar_text(&dir);
    assert!(!text.contains("archivedFrom") && text.contains("archivedAt: 2026-11-07"), "{text}");
}
