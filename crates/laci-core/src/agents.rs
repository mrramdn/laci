use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{env::Env, files, paths};

pub fn catalog(env: &Env) -> Vec<Value> {
    vec![
        json!({"id":"claude","name":"Claude Code","about":"Sessions and memory, one folder per project","builtin":true,"link":{"kind":"named","dir":env.home.join(".claude/projects"),"naming":"dashes"}}),
        json!({"id":"codex","name":"Codex","about":"Sessions filed by date; each log records its folder","builtin":true,"link":{"kind":"cwd","dir":env.home.join(".codex/sessions"),"ext":".jsonl","field":"cwd"}}),
        json!({"id":"gemini","name":"Gemini CLI","about":"Chats and checkpoints, one folder per project","builtin":true,"link":{"kind":"named","dir":env.home.join(".gemini/tmp"),"naming":"sha256"}}),
        json!({"id":"claude-plans","name":"Claude plans","about":"Plan files, linked by the paths they mention","builtin":true,"link":{"kind":"mentions","dir":env.home.join(".claude/plans"),"ext":".md"}}),
        json!({"id":"serena","name":"Serena","about":"Memories kept inside the project","builtin":true,"link":{"kind":"inside","path":".serena/memories"}}),
        json!({"id":"aider","name":"Aider","about":"Chat history kept inside the project","builtin":true,"link":{"kind":"inside","path":".aider.chat.history.md"}}),
    ]
}

pub fn connectors(env: &Env, cfg: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for c in catalog(env) {
        let enabled = cfg["presets"].as_array().map(|ids| ids.contains(&c["id"])).unwrap_or_else(|| {
            c["link"]["dir"]
                .as_str()
                .is_some_and(|p| safe(env, Path::new(p)) && !files::entries(Path::new(p)).is_empty())
        });
        if enabled {
            out.push(c);
        }
    }
    for custom in cfg["custom"].as_array().into_iter().flatten() {
        let Ok(mut c) = crate::config::validate_connector(env, custom) else { continue };
        c["builtin"] = json!(false);
        c["about"] = json!(match c["link"]["kind"].as_str().unwrap_or("") {
            "cwd" => "Log files that record their folder",
            "named" => "One folder per project",
            "inside" => "Kept inside the project",
            _ => "Files that mention project paths",
        });
        if let Some(p) = c["link"]["dir"].as_str() {
            c["link"]["dir"] = json!(paths::expand(p, &env.home));
        }
        if !out.iter().any(|existing| existing["id"] == c["id"]) {
            out.push(c);
        }
    }
    out
}

pub fn store_name(link: &Value, path: &str) -> String {
    if link["naming"] == "sha256" { format!("{:x}", Sha256::digest(path.as_bytes())) } else { paths::enc(path) }
}

pub fn where_for(env: &Env, link: &Value) -> String {
    if let Some(dir) = link["dir"].as_str() {
        paths::tilde(Path::new(dir), &env.home)
    } else {
        format!("<project>/{}", link["path"].as_str().unwrap_or(""))
    }
}

pub fn safe(env: &Env, path: &Path) -> bool {
    paths::home_path(&path.to_string_lossy(), env).is_ok()
}

/// Resolve lossy Claude names by walking existing folders, never decoding punctuation blindly.
/// Project folders must remain within home or an explicitly selected workspace root.
pub fn resolve_encoded(env: &Env, name: &str) -> Option<PathBuf> {
    fn visit(env: &Env, dir: &Path, rest: &str, depth: usize) -> Option<PathBuf> {
        if rest.is_empty() {
            return paths::workspace_path(&dir.to_string_lossy(), env).is_ok().then(|| dir.to_owned());
        }
        if depth > 64 {
            return None;
        }
        for entry in files::entries(dir) {
            let piece = format!("-{}", paths::enc(&entry.file_name().to_string_lossy()));
            if rest != piece && !rest.strip_prefix(&piece).is_some_and(|s| s.starts_with('-')) {
                continue;
            }
            let path = entry.path();
            if !path.is_dir() || paths::workspace_path(&path.to_string_lossy(), env).is_err() {
                continue;
            }
            if let Some(found) = visit(env, &path, &rest[piece.len()..], depth + 1) {
                return Some(found);
            }
        }
        None
    }
    let mut roots = vec![env.home.clone()];
    roots.extend(paths::workspace_roots(env));
    for root in roots {
        let prefix = paths::enc(&root.to_string_lossy());
        let Some(rest) = name.strip_prefix(&prefix) else { continue };
        if !rest.is_empty() && !rest.starts_with('-') {
            continue;
        }
        if let Some(found) = visit(env, &root, rest, 0) {
            return Some(found);
        }
    }
    None
}

#[derive(Default)]
pub struct AgentData {
    pub claude: BTreeMap<String, Value>,
    pub items: BTreeMap<String, Value>,
    pub mentions: BTreeMap<String, String>,
    pub paths: BTreeSet<PathBuf>,
}

struct Cache {
    values: BTreeMap<String, Value>,
    seen: BTreeSet<String>,
}

impl Cache {
    fn load(env: &Env) -> Self {
        let values = files::text(&env.cache_dir.join("v2-agent-facts.json"))
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { values, seen: BTreeSet::new() }
    }
    fn facts(&mut self, kind: &str, path: &Path, read: impl FnOnce() -> Value) -> Value {
        let key = format!("{kind}:{}", path.display());
        self.seen.insert(key.clone());
        let meta = fs::metadata(path).ok();
        let size = meta.as_ref().map_or(0, |m| m.len());
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|m| m.as_nanos().to_string())
            .unwrap_or_default();
        // Laci preserves log mtimes on purpose. Equal-length rewrites must still invalidate
        // facts, and external writers can preserve mtime too. Replacement and in-place writes
        // both change Unix ctime; the inode also detects atomic replacement on coarse clocks.
        #[cfg(unix)]
        let changed = meta
            .as_ref()
            .map(|m| {
                use std::os::unix::fs::MetadataExt;
                format!("{}:{}:{}", m.ctime(), m.ctime_nsec(), m.ino())
            })
            .unwrap_or_default();
        #[cfg(not(unix))]
        let changed = meta
            .as_ref()
            .and_then(|m| m.created().ok())
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|m| m.as_nanos().to_string())
            .unwrap_or_default();
        if let Some(previous) = self.values.get(&key)
            && previous["size"] == size
            && previous["modified"] == modified
            && previous["changed"] == changed
        {
            return previous["facts"].clone();
        }
        let facts = read();
        self.values.insert(key, json!({"size":size,"modified":modified,"changed":changed,"facts":facts}));
        facts
    }
    fn save(mut self, env: &Env) {
        self.values.retain(|k, _| self.seen.contains(k));
        if let Ok(text) = serde_json::to_vec(&self.values) {
            let _ = files::replace(&env.cache_dir.join("v2-agent-facts.json"), &text);
        }
    }
}

fn field_regex(field: &str) -> Regex {
    Regex::new(&format!(r#""{}"\s*:\s*"((?:[^"\\]|\\.)*)""#, regex::escape(field))).expect("escaped field regex")
}
fn decoded(raw: &str) -> Option<String> {
    serde_json::from_str(&format!("\"{raw}\"")).ok()
}

fn log_facts(path: &Path, field: &str, claude: bool) -> Value {
    let mut cwds: BTreeMap<String, u64> = BTreeMap::new();
    let field = field_regex(field);
    let mut first = None;
    let mut title = None;
    let mut branch = None;
    let title_re = field_regex("aiTitle");
    let branch_re = field_regex("gitBranch");
    let Ok(file) = fs::File::open(path) else {
        return json!({"cwds":{}});
    };
    // Read a line at a time: session logs may be hundreds of megabytes.
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => (),
        }
        // A complete final JSON record is valid without a trailing newline; an unfinished
        // writer's record is retried after its metadata changes.
        if !line.ends_with('\n') && serde_json::from_str::<Value>(&line).is_err() {
            break;
        }
        for c in field.captures_iter(&line) {
            let Some(value) = decoded(&c[1]) else { continue };
            if !Path::new(&value).is_absolute() {
                continue;
            }
            let value = paths::normalize(Path::new(&value)).to_string_lossy().into_owned();
            if first.is_none() {
                first = Some(value.clone());
            }
            *cwds.entry(value).or_default() += 1;
        }
        if claude {
            if let Some(c) = title_re.captures(&line) {
                title = decoded(&c[1]);
            }
            if branch.is_none()
                && let Some(c) = branch_re.captures(&line)
            {
                branch = decoded(&c[1]);
            }
        }
    }
    let lines = first.as_ref().map_or(0, |cwd| {
        cwds.iter().filter(|(p, _)| paths::within(Path::new(p), Path::new(cwd))).map(|(_, n)| n).sum()
    });
    json!({"cwd":first,"cwds":cwds,"lines":lines,"title":title,"branch":branch})
}

fn regular_files(env: &Env, dir: &Path, ext: &str) -> Vec<PathBuf> {
    if !safe(env, dir) {
        return Vec::new();
    }
    files::walk(dir, true)
        .filter(|entry| entry.file_type().is_file() && entry.path().to_string_lossy().ends_with(ext))
        .map(|entry| entry.into_path())
        .filter(|path| safe(env, path))
        .collect()
}

fn claude_dirs(env: &Env, cache: &mut Cache) -> BTreeMap<String, Value> {
    let root = env.home.join(".claude/projects");
    let mut out = BTreeMap::new();
    if !safe(env, &root) {
        return out;
    }
    for entry in files::entries(&root) {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let dir = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !safe(env, &dir) {
            continue;
        }
        let mut bytes = 0u64;
        let mut logs = 0usize;
        let mut sessions = Vec::new();
        let mut counts: BTreeMap<String, u64> = BTreeMap::new();
        for f in files::walk(&dir, true).filter(|f| f.file_type().is_file()) {
            bytes += f.metadata().map_or(0, |m| m.len());
            let relative = f.path().strip_prefix(&dir).unwrap_or(f.path());
            if relative.components().any(|c| c.as_os_str() == "memory")
                || f.path().extension().is_none_or(|e| e != "jsonl")
            {
                continue;
            }
            logs += 1;
            let facts = cache.facts("claude", f.path(), || log_facts(f.path(), "cwd", true));
            for (cwd, n) in facts["cwds"].as_object().into_iter().flatten() {
                *counts.entry(cwd.clone()).or_default() += n.as_u64().unwrap_or(0);
            }
            if f.path().parent() == Some(dir.as_path()) {
                let mut session = json!({"id":f.path().file_stem().unwrap_or_default().to_string_lossy(),"at":files::modified(f.path()),"bytes":f.metadata().map_or(0,|m|m.len())});
                for key in ["cwd", "title", "branch"] {
                    if let Some(v) = facts[key].as_str().filter(|v| !v.is_empty()) {
                        session[key] = json!(v);
                    }
                }
                sessions.push(session);
            }
        }
        sessions.sort_by(|a, b| b["at"].as_str().cmp(&a["at"].as_str()));
        let memory: Vec<_> = files::entries(&dir.join("memory"))
            .into_iter()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let gone: Vec<_> = counts.keys().filter(|p| !Path::new(p).exists()).cloned().collect();
        let mut c = json!({"name":name,"dir":dir,"sessions":sessions,"subagentLogs":logs.saturating_sub(sessions.len()),"memory":memory,"bytes":bytes,"cwds":counts,"gone":gone});
        if let Some(path) = resolve_encoded(env, &name) {
            c["path"] = json!(path);
        }
        out.insert(name, c);
    }
    out
}

pub fn read_inside(env: &Env, c: &Value, project: &Path) -> Option<Value> {
    let relative = c["link"]["path"].as_str()?;
    let path = project.join(relative);
    if paths::workspace_path(&path.to_string_lossy(), env).is_err() {
        return None;
    }
    let project_actual = project.canonicalize().ok()?;
    if !path.canonicalize().ok()?.starts_with(&project_actual) {
        return None;
    }
    let meta = fs::metadata(&path).ok()?;
    let mut item = json!({"id":format!("{}:{}",c["id"].as_str()?,project.display()),"connector":c["id"],"file":path,"at":files::modified(&path),"bytes":if meta.is_dir(){files::size(&path)}else{meta.len()},"cwd":project,"lines":0});
    if meta.is_dir() {
        item["title"] = json!(format!("{} files", files::entries(&path).len()));
    }
    Some(item)
}

pub fn read_all(env: &Env, on: &[Value]) -> AgentData {
    let mut cache = Cache::load(env);
    let mut out = AgentData::default();
    if on.iter().any(|c| c["id"] == "claude") {
        out.claude = claude_dirs(env, &mut cache);
    }
    for c in on.iter().filter(|c| c["id"] != "claude") {
        let Some(id) = c["id"].as_str() else { continue };
        let link = &c["link"];
        let Some(raw) = link["dir"].as_str() else { continue };
        let dir = paths::expand(raw, &env.home);
        if !safe(env, &dir) {
            continue;
        }
        match link["kind"].as_str().unwrap_or("") {
            "cwd" => {
                let field = link["field"].as_str().unwrap_or("cwd");
                for file in regular_files(env, &dir, link["ext"].as_str().unwrap_or(".jsonl")) {
                    let facts = cache.facts(&format!("cwd:{id}:{field}"), &file, || log_facts(&file, field, false));
                    let key = format!("{id}:{}", file.strip_prefix(&dir).unwrap_or(&file).display());
                    let mut item = json!({"id":key,"connector":id,"file":file,"at":files::modified(&file),"bytes":fs::metadata(&file).map_or(0,|m|m.len()),"lines":facts["lines"]});
                    if let Some(cwd) = facts["cwd"].as_str() {
                        item["cwd"] = json!(cwd);
                    }
                    out.items.insert(key, item);
                }
            }
            "named" => {
                for entry in files::entries(&dir).into_iter().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if link["naming"] == "sha256" {
                        if name.len() != 64 || !name.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
                            continue;
                        }
                    } else if !name.starts_with('-') {
                        continue;
                    }
                    let file = entry.path();
                    if !safe(env, &file) {
                        continue;
                    }
                    let newest = files::walk(&file, true)
                        .map(|e| files::modified(e.path()))
                        .max()
                        .unwrap_or_else(|| files::modified(&file));
                    let key = format!("{id}:{name}");
                    let mut item =
                        json!({"id":key,"connector":id,"file":file,"at":newest,"bytes":files::size(&file),"lines":0});
                    if link["naming"] == "dashes"
                        && let Some(cwd) = resolve_encoded(env, &name)
                    {
                        item["cwd"] = json!(cwd);
                    }
                    out.items.insert(key, item);
                }
            }
            "mentions" => {
                for file in regular_files(env, &dir, link["ext"].as_str().unwrap_or(".md")) {
                    let text = files::read_limit(&file, 256 * 1024).unwrap_or_default();
                    let title = text
                        .lines()
                        .find_map(|l| l.strip_prefix("# "))
                        .map(crate::readers::strip_md)
                        .unwrap_or_else(|| file.file_name().unwrap_or_default().to_string_lossy().into_owned());
                    let key = format!("{id}:{}", file.strip_prefix(&dir).unwrap_or(&file).display());
                    out.items.insert(key.clone(), json!({"id":key,"connector":id,"file":file,"at":files::modified(&file),"bytes":fs::metadata(&file).map_or(0,|m|m.len()),"lines":0,"title":title}));
                    out.mentions.insert(key, text);
                }
            }
            _ => (),
        }
    }
    for c in out.claude.values() {
        if let Some(p) = c["path"].as_str() {
            out.paths.insert(PathBuf::from(p));
        }
    }
    for item in out.items.values() {
        if let Some(p) = item["cwd"].as_str().filter(|p| paths::workspace_path(p, env).is_ok() && Path::new(p).is_dir())
        {
            out.paths.insert(PathBuf::from(p));
        }
    }
    cache.save(env);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_escaped_cwd_and_full_logs_without_counting_unfinished_lines() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("log.jsonl");
        fs::write(
            &file,
            "{\"cwd\": \"/home/a/project\\u0020one\"}\n{\"cwd\":\"/home/a/project one/sub\"}\n{\"cwd\":\"/half\"",
        )
        .unwrap();
        let facts = log_facts(&file, "cwd", false);
        assert_eq!(facts["cwd"], "/home/a/project one");
        assert_eq!(facts["lines"], 2);
        fs::write(&file, r#"{"cwd":"/home/a/project"}"#).unwrap();
        assert_eq!(log_facts(&file, "cwd", false)["cwd"], "/home/a/project");
    }
    #[cfg(unix)]
    #[test]
    fn equal_length_rewrite_with_preserved_mtime_invalidates_cached_history() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let log = env.home.join("log.jsonl");
        fs::write(&log, "{\"cwd\":\"/home/test/alpha\"}\n").unwrap();
        let old = fs::metadata(&log).unwrap();
        let mut cache = Cache::load(&env);
        assert_eq!(cache.facts("test", &log, || log_facts(&log, "cwd", false))["cwd"], "/home/test/alpha");
        cache.save(&env);
        files::replace(&log, b"{\"cwd\":\"/home/test/bravo\"}\n").unwrap();
        fs::File::options()
            .write(true)
            .open(&log)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old.modified().unwrap()))
            .unwrap();
        assert_eq!(fs::metadata(&log).unwrap().modified().unwrap(), old.modified().unwrap());
        assert_eq!(fs::metadata(&log).unwrap().len(), old.len());
        let mut cache = Cache::load(&env);
        assert_eq!(cache.facts("test", &log, || log_facts(&log, "cwd", false))["cwd"], "/home/test/bravo");
    }
    #[cfg(unix)]
    #[test]
    fn connector_cannot_follow_store_or_inside_symlink_outside_home() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.jsonl"), "{\"cwd\":\"/secret\"}\n").unwrap();
        symlink(outside.path(), home.path().join("logs")).unwrap();
        let env = Env::for_home(home.path().to_owned());
        let on = vec![
            json!({"id":"custom-test","link":{"kind":"cwd","dir":home.path().join("logs"),"field":"cwd","ext":".jsonl"}}),
        ];
        assert!(read_all(&env, &on).items.is_empty());
        let project = home.path().join("project");
        fs::create_dir(&project).unwrap();
        symlink(outside.path(), project.join(".history")).unwrap();
        assert!(read_inside(&env, &json!({"id":"custom-test","link":{"path":".history"}}), &project).is_none());
    }
}
