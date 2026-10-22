//! The copy of AI chats: each file packed with zstd, kept in Laci's data folder or in a folder the user chose, which
//! may be outside home and on a drive that isn't always there.
use laci_core::{activity, backup, config, env::Env, ops, service::Service};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

mod support;

const ID: &str = "11111111-2222-3333-4444-555555555555";

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn stamp(path: &Path) {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000))
                .set_accessed(SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000)),
        )
        .unwrap();
}
/// What the packed file `path` holds.
fn unpacked(path: &Path) -> String {
    let mut text = String::new();
    backup::open(path).unwrap().read_to_string(&mut text).unwrap();
    text
}
/// The number of bytes the frame header of the packed file `path` records.
fn recorded(path: &Path) -> Option<u64> {
    let bytes = fs::read(path).unwrap();
    zstd::zstd_safe::get_frame_content_size(&bytes[..bytes.len().min(18)]).ok().flatten()
}
fn modified(path: &Path) -> SystemTime {
    fs::metadata(path).unwrap().modified().unwrap()
}
/// A home inside a temporary folder, and beside home a folder that stands for another drive.
fn home() -> (support::TempDir, Env, PathBuf) {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let disk = temp.path().join("disk");
    fs::create_dir_all(&env.home).unwrap();
    fs::create_dir_all(&disk).unwrap();
    (temp, env, disk)
}
fn codex(store: &Path) -> Value {
    json!({"connectors":[{"id":"codex","name":"Codex","link":{"kind":"cwd","dir":store}}]})
}

#[test]
fn a_backup_packs_each_log_and_copies_one_again_only_when_it_grew() {
    let (_temp, env, _) = home();
    let store = env.home.join(".codex/sessions");
    let source = store.join("2026/10/session.jsonl");
    write(&source, "original log\n");
    stamp(&source);
    let snap = codex(&store);
    let first = ops::backup_history(&env, &snap).unwrap();
    assert_eq!((&first["copied"], &first["sessions"], &first["files"]), (&json!(1), &json!(1), &json!(1)));
    let copy = env.data_dir.join("history");
    let packed = copy.join("codex/2026/10/session.jsonl.zst");
    assert_eq!(unpacked(&packed), "original log\n");
    assert_eq!(recorded(&packed), Some(13), "the frame says how long the log was");
    assert_eq!(modified(&packed), modified(&source), "the copy keeps the log's time");
    assert!(!copy.join("codex/2026/10/session.jsonl").exists(), "no plain copy is written");
    assert!(fs::read_to_string(copy.join(backup::MARKER)).unwrap().contains("zstd -d"));

    assert_eq!(ops::backup_history(&env, &snap).unwrap()["copied"], 0, "an unchanged log is skipped");
    write(&source, "original log\nand a reply\n");
    let again = ops::backup_history(&env, &snap).unwrap();
    assert_eq!((&again["copied"], &again["bytes"]), (&json!(1), &json!(25)));
    assert_eq!(unpacked(&packed), "original log\nand a reply\n");
    assert_eq!(recorded(&packed), Some(25));
}

#[test]
fn a_plain_copy_from_before_is_packed_once_it_unpacks_to_the_same_bytes() {
    let (_temp, env, _) = home();
    let store = env.home.join(".codex/sessions");
    fs::create_dir_all(&store).unwrap();
    let kept = env.data_dir.join("history/codex");
    let old = kept.join("old.jsonl");
    write(&old, "{\"type\":\"user\"}\n");
    stamp(&old);
    let when = modified(&old);
    write(&kept.join("notes/MEMORY.md"), "- a note\n");
    // A plain file beside its packed copy: the packed one is newer, as a later run made it.
    write(&kept.join("both.jsonl"), "older\n");
    fs::write(kept.join("both.jsonl.zst"), zstd::stream::encode_all(&b"newer\n"[..], 3).unwrap()).unwrap();

    let done = ops::backup_history(&env, &codex(&store)).unwrap();
    assert_eq!(done["copied"], 0, "nothing new to copy");
    assert_eq!((&done["sessions"], &done["files"]), (&json!(2), &json!(3)));
    assert!(!old.exists() && !kept.join("both.jsonl").exists() && !kept.join("notes/MEMORY.md").exists());
    assert_eq!(unpacked(&kept.join("old.jsonl.zst")), "{\"type\":\"user\"}\n");
    assert_eq!(modified(&kept.join("old.jsonl.zst")), when);
    assert_eq!(unpacked(&kept.join("notes/MEMORY.md.zst")), "- a note\n");
    assert_eq!(unpacked(&kept.join("both.jsonl.zst")), "newer\n");
}

#[test]
fn a_backup_removes_only_what_a_run_that_stopped_left_in_the_copy() {
    let (_temp, env, _) = home();
    let store = env.home.join(".codex/sessions");
    fs::create_dir_all(&store).unwrap();
    let kept = env.data_dir.join("history/codex");
    let chat = kept.join("chat.jsonl.zst");
    fs::create_dir_all(&kept).unwrap();
    fs::write(&chat, zstd::stream::encode_all(&b"a chat\n"[..], 3).unwrap()).unwrap();
    // What runs that stopped left: the old writer's temporary file, Laci's own, and a move from another drive.
    write(&kept.join(".tmpYmKbQv"), "half a log");
    write(&kept.join("2026/.laci-copy-a1b2C3"), "half a copy");
    write(&kept.join(".laci-move-Ab12Cd/payload/chat.jsonl.zst"), "half a moved copy");
    // What a move set aside is its source, and a file Laci doesn't know is the user's.
    write(&kept.join(".laci-move-1f2e-3/chat.jsonl.zst"), "set aside");
    write(&kept.join("notes.txt"), "mine");
    // Outside the copy, nothing is touched.
    write(&store.join(".tmpAbCdEf"), "not Laci's");

    ops::backup_history(&env, &codex(&store)).unwrap();
    assert!(!kept.join(".tmpYmKbQv").exists());
    assert!(!kept.join("2026/.laci-copy-a1b2C3").exists());
    assert!(!kept.join(".laci-move-Ab12Cd").exists());
    assert_eq!(unpacked(&chat), "a chat\n");
    assert_eq!(fs::read_to_string(kept.join(".laci-move-1f2e-3/chat.jsonl.zst")).unwrap(), "set aside");
    assert_eq!(fs::read_to_string(kept.join("notes.txt")).unwrap(), "mine");
    assert!(store.join(".tmpAbCdEf").exists());
}

/// Settings with Claude Code connected and `~/project` scanned, and one project in it.
fn claude(env: &Env) -> PathBuf {
    let project = env.home.join("project/demo");
    write(&project.join("package.json"), r#"{"name":"demo"}"#);
    config::save(env, &json!({"roots":["~/project"],"presets":["claude"],"custom":[],"apps":{}})).unwrap();
    project
}
/// A Claude Code session in `project`, last written an hour ago.
fn session(env: &Env, project: &Path, id: &str, prompt: &str) -> PathBuf {
    let store = env.home.join(".claude/projects").join(laci_core::paths::enc(&project.to_string_lossy()));
    let file = store.join(format!("{id}.jsonl"));
    let line = json!({"type":"user","cwd":project,"sessionId":id,"message":{"role":"user","content":prompt}});
    write(&file, &format!("{line}\n{}\n", json!({"type":"assistant","cwd":project,"sessionId":id})));
    let hour_ago = SystemTime::now() - Duration::from_secs(3600);
    fs::File::options().write(true).open(&file).unwrap().set_modified(hour_ago).unwrap();
    file
}
fn in_copy(snap: &Value) -> Vec<Value> {
    snap["sessions"].as_array().unwrap().iter().filter(|s| s["backup"] == true).cloned().collect()
}
fn journal_entry(env: &Env, journal: &Value) -> Value {
    activity::read_log(env, 50).into_iter().find(|e| e["journal"] == journal["id"]).unwrap()
}

#[test]
fn a_session_only_the_packed_copy_holds_is_listed_and_comes_back_byte_for_byte() {
    let (_temp, env, _) = home();
    let project = claude(&env);
    let file = session(&env, &project, ID, "Fix the login page");
    let bytes = fs::read(&file).unwrap();
    let mut service = Service::new(env.clone());
    service.request("backup", &json!({})).unwrap();
    fs::remove_file(&file).unwrap();
    let snap = service.rescan().unwrap();
    let kept = in_copy(&snap);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["title"], "Fix the login page");
    assert_eq!(kept[0]["sessionId"], ID);
    assert_eq!(kept[0]["restoreTo"], json!(file));
    assert!(kept[0]["file"].as_str().unwrap().ends_with(&format!("{ID}.jsonl.zst")));
    service.request("backup/restore", &json!({"id":kept[0]["id"]})).unwrap();
    assert_eq!(fs::read(&file).unwrap(), bytes, "the restored log is the log as it was");
}

#[test]
fn the_copy_moves_to_a_folder_outside_home_and_undo_moves_it_back() {
    let (_temp, env, disk) = home();
    let project = claude(&env);
    let file = session(&env, &project, ID, "Fix the login page");
    let mut service = Service::new(env.clone());
    service.request("backup", &json!({})).unwrap();
    let default = env.data_dir.join("history");
    let relative = file.strip_prefix(env.home.join(".claude/projects")).unwrap();
    let before = backup::packed(&default.join("claude").join(relative));
    assert!(before.is_file());

    let chosen = disk.join("ai-chats");
    fs::create_dir(&chosen).unwrap();
    let moved = service.request("backup/move", &json!({"dir":chosen})).unwrap();
    assert_eq!(moved["dest"], json!(chosen));
    let title = format!("Moved the copy of AI chats to {}", chosen.display());
    assert_eq!(moved["journal"]["title"], json!(title));
    let entry = journal_entry(&env, &moved["journal"]);
    assert_eq!(entry["say"], json!({"form":"movedCopy","dir":chosen}));
    let after = backup::packed(&chosen.join("claude").join(relative));
    assert!(after.is_file() && !before.exists());
    assert!(backup::marked(&chosen) && backup::marked(&default), "each folder keeps its own marker");
    let cfg = config::load(&env);
    assert_eq!(cfg["backupDir"], json!(chosen));
    let identity = &cfg["rootIdentities"][chosen.to_str().unwrap()];
    assert!(identity["device"].is_u64() && identity["inode"].is_u64());
    let snap = moved["snapshot"].clone();
    assert_eq!((&snap["backup"]["dest"], &snap["backup"]["chosen"]), (&json!(chosen), &json!(true)));
    assert!(snap["backup"]["error"].is_null());

    // Backups go to the chosen folder now.
    write(&file, &format!("{}{}\n", fs::read_to_string(&file).unwrap(), json!({"more":1})));
    let done = service.request("backup", &json!({})).unwrap();
    assert_eq!((&done["copied"], &done["dest"]), (&json!(1), &json!(chosen)));
    assert!(!before.exists());

    // A deleted session takes its packed copy from the chosen folder into the quarantine, and Undo puts it back.
    let hour_ago = SystemTime::now() - Duration::from_secs(3600);
    fs::File::options().write(true).open(&file).unwrap().set_modified(hour_ago).unwrap();
    service.rescan().unwrap();
    let deleted = service.request("session/delete", &json!({"files":[file]})).unwrap();
    assert!(!after.exists() && !file.exists());
    let quarantine = env.data_dir.join("orphans/sessions").join(deleted["journal"]["id"].as_str().unwrap());
    assert!(backup::packed(&quarantine.join("backup/claude").join(relative)).is_file());
    let entry = journal_entry(&env, &deleted["journal"]);
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert!(after.is_file() && file.is_file());

    // Undo of the move refuses while the folder's drive is gone, and makes nothing in its place.
    let entry = journal_entry(&env, &moved["journal"]);
    let away = disk.join("unplugged");
    fs::rename(&chosen, &away).unwrap();
    let refused = service.request("log/undo", &json!({"id":entry["id"]})).unwrap_err();
    assert!(refused.contains("isn't there as it was"), "{refused}");
    assert!(!chosen.exists());
    fs::rename(&away, &chosen).unwrap();
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert!(before.is_file() && !after.exists());
    assert_eq!(config::load(&env)["backupDir"], Value::Null, "the setting is as it was before the move");
    assert!(chosen.is_dir(), "the folder the copy left stays");
}

#[test]
fn an_empty_copy_switches_to_a_folder_that_holds_a_copy_laci_made() {
    let (_temp, env, disk) = home();
    claude(&env);
    let earlier = disk.join("ai-chats");
    write(&backup::packed(&earlier.join("claude/-x/a.jsonl")), "packed elsewhere");
    write(&earlier.join(backup::MARKER), "a copy Laci made");
    let moved = ops::move_backup(&env, earlier.to_str().unwrap()).unwrap();
    assert!(moved["journal"]["entries"].as_array().unwrap().iter().all(|e| e["kind"] != "move"), "nothing moves");
    assert_eq!(config::load(&env)["backupDir"], json!(earlier));
    assert_eq!(backup::dir(&env).unwrap(), earlier);
    // Saving other settings keeps what Laci knows of the folder.
    let identity = config::load(&env)["rootIdentities"][earlier.to_str().unwrap()].clone();
    assert!(identity["device"].is_u64() && identity["inode"].is_u64());
    let mut service = Service::new(env.clone());
    service.request("setup/save", &json!({"roots":["~/project"],"presets":["claude"],"apps":{}})).unwrap();
    assert_eq!(config::load(&env)["rootIdentities"][earlier.to_str().unwrap()], identity);
    assert_eq!(config::load(&env)["backupDir"], json!(earlier));
    // Back to the default, which Laci makes: the copy moves with it.
    ops::move_backup(&env, "").unwrap();
    assert_eq!(config::load(&env)["backupDir"], "");
    let back = env.data_dir.join("history");
    assert_eq!(fs::read_to_string(backup::packed(&back.join("claude/-x/a.jsonl"))).unwrap(), "packed elsewhere");
    assert!(!earlier.join("claude").exists() && backup::marked(&back));
    assert!(ops::move_backup(&env, back.to_str().unwrap()).unwrap_err().contains("already"));
}

#[test]
fn a_folder_that_cant_hold_the_copy_is_refused() {
    let (temp, env, disk) = home();
    claude(&env);
    let store = env.home.join(".claude/projects");
    for dir in [store.join("inside"), env.config_dir.clone(), env.data_dir.join("journal"), env.cache_dir.clone()] {
        fs::create_dir_all(&dir).unwrap();
    }
    write(&disk.join("full/mine.txt"), "the user's");
    let refusals = [
        ("~".to_owned(), "home folder"),
        (temp.path().to_string_lossy().into_owned(), "home folder"),
        (env.config_dir.to_string_lossy().into_owned(), "belongs to Laci"),
        (env.data_dir.join("journal").to_string_lossy().into_owned(), "belongs to Laci"),
        (env.cache_dir.to_string_lossy().into_owned(), "belongs to Laci"),
        (store.join("inside").to_string_lossy().into_owned(), "history of Claude Code"),
        (env.home.join(".claude").to_string_lossy().into_owned(), "history of Claude Code"),
        (disk.join("full").to_string_lossy().into_owned(), "already holds files"),
        (disk.join("missing").to_string_lossy().into_owned(), "existing folder"),
    ];
    for (dir, why) in refusals {
        let refused = ops::move_backup(&env, &dir).unwrap_err();
        assert!(refused.contains(why), "{dir}: {refused}");
    }
    assert_eq!(config::load(&env)["backupDir"], Value::Null, "no refusal changed the setting");
    // The default folder itself means the default.
    assert!(config::validate_backup_dir(&env, &json!(env.data_dir.join("history"))).unwrap().is_none());
}

#[test]
fn a_chosen_folder_that_is_gone_or_another_one_now_takes_no_copy() {
    let (_temp, env, disk) = home();
    let store = env.home.join(".codex/sessions");
    write(&store.join("session.jsonl"), "a log\n");
    let chosen = disk.join("ai-chats");
    fs::create_dir(&chosen).unwrap();
    ops::move_backup(&env, chosen.to_str().unwrap()).unwrap();

    // The drive isn't connected: nothing is made where the folder was.
    let away = disk.join("unplugged");
    fs::rename(&chosen, &away).unwrap();
    let refused = ops::backup_history(&env, &codex(&store)).unwrap_err();
    assert!(refused.contains("isn't there") && refused.contains("Connect its drive"), "{refused}");
    assert!(!chosen.exists());
    assert!(backup::dir(&env).is_err());

    // An empty folder in its place, as a mount point without its drive, is another folder.
    fs::create_dir(&chosen).unwrap();
    let refused = ops::backup_history(&env, &codex(&store)).unwrap_err();
    assert!(refused.contains("isn't the one Laci knows"), "{refused}");
    assert!(fs::read_dir(&chosen).unwrap().next().is_none(), "nothing is written there");
    fs::remove_dir(&chosen).unwrap();
    fs::rename(&away, &chosen).unwrap();
    assert_eq!(ops::backup_history(&env, &codex(&store)).unwrap()["copied"], 1);
}

#[test]
fn the_folder_of_the_copy_is_no_project_and_the_project_around_it_stays_put() {
    let (_temp, env, _) = home();
    let project = claude(&env);
    let other = env.home.join("project/other");
    write(&other.join("package.json"), r#"{"name":"other"}"#);
    let chats = env.home.join("project/chats");
    fs::create_dir_all(&chats).unwrap();
    let mut service = Service::new(env.clone());
    service.request("backup/move", &json!({"dir":chats})).unwrap();
    // Before a run packs them, copies can look like documents.
    write(&chats.join("claude/notes/README.md"), "# Notes\n");
    let snap = service.rescan().unwrap();
    assert!(snap["nodes"].as_object().unwrap().keys().all(|id| !Path::new(id).starts_with(&chats)));

    let inside = project.join("ai-chats");
    fs::create_dir(&inside).unwrap();
    service.request("backup/move", &json!({"dir":inside})).unwrap();
    let id = project.to_str().unwrap();
    let elsewhere = env.home.join("project/elsewhere/demo");
    let refused = service.request("move", &json!({"id":id,"destination":elsewhere})).unwrap_err();
    assert!(refused.contains("holds Laci's copy of AI chats"), "{refused}");
    let refused = service.request("delete/plan", &json!({"id":id})).unwrap_err();
    assert!(refused.contains("holds Laci's copy of AI chats"), "{refused}");
    let into = inside.join("other");
    let refused = service.request("move", &json!({"id":other.to_str().unwrap(),"destination":into})).unwrap_err();
    assert!(refused.contains("inside Laci's copy of AI chats"), "{refused}");
    assert!(project.join("package.json").is_file() && other.join("package.json").is_file() && !into.exists());
}
