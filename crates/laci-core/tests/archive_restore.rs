//! The archive folder keeps each project below the scan location it came from, and Restore puts it back.
use laci_core::{activity, backup, config, env::Env, ops, paths, service::Service, sidecar};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

mod support;

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
/// Scan locations ~/project and ~/study, and an archive folder on another disk.
fn fixture() -> (support::TempDir, Env, PathBuf) {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let archive = temp.path().join("archive");
    fs::create_dir_all(&archive).unwrap();
    fs::create_dir_all(env.home.join("project")).unwrap();
    fs::create_dir_all(env.home.join("study")).unwrap();
    config::save(&env, &json!({"roots":["~/project","~/study"],"presets":["claude"],"archiveDir":archive})).unwrap();
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
    let project = env.home.join("study").join("design-course").join("term-project");
    write(&project.join("package.json"), "{}");
    write(&store(&env, &project).join("first.jsonl"), &session(&project));
    let mut service = Service::new(env.clone());
    let id = project.to_str().unwrap();
    let snap = service.snapshot().unwrap();
    let dest = archive.join("study").join("design-course").join("term-project");
    assert_eq!(snap["nodes"][id]["inArchive"], false);
    assert_eq!(snap["nodes"][id]["archivePlan"]["dest"], json!(dest));
    assert!(snap["nodes"][id]["restorePlan"].is_null());

    let archived = service.request("archive", &json!({"id":id})).unwrap();
    assert!(!project.exists());
    assert!(dest.join("package.json").is_file());
    let text = sidecar_text(&dest);
    assert!(text.contains("status: archived"), "{text}");
    assert!(text.contains("archivedFrom: ~/study/design-course/term-project"), "{text}");
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
        json!({"form":"restored","name":"term-project","to":"~/study/design-course/term-project"})
    );
    let snap = service.snapshot().unwrap();
    assert_eq!(snap["nodes"][id]["archived"], false);
    assert!(snap["nodes"][id]["restorePlan"].is_null());

    service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap();
    assert!(!project.exists());
    assert!(dest.join("package.json").is_file());
    assert!(sidecar_text(&dest).contains("archivedFrom: ~/study/design-course/term-project"));
    assert_eq!(fs::read_to_string(store(&env, &dest).join("later.jsonl")).unwrap(), session(&dest));

    service.request("undo", &json!({"id":archived["journal"]["id"]})).unwrap();
    assert!(project.join("package.json").is_file());
    assert!(!project.join(".laci.md").exists());
    assert_eq!(fs::read_to_string(store(&env, &project).join("first.jsonl")).unwrap(), session(&project));
}

#[test]
fn restore_finds_the_origin_from_the_archive_layout_and_refuses_an_occupied_place() {
    let (temp, env, archive) = fixture();
    let archived = archive.join("study").join("course").join("old");
    write(&archived.join("package.json"), "{}");
    let loose = archive.join("loose");
    write(&loose.join("package.json"), "{}");
    let origin = env.home.join("study").join("course").join("old");
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
    assert!(error.contains("Something is already at ~/study/course/old"), "{error}");
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

/// A project archived from ~/study/course/demo with a Claude session: the service, the project, the place the
/// archive keeps it and the journal id of the Archive.
fn archived_demo() -> (support::TempDir, Env, Service, PathBuf, PathBuf, String) {
    let (temp, env, archive) = fixture();
    let project = env.home.join("study").join("course").join("demo");
    write(&project.join("package.json"), "{}");
    write(&store(&env, &project).join("first.jsonl"), &session(&project));
    let mut service = Service::new(env.clone());
    service.snapshot().unwrap();
    let archived = service.request("archive", &json!({"id":project})).unwrap();
    let dest = archive.join("study").join("course").join("demo");
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
    let project = env.home.join("study").join("Lab #2").join("demo");
    write(&project.join("package.json"), "{}");
    let mut service = Service::new(env.clone());
    service.snapshot().unwrap();
    service.request("archive", &json!({"id":project})).unwrap();
    let dest = archive.join("study").join("Lab #2").join("demo");
    let text = sidecar_text(&dest);
    assert!(text.contains("status: archived") && !text.contains("archivedFrom"), "{text}");
    // The archive's layout still tells where it came from.
    let snap = service.rescan().unwrap();
    assert_eq!(snap["nodes"][dest.to_str().unwrap()]["restorePlan"]["dest"], json!(project));
    let error = sidecar::set_meta(&dest, "archivedFrom", "~/study/Lab #2/demo").unwrap_err();
    assert!(error.contains("invalid value"), "{error}");
    for value in ["~/study/demo ", "~/study/demo'", "~/study/demo\""] {
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
    let deep = archive.join("project/work/clients/site/web/site/site-wp");
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
    assert_eq!(node["restorePlan"]["dest"], json!(env.home.join("project/work/clients/site/web/site/site-wp")));
    assert!(snap["nodes"][deeper.to_str().unwrap()].is_null(), "eight folders below the archive is too deep");
    assert_eq!(snap["nodes"][at_home.to_str().unwrap()]["kind"], "project");
    assert!(snap["nodes"][too_deep.to_str().unwrap()].is_null(), "other scan locations keep their depth");
}

/// A project moved into the archive by hand from ~/project/side/old-site, with a link left there that leads to it and
/// a Claude session from while it was in the archive.
fn linked_back() -> (support::TempDir, Env, Service, PathBuf, PathBuf) {
    let (temp, env, archive) = fixture();
    let archived = archive.join("project").join("side").join("old-site");
    write(&archived.join("package.json"), "{}");
    write(&store(&env, &archived).join("first.jsonl"), &session(&archived));
    let origin = env.home.join("project").join("side").join("old-site");
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
        json!({"kind":"unlink","label":"Remove the old link","from":"~/project/side/old-site","to":archived})
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
        json!({"kind":"unlink","label":"Removed the old link","from":"~/project/side/old-site","to":archived})
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
    let away = env.home.join("project").join("side").join("old-site-kept");
    fs::rename(&origin, &away).unwrap();
    write(&origin.join("other.txt"), "made since");
    let error = service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap_err();
    assert!(
        error.contains(
            "Something else is at ~/project/side/old-site since this change, so Undo can't put the old link back"
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
        let away = env.home.join("project").join("side").join("old-site-kept");
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
                "The old link at ~/project/side/old-site isn't back: {}, where it led, is gone",
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
    let archived = archive.join("project").join("side").join("old-site");
    write(&archived.join("package.json"), "{}");
    let other = archive.join("project").join("side").join("other");
    write(&other.join("keep.txt"), "kept");
    let origin = env.home.join("project").join("side").join("old-site");
    fs::create_dir_all(origin.parent().unwrap()).unwrap();
    let mut service = Service::new(env.clone());
    for target in [other.clone(), env.home.join("nowhere")] {
        let _ = fs::remove_file(&origin);
        std::os::unix::fs::symlink(&target, &origin).unwrap();
        let snap = service.rescan().unwrap();
        let plan = &snap["nodes"][archived.to_str().unwrap()]["restorePlan"];
        assert_eq!((&plan["reason"], &plan["dest"], &plan["ops"]), (&json!("occupied"), &json!(origin), &json!([])));
        assert!(plan["error"].as_str().unwrap().contains("Something is already at ~/project/side/old-site"), "{plan}");
        let error = service.request("restore", &json!({"id":archived})).unwrap_err();
        assert!(error.contains("Something is already at"), "{error}");
        assert_eq!(fs::read_link(&origin).unwrap(), target);
        assert!(archived.join("package.json").is_file());
    }
}

#[test]
fn a_group_linked_back_from_the_archive_goes_back_whole_and_its_projects_not_alone() {
    let (_temp, env, archive) = fixture();
    let group = archive.join("project").join("work").join("clients").join("acme");
    let (one, two) = (group.join("one"), group.join("two"));
    write(&one.join("package.json"), "{}");
    write(&two.join("package.json"), "{}");
    write(&group.join("penting").join("list.txt"), "a plain folder");
    write(&store(&env, &one).join("first.jsonl"), &session(&one));
    let origin = env.home.join("project").join("work").join("clients").join("acme");
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
    let linked = "~/project/work/clients/acme is a link into the archive. Remove that link first, or mark \
                  acme status: archived to restore it whole.";
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
        json!({"kind":"unlink","label":"Remove the old link","from":"~/project/work/clients/acme","to":group})
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
                "~/project/work/clients/acme is a link into the archive. Restore the whole group acme, or \
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
        json!({"form":"restored","name":"acme","to":"~/project/work/clients/acme"})
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

/// A Git repository in `dir` with one commit and no remote.
fn committed(dir: &Path) {
    for args in [&["init", "-q", "--initial-branch=main"][..], &["add", "-A"], &["commit", "-q", "-m", "first"]] {
        let out = Command::new("git")
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
    }
}
fn path(p: &Path) -> &str {
    p.to_str().unwrap()
}

#[test]
fn an_archive_style_folder_keeps_the_depth_a_project_had_once() {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    // Six folders below ~/project, as deep as a scan looks.
    let deep = env.home.join("project/a/b/c/d/e/f");
    write(&deep.join("package.json"), "{}");
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"]})).unwrap();
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    // Without an archive folder in Settings it goes to the scan location's _archive, one folder deeper.
    let dest = env.home.join("project/_archive/a/b/c/d/e/f");
    assert_eq!(snap["nodes"][path(&deep)]["archivePlan"]["dest"], json!(dest));
    service.request("archive", &json!({"id":deep})).unwrap();
    assert!(dest.join("package.json").is_file());
    // One folder deeper than any project could have come from.
    let too_deep = env.home.join("project/_archive/x/b/c/d/e/f/g");
    write(&too_deep.join("package.json"), "{}");
    // An _archive inside an _archive adds nothing more.
    let nested = env.home.join("project/_archive/y/_archive/b/c/d/p");
    write(&nested.join("package.json"), "{}");
    let nested_too_deep = env.home.join("project/_archive/y/_archive/b/c/d/e/q");
    write(&nested_too_deep.join("package.json"), "{}");
    // Elsewhere in the scan location the depth is as before.
    let outside = env.home.join("project/a/b/c/d/e/x/y");
    write(&outside.join("package.json"), "{}");

    let snap = service.rescan().unwrap();
    let node = &snap["nodes"][path(&dest)];
    assert_eq!((&node["kind"], &node["inArchive"]), (&json!("project"), &json!(true)), "{node}");
    assert_eq!(node["restorePlan"]["dest"], json!(deep));
    assert_eq!(snap["nodes"][path(&nested)]["kind"], "project");
    for gone in [&too_deep, &nested_too_deep, &outside] {
        assert!(snap["nodes"][path(gone)].is_null(), "{}", gone.display());
    }
    service.request("restore", &json!({"id":dest})).unwrap();
    assert!(deep.join("package.json").is_file() && !dest.exists());
}

#[test]
fn an_archive_folder_inside_a_scan_location_is_looked_through_as_deep_as_one_outside() {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let archive = env.home.join("project/archive");
    fs::create_dir_all(&archive).unwrap();
    let deep = env.home.join("project/a/b/c/d/e/f");
    write(&deep.join("package.json"), "{}");
    write(&store(&env, &deep).join("first.jsonl"), &session(&deep));
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"archiveDir":archive})).unwrap();
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let dest = archive.join("project/a/b/c/d/e/f");
    assert_eq!(snap["nodes"][path(&deep)]["archivePlan"]["dest"], json!(dest));
    service.request("archive", &json!({"id":deep})).unwrap();
    // Put there by hand: as deep as a project from ~/project can be, and one folder deeper.
    let by_hand = archive.join("project/k/b/c/d/e/f");
    write(&by_hand.join("package.json"), "{}");
    let too_deep = archive.join("project/k/b/c/d/e/x/y");
    write(&too_deep.join("package.json"), "{}");
    // An _archive inside the archive folder adds nothing more.
    let inner = archive.join("project/_archive/c/d/e/f/g");
    write(&inner.join("package.json"), "{}");
    let inner_too_deep = archive.join("project/_archive/c/d/e/f/x/h");
    write(&inner_too_deep.join("package.json"), "{}");

    let snap = service.rescan().unwrap();
    let node = &snap["nodes"][path(&dest)];
    assert_eq!((&node["kind"], &node["inArchive"]), (&json!("project"), &json!(true)), "{node}");
    assert_eq!(node["restorePlan"]["dest"], json!(deep));
    assert_eq!(snap["nodes"][path(&by_hand)]["restorePlan"]["dest"], json!(env.home.join("project/k/b/c/d/e/f")));
    assert_eq!(snap["nodes"][path(&inner)]["inArchive"], true);
    for gone in [&too_deep, &inner_too_deep] {
        assert!(snap["nodes"][path(gone)].is_null(), "{}", gone.display());
    }
    assert!(snap["nodes"][path(&archive)]["archivePlan"].is_null(), "the archive folder isn't archived");

    service.request("restore", &json!({"id":dest})).unwrap();
    assert!(deep.join("package.json").is_file() && !dest.exists());
    assert_eq!(fs::read_to_string(store(&env, &deep).join("first.jsonl")).unwrap(), session(&deep));
}

#[test]
fn restoring_a_group_clears_the_folders_and_projects_marked_archived_in_it() {
    let (_temp, env, archive) = fixture();
    let group = archive.join("project/clients");
    let team = group.join("old-team");
    let site = group.join("site");
    let api = group.join("api");
    write(&group.join(".laci.md"), "---\nstatus: archived\narchivedFrom: ~/project/clients\n---\n");
    write(&team.join(".laci.md"), "---\nstatus: archived\npriority: low\n---\n");
    write(&team.join("app/package.json"), "{}");
    write(&site.join("package.json"), "{}");
    write(
        &site.join(".laci.md"),
        "---\nstatus: archived\narchivedFrom: ~/project/clients/site\narchivedAt: 2026-01-02\n---\n",
    );
    write(&api.join("package.json"), "{}");
    let texts = |root: &Path| {
        ["", "old-team/", "site/"].map(|dir| fs::read_to_string(root.join(format!("{dir}.laci.md"))).unwrap())
    };
    let before = texts(&group);
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let origin = env.home.join("project/clients");
    let plan = &snap["nodes"][path(&group)]["restorePlan"];
    assert!(plan["error"].is_null(), "{plan}");
    assert_eq!(plan["dest"], json!(origin));
    let cleared: Vec<_> =
        plan["ops"].as_array().unwrap().iter().filter(|op| op["label"] == "Clear status: archived").collect();
    assert_eq!(
        cleared.iter().map(|op| op["to"].as_str().unwrap()).collect::<Vec<_>>(),
        ["~/project/clients/.laci.md", "~/project/clients/old-team/.laci.md", "~/project/clients/site/.laci.md"]
    );
    // What is in the group goes back with it, not alone: each names the outermost group.
    for inner in [&team, &team.join("app"), &site, &api] {
        let plan = &snap["nodes"][path(inner)]["restorePlan"];
        assert_eq!((&plan["reason"], &plan["group"], &plan["ops"]), (&json!("inGroup"), &json!(group), &json!([])));
    }
    let plan = &snap["nodes"][path(&site)]["restorePlan"];
    assert_eq!(
        plan["error"],
        "site is in the archived group clients, which goes back whole. Restore clients, or choose another place for it."
    );
    // The place it came from is the group's: none is given.
    assert!(plan.get("dest").is_none(), "{plan}");
    assert!(service.request("restore", &json!({"id":site})).unwrap_err().contains("goes back whole"));
    // A place of its own inside the group's would be in its way, so it is refused the same.
    for inside in [origin.join("api"), origin.join("later/api")] {
        let plan = service.request("restore/plan", &json!({"id":api,"destination":inside})).unwrap();
        assert_eq!((&plan["reason"], &plan["group"], &plan["ops"]), (&json!("inGroup"), &json!(group), &json!([])));
        assert!(plan.get("dest").is_none(), "{plan}");
        assert_eq!(
            plan["error"],
            "api is in the archived group clients, which goes back whole to ~/project/clients. Restore clients, or \
             choose a place outside it."
        );
        assert!(service.request("restore", &json!({"id":api,"destination":inside})).is_err());
        assert!(!inside.exists());
    }
    // A place of its own takes it out alone.
    let elsewhere = env.home.join("project/api");
    let alone = service.request("restore/plan", &json!({"id":api,"destination":elsewhere})).unwrap();
    assert_eq!((&alone["error"], &alone["dest"]), (&json!(null), &json!(elsewhere)));

    let restored = service.request("restore", &json!({"id":group})).unwrap();
    assert!(!group.exists());
    for file in ["api/package.json", "site/package.json", "old-team/app/package.json"] {
        assert!(origin.join(file).is_file(), "{file}");
    }
    let [own, inner, project] = texts(&origin);
    for text in [&own, &inner, &project] {
        for key in ["status:", "archivedFrom:", "archivedAt:"] {
            assert!(!text.contains(key), "{text}");
        }
    }
    assert!(inner.contains("priority: low"), "{inner}");
    let snap = service.snapshot().unwrap();
    for back in [&origin, &origin.join("old-team"), &origin.join("site"), &origin.join("api")] {
        let node = &snap["nodes"][path(back)];
        assert_eq!(node["archived"], false, "{node}");
        assert!(node["restorePlan"].is_null(), "{node}");
    }

    // One Undo brings all three back.
    service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap();
    assert!(!origin.exists());
    assert_eq!(texts(&group), before);
}

#[test]
fn a_folder_marked_archived_outside_the_archive_is_restored_where_it_is() {
    let (_temp, env, archive) = fixture();
    let folder = env.home.join("project/clients");
    write(&folder.join("site/package.json"), "{}");
    let original = "---\nstatus: archived\narchivedAt: 2026-01-02\npriority: low\n---\n";
    write(&folder.join(".laci.md"), original);
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let node = &snap["nodes"][path(&folder)];
    assert_eq!(
        (&node["kind"], &node["archived"], &node["inArchive"]),
        (&json!("folder"), &json!(true), &json!(false)),
        "{node}"
    );
    assert!(node["archivePlan"].is_null(), "an archived folder isn't archived again");
    let plan = &node["restorePlan"];
    assert_eq!((&plan["dest"], &plan["checks"]), (&json!(folder), &json!([])), "{plan}");
    assert_eq!(
        plan["ops"][0],
        json!({"kind":"write","label":"Clear status: archived","to":"~/project/clients/.laci.md"})
    );
    assert_eq!(plan["ops"].as_array().unwrap().len(), 2, "and the undo journal: {plan}");
    assert!(snap["nodes"][path(&folder.join("site"))]["restorePlan"].is_null());
    let error = service.request("restore", &json!({"id":folder,"destination":env.home.join("elsewhere")})).unwrap_err();
    assert!(error.contains("only marked archived"), "{error}");

    let restored = service.request("restore", &json!({"id":folder})).unwrap();
    let text = sidecar_text(&folder);
    assert!(!text.contains("status:") && !text.contains("archivedAt:") && text.contains("priority: low"), "{text}");
    let snap = service.snapshot().unwrap();
    let node = &snap["nodes"][path(&folder)];
    assert_eq!(node["archived"], false);
    assert!(node["restorePlan"].is_null());
    assert_eq!(node["archivePlan"]["dest"], json!(archive.join("project/clients")));
    service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap();
    assert_eq!(sidecar_text(&folder), original);
}

#[test]
fn a_folder_of_projects_is_archived_as_a_group_and_goes_back_whole() {
    let (_temp, env, archive) = fixture();
    let group = env.home.join("project/clients/acme");
    let (one, two) = (group.join("one"), group.join("two"));
    write(&one.join("package.json"), "{}");
    committed(&one);
    write(&two.join("package.json"), "{}");
    write(&store(&env, &two).join("first.jsonl"), &session(&two));
    write(&group.join("brief.txt"), "a plain file");
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let dest = archive.join("project/clients/acme");
    let node = &snap["nodes"][path(&group)];
    assert_eq!((&node["kind"], &node["projectCount"]), (&json!("folder"), &json!(2)), "{node}");
    let plan = &node["archivePlan"];
    assert!(plan["error"].is_null(), "{plan}");
    assert_eq!(plan["dest"], json!(dest));
    // The checks are those of the projects in it, each naming its project.
    let checks = plan["checks"].as_array().unwrap();
    assert!(checks.iter().any(|c| c["code"] == "no-remote"), "{plan}");
    for check in checks {
        assert_eq!((&check["project"], &check["projectId"]), (&json!("one"), &json!(one)), "{check}");
    }
    let ops = plan["ops"].as_array().unwrap();
    assert_eq!(ops[0]["kind"], "move");
    assert!(ops.iter().any(|op| op["kind"] == "rename"), "the sessions of a project in it go along: {plan}");
    assert!(ops.iter().any(|op| op["kind"] == "keep" && op["detail"] == "2 projects and everything else in it"));
    assert!(ops.iter().any(|op| op["label"] == "Set status: archived"), "{plan}");
    // The folder above it is a group too; the scan location isn't.
    let clients = &snap["nodes"][path(&env.home.join("project/clients"))];
    assert_eq!(clients["projectCount"], 2);
    assert_eq!(clients["archivePlan"]["dest"], json!(archive.join("project/clients")));
    let root = &snap["nodes"][path(&env.home.join("project"))];
    assert_eq!(root["projectCount"], 2);
    assert!(root["archivePlan"].is_null());

    let archived = service.request("archive", &json!({"id":group})).unwrap();
    assert!(!group.exists());
    for file in ["one/package.json", "one/.git/HEAD", "two/package.json", "brief.txt"] {
        assert!(dest.join(file).exists(), "{file}");
    }
    let text = sidecar_text(&dest);
    assert!(text.contains("status: archived") && text.contains("archivedFrom: ~/project/clients/acme"), "{text}");
    assert!(text.contains(&format!("archivedAt: {}", chrono::Local::now().format("%Y-%m-%d"))), "{text}");
    let moved = dest.join("two");
    assert_eq!(fs::read_to_string(store(&env, &moved).join("first.jsonl")).unwrap(), session(&moved));
    assert!(!store(&env, &two).exists());
    assert_eq!(activity::read_log(&env, 5)[0]["say"], json!({"form":"archived","name":"acme"}));

    // It is an archived group now: it goes back whole, and its projects with it.
    let snap = service.rescan().unwrap();
    let node = &snap["nodes"][path(&dest)];
    assert_eq!((&node["kind"], &node["inArchive"], &node["archived"]), (&json!("folder"), &json!(true), &json!(true)));
    assert!(node["archivePlan"].is_null());
    assert_eq!(node["restorePlan"]["dest"], json!(group));
    let alone = &snap["nodes"][path(&dest.join("one"))]["restorePlan"];
    assert_eq!((&alone["reason"], &alone["group"], &alone["dest"]), (&json!("inGroup"), &json!(dest), &json!(null)));

    let restored = service.request("restore", &json!({"id":dest})).unwrap();
    assert!(one.join(".git/HEAD").is_file() && two.join("package.json").is_file() && !dest.exists());
    assert_eq!(fs::read_to_string(store(&env, &two).join("first.jsonl")).unwrap(), session(&two));
    let text = sidecar_text(&group);
    for key in ["status:", "archivedFrom:", "archivedAt:"] {
        assert!(!text.contains(key), "{text}");
    }
    assert_eq!(service.snapshot().unwrap()["nodes"][path(&group)]["archived"], false);

    service.request("undo", &json!({"id":restored["journal"]["id"]})).unwrap();
    assert!(dest.join("two/package.json").is_file() && !group.exists());
    service.request("undo", &json!({"id":archived["journal"]["id"]})).unwrap();
    assert!(one.join(".git/HEAD").is_file() && group.join("brief.txt").is_file() && !dest.exists());
    assert!(!group.join(".laci.md").exists());
    assert_eq!(fs::read_to_string(store(&env, &two).join("first.jsonl")).unwrap(), session(&two));
}

#[test]
fn a_scan_location_home_or_a_folder_holding_the_archive_or_the_copy_is_not_archived() {
    let (_temp, env, archive) = fixture();
    let team = env.home.join("project/team");
    write(&team.join("app/package.json"), "{}");
    let marked = env.home.join("project/marked");
    write(&marked.join("app/package.json"), "{}");
    write(&marked.join(".laci.md"), "---\nstatus: archived\n---\n");
    let copy = team.join("ai-chats");
    fs::create_dir_all(&copy).unwrap();
    let settings = |extra: serde_json::Value| {
        let mut cfg = json!({"roots":["~/project","~/study"],"presets":["claude"],"archiveDir":archive});
        for (key, value) in extra.as_object().unwrap() {
            cfg[key] = value.clone();
        }
        config::save(&env, &cfg).unwrap();
    };
    settings(json!({"backupDir":copy}));
    let mut service = Service::new(env.clone());
    let refused = |service: &mut Service, dir: &Path, said: &str| {
        let snap = service.rescan().unwrap();
        assert!(snap["nodes"][path(dir)]["archivePlan"].is_null(), "{}", dir.display());
        for name in ["archive/plan", "archive"] {
            let error = service.request(name, &json!({"id":dir})).unwrap_err();
            assert!(error.contains(said), "{name}: {error}");
        }
        assert!(dir.is_dir());
    };
    refused(&mut service, &env.home.join("project"), "A scan location can't be archived");
    refused(&mut service, &marked, "marked archived already");
    refused(&mut service, &team, "holds Laci's copy of AI chats");

    let inside = team.join("old");
    fs::create_dir_all(&inside).unwrap();
    settings(json!({"archiveDir":inside}));
    refused(&mut service, &team, "holds the archive folder");

    settings(json!({"roots":["~"]}));
    refused(&mut service, &env.home, "Your home folder can't be archived");
}

#[test]
fn the_copy_of_ai_chats_and_the_archive_folder_stay_apart() {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let shelf = env.home.join("shelf");
    let archive = shelf.join("archive");
    let copy = archive.join("ai-chats");
    fs::create_dir_all(&copy).unwrap();
    // The copy may be a folder of its own in the archive folder, not the archive folder or one that holds it.
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"archiveDir":archive})).unwrap();
    assert_eq!(config::validate_backup_dir(&env, &json!(copy)).unwrap(), Some(copy.clone()));
    for (dir, said) in [(&archive, "That is the archive folder"), (&shelf, "holds the archive folder")] {
        let error = config::validate_backup_dir(&env, &json!(dir)).unwrap_err();
        assert!(error.contains(said), "{error}");
    }
    // The archive folder can't be the copy's folder, nor inside it.
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"backupDir":copy})).unwrap();
    assert_eq!(config::validate_archive_dir(&env, &json!(archive)).unwrap(), json!("~/shelf/archive"));
    let error = config::validate_archive_dir(&env, &json!(copy)).unwrap_err();
    assert!(error.contains("That is the folder of Laci's copy of AI chats"), "{error}");
    let inside = copy.join("old");
    fs::create_dir_all(&inside).unwrap();
    let error = config::validate_archive_dir(&env, &json!(inside)).unwrap_err();
    assert!(error.contains("inside Laci's copy of AI chats (~/shelf/archive/ai-chats)"), "{error}");

    // A setup from before the rule, its archive folder inside the copy, goes on: the copy is still made, and the
    // settings saved with the archive folder unchanged keep it. Choosing such a folder is what is refused.
    write(&copy.join(backup::MARKER), "a copy Laci made");
    let identities = config::root_identities(&env, &json!([copy]), &json!({}));
    config::save(
        &env,
        &json!({"roots":["~/project"],"presets":["claude"],"backupDir":copy,"archiveDir":inside,"rootIdentities":identities}),
    )
    .unwrap();
    assert_eq!(backup::dir(&env).unwrap(), copy);
    assert_eq!(config::validate_archive_dir(&env, &json!(inside)).unwrap(), json!("~/shelf/archive/ai-chats/old"));
    assert!(config::validate_archive_dir(&env, &json!(copy)).unwrap_err().contains("That is the folder"));
    // The copy kept in the archive folder itself goes on too.
    let identities = config::root_identities(&env, &json!([archive]), &json!({}));
    write(&archive.join(backup::MARKER), "a copy Laci made");
    config::save(
        &env,
        &json!({"roots":["~/project"],"presets":["claude"],"backupDir":archive,"archiveDir":archive,"rootIdentities":identities}),
    )
    .unwrap();
    assert_eq!(backup::dir(&env).unwrap(), archive);
}

#[test]
fn undo_of_a_settings_change_does_not_make_the_copy_of_ai_chats_the_archive_folder() {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let (old, new) = (env.home.join("shelf/old-archive"), env.home.join("shelf/archive"));
    for dir in [&old, &new, &env.home.join("project")] {
        fs::create_dir_all(dir).unwrap();
    }
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"archiveDir":old})).unwrap();
    let mut service = Service::new(env.clone());
    service
        .request("setup/save", &json!({"roots":["~/project"],"presets":["claude"],"apps":{},"archiveDir":new}))
        .unwrap();
    let changed = activity::read_log(&env, 10).into_iter().find(|a| a["title"] == "Changed settings").unwrap();
    // The folder that was the archive folder holds the copy of AI chats now.
    ops::move_backup(&env, old.to_str().unwrap(), false).unwrap();
    let error = service.request("log/undo", &json!({"id":changed["id"]})).unwrap_err();
    assert_eq!(
        error,
        "Undo would make ~/shelf/old-archive the archive folder again. That is the folder of Laci's copy of AI chats. \
         Choose the archive folder in Settings instead."
    );
    assert_eq!(config::load(&env)["archiveDir"], "~/shelf/archive");
    // Once the copy is elsewhere, the Undo goes ahead.
    ops::move_backup(&env, "", false).unwrap();
    service.request("log/undo", &json!({"id":changed["id"]})).unwrap();
    assert_eq!(config::load(&env)["archiveDir"], "~/shelf/old-archive");
}

/// A group whose place in the archive an earlier archive of one of its projects made.
fn course_with_p1_archived() -> (support::TempDir, Env, Service, PathBuf, PathBuf) {
    let (temp, env, archive) = fixture();
    let course = env.home.join("project/course");
    for name in ["p1", "p2"] {
        write(&course.join(name).join("package.json"), "{}");
    }
    write(&store(&env, &course.join("p2")).join("first.jsonl"), &session(&course.join("p2")));
    write(&course.join("brief.txt"), "notes");
    let mut service = Service::new(env.clone());
    service.snapshot().unwrap();
    service.request("archive", &json!({"id":course.join("p1")})).unwrap();
    let place = archive.join("project/course");
    assert!(place.join("p1/package.json").is_file() && !course.join("p1").exists());
    service.rescan().unwrap();
    (temp, env, service, course, place)
}

#[test]
fn a_group_joins_the_folder_in_the_archive_an_earlier_archive_of_its_project_made() {
    let (_temp, env, mut service, course, place) = course_with_p1_archived();
    let (p1, p2) = (place.join("p1"), course.join("p2"));
    let snap = service.rescan().unwrap();
    let plan = &snap["nodes"][path(&course)]["archivePlan"];
    assert!(plan["error"].is_null(), "{plan}");
    assert_eq!((&plan["dest"], &plan["join"]), (&json!(place), &json!(true)));
    assert_eq!(
        (&plan["ops"][0]["kind"], &plan["ops"][0]["label"]),
        (&json!("move"), &json!("Join the folder already in the archive (it holds 1 earlier archived item)"))
    );

    let archived = service.request("archive", &json!({"id":course})).unwrap();
    assert!(!course.exists());
    for file in ["p1/package.json", "p2/package.json", "brief.txt"] {
        assert!(place.join(file).is_file(), "{file}");
    }
    let text = sidecar_text(&place);
    assert!(text.contains("status: archived") && text.contains("archivedFrom: ~/project/course"), "{text}");
    assert!(sidecar_text(&p1).contains("archivedFrom: ~/project/course/p1"));
    assert_eq!(
        fs::read_to_string(store(&env, &place.join("p2")).join("first.jsonl")).unwrap(),
        session(&place.join("p2"))
    );
    // One archived group, with p1 in it.
    let snap = service.rescan().unwrap();
    let node = &snap["nodes"][path(&place)];
    assert_eq!((&node["kind"], &node["inArchive"], &node["archived"]), (&json!("folder"), &json!(true), &json!(true)));
    assert_eq!(node["restorePlan"]["dest"], json!(course));
    assert_eq!(snap["nodes"][path(&p1)]["restorePlan"]["reason"], "inGroup");

    // Undo takes back only what the group archive moved: p1 stays archived where it was.
    service.request("undo", &json!({"id":archived["journal"]["id"]})).unwrap();
    assert!(p2.join("package.json").is_file() && course.join("brief.txt").is_file());
    assert_eq!(fs::read_to_string(store(&env, &p2).join("first.jsonl")).unwrap(), session(&p2));
    assert!(!place.join("p2").exists() && !place.join("brief.txt").exists() && !place.join(".laci.md").exists());
    assert!(p1.join("package.json").is_file() && sidecar_text(&p1).contains("status: archived"));

    // Archived again, the group goes back whole, and p1's own mark is cleared with it.
    service.rescan().unwrap();
    service.request("archive", &json!({"id":course})).unwrap();
    service.rescan().unwrap();
    service.request("restore", &json!({"id":place})).unwrap();
    assert!(!place.exists());
    for file in ["p1/package.json", "p2/package.json", "brief.txt"] {
        assert!(course.join(file).is_file(), "{file}");
    }
    for dir in [course.clone(), course.join("p1")] {
        let text = sidecar_text(&dir);
        assert!(!text.contains("status:") && !text.contains("archivedFrom:"), "{text}");
    }
    let snap = service.rescan().unwrap();
    for dir in [&course, &course.join("p1"), &p2] {
        assert_eq!(snap["nodes"][path(dir)]["archived"], false, "{}", dir.display());
    }
}

#[test]
fn a_group_does_not_join_a_folder_in_the_archive_holding_the_same_name_or_archived_whole() {
    let (_temp, _env, mut service, course, place) = course_with_p1_archived();
    // A new p1 since.
    write(&course.join("p1/package.json"), "{}");
    let said = format!("{} already holds p1 from an earlier archive. Choose another place.", place.display());
    let snap = service.rescan().unwrap();
    assert_eq!(snap["nodes"][path(&course)]["archivePlan"]["error"], json!(said));
    assert_eq!(service.request("archive", &json!({"id":course})).unwrap_err(), said);
    assert!(course.join("p1/package.json").is_file() && course.join("p2/package.json").is_file());

    // A place archived as a whole is not joined either.
    fs::remove_dir_all(course.join("p1")).unwrap();
    write(&place.join(".laci.md"), "---\nstatus: archived\n---\n");
    let said = format!(
        "{} already holds course from an earlier archive. Choose another place.",
        place.parent().unwrap().display()
    );
    service.rescan().unwrap();
    assert_eq!(service.request("archive", &json!({"id":course})).unwrap_err(), said);
    assert!(course.join("p2/package.json").is_file() && !place.join("p2").exists());
}

/// `git` in `dir`, as a test's own: no settings of the machine's.
fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn a_group_plan_names_a_git_worktree_that_lies_across_its_edge() {
    let (_temp, env, _archive) = fixture();
    let team = env.home.join("project/team");
    let (one, two, base) = (team.join("one"), team.join("two"), env.home.join("project/base"));
    for dir in [&one, &base] {
        write(&dir.join("package.json"), "{}");
        committed(dir);
    }
    // A worktree of one outside the group, and two a worktree of a repository outside it.
    git(&one, &["worktree", "add", "-q", "../../wt-one"]);
    git(&base, &["worktree", "add", "-q", "../team/two"]);
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let plan = &snap["nodes"][path(&team)]["archivePlan"];
    let apart: Vec<_> = plan["checks"].as_array().unwrap().iter().filter(|c| c["code"] == "worktree").collect();
    assert_eq!(apart.len(), 2, "{plan}");
    let of = |name: &str| *apart.iter().find(|c| c["project"] == name).unwrap_or_else(|| panic!("{name}: {plan}"));
    let (first, second) = (of("one"), of("two"));
    assert_eq!(
        (&first["severity"], &first["project"], &first["projectId"]),
        (&json!("med"), &json!("one"), &json!(one))
    );
    let title = first["title"].as_str().unwrap();
    assert!(
        title.starts_with("one: a git worktree outside the group (")
            && title.ends_with("wt-one) will need git worktree repair"),
        "{title}"
    );
    assert_eq!((&second["project"], &second["projectId"]), (&json!("two"), &json!(two)));
    let title = second["title"].as_str().unwrap();
    assert!(
        title.starts_with("two: a git worktree of a repository outside the group (")
            && title.ends_with("base) will need git worktree repair"),
        "{title}"
    );
    // A project archived alone has no such check: it is the group's.
    assert!(
        snap["nodes"][path(&one)]["archivePlan"]["checks"].as_array().unwrap().iter().all(|c| c["code"] != "worktree")
    );
}

#[test]
fn a_scan_location_named_like_the_copy_in_the_archive_folder_is_refused_clearly() {
    let (_temp, env, archive) = fixture();
    let copy = archive.join("study");
    fs::create_dir_all(&copy).unwrap();
    config::save(
        &env,
        &json!({"roots":["~/project","~/study"],"presets":["claude"],"archiveDir":archive,"backupDir":copy}),
    )
    .unwrap();
    let project = env.home.join("study/course/demo");
    write(&project.join("package.json"), "{}");
    let other = env.home.join("project/app");
    write(&other.join("package.json"), "{}");
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let said =
        format!("The archive keeps what comes from ~/study in {}, the folder of the copy of AI chats.", copy.display());
    let error = snap["nodes"][path(&project)]["archivePlan"]["error"].as_str().unwrap();
    assert!(error.contains(&said), "{error}");
    let error = service.request("archive", &json!({"id":project})).unwrap_err();
    assert!(error.contains(&said), "{error}");
    assert!(project.join("package.json").is_file());
    assert_eq!(snap["nodes"][path(&other)]["archivePlan"]["dest"], json!(archive.join("project/app")));
}
