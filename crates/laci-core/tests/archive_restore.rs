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
    for value in ["~/tugas/demo ", "~/tugas/demo'", "~/tugas/demo\""] {
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

#[test]
fn the_archive_is_looked_through_one_folder_deeper_than_a_scan_location() {
    let (_temp, env, archive) = fixture();
    // Seven folders below the archive, six below ~/project where it came from.
    let deep = archive.join("project/freelance/client/site/web/site/site-wp");
    write(&deep.join("package.json"), "{}");
    let deeper = archive.join("project/a/b/c/d/e/f/g");
    write(&deeper.join("package.json"), "{}");
    let at_home = env.home.join("project/a/b/c/d/e/f");
    write(&at_home.join("package.json"), "{}");
    let too_deep = env.home.join("project/a/b/c/d/e/x/y");
    write(&too_deep.join("package.json"), "{}");
    let snap = Service::new(env.clone()).snapshot().unwrap();
    let node = &snap["nodes"][deep.to_str().unwrap()];
    assert_eq!((&node["kind"], &node["inArchive"]), (&json!("project"), &json!(true)), "{node}");
    assert_eq!(node["restorePlan"]["dest"], json!(env.home.join("project/freelance/client/site/web/site/site-wp")));
    assert!(snap["nodes"][deeper.to_str().unwrap()].is_null(), "eight folders below the archive is too deep");
    assert_eq!(snap["nodes"][at_home.to_str().unwrap()]["kind"], "project");
    assert!(snap["nodes"][too_deep.to_str().unwrap()].is_null(), "other scan locations keep their depth");
}

/// A project moved into the archive by hand from ~/project/gabut/dummy2, with a link left there that leads to it and
/// a Claude session from while it was in the archive.
fn linked_back() -> (support::TempDir, Env, Service, PathBuf, PathBuf) {
    let (temp, env, archive) = fixture();
    let archived = archive.join("project").join("gabut").join("dummy2");
    write(&archived.join("package.json"), "{}");
    write(&store(&env, &archived).join("first.jsonl"), &session(&archived));
    let origin = env.home.join("project").join("gabut").join("dummy2");
    fs::create_dir_all(origin.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&archived, &origin).unwrap();
    let service = Service::new(env.clone());
    (temp, env, service, archived, origin)
}

#[test]
fn restore_removes_the_old_link_to_it_and_undo_makes_the_link_again() {
    let (_temp, env, mut service, archived, origin) = linked_back();
    let snap = service.snapshot().unwrap();
    let id = archived.to_str().unwrap();
    let plan = &snap["nodes"][id]["restorePlan"];
    assert!(plan["error"].is_null(), "{plan}");
    assert_eq!(plan["dest"], json!(origin));
    assert_eq!(
        plan["ops"][0],
        json!({"kind":"unlink","label":"Remove the old link","from":"~/project/gabut/dummy2","to":archived})
    );
    assert_eq!(plan["ops"][1]["kind"], "move", "{plan}");

    let restored = service.request("restore", &json!({"id":id})).unwrap();
    let meta = fs::symlink_metadata(&origin).unwrap();
    assert!(meta.is_dir() && !meta.is_symlink());
    assert!(origin.join("package.json").is_file());
    assert!(!archived.exists());
    assert_eq!(fs::read_to_string(store(&env, &origin).join("first.jsonl")).unwrap(), session(&origin));
    let entry = &restored["journal"]["entries"][0];
    assert_eq!(
        (&entry["kind"], &entry["path"], &entry["target"]),
        (&json!("unlink"), &json!(origin), &json!(archived))
    );
    let log = activity::read_log(&env, 5).remove(0);
    assert_eq!(
        log["steps"][0],
        json!({"kind":"unlink","label":"Removed the old link","from":"~/project/gabut/dummy2","to":archived})
    );
    assert_eq!(log["canUndo"], true);
    let snap = service.snapshot().unwrap();
    assert_eq!(snap["nodes"][origin.to_str().unwrap()]["archived"], false);

    service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap();
    assert!(archived.join("package.json").is_file());
    assert_eq!(fs::read_link(&origin).unwrap(), archived);
    assert_eq!(fs::read_to_string(store(&env, &archived).join("first.jsonl")).unwrap(), session(&archived));
    assert!(!store(&env, &origin).exists());
}

#[test]
fn undo_of_a_restore_refuses_when_something_else_took_the_place_of_the_link() {
    let (_temp, env, mut service, archived, origin) = linked_back();
    service.snapshot().unwrap();
    let restored = service.request("restore", &json!({"id":archived})).unwrap();
    let away = env.home.join("project").join("gabut").join("dummy2-kept");
    fs::rename(&origin, &away).unwrap();
    write(&origin.join("other.txt"), "made since");
    let error = service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap_err();
    assert!(
        error.contains(
            "Something else is at ~/project/gabut/dummy2 since this change, so Undo can't put the old link back"
        ),
        "{error}"
    );
    assert_eq!(fs::read_to_string(origin.join("other.txt")).unwrap(), "made since");
    assert!(away.join("package.json").is_file());
    assert!(!archived.exists());
    assert!(store(&env, &origin).join("first.jsonl").is_file() && !store(&env, &archived).exists());
}

#[test]
fn undo_of_a_restore_leaves_out_the_old_link_once_the_folder_moved_on_by_hand() {
    for via_log in [false, true] {
        let (_temp, env, mut service, archived, origin) = linked_back();
        service.snapshot().unwrap();
        let restored = service.request("restore", &json!({"id":archived})).unwrap();
        let away = env.home.join("project").join("gabut").join("dummy2-kept");
        fs::rename(&origin, &away).unwrap();
        let undone = if via_log {
            let entry = activity::read_log(&env, 5).remove(0);
            service.request("log/undo", &json!({"id":entry["id"]})).unwrap()
        } else {
            service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap()
        };
        assert!(fs::symlink_metadata(&origin).is_err(), "no link that leads nowhere is left at the origin");
        assert!(!archived.exists());
        assert!(away.join("package.json").is_file());
        assert_eq!(
            undone["warnings"],
            json!([format!(
                "The old link at ~/project/gabut/dummy2 isn't back: {}, where it led, is gone",
                paths::tilde(&archived, &env.home)
            )]),
            "{undone}"
        );
        assert!(undone["journal"]["warnings"].is_null(), "{undone}");
    }
}

#[test]
fn a_link_at_the_origin_that_leads_anywhere_else_is_in_the_way() {
    let (_temp, env, archive) = fixture();
    let archived = archive.join("project").join("gabut").join("dummy2");
    write(&archived.join("package.json"), "{}");
    let other = archive.join("project").join("gabut").join("other");
    write(&other.join("keep.txt"), "kept");
    let origin = env.home.join("project").join("gabut").join("dummy2");
    fs::create_dir_all(origin.parent().unwrap()).unwrap();
    let mut service = Service::new(env.clone());
    for target in [other.clone(), env.home.join("nowhere")] {
        let _ = fs::remove_file(&origin);
        std::os::unix::fs::symlink(&target, &origin).unwrap();
        let snap = service.rescan().unwrap();
        let plan = &snap["nodes"][archived.to_str().unwrap()]["restorePlan"];
        assert_eq!((&plan["reason"], &plan["dest"], &plan["ops"]), (&json!("occupied"), &json!(origin), &json!([])));
        assert!(plan["error"].as_str().unwrap().contains("Something is already at ~/project/gabut/dummy2"), "{plan}");
        let error = service.request("restore", &json!({"id":archived})).unwrap_err();
        assert!(error.contains("Something is already at"), "{error}");
        assert_eq!(fs::read_link(&origin).unwrap(), target);
        assert!(archived.join("package.json").is_file());
    }
}

#[test]
fn a_group_linked_back_from_the_archive_goes_back_whole_and_its_projects_not_alone() {
    let (_temp, env, archive) = fixture();
    let group = archive.join("project").join("freelance").join("client").join("ecobiz");
    let (one, two) = (group.join("one"), group.join("two"));
    write(&one.join("package.json"), "{}");
    write(&two.join("package.json"), "{}");
    write(&group.join("penting").join("list.txt"), "a plain folder");
    write(&store(&env, &one).join("first.jsonl"), &session(&one));
    let origin = env.home.join("project").join("freelance").join("client").join("ecobiz");
    fs::create_dir_all(origin.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&group, &origin).unwrap();
    let mut service = Service::new(env.clone());

    // Without status: archived it is a folder in the archive like any other: nothing to put back.
    let snap = service.snapshot().unwrap();
    let node = &snap["nodes"][group.to_str().unwrap()];
    assert_eq!((&node["kind"], &node["inArchive"]), (&json!("folder"), &json!(true)), "{node}");
    assert!(node["restorePlan"].is_null(), "{node}");
    assert!(snap["nodes"][archive.join("project").to_str().unwrap()]["restorePlan"].is_null());
    let error = service.request("restore/plan", &json!({"id":group})).unwrap_err();
    assert!(error.contains("isn't an archived group"), "{error}");
    // Nothing there goes back whole yet, so the refusal doesn't offer it.
    let linked = "~/project/freelance/client/ecobiz is a link into the archive. Remove that link first, or mark \
                  ecobiz status: archived to restore it whole.";
    let plan = &snap["nodes"][one.to_str().unwrap()]["restorePlan"];
    assert_eq!(
        (&plan["error"], &plan["reason"], &plan["dest"], &plan["ops"], &plan["group"]),
        (&json!(linked), &json!("linked"), &json!(origin.join("one")), &json!([]), &json!(null))
    );
    let error = service.request("restore", &json!({"id":one})).unwrap_err();
    assert_eq!(error, linked);
    assert_eq!(fs::read_link(&origin).unwrap(), group);
    assert!(one.join("package.json").is_file());

    write(&group.join(".laci.md"), "---\nstatus: archived\npriority: low\n---\n");
    let snap = service.rescan().unwrap();
    let node = &snap["nodes"][group.to_str().unwrap()];
    assert_eq!(
        (&node["kind"], &node["archived"], &node["meta"]["status"]),
        (&json!("folder"), &json!(true), &json!("archived"))
    );
    let plan = &node["restorePlan"];
    assert!(plan["error"].is_null(), "{plan}");
    assert_eq!(plan["dest"], json!(origin));
    assert_eq!(
        plan["ops"][0],
        json!({"kind":"unlink","label":"Remove the old link","from":"~/project/freelance/client/ecobiz","to":group})
    );
    let ops = plan["ops"].as_array().unwrap();
    assert!(ops.iter().any(|op| op["kind"] == "rename"), "the sessions of a project in it go along: {plan}");
    assert!(ops.iter().any(|op| op["label"] == "Clear status: archived"), "{plan}");
    // A project in it still can't go back alone: the refusal names the group to restore instead, and where it is.
    let plan = &snap["nodes"][two.to_str().unwrap()]["restorePlan"];
    assert_eq!(
        (&plan["error"], &plan["reason"], &plan["group"]),
        (
            &json!(
                "~/project/freelance/client/ecobiz is a link into the archive. Restore the whole group ecobiz, or \
                 remove that link first."
            ),
            &json!("linked"),
            &json!(group)
        ),
        "{plan}"
    );

    let restored = service.request("restore", &json!({"id":group})).unwrap();
    assert!(!fs::symlink_metadata(&origin).unwrap().is_symlink());
    for file in ["one/package.json", "two/package.json", "penting/list.txt"] {
        assert!(origin.join(file).is_file(), "{file}");
    }
    assert!(!group.exists());
    let back = origin.join("one");
    assert_eq!(fs::read_to_string(store(&env, &back).join("first.jsonl")).unwrap(), session(&back));
    assert!(!store(&env, &one).exists());
    let text = sidecar_text(&origin);
    assert!(!text.contains("status:") && text.contains("priority: low"), "{text}");
    assert_eq!(
        activity::read_log(&env, 5)[0]["say"],
        json!({"form":"restored","name":"ecobiz","to":"~/project/freelance/client/ecobiz"})
    );
    let snap = service.snapshot().unwrap();
    let node = &snap["nodes"][origin.to_str().unwrap()];
    assert_eq!((&node["kind"], &node["archived"]), (&json!("folder"), &json!(false)), "{node}");
    assert!(node["restorePlan"].is_null());
    assert_eq!(snap["nodes"][back.to_str().unwrap()]["archived"], false);

    service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap();
    assert_eq!(fs::read_link(&origin).unwrap(), group);
    assert!(one.join("package.json").is_file() && group.join("penting").join("list.txt").is_file());
    assert!(sidecar_text(&group).contains("status: archived"));
    assert_eq!(fs::read_to_string(store(&env, &one).join("first.jsonl")).unwrap(), session(&one));
}
