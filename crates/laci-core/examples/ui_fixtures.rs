//! Records what the engine answers to the requests the interface makes. The browser preview (`ui/preview.html`)
//! plays these answers back. `scripts/ui-fixtures.mjs` runs this on a demo home and tidies the result.
//!
//! Usage: `ui_fixtures <demo-home> <out.json>`.
//!
//! Saving the first-run setup and a rescan are the only writes, and they stay inside the demo home. Everything else
//! is a read. Nothing outside the demo home may run, so PATH can only list folders inside it, and Git must not reach
//! the network: the example refuses to start without `GIT_ALLOW_PROTOCOL=file`. (A Trash plan asks the project's
//! remote. With that setting Git refuses at once, and the plan says it could not verify the remote.)
//! `LACI_DEMO_NOW` is the time the demo home was made for. The engine reads the real clock, so the script stops it at
//! that time: statuses and "Due in 5 days" come out the same on every day. Nothing in the demo home is newer than
//! that time, so a later one can only be a time the disk gave while recording, and it is set to `LACI_DEMO_NOW`.
use chrono::{DateTime, SecondsFormat, Utc};
use laci_core::{Result, env::Env, launch, service::Service};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

/// The agents Laci can start. Their model lists are read without starting them.
const PROVIDERS: [&str; 3] = ["claude", "codex", "antigravity"];
/// A demo home has a few dozen folders. More means the wrong home was given.
const MAX_FOLDERS: usize = 400;

fn main() {
    if let Err(error) = run() {
        eprintln!("ui_fixtures: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (Some(home), Some(out), None) = (args.next(), args.next(), args.next()) else {
        return Err("usage: ui_fixtures <demo-home> <out.json>".into());
    };
    let home = PathBuf::from(home);
    if !home.is_absolute() || !home.join("project").is_dir() {
        return Err(format!("{} is not a demo home made by scripts/demo.ts", home.display()));
    }
    guard(&home)?;
    let now = std::env::var("LACI_DEMO_NOW").map_err(|_| "set LACI_DEMO_NOW to the time the demo home was made for")?;
    let now = DateTime::parse_from_rfc3339(&now).map_err(|e| format!("LACI_DEMO_NOW: {e}"))?.to_utc();
    if Utc::now().timestamp() != now.timestamp() {
        return Err("the clock is not stopped at LACI_DEMO_NOW. Run scripts/ui-fixtures.mjs instead".into());
    }

    let mut fixtures = record(&home)?;
    let stamp = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    pin_times(&mut fixtures, now, &stamp);
    steady(&mut fixtures, &stamp);
    fixtures["meta"] = json!({"now":stamp,"home":home});
    let mut text = serde_json::to_string_pretty(&fixtures).map_err(|e| e.to_string())?;
    text.push('\n');
    fs::write(out, text).map_err(|e| e.to_string())
}

/// Programs the engine starts are found on PATH. With only folders of the demo home on it, none of your own tools
/// (`gh` asking GitHub who you are, an agent) can run, and Git can't be sent to a remote.
fn guard(home: &Path) -> Result<()> {
    if std::env::var("GIT_ALLOW_PROTOCOL").as_deref() != Ok("file") {
        return Err("set GIT_ALLOW_PROTOCOL=file so Git can't reach the network".into());
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    if std::env::split_paths(&path).any(|dir| !dir.starts_with(home)) {
        return Err("PATH may only list folders inside the demo home. Run scripts/ui-fixtures.mjs instead".into());
    }
    Ok(())
}

fn record(home: &Path) -> Result<Value> {
    let mut env = Env::for_home(home.to_owned());
    // Where an installed Laci lives, so the MCP lines read like a real machine's.
    env.program = PathBuf::from("/usr/bin/laci");
    let mut service = Service::new(env.clone());
    let mut ask = |name: &str, body: Value| service.request(name, &body).map_err(|e| format!("{name}: {e}"));

    // The setup a person finishes on the first run: the project folder and the reports folder, with the default
    // archive folder, two history connectors and the default apps.
    ask(
        "setup/save",
        json!({"roots":["~/project"],"archiveDir":"","reportsDir":"~/Documents/agent-reports","presets":["claude","codex"],"apps":{},"terminalTarget":"internal"}),
    )?;
    ask("rescan", json!({}))?;

    let mut fixtures = json!({});
    for name in ["snapshot", "apps", "setup/info", "setup/discover", "log", "storage", "new/info", "agent/mcp"] {
        fixtures[name] = ask(name, json!({}))?;
    }
    for provider in PROVIDERS {
        fixtures["agent/models"][provider] = launch::known(&env, provider)?;
    }
    fixtures["assistant/prompt"]["review"] = ask("assistant/prompt", json!({"kind":"review"}))?;

    let snapshot = fixtures["snapshot"].clone();
    let nodes = snapshot["nodes"].as_object().ok_or("The scan has no folders")?;
    let mut tasks = vec![];
    for project in nodes.values().filter(|n| n["kind"] == "project") {
        let id = project["id"].clone();
        let key = id.as_str().unwrap_or_default();
        fixtures["health"][key] = ask("health", json!({"id":id}))?;
        if project["archived"] != true {
            fixtures["archive/plan"][key] = ask("archive/plan", json!({"id":id}))?;
        }
        fixtures["delete/plan"][key] = ask("delete/plan", json!({"id":id}))?;
        for task in project["tasks"].as_array().into_iter().flatten().filter(|t| t["done"] == false) {
            let body = json!({"kind":"task","id":id,"file":task["file"],"text":task["text"]});
            tasks.push(json!({"id":id,"file":task["file"],"text":task["text"],"reply":ask("assistant/prompt", body)?}));
        }
    }
    fixtures["assistant/prompt"]["tasks"] = json!(tasks);

    let mut folders = vec![home.to_owned(), home.join("Documents"), home.join("Documents/agent-reports")];
    folders.extend(below(&home.join("project"))?);
    for folder in folders {
        let key = folder.to_string_lossy().into_owned();
        fixtures["ls"][&key] = ask("ls", json!({"path":key}))?;
        fixtures["ls/newest"][&key] = ask("ls/newest", json!({"path":key}))?;
    }

    for report in snapshot["reports"].as_array().into_iter().flatten() {
        let id = report["id"].clone();
        fixtures["reports/read"][id.as_str().unwrap_or_default()] = ask("reports/read", json!({"id":id}))?;
    }
    Ok(fixtures)
}

/// Every folder below `root`, and `root`. Git's own folders are left out: nobody opens them.
fn below(root: &Path) -> Result<Vec<PathBuf>> {
    let mut found = vec![];
    let mut pending = vec![root.to_owned()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) && entry.file_name() != ".git" {
                pending.push(entry.path());
            }
        }
        found.push(dir);
        if found.len() > MAX_FOLDERS {
            return Err(format!("{} has more than {MAX_FOLDERS} folders", root.display()));
        }
    }
    found.sort();
    Ok(found)
}

/// Times the disk gave while recording (when a folder was made, when the engine wrote a file) are replaced by
/// `stamp`. The demo home has nothing newer than `now`, so a later time can only have come from this run.
fn pin_times(value: &mut Value, now: DateTime<Utc>, stamp: &str) {
    match value {
        Value::String(text) => {
            if DateTime::parse_from_rfc3339(text).is_ok_and(|at| at > now) {
                *text = stamp.to_owned();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| pin_times(item, now, stamp)),
        Value::Object(fields) => fields.values_mut().for_each(|field| pin_times(field, now, stamp)),
        _ => {}
    }
}

/// What differs from run to run, or from machine to machine, gets a fixed and believable value.
fn steady(fixtures: &mut Value, now: &str) {
    fixtures["snapshot"]["host"] = json!("demo");
    fixtures["snapshot"]["tookMs"] = json!(40);
    disks(&mut fixtures["snapshot"]["rootStatus"]);
    disks(&mut fixtures["setup/info"]["rootStatus"]);
    // A folder's own size is the file system's business. 4096 is what most of them report.
    for listing in fixtures["ls"].as_object_mut().into_iter().flat_map(Map::values_mut) {
        for entry in listing["entries"].as_array_mut().into_iter().flatten().filter(|e| e["dir"] == true) {
            entry["size"] = json!(4096);
        }
    }
    log_ids(&mut fixtures["log"]["entries"], now);
    // The Log and the scan cache hold the home's path and the scan's timing, so their size is not fixed.
    let sizes = [("journal", 12_288), ("cache", 524_288)];
    let mut total = 0;
    for part in fixtures["storage"]["parts"].as_array_mut().into_iter().flatten() {
        if let Some((_, bytes)) = sizes.iter().find(|(id, _)| part["id"] == *id) {
            part["bytes"] = json!(bytes);
        }
        total += part["bytes"].as_u64().unwrap_or(0);
    }
    fixtures["storage"]["total"] = json!(total);
}

/// Which disk a folder is on, and where on it, belongs to this machine.
fn disks(roots: &mut Value) {
    for (i, root) in roots.as_array_mut().into_iter().flatten().enumerate() {
        root["device"] = json!(2049);
        root["inode"] = json!(1000 + i);
    }
}

/// The Log's ids hold the time to the millisecond and the process id. They are numbered instead, newest highest.
/// Entries point at each other by id.
fn log_ids(entries: &mut Value, now: &str) {
    let entries: Vec<&mut Value> = entries.as_array_mut().into_iter().flatten().collect();
    let prefix = now.replace([':', '.'], "-");
    let ids: BTreeMap<String, String> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, entry)| Some((entry["id"].as_str()?.to_owned(), format!("{prefix}-{}", entries.len() - i))))
        .collect();
    for entry in entries {
        for key in ["id", "undoes"] {
            if let Some(new) = entry[key].as_str().and_then(|old| ids.get(old)) {
                entry[key] = json!(new);
            }
        }
    }
}
