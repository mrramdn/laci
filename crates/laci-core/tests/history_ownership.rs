//! A bounded display snapshot must never authorize removing shared or unverified history.
use laci_core::{config, env::Env, ops, paths, scan};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn fixture(provider: &str) -> (tempfile::TempDir, Env, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    fs::create_dir_all(env.home.join("projects/live")).unwrap();
    let cfg = if provider == "custom" {
        json!({"roots":["~/projects"],"presets":[],"custom":[{"id":"custom-history","name":"History","link":{"kind":"cwd","dir":"~/history","field":"cwd","ext":".jsonl"}}]})
    } else {
        json!({"roots":["~/projects"],"presets":[provider]})
    };
    config::save(&env, &cfg).unwrap();
    let log = match provider {
        "codex" => env.home.join(".codex/sessions/session.jsonl"),
        "claude" => env
            .home
            .join(".claude/projects")
            .join(paths::enc(env.home.join("projects/gone").to_str().unwrap()))
            .join("session.jsonl"),
        _ => env.home.join("history/session.jsonl"),
    };
    (temp, env, log)
}
fn record(env: &Env, cwd: &str) -> String {
    format!("{}\n", json!({"type":"turn_context","payload":{"cwd":env.home.join("projects").join(cwd)}}))
}
fn proposal(snapshot: &Value) -> &Value {
    snapshot["proposals"].as_array().unwrap().iter().find(|p| p["category"] == "orphan").unwrap()
}
fn blocked_in_both_modes(env: &Env, source: &Path, snapshot: &Value) {
    let p = proposal(snapshot);
    assert_eq!(p["blocked"], true, "{p}");
    assert_eq!(p["availability"], "unavailable");
    for recovery in ["quarantine", "trash"] {
        assert!(ops::apply_proposal(env, snapshot, p, recovery).is_err(), "{recovery}");
        assert!(source.exists(), "{recovery}");
    }
}

#[test]
fn shared_live_and_missing_owners_block_both_cleanup_modes() {
    for provider in ["codex", "custom"] {
        let (_temp, env, log) = fixture(provider);
        let text = if provider == "codex" {
            record(&env, "live") + &record(&env, "gone")
        } else {
            // Custom logs keep their first display cwd, so put the missing owner first.
            format!(
                "{}\n{}\n",
                json!({"cwd":env.home.join("projects/gone")}),
                json!({"cwd":env.home.join("projects/live")})
            )
        };
        write(&log, &text);
        let snapshot = scan::scan(&env).unwrap();
        let item = snapshot["items"].as_object().unwrap().values().next().unwrap();
        assert_eq!(item["ownershipComplete"], true);
        assert_eq!(item["cwds"].as_object().unwrap().len(), 2);
        blocked_in_both_modes(&env, &log, &snapshot);
        assert_eq!(fs::read_to_string(&log).unwrap(), text);
    }
}

// Linux only until macOS and Windows can tell which programs write to the history.
#[cfg(target_os = "linux")]
#[test]
fn all_missing_owners_allow_quarantine_with_exact_undo() {
    let (_temp, env, log) = fixture("codex");
    let bytes = record(&env, "gone-a") + &record(&env, "gone-b");
    write(&log, &bytes);
    let snapshot = scan::scan(&env).unwrap();
    let p = proposal(&snapshot);
    assert_eq!(p["validation"]["projects"].as_array().unwrap().len(), 2);
    let changed = ops::apply_proposal(&env, &snapshot, p, "quarantine").unwrap();
    assert!(!log.exists());
    ops::undo(&env, changed["id"].as_str().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(log).unwrap(), bytes);
}

#[test]
fn equal_size_source_changes_invalidate_ownership_and_reviewed_cleanup() {
    let (_temp, env, log) = fixture("codex");
    write(&log, record(&env, "gone") + &record(&env, "gone-b"));
    let reviewed = scan::scan(&env).unwrap();
    let p = proposal(&reviewed).clone();
    let before = fs::metadata(&log).unwrap();
    write(&log, record(&env, "live") + &record(&env, "gone-b"));
    fs::File::options()
        .write(true)
        .open(&log)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(before.modified().unwrap()))
        .unwrap();
    assert_eq!(fs::metadata(&log).unwrap().len(), before.len());
    let fresh = scan::scan(&env).unwrap();
    blocked_in_both_modes(&env, &log, &fresh);
    for mode in ["quarantine", "trash"] {
        assert!(ops::apply_proposal(&env, &reviewed, &p, mode).is_err());
        assert!(log.exists());
    }
}

// gio is Linux's Trash.
#[cfg(target_os = "linux")]
#[test]
fn all_missing_owners_allow_only_checked_trash_sources() {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    const CHILD: &str = "LACI_SHARED_HISTORY_TRASH_TEST";
    if std::env::var_os(CHILD).is_none() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        let gio = bin.join("gio");
        write(
            &gio,
            "#!/bin/sh\n[ \"$1\" = trash ] && [ \"$2\" = -- ] && [ \"$#\" = 3 ] || exit 7\n/usr/bin/mv -- \"$3\" \"$LACI_SHARED_HISTORY_TRASH_TEST\"\n",
        );
        fs::set_permissions(&gio, fs::Permissions::from_mode(0o700)).unwrap();
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "all_missing_owners_allow_only_checked_trash_sources", "--nocapture"])
            .env(CHILD, temp.path().join("fixture-trash.jsonl"))
            .env("PATH", std::env::join_paths([bin.as_path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(temp.path().join("fixture-trash.jsonl").is_file());
        return;
    }
    let (_temp, env, log) = fixture("codex");
    write(&log, record(&env, "gone-a") + &record(&env, "gone-b"));
    let snapshot = scan::scan(&env).unwrap();
    let p = proposal(&snapshot);
    assert_eq!(p["validation"]["projects"].as_array().unwrap().len(), 2);
    ops::apply_proposal(&env, &snapshot, p, "trash").unwrap();
    assert!(!log.exists());
    assert!(env.home.join("projects/live").is_dir());
}

#[test]
fn bounded_and_malformed_history_never_authorizes_cleanup() {
    for provider in ["codex", "custom"] {
        for case in ["records", "bytes", "unfinished", "invalid"] {
            let (_temp, env, log) = fixture(provider);
            let mut text = if provider == "codex" {
                record(&env, "gone")
            } else {
                format!("{}\n", json!({"cwd":env.home.join("projects/gone")}))
            };
            match case {
                "records" => text.push_str(&"{}\n".repeat(20_000)),
                "bytes" => text.push_str(&format!("{}\n", json!({"padding":"x".repeat(1024 * 1024)})).repeat(9)),
                "unfinished" => text.push_str("{\"cwd\":\"/unfinished"),
                "invalid" => text.push_str("broken JSON\n"),
                _ => unreachable!(),
            }
            if matches!(case, "records" | "bytes") {
                text.push_str(&record(&env, "live"));
                text.push_str(&record(&env, "latest-gone"));
            }
            write(&log, &text);
            let snapshot = scan::scan(&env).unwrap();
            let item = snapshot["items"].as_object().unwrap().values().next().unwrap();
            assert_eq!(item["ownershipComplete"], false, "{provider}/{case}");
            blocked_in_both_modes(&env, &log, &snapshot);
            assert_eq!(fs::read_to_string(&log).unwrap(), text);
        }
    }
}

// Unreadable files are made with Unix modes.
#[cfg(unix)]
#[test]
fn claude_folder_aggregation_propagates_incomplete_and_unreadable_evidence() {
    use std::os::unix::fs::PermissionsExt;
    for case in ["records", "unfinished", "unreadable", "unreadable-directory"] {
        let (_temp, env, log) = fixture("claude");
        write(&log, format!("{}\n", json!({"cwd":env.home.join("projects/gone")})));
        let other = log.parent().unwrap().join("child/other.jsonl");
        let text = match case {
            "records" => format!("{}{}", "{}\n".repeat(20_000), record(&env, "live")),
            "unfinished" => "{\"cwd\":".into(),
            _ => format!("{}\n", json!({"cwd":env.home.join("projects/live")})),
        };
        write(&other, text);
        let restricted = if case == "unreadable-directory" { other.parent().unwrap() } else { &other };
        if case.starts_with("unreadable") {
            fs::set_permissions(restricted, fs::Permissions::from_mode(0o0)).unwrap();
        }
        let snapshot = scan::scan(&env).unwrap();
        let group = snapshot["claude"].as_object().unwrap().values().next().unwrap();
        assert_eq!(group["ownershipComplete"], false, "{case}");
        blocked_in_both_modes(&env, &log, &snapshot);
        if case.starts_with("unreadable") {
            fs::set_permissions(restricted, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert!(other.exists());
    }
}

#[test]
fn named_folder_without_authoritative_ownership_is_never_cleanup_proof() {
    let (_temp, env, _) = fixture("custom");
    let folder = env.home.join("named/-unknown-project");
    write(&folder.join("history.jsonl"), format!("{}\n", json!({"cwd":env.home.join("projects/gone")})));
    config::save(&env, &json!({"roots":["~/projects"],"presets":[],"custom":[{"id":"custom-named-history","name":"Named","link":{"kind":"named","dir":"~/named","naming":"dashes"}}]})).unwrap();
    let snapshot = scan::scan(&env).unwrap();
    let item = snapshot["items"].as_object().unwrap().values().next().unwrap();
    assert_eq!(item["ownershipComplete"], false);
    blocked_in_both_modes(&env, &folder, &snapshot);
}

#[cfg(unix)]
#[test]
fn unreadable_cwd_logs_invalidate_cached_cleanup_permission() {
    use std::os::unix::fs::PermissionsExt;
    for provider in ["codex", "custom"] {
        let (_temp, env, log) = fixture(provider);
        let text = if provider == "codex" {
            record(&env, "gone")
        } else {
            format!("{}\n", json!({"cwd":env.home.join("projects/gone")}))
        };
        write(&log, text);
        let reviewed = scan::scan(&env).unwrap();
        let p = proposal(&reviewed).clone();
        fs::set_permissions(&log, fs::Permissions::from_mode(0o0)).unwrap();
        let fresh = scan::scan(&env).unwrap();
        let item = fresh["items"].as_object().unwrap().values().next().unwrap();
        assert_eq!(item["ownershipComplete"], false);
        for recovery in ["quarantine", "trash"] {
            assert!(ops::apply_proposal(&env, &reviewed, &p, recovery).is_err());
            assert!(log.exists());
        }
        fs::set_permissions(&log, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
