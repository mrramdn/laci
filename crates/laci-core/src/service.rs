//! Application actions shared by IPC and MCP.
use crate::{Result, activity, agents, config, create, env::Env, files, ops, paths, readers, scan, sidecar};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

pub fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
/// App key, Settings label and built-in default.
const APPS: [(&str, &str, &str); 3] =
    [("terminal", "Terminal app", "kitty"), ("editor", "Editor", "code"), ("files", "File manager", "dolphin")];
fn settings_detail(env: &Env, before: &Value, after: &Value) -> String {
    let mut parts = vec![];
    let roots = |c: &Value| -> Vec<String> {
        array(&c["roots"])
            .iter()
            .filter_map(Value::as_str)
            .map(|s| paths::tilde(&paths::expand(s, &env.home), &env.home))
            .collect()
    };
    let (old, new) = (roots(before), roots(after));
    for (verb, list, other) in [("added", &new, &old), ("removed", &old, &new)] {
        let names: Vec<_> = list.iter().filter(|r| !other.contains(r)).cloned().collect();
        if !names.is_empty() {
            parts.push(format!("Folders: {verb} {}", names.join(", ")));
        }
    }
    for (key, label, fallback) in APPS {
        let (a, b) =
            (before["apps"][key].as_str().unwrap_or(fallback), after["apps"][key].as_str().unwrap_or(fallback));
        if a != b {
            parts.push(format!("{label}: {a} → {b}"));
        }
    }
    let target = |c: &Value| if c["terminalTarget"] == "external" { "external" } else { "built-in" };
    if target(before) != target(after) {
        parts.push(format!("Terminal: {} → {}", target(before), target(after)));
    }
    let archive = |c: &Value| {
        c["archiveDir"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| paths::tilde(&paths::expand(s, &env.home), &env.home))
    };
    if archive(before) != archive(after) {
        parts.push(format!("Archive folder: {}", archive(after).unwrap_or_else(|| "none".into())));
    }
    let catalog = agents::catalog(env);
    let (old, new) = (array(&before["presets"]), array(&after["presets"]));
    let tools: Vec<_> = new
        .iter()
        .filter(|p| !old.contains(p))
        .map(|p| (p, "on"))
        .chain(old.iter().filter(|p| !new.contains(p)).map(|p| (p, "off")))
        .map(|(id, state)| {
            let name = catalog.iter().find(|c| &c["id"] == id).map(|c| string(c, "name")).or(id.as_str());
            format!("{} {state}", name.unwrap_or("Unknown"))
        })
        .collect();
    if !tools.is_empty() {
        parts.push(format!("AI tools: {}", tools.join(", ")));
    }
    parts.join(" · ")
}
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Work needed after a committed action. Full scans subsume the narrower refreshes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Refresh {
    pub full: bool,
    pub agents: bool,
    pub projects: BTreeSet<String>,
    pub watches: bool,
}
impl Refresh {
    pub fn full() -> Self {
        Self { full: true, watches: true, ..Self::default() }
    }
    pub fn agents() -> Self {
        Self { agents: true, ..Self::default() }
    }
    pub fn needed(&self) -> bool {
        self.full || self.agents || !self.projects.is_empty() || self.watches
    }
    pub fn merge(&mut self, other: Self) {
        self.full |= other.full;
        self.agents |= other.agents;
        self.watches |= other.watches;
        self.projects.extend(other.projects);
        if self.full {
            self.agents = false;
            self.projects.clear();
        }
    }
    /// Returns the refreshed snapshot and whether discovery changed its project graph.
    pub fn read(&self, env: &Env, current: Option<Value>) -> Result<(Value, bool)> {
        let Some(mut snapshot) = current.filter(|_| !self.full) else {
            return scan::scan(env).map(|s| (s, true));
        };
        let mut topology = false;
        if self.agents {
            topology = scan::refresh_agents(env, &mut snapshot)?;
        }
        if !topology {
            for id in &self.projects {
                if snapshot["nodes"].get(id).is_some() {
                    scan::refresh(env, &mut snapshot, id)?;
                }
            }
        }
        Ok((snapshot, topology))
    }
}

#[derive(Debug)]
pub struct RequestOutcome {
    pub value: Value,
    pub refresh: Refresh,
}

pub fn mutates(name: &str) -> bool {
    matches!(
        name,
        "meta"
            | "todo"
            | "notes"
            | "archive"
            | "delete"
            | "move"
            | "apply"
            | "undo"
            | "log/undo"
            | "theme"
            | "setup/save"
            | "new"
            | "new/template"
            | "new/recipe"
            | "connector/add"
            | "connector/remove"
            | "backup/restore"
    )
}

pub fn changes_history(name: &str) -> bool {
    matches!(
        name,
        "archive"
            | "delete"
            | "move"
            | "apply"
            | "undo"
            | "log/undo"
            | "setup/save"
            | "new"
            | "connector/add"
            | "connector/remove"
            | "backup/restore"
    )
}

pub struct Service {
    pub env: Env,
    pub current: Option<Value>,
    notes_saved: HashMap<String, (Instant, String)>,
}
impl Service {
    pub fn new(env: Env) -> Self {
        let cached = files::text(&env.cache_dir.join("snapshot-v2.json"))
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|v| v["home"] == env.home.to_string_lossy().as_ref() && v["config"] == config::load(&env))
            .map(|v| v["snapshot"].clone());
        Self { env, current: cached, notes_saved: HashMap::new() }
    }
    pub fn snapshot(&mut self) -> Result<Value> {
        if let Some(s) = &self.current { Ok(s.clone()) } else { self.rescan() }
    }
    pub fn rescan(&mut self) -> Result<Value> {
        let snap = scan::scan(&self.env)?;
        self.cache_snapshot(&snap);
        self.current = Some(snap.clone());
        self.debug(&format!(
            "scanned {} projects in {} ms",
            snap["nodes"].as_object().map_or(0, |m| m.values().filter(|n| n["kind"] == "project").count()),
            snap["tookMs"]
        ));
        Ok(snap)
    }
    pub fn cache_snapshot(&self, snapshot: &Value) {
        let cached = json!({"home":self.env.home,"config":config::load(&self.env),"snapshot":snapshot});
        let _ = files::private_dir(&self.env.cache_dir);
        let _ = files::replace(&self.env.cache_dir.join("snapshot-v2.json"), cached.to_string().as_bytes());
    }
    pub fn debug(&self, message: &str) {
        use std::io::Write;
        let path = self.env.data_dir.join("laci.log");
        if sidecar::plain_path(&path).is_err() || files::private_dir(&self.env.data_dir).is_err() {
            return;
        }
        files::rotate_private(&path, &path.with_extension("log.1"), 1_048_576);
        if let Ok(mut file) = files::private_append(&path) {
            let _ = writeln!(file, "{} {message}", files::now());
        }
    }
    pub fn node(&mut self, id: &str) -> Result<Value> {
        let snap = self.snapshot()?;
        snap["nodes"]
            .get(id)
            .cloned()
            .ok_or_else(|| "That folder is not in the last scan. Rescan and try again.".into())
    }
    pub fn place(&mut self, id: &str) -> Result<Value> {
        if let Ok(node) = self.node(id) {
            return Ok(node);
        }
        let path = paths::workspace_path(id, &self.env)?;
        if !path.is_dir() {
            return Err("That folder is gone".into());
        }
        Ok(json!({"path":path,"name":path.file_name().unwrap_or_default().to_string_lossy()}))
    }
    fn refreshed(&mut self, id: &str) -> Result<Value> {
        self.snapshot()?;
        scan::refresh_tasks(&self.env, self.current.as_mut().ok_or("No scan yet")?, id)
    }
    fn editable(&mut self, id: &str) -> Result<(Value, std::path::PathBuf)> {
        let node = self.node(id)?;
        let dir = paths::workspace_path(string(&node, "path"), &self.env)?;
        if let Some(exclude) = sidecar::exclude_file(&dir) {
            paths::workspace_path(&exclude.to_string_lossy(), &self.env)?;
            sidecar::plain_path(&exclude)?;
        }
        Ok((node, dir))
    }
    fn checkbox(&self, node: &Value, body: &Value, path: &Path) -> Result<sidecar::Checkbox> {
        let file = string(body, "file");
        let text = string(body, "text");
        match (body.get("occurrence"), body.get("count")) {
            (Some(occurrence), Some(count)) => {
                let occurrence = occurrence.as_u64().ok_or("Invalid checkbox occurrence")? as usize;
                let count = count.as_u64().ok_or("Invalid checkbox count")? as usize;
                return sidecar::checkbox_occurrence(path, text, occurrence, count);
            }
            (None, None) => {}
            _ => return Err("Invalid checkbox identity".into()),
        }
        let line = body["line"].as_u64().unwrap_or(0) as usize;
        let known = array(&node["tasks"])
            .into_iter()
            .filter(|task| task["file"] == file && task["text"] == text && task["kind"] == "check")
            .collect::<Vec<_>>();
        let occurrence = known
            .iter()
            .position(|task| line > 0 && task["line"].as_u64() == Some(line as u64))
            .or_else(|| (known.len() == 1).then_some(0))
            .ok_or("Couldn't identify that checkbox. Rescan and try again.")?;
        sidecar::checkbox_occurrence(path, text, occurrence, known.len())
    }
    fn journaled(&mut self, journal: Value, path: Option<&str>, by: &str) -> Result<Value> {
        let mut entry = json!({"by":by,"title":journal["title"],"path":path,"journal":journal["id"]});
        if ops::can_undo(&journal) {
            entry["undo"] = json!({"type":"journal","id":journal["id"]});
        }
        if let Some(detail) = ops::recovery(&journal) {
            entry["detail"] = json!(detail);
        }
        activity::record(&self.env, entry);
        Ok(json!({"journal":journal}))
    }
    pub fn apps(&self) -> Value {
        let c = config::load(&self.env);
        let mut out = json!({});
        for (key, _, fallback) in APPS {
            out[key] = json!(
                self.env
                    .app_overrides
                    .get(key)
                    .cloned()
                    .unwrap_or_else(|| c["apps"][key].as_str().unwrap_or(fallback).into())
            );
        }
        out
    }
    pub fn request(&mut self, name: &str, b: &Value) -> Result<Value> {
        self.request_as(name, b, "app")
    }
    pub fn request_as(&mut self, name: &str, b: &Value, by: &str) -> Result<Value> {
        let mut outcome = self.execute(name, b, by)?;
        if outcome.refresh.needed() {
            match outcome.refresh.read(&self.env, self.current.clone()) {
                Ok((snapshot, _)) => {
                    self.cache_snapshot(&snapshot);
                    self.current = Some(snapshot.clone());
                    if matches!(name, "setup/save" | "connector/add" | "connector/remove") {
                        return Ok(snapshot);
                    }
                    outcome.value["snapshot"] = snapshot;
                }
                Err(error) => {
                    // The disk transaction already succeeded; callers must not retry it as a failed action.
                    self.debug(&format!("{name} saved; refresh failed: {error}"));
                    let mut warnings = array(&outcome.value["warnings"]);
                    warnings.push(json!(format!("Changes saved, but the view could not refresh: {error}")));
                    outcome.value["warnings"] = json!(warnings);
                }
            }
        }
        Ok(outcome.value)
    }
    /// Executes the action without waiting for a scan. Desktop refreshes run outside its service lock.
    pub fn execute(&mut self, name: &str, b: &Value, by: &str) -> Result<RequestOutcome> {
        let apply_kind = if name == "apply" {
            self.snapshot()?["proposals"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|p| p["id"] == b["id"])
                .map(|p| string(&p["action"], "type").to_owned())
        } else {
            None
        };
        let value = self.execute_action(name, b, by)?;
        let refresh = match name {
            "archive" | "delete" | "move" | "undo" | "log/undo" | "setup/save" | "new" => Refresh::full(),
            "connector/add" | "connector/remove" => Refresh { watches: true, ..Refresh::agents() },
            "apply" if matches!(apply_kind.as_deref(), Some("archive" | "trash")) => Refresh::full(),
            "apply" => Refresh { watches: true, ..Refresh::agents() },
            // The warning and the backup line on Today come from the agent pass.
            "backup" if value["skipped"] != true => Refresh::agents(),
            "backup/auto" | "backup/restore" => Refresh::agents(),
            _ => Refresh::default(),
        };
        if changes_history(name)
            && let Some(snapshot) = self.current.as_mut()
        {
            // Grouped proposals can share history files; none remain valid until history is linked again.
            snapshot["proposals"] = json!([]);
        }
        Ok(RequestOutcome { value, refresh })
    }
    fn execute_action(&mut self, name: &str, b: &Value, by: &str) -> Result<Value> {
        let id = string(b, "id");
        match name {
            "snapshot" => self.snapshot(),
            "status" => Ok(json!({"busy":false})),
            "rescan" => self.rescan(),
            "apps" => Ok(self.apps()),
            "meta" => {
                let (node, dir) = self.editable(id)?;
                let key = string(b, "key");
                let value = string(b, "value");
                ops::with_lock(&self.env, || {
                    let latest = readers::tasks(&dir);
                    let before = latest["meta"][key].as_str().unwrap_or("");
                    sidecar::set_meta(&dir, key, value)?;
                    if before != value {
                        activity::record(
                            &self.env,
                            json!({"by":by,"title":format!("{} of {} {}",files::capitalize(key),string(&node,"name"),if value.is_empty(){"cleared".into()}else{format!("set to {value}")}),"path":dir,"key":format!("meta:{}:{key}",dir.display()),"undo":{"type":"meta","key":key,"value":before}}),
                        );
                    }
                    Ok(())
                })?;
                self.refreshed(id)
            }
            "todo" => {
                let (node, dir) = self.editable(id)?;
                let text = string(b, "text");
                let file = string(b, "file");
                let op = string(b, "op");
                let task_path = dir.join(file);
                if op != "add" {
                    if file != ".laci.md" && !array(&node["taskFiles"]).iter().any(|f| f["file"] == file) {
                        return Err("Unknown task file".into());
                    }
                    let checked = paths::workspace_path(&task_path.to_string_lossy(), &self.env)?;
                    if !checked.starts_with(&dir) {
                        return Err("Task file must stay inside the project".into());
                    }
                }
                ops::with_lock(&self.env, || {
                    let (detail, undo, title) = match op {
                        "add" => {
                            let step = text.split_whitespace().collect::<Vec<_>>().join(" ");
                            let step: String = step.chars().take(300).collect();
                            if step.is_empty() {
                                return Err("Write something first".into());
                            }
                            let task = sidecar::add_next_checked(&dir, &step, false)?;
                            (
                                step.clone(),
                                json!({"type":"drop","file":sidecar::SIDECAR,"text":readers::strip_md(&step),"line":task.line,"occurrence":task.occurrence,"count":task.count}),
                                format!("Added a next step to {}", string(&node, "name")),
                            )
                        }
                        "toggle" => {
                            let done = b["done"].as_bool().unwrap_or(false);
                            let task = self.checkbox(&node, b, &task_path)?;
                            let before = task.done;
                            if before == done {
                                return Ok(());
                            }
                            sidecar::toggle_check(&task_path, task.line, text, done)?;
                            (
                                text.into(),
                                json!({"type":"check","file":file,"text":text,"line":task.line,"occurrence":task.occurrence,"count":task.count,"done":before}),
                                format!(
                                    "{} a to-do in {}",
                                    if done { "Ticked" } else { "Unticked" },
                                    string(&node, "name")
                                ),
                            )
                        }
                        "delete" => {
                            if file != ".laci.md" {
                                return Err("Only .laci.md tasks can be deleted here".into());
                            }
                            let task = self.checkbox(&node, b, &task_path)?;
                            let context = sidecar::delete_check_with_context(&task_path, task.line, text)?;
                            let restore =
                                json!({"raw":context.raw,"offset":context.offset,"afterHash":context.after_hash});
                            (
                                text.into(),
                                json!({"type":"add","file":file,"text":text,"line":task.line,"occurrence":task.occurrence,"count":task.count,"done":task.done,"restore":restore}),
                                format!("Deleted a next step from {}", string(&node, "name")),
                            )
                        }
                        _ => return Err("Unknown to-do operation".into()),
                    };
                    activity::record(
                        &self.env,
                        json!({"by":by,"title":title,"detail":detail,"path":dir,"key":format!("todo:{}:{}:{}:{}",dir.display(),string(&undo,"file"),readers::strip_md(&detail),undo["occurrence"].as_u64().unwrap_or(0)),"undo":undo}),
                    );
                    Ok(())
                })?;
                self.refreshed(id)
            }
            "notes" => {
                let (node, dir) = self.editable(id)?;
                let text: String = string(b, "text").chars().take(20_000).collect();
                let previous = self.notes_saved.get(id).cloned();
                let entry_id = ops::with_lock(&self.env, || {
                    let latest = readers::tasks(&dir);
                    let before = latest["notes"].as_str().unwrap_or("");
                    let key = format!("notes:{}", dir.display());
                    let latest_entry = activity::read_log(&self.env, 300).into_iter().find(|e| e["key"] == key);
                    let sitting = by != "app"
                        || previous.as_ref().is_none_or(|(time, entry)| {
                            time.elapsed() > Duration::from_secs(600)
                                || latest_entry.as_ref().is_none_or(|e| e["id"] != *entry || e["canUndo"] != true)
                        });
                    sidecar::set_notes(&dir, &text)?;
                    if sitting && before != text {
                        let entry = activity::record(
                            &self.env,
                            json!({"by":by,"title":format!("Edited the notes of {}",string(&node,"name")),"path":dir,"key":key,"undo":{"type":"notes","text":before}}),
                        );
                        return Ok(Some(string(&entry, "id").to_owned()));
                    }
                    Ok(previous.as_ref().map(|(_, id)| id.clone()))
                })?;
                if let Some(entry) = entry_id {
                    self.notes_saved.insert(id.into(), (Instant::now(), entry));
                }
                self.refreshed(id)
            }
            "archive/plan" => {
                let snap = self.snapshot()?;
                scan::archive_plan(&self.env, &snap, id, b["destination"].as_str())
            }
            "delete/plan" => {
                let node = self.node(id)?;
                crate::deletion::plan(&self.env, &node)
            }
            "delete" => {
                if b["confirm"] != true {
                    return Err("Review the removal plan and confirm before moving to Trash".into());
                }
                let node = self.node(id)?;
                crate::deletion::trash(&self.env, &node)?;
                activity::record(
                    &self.env,
                    json!({"by":by,"title":format!("Moved {} to system Trash",string(&node,"name")),"path":node["path"],"detail":"Restore through your file manager. External agent history was preserved."}),
                );
                Ok(json!({}))
            }
            "archive" => {
                let snap = self.snapshot()?;
                let j = ops::archive_project_to(
                    &self.env,
                    &snap,
                    id,
                    b["destination"].as_str(),
                    b["trashHeavy"].as_bool().unwrap_or(false),
                )?;
                self.journaled(j, Some(id), by)
            }
            "move" => {
                let snap = self.snapshot()?;
                let j = ops::move_project(&self.env, &snap, id, string(b, "destination"), b)?;
                self.journaled(j, Some(id), by)
            }
            "apply" => {
                let snap = self.snapshot()?;
                let p =
                    array(&snap["proposals"]).into_iter().find(|p| p["id"] == id).ok_or("That suggestion is gone")?;
                if p["action"].is_null() {
                    return Err("Nothing to apply here; open the folders and decide".into());
                }
                let j = ops::apply_proposal(&self.env, &snap, &p, b["recovery"].as_str().unwrap_or("quarantine"))?;
                self.journaled(j, p["nodeId"].as_str(), by)
            }
            "undo" => {
                let j = ops::undo(&self.env, id)?;
                let entry = activity::read_log(&self.env, 300).into_iter().find(|e| e["journal"] == j["id"]);
                activity::record(
                    &self.env,
                    json!({"by":by,"title":format!("Undid: {}",string(&j,"title")),"undoes":entry.map(|e|e["id"].clone()).unwrap_or_else(||json!(format!("j:{}",string(&j,"id"))))}),
                );
                Ok(json!({"journal":j}))
            }
            "log" => Ok(
                json!({"entries":activity::read_log(&self.env,300),"file":paths::tilde(&self.env.data_dir.join("laci.log"),&self.env.home)}),
            ),
            "log/undo" => {
                activity::undo_activity(&self.env, id, by)?;
                Ok(json!({}))
            }
            "log/open" => {
                detach(
                    "xdg-open",
                    &[self.env.data_dir.join("laci.log").to_string_lossy().into_owned()],
                    &self.env.home,
                )?;
                Ok(json!({"ok":true}))
            }
            "backup" => {
                let auto = b["auto"] == true;
                let snap = self.snapshot()?;
                // An automatic run is opt-in, at most hourly, and only when a session changed since the last one.
                if auto
                    && (config::load(&self.env)["autoBackup"] != true
                        || snap["backup"]["pending"] == 0
                        || files::age(string(&snap["backup"], "at")) < 1.0 / 24.0)
                {
                    return Ok(json!({"skipped":true}));
                }
                let mut result = ops::backup_history(&self.env, &snap)?;
                let copied = result["copied"].as_u64().unwrap_or(0);
                result["size"] = json!(scan::bytes(result["bytes"].as_u64().unwrap_or(0)));
                result["dest"] = json!(paths::tilde(Path::new(string(&result, "dest")), &self.env.home));
                if copied > 0 || !auto {
                    let kept = format!(
                        "{} kept · {} in {}",
                        scan::plural(result["sessions"].as_u64().unwrap_or(0), "session"),
                        scan::bytes(result["total"].as_u64().unwrap_or(0)),
                        string(&result, "dest")
                    );
                    activity::record(
                        &self.env,
                        json!({"by":if auto {"auto"} else {by},"title":if copied > 0 {format!("Backed up {}",scan::plural(copied,"agent history file"))} else {"Agent history backup is up to date".into()},"detail":kept}),
                    );
                }
                Ok(result)
            }
            "backup/restore" => {
                let snap = self.snapshot()?;
                let result = ops::restore_backup(&self.env, &snap, string(b, "id"))?;
                let name = array(&snap["connectors"])
                    .into_iter()
                    .find(|c| c["provider"] == result["provider"])
                    .map(|c| string(&c, "name").to_owned())
                    .unwrap_or_else(|| "agent".into());
                activity::record(
                    &self.env,
                    json!({"by":by,"title":format!("Restored a {name} session from the backup"),"path":result["restored"],"detail":result["title"]}),
                );
                Ok(result)
            }
            "backup/auto" => {
                let on = b["on"].as_bool().ok_or("Choose on or off")?;
                ops::with_lock(&self.env, || {
                    let mut c = config::load(&self.env);
                    if c["autoBackup"].as_bool().unwrap_or(false) != on {
                        c["autoBackup"] = json!(on);
                        config::save(&self.env, &c)?;
                        activity::record(
                            &self.env,
                            json!({"by":by,"title":format!("Automatic history backup turned {}",if on {"on"} else {"off"})}),
                        );
                    }
                    Ok(())
                })?;
                Ok(json!({"on":on}))
            }
            "theme" => {
                let theme = string(b, "theme");
                if !["", "light", "dark"].contains(&theme) {
                    return Err("Unknown theme".into());
                }
                ops::with_lock(&self.env, || {
                    let mut c = config::load(&self.env);
                    if theme.is_empty() {
                        c.as_object_mut().ok_or("Invalid config")?.remove("theme");
                    } else {
                        c["theme"] = json!(theme);
                    }
                    config::save(&self.env, &c)
                })?;
                Ok(json!({"theme":theme}))
            }
            "setup/info" => self.setup_info(),
            "setup/discover" => self.discover_roots(),
            "setup/save" => {
                let roots = config::validate_roots(&self.env, &b["roots"])?;
                if b.get("terminalTarget").is_some()
                    && !matches!(b["terminalTarget"].as_str(), Some("internal" | "external"))
                {
                    return Err("Unknown terminal target".into());
                }
                let apps = config::validate_apps(&b["apps"])?;
                let archive_dir =
                    b.get("archiveDir").map(|v| config::validate_archive_dir(&self.env, v)).transpose()?;
                let presets = array(&b["presets"]);
                let catalog = agents::catalog(&self.env);
                let existing = config::load(&self.env);
                if presets
                    .iter()
                    .any(|p| !catalog.iter().any(|c| &c["id"] == p) && !array(&existing["presets"]).contains(p))
                {
                    return Err("Unknown connector".into());
                }
                ops::with_lock(&self.env, || {
                    let mut c = config::load(&self.env);
                    let before = json!({"type":"config","roots":c["roots"],"presets":c["presets"],"apps":c["apps"],"archiveDir":c["archiveDir"],"rootIdentities":c["rootIdentities"],"terminalTarget":c["terminalTarget"]});
                    c["roots"] = roots;
                    if let Some(target) = b.get("terminalTarget") {
                        c["terminalTarget"] = target.clone();
                    }
                    c["presets"] = json!(presets);
                    let mut apps = apps;
                    for (key, _, _) in APPS {
                        if self.env.app_overrides.get(key).is_some_and(|o| apps[key].as_str() == Some(o)) {
                            match c["apps"].get(key) {
                                Some(kept) => apps[key] = kept.clone(),
                                None => drop(apps.as_object_mut().and_then(|a| a.remove(key))),
                            }
                        }
                    }
                    c["apps"] = apps;
                    if let Some(archive_dir) = archive_dir {
                        c["archiveDir"] = archive_dir;
                    }
                    let mut locations = array(&c["roots"]);
                    if let Some(dir) = c["archiveDir"].as_str().filter(|dir| !dir.is_empty()) {
                        locations.push(json!(dir));
                    }
                    c["rootIdentities"] = config::root_identities(&self.env, &json!(locations), &c["rootIdentities"]);
                    config::save(&self.env, &c)?;
                    let detail = settings_detail(&self.env, &before, &c);
                    if !detail.is_empty() {
                        activity::record(
                            &self.env,
                            json!({"by":by,"title":"Changed settings","detail":detail,"key":"settings","undo":before}),
                        );
                    }
                    Ok(())
                })?;
                Ok(json!({}))
            }
            "new/info" => Ok(
                json!({"templates":create::templates(&self.env),"templatesDir":paths::tilde(&self.env.config_dir.join("templates"),&self.env.home),"hosts":create::hosts(),"recipes":create::generator::recipes(&self.env)}),
            ),
            "new/template" => create::add_template(&self.env, string(b, "path")),
            "new/recipe" => create::generator::save(&self.env, &b["recipe"]),
            "new/preview" => Ok(create::generator::plan(&self.env, b)?.preview()),
            "new" => {
                let r = create::create_project(&self.env, b)?;
                activity::record(
                    &self.env,
                    json!({"by":by,"title":format!("Created {}",string(b,"name")),"path":r["path"],"detail":r["warnings"]}),
                );
                Ok(r)
            }
            "connector/add" | "connector/remove" => {
                let snap = self.snapshot()?;
                ops::with_lock(&self.env, || {
                    let mut c = config::load(&self.env);
                    if !c["presets"].is_array() {
                        c["presets"] = json!(
                            array(&snap["connectors"])
                                .iter()
                                .filter(|x| x["builtin"] == true)
                                .map(|x| x["id"].clone())
                                .collect::<Vec<_>>()
                        );
                    }
                    let (key, title, undo) = if name == "connector/remove" {
                        let old = array(&snap["connectors"])
                            .into_iter()
                            .find(|c| c["id"] == id)
                            .ok_or("Unknown connector")?;
                        let custom = array(&c["custom"]).into_iter().find(|s| s["id"] == id);
                        c["presets"] = json!(array(&c["presets"]).into_iter().filter(|p| p != id).collect::<Vec<_>>());
                        c["custom"] =
                            json!(array(&c["custom"]).into_iter().filter(|p| p["id"] != id).collect::<Vec<_>>());
                        (
                            id.to_owned(),
                            // A tool Laci only starts has no history to speak of.
                            format!(
                                "Removed {}{}",
                                string(&old, "name"),
                                if old["link"]["kind"] == "none" { "" } else { " history" }
                            ),
                            if let Some(spec) = custom {
                                json!({"type":"connector","spec":spec})
                            } else {
                                json!({"type":"connector","preset":id})
                            },
                        )
                    } else if let Some(preset) = b["preset"].as_str() {
                        let old = agents::catalog(&self.env)
                            .into_iter()
                            .find(|c| c["id"] == preset)
                            .ok_or("Unknown connector")?;
                        let mut presets = array(&c["presets"]);
                        if !presets.contains(&json!(preset)) {
                            presets.push(json!(preset));
                        }
                        c["presets"] = json!(presets);
                        (
                            preset.into(),
                            format!("Added {} history", string(&old, "name")),
                            json!({"type":"connector","remove":preset}),
                        )
                    } else {
                        let mut spec = config::validate_connector(&self.env, b)?;
                        let base = string(&spec, "id").to_owned();
                        let mut n = 2;
                        while array(&c["custom"]).iter().any(|s| s["id"] == spec["id"]) {
                            spec["id"] = json!(format!("{base}-{n}"));
                            n += 1;
                        }
                        let key = string(&spec, "id").to_owned();
                        let mut custom = array(&c["custom"]);
                        custom.push(spec.clone());
                        c["custom"] = json!(custom);
                        (
                            key.clone(),
                            format!(
                                "Added {}{}",
                                string(&spec, "name"),
                                if spec["link"]["kind"] == "none" { "" } else { " history" }
                            ),
                            json!({"type":"connector","remove":key}),
                        )
                    };
                    config::save(&self.env, &c)?;
                    activity::record(
                        &self.env,
                        json!({"by":by,"title":title,"key":format!("connector:{key}"),"undo":undo}),
                    );
                    Ok(())
                })?;
                Ok(json!({}))
            }
            "agent/mcp" => Ok(json!({"agents":crate::mcp_setup::statuses(&self.env)})),
            "agent/mcp/apply" => crate::mcp_setup::change(&self.env, string(b, "provider"), b["remove"] == true, by),
            "health" => {
                let node = self.node(string(b, "id"))?;
                Ok(readers::health(&paths::workspace_path(string(&node, "path"), &self.env)?))
            }
            "ls" => {
                let raw = b["path"].as_str().unwrap_or(self.env.home.to_str().unwrap_or(""));
                let path = paths::workspace_path(raw, &self.env)?;
                if !path.is_dir() {
                    return Err("That folder doesn't exist anymore".into());
                }
                let entries:Vec<_>=files::entries(&path).into_iter().take(5000).map(|e|{let meta=fs::symlink_metadata(e.path()).ok();let link=meta.as_ref().is_some_and(|m|m.is_symlink());
                    let allowed=paths::workspace_path(&e.path().to_string_lossy(),&self.env).is_ok();let dir=allowed&&e.path().is_dir();
                    json!({"name":e.file_name().to_string_lossy(),"path":e.path(),"dir":dir,"link":link,"size":meta.map(|m|m.len()),"at":files::modified(&e.path()),"git":dir&&e.path().join(".git").exists()})}).collect();
                Ok(json!({"path":path,"entries":entries}))
            }
            "ls/newest" => {
                let path = paths::workspace_path(string(b, "path"), &self.env)?;
                let mut out = json!({});
                for e in files::entries(&path).into_iter().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).take(500)
                {
                    let newest = files::walk(&e.path(), false)
                        .filter(|e| e.file_type().is_file() && e.file_name() != ".laci.md")
                        .take(3000)
                        .map(|e| files::modified(e.path()))
                        .max()
                        .unwrap_or_else(|| files::modified(&e.path()));
                    out[e.file_name().to_string_lossy().as_ref()] = json!(newest);
                }
                Ok(out)
            }
            "open/url" => {
                let url = string(b, "url");
                let url = if url.starts_with("https://") || url.starts_with("http://") {
                    url
                } else if url.starts_with("mailto:") {
                    // Only the address: a mail link can also ask the mail program to attach a file.
                    url.split('?').next().unwrap_or(url)
                } else {
                    return Err("Only web and mail addresses can be opened".into());
                };
                detach("xdg-open", &[url.into()], &self.env.home)?;
                Ok(json!({"ok":true}))
            }
            "open" => self.open(b),
            _ => Err(format!("Unknown action: {name}")),
        }
    }
    pub fn setup_info(&mut self) -> Result<Value> {
        let c = config::load(&self.env);
        let roots: Vec<_> = array(&c["roots"])
            .iter()
            .filter_map(Value::as_str)
            .map(|s| json!(paths::expand(s, &self.env.home)))
            .collect();
        Ok(
            json!({"configured":c["roots"].is_array(),"roots":roots,"rootStatus":scan::root_status(&self.env,&c),"archiveDir":c["archiveDir"].as_str().filter(|s|!s.is_empty()).map(|s|paths::expand(s,&self.env.home).to_string_lossy().into_owned()).unwrap_or_default(),"candidates":[],"presets":array(&c["presets"]),"custom":array(&c["custom"]).len(),"apps":self.apps(),"terminalTarget":c["terminalTarget"].as_str().unwrap_or("internal"),"installed":installed_apps()}),
        )
    }
    /// Optional shallow discovery. Opening Settings never walks Home or selects suggestions.
    fn discover_roots(&self) -> Result<Value> {
        let mut candidates = Vec::new();
        let mut inspected = 0usize;
        let started = Instant::now();
        for entry in fs::read_dir(&self.env.home)
            .map_err(|e| e.to_string())?
            .take(2000)
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.'))
            .take(100)
        {
            let mut repos = 0usize;
            for entry in
                walkdir::WalkDir::new(entry.path()).max_depth(3).follow_links(false).into_iter().filter_entry(|e| {
                    e.depth() == 0
                        || (!e.file_name().to_string_lossy().starts_with('.')
                            && !files::HEAVY.contains(&e.file_name().to_string_lossy().as_ref()))
                })
            {
                if inspected >= 4000 || started.elapsed() > Duration::from_secs(2) {
                    break;
                }
                inspected += 1;
                if entry.is_ok_and(|e| e.file_type().is_dir() && e.path().join(".git").is_dir()) {
                    repos += 1;
                }
            }
            candidates.push(json!({"path":entry.path(),"repos":repos}));
            if inspected >= 4000 || started.elapsed() > Duration::from_secs(2) {
                break;
            }
        }
        candidates.sort_by_key(|c| std::cmp::Reverse(c["repos"].as_u64().unwrap_or(0)));
        Ok(json!({"candidates":candidates,"limited":inspected>=4000 || started.elapsed()>Duration::from_secs(2)}))
    }
    pub fn agent_context(&mut self, body: &Value) -> Result<(crate::launch::LaunchRequest, Option<Value>)> {
        let mut body = body.clone();
        if body.get("target").is_none() {
            body["target"] = config::load(&self.env)["terminalTarget"].clone();
        }
        let request = crate::launch::LaunchRequest::from_value(&body)?;
        let snapshot = self.snapshot()?;
        let connected = agents::connectors(&self.env, &config::load(&self.env));
        if !connected.iter().any(|c| c["provider"] == request.provider && c["capabilities"]["launch"] == true) {
            return Err("Add this agent connector before launching it".into());
        }
        let session = if let Some(id) = &request.session_id {
            Some(
                array(&snapshot["sessions"])
                    .into_iter()
                    .find(|s| {
                        s["provider"] == request.provider
                            && s["sessionId"] == *id
                            && connected.iter().any(|c| c["id"] == s["connector"])
                    })
                    .ok_or("That session is no longer available; refresh history")?,
            )
        } else {
            None
        };
        Ok((request, session))
    }
    pub fn action(&mut self, node: &Value, what: &str, arg: &str) -> Result<(Option<String>, bool, String)> {
        let title = string(node, "name").to_owned();
        match what {
            "shell" | "terminal" => Ok((None, false, title)),
            "resume" => {
                let snap = self.snapshot()?;
                let sessions: Vec<_> = array(&snap["sessions"])
                    .into_iter()
                    .filter(|s| s["sessionId"] == arg && s["cwd"] == node["path"])
                    .collect();
                if sessions.len() != 1 {
                    return Err("Unknown or ambiguous session".into());
                }
                let (request, session) = self.agent_context(
                    &json!({"provider":sessions[0]["provider"],"sessionId":arg,"projectPath":node["path"]}),
                )?;
                let command = crate::launch::resolve(&self.env, &request, session.as_ref())?;
                let argv = std::iter::once(&command.executable)
                    .chain(command.args.iter())
                    .map(|v| shell_quote(v))
                    .collect::<Vec<_>>()
                    .join(" ");
                Ok((Some(argv), true, command.title))
            }
            "script" => {
                if !array(&node["stack"]["scripts"]).iter().any(|s| s["name"] == arg) {
                    return Err("Unknown script".into());
                }
                let pm = node["stack"]["packageManager"]
                    .as_str()
                    .filter(|s| ["npm", "pnpm", "yarn", "bun"].contains(s))
                    .unwrap_or("npm");
                Ok((
                    Some(format!("{pm} {}{}", if pm == "npm" { "run " } else { "" }, shell_quote(arg))),
                    true,
                    format!("{title} · {arg}"),
                ))
            }
            "fix" => {
                if !array(&node["issues"]).iter().any(|i| i["code"] == arg) {
                    return Err("Nothing to fix".into());
                }
                let command = match arg {
                    "no-remote" => {
                        format!("gh repo create {} --private --source . --remote origin --push", shell_quote(&title))
                    }
                    "no-commits" => "git add -A && git commit -m 'chore: initial commit'".into(),
                    "dirty" => "git status --short".into(),
                    "unpushed" => "git push".into(),
                    "stash" => "git stash show -p stash@{0}".into(),
                    "no-git" => "git init".into(),
                    "behind" => "git pull --ff-only".into(),
                    _ => return Err("Nothing to fix".into()),
                };
                Ok((Some(command), false, title))
            }
            "summary" => {
                let providers: BTreeSet<_> = agents::connectors(&self.env, &config::load(&self.env))
                    .iter()
                    .filter(|c| c["capabilities"]["launch"] == true)
                    .filter_map(|c| c["provider"].as_str().map(str::to_owned))
                    .collect();
                let provider = if arg.is_empty() && providers.len() == 1 {
                    providers.iter().next().unwrap().as_str()
                } else if providers.contains(arg) {
                    arg
                } else {
                    return Err("Choose a connected agent to write the summary".into());
                };
                let (request, session) = self.agent_context(&json!({
                    "provider":provider,"projectPath":node["path"],
                    "prompt":"Read this project's README, package files and recent commits. Save a two-sentence project summary under ## Summary in .laci.md. Change nothing else."
                }))?;
                let command = crate::launch::resolve(&self.env, &request, session.as_ref())?;
                let argv = std::iter::once(&command.executable)
                    .chain(command.args.iter())
                    .map(|v| shell_quote(v))
                    .collect::<Vec<_>>()
                    .join(" ");
                Ok((Some(argv), true, format!("{title} · summary")))
            }
            _ => Err("Unknown action".into()),
        }
    }
    fn open(&mut self, b: &Value) -> Result<Value> {
        let id = string(b, "id");
        let what = string(b, "what");
        let apps = self.apps();
        if what == "default" {
            let path = paths::workspace_path(id, &self.env)?;
            if !path.exists() {
                return Err("That file is gone".into());
            }
            detach("xdg-open", &[path.to_string_lossy().into_owned()], path.parent().unwrap_or(&self.env.home))?;
        } else if what == "link" {
            let node = self.place(id)?;
            let project = paths::workspace_path(string(&node, "path"), &self.env)?;
            let shown = match link_target(&project, string(b, "arg"))? {
                LinkTarget::Open(file) => {
                    detach("xdg-open", &[file.to_string_lossy().into_owned()], file.parent().unwrap_or(&project))?;
                    false
                }
                LinkTarget::Show(folder) => {
                    detach(string(&apps, "files"), &[folder.to_string_lossy().into_owned()], &folder)?;
                    true
                }
            };
            return Ok(json!({"ok":true,"shown":shown}));
        } else {
            let node = self.place(id)?;
            let cwd = paths::workspace_path(string(&node, "path"), &self.env)?;
            if what == "editor" || what == "files" {
                detach(string(&apps, what), &[cwd.to_string_lossy().into_owned()], &cwd)?;
            } else {
                let (cmd, run, _) = self.action(&node, what, string(b, "arg"))?;
                external_terminal(string(&apps, "terminal"), &cwd, cmd.as_deref(), !run)?;
            }
        }
        Ok(json!({"ok":true}))
    }
}
/// Where a link in a project's README leads.
#[derive(Debug, PartialEq)]
pub enum LinkTarget {
    /// A document inside the project, for the system's default viewer.
    Open(PathBuf),
    /// A folder for the file manager: the target itself, or the one holding a file that is not a document.
    Show(PathBuf),
}
/// File types that only display. Whatever else a link names is shown in its folder, never started.
const DOCUMENTS: [&str; 19] = [
    "md", "markdown", "txt", "rst", "adoc", "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "csv", "tsv", "json",
    "yaml", "yml", "toml", "log",
];
fn percent_decoded(text: &str) -> Option<String> {
    let mut out = Vec::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('%') {
        out.extend_from_slice(&rest.as_bytes()[..at]);
        out.push(u8::from_str_radix(rest.get(at + 1..at + 3)?, 16).ok()?);
        rest = &rest[at + 3..];
    }
    out.extend_from_slice(rest.as_bytes());
    String::from_utf8(out).ok()
}
/// A README is not trusted: its link text can promise one thing and name another. The target must be inside
/// the project, also after links on disk are followed.
pub fn link_target(project: &Path, href: &str) -> Result<LinkTarget> {
    let outside = "That link leads outside this project";
    let raw = href.split(['#', '?']).next().unwrap_or("");
    let decoded = percent_decoded(raw).unwrap_or_else(|| raw.to_owned());
    // Like on code hosts, a leading slash means the top of the project.
    let relative = decoded.trim_start_matches('/');
    if relative.is_empty() || relative.contains('\0') {
        return Err("That link has no file to open".into());
    }
    let target = paths::normalize(&project.join(relative));
    if !target.starts_with(project) {
        return Err(outside.into());
    }
    let real = target.canonicalize().map_err(|_| "That file is gone".to_owned())?;
    if !real.starts_with(project.canonicalize().map_err(|_| "That folder is gone".to_owned())?) {
        return Err(outside.into());
    }
    let document =
        real.extension().and_then(|e| e.to_str()).is_some_and(|e| DOCUMENTS.contains(&e.to_ascii_lowercase().as_str()));
    Ok(if real.is_dir() {
        LinkTarget::Show(real)
    } else if document {
        LinkTarget::Open(real)
    } else {
        LinkTarget::Show(real.parent().unwrap_or(project).to_owned())
    })
}
pub fn installed_apps() -> Value {
    let path = crate::process::host_path();
    let mut result = json!({});
    for (kind, choices) in [
        (
            "terminal",
            vec![
                "kitty",
                "konsole",
                "alacritty",
                "wezterm",
                "foot",
                "ghostty",
                "gnome-terminal",
                "xfce4-terminal",
                "xterm",
            ],
        ),
        ("editor", vec!["code", "cursor", "zed", "codium", "windsurf", "subl", "kate", "gnome-text-editor"]),
        ("files", vec!["dolphin", "nautilus", "thunar", "nemo", "pcmanfm", "caja"]),
    ] {
        result[kind] = json!(
            choices
                .into_iter()
                .filter(|bin| std::env::split_paths(&path).any(|p| p.join(bin).is_file()))
                .collect::<Vec<_>>()
        );
    }
    result
}
pub fn detach(program: &str, args: &[String], cwd: &Path) -> Result<()> {
    let mut child = crate::process::command(program)
        .args(args)
        .current_dir(cwd)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't open {program}: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
fn external_terminal(app: &str, cwd: &Path, cmd: Option<&str>, confirm: bool) -> Result<()> {
    let d = cwd.to_string_lossy().into_owned();
    let mut args = match app {
        "kitty" => vec!["--directory".into(), d],
        "konsole" => vec!["--workdir".into(), d],
        "alacritty" => vec!["--working-directory".into(), d],
        "wezterm" => vec!["start".into(), "--cwd".into(), d],
        _ => Vec::new(),
    };
    if let Some(cmd) = cmd {
        args.push(if app == "wezterm" || app == "gnome-terminal" { "--" } else { "-e" }.into());
        let script = if confirm {
            "printf '$ %s\\n' \"$0\"; read -r -p 'Press Enter to run, Ctrl+C to cancel ' _ && eval \"$0\"; exec \"${SHELL:-bash}\""
        } else {
            "eval \"$0\"; exec \"${SHELL:-bash}\""
        };
        args.extend(["bash".into(), "-lc".into(), script.into(), cmd.into()]);
    }
    detach(app, &args, cwd)
}
