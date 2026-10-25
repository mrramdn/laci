//! Human-readable history layered over the v1-compatible transaction journals.
use crate::{Result, config, env::Env, files, ops, paths, readers, sidecar};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
static SEQ: AtomicU64 = AtomicU64::new(0);
fn activity_file(env: &Env) -> std::path::PathBuf {
    env.data_dir.join("activity.jsonl")
}
pub fn record(env: &Env, mut entry: Value) -> Value {
    if !entry.is_object() {
        entry = json!({"title":"Changed Laci","by":"app"});
    }
    let at = files::now();
    entry["id"] = json!(format!(
        "{}-{:x}{:x}",
        at.replace([':', '.'], "-"),
        SEQ.fetch_add(1, Ordering::Relaxed),
        std::process::id()
    ));
    entry["at"] = json!(at);
    let wrote = (|| -> Result<()> {
        let file = activity_file(env);
        paths::home_path(&file.to_string_lossy(), env)?;
        sidecar::plain_path(&file)?;
        files::private_dir(&env.data_dir)?;
        files::rotate_private(&file, &file.with_extension("jsonl.1"), 4 * 1024 * 1024);
        let mut bytes = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        files::private_append(&file).and_then(|mut f| f.write_all(&bytes)).map_err(|e| e.to_string())
    })();
    if let Err(error) = wrote {
        eprintln!("Could not write the activity log: {error}");
    }
    entry
}
/// Tells the Log about a journaled change, with its Undo when it has one.
pub(crate) fn record_journal(env: &Env, journal: &Value, path: Option<&str>, by: &str) {
    let mut entry = json!({"by":by,"title":journal["title"],"path":path,"journal":journal["id"]});
    if journal["say"].is_object() {
        entry["say"] = journal["say"].clone();
    }
    if ops::can_undo(journal) {
        entry["undo"] = json!({"type":"journal","id":journal["id"]});
    }
    if let Some(detail) = ops::recovery(journal) {
        entry["detail"] = json!(detail);
    }
    record(env, entry);
}
fn read_activity(env: &Env) -> Vec<Value> {
    let file = activity_file(env);
    if sidecar::plain_path(&file).is_err() {
        return vec![];
    }
    let Ok(mut f) = fs::File::open(file) else {
        return vec![];
    };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let offset = size.saturating_sub(2 * 1024 * 1024);
    if f.seek(SeekFrom::Start(offset)).is_err() {
        return vec![];
    }
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return vec![];
    }
    let source = String::from_utf8_lossy(&bytes);
    source
        .lines()
        .skip(usize::from(offset > 0))
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .filter(Value::is_object)
        .collect()
}
fn steps(env: &Env, j: &Value) -> Value {
    let entries = j["entries"].as_array().cloned().unwrap_or_default();
    let mut out = vec![];
    let tilde = |v: &Value| paths::tilde(Path::new(v.as_str().unwrap_or("")), &env.home);
    let moves = entries.iter().filter(|e| e["kind"] == "move").collect::<Vec<_>>();
    for e in moves.iter().take(20) {
        out.push(json!({"kind":"move","label":"Moved","from":tilde(&e["from"]),"to":tilde(&e["to"])}));
    }
    if moves.len() > 20 {
        out.push(json!({"kind":"move","label":format!("And {} more moves",moves.len()-20)}));
    }
    // A project chosen for the copy of AI chats stays chosen where it went.
    for pair in entries
        .iter()
        .filter(|e| e["kind"] == "chosen")
        .flat_map(|e| e["pairs"].as_array().cloned().unwrap_or_default())
    {
        out.push(json!({"kind":"write","label":"Kept it chosen for the copy of AI chats","from":tilde(&pair[0]),"to":tilde(&pair[1])}));
    }
    let rewrites = entries.iter().filter(|e| e["kind"] == "rewrite").count();
    if rewrites > 0 {
        out.push(json!({"kind":"rewrite","label":format!("Rewrote the folder path in {rewrites} log file{}",if rewrites==1{""}else{"s"})}));
    }
    for e in entries.iter().filter(|e| e["kind"] == "trash") {
        out.push(json!({"kind":"delete","label":"Moved to the trash","from":tilde(&e["path"])}));
    }
    for e in entries.iter().filter(|e| e["kind"] == "cleared") {
        out.push(json!({"kind":"delete","label":"Deleted build output","from":tilde(&e["path"])}));
    }
    for e in entries.iter().filter(|e| e["kind"] == "file") {
        let path = Path::new(e["path"].as_str().unwrap_or(""));
        if path.file_name().is_some_and(|n| n == "exclude") {
            out.push(json!({"kind":"write","label":"Kept .laci.md out of git","from":tilde(&e["path"])}));
        } else {
            out.push(json!({"kind":"write","label":format!("Edited {}",path.file_name().unwrap_or_default().to_string_lossy()),"from":paths::tilde(path.parent().unwrap_or(path),&env.home)}));
        }
    }
    Value::Array(out)
}
pub fn read_log(env: &Env, limit: usize) -> Vec<Value> {
    let mut acts = read_activity(env);
    acts.reverse();
    let journals = ops::journals(env, 200);
    let by_journal = journals.iter().filter_map(|j| j["id"].as_str().map(|id| (id, j))).collect::<HashMap<_, _>>();
    let covered = acts.iter().filter_map(|a| a["journal"].as_str().map(str::to_owned)).collect::<HashSet<_>>();
    let undone = acts.iter().filter_map(|a| a["undoes"].as_str().map(str::to_owned)).collect::<HashSet<_>>();
    acts.extend(journals.iter().filter(|j| j["id"].as_str().is_some_and(|id| !covered.contains(id))).map(|j| {
        let mut entry = json!({"id":format!("j:{}",j["id"].as_str().unwrap()),"at":j["at"],"by":"app","title":j["title"],"journal":j["id"],"undo":{"type":"journal","id":j["id"]}});
        if j["say"].is_object() {
            entry["say"] = j["say"].clone();
        }
        entry
    }));
    acts.sort_by(|a, b| b["at"].as_str().unwrap_or("").cmp(a["at"].as_str().unwrap_or("")));
    let mut seen = HashSet::new();
    let mut seen_tasks = HashSet::new();
    let mut seen_legacy_tasks = HashSet::new();
    acts.into_iter()
        .take(limit)
        .map(|mut a| {
            let journal = a["journal"].as_str().and_then(|id| by_journal.get(id)).copied();
            let state = journal.map(|j| j["state"].as_str().unwrap_or("failed")).unwrap_or_else(|| {
                if a["id"].as_str().is_some_and(|id| undone.contains(id)) { "undone" } else { "applied" }
            });
            let task_scope = task_scope(&a);
            let legacy_task = task_scope.is_some() && a["undo"]["occurrence"].as_u64().is_none();
            let superseded = a["key"].as_str().is_some_and(|key| seen.contains(key))
                || task_scope.as_ref().is_some_and(|scope| {
                    if legacy_task { seen_tasks.contains(scope) } else { seen_legacy_tasks.contains(scope) }
                });
            if state == "applied" && a["undoes"].is_null() {
                if let Some(key) = a["key"].as_str() {
                    seen.insert(key.to_owned());
                }
                if let Some(scope) = task_scope {
                    seen_tasks.insert(scope.clone());
                    if legacy_task {
                        seen_legacy_tasks.insert(scope);
                    }
                }
            }
            a["state"] = json!(state);
            a["superseded"] = json!(superseded);
            a["canUndo"] = json!(
                a["undo"].is_object()
                    && journal.is_none_or(ops::can_undo)
                    && a["undoes"].is_null()
                    && state == "applied"
                    && !superseded
            );
            if let Some(j) = journal {
                if j["error"].is_string() {
                    a["error"] = j["error"].clone();
                }
                a["steps"] = steps(env, j);
                if let Some(detail) = ops::recovery(j) {
                    a["recovery"] = json!(detail);
                    a["detail"] = json!(detail);
                }
            }
            a
        })
        .collect()
}
fn task_scope(entry: &Value) -> Option<String> {
    let undo = &entry["undo"];
    if !["check", "drop", "add", "edit"].contains(&undo["type"].as_str()?) {
        return None;
    }
    Some(format!(
        "{}:{}:{}",
        entry["path"].as_str()?,
        undo["file"].as_str().unwrap_or(sidecar::SIDECAR),
        readers::strip_md(undo["text"].as_str()?)
    ))
}
fn recorded_checkbox(file: &Path, undo: &Value) -> Result<sidecar::Checkbox> {
    let text = undo["text"].as_str().ok_or("Unknown task")?;
    match (undo["occurrence"].as_u64(), undo["count"].as_u64()) {
        (Some(occurrence), Some(count)) => {
            sidecar::checkbox_occurrence(file, text, occurrence as usize, count as usize)
        }
        (None, None) => sidecar::checkbox(file, 0, text),
        _ => Err("Invalid checkbox identity".into()),
    }
}
fn removed_context(value: &Value) -> Result<sidecar::RemovedCheckbox> {
    Ok(sidecar::RemovedCheckbox {
        raw: value["raw"].as_str().ok_or("Invalid deleted checkbox context")?.to_owned(),
        offset: value["offset"].as_u64().ok_or("Invalid deleted checkbox position")? as usize,
        after_hash: value["afterHash"].as_str().ok_or("Invalid deleted checkbox fingerprint")?.to_owned(),
    })
}
pub fn undo_activity(env: &Env, id: &str, by: &str) -> Result<Value> {
    ops::with_lock(env, || {
        let a = read_log(env, 2000).into_iter().find(|a| a["id"] == id).ok_or("That change is no longer in the log")?;
        if a["canUndo"] != true {
            return Err(if a["superseded"] == true {
                "It was changed again after this. Undo the newer change first."
            } else if a["state"] == "undone" {
                "Already undone"
            } else {
                "This change can't be undone from here"
            }
            .into());
        }
        let undo = &a["undo"];
        let kind = undo["type"].as_str().ok_or("Invalid undo")?;
        let mut out = json!({"refresh":"project"});
        if kind == "journal" {
            // A move of the copy that stopped part-way and that this finished first is told before the Undo, also
            // when the Undo is then refused.
            let mut settled = None;
            let undone = ops::undo_unlocked(env, undo["id"].as_str().ok_or("Missing journal")?, &mut settled);
            if let Some(journal) = &settled {
                record_journal(env, journal, None, by);
            }
            out["journal"] = undone?;
            out["refresh"] = json!("all");
        } else if kind == "config" || kind == "connector" {
            let mut c = config::load(env);
            // The copy of AI chats moves on its own, with its own Undo, so it keeps the identity it has now.
            let copy = crate::backup::chosen(env, &c).and_then(|dir| {
                let key = dir.to_string_lossy().into_owned();
                c["rootIdentities"].get(&key).cloned().map(|id| (key, id))
            });
            if kind == "config" {
                for field in ["roots", "presets"] {
                    if undo[field].is_null() {
                        c.as_object_mut().unwrap().remove(field);
                    } else {
                        c[field] = if field == "roots" {
                            config::restore_roots(env, &undo[field])?
                        } else {
                            undo[field].clone()
                        };
                    }
                }
                c["apps"] = config::validate_apps(&undo["apps"])?;
                for key in ["rootIdentities", "terminalTarget"] {
                    if let Some(value) = undo.get(key) {
                        c[key] = value.clone();
                    }
                }
                if let Some((key, id)) = copy {
                    if !c["rootIdentities"].is_object() {
                        c["rootIdentities"] = json!({});
                    }
                    c["rootIdentities"][key] = id;
                }
                // Entries from before a setting existed carry no key for it and leave it alone.
                for key in ["archiveDir", "reportsDir"] {
                    if let Some(dir) = undo.get(key) {
                        if dir.is_null() {
                            c.as_object_mut().unwrap().remove(key);
                        } else {
                            c[key] = if dir.as_str() == Some("") {
                                json!("")
                            } else {
                                config::restore_roots(env, &json!([dir]))?[0].clone()
                            };
                        }
                    }
                }
            } else if let Some(remove) = undo["remove"].as_str() {
                if let Some(p) = c["presets"].as_array_mut() {
                    p.retain(|x| x != remove);
                }
                if let Some(custom) = c["custom"].as_array_mut() {
                    custom.retain(|x| x["id"] != remove);
                }
            } else if let Some(preset) = undo["preset"].as_str() {
                if !c["presets"].is_array() {
                    c["presets"] = json!([]);
                }
                let presets = c["presets"].as_array_mut().unwrap();
                if !presets.iter().any(|p| p == preset) {
                    presets.push(json!(preset));
                }
            } else if undo["spec"].is_object() {
                let spec = config::validate_connector(env, &undo["spec"])?;
                let custom = c["custom"].as_array_mut().unwrap();
                if !custom.iter().any(|x| x["id"] == spec["id"]) {
                    custom.push(spec);
                }
            } else {
                return Err("Invalid connector undo".into());
            }
            config::save(env, &c)?;
            out["refresh"] = json!("all");
        } else if kind == "copyChoice" {
            // What the change ticked is unticked and what it unticked is ticked again, so a project Laci moved since
            // stays ticked where it went. Nothing the copy holds changes.
            let mut c = config::load(env);
            let now = c.get("backupOnly").cloned().unwrap_or(Value::Null);
            // The folders it ticked or unticked are told where Laci moved them since.
            let moves = ops::moves_since(env, a["at"].as_str().unwrap_or(""));
            let (before, after) = (
                crate::copy_choice::followed(env, &undo["only"], &moves),
                crate::copy_choice::followed(env, &undo["after"], &moves),
            );
            let only = crate::copy_choice::undone(env, &before, &after, &now);
            if only.is_null() {
                c.as_object_mut().ok_or("Invalid config")?.remove("backupOnly");
            } else {
                c["backupOnly"] = only;
            }
            config::save(env, &c)?;
            out["refresh"] = json!("all");
        } else if kind == "report-item" {
            crate::reports::restore_item(env, undo)?;
            out["refresh"] = json!("all");
        } else {
            let dir = paths::workspace_path(a["path"].as_str().ok_or("Missing project")?, env)?;
            sidecar::plain_path(&dir)?;
            if !dir.is_dir() {
                return Err(format!("{} is gone. It may have been moved since.", paths::tilde(&dir, &env.home)));
            }
            if let Some(exclude) = sidecar::exclude_file(&dir) {
                paths::workspace_path(&exclude.to_string_lossy(), env)?;
                sidecar::plain_path(&exclude)?;
            }
            match kind {
                "meta" => sidecar::set_meta(
                    &dir,
                    undo["key"].as_str().ok_or("Unknown field")?,
                    undo["value"].as_str().ok_or("Invalid old value")?,
                )?,
                "check" => {
                    let raw = undo["file"].as_str().ok_or("Unknown task file")?;
                    let file = paths::normalize(&dir.join(raw));
                    if !file.starts_with(&dir) {
                        return Err("Unknown task file".into());
                    }
                    paths::workspace_path(&file.to_string_lossy(), env)?;
                    let task = recorded_checkbox(&file, undo)?;
                    sidecar::toggle_check(
                        &file,
                        task.line,
                        undo["text"].as_str().ok_or("Unknown task")?,
                        undo["done"].as_bool().ok_or("Invalid old checkbox")?,
                    )?;
                }
                "edit" => {
                    let raw = undo["file"].as_str().ok_or("Unknown task file")?;
                    let file = paths::normalize(&dir.join(raw));
                    if !file.starts_with(&dir) {
                        return Err("Unknown task file".into());
                    }
                    paths::workspace_path(&file.to_string_lossy(), env)?;
                    let task = recorded_checkbox(&file, undo)?;
                    sidecar::edit_check(
                        &file,
                        task.line,
                        undo["text"].as_str().ok_or("Unknown task")?,
                        undo["was"].as_str().ok_or("Invalid old text")?,
                    )?;
                }
                "drop" => {
                    let file = dir.join(sidecar::SIDECAR);
                    let task = recorded_checkbox(&file, undo)?;
                    sidecar::delete_check(&file, task.line, undo["text"].as_str().ok_or("Unknown task")?)?
                }
                "add" => {
                    let text = undo["text"].as_str().ok_or("Unknown task")?;
                    let done = undo["done"].as_bool().ok_or("Invalid old checkbox")?;
                    match (undo["occurrence"].as_u64(), undo["count"].as_u64()) {
                        (Some(occurrence), Some(count)) => {
                            let context =
                                if undo["restore"].is_null() { None } else { Some(removed_context(&undo["restore"])?) };
                            sidecar::restore_check(
                                &dir,
                                text,
                                done,
                                occurrence as usize,
                                count as usize,
                                context.as_ref(),
                            )?;
                        }
                        (None, None) => {
                            sidecar::add_next_checked(&dir, text, done)?;
                        }
                        _ => return Err("Invalid checkbox identity".into()),
                    }
                }
                "notes" => sidecar::set_notes(&dir, undo["text"].as_str().ok_or("Invalid old notes")?)?,
                _ => return Err("Unknown undo type".into()),
            }
            out["path"] = json!(dir);
        }
        out["entry"] = record(
            env,
            json!({"by":by,"title":format!("Undid: {}",a["title"].as_str().unwrap_or("change")),"say":{"form":"undid"},"path":a["path"],"undoes":a["id"]}),
        );
        Ok(out)
    })
}
pub fn entry_for_journal(env: &Env, id: &str) -> String {
    read_activity(env)
        .into_iter()
        .find(|a| a["journal"] == id)
        .and_then(|a| a["id"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("j:{id}"))
}
