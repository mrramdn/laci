//! What Laci itself keeps on disk, and letting go of the parts that are safe to free.
use std::{fs, path::Path, time::Duration};

use serde_json::{Value, json};

use crate::{Result, env::Env, files, ops, paths};

/// Names the Electron-based Laci 1.x left in its config folder. Laci 2 runs on WebKit and keeps its web
/// data elsewhere, so none of these is read any more. Only these names are ever removed.
const LEGACY: [&str; 27] = [
    "blob_storage",
    "Cache",
    "Code Cache",
    "Cookies",
    "Cookies-journal",
    "Crashpad",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "declarative_performance_observer.db",
    "declarative_performance_observer.db-journal",
    "DevToolsActivePort",
    "Dictionaries",
    "DIPS",
    "GPUCache",
    "GPUPersistentCache",
    "IndexedDB",
    "Local State",
    "Local Storage",
    "Network Persistent State",
    "Preferences",
    "Service Worker",
    "Session Storage",
    "Shared Dictionary",
    "TransportSecurity",
    "Trust Tokens",
    "Trust Tokens-journal",
];
/// Undo copies younger than this stay: a move from the last week can still be undone completely.
const UNDO_DAYS: u64 = 7;

fn legacy(env: &Env) -> Vec<std::path::PathBuf> {
    LEGACY.iter().map(|name| env.config_dir.join(name)).filter(|p| fs::symlink_metadata(p).is_ok()).collect()
}
fn entry_size(path: &Path) -> u64 {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => files::size(path),
        Ok(meta) => meta.len(),
        Err(_) => 0,
    }
}
/// The undo copies of moves older than a week, with the journals they belong to.
fn old_undo(env: &Env) -> Vec<(std::path::PathBuf, String)> {
    let Ok(dir) = ops::data(env, "backup") else { return vec![] };
    files::entries(&dir)
        .into_iter()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            e.metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|m| m.elapsed().ok())
                .is_some_and(|age| age > Duration::from_secs(UNDO_DAYS * 86_400))
        })
        .map(|e| (e.path(), e.file_name().to_string_lossy().into_owned()))
        .collect()
}

pub fn report(env: &Env) -> Result<Value> {
    let size = |name: &str| ops::data(env, name).map(|p| files::size(&p)).unwrap_or(0);
    let old: u64 = old_undo(env).iter().map(|(p, _)| files::size(p)).sum();
    let legacy: u64 = legacy(env).iter().map(|p| entry_size(p)).sum();
    let parts = [
        json!({"id":"removed","label":"Deleted sessions and quarantined history","about":"Kept so Undo in the Log can put them back. Freeing it makes those deletions final.","bytes":size("orphans"),"free":size("orphans")}),
        json!({"id":"undo","label":"Undo copies of moved projects","about":format!("Copies of agent logs and settings taken before a move rewrote them. Copies older than {UNDO_DAYS} days can go; those moves can then no longer be undone."),"bytes":size("backup"),"free":old}),
        json!({"id":"history","label":"Agent history backup","about":"Copies of your agents' sessions, so a tool that deletes old logs cannot lose them. Nothing is removed from it.","bytes":size("history"),"free":0}),
        json!({"id":"legacy","label":"Files left by Laci 1","about":"Web data of the old Electron app in ~/.config/laci. Laci 2 does not read it.","bytes":legacy,"free":legacy}),
        json!({"id":"journal","label":"Change journal and Log","about":"What Undo needs to know about each change.","bytes":size("journal") + fs::metadata(env.data_dir.join("activity.jsonl")).map_or(0, |m| m.len()),"free":0}),
        json!({"id":"cache","label":"Scan cache","about":"Rebuilt by the next scan.","bytes":files::size(&env.cache_dir),"free":0}),
    ];
    let total: u64 = parts.iter().map(|p| p["bytes"].as_u64().unwrap_or(0)).sum();
    Ok(json!({"parts":parts,"total":total,"dir":paths::tilde(&env.data_dir,&env.home)}))
}

/// Frees one part of `report`. Returns how much was freed and what to tell the Log.
pub fn free(env: &Env, part: &str) -> Result<Value> {
    ops::with_lock(env, || {
        let (freed, title, form) = match part {
            "removed" => {
                let dir = ops::data(env, "orphans")?;
                let mut freed = 0;
                for e in files::entries(&dir) {
                    freed += entry_size(&e.path());
                    remove(&e.path())?;
                }
                // Journals that moved something into the quarantine can no longer be undone.
                mark_journals(env, |entry| {
                    entry["kind"] == "move" && entry["to"].as_str().is_some_and(|to| Path::new(to).starts_with(&dir))
                })?;
                (freed, "Emptied the quarantine of deleted sessions and history", json!({"form":"emptiedKept"}))
            }
            "undo" => {
                let mut freed = 0;
                let mut gone = std::collections::BTreeSet::new();
                for (path, journal) in old_undo(env) {
                    freed += files::size(&path);
                    remove(&path)?;
                    gone.insert(journal);
                }
                mark_ids(env, &gone)?;
                (freed, "Removed undo copies of moves older than a week", json!({"form":"removedOldUndo"}))
            }
            "legacy" => {
                let mut freed = 0;
                for path in legacy(env) {
                    freed += entry_size(&path);
                    remove(&path)?;
                }
                (freed, "Removed files left by Laci 1", json!({"form":"removedLaci1"}))
            }
            _ => return Err("That part cannot be freed".into()),
        };
        Ok(json!({"freed":freed,"title":title,"say":form}))
    })
}
fn remove(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }.map_err(|e| e.to_string())
}
fn mark_ids(env: &Env, ids: &std::collections::BTreeSet<String>) -> Result<()> {
    mark(env, |journal| journal["id"].as_str().is_some_and(|id| ids.contains(id)))
}
fn mark_journals(env: &Env, touches: impl Fn(&Value) -> bool) -> Result<()> {
    mark(env, |journal| journal["entries"].as_array().into_iter().flatten().any(&touches))
}
/// Notes in each matching applied journal that Undo would now be incomplete, so it refuses instead.
fn mark(env: &Env, matches: impl Fn(&Value) -> bool) -> Result<()> {
    let dir = ops::data(env, "journal")?;
    for e in files::entries(&dir) {
        let path = e.path();
        if path.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let Ok(mut journal) = ops::read_journal(&path) else { continue };
        if journal["state"] == "applied" && journal["copiesRemoved"] != true && matches(&journal) {
            journal["copiesRemoved"] = json!(true);
            files::replace(&path, &serde_json::to_vec_pretty(&journal).map_err(|e| e.to_string())?)?;
        }
    }
    Ok(())
}
