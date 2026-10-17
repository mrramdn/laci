use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Instant,
};

use rayon::prelude::*;
use regex::Regex;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use crate::{Result, agents, config, env::Env, files, paths, platform, readers};

static DOCS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(readme|notes?|handoff|todo|tasks)[\w.-]*\.md$").expect("docs pattern"));
static ARCHIVE_COMPONENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^_?archived?s?$").expect("archive pattern"));
static GENERIC_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(docs?|root|app|api|web|frontend|backend|server|client|site|rewrite|main|src)$")
        .expect("generic pattern")
});
static ARCHIVE_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/_archive(?:/|$)").expect("archive path pattern"));

const CODE: &[&str] = &[
    "package.json",
    "go.mod",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "pubspec.yaml",
    "composer.json",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "CMakeLists.txt",
    "Dockerfile",
    "docker-compose.yml",
    "compose.yaml",
    "wp-config.php",
    "deno.json",
    "shopify.theme.toml",
    "artisan",
];

fn check_root_identity(path: &Path, cfg: &Value) -> Result<()> {
    crate::sidecar::plain_path(path)?;
    let meta = std::fs::metadata(path).map_err(|_| "Folder or drive is unavailable".to_owned())?;
    if !meta.is_dir() {
        return Err("Location is no longer a folder".into());
    }
    if let Some(expected) = cfg["rootIdentities"].get(path.to_string_lossy().as_ref())
        && platform::identity(path, &meta).ok().is_none_or(|id| !id.matches(expected))
    {
        return Err("The selected folder or drive has changed; select it again to use it".into());
    }
    Ok(())
}

pub(crate) fn check_archive_destination(env: &Env, dest: &Path) -> Result<()> {
    paths::workspace_path(&dest.to_string_lossy(), env)?;
    let cfg = config::load(env);
    // Scan roots are deduplicated, but a nested archive selection has its own identity.
    for root in paths::workspace_roots(env).into_iter().filter(|root| dest.starts_with(root)) {
        check_root_identity(&root, &cfg)?;
    }
    Ok(())
}

/// Configured locations stay visible when a disk is disconnected or cannot be read.
pub fn root_status(env: &Env, cfg: &Value) -> Vec<Value> {
    roots(env, cfg)
        .into_iter()
        .map(|path| {
            let checked = (|| -> Result<()> {
                check_root_identity(&path, cfg)?;
                paths::workspace_path(&path.to_string_lossy(), env)?;
                std::fs::read_dir(&path).map_err(|_| "Folder cannot be read".to_owned())?;
                Ok(())
            })();
            match checked {
                Ok(()) => match std::fs::metadata(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|meta| platform::identity(&path, &meta))
                {
                    Ok(id) => {
                        let mut status = id.to_json();
                        status["path"] = json!(path);
                        status["available"] = json!(true);
                        status
                    }
                    Err(_) => json!({"path":path,"available":false,"reason":"Folder or drive became unavailable"}),
                },
                Err(reason) => json!({"path":path,"available":false,"reason":reason}),
            }
        })
        .collect()
}

#[derive(Clone)]
struct Found {
    path: PathBuf,
    kind: &'static str,
    typ: Option<&'static str>,
    git: bool,
    children: Vec<Found>,
}
impl Found {
    fn has_repo(&self) -> bool {
        self.git || self.children.iter().any(Self::has_repo)
    }
}

fn detect(env: &Env, path: &Path, agent_paths: &BTreeSet<PathBuf>, depth: usize) -> Option<Found> {
    if paths::workspace_path(&path.to_string_lossy(), env).is_err() || !path.is_dir() {
        return None;
    }
    let entries = files::entries(path);
    let regular: Vec<_> = entries
        .iter()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let git = entries.iter().any(|e| e.file_name() == ".git");
    let code = regular.iter().any(|f| CODE.contains(&f.as_str()) || f.ends_with(".csproj") || f.ends_with(".sln"));
    let markdown = regular.iter().any(|f| f.to_lowercase().ends_with(".md"));
    if git {
        return Some(Found {
            path: path.to_owned(),
            kind: "project",
            typ: Some(if code || !markdown { "code" } else { "docs" }),
            git,
            children: Vec::new(),
        });
    }
    let mut children = Vec::new();
    if depth < 6 {
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().is_ok_and(|t| t.is_dir())
                || name.starts_with('.')
                || files::HEAVY.contains(&name.as_str())
            {
                continue;
            }
            if let Some(child) = detect(env, &entry.path(), agent_paths, depth + 1) {
                children.push(child);
            }
        }
    }
    if code && !children.iter().any(Found::has_repo) {
        return Some(Found { path: path.to_owned(), kind: "project", typ: Some("code"), git, children: Vec::new() });
    }
    if !children.is_empty() {
        return Some(Found { path: path.to_owned(), kind: "folder", typ: None, git, children });
    }
    if (depth > 0 || explicitly_archived(path))
        && (agent_paths.contains(path) || regular.iter().any(|f| DOCS.is_match(f)))
    {
        return Some(Found { path: path.to_owned(), kind: "project", typ: Some("docs"), git, children: Vec::new() });
    }
    None
}

fn explicitly_archived(path: &Path) -> bool {
    files::text(&path.join(".laci.md")).is_some_and(|text| readers::parse_meta(&text)["status"] == "archived")
}

fn found_nodes(env: &Env, f: &Found, parent: Option<&str>, archive_dir: Option<&Path>, out: &mut Vec<Value>) {
    let id = f.path.to_string_lossy().into_owned();
    let mut n = json!({"id":id,"path":id,"name":f.path.file_name().unwrap_or_default().to_string_lossy(),"kind":f.kind,"children":f.children.iter().map(|c|c.path.to_string_lossy().into_owned()).collect::<Vec<_>>()});
    n["archived"] = json!(
        explicitly_archived(&f.path)
            || archive_dir.is_some_and(|dir| f.path.starts_with(dir))
            || f.path
                .strip_prefix(&env.home)
                .unwrap_or(&f.path)
                .components()
                .any(|c| { ARCHIVE_COMPONENT.is_match(&c.as_os_str().to_string_lossy()) })
    );
    if let Some(parent) = parent {
        n["parent"] = json!(parent);
    }
    if let Some(typ) = f.typ {
        n["type"] = json!(typ);
    }
    out.push(n);
    for child in &f.children {
        found_nodes(env, child, Some(&id), archive_dir, out);
    }
}

fn roots(env: &Env, cfg: &Value) -> Vec<PathBuf> {
    let mut roots: Vec<_> = if let Some(list) = cfg["roots"].as_array() {
        list.iter().filter_map(Value::as_str).map(|s| paths::expand(s, &env.home)).filter(|p| p.is_absolute()).collect()
    } else {
        Vec::new()
    };
    if let Some(dir) = configured_archive(env, cfg)
        && dir.is_absolute()
        && !roots.iter().any(|root| dir.starts_with(root))
    {
        roots.retain(|root| !root.starts_with(&dir));
        roots.push(dir);
    }
    roots
}

fn configured_archive(env: &Env, cfg: &Value) -> Option<PathBuf> {
    cfg["archiveDir"].as_str().filter(|s| !s.is_empty()).map(|s| paths::expand(s, &env.home))
}

fn available_roots(env: &Env, cfg: &Value) -> Vec<PathBuf> {
    root_status(env, cfg)
        .into_iter()
        .filter(|s| s["available"] == true)
        .filter_map(|s| s["path"].as_str().map(PathBuf::from))
        .collect()
}

pub fn scan(env: &Env) -> Result<Value> {
    let started = Instant::now();
    let cfg = config::load(env);
    let roots = roots(env, &cfg);
    let on = agents::connectors(env, &cfg);
    let history = agents::read_all(env, &on);
    let found = available_roots(env, &cfg).iter().filter_map(|r| detect(env, r, &history.paths, 0)).collect();
    build(env, cfg["roots"].is_array(), roots, on, history, found, started)
}

fn build(
    env: &Env,
    configured: bool,
    roots: Vec<PathBuf>,
    on: Vec<Value>,
    mut history: agents::AgentData,
    found: Vec<Found>,
    started: Instant,
) -> Result<Value> {
    let root_ids: Vec<_> = found.iter().map(|f| f.path.to_string_lossy().into_owned()).collect();
    let mut blanks = Vec::new();
    let archive_dir = configured_archive(env, &config::load(env));
    for f in &found {
        found_nodes(env, f, None, archive_dir.as_deref(), &mut blanks);
    }
    // Bound subprocess and disk concurrency, even on hosts reporting many CPU cores.
    let pool = rayon::ThreadPoolBuilder::new().num_threads(6).build().map_err(|e| e.to_string())?;
    let enriched: Vec<_> = pool.install(|| {
        blanks
            .into_par_iter()
            .filter_map(|blank| {
                let path = Path::new(blank["path"].as_str()?);
                let mut n =
                    if blank["kind"] == "folder" { readers::folder(env, path) } else { readers::project(env, path) }
                        .ok()?;
                for key in ["kind", "type", "parent", "children", "archived"] {
                    if !blank[key].is_null() {
                        n[key] = blank[key].clone();
                    }
                }
                if n["kind"] == "folder" {
                    for key in ["type", "git", "stack", "size", "ownActivity", "lastActivity"] {
                        n.as_object_mut()?.remove(key);
                    }
                }
                let root = n["git"]["rootCommit"].as_str().filter(|s| !s.is_empty());
                n["stableId"] = json!(if let Some(root) = root {
                    format!("git:{}", &root[..root.len().min(12)])
                } else {
                    format!("p:{}", &format!("{:x}", Sha1::digest(path.to_string_lossy().as_bytes()))[..12])
                });
                Some(n)
            })
            .collect()
    });
    let mut nodes: BTreeMap<String, Value> =
        enriched.into_iter().filter_map(|n| Some((n["id"].as_str()?.to_owned(), n))).collect();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for n in nodes.values() {
        *counts.entry(n["name"].as_str().unwrap_or("").to_owned()).or_default() += 1;
    }
    let names: BTreeMap<_, _> =
        nodes.iter().map(|(id, n)| (id.clone(), n["name"].as_str().unwrap_or("").to_owned())).collect();
    for n in nodes.values_mut() {
        let name = n["name"].as_str().unwrap_or("");
        let label = if let Some(parent) = n["parent"].as_str().and_then(|id| names.get(id))
            && (counts.get(name).copied().unwrap_or(0) > 1 || GENERIC_NAME.is_match(name))
        {
            format!("{parent}/{name}")
        } else {
            name.to_owned()
        };
        n["label"] = json!(label);
        let path = Path::new(n["path"].as_str().unwrap_or(""));
        for c in on.iter().filter(|c| c["link"]["kind"] == "inside") {
            if let Some(item) = agents::read_inside(env, c, path) {
                history.items.insert(item["id"].as_str().unwrap_or("").to_owned(), item);
            }
        }
    }
    let host =
        files::read_limit(Path::new("/etc/hostname"), 256).unwrap_or_else(|| "localhost".into()).trim().to_owned();
    let mut snapshot = json!({"scannedAt":files::now(),"home":env.home,"host":host,"roots":roots,"configured":configured,"rootIds":root_ids,"nodes":nodes,
        "claude":history.claude,"items":history.items,"connectors":[],"suggestions":[],"global":{"claude":[],"items":[]},"orphans":{"claude":[],"items":[]},"unmatched":[],"proposals":[],"warnings":[],"tookMs":0});
    snapshot["sessions"] = json!(history.sessions);
    snapshot["rootStatus"] = json!(root_status(env, &config::load(env)));
    snapshot["terminalTarget"] = json!(config::load(env)["terminalTarget"].as_str().unwrap_or("internal"));
    link(env, &mut snapshot, &on, &history.paths, &history.mentions);
    settle(env, &mut snapshot);
    plan(env, &mut snapshot);
    crate::reports::attach(env, &mut snapshot);
    snapshot["tookMs"] = json!(started.elapsed().as_millis() as u64);
    Ok(snapshot)
}

/// Relinks history while retaining project metadata. Agent-only document folders still need discovery.
pub fn refresh_agents(env: &Env, snapshot: &mut Value) -> Result<bool> {
    let started = Instant::now();
    let cfg = config::load(env);
    let roots = roots(env, &cfg);
    let on = agents::connectors(env, &cfg);
    let mut history = agents::read_all(env, &on);
    let found: Vec<_> = available_roots(env, &cfg).iter().filter_map(|r| detect(env, r, &history.paths, 0)).collect();
    let mut graph = Vec::new();
    let archive_dir = configured_archive(env, &cfg);
    for node in &found {
        found_nodes(env, node, None, archive_dir.as_deref(), &mut graph);
    }
    let same_graph = snapshot["nodes"].as_object().is_some_and(|nodes| {
        nodes.len() == graph.len()
            && graph.iter().all(|node| {
                nodes.get(string(node, "id")).is_some_and(|old| {
                    ["kind", "type", "parent", "children", "archived"].iter().all(|key| old[key] == node[key])
                })
            })
    });
    if !same_graph {
        *snapshot = build(env, cfg["roots"].is_array(), roots, on, history, found, started)?;
        return Ok(true);
    }
    for node in snapshot["nodes"].as_object_mut().into_iter().flatten().map(|(_, n)| n) {
        node["agents"]["claude"] = json!([]);
        node["agents"]["items"] = json!([]);
        for connector in on.iter().filter(|c| c["link"]["kind"] == "inside") {
            if let Some(item) = agents::read_inside(env, connector, Path::new(string(node, "path"))) {
                history.items.insert(string(&item, "id").to_owned(), item);
            }
        }
    }
    snapshot["roots"] = json!(roots);
    snapshot["rootStatus"] = json!(root_status(env, &cfg));
    snapshot["sessions"] = json!(history.sessions);
    snapshot["claude"] = json!(history.claude);
    snapshot["items"] = json!(history.items);
    snapshot["global"] = json!({"claude":[],"items":[]});
    snapshot["orphans"] = json!({"claude":[],"items":[]});
    snapshot["unmatched"] = json!([]);
    snapshot["warnings"] = json!([]);
    link(env, snapshot, &on, &history.paths, &history.mentions);
    settle(env, snapshot);
    plan(env, snapshot);
    // Sessions changed, and with them the projects a report reaches through its session ids.
    crate::reports::attach(env, snapshot);
    Ok(false)
}

/// Task edits need only their markdown reread, not Git history or a directory walk.
pub fn refresh_tasks(env: &Env, snapshot: &mut Value, id: &str) -> Result<Value> {
    let node = &mut snapshot["nodes"][id];
    let path = Path::new(node["path"].as_str().ok_or("Project path is missing")?);
    let tasks = readers::tasks(path);
    for key in ["meta", "tasks", "taskFiles", "sidecar", "notes"] {
        if let Some(value) = tasks.get(key) {
            node[key] = value.clone();
        } else if let Some(node) = node.as_object_mut() {
            node.remove(key);
        }
    }
    if let Some(summary) = tasks["summary"].as_str().filter(|s| !s.is_empty()) {
        node["summary"] = json!({"text":summary,"source":".laci.md"});
    }
    settle(env, snapshot);
    plan(env, snapshot);
    Ok(snapshot["nodes"][id].clone())
}

/// Re-read the folder without traversing the rest of the project roots.
pub fn refresh(env: &Env, snapshot: &mut Value, id: &str) -> Result<Value> {
    let old = snapshot["nodes"][id].clone();
    if !old.is_object() {
        return Err("Project was not found; rescan first".into());
    }
    let path = Path::new(old["path"].as_str().ok_or("Project path is missing")?);
    let mut node = if old["kind"] == "folder" { readers::folder(env, path) } else { readers::project(env, path) }?;
    for key in ["id", "label", "kind", "type", "parent", "children", "agents", "archived", "stableId"] {
        if !old[key].is_null() {
            node[key] = old[key].clone();
        }
    }
    if let Some(root) = node["git"]["rootCommit"].as_str().filter(|s| !s.is_empty()) {
        node["stableId"] = json!(format!("git:{}", &root[..root.len().min(12)]));
    }
    if node["kind"] == "folder" {
        for key in ["type", "git", "stack", "size", "ownActivity", "lastActivity"] {
            node.as_object_mut().expect("node object").remove(key);
        }
    }
    snapshot["nodes"][id] = node;
    settle(env, snapshot);
    plan(env, snapshot);
    Ok(snapshot["nodes"][id].clone())
}

fn append(snapshot: &mut Value, field: &str, key: &str, value: Value) {
    snapshot[field][key].as_array_mut().expect("history arrays").push(value);
}
fn nearest(nodes: &Value, path: &str) -> Option<String> {
    nodes
        .as_object()?
        .values()
        .filter(|n| n["path"].as_str().is_some_and(|p| paths::within(Path::new(path), Path::new(p))))
        .max_by_key(|n| n["path"].as_str().unwrap_or("").len())
        .and_then(|n| n["id"].as_str().map(str::to_owned))
}

fn link(
    env: &Env,
    snapshot: &mut Value,
    on: &[Value],
    agent_paths: &BTreeSet<PathBuf>,
    mentions: &BTreeMap<String, String>,
) {
    let mut known: BTreeSet<PathBuf> = agent_paths.clone();
    known.insert(env.home.clone());
    for r in snapshot["roots"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        known.insert(PathBuf::from(r));
    }
    for n in snapshot["nodes"].as_object().into_iter().flatten().map(|(_, n)| n) {
        if let Some(p) = n["path"].as_str() {
            known.insert(PathBuf::from(p));
        }
    }
    for c in on.iter().filter(|c| c["link"]["kind"] == "named" && c["link"]["naming"] == "sha256") {
        let by_name: BTreeMap<_, _> =
            known.iter().map(|p| (agents::store_name(&c["link"], &p.to_string_lossy()), p)).collect();
        for item in snapshot["items"]
            .as_object_mut()
            .into_iter()
            .flatten()
            .map(|(_, i)| i)
            .filter(|i| i["connector"] == c["id"])
        {
            let name = Path::new(item["file"].as_str().unwrap_or("")).file_name().unwrap_or_default().to_string_lossy();
            if let Some(cwd) = by_name.get(name.as_ref()) {
                item["cwd"] = json!(cwd);
            }
        }
    }
    let claude: Vec<_> =
        snapshot["claude"].as_object().into_iter().flatten().map(|(k, c)| (k.clone(), c.clone())).collect();
    for (name, c) in &claude {
        if let Some(p) = c["path"].as_str() {
            if let Some(id) = nearest(&snapshot["nodes"], p) {
                snapshot["nodes"][&id]["agents"]["claude"].as_array_mut().expect("node agents").push(json!(name));
            } else {
                append(snapshot, "global", "claude", json!(name));
            }
        } else {
            let missing = c["cwds"].as_object().is_some_and(|cwds| {
                !cwds.is_empty() && cwds.keys().all(|p| crate::orphan::absence(env, Path::new(p)).is_ok())
            });
            snapshot["claude"][name]["availability"] = json!(if missing { "missing" } else { "unavailable" });
            append(snapshot, "orphans", "claude", json!(name));
        }
    }
    let items: Vec<_> =
        snapshot["items"].as_object().into_iter().flatten().map(|(k, i)| (k.clone(), i.clone())).collect();
    for (id, item) in &items {
        let Some(c) = on.iter().find(|c| c["id"] == item["connector"]) else {
            continue;
        };
        let kind = c["link"]["kind"].as_str().unwrap_or("");
        if kind == "mentions" {
            let text = mentions.get(id).map(String::as_str).unwrap_or("");
            for n in snapshot["nodes"].as_object_mut().into_iter().flatten().map(|(_, n)| n) {
                let path = n["path"].as_str().unwrap_or("");
                let tilde = paths::tilde(Path::new(path), &env.home);
                if [path, tilde.as_str()].iter().any(|p| {
                    Regex::new(&format!(r"{}(?:$|[^\w./-])", regex::escape(p))).is_ok_and(|re| re.is_match(text))
                }) {
                    n["agents"]["items"].as_array_mut().expect("node items").push(json!(id));
                }
            }
        } else if let Some(cwd) = item["cwd"].as_str() {
            if !Path::new(cwd).exists() {
                snapshot["items"][id]["availability"] =
                    json!(if crate::orphan::absence(env, Path::new(cwd)).is_ok() { "missing" } else { "unavailable" });
                append(snapshot, "orphans", "items", json!(id));
            } else if let Some(node) = nearest(&snapshot["nodes"], cwd) {
                snapshot["nodes"][&node]["agents"]["items"].as_array_mut().expect("node items").push(json!(id));
            } else {
                append(snapshot, "global", "items", json!(id));
            }
        } else if kind == "named" {
            if c["link"]["naming"] == "sha256" {
                snapshot["unmatched"].as_array_mut().expect("unmatched list").push(json!(id));
            } else {
                append(snapshot, "orphans", "items", json!(id));
            }
        }
    }
    // Conversations, not the logs of the subagents that ran inside them.
    let sessions: usize = claude
        .iter()
        .map(|(_, c)| array(&c["sessions"]).iter().filter(|s| s["sourceKind"] != "subagent").count())
        .sum();
    let states: Vec<_> = on
        .iter()
        .map(|c| {
            let mut state = c.clone();
            let kind = c["link"]["kind"].as_str().unwrap_or("");
            let mine: Vec<_> = items.iter().filter(|(_, i)| i["connector"] == c["id"]).collect();
            let dir = c["link"]["dir"].as_str().map(Path::new);
            let present =
                dir.is_some_and(|p| p.exists() && agents::safe(env, p)) || (!mine.is_empty() && kind == "inside");
            state["where"] = json!(agents::where_for(env, &c["link"]));
            state["present"] = json!(present);
            state["bytes"] = json!(if c["id"] == "claude" {
                claude.iter().map(|(_, c)| u(c, "bytes")).sum::<u64>()
            } else if let Some(dir) = dir {
                if present { files::size(dir) } else { 0 }
            } else {
                mine.iter().map(|(_, i)| u(i, "bytes")).sum::<u64>()
            });
            state["count"] = json!(if c["id"] == "claude" { sessions } else { mine.len() });
            state["moves"] = json!(if c["id"] == "claude" {
                "Its folder is renamed and paths in the logs are rewritten"
            } else {
                match kind {
                    "cwd" => "Paths in the logs are rewritten",
                    "named" => "Its folder is renamed to match",
                    "inside" => "Travels with the folder",
                    "none" => "Nothing to move: Laci only starts it",
                    _ => "Left as is: they only mention the old path",
                }
            });
            if c["id"] == "claude" {
                state["about"] = json!(format!(
                    "{} · {}",
                    count(claude.len() as u64, "project folder", "project folders"),
                    count(sessions as u64, "session", "sessions")
                ));
            }
            state
        })
        .collect();
    snapshot["connectors"] = json!(states);
    let suggestions:Vec<_>=agents::catalog(env).into_iter().filter(|c|!on.iter().any(|on|on["id"]==c["id"])).map(|c|{
        let link=&c["link"];let mut suggestion=json!({"id":c["id"],"name":c["name"],"about":c["about"],"where":agents::where_for(env,link),"found":false,"launch":c["capabilities"]["launch"]==true});
        if link["kind"]=="inside"{
            let hits=snapshot["nodes"].as_object().into_iter().flatten().map(|(_,n)|n).filter(|n|n["kind"]=="project").filter(|n|{
                let path=Path::new(n["path"].as_str().unwrap_or("")).join(link["path"].as_str().unwrap_or(""));path.exists()&&paths::workspace_path(&path.to_string_lossy(),env).is_ok()
            }).count();if hits>0{suggestion["found"]=json!(true);suggestion["detail"]=json!(format!("in {}",plural(hits as u64,"project")));}
        }else if let Some(dir)=link["dir"].as_str().map(Path::new)&&agents::safe(env,dir)&&std::fs::read_dir(dir).is_ok_and(|mut entries|entries.next().is_some()){suggestion["found"]=json!(true);suggestion["detail"]=json!("History found");}suggestion
    }).collect();
    snapshot["suggestions"] = json!(suggestions);
    // History kept in a store of its own can be copied; what lives inside a project travels with it.
    if on.iter().any(|c| c["link"]["dir"].is_string() && c["link"]["kind"] != "mentions") {
        // Sessions that changed after the last backup are the ones still at risk.
        let live: Vec<(String, String)> = array(&snapshot["sessions"])
            .iter()
            .filter(|s| s["backup"] != true)
            .map(|s| (string(s, "provider").to_owned(), string(s, "updatedAt").to_owned()))
            .collect();
        let mut backup = crate::ops::backup_state(env).unwrap_or_else(|| json!({}));
        let ran = backup["at"].is_string();
        if ran {
            let at = string(&backup, "at").to_owned();
            backup["pending"] = json!(live.iter().filter(|(_, t)| t.as_str() > at.as_str()).count());
            backup["dest"] = json!(paths::tilde(Path::new(string(&backup, "dest")), &env.home));
        }
        backup["auto"] = json!(crate::config::load(env)["autoBackup"] == true);
        let covered = ran && backup["pending"] == 0;
        // Each agent that deletes its own history says so in a setting of its own.
        for provider in crate::providers::all(env) {
            let Some(retention) = &provider.retention else { continue };
            if covered || !on.iter().any(|c| c["provider"] == provider.id.as_str()) {
                continue;
            }
            let keep = paths::home_path(&retention.file, env)
                .ok()
                .filter(|file| agents::safe(env, file))
                .and_then(|file| files::text(&file))
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|settings| settings[&retention.key].as_u64())
                .unwrap_or(retention.days);
            if keep >= 3650 {
                continue;
            }
            let oldest =
                live.iter().filter(|(owner, _)| *owner == provider.id).map(|(_, t)| t.as_str()).min().unwrap_or("—");
            let behind = if ran {
                let changed = count(u(&backup, "pending"), "session has changed", "sessions have changed");
                format!(" {changed} since the last backup.")
            } else {
                String::new()
            };
            snapshot["warnings"].as_array_mut().expect("warnings list").push(json!({"code":format!("{}-cleanup",provider.id),"severity":"high","title":format!("{} deletes session logs after {keep} days",provider.name),"detail":format!("Your oldest surviving session is from {}. {}{behind}",oldest.get(..10).unwrap_or(oldest),retention.note)}));
        }
        snapshot["backup"] = backup;
    }
}

fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn u(v: &Value, key: &str) -> u64 {
    v[key].as_u64().unwrap_or(0)
}
pub fn plural(n: u64, unit: &str) -> String {
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}
/// `count(1, "commit not pushed", "commits not pushed")`: for phrases where the noun is not the last word.
fn count(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}
/// What a store holds, without counting something that is not there: "2 memory files", never "0 sessions + …".
fn history_size(sessions: u64, memory: u64) -> String {
    match (sessions, memory) {
        (0, 0) => "Empty history".into(),
        (0, _) => plural(memory, "memory file"),
        (_, 0) => plural(sessions, "session"),
        _ => format!("{} + {}", plural(sessions, "session"), plural(memory, "memory file")),
    }
}
pub fn bytes(n: u64) -> String {
    if n >= 1_000_000_000 {
        format!("{:.1} GB", n as f64 / 1e9)
    } else if n >= 1_000_000 {
        format!("{:.0} MB", n as f64 / 1e6)
    } else if n >= 1_000 {
        format!("{:.0} KB", n as f64 / 1e3)
    } else {
        format!("{n} B")
    }
}
fn shortest(mut paths: Vec<String>) -> Vec<String> {
    paths.sort_by_key(String::len);
    let mut out: Vec<String> = Vec::new();
    for p in paths {
        if !out.iter().any(|r| paths::within(Path::new(&p), Path::new(r))) {
            out.push(p);
        }
    }
    out
}
pub fn gone_starts(c: &Value) -> Vec<String> {
    shortest(
        array(&c["sessions"])
            .iter()
            .filter_map(|s| s["cwd"].as_str())
            .filter(|p| {
                array(&c["gone"]).iter().any(|g| g == p)
                    && c["path"].as_str().is_none_or(|current| !paths::within(Path::new(p), Path::new(current)))
            })
            .map(str::to_owned)
            .collect(),
    )
}
pub fn stale_roots(c: &Value) -> Vec<String> {
    if c["path"].is_string() { gone_starts(c) } else { Vec::new() }
}
pub fn stale_cwds(c: &Value) -> Vec<(String, u64)> {
    let roots = stale_roots(c);
    c["cwds"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(p, _)| roots.iter().any(|r| paths::within(Path::new(p), Path::new(r))))
        .map(|(p, n)| (p.clone(), n.as_u64().unwrap_or(0)))
        .collect()
}

fn settle(env: &Env, snapshot: &mut Value) {
    let mut ids: Vec<_> = snapshot["nodes"].as_object().into_iter().flatten().map(|(id, _)| id.clone()).collect();
    ids.sort_by_key(|id| std::cmp::Reverse(id.len()));
    for id in ids {
        let mut n = snapshot["nodes"][&id].clone();
        let mut activity = n["ownActivity"].clone();
        if activity["at"].as_str().is_none_or(str::is_empty) {
            activity = Value::Null;
        }
        let mut dates = Vec::new();
        for name in array(&n["agents"]["claude"]).iter().filter_map(Value::as_str) {
            if let Some(at) = snapshot["claude"][name]["sessions"][0]["at"].as_str() {
                dates.push(at.to_owned());
            }
        }
        for item in array(&n["agents"]["items"]).iter().filter_map(Value::as_str) {
            let i = &snapshot["items"][item];
            let mentions = array(&snapshot["connectors"])
                .iter()
                .any(|c| c["id"] == i["connector"] && c["link"]["kind"] == "mentions");
            if !mentions && let Some(at) = i["at"].as_str() {
                dates.push(at.to_owned());
            }
        }
        for child in array(&n["children"]).iter().filter_map(Value::as_str) {
            if let Some(at) = snapshot["nodes"][child]["lastActivity"]["at"].as_str() {
                dates.push(at.to_owned());
            }
        }
        for at in dates {
            if activity["at"].as_str().is_none_or(|old| at.as_str() > old) {
                activity = json!({"at":at,"source":if array(&n["children"]).is_empty(){"agent"}else{"inside"}});
            }
        }
        n["lastActivity"] = activity;
        let age = files::age(string(&n["lastActivity"], "at"));
        let explicit = n["meta"]["status"].as_str().filter(|s| !s.is_empty());
        n["status"] = json!({"value":explicit.unwrap_or(if n["archived"]==true{"archived"}else if age<=14.0{"active"}else if age<=60.0{"idle"}else{"dormant"}),"auto":explicit.is_none()});
        n["issues"] = json!(issues(env, &n, &snapshot["claude"]));
        snapshot["nodes"][&id] = n;
    }
}

fn issue(code: &str, severity: &str, title: String, detail: Option<String>) -> Value {
    let mut v = json!({"code":code,"severity":severity,"title":title});
    if let Some(detail) = detail {
        v["detail"] = json!(detail);
    }
    v
}
/// `days` until the deadline, negative once it has passed. Nothing is raised more than a week ahead.
fn deadline_issue(days: i64) -> Option<(&'static str, &'static str, String)> {
    Some(match days {
        ..0 => ("overdue", "high", format!("Overdue by {}", count(days.unsigned_abs(), "day", "days"))),
        0 => ("due-soon", "high", "Due today".into()),
        1 => ("due-soon", "high", "Due tomorrow".into()),
        2..=7 => ("due-soon", if days == 2 { "high" } else { "med" }, format!("Due in {days} days")),
        _ => return None,
    })
}
fn issues(env: &Env, n: &Value, claude: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let g = &n["git"];
    if n["kind"] == "project" {
        if g.is_object() {
            if u(g, "commits") == 0 {
                out.push(issue(
                    "no-commits",
                    "high",
                    "No commits yet".into(),
                    (u(g, "dirty") > 0).then(|| {
                        format!("{} never committed, no history to go back to", plural(u(g, "dirty"), "file"))
                    }),
                ));
            } else if array(&g["remotes"]).is_empty() {
                out.push(issue(
                    "no-remote",
                    "high",
                    "No remote".into(),
                    Some(count(u(g, "commits"), "commit exists only on this disk", "commits exist only on this disk")),
                ));
            }
            if u(g, "dirty") > 0 && u(g, "commits") > 0 {
                let deleted = u(g, "deleted");
                out.push(issue(
                    "dirty",
                    if n["archived"] == true { "high" } else { "med" },
                    plural(u(g, "dirty"), "uncommitted change"),
                    if n["archived"] == true {
                        Some("Archived with work that was never committed".into())
                    } else if deleted > 0 {
                        Some(format!(
                            "{} deleted, still in the last commit",
                            count(deleted, "tracked file", "tracked files")
                        ))
                    } else {
                        None
                    },
                ));
            }
            if u(g, "localOnly") > 0 {
                out.push(issue(
                    "unpushed",
                    "med",
                    count(u(g, "localOnly"), "commit not pushed", "commits not pushed"),
                    Some(format!(
                        "{} has no upstream, and no remote has {}",
                        if string(g, "branch").is_empty() { "This branch" } else { string(g, "branch") },
                        if u(g, "localOnly") == 1 { "it" } else { "them" }
                    )),
                ));
            }
            let diverged = u(g, "ahead") > 0 && u(g, "behind") > 0;
            if diverged {
                out.push(issue(
                    "diverged",
                    "med",
                    format!(
                        "Diverged from {}",
                        if string(g, "upstream").is_empty() { "its remote" } else { string(g, "upstream") }
                    ),
                    Some(format!(
                        "{} here and {} there; push or pull alone won't fix it",
                        count(u(g, "ahead"), "commit", "commits"),
                        count(u(g, "behind"), "commit", "commits")
                    )),
                ));
            }
            for (key, code, sev, (one, many), detail) in [
                (
                    "ahead",
                    "unpushed",
                    "med",
                    ("commit not pushed", "commits not pushed"),
                    (!string(g, "upstream").is_empty()).then(|| format!("ahead of {}", string(g, "upstream"))),
                ),
                (
                    "stashes",
                    "stash",
                    "med",
                    ("forgotten stash", "forgotten stashes"),
                    Some("Stashes are easy to lose and never pushed".into()),
                ),
                ("behind", "behind", "low", ("commit behind remote", "commits behind remote"), None),
            ] {
                if u(g, key) > 0 && !(diverged && matches!(code, "unpushed" | "behind")) {
                    out.push(issue(code, sev, count(u(g, key), one, many), detail));
                }
            }
        } else if n["type"] == "code" {
            out.push(issue("no-git", "med", "Not under version control".into(), None));
        }
        if n["type"] == "code" && n["archived"] != true {
            if !n["readme"].is_object() {
                out.push(issue(
                    "no-readme",
                    "low",
                    "No README".into(),
                    Some("Summary falls back to package.json or stays empty".into()),
                ));
            } else if n["readme"]["template"] == true {
                out.push(issue("template-readme", "low", "README is still the scaffold template".into(), None));
            }
        }
    }
    for name in array(&n["agents"]["claude"]).iter().filter_map(Value::as_str) {
        let stale = stale_cwds(&claude[name]);
        if !stale.is_empty() {
            out.push(issue(
                "stale-cwd",
                "low",
                "Agent logs point to an old path".into(),
                Some(format!(
                    "{} {}",
                    count(stale.iter().map(|(_, n)| n).sum(), "line still says", "lines still say"),
                    stale
                        .iter()
                        .take(2)
                        .map(|(p, _)| paths::tilde(Path::new(p), &env.home))
                        .collect::<Vec<_>>()
                        .join(", ")
                )),
            ));
        }
    }
    if n["status"]["value"] != "done"
        && n["archived"] != true
        && let Some(deadline) =
            n["meta"]["deadline"].as_str().and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
    {
        // The user's own calendar day: a deadline of today is not overdue until local midnight.
        let days = deadline.signed_duration_since(chrono::Local::now().date_naive()).num_days();
        if let Some((code, severity, title)) = deadline_issue(days) {
            out.push(issue(code, severity, title, None));
        }
    }
    let age = files::age(string(&n["lastActivity"], "at"));
    if n["meta"]["status"] == "active" && age > 30.0 {
        out.push(issue(
            "stalled",
            "med",
            format!(
                "Marked active, untouched {}d",
                if age.is_finite() { (age as u64).to_string() } else { "unknown".into() }
            ),
            None,
        ));
    }
    for f in array(&n["taskFiles"]) {
        let age = files::age(string(f, "at"));
        if u(f, "open") > 0 && age > 14.0 && n["archived"] != true {
            out.push(issue(
                "old-handoff",
                "low",
                format!("{}: {}", string(f, "file"), plural(u(f, "open"), "open item")),
                Some(format!("last edited {} days ago", age as u64)),
            ));
        }
    }
    out.sort_by_key(|i| match i["severity"].as_str() {
        Some("high") => 0,
        Some("med") => 1,
        _ => 2,
    });
    // Checks the user muted for this project stay listed, marked, so they can be unmuted again.
    let quiet: Vec<&str> = n["meta"]["quiet"].as_str().unwrap_or("").split(',').map(str::trim).collect();
    for i in &mut out {
        if quiet.contains(&i["code"].as_str().unwrap_or("")) {
            i["muted"] = json!(true);
        }
    }
    out
}

pub fn archive_dest(env: &Env, node: &Value, roots: &[PathBuf]) -> PathBuf {
    let path = Path::new(string(node, "path"));
    if let Some(dir) = configured_archive(env, &config::load(env)) {
        return dir.join(path.file_name().unwrap_or_default());
    }
    let root = roots
        .iter()
        .find(|r| paths::within(path, r) && r.as_path() != path)
        .map(PathBuf::as_path)
        .unwrap_or_else(|| path.parent().unwrap_or(path));
    let mut dir = path.parent().unwrap_or(root);
    while paths::within(dir, root) {
        if dir.join("_archive").is_dir() {
            return dir.join("_archive").join(path.strip_prefix(dir).unwrap_or(path));
        }
        if dir == root {
            break;
        }
        dir = dir.parent().unwrap_or(root);
    }
    root.join("_archive").join(path.strip_prefix(root).unwrap_or(path))
}

fn relocated(from: &Path, to: &Path, path: &Path) -> PathBuf {
    let suffix = path.strip_prefix(from).unwrap_or(Path::new(""));
    if suffix.as_os_str().is_empty() { to.to_owned() } else { to.join(suffix) }
}

pub fn move_ops(env: &Env, from: &Path, to: &Path, snapshot: &Value) -> Vec<Value> {
    let mut ops = vec![
        json!({"kind":"move","label":"Move folder","from":paths::tilde(from,&env.home),"to":paths::tilde(to,&env.home)}),
    ];
    for c in snapshot["claude"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, c)| c)
        .filter(|c| c["path"].as_str().is_some_and(|p| paths::within(Path::new(p), from)))
    {
        let target = relocated(from, to, Path::new(string(c, "path")));
        ops.push(json!({"kind":"rename","label":"Move Claude sessions + memory","from":paths::tilde(Path::new(string(c,"path")),&env.home),"to":paths::tilde(&target,&env.home),"detail":format!("{} sessions · {} memory files · {}",array(&c["sessions"]).len(),array(&c["memory"]).len(),bytes(u(c,"bytes")))}));
        let lines: u64 = c["cwds"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(p, _)| paths::within(Path::new(p), from))
            .map(|(_, n)| n.as_u64().unwrap_or(0))
            .sum::<u64>()
            + stale_cwds(c).iter().map(|(_, n)| n).sum::<u64>();
        if lines > 0 {
            ops.push(json!({"kind":"rewrite","label":"Rewrite cwd in Claude logs","detail":format!("{} → {}",plural(lines,"line"),paths::tilde(&target,&env.home))}));
        }
    }
    for c in array(&snapshot["connectors"]) {
        let mine: Vec<_> = snapshot["items"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, i)| i)
            .filter(|i| {
                i["cleanupCapability"] != "unsupported"
                    && i["connector"] == c["id"]
                    && i["cwd"].as_str().is_some_and(|p| paths::within(Path::new(p), from))
            })
            .collect();
        if mine.is_empty() {
            continue;
        }
        if c["link"]["kind"] == "cwd" {
            ops.push(json!({"kind":"rewrite","label":format!("Rewrite paths in {} logs",string(c,"name")),"detail":format!("{} in {}",plural(mine.iter().map(|i|u(i,"lines")).sum(),"line"),plural(mine.len() as u64,"file"))}));
        } else if c["link"]["kind"] == "named" {
            for it in mine {
                let path = Path::new(string(it, "cwd"));
                let target = relocated(from, to, path);
                ops.push(json!({"kind":"rename","label":format!("Move {} history",string(c,"name")),"from":paths::tilde(path,&env.home),"to":paths::tilde(&target,&env.home),"detail":bytes(u(it,"bytes"))}));
            }
        }
    }
    ops
}

pub fn archive_plan(env: &Env, snapshot: &Value, id: &str, destination: Option<&str>) -> Result<Value> {
    let n = &snapshot["nodes"][id];
    if n["kind"] != "project" {
        return Err("Unknown project. Rescan and try again.".into());
    }
    let source = paths::workspace_path(string(n, "path"), env)?;
    let roots: Vec<_> = array(&snapshot["roots"]).iter().filter_map(Value::as_str).map(PathBuf::from).collect();
    let dest = if let Some(raw) = destination.filter(|raw| !raw.trim().is_empty()) {
        paths::workspace_path(raw, env)?
    } else {
        if let Some(dir) = configured_archive(env, &config::load(env))
            && !dir.is_dir()
        {
            return Err("The archive folder is unavailable. Check Settings first.".into());
        }
        paths::workspace_path(&archive_dest(env, n, &roots).to_string_lossy(), env)?
    };
    check_archive_destination(env, &dest)?;
    if dest.starts_with(&source) {
        return Err("Can't move a folder into itself".into());
    }
    if dest.exists() {
        return Err("The archive destination already exists".into());
    }
    let mut ops = move_ops(env, Path::new(string(n, "path")), &dest, snapshot);
    let mut travels: Vec<_> =
        array(&n["agents"]["aiFiles"]).iter().filter_map(Value::as_str).map(str::to_owned).collect();
    travels.push(".laci.md".into());
    let mut mentions = BTreeSet::new();
    let mut mentioned = 0;
    for id in array(&n["agents"]["items"]).iter().filter_map(Value::as_str) {
        let item = &snapshot["items"][id];
        let Some(c) = array(&snapshot["connectors"]).iter().find(|c| c["id"] == item["connector"]) else {
            continue;
        };
        if c["link"]["kind"] == "inside" {
            let rel = Path::new(string(item, "file"))
                .strip_prefix(Path::new(string(n, "path")))
                .unwrap_or(Path::new(string(item, "file")))
                .to_string_lossy()
                .into_owned();
            if !travels.iter().any(|p| paths::within(Path::new(&rel), Path::new(p))) {
                travels.push(rel);
            }
        } else if c["link"]["kind"] == "mentions" {
            mentioned += 1;
            mentions.insert(string(c, "name"));
        }
    }
    ops.push(json!({"kind":"keep","label":"Travels with the folder","detail":travels.join(", ")}));
    if mentioned > 0 {
        ops.push(json!({"kind":"keep","label":"Left as is","detail":format!("{} that mention the old path ({})",plural(mentioned,"file"),mentions.into_iter().collect::<Vec<_>>().join(", "))}));
    }
    ops.push(json!({"kind":"write","label":"Set status: archived","to":format!("{}/.laci.md",paths::tilde(&dest,&env.home))}));
    if u(&n["size"], "reclaimable") > 50_000_000 {
        ops.push(json!({"kind":"delete","label":"Optional: delete deps & build output","detail":format!("{} ({})",bytes(u(&n["size"],"reclaimable")),array(&n["size"]["parts"]).iter().map(|p|string(p,"path")).collect::<Vec<_>>().join(", "))}));
    }
    ops.push(json!({"kind":"write","label":"Write undo journal","to":format!("{}/",paths::tilde(&env.data_dir.join("journal"),&env.home))}));
    let checks: Vec<_> = array(&n["issues"])
        .iter()
        .filter(|i| ["no-commits", "no-remote", "dirty", "unpushed", "stash"].contains(&string(i, "code")))
        .cloned()
        .collect();
    Ok(json!({"dest":dest,"checks":checks,"ops":ops}))
}

fn plan(env: &Env, snapshot: &mut Value) {
    let ids: Vec<_> = snapshot["nodes"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, n)| n["kind"] == "project" && n["archived"] != true)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        snapshot["nodes"][&id]["archivePlan"] = match archive_plan(env, snapshot, &id, None) {
            Ok(plan) => plan,
            Err(error) => json!({"error":error,"ops":[],"checks":[]}),
        };
    }
    let dismissed = dismissed(env);
    let (hidden, shown): (Vec<_>, Vec<_>) = proposals(env, snapshot)
        .into_iter()
        .partition(|p| p["id"].as_str().is_some_and(|id| dismissed.contains_key(id)));
    snapshot["proposals"] = json!(shown);
    snapshot["dismissed"] = json!(
        hidden
            .iter()
            .map(|p| json!({"id":p["id"],"title":p["title"],"at":dismissed[string(p,"id")]}))
            .collect::<Vec<_>>()
    );
}
/// How long a dismissed suggestion stays hidden before Tidy up may offer it again.
const DISMISS_DAYS: f64 = 90.0;
/// Suggestions the user dismissed, by id, with the date they did.
pub fn dismissed(env: &Env) -> BTreeMap<String, String> {
    config::load(env)["dismissed"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(id, at)| {
            at.as_str().filter(|at| files::age(at) < DISMISS_DAYS).map(|at| (id.clone(), at.to_owned()))
        })
        .collect()
}

fn proposals(env: &Env, snapshot: &Value) -> Vec<Value> {
    let nodes: Vec<_> = snapshot["nodes"].as_object().into_iter().flatten().map(|(_, n)| n).collect();
    let mut out = Vec::new();
    let quarantine = env.data_dir.join("orphans");
    for name in array(&snapshot["orphans"]["claude"]).iter().filter_map(Value::as_str) {
        let c = &snapshot["claude"][name];
        let what = history_size(array(&c["sessions"]).len() as u64, array(&c["memory"]).len() as u64);
        let mut candidates: Vec<_> = nodes
            .iter()
            .filter(|n| name.ends_with(&format!("-{}", paths::enc(string(n, "name")))))
            .map(|n| {
                let unarchived = ARCHIVE_PATH.replace_all(string(n, "path"), "/");
                (*n, paths::enc(&unarchived) == name)
            })
            .collect();
        if c["cwds"].as_object().is_none_or(|cwds| {
            cwds.is_empty() || cwds.keys().any(|cwd| crate::orphan::absence(env, Path::new(cwd)).is_err())
        }) {
            candidates.clear();
        }
        candidates.sort_by_key(|(_, exact)| !exact);
        if let Some((n, exact)) = candidates.first() {
            let mut ops = vec![
                json!({"kind":"rename","label":"Move Claude sessions + memory","from":gone_starts(c).first().map(|p|paths::tilde(Path::new(p),&env.home)).unwrap_or_else(||paths::tilde(Path::new(string(c,"dir")),&env.home)),"to":paths::tilde(Path::new(string(n,"path")),&env.home),"detail":what}),
            ];
            let lines: u64 = c["cwds"].as_object().into_iter().flatten().map(|(_, n)| n.as_u64().unwrap_or(0)).sum();
            if lines > 0 {
                ops.push(json!({"kind":"rewrite","label":"Rewrite cwd in Claude logs","detail":format!("{} → {}",plural(lines,"line"),paths::tilde(Path::new(string(n,"path")),&env.home))}));
            }
            out.push(json!({"id":format!("reconnect:{name}"),"category":"reconnect","title":format!("Reconnect {what} to {}",string(n,"label")),"why":if *exact{"The folder was moved into _archive, but its agent history stayed at the old address. Claude cannot find these at the new address."}else{"No folder matches this address anymore. This project has the same name. Check before applying."},"confidence":if *exact{"high"}else if candidates.len()==1{"med"}else{"low"},"nodeId":n["id"],"ops":ops,"action":{"type":"reconnect-claude","dir":c["dir"],"target":env.home.join(".claude/projects").join(paths::enc(string(n,"path"))),"pairs":gone_starts(c).iter().map(|p|json!([p,n["path"]])).collect::<Vec<_>>()}}));
        } else {
            out.push(json!({"id":format!("orphan:{name}"),"category":"orphan","title":format!("{what} for a folder that is gone"),"why":format!("Nothing on disk matches {name}. Last used {}.",string(&c["sessions"][0],"at").get(..10).unwrap_or("unknown")),"confidence":"med","ops":[{"kind":"move","label":"Quarantine (restorable)","from":paths::tilde(Path::new(string(c,"dir")),&env.home),"to":paths::tilde(&quarantine.join("claude").join(name),&env.home)}],"action":{"type":"quarantine","moves":[{"from":c["dir"],"to":format!("claude/{name}")}]}}));
        }
    }
    let half: Vec<_> = snapshot["claude"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, c)| c)
        .filter(|c| c["path"].is_string() && !stale_cwds(c).is_empty())
        .collect();
    if !half.is_empty() {
        out.push(json!({"id":"migration:stale-cwd","category":"migration","title":format!("Finish {}",count(half.len() as u64,"half-done move","half-done moves")),"why":"These session folders were renamed after a move, but their logs still record the old path. Search, stats and the next move would get it wrong.","confidence":"high","ops":half.iter().map(|c|{let stale=stale_cwds(c);json!({"kind":"rewrite","label":paths::tilde(Path::new(string(c,"path")),&env.home),"from":stale.iter().map(|(p,_)|paths::tilde(Path::new(p),&env.home)).collect::<Vec<_>>().join(", "),"to":paths::tilde(Path::new(string(c,"path")),&env.home),"detail":plural(stale.iter().map(|(_,n)|n).sum(),"line")})}).collect::<Vec<_>>(),"action":{"type":"rewrite-claude","items":half.iter().map(|c|json!({"dir":c["dir"],"pairs":stale_roots(c).iter().map(|r|json!([r,c["path"]])).collect::<Vec<_>>()})).collect::<Vec<_>>()}}));
    }
    let mut groups: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for id in array(&snapshot["orphans"]["items"]).iter().filter_map(Value::as_str) {
        let it = &snapshot["items"][id];
        if it["cleanupCapability"] == "unsupported" {
            continue;
        }
        groups
            .entry(format!("{}\0{}", string(it, "connector"), it["cwd"].as_str().unwrap_or(string(it, "file"))))
            .or_default()
            .push(it);
    }
    for list in groups.values() {
        let first = list[0];
        let Some(c) = array(&snapshot["connectors"]).iter().find(|c| c["id"] == first["connector"]) else {
            continue;
        };
        let cwd = first["cwd"].as_str();
        let id = string(c, "id");
        let unit = if c["link"]["kind"] == "cwd" { "session" } else { "folder" };
        let formerly = if c["link"]["kind"] == "cwd"
            && cwd.is_some_and(|path| crate::orphan::absence(env, Path::new(path)).is_ok())
        {
            cwd.and_then(|p| {
                half.iter().find_map(|claude| {
                    let old = stale_cwds(claude).into_iter().map(|(p, _)| p).min_by_key(String::len)?;
                    if !paths::within(Path::new(p), Path::new(&old)) {
                        return None;
                    }
                    let node = nearest(&snapshot["nodes"], string(claude, "path"))?;
                    Some((&snapshot["nodes"][&node], old, string(claude, "path").to_owned()))
                })
            })
        } else {
            None
        };
        if let Some((n, old, current)) = formerly {
            let source = cwd.unwrap_or("");
            let target = relocated(Path::new(&old), Path::new(&current), Path::new(source));
            out.push(json!({"id":format!("orphan:{id}:{source}"),"category":"reconnect","title":format!("Reconnect {} {} {} to {}",list.len(),string(c,"name"),if list.len()==1{unit.to_owned()}else{format!("{unit}s")},string(n,"label")),"why":format!("{} used to live at {}: its Claude logs still say so. These sessions stayed at the old address.",string(n,"label"),paths::tilde(Path::new(&old),&env.home)),"confidence":"high","nodeId":n["id"],"ops":[{"kind":"rewrite","label":format!("Rewrite paths in {} logs",string(c,"name")),"from":paths::tilde(Path::new(source),&env.home),"to":paths::tilde(&target,&env.home),"detail":format!("{} in {}",plural(list.iter().map(|x|u(x,"lines")).sum(),"line"),plural(list.len() as u64,"file"))}],"action":{"type":"rewrite-logs","field":c["link"]["field"],"files":list.iter().map(|x|x["file"].clone()).collect::<Vec<_>>(),"pairs":[[old,current]]}}));
            continue;
        }
        let store = Path::new(string(&c["link"], "dir"));
        let name = Path::new(cwd.unwrap_or(string(first, "file"))).file_name().unwrap_or_default().to_string_lossy();
        out.push(json!({"id":format!("orphan:{id}:{}",cwd.unwrap_or(string(first,"file"))),"category":"orphan","title":format!("{} {} {} for deleted {name}",list.len(),string(c,"name"),if list.len()==1{unit.to_owned()}else{format!("{unit}s")}),"why":format!("{} no longer exists. Last used {}.",cwd.map(|p|paths::tilde(Path::new(p),&env.home)).unwrap_or_else(||"Its folder".into()),string(first,"at").get(..10).unwrap_or("unknown")),"confidence":"med","ops":list.iter().map(|x|json!({"kind":"move","label":"Quarantine (restorable)","from":paths::tilde(Path::new(string(x,"file")),&env.home),"to":paths::tilde(&quarantine.join(id),&env.home)})).collect::<Vec<_>>(),"action":{"type":"quarantine","moves":list.iter().map(|x|json!({"from":x["file"],"to":Path::new(id).join(Path::new(string(x,"file")).strip_prefix(store).unwrap_or_else(|_|Path::new(string(x,"file")).file_name().map(Path::new).unwrap_or(Path::new("history"))))})).collect::<Vec<_>>()}}));
    }
    for n in &nodes {
        // Work that is not committed or not pushed is dealt with first; Today lists it as at risk.
        let unfinished = array(&n["issues"]).iter().any(|i| {
            i["muted"] != true && matches!(i["code"].as_str(), Some("dirty" | "unpushed" | "diverged" | "stash"))
        });
        if n["kind"] == "project"
            && n["archived"] != true
            && n["status"]["value"] == "dormant"
            && n["archivePlan"]["dest"].is_string()
            && !unfinished
        {
            let age = files::age(string(&n["lastActivity"], "at"));
            out.push(json!({"id":format!("archive:{}",string(n,"id")),"category":"status","title":format!("Archive {}?",string(n,"label")),"why":if age.is_finite(){format!("No commits, file changes or agent sessions for {} days.",age as u64)}else{"No recorded commits, file changes or agent sessions.".into()},"confidence":"med","nodeId":n["id"],"ops":n["archivePlan"]["ops"],"action":{"type":"archive","nodeId":n["id"]}}));
        }
    }
    let heavy: Vec<_> = nodes
        .iter()
        .filter(|n| {
            u(&n["size"], "reclaimable") > 100_000_000 && (n["archived"] == true || n["status"]["value"] == "dormant")
        })
        .collect();
    if !heavy.is_empty() {
        out.push(json!({"id":"space:inactive","category":"space","title":format!("Free {} from {}",bytes(heavy.iter().map(|n|u(&n["size"],"reclaimable")).sum()),count(heavy.len() as u64,"inactive project","inactive projects")),"why":"Dependencies and build output in archived or dormant projects. They are deleted for good; a fresh install or build brings them back.","confidence":"high","action":{"type":"clear","paths":heavy.iter().flat_map(|n|array(&n["size"]["parts"]).iter().map(|p|Path::new(string(n,"path")).join(string(p,"path")))).collect::<Vec<_>>()},"ops":heavy.iter().map(|n|json!({"kind":"delete","label":n["label"],"detail":format!("{} · {}",bytes(u(&n["size"],"reclaimable")),array(&n["size"]["parts"]).iter().map(|p|string(p,"path")).collect::<Vec<_>>().join(", "))})).collect::<Vec<_>>()}));
    }
    let mut same: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for n in &nodes {
        if let Some(root) = n["git"]["rootCommit"].as_str().filter(|s| !s.is_empty()) {
            same.entry(root).or_default().push(n);
        }
    }
    for (root, nodes) in same {
        if nodes.len() < 2 {
            continue;
        }
        out.push(json!({"id":format!("dup:{root}"),"category":"duplicate","title":format!("{} exists in {} places",string(nodes[0],"name"),nodes.len()),"why":format!("{} share their first commit. One is probably a stale copy.",nodes.iter().map(|n|paths::tilde(Path::new(string(n,"path")),&env.home)).collect::<Vec<_>>().join(" and ")),"confidence":"med","ops":nodes.iter().map(|n|json!({"kind":"keep","label":paths::tilde(Path::new(string(n,"path")),&env.home),"detail":format!("last commit {} · {}",string(&n["git"],"lastCommitAt").get(..10).unwrap_or("—"),count(u(&n["git"],"commits"),"commit","commits"))})).collect::<Vec<_>>()}));
    }
    for proposal in &mut out {
        crate::orphan::prepare(env, snapshot, proposal);
    }
    out.sort_by_key(|p| {
        (
            ["reconnect", "migration", "space", "duplicate", "orphan", "status"]
                .iter()
                .position(|c| p["category"] == *c)
                .unwrap_or(99),
            ["high", "med", "low"].iter().position(|c| p["confidence"] == *c).unwrap_or(99),
        )
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    #[test]
    fn a_diverged_branch_is_one_check_without_push_or_pull_and_holds_back_archiving() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let node = |ahead: u64, behind: u64, quiet: &str| {
            json!({"kind":"project","type":"code","meta":{"quiet":quiet},"readme":{},"agents":{"claude":[]},"taskFiles":[],
                "git":{"commits":9,"remotes":["origin"],"upstream":"gitlab/main","ahead":ahead,"behind":behind,"dirty":0,"stashes":0}})
        };
        let codes =
            |n: &Value| issues(&env, n, &json!({})).iter().map(|i| string(i, "code").to_owned()).collect::<Vec<_>>();
        assert_eq!(codes(&node(40, 40, "")), ["diverged"]);
        assert_eq!(codes(&node(2, 0, "")), ["unpushed"]);
        assert_eq!(codes(&node(0, 3, "")), ["behind"]);
        // A branch with no upstream still shows commits that no remote has, and deleted files say so.
        let mut local = node(0, 0, "");
        local["git"]["upstream"] = json!("");
        local["git"]["branch"] = json!("fix/fingerprint");
        local["git"]["localOnly"] = json!(1);
        local["git"]["dirty"] = json!(2);
        local["git"]["deleted"] = json!(2);
        let found = issues(&env, &local, &json!({}));
        assert_eq!(found.iter().map(|i| string(i, "code")).collect::<Vec<_>>(), ["dirty", "unpushed"]);
        assert_eq!(found[0]["detail"], "2 tracked files deleted, still in the last commit");
        assert_eq!(found[1]["title"], "1 commit not pushed");
        assert_eq!(found[1]["detail"], "fix/fingerprint has no upstream, and no remote has it");
        let both = issues(&env, &node(40, 40, "diverged"), &json!({}));
        assert_eq!(both[0]["title"], "Diverged from gitlab/main");
        assert_eq!(both[0]["detail"], "40 commits here and 40 commits there; push or pull alone won't fix it");
        assert_eq!(both[0]["muted"], true);

        let dormant = |id: &str, codes: &[&str]| {
            json!({"id":id,"label":id,"kind":"project","status":{"value":"dormant"},"archivePlan":{"dest":"/archive","ops":[]},
                "issues":codes.iter().map(|c| json!({"code":c})).collect::<Vec<_>>(),"size":{}})
        };
        let snapshot = json!({"nodes":{"a":dormant("a",&["no-remote"]),"b":dormant("b",&["dirty"]),"c":dormant("c",&["diverged"])},
            "claude":{},"items":{},"orphans":{"claude":[],"items":[]},"connectors":[]});
        let offered: Vec<_> = proposals(&env, &snapshot).iter().map(|p| string(p, "id").to_owned()).collect();
        assert_eq!(offered, ["archive:a"], "unfinished work is dealt with before archiving");
    }
    #[test]
    fn agent_refresh_reuses_metadata_and_discovers_new_agent_only_projects() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let project = env.home.join("project/app");
        write(&project.join("package.json"), "{}");
        write(&project.join("README.md"), "# App\nOriginal metadata.\n");
        let store = env.home.join(".claude/projects");
        let history = store.join(paths::enc(&project.to_string_lossy()));
        write(&history.join("first.jsonl"), &format!("{}\n", json!({"cwd":project})));
        config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"custom":[],"apps":{}})).unwrap();
        let mut snapshot = scan(&env).unwrap();
        let id = project.to_string_lossy().into_owned();
        let metadata = snapshot["nodes"][&id]["readme"].clone();
        write(&project.join("README.md"), "# App\nMetadata changed outside the agent store.\n");
        write(&history.join("second.jsonl"), &format!("{}\n", json!({"cwd":project})));
        assert!(!refresh_agents(&env, &mut snapshot).unwrap());
        assert_eq!(snapshot["nodes"][&id]["readme"], metadata, "agent updates re-read project metadata");
        assert_eq!(snapshot["claude"][paths::enc(&id)]["sessions"].as_array().unwrap().len(), 2);
        assert!(!refresh_agents(&env, &mut snapshot).unwrap());
        assert_eq!(snapshot["nodes"][&id]["agents"]["claude"].as_array().unwrap().len(), 1);
        let docs = env.home.join("project/research");
        fs::create_dir_all(&docs).unwrap();
        write(
            &store.join(paths::enc(&docs.to_string_lossy())).join("new.jsonl"),
            &format!("{}\n", json!({"cwd":docs})),
        );
        assert!(refresh_agents(&env, &mut snapshot).unwrap());
        assert_eq!(snapshot["nodes"][docs.to_str().unwrap()]["type"], "docs");
        assert_ne!(snapshot["nodes"][&id]["readme"], metadata, "changed project graph must do a full refresh");
    }

    #[test]
    fn histories_survive_former_locations_and_mixed_connector_stores() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let project = env.home.join("project/current");
        let former = env.home.join("project/former");
        write(&project.join("package.json"), "{\"name\":\"test\"}");
        let archive = env.home.join("project/_archive/lost");
        write(&archive.join("README.md"), "# Lost\nArchived documentation.");
        let former_lost = env.home.join("project/lost");
        write(
            &env.home.join(".claude/projects").join(paths::enc(&project.to_string_lossy())).join("session.jsonl"),
            &format!("{}\n", json!({"cwd":former,"gitBranch":"main","type":"ai-title","aiTitle":"Moved project"})),
        );
        write(
            &env.home.join(".claude/projects").join(paths::enc(&former_lost.to_string_lossy())).join("old.jsonl"),
            &format!("{}\n", json!({"cwd":former_lost})),
        );
        write(
            &env.home.join(".codex/sessions/2026/session.jsonl"),
            &format!("{}\n", json!({"type":"session_meta","payload":{"cwd":former}})),
        );
        let nested = project.join("notes");
        let former_nested = env.home.join("project/past-docs");
        write(&nested.join("README.md"), "# Notes\nNested project documentation.");
        write(
            &env.home.join(".claude/projects").join(paths::enc(&nested.to_string_lossy())).join("nested.jsonl"),
            &format!("{}\n", json!({"cwd":former_nested})),
        );
        write(&env.home.join(".codex/sessions/2026/nested.jsonl"), &format!("{}\n", json!({"cwd":former_nested})));
        let gemini = env
            .home
            .join(".gemini/tmp")
            .join(agents::store_name(&json!({"naming":"sha256"}), &project.to_string_lossy()));
        write(&gemini.join("chat.json"), "{}");
        write(&env.home.join(".gemini/tmp").join("0".repeat(64)).join("unknown.json"), "{}");
        write(&env.home.join(".claude/plans/plan.md"), "# Plan\nChange ~/project/current tomorrow.");
        write(&project.join(".aider.chat.history.md"), "Previous conversation");
        config::save(&env,&json!({"roots":["~/project"],"presets":["claude","codex","gemini","claude-plans","aider"],"custom":[],"apps":{}})).unwrap();
        let snap = scan(&env).unwrap();
        let node = &snap["nodes"][project.to_string_lossy().as_ref()];
        assert_eq!(array(&node["agents"]["claude"]).len(), 2);
        assert_eq!(array(&node["agents"]["items"]).len(), 3, "Gemini, plan, and inside Aider history should attach");
        assert_eq!(
            array(&snap["unmatched"]).len(),
            1,
            "An unknown Gemini hash must stay unmatched, not become a false orphan"
        );
        assert!(array(&snap["proposals"]).iter().any(|p| p["action"]["type"] == "rewrite-claude"));
        assert!(array(&snap["proposals"]).iter().any(|p| p["action"]["type"] == "rewrite-logs"
            && p["action"]["pairs"][0][1] == project.to_string_lossy().as_ref()));
        assert!(
            array(&snap["proposals"]).iter().any(|p| p["action"]["type"] == "rewrite-logs"
                && p["action"]["pairs"][0][0] == former_nested.to_string_lossy().as_ref()
                && p["action"]["pairs"][0][1] == nested.to_string_lossy().as_ref()),
            "History for a renamed nested folder must reconnect to that folder, not lose its suffix at the project root"
        );
        assert!(
            array(&snap["proposals"])
                .iter()
                .any(|p| p["action"]["type"] == "reconnect-claude" && p["confidence"] == "high")
        );
        assert!(
            array(&node["archivePlan"]["ops"])
                .iter()
                .any(|o| o["kind"] == "keep" && string(o, "detail").contains(".aider.chat.history.md"))
        );
        assert!(env.cache_dir.join("v5-agent-facts.json").exists());
    }
    #[test]
    fn metadata_edits_leave_source_activity_unchanged_and_keep_stable_id() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let dir = env.home.join("project/a");
        write(&dir.join("package.json"), "{}");
        config::save(&env, &json!({"roots":["~/project"],"presets":[]})).unwrap();
        let mut snap = scan(&env).unwrap();
        let id = dir.to_string_lossy().into_owned();
        let activity = snap["nodes"][&id]["ownActivity"].clone();
        let stable = snap["nodes"][&id]["stableId"].clone();
        write(&dir.join(".laci.md"), "---\nstatus: paused\n---\n\n## Notes\nChanged notes\n");
        let node = refresh(&env, &mut snap, &id).unwrap();
        assert_eq!(node["ownActivity"], activity);
        assert_eq!(node["stableId"], stable);
        assert_eq!(node["status"]["value"], "paused");
        let root_node = json!({"path":env.home.join("project"),"name":"project"});
        let dest = archive_dest(&env, &root_node, &[env.home.join("project")]);
        assert!(!dest.starts_with(env.home.join("project")), "A configured root must never archive into itself");
    }
    #[test]
    fn deadlines_read_naturally_and_only_near_ones_are_urgent() {
        let title = |days| deadline_issue(days).map(|(code, severity, title)| format!("{code} {severity} {title}"));
        assert_eq!(title(-12).unwrap(), "overdue high Overdue by 12 days");
        assert_eq!(title(-1).unwrap(), "overdue high Overdue by 1 day");
        assert_eq!(title(0).unwrap(), "due-soon high Due today");
        assert_eq!(title(1).unwrap(), "due-soon high Due tomorrow");
        assert_eq!(title(2).unwrap(), "due-soon high Due in 2 days");
        assert_eq!(title(3).unwrap(), "due-soon med Due in 3 days");
        assert_eq!(title(7).unwrap(), "due-soon med Due in 7 days");
        assert_eq!(title(8), None);
    }
    #[test]
    fn a_deadline_is_measured_in_local_calendar_days() {
        let today = chrono::Local::now().date_naive();
        let node = |deadline: chrono::NaiveDate| json!({"kind":"folder","archived":false,"agents":{},"status":{"value":"active"},"meta":{"deadline":deadline.format("%Y-%m-%d").to_string()}});
        let titles = |deadline| {
            issues(&Env::for_home(std::env::temp_dir()), &node(deadline), &json!({}))
                .iter()
                .map(|i| i["title"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(titles(today), ["Due today"]);
        assert_eq!(titles(today.succ_opt().unwrap()), ["Due tomorrow"]);
        assert_eq!(titles(today.pred_opt().unwrap()), ["Overdue by 1 day"]);
    }
    #[test]
    fn history_is_described_by_what_it_holds() {
        assert_eq!(history_size(3, 0), "3 sessions");
        assert_eq!(history_size(1, 2), "1 session + 2 memory files");
        assert_eq!(history_size(0, 1), "1 memory file");
        assert_eq!(history_size(0, 0), "Empty history");
    }
    #[test]
    fn count_picks_singular_or_plural_phrase() {
        assert_eq!(count(0, "stash", "stashes"), "0 stashes");
        assert_eq!(count(1, "stash", "stashes"), "1 stash");
        assert_eq!(count(2, "stash", "stashes"), "2 stashes");
        let node = json!({"kind":"project","type":"docs","archived":false,"agents":{},"git":{"commits":1,"remotes":[],"ahead":0,"behind":0,"stashes":0,"dirty":0}});
        let found = issues(&Env::for_home(std::env::temp_dir()), &node, &json!({}));
        let no_remote = found.iter().find(|i| i["code"] == "no-remote").unwrap();
        assert_eq!(no_remote["detail"], "1 commit exists only on this disk");
    }
}
