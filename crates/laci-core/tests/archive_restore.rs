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
    let (_temp, env, archive) = fixture();
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
    let error = snap["nodes"][loose.to_str().unwrap()]["restorePlan"]["error"].as_str().unwrap();
    assert!(error.contains("doesn't know where this project came from"), "{error}");

    write(&origin.join("keep.txt"), "already here");
    let error = service.request("restore/plan", &json!({"id":id})).unwrap_err();
    assert!(error.contains("Something is already at ~/tugas/course/old"), "{error}");
    assert!(service.request("restore", &json!({"id":id})).is_err());
    assert!(archived.join("package.json").is_file());
    let error = service.request("restore/plan", &json!({"id":id,"destination":archive.join("elsewhere")})).unwrap_err();
    assert!(error.contains("in the archive"), "{error}");
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
