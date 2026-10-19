//! Cleanup proposals must remain safe across offline disks, reconnects and stale review snapshots.
use laci_core::{activity, config, env::Env, ops, paths, service::Service};
use serde_json::{Value, json};
use std::{fs, path::Path};

mod support;

fn write(path: &Path, bytes: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn fixture() -> (support::TempDir, Env, std::path::PathBuf, Service, Value) {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let root = env.home.join("projects");
    fs::create_dir_all(&root).unwrap();
    config::save(&env, &json!({"roots":["~/projects"],"presets":["claude"]})).unwrap();
    let missing = root.join("gone");
    let history = env.home.join(".claude/projects").join(paths::enc(missing.to_str().unwrap()));
    write(&history.join("session.jsonl"), &format!("{}\n", json!({"cwd":missing})));
    write(&history.join("memory/notes.md"), "exact recovery bytes\n");
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let proposal = snap["proposals"].as_array().unwrap().iter().find(|p| p["category"] == "orphan").unwrap().clone();
    (temp, env, history, service, proposal)
}

#[test]
fn fresh_settings_and_explicit_empty_roots_do_not_discover_or_reactivate_locations() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    write(&env.home.join("project/hidden/package.json"), "{}");
    write(&env.home.join(".codex/sessions/session.jsonl"), "{\"cwd\":\"/missing\"}\n");
    let mut service = Service::new(env.clone());
    let first = service.snapshot().unwrap();
    assert_eq!(first["roots"], json!([]));
    assert_eq!(first["connectors"], json!([]));
    assert_eq!(first["nodes"], json!({}));
    assert_eq!(service.request("setup/info", &json!({})).unwrap()["candidates"], json!([]));
    service.request("setup/save", &json!({"roots":[],"presets":[],"apps":{}})).unwrap();
    service.request("setup/save", &json!({"roots":["~/project"],"presets":[],"apps":{}})).unwrap();
    let entry = activity::read_log(&env, 10).into_iter().find(|e| e["canUndo"] == true).unwrap();
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert_eq!(config::load(&env)["roots"], json!([]));
    let mut restarted = Service::new(env);
    assert_eq!(restarted.request("rescan", &json!({})).unwrap()["nodes"], json!({}));
}

#[test]
fn offline_roots_survive_settings_and_undo_but_never_authorize_cleanup() {
    let (temp, env, history, mut service, proposal) = fixture();
    let roots = env.home.join("projects");
    fs::rename(&roots, temp.path().join("disconnected")).unwrap();
    assert!(service.request("apply", &json!({"id":proposal["id"]})).is_err());
    assert!(history.exists());
    service.request("setup/save", &json!({"roots":["~/projects"],"presets":["claude"],"apps":{}})).unwrap();
    let snap = service.snapshot().unwrap();
    assert_eq!(snap["roots"], json!([roots]));
    assert_eq!(snap["rootStatus"][0]["available"], false);
    service.request("setup/save", &json!({"roots":[],"presets":["claude"],"apps":{}})).unwrap();
    let entry =
        activity::read_log(&env, 10).into_iter().find(|e| e["key"] == "settings" && e["canUndo"] == true).unwrap();
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert_eq!(config::load(&env)["roots"], json!(["~/projects"]));
    assert_eq!(service.snapshot().unwrap()["rootStatus"][0]["available"], false);
}

#[test]
fn replaced_root_is_unavailable_instead_of_producing_deletion_proof() {
    let (temp, env, history, mut service, proposal) = fixture();
    service.request("setup/save", &json!({"roots":["~/projects"],"presets":["claude"],"apps":{}})).unwrap();
    let root = env.home.join("projects");
    fs::rename(&root, temp.path().join("original-drive")).unwrap();
    fs::create_dir(&root).unwrap();
    assert!(service.request("apply", &json!({"id":proposal["id"]})).is_err());
    assert_eq!(service.request("rescan", &json!({})).unwrap()["rootStatus"][0]["available"], false);
    assert!(history.exists());
}

#[test]
fn reconnect_stale_bytes_and_symlinks_reject_reviewed_cleanup() {
    for case in ["reconnect", "edited", "symlink", "outside"] {
        let (_temp, env, history, mut service, proposal) = fixture();
        match case {
            "reconnect" => fs::create_dir(env.home.join("projects/gone")).unwrap(),
            "edited" => write(&history.join("memory/notes.md"), "new session content"),
            "symlink" => support::link_dir(&env.home, &history.join("linked")),
            "outside" => config::save(&env, &json!({"roots":[],"presets":["claude"]})).unwrap(),
            _ => unreachable!(),
        }
        let error =
            service.request("apply", &json!({"id":proposal["id"],"recovery":"trash","paths":[env.home]})).unwrap_err();
        assert!(!error.is_empty(), "{case}");
        assert!(history.join("session.jsonl").exists(), "{case}");
    }
}

// The writer is the shell, holding the log open from another folder.
#[cfg(unix)]
#[test]
fn open_history_writer_blocks_cleanup_even_when_its_cwd_is_elsewhere() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    let (_temp, _env, history, mut service, proposal) = fixture();
    let mut child = Command::new("sh")
        .args(["-c", "exec 3>>\"$1\"; echo ready; exec sleep 30", "writer"])
        .arg(history.join("session.jsonl"))
        .current_dir("/")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    let result = service.request("apply", &json!({"id":proposal["id"]}));
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(result.unwrap_err().contains("writer"));
    assert!(history.exists());
}

#[test]
fn quarantine_defaults_to_exact_restore_and_duplicate_submission_is_rejected() {
    let (_temp, env, history, mut service, proposal) = fixture();
    assert_eq!(proposal["availability"], "missing");
    let bytes = fs::read(history.join("session.jsonl")).unwrap();
    let change = service.execute("apply", &json!({"id":proposal["id"]}), "app").unwrap();
    assert_eq!(change.value["journal"]["canUndo"], true);
    assert!(!history.exists());
    assert!(service.execute("apply", &json!({"id":proposal["id"]}), "app").is_err());
    service.request("undo", &json!({"id":change.value["journal"]["id"]})).unwrap();
    assert_eq!(fs::read(history.join("session.jsonl")).unwrap(), bytes);
    assert_eq!(fs::read_to_string(history.join("memory/notes.md")).unwrap(), "exact recovery bytes\n");
    assert_eq!(
        activity::read_log(&env, 10).iter().filter(|a| a["state"] == "applied" && a["journal"].is_string()).count(),
        0
    );
}

#[test]
fn pure_trash_has_no_laci_undo_and_mixed_journals_explain_partial_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    for (id, entries) in [
        ("pure", json!([{"kind":"trash","path":env.home.join("gone")}])),
        (
            "mixed",
            json!([{"kind":"trash","path":env.home.join("gone")},{"kind":"move","from":env.home.join("old"),"to":env.home.join("new")}]),
        ),
    ] {
        write(&env.data_dir.join(format!("journal/{id}.json")),&json!({"id":id,"state":"applied","title":"Fixture cleanup","at":"2026-10-04T00:00:00.000Z","entries":entries}).to_string());
    }
    let log = activity::read_log(&env, 10);
    let pure = log.iter().find(|e| e["journal"] == "pure").unwrap();
    let mixed = log.iter().find(|e| e["journal"] == "mixed").unwrap();
    assert_eq!(pure["canUndo"], false);
    assert!(ops::undo(&env, "pure").unwrap_err().contains(laci_core::platform::BIN.bare));
    assert_eq!(mixed["canUndo"], true);
    assert!(mixed["recovery"].as_str().unwrap().contains("moves and edits only"));
}

#[test]
fn invalid_default_archive_keeps_review_available_with_a_valid_alternative() {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    // A name at a time, as the scan spells the paths it finds: on Windows a `/` given to `join` stays in the text.
    let project = env.home.join("projects").join("demo");
    write(&project.join("package.json"), "{}");
    write(&env.home.join("projects/_archive/demo/occupied"), "existing");
    config::save(&env, &json!({"roots":["~/projects"],"presets":[]})).unwrap();
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    assert!(snap["nodes"][project.to_str().unwrap()]["archivePlan"]["error"].is_string());
    let dest = env.home.join("other").join("demo");
    let plan = service.request("archive/plan", &json!({"id":project,"destination":dest})).unwrap();
    assert_eq!(plan["dest"], json!(dest));
    service.request("archive", &json!({"id":project,"destination":dest})).unwrap();
    assert!(dest.join("package.json").exists());
}

// gio is Linux's Trash.
#[cfg(target_os = "linux")]
#[test]
fn system_trash_uses_checked_history_paths_and_never_offers_laci_undo() {
    const CHILD: &str = "LACI_ORPHAN_TRASH_TEST";
    if std::env::var_os(CHILD).is_none() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        let gio = bin.join("gio");
        write(
            &gio,
            "#!/bin/sh\n[ \"$1\" = trash ] && [ \"$2\" = -- ] && [ \"$#\" = 3 ] || exit 7\n/usr/bin/mv -- \"$3\" \"$LACI_ORPHAN_TRASH_TEST\"\n",
        );
        fs::set_permissions(&gio, fs::Permissions::from_mode(0o700)).unwrap();
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "system_trash_uses_checked_history_paths_and_never_offers_laci_undo", "--nocapture"])
            .env(CHILD, temp.path().join("fixture-trash"))
            .env("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default()))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(temp.path().join("fixture-trash/session.jsonl").exists());
        return;
    }
    let (_temp, env, history, mut service, proposal) = fixture();
    let unrelated = env.home.join("unrelated.txt");
    write(&unrelated, "must remain");
    let result =
        service.request("apply", &json!({"id":proposal["id"],"recovery":"trash","paths":[unrelated]})).unwrap();
    assert!(!history.exists());
    assert_eq!(fs::read_to_string(&unrelated).unwrap(), "must remain");
    assert_eq!(result["journal"]["canUndo"], false);
    assert!(service.request("undo", &json!({"id":result["journal"]["id"]})).is_err());
    let log = activity::read_log(&env, 10);
    assert_eq!(log.iter().find(|e| e["journal"] == result["journal"]["id"]).unwrap()["canUndo"], false);
}

#[test]
fn an_offline_archive_location_does_not_block_settings_or_saved_selection_undo() {
    let (temp, env, _history, mut service, _proposal) = fixture();
    let archive = temp.path().join("archive-drive");
    fs::create_dir(&archive).unwrap();
    service
        .request("setup/save", &json!({"roots":["~/projects"],"archiveDir":archive,"presets":[],"apps":{}}))
        .unwrap();
    fs::remove_dir(&archive).unwrap();
    service.request("setup/save", &json!({"roots":[],"archiveDir":archive,"presets":[],"apps":{}})).unwrap();
    service.request("setup/save", &json!({"roots":[],"archiveDir":"","presets":[],"apps":{}})).unwrap();
    let entry = activity::read_log(&env, 10)
        .into_iter()
        .find(|entry| entry["key"] == "settings" && entry["canUndo"] == true)
        .unwrap();
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert_eq!(config::load(&env)["archiveDir"], json!(archive));
    assert_eq!(service.snapshot().unwrap()["rootStatus"][0]["available"], false);
}

#[test]
fn automatic_rescan_cannot_replace_the_history_identity_that_was_reviewed() {
    let (_temp, _env, history, mut service, reviewed) = fixture();
    write(&history.join("memory/notes.md"), "new history after the dialog opened\n");
    let fresh = service.request("rescan", &json!({})).unwrap();
    let updated = fresh["proposals"].as_array().unwrap().iter().find(|p| p["category"] == "orphan").unwrap();
    assert_ne!(reviewed["id"], updated["id"], "Cleanup IDs must bind to the reviewed source metadata");
    assert!(service.request("apply", &json!({"id":reviewed["id"]})).is_err());
    assert_eq!(fs::read_to_string(history.join("memory/notes.md")).unwrap(), "new history after the dialog opened\n");
}

#[test]
fn legacy_external_scan_locations_need_a_recorded_drive_identity_before_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let root = temp.path().join("external-mountpoint");
    fs::create_dir_all(&root).unwrap();
    let missing = root.join("gone");
    let history = env.home.join(".claude/projects").join(paths::enc(missing.to_str().unwrap()));
    write(&history.join("session.jsonl"), &format!("{}\n", json!({"cwd":missing})));
    config::save(&env, &json!({"roots":[root],"presets":["claude"]})).unwrap();
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let proposal = snap["proposals"].as_array().unwrap().iter().find(|p| p["category"] == "orphan").unwrap();
    assert_eq!(proposal["blocked"], true);
    assert!(proposal["reason"].as_str().unwrap().contains("no recorded identity"));
    assert!(service.request("apply", &json!({"id":proposal["id"]})).is_err());
    service.request("setup/save", &json!({"roots":[root],"presets":["claude"],"apps":{}})).unwrap();
    let snap = service.snapshot().unwrap();
    assert!(snap["proposals"].as_array().unwrap().iter().any(|p| p["availability"] == "missing"));
    assert!(history.exists());
}
