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
    // What runs that stopped left: the old writer's temporary file and Laci's own.
    write(&kept.join(".tmpYmKbQv"), "half a log");
    write(&kept.join("2026/.laci-copy-a1b2C3"), "half a copy");
    // What a move copied into or set aside can be the only copy of a chat once its source is gone, and a file
    // Laci doesn't know is the user's.
    write(&kept.join(".laci-move-Ab12Cd/payload/chat.jsonl.zst"), "a moved copy");
    write(&kept.join(".laci-move-1f2e-3/chat.jsonl.zst"), "set aside");
    write(&kept.join("notes.txt"), "mine");
    // Outside the folders of the agents Laci knows, nothing is touched either.
    write(&env.data_dir.join("history/elsewhere/.tmpQwErTy"), "not a copy");
    // Outside the copy, nothing is touched.
    write(&store.join(".tmpAbCdEf"), "not Laci's");

    ops::backup_history(&env, &codex(&store)).unwrap();
    assert!(!kept.join(".tmpYmKbQv").exists());
    assert!(!kept.join("2026/.laci-copy-a1b2C3").exists());
    assert_eq!(fs::read_to_string(kept.join(".laci-move-Ab12Cd/payload/chat.jsonl.zst")).unwrap(), "a moved copy");
    assert!(env.data_dir.join("history/elsewhere/.tmpQwErTy").exists());
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
    // Its size is the chat's, as its tool's copy told it, not that of the packed file.
    assert_eq!(kept[0]["bytes"], json!(bytes.len()));
    assert!(fs::metadata(kept[0]["file"].as_str().unwrap()).unwrap().len() != bytes.len() as u64);
    service.request("backup/restore", &json!({"id":kept[0]["id"]})).unwrap();
    assert_eq!(fs::read(&file).unwrap(), bytes, "the restored log is the log as it was");
}

#[test]
fn the_copy_moves_to_a_folder_outside_home_and_undo_moves_it_back() {
    let (_temp, env, disk) = home();
    let project = claude(&env);
    let file = session(&env, &project, ID, "Fix the login page");
    // Claude Code keeps the session's subagent logs in a folder named after it, and the project's memory beside it.
    let subagent = file.with_extension("").join("subagents/agent-a1b2c3.jsonl");
    write(&subagent, &format!("{}\n", json!({"type":"user","isSidechain":true,"cwd":project,"sessionId":ID})));
    write(&file.with_file_name("memory/MEMORY.md"), "- a note\n");
    let mut service = Service::new(env.clone());
    service.request("backup", &json!({})).unwrap();
    let default = env.data_dir.join("history");
    let relative = file.strip_prefix(env.home.join(".claude/projects")).unwrap();
    let before = backup::packed(&default.join("claude").join(relative));
    assert!(before.is_file());
    let subagents = relative.with_extension("");
    let packed_subagent = |copy: PathBuf| backup::packed(&copy.join(&subagents).join("subagents/agent-a1b2c3.jsonl"));
    assert!(packed_subagent(default.join("claude")).is_file());

    let chosen = disk.join("ai-chats");
    fs::create_dir(&chosen).unwrap();
    let moved = service.request("backup/move", &json!({"dir":chosen})).unwrap();
    assert_eq!(moved["dest"], json!(chosen));
    let title = format!("Moved the copy of AI chats to {}", chosen.display());
    assert_eq!(moved["journal"]["title"], json!(title));
    assert_eq!(moved["moved"], true);
    let entry = journal_entry(&env, &moved["journal"]);
    assert_eq!(entry["say"], json!({"form":"movedCopy","dir":chosen,"own":false}));
    // The copy is no longer part of what the data folder holds.
    let storage = laci_core::storage::report(&env).unwrap();
    let part = storage["parts"].as_array().unwrap().iter().find(|p| p["id"] == "history").unwrap().clone();
    assert_eq!((&part["dir"], &part["elsewhere"]), (&json!(chosen), &json!(true)));
    assert!(part["bytes"].as_u64().unwrap() > 0);
    let parts: u64 = storage["parts"].as_array().unwrap().iter().map(|p| p["bytes"].as_u64().unwrap()).sum();
    assert_eq!(storage["total"].as_u64().unwrap(), parts - part["bytes"].as_u64().unwrap());
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
    assert!(packed_subagent(chosen.join("claude")).is_file());
    let deleted = service.request("session/delete", &json!({"files":[file]})).unwrap();
    assert!(!after.exists() && !file.exists() && !subagent.exists());
    let quarantine = env.data_dir.join("orphans/sessions").join(deleted["journal"]["id"].as_str().unwrap());
    assert!(backup::packed(&quarantine.join("backup/claude").join(relative)).is_file());
    // The copy of its subagent logs goes with it, beside the copy of the log, and nothing else of the copy does.
    assert!(!chosen.join("claude").join(&subagents).exists());
    assert!(packed_subagent(quarantine.join("backup/claude")).is_file());
    let memory = backup::packed(&chosen.join("claude").join(relative.with_file_name("memory/MEMORY.md")));
    assert!(memory.is_file() && backup::marked(&chosen));
    let entry = journal_entry(&env, &deleted["journal"]);
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert!(after.is_file() && file.is_file() && subagent.is_file());
    assert!(packed_subagent(chosen.join("claude")).is_file());
    assert!(!quarantine.join("backup/claude").join(&subagents).exists());

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
    assert!(packed_subagent(default.join("claude")).is_file());
    assert_eq!(config::load(&env)["backupDir"], "", "the copy is in the default folder again");
    assert!(chosen.is_dir(), "the folder the copy left stays");
}

#[test]
fn an_empty_copy_switches_to_a_folder_that_holds_a_copy_laci_made() {
    let (_temp, env, disk) = home();
    claude(&env);
    let earlier = disk.join("ai-chats");
    write(&backup::packed(&earlier.join("claude/-x/a.jsonl")), "packed elsewhere");
    write(&earlier.join(backup::MARKER), "a copy Laci made");
    let moved = ops::move_backup(&env, earlier.to_str().unwrap(), false).unwrap();
    assert!(moved["journal"]["entries"].as_array().unwrap().iter().all(|e| e["kind"] != "move"), "nothing moves");
    assert_eq!((&moved["moved"], &moved["bytes"]), (&json!(false), &json!(0)));
    assert_eq!(moved["journal"]["say"]["form"], "keptCopyIn");
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
    assert_eq!(
        ops::move_backup(&env, "", false).unwrap()["journal"]["say"],
        json!({"form":"movedCopy","dir":"~/.local/share/laci/history","own":true})
    );
    assert_eq!(config::load(&env)["backupDir"], "");
    let back = env.data_dir.join("history");
    assert_eq!(fs::read_to_string(backup::packed(&back.join("claude/-x/a.jsonl"))).unwrap(), "packed elsewhere");
    assert!(!earlier.join("claude").exists() && backup::marked(&back));
    assert!(ops::move_backup(&env, back.to_str().unwrap(), false).unwrap_err().contains("already"));
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
        let refused = ops::move_backup(&env, &dir, false).unwrap_err();
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
    ops::move_backup(&env, chosen.to_str().unwrap(), false).unwrap();

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

#[test]
fn a_folder_for_the_copy_that_was_never_chosen_takes_nothing_and_loses_nothing() {
    let (_temp, env, disk) = home();
    let store = env.home.join(".codex/sessions");
    write(&store.join("session.jsonl"), "a log\n");
    // config.json edited by hand, or by another program: home itself, which is told as such before anything is on
    // record, and a folder of the user's files.
    let theirs = disk.join("archive");
    write(&theirs.join("codex/notes.md"), "the user's notes\n");
    write(&theirs.join("codex/.tmpAbCdEf"), "the user's file\n");
    for (dir, why) in [(env.home.clone(), "not your home folder"), (theirs.clone(), "isn't the one Laci knows")] {
        config::save(&env, &json!({"presets":["codex"],"backupDir":dir})).unwrap();
        let refused = ops::backup_history(&env, &codex(&store)).unwrap_err();
        assert!(refused.contains(why), "{refused}");
        assert!(backup::dir(&env).is_err());
    }
    // Known by its identity, as when its drive was recorded for another setting, it is still no copy Laci made.
    let identity = |dir: &Path| {
        let meta = fs::metadata(dir).unwrap();
        json!({"device":std::os::unix::fs::MetadataExt::dev(&meta),"inode":std::os::unix::fs::MetadataExt::ino(&meta)})
    };
    let mut identities = json!({});
    identities[theirs.to_str().unwrap()] = identity(&theirs);
    identities[env.home.to_str().unwrap()] = identity(&env.home);
    config::save(&env, &json!({"presets":["codex"],"backupDir":theirs,"rootIdentities":identities})).unwrap();
    let refused = ops::backup_history(&env, &codex(&store)).unwrap_err();
    assert!(refused.contains("doesn't hold a copy Laci made"), "{refused}");
    config::save(&env, &json!({"presets":["codex"],"backupDir":"~","rootIdentities":identities})).unwrap();
    let refused = ops::backup_history(&env, &codex(&store)).unwrap_err();
    assert!(refused.contains("not your home folder"), "{refused}");
    // Nothing was packed, removed or marked.
    assert_eq!(fs::read_to_string(theirs.join("codex/notes.md")).unwrap(), "the user's notes\n");
    assert!(theirs.join("codex/.tmpAbCdEf").is_file() && !theirs.join("codex/notes.md.zst").exists());
    assert!(!backup::marked(&theirs) && !backup::marked(&env.home));
    assert!(!theirs.join("codex/session.jsonl.zst").exists() && !env.home.join("codex").exists());
}

#[test]
fn a_copy_that_cant_be_reached_moves_only_once_the_drive_is_back_or_a_new_copy_starts() {
    let (_temp, env, disk) = home();
    let store = env.home.join(".codex/sessions");
    write(&store.join("session.jsonl"), "a log\n");
    let chosen = disk.join("ai-chats");
    fs::create_dir(&chosen).unwrap();
    ops::move_backup(&env, chosen.to_str().unwrap(), false).unwrap();
    ops::backup_history(&env, &codex(&store)).unwrap();
    let away = disk.join("unplugged");
    fs::rename(&chosen, &away).unwrap();

    // Moving it now would leave the chats on the drive that isn't there: refused, and nothing changes.
    let refused = ops::move_backup(&env, "", false).unwrap_err();
    assert!(refused.starts_with("Connect the drive first, so Laci can move the copy."), "{refused}");
    assert_eq!(config::load(&env)["backupDir"], json!(chosen));
    // Asked for, a new copy starts in Laci's own folder: nothing moves, and the old one stays on its drive.
    let fresh = ops::move_backup(&env, "", true).unwrap();
    assert_eq!((&fresh["moved"], &fresh["bytes"]), (&json!(false), &json!(0)));
    assert_eq!(fresh["journal"]["say"]["form"], "keptCopyIn");
    assert_eq!(config::load(&env)["backupDir"], "");
    assert!(backup::packed(&away.join("codex/session.jsonl")).is_file());
    assert_eq!(ops::backup_state(&env), None, "what the last backup said is of the copy left behind");
    assert_eq!(ops::backup_history(&env, &codex(&store)).unwrap()["copied"], 1);
    assert!(backup::packed(&env.data_dir.join("history/codex/session.jsonl")).is_file());
}

#[test]
fn undo_moves_nothing_outside_the_copy_whatever_its_journal_says() {
    let (_temp, env, disk) = home();
    let outside = disk.join("someone/else.txt");
    write(&outside, "not Laci's\n");
    let journal = env.data_dir.join("journal/edited.json");
    let root = |dir: &Path| {
        let meta = fs::metadata(dir).unwrap();
        json!({"path":dir,"device":std::os::unix::fs::MetadataExt::dev(&meta),"inode":std::os::unix::fs::MetadataExt::ino(&meta)})
    };
    let elsewhere = disk.join("moved.txt");
    for entry in [
        // A folder recorded as a copy that is none.
        json!({"kind":"move","scope":"copy","roots":[root(&disk)],"from":outside,"to":elsewhere,"token":"1-1"}),
        // The scope of a copy on another kind of entry.
        json!({"kind":"file","scope":"copy","roots":[root(&disk)],"path":outside,"existed":false}),
    ] {
        write(&journal, &json!({"id":"edited","state":"applied","entries":[entry]}).to_string());
        assert!(ops::undo(&env, "edited").is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "not Laci's\n");
    }
}

#[test]
fn a_plain_copy_longer_than_its_packed_one_takes_its_place() {
    let (_temp, env, _) = home();
    let store = env.home.join(".codex/sessions");
    fs::create_dir_all(&store).unwrap();
    let kept = env.data_dir.join("history/codex");
    // A Laci before 3.1 wrote the plain copy after a later one had packed a shorter log.
    write(&kept.join("grown.jsonl"), "first line\nsecond line\n");
    fs::write(kept.join("grown.jsonl.zst"), zstd::bulk::compress(b"first line\n", 3).unwrap()).unwrap();
    ops::backup_history(&env, &codex(&store)).unwrap();
    assert_eq!(unpacked(&kept.join("grown.jsonl.zst")), "first line\nsecond line\n");
    assert!(!kept.join("grown.jsonl").exists());
}

#[test]
fn the_first_backup_after_the_upgrade_tells_the_log_what_it_packed() {
    let (_temp, env, _) = home();
    claude(&env);
    fs::create_dir_all(env.home.join(".claude/projects")).unwrap();
    let kept = env.data_dir.join("history/claude/-home-old");
    let text = "{\"type\":\"user\",\"message\":\"hello\"}\n".repeat(2000);
    write(&kept.join("old.jsonl"), &text);
    write(&kept.join("memory/MEMORY.md"), "- a note\n");
    let said = laci_core::service::backup_now(&env, "cli").unwrap();
    let (packed, copied) = said.split_once('\n').unwrap();
    assert!(packed.starts_with("Packed the copy of AI chats: 2 files, "), "{said}");
    assert!(packed.contains(" → "), "{said}");
    assert!(copied.starts_with("Copied 0 files · 1 session kept · "), "{said}");
    // Packing is told once, by the command line, and copying nothing isn't told.
    let log = activity::read_log(&env, 10);
    assert_eq!(log.len(), 1, "{log:?}");
    let say = &log[0]["say"];
    assert_eq!((&log[0]["by"], &say["form"], &say["files"]), (&json!("cli"), &json!("packedCopy"), &json!(2)));
    assert!(log[0]["title"].as_str().unwrap().starts_with("Compressed the agent history backup: 2 files, "));
    let after = fs::metadata(kept.join("old.jsonl.zst")).unwrap().len()
        + fs::metadata(kept.join("memory/MEMORY.md.zst")).unwrap().len();
    assert_eq!((&say["before"], &say["after"]), (&json!(text.len() + 9), &json!(after)));
    assert!(after < text.len() as u64 / 4);
    // Nothing is left to pack: the next run tells nothing.
    let said = laci_core::service::backup_now(&env, "cli").unwrap();
    assert!(said.starts_with("Copied 0 files · "), "{said}");
    assert_eq!(activity::read_log(&env, 10).len(), 1);
}

#[test]
fn laci_backup_copies_without_a_scan_and_tells_the_log_only_when_it_copied() {
    let (_temp, env, disk) = home();
    let project = claude(&env);
    session(&env, &project, ID, "Fix the login page");
    let said = laci_core::service::backup_now(&env, "cli").unwrap();
    assert!(said.starts_with("Copied 1 file · 1 session kept · "), "{said}");
    assert!(said.ends_with(" in ~/.local/share/laci/history"), "{said}");
    let entry = &activity::read_log(&env, 10)[0];
    assert_eq!((&entry["by"], &entry["say"]), (&json!("cli"), &json!({"form":"backedUp","files":1})));
    // Nothing new: nothing is told.
    let said = laci_core::service::backup_now(&env, "cli").unwrap();
    assert!(said.starts_with("Copied 0 files · "), "{said}");
    assert_eq!(activity::read_log(&env, 10).len(), 1);
    // A copy folder that can't be used is the error the command exits with.
    let chosen = disk.join("ai-chats");
    fs::create_dir(&chosen).unwrap();
    ops::move_backup(&env, chosen.to_str().unwrap(), false).unwrap();
    fs::rename(&chosen, disk.join("unplugged")).unwrap();
    let refused = laci_core::service::backup_now(&env, "cli").unwrap_err();
    assert!(refused.contains("isn't there"), "{refused}");
}
