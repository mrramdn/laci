use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{env::Env, files, paths, providers};

pub fn catalog(env: &Env) -> Vec<Value> {
    vec![
        json!({"id":"claude","provider":"claude","name":"Claude Code","about":"Sessions, titles, resume and project memory","builtin":true,"capabilities":{"launch":true,"resume":true,"titles":true,"modelDiscovery":"aliases"},"link":{"kind":"named","dir":env.home.join(".claude/projects"),"naming":"dashes"}}),
        json!({"id":"codex","provider":"codex","name":"Codex","about":"Sessions, titles and provider-aware resume","builtin":true,"capabilities":{"launch":true,"resume":true,"titles":true,"modelDiscovery":"on-demand"},"link":{"kind":"cwd","dir":env.home.join(".codex/sessions"),"ext":".jsonl","field":"cwd"}}),
        json!({"id":"antigravity","provider":"antigravity","name":"Antigravity","about":"CLI history and last conversations; full conversation titles are unavailable","builtin":true,"capabilities":{"launch":true,"resume":true,"titles":false,"modelDiscovery":"on-demand"},"link":{"kind":"cwd","dir":env.home.join(".gemini/antigravity-cli"),"ext":".jsonl","field":"workspace"}}),
    ]
}
fn legacy_catalog(env: &Env) -> Vec<Value> {
    vec![
        json!({"id":"gemini","name":"Gemini CLI","link":{"kind":"named","dir":env.home.join(".gemini/tmp"),"naming":"sha256"}}),
        json!({"id":"claude-plans","name":"Claude plans","link":{"kind":"mentions","dir":env.home.join(".claude/plans"),"ext":".md"}}),
        json!({"id":"serena","name":"Serena","link":{"kind":"inside","path":".serena/memories"}}),
        json!({"id":"aider","name":"Aider","link":{"kind":"inside","path":".aider.chat.history.md"}}),
    ]
}
fn same_store(a: &Value, b: &Value) -> bool {
    match (a["link"]["dir"].as_str(), b["link"]["dir"].as_str()) {
        (Some(a), Some(b)) => {
            let a = Path::new(a);
            let b = Path::new(b);
            a.canonicalize().unwrap_or_else(|_| paths::normalize(a))
                == b.canonicalize().unwrap_or_else(|_| paths::normalize(b))
        }
        // Tools Laci only starts keep no store, so two of them never share one.
        _ => a["link"]["kind"] != "none" && a["link"] == b["link"],
    }
}
pub fn connectors(env: &Env, cfg: &Value) -> Vec<Value> {
    let builtins = catalog(env);
    let mut out = Vec::new();
    // Explicit custom configuration wins when a newly offered builtin uses the same store.
    for custom in cfg["custom"].as_array().into_iter().flatten() {
        let Ok(mut c) = crate::config::validate_connector(env, custom) else { continue };
        c["builtin"] = json!(false);
        c["about"] = json!(match (c["agent"].is_object(), c["link"]["kind"] == "none") {
            (true, true) => "Started from Laci; it keeps no history Laci reads",
            (true, false) => "Started from Laci, with the history store you described",
            _ => "User-configured history store",
        });
        if let Some(p) = c["link"]["dir"].as_str() {
            c["link"]["dir"] = json!(paths::expand(p, &env.home));
        }
        if let Some(builtin) = builtins.iter().find(|b| same_store(b, &c)) {
            c["provider"] = builtin["provider"].clone();
            c["capabilities"] = builtin["capabilities"].clone();
        }
        if !out.iter().any(|existing: &Value| existing["id"] == c["id"] || same_store(existing, &c)) {
            out.push(c);
        }
    }
    for mut c in builtins.into_iter().chain(legacy_catalog(env)) {
        if !cfg["presets"].as_array().is_some_and(|ids| ids.contains(&c["id"])) {
            continue;
        }
        if c["builtin"] != true {
            c["builtin"] = json!(false);
            c["legacy"] = json!(true);
            c["about"] = json!("Previously configured history connector");
        }
        if !out.iter().any(|existing| existing["id"] == c["id"] || same_store(existing, &c)) {
            out.push(c);
        }
    }
    // What each one can do comes from its description, built in or the user's own.
    let known = providers::builtins();
    for c in &mut out {
        let described = if c["provider"].is_null() { providers::from_spec(c) } else { None };
        if described.is_some() {
            c["provider"] = c["id"].clone();
            c["capabilities"] = json!({"launch":true,"resume":false,"titles":false,"modelDiscovery":"aliases"});
        }
        let Some(provider) = described.as_ref().or_else(|| known.iter().find(|p| c["provider"] == p.id.as_str()))
        else {
            continue;
        };
        c["command"] = json!(provider.command);
        c["capabilities"]["continue"] = json!(!provider.continue_last.is_empty());
        c["capabilities"]["mcp"] = json!(provider.mcp.is_some());
    }
    out
}
/// Metadata alongside a provider store needs watches as well as the logs themselves.
pub fn metadata_paths(env: &Env, connector: &Value) -> Vec<PathBuf> {
    match connector["provider"].as_str().or_else(|| connector["id"].as_str()) {
        Some("codex") => vec![env.home.join(".codex/session_index.jsonl")],
        Some("antigravity") => vec![env.home.join(".gemini/antigravity-cli/cache/last_conversations.json")],
        _ => vec![],
    }
}

pub fn store_name(link: &Value, path: &str) -> String {
    if link["naming"] == "sha256" { format!("{:x}", Sha256::digest(path.as_bytes())) } else { paths::enc(path) }
}

pub fn where_for(env: &Env, link: &Value) -> String {
    if let Some(dir) = link["dir"].as_str() {
        paths::tilde(Path::new(dir), &env.home)
    } else if link["kind"] == "none" {
        String::new()
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
    pub sessions: Vec<Value>,
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
        let values = files::read_limit(&env.cache_dir.join("v5-agent-facts.json"), 32 * 1024 * 1024)
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { values, seen: BTreeSet::new() }
    }
    fn facts(&mut self, kind: &str, path: &Path, read: impl FnOnce() -> Value) -> Value {
        self.grown(kind, path, |_| read())
    }
    /// Like `facts`, but a changed file is handed the facts of its last read, so a log that only grew
    /// can be read from where that read stopped.
    fn grown(&mut self, kind: &str, path: &Path, read: impl FnOnce(Option<&Value>) -> Value) -> Value {
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
        let facts = read(self.values.get(&key).map(|previous| &previous["facts"]));
        if self.values.len() >= 20_000 {
            self.values.clear();
        }
        self.values.insert(key, json!({"size":size,"modified":modified,"changed":changed,"facts":facts}));
        facts
    }
    fn save(mut self, env: &Env) {
        self.values.retain(|k, _| self.seen.contains(k));
        if let Ok(text) = serde_json::to_vec(&self.values) {
            let _ = files::private_dir(&env.cache_dir);
            let _ = files::replace(&env.cache_dir.join("v5-agent-facts.json"), &text);
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
    let mut valid_locations = true;
    let complete = records(path, |value| {
        let line = value.to_string();
        for c in field.captures_iter(&line) {
            let Some(value) = decoded(&c[1]) else {
                valid_locations = false;
                continue;
            };
            if !Path::new(&value).is_absolute() {
                valid_locations = false;
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
    });
    let lines = first.as_ref().map_or(0, |cwd| {
        cwds.iter().filter(|(p, _)| paths::within(Path::new(p), Path::new(cwd))).map(|(_, n)| n).sum()
    });
    json!({"cwd":first,"cwds":cwds,"lines":lines,"title":title,"branch":branch,"ownershipComplete":complete && valid_locations})
}

const METADATA_BYTES: u64 = 8 * 1024 * 1024;
const METADATA_RECORDS: usize = 20_000;
fn records(path: &Path, read: impl FnMut(Value)) -> bool {
    records_from(path, false, read)
}
// Completeness is required for cleanup. A tail window is only display metadata.
fn records_from(path: &Path, tail: bool, mut read: impl FnMut(Value)) -> bool {
    let Ok(mut file) = fs::File::open(path) else { return false };
    let Ok(before) = file.metadata() else { return false };
    let skip = if tail { before.len().saturating_sub(METADATA_BYTES) } else { 0 };
    if file.seek(SeekFrom::Start(skip)).is_err() {
        return false;
    }
    let mut bytes = Vec::new();
    if (&mut file).take(METADATA_BYTES).read_to_end(&mut bytes).is_err() {
        return false;
    }
    let mut complete = skip == 0 && bytes.len() as u64 == before.len();
    let mut data = bytes.as_slice();
    if skip > 0 {
        // The window can begin inside a JSON string. Never interpret that fragment.
        data = data.iter().position(|b| *b == b'\n').map_or(&[], |end| &data[end + 1..]);
    }
    let lines: Vec<_> = if tail {
        let mut recent: Vec<_> = data.rsplit(|b| *b == b'\n').take(128_000).collect();
        recent.reverse();
        recent
    } else {
        data.split(|b| *b == b'\n').take(METADATA_RECORDS).collect()
    };
    let mut consumed = 0usize;
    for line in lines {
        consumed += line.len() + 1;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<Value>(line) {
            Ok(value) if value.is_object() => read(value),
            _ => complete = false,
        }
    }
    complete &= consumed >= data.len();
    // A writer changing the file during this read cannot supply complete ownership proof.
    complete &= file.metadata().is_ok_and(|after| {
        use std::os::unix::fs::MetadataExt;
        after.len() == before.len()
            && after.mtime() == before.mtime()
            && after.mtime_nsec() == before.mtime_nsec()
            && after.ctime() == before.ctime()
            && after.ctime_nsec() == before.ctime_nsec()
    });
    complete
}
/// What the user typed or the agent said, as one line. Tool plumbing and injected context are not text.
fn spoken(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty()
        || [
            "# AGENTS.md",
            "<environment_context>",
            "<INSTRUCTIONS>",
            "<system",
            "<developer",
            "<local-command",
            "<command-name>",
            "This session is being continued",
            "[Request interrupted",
            "<codex_delegation>",
            "<user_instructions>",
            "<task-notification>",
        ]
        .iter()
        .any(|prefix| text.starts_with(prefix))
    {
        return None;
    }
    Some(text.split_whitespace().collect::<Vec<_>>().join(" "))
}
fn concise(text: &str) -> Option<String> {
    spoken(text).map(|text| text.chars().take(120).collect())
}
fn excerpt(text: String) -> String {
    let mut out: String = text.chars().take(EXCERPT).collect();
    if out.len() < text.len() {
        out.push('…');
    }
    out
}
fn message_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return spoken(text);
    }
    content
        .as_array()?
        .iter()
        .filter(|v| matches!(v["type"].as_str(), Some("text" | "input_text" | "output_text")))
        .find_map(|v| v["text"].as_str().and_then(spoken))
}
const EXCERPT: usize = 400;
/// Files one session changed are remembered up to this many, to count each once.
const CHANGED_FILES: usize = 400;
/// One pass reads at most this much; a longer log carries on at the next refresh.
const PASS_BYTES: u64 = 256 * 1024 * 1024;
/// Bumped when the facts a pass collects change, so older cached passes are read again from the start.
const READER: u64 = 1;
/// The bytes just before where the last pass stopped, to tell a log that only grew from one rewritten.
fn probe(file: &mut fs::File, offset: u64) -> Option<String> {
    let start = offset.saturating_sub(256);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    (&mut *file).take(offset - start).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 == offset - start).then(|| format!("{:x}", Sha256::digest(&bytes)))
}
#[cfg(test)]
fn session_facts(path: &Path, provider: &str) -> Value {
    session_facts_from(path, provider, None)
}
/// Reads one session log. When `previous` is the last pass over the same file and the file only grew,
/// only the new lines are read: an agent that is working costs a few kilobytes per refresh.
///
/// Ownership (which folders a log belongs to) is still decided by the head window alone, as before: a
/// log longer than it is never complete enough to clean up.
fn session_facts_from(path: &Path, provider: &str, previous: Option<&Value>) -> Value {
    use std::io::BufRead;
    use std::os::unix::fs::MetadataExt;
    let fresh = || json!({"cwds":{},"lines":0,"prompts":0,"filesChanged":0});
    let Ok(mut file) = fs::File::open(path) else {
        return json!({"cwds":{},"lines":0,"ownershipComplete":false});
    };
    let Ok(before) = file.metadata() else {
        return json!({"cwds":{},"lines":0,"ownershipComplete":false});
    };
    let len = before.len();
    let resumed = previous.filter(|p| {
        let read = &p["_read"];
        read["reader"] == READER
            && read["inode"] == before.ino()
            && read["offset"].as_u64().is_some_and(|offset| offset <= len)
            && read["probe"]
                .as_str()
                .is_some_and(|hash| Some(hash.to_owned()) == probe(&mut file, read["offset"].as_u64().unwrap_or(0)))
    });
    let mut facts = resumed.cloned().unwrap_or_else(fresh);
    let mut state = facts["_read"].take();
    if resumed.is_none() {
        state = json!({"reader":READER,"offset":0,"headBytes":0,"headRecords":0,"head":true,"parsed":true,"valid":true,"files":[]});
    }
    let start = state["offset"].as_u64().unwrap_or(0);
    let mut changed: BTreeSet<String> =
        state["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str().map(str::to_owned)).collect();
    let mut head = state["head"] == true;
    let mut head_bytes = state["headBytes"].as_u64().unwrap_or(0);
    let mut head_records = state["headRecords"].as_u64().unwrap_or(0) as usize;
    let mut parsed = state["parsed"] == true;
    let mut valid = state["valid"] == true;
    let mut offset = start;
    let mut pending = false;
    if file.seek(SeekFrom::Start(start)).is_ok() {
        let mut reader = std::io::BufReader::new((&mut file).take(len - start));
        let mut line = Vec::new();
        while offset - start < PASS_BYTES {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let finished = line.last() == Some(&b'\n');
            let value = serde_json::from_slice::<Value>(&line).ok().filter(Value::is_object);
            // A half-written last line is read again once its writer finishes it.
            if !finished && value.is_none() {
                pending = true;
                break;
            }
            let size = line.len() as u64;
            offset += size;
            let in_head = head && head_bytes + size <= METADATA_BYTES && head_records < METADATA_RECORDS;
            if in_head {
                head_bytes += size;
                head_records += 1;
            } else {
                head = false;
            }
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let Some(v) = value else {
                parsed = false;
                continue;
            };
            read_record(&v, provider, in_head, &mut facts, &mut valid, &mut changed);
        }
        if offset < len && !pending {
            // The pass stopped at its size limit; the rest is read at the next refresh.
            pending = true;
        }
    }
    // A log that shrank or was replaced while it was read proves nothing; read it again next time.
    let replaced = fs::metadata(path).map_or(true, |after| after.ino() != before.ino() || after.len() < offset);
    facts["filesChanged"] = json!(changed.len());
    if facts["title"].is_null()
        && let Some(prompt) = facts["firstPrompt"].as_str()
    {
        facts["title"] = json!(prompt.chars().take(120).collect::<String>().trim_end_matches('…'));
        facts["titleSource"] = json!("first-message");
    }
    facts["ownershipComplete"] = json!(head && parsed && valid && !pending && !replaced);
    if !replaced {
        facts["_read"] = json!({"reader":READER,"inode":before.ino(),"offset":offset,"probe":probe(&mut file, offset),"headBytes":head_bytes,"headRecords":head_records,"head":head,"parsed":parsed,"valid":valid,"files":changed.into_iter().take(CHANGED_FILES).collect::<Vec<_>>()});
    }
    facts
}
/// One record of a Claude Code or Codex log: where it ran, what it is called, and what happened in it.
fn read_record(
    v: &Value,
    provider: &str,
    head: bool,
    facts: &mut Value,
    valid: &mut bool,
    changed: &mut BTreeSet<String>,
) {
    if let Some(at) = v["timestamp"].as_str().filter(|at| !at.is_empty()) {
        if facts["startedAt"].is_null() {
            facts["startedAt"] = json!(at);
        }
        facts["endedAt"] = json!(at);
    }
    let meta = if provider == "codex" {
        if matches!(v["type"].as_str(), Some("session_meta" | "turn_context")) {
            Some(&v["payload"])
        } else if v["type"].is_null() {
            Some(v)
        } else {
            None
        }
    } else {
        Some(v)
    };
    if let Some(meta) = meta {
        if let Some(cwd) = meta["cwd"].as_str().filter(|s| Path::new(s).is_absolute()) {
            let cwd = paths::normalize(Path::new(cwd)).to_string_lossy().into_owned();
            // Session and turn metadata are authoritative; tool arguments are never searched.
            facts["cwd"] = json!(cwd);
            if head {
                let n = facts["cwds"][&cwd].as_u64().unwrap_or(0) + 1;
                facts["cwds"][&cwd] = json!(n);
                facts["lines"] = json!(facts["lines"].as_u64().unwrap_or(0) + 1);
            }
        } else if !meta["cwd"].is_null() {
            *valid = false;
        }
        if provider == "codex" && v["type"] == "session_meta" {
            if let Some(id) = meta["id"].as_str().filter(|id| !id.is_empty()) {
                if facts["sessionId"].is_null() {
                    facts["sessionId"] = json!(id);
                } else if facts["sessionId"] != id {
                    *valid = false;
                }
            }
            if let Some(source) = meta["source"].as_str().filter(|source| !source.is_empty()) {
                facts["sourceKind"] = json!(source);
            } else if meta["source"]["subagent"].is_object() {
                facts["sourceKind"] = json!("subagent");
            }
            if let Some(parent) = meta["parent_thread_id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .or_else(|| meta["source"]["subagent"]["thread_spawn"]["parent_thread_id"].as_str())
                .or_else(|| meta["source"]["subagent"]["parent_thread_id"].as_str())
                .filter(|id| !id.is_empty())
            {
                facts["parentId"] = json!(parent);
            }
        } else if provider == "codex" && v["type"] == "turn_context" {
            if let Some(model) = meta["model"].as_str().filter(|m| !m.is_empty()) {
                facts["model"] = json!(model);
            }
        } else if provider == "claude" {
            if let Some(id) = v["sessionId"].as_str().filter(|id| !id.is_empty()) {
                if facts["sessionId"].is_null() {
                    facts["sessionId"] = json!(id);
                } else if facts["sessionId"] != id {
                    *valid = false;
                }
            }
            if let Some(branch) = v["gitBranch"].as_str() {
                facts["branch"] = json!(branch);
            }
            for key in ["aiTitle", "agentName", "customTitle"] {
                if let Some(title) = v[key].as_str().and_then(concise) {
                    facts["title"] = json!(title);
                    facts["titleSource"] = json!("provider");
                }
            }
            if v["type"] == "summary"
                && let Some(title) = v["summary"].as_str().and_then(concise)
            {
                facts["title"] = json!(title);
                facts["titleSource"] = json!("provider");
            }
        }
    }
    let prompt = |facts: &mut Value, text: String| {
        if facts["firstPrompt"].is_null() {
            facts["firstPrompt"] = json!(excerpt(text.clone()));
        }
        facts["lastPrompt"] = json!(excerpt(text));
        facts["prompts"] = json!(facts["prompts"].as_u64().unwrap_or(0) + 1);
    };
    let mut touched = |path: &str| {
        if changed.len() < CHANGED_FILES && !path.is_empty() {
            changed.insert(path.to_owned());
        }
    };
    if provider == "codex" {
        let p = &v["payload"];
        match (v["type"].as_str(), p["type"].as_str()) {
            (Some("event_msg"), Some("user_message")) => {
                if let Some(text) = p["message"].as_str().and_then(spoken) {
                    prompt(facts, text);
                }
            }
            (Some("event_msg"), Some("agent_message")) => {
                if let Some(text) = p["message"].as_str().and_then(spoken) {
                    facts["lastReply"] = json!(excerpt(text));
                }
            }
            (Some("response_item"), Some("custom_tool_call" | "function_call")) if p["name"] == "apply_patch" => {
                let input = p["input"].as_str().map(str::to_owned).unwrap_or_else(|| {
                    p["arguments"]
                        .as_str()
                        .and_then(|a| serde_json::from_str::<Value>(a).ok())
                        .and_then(|a| a["input"].as_str().map(str::to_owned))
                        .unwrap_or_default()
                });
                for line in input.lines() {
                    if let Some(path) = ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
                        .iter()
                        .find_map(|prefix| line.strip_prefix(prefix))
                    {
                        touched(path.trim());
                    }
                }
            }
            _ => {}
        }
        return;
    }
    match v["type"].as_str() {
        Some("user")
            if v["isMeta"] != true
                && v["isSidechain"] != true
                && v["isCompactSummary"] != true
                && v["message"]["role"] == "user" =>
        {
            if let Some(text) = message_text(&v["message"]["content"]) {
                prompt(facts, text);
            }
        }
        Some("assistant") if v["isSidechain"] != true => {
            let message = &v["message"];
            if let Some(model) = message["model"].as_str().filter(|m| !m.is_empty() && !m.starts_with('<')) {
                facts["model"] = json!(model);
            }
            for block in message["content"].as_array().into_iter().flatten() {
                match block["type"].as_str() {
                    Some("text") => {
                        if let Some(text) = block["text"].as_str().and_then(spoken) {
                            facts["lastReply"] = json!(excerpt(text));
                        }
                    }
                    Some("tool_use")
                        if matches!(block["name"].as_str(), Some("Edit" | "Write" | "MultiEdit" | "NotebookEdit")) =>
                    {
                        let input = &block["input"];
                        touched(input["file_path"].as_str().or(input["notebook_path"].as_str()).unwrap_or(""));
                    }
                    _ => {}
                }
            }
        }
        Some("pr-link") => {
            if let Some(url) = v["prUrl"].as_str().filter(|u| u.starts_with("https://")) {
                let prs = facts["prs"].as_array().cloned().unwrap_or_default();
                if prs.len() < 10 && !prs.iter().any(|pr| pr["url"] == url) {
                    let mut prs = prs;
                    prs.push(json!({"number":v["prNumber"],"url":url}));
                    facts["prs"] = json!(prs);
                }
            }
        }
        Some("continued-in") => {
            if let Some(id) = v["continuedInSessionId"].as_str().filter(|id| crate::launch::session_id_valid(id)) {
                facts["continuedIn"] = json!(id);
            }
        }
        Some("cost-state") => {
            for (from, to) in [("totalLinesAdded", "linesAdded"), ("totalLinesRemoved", "linesRemoved")] {
                if let Some(n) = v[from].as_u64() {
                    facts[to] = json!(n);
                }
            }
        }
        _ => {}
    }
}
fn normalized_session(provider: &str, file: &Path, facts: &Value, fallback_id: Option<&str>) -> Value {
    let id = facts["sessionId"].as_str().or(fallback_id).unwrap_or("");
    let title = facts["title"].as_str().map(str::to_owned).unwrap_or_else(|| {
        if id.is_empty() {
            "Untitled session".into()
        } else {
            format!("Untitled · {}", id.chars().take(8).collect::<String>())
        }
    });
    let resumable = crate::launch::session_id_valid(id);
    let mut session = json!({"provider":provider,"sessionId":id,"title":title,"titleSource":facts["titleSource"].as_str().unwrap_or("fallback"),"cwd":facts["cwd"],"parentId":facts["parentId"],"sourceKind":facts["sourceKind"].as_str().unwrap_or("cli"),"updatedAt":files::modified(file),"resumeCapability":if resumable {"supported"}else{"history-only"},"file":file});
    for key in SUMMARY {
        if !facts[key].is_null() {
            session[key] = facts[key].clone();
        }
    }
    session
}
/// What a session was about, as far as its log tells.
const SUMMARY: [&str; 12] = [
    "prompts",
    "filesChanged",
    "firstPrompt",
    "lastPrompt",
    "lastReply",
    "startedAt",
    "endedAt",
    "model",
    "prs",
    "continuedIn",
    "linesAdded",
    "linesRemoved",
];
fn title_index(path: &Path) -> Value {
    let mut titles = json!({});
    records_from(path, true, |v| {
        if let (Some(id), Some(title)) = (v["id"].as_str(), v["thread_name"].as_str().and_then(concise)) {
            let updated = v["updated_at"].as_str().unwrap_or("");
            if titles[id]["updated"].as_str().is_none_or(|old| old <= updated) {
                titles[id] = json!({"title":title,"updated":updated});
            }
        }
    });
    titles
}

fn regular_files(env: &Env, dir: &Path, ext: &str) -> Vec<PathBuf> {
    if !safe(env, dir) {
        return Vec::new();
    }
    files::walk(dir, true)
        .filter(|entry| entry.file_type().is_file() && entry.path().to_string_lossy().ends_with(ext))
        .map(|entry| entry.into_path())
        .filter(|path| safe(env, path))
        .take(20_000)
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

        let mut sessions = Vec::new();
        let mut counts: BTreeMap<String, u64> = BTreeMap::new();
        let mut complete = true;
        for (index, entry) in walkdir::WalkDir::new(&dir).follow_links(false).into_iter().enumerate() {
            if index >= 20_000 {
                complete = false;
                break;
            }
            let Ok(f) = entry else {
                complete = false;
                continue;
            };
            if f.file_type().is_dir() {
                continue;
            }
            if !f.file_type().is_file() {
                complete = false;
                continue;
            }
            let Ok(meta) = f.metadata() else {
                complete = false;
                continue;
            };
            bytes += meta.len();
            let relative = f.path().strip_prefix(&dir).unwrap_or(f.path());
            if relative.components().any(|c| c.as_os_str() == "memory")
                || f.path().extension().is_none_or(|e| e != "jsonl")
            {
                continue;
            }

            let facts = cache.grown("claude", f.path(), |previous| session_facts_from(f.path(), "claude", previous));
            complete &=
                facts["ownershipComplete"] == true && facts["cwds"].as_object().is_some_and(|cwds| !cwds.is_empty());
            for (cwd, n) in facts["cwds"].as_object().into_iter().flatten() {
                *counts.entry(cwd.clone()).or_default() += n.as_u64().unwrap_or(0);
            }
            {
                let stem = f.path().file_stem().unwrap_or_default().to_string_lossy();
                let mut session = normalized_session("claude", f.path(), &facts, Some(&stem));
                session["id"] = json!(stem);
                if f.path().parent() != Some(dir.as_path()) {
                    session["parentId"] = facts["sessionId"].clone();
                    session["sessionId"] = json!(stem);
                    session["sourceKind"] = json!("subagent");
                    session["resumeCapability"] = json!("history-only");
                }
                session["at"] = json!(files::modified(f.path()));
                session["bytes"] = json!(f.metadata().map_or(0, |m| m.len()));
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
        let mut c = json!({"name":name,"dir":dir,"sessions":sessions,"subagentLogs":sessions.iter().filter(|s| s["sourceKind"] == "subagent").count(),"memory":memory,"bytes":bytes,"cwds":counts,"gone":gone,"ownershipComplete":complete});
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

fn read_antigravity(env: &Env, dir: &Path, connector: &str, cache: &mut Cache, out: &mut AgentData) {
    let file = dir.join("cache/last_conversations.json");
    if !safe(env, &file) {
        return;
    }
    let last = cache.facts("antigravity-last", &file, || {
        files::read_limit(&file, 512 * 1024)
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or_else(|| json!({}))
    });
    for (cwd, value) in last.as_object().into_iter().flatten() {
        // This index is only the last conversation per cwd, not a full history database.
        let Some(id) = value.as_str().or_else(|| value["conversation_id"].as_str()) else { continue };
        if !Path::new(cwd).is_absolute() || !crate::launch::session_id_valid(id) {
            continue;
        }
        let key = format!("{connector}:conversation:{id}");
        let mut session = normalized_session(
            "antigravity",
            &file,
            &json!({"sessionId":id,"cwd":cwd,"sourceKind":"last-conversation"}),
            None,
        );
        session["id"] = json!(key);
        session["connector"] = json!(connector);
        session["at"] = session["updatedAt"].clone();
        session["bytes"] = json!(0);
        session["lines"] = json!(0);
        // Shared index records are never standalone cleanup targets.
        session["cleanupCapability"] = json!("unsupported");
        out.items.insert(key, session);
    }
}

/// Sessions Laci's backup still holds although their tool has deleted them. They cannot be resumed
/// from there, only read and put back.
fn read_backup(env: &Env, on: &[Value], cache: &mut Cache, out: &mut AgentData) {
    for c in on {
        let (Some(id), Some(store)) = (c["id"].as_str(), c["link"]["dir"].as_str()) else { continue };
        let provider = c["provider"].as_str().unwrap_or(id);
        // Only these two keep one log per session in a form Laci reads.
        if !matches!(provider, "claude" | "codex") {
            continue;
        }
        let store = paths::expand(store, &env.home);
        let kept = env.data_dir.join("history").join(id);
        for file in regular_files(env, &kept, ".jsonl") {
            let Ok(relative) = file.strip_prefix(&kept) else { continue };
            // Claude Code keeps a session at <project>/<id>.jsonl; deeper logs belong to its subagents.
            if provider == "claude" && relative.components().count() != 2 {
                continue;
            }
            let original = store.join(relative);
            if fs::symlink_metadata(&original).is_ok() {
                continue;
            }
            let facts = cache
                .grown(&format!("backup:{provider}"), &file, |previous| session_facts_from(&file, provider, previous));
            let stem = file.file_stem().unwrap_or_default().to_string_lossy();
            let mut session = normalized_session(provider, &file, &facts, (provider == "claude").then_some(&*stem));
            session["id"] = json!(format!("backup:{id}:{}", relative.display()));
            session["connector"] = json!(id);
            session["backup"] = json!(true);
            session["restoreTo"] = json!(original);
            session["resumeCapability"] = json!("history-only");
            session["at"] = session["updatedAt"].clone();
            session["bytes"] = json!(fs::metadata(&file).map_or(0, |m| m.len()));
            out.sessions.push(session);
        }
    }
}

/// The sessions the user keeps: cleanup never offers or deletes them. Keyed by agent and session id, so
/// the mark survives a project move.
pub fn kept(env: &Env) -> BTreeSet<String> {
    files::read_limit(&env.data_dir.join(KEPT), 4 * 1024 * 1024)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v["kept"].as_array().cloned())
        .into_iter()
        .flatten()
        .filter_map(|k| k.as_str().map(str::to_owned))
        .collect()
}
const KEPT: &str = "sessions.json";
pub fn kept_key(session: &Value) -> String {
    format!("{}:{}", session["provider"].as_str().unwrap_or(""), session["sessionId"].as_str().unwrap_or(""))
}
pub fn keep(env: &Env, sessions: &[Value], on: bool) -> crate::Result<usize> {
    let mut all = kept(env);
    let mut changed = 0;
    for session in sessions {
        let key = kept_key(session);
        if key.ends_with(':') || key.starts_with(':') {
            return Err("Unknown session".into());
        }
        changed += usize::from(if on { all.insert(key) } else { all.remove(&key) });
    }
    if changed > 0 {
        files::private_dir(&env.data_dir)?;
        let text = serde_json::to_vec_pretty(&json!({"kept":all})).map_err(|e| e.to_string())?;
        files::replace(&env.data_dir.join(KEPT), &text)?;
    }
    Ok(changed)
}

pub fn read_all(env: &Env, on: &[Value]) -> AgentData {
    let mut cache = Cache::load(env);
    let mut out = AgentData::default();
    if on.iter().any(|c| c["provider"] == "claude" || c["id"] == "claude") {
        out.claude = claude_dirs(env, &mut cache);
    }
    for c in on.iter().filter(|c| c["id"] != "claude" && c["provider"] != "claude") {
        let Some(id) = c["id"].as_str() else { continue };
        let provider = c["provider"].as_str().unwrap_or(id);
        let link = &c["link"];
        let Some(raw) = link["dir"].as_str() else { continue };
        let dir = paths::expand(raw, &env.home);
        if !safe(env, &dir) {
            continue;
        }
        match link["kind"].as_str().unwrap_or("") {
            "cwd" => {
                let field = link["field"].as_str().unwrap_or("cwd");
                let titles = if provider == "codex" {
                    let index = env.home.join(".codex/session_index.jsonl");
                    if safe(env, &index) {
                        cache.facts("codex-titles", &index, || title_index(&index))
                    } else {
                        json!({})
                    }
                } else {
                    json!({})
                };
                for file in regular_files(env, &dir, link["ext"].as_str().unwrap_or(".jsonl")) {
                    let facts = cache.grown(&format!("cwd:{id}:{field}"), &file, |previous| {
                        if provider == "codex" {
                            session_facts_from(&file, "codex", previous)
                        } else {
                            log_facts(&file, field, false)
                        }
                    });
                    let key = format!("{id}:{}", file.strip_prefix(&dir).unwrap_or(&file).display());
                    let mut item = json!({"id":key,"connector":id,"file":file,"at":files::modified(&file),"bytes":fs::metadata(&file).map_or(0,|m|m.len()),"lines":facts["lines"],"cwds":facts["cwds"],"ownershipComplete":facts["ownershipComplete"]});
                    if let Some(cwd) = facts["cwd"].as_str() {
                        item["cwd"] = json!(cwd);
                    }
                    if provider == "codex" {
                        let mut session = normalized_session("codex", &file, &facts, None);
                        if let Some(title) = session["sessionId"].as_str().and_then(|id| titles[id]["title"].as_str()) {
                            session["title"] = json!(title);
                            session["titleSource"] = json!("index");
                        }
                        for (key, value) in session.as_object().into_iter().flatten() {
                            item[key] = value.clone();
                        }
                    } else if provider == "antigravity" {
                        item["provider"] = json!(provider);
                        item["sourceKind"] = json!("history");
                        item["resumeCapability"] = json!("history-only");
                        item["cleanupCapability"] = json!("unsupported");
                        item["title"] = json!("Antigravity CLI history");
                    }
                    out.items.insert(key, item);
                }
                if provider == "antigravity" {
                    read_antigravity(env, &dir, id, &mut cache, &mut out);
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
                    let mut item = json!({"id":key,"connector":id,"file":file,"at":newest,"bytes":files::size(&file),"lines":0,"ownershipComplete":false});
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
        for session in c["sessions"].as_array().into_iter().flatten() {
            let mut session = session.clone();
            session["connector"] = on
                .iter()
                .find(|c| c["provider"] == "claude" || c["id"] == "claude")
                .map(|c| c["id"].clone())
                .unwrap_or_else(|| json!("claude"));
            out.sessions.push(session);
        }
        if let Some(p) = c["path"].as_str() {
            out.paths.insert(PathBuf::from(p));
        }
    }
    for item in out.items.values() {
        if item["sessionId"].is_string() {
            out.sessions.push(item.clone());
        }
        if let Some(p) = item["cwd"].as_str().filter(|p| paths::workspace_path(p, env).is_ok() && Path::new(p).is_dir())
        {
            out.paths.insert(PathBuf::from(p));
        }
    }
    read_backup(env, on, &mut cache, &mut out);
    let kept = kept(env);
    for session in &mut out.sessions {
        if kept.contains(&kept_key(session)) {
            session["kept"] = json!(true);
        }
    }
    out.sessions.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    cache.save(env);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "12345678-1234-1234-1234-123456789abc";
    const CHILD: &str = "12345678-1234-1234-1234-123456789def";
    fn put(path: &Path, values: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, values.iter().map(|v| format!("{v}\n")).collect::<String>()).unwrap();
    }
    #[test]
    fn connectors_are_opt_in_and_custom_store_identity_wins_without_losing_legacy() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        fs::create_dir_all(env.home.join(".codex/sessions")).unwrap();
        assert!(connectors(&env, &json!({})).is_empty());
        let cfg = json!({"presets":["antigravity","gemini","aider"],"custom":[{"id":"custom-agy","name":"My history","link":{"dir":"~/.gemini/antigravity-cli","kind":"cwd","field":"workspace","ext":".jsonl"}}]});
        let on = connectors(&env, &cfg);
        assert_eq!(on.len(), 3);
        assert_eq!(on[0]["id"], "custom-agy");
        assert_eq!(on[0]["provider"], "antigravity");
        assert_eq!(on[1]["id"], "gemini");
        assert_eq!(on[1]["legacy"], true);
        assert_eq!(catalog(&env).len(), 3);
    }
    #[test]
    fn codex_metadata_ignores_tool_paths_and_context_titles_and_keeps_child_identity() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let log = env.home.join(".codex/sessions/child.jsonl");
        put(
            &log,
            &[
                json!({"type":"session_meta","payload":{"id":CHILD,"cwd":env.home,"source":{"subagent":{"thread_spawn":{"parent_thread_id":ID}}}}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /project"}]}}),
                json!({"type":"response_item","payload":{"type":"function_call","arguments":{"cwd":"/unrelated/project"}}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"Fix the actual bug\nwith care"}}),
            ],
        );
        let on = connectors(&env, &json!({"presets":["codex"]}));
        let history = read_all(&env, &on);
        let s = &history.sessions[0];
        assert_eq!(s["provider"], "codex");
        assert_eq!(s["sessionId"], CHILD);
        assert_eq!(s["parentId"], ID);
        assert_eq!(s["cwd"], json!(env.home));
        assert_eq!(s["title"], "Fix the actual bug with care");
        assert_eq!(s["resumeCapability"], "supported");
    }
    #[test]
    fn codex_top_level_and_nested_parents_survive_late_metadata() {
        let home = tempfile::tempdir().unwrap();
        let log = home.path().join("session.jsonl");
        for source in [
            json!({"source":{"subagent":{"other":"review"}},"parent_thread_id":ID}),
            json!({"source":{"subagent":{"thread_spawn":{"parent_thread_id":ID}}}}),
            json!({"source":{"subagent":{"parent_thread_id":ID}}}),
        ] {
            let mut payload = source;
            payload["id"] = json!(CHILD);
            payload["cwd"] = json!("/projects/old");
            let mut text = format!("{}\n", json!({"type":"session_meta","payload":payload}));
            text.push_str(&"{}\n".repeat(METADATA_RECORDS));
            text.push_str(&format!("{}\n", json!({"type":"session_meta","payload":{"cwd":"/projects/latest"}})));
            fs::write(&log, text).unwrap();
            let facts = session_facts(&log, "codex");
            assert_eq!(facts["cwd"], "/projects/latest");
            assert_eq!(facts["parentId"], ID);
            assert_eq!(facts["sessionId"], CHILD);
            assert_eq!(facts["sourceKind"], "subagent");
            assert_eq!(facts["ownershipComplete"], false);
        }
    }
    #[test]
    fn recent_metadata_beyond_byte_and_record_bounds_updates_display_only() {
        let home = tempfile::tempdir().unwrap();
        let log = home.path().join("session.jsonl");
        for provider in ["codex", "claude"] {
            for boundary in ["bytes", "records"] {
                let head = if provider == "codex" {
                    vec![
                        json!({"type":"session_meta","payload":{"id":ID,"cwd":"/projects/old","source":"cli"}}),
                        json!({"type":"event_msg","payload":{"type":"user_message","message":"Original user request"}}),
                    ]
                } else {
                    vec![
                        json!({"type":"user","sessionId":ID,"cwd":"/projects/old","message":{"role":"user","content":"Original user request"}}),
                    ]
                };
                let mut text = head.iter().map(|v| format!("{v}\n")).collect::<String>();
                if boundary == "bytes" {
                    text.push_str(&format!("{}\n", json!({"padding":"x".repeat(1024 * 1024)})).repeat(9));
                } else {
                    text.push_str(&"{}\n".repeat(METADATA_RECORDS));
                }
                let tail = if provider == "codex" {
                    json!({"type":"turn_context","payload":{"cwd":"/projects/latest"}})
                } else {
                    json!({"type":"custom-title","customTitle":"Renamed late","cwd":"/projects/latest"})
                };
                text.push_str(&format!("{tail}\n"));
                fs::write(&log, text).unwrap();
                let facts = session_facts(&log, provider);
                assert_eq!(facts["cwd"], "/projects/latest", "{provider}/{boundary}");
                assert_eq!(facts["sessionId"], ID);
                assert_eq!(facts["ownershipComplete"], false);
                assert_eq!(facts["cwds"], json!({"/projects/old":1}));
                assert_eq!(facts["title"], if provider == "claude" { "Renamed late" } else { "Original user request" });
            }
        }
    }
    #[test]
    fn a_session_says_what_it_was_about() {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("claude.jsonl");
        put(
            &log,
            &[
                json!({"type":"user","isMeta":true,"sessionId":ID,"cwd":"/p","message":{"role":"user","content":"<local-command-caveat>x"}}),
                json!({"type":"user","sessionId":ID,"cwd":"/p","timestamp":"2026-10-09T01:00:00Z","message":{"role":"user","content":"Fix the login page"}}),
                json!({"type":"assistant","sessionId":ID,"cwd":"/p","timestamp":"2026-10-09T01:00:05Z","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Looking at it."},{"type":"tool_use","name":"Edit","input":{"file_path":"/p/login.tsx"}},{"type":"tool_use","name":"Edit","input":{"file_path":"/p/login.tsx"}},{"type":"tool_use","name":"Write","input":{"file_path":"/p/test.ts"}}]}}),
                json!({"type":"user","sessionId":ID,"cwd":"/p","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}),
                json!({"type":"assistant","sessionId":ID,"cwd":"/p","message":{"model":"<synthetic>","content":[{"type":"text","text":"Done: the form submits again."}]}}),
                json!({"type":"user","sessionId":ID,"cwd":"/p","timestamp":"2026-10-09T02:30:00Z","message":{"role":"user","content":"Thanks, ship it"}}),
                json!({"type":"pr-link","prNumber":4,"prUrl":"https://github.com/a/b/pull/4"}),
                json!({"type":"pr-link","prNumber":4,"prUrl":"https://github.com/a/b/pull/4"}),
            ],
        );
        let facts = session_facts(&log, "claude");
        assert_eq!(facts["title"], "Fix the login page");
        assert_eq!(facts["titleSource"], "first-message");
        assert_eq!(facts["prompts"], 2);
        assert_eq!(facts["filesChanged"], 2);
        assert_eq!(facts["firstPrompt"], "Fix the login page");
        assert_eq!(facts["lastPrompt"], "Thanks, ship it");
        assert_eq!(facts["lastReply"], "Done: the form submits again.");
        assert_eq!(facts["model"], "claude-opus-5-5");
        assert_eq!(facts["startedAt"], "2026-10-09T01:00:00Z");
        assert_eq!(facts["endedAt"], "2026-10-09T02:30:00Z");
        assert_eq!(facts["prs"], json!([{"number":4,"url":"https://github.com/a/b/pull/4"}]));
        let session = normalized_session("claude", &log, &facts, None);
        assert_eq!(session["prompts"], 2);
        assert!(session.get("_read").is_none());

        let codex = temp.path().join("codex.jsonl");
        put(
            &codex,
            &[
                json!({"type":"session_meta","payload":{"id":ID,"cwd":"/p","source":"cli"}}),
                json!({"type":"turn_context","payload":{"cwd":"/p","model":"gpt-6"}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"<environment_context>x"}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"Add a README"}}),
                json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch\n*** Add File: README.md\n+hi\n*** Update File: src/a.rs\n*** End Patch"}}),
                json!({"type":"event_msg","payload":{"type":"agent_message","message":"Added it."}}),
            ],
        );
        let facts = session_facts(&codex, "codex");
        assert_eq!((facts["prompts"].clone(), facts["filesChanged"].clone()), (json!(1), json!(2)));
        assert_eq!(facts["lastReply"], "Added it.");
        assert_eq!(facts["model"], "gpt-6");
    }
    #[test]
    fn a_log_that_only_grew_is_read_from_where_the_last_read_stopped() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let log = env.home.join("session.jsonl");
        let line = |text: &str| {
            format!("{}\n", json!({"type":"user","sessionId":ID,"cwd":"/p","message":{"role":"user","content":text}}))
        };
        fs::write(&log, line("First")).unwrap();
        let mut cache = Cache::load(&env);
        let first = cache.grown("claude", &log, |previous| session_facts_from(&log, "claude", previous));
        assert_eq!((first["prompts"].clone(), first["ownershipComplete"].clone()), (json!(1), json!(true)));
        let stopped = first["_read"]["offset"].as_u64().unwrap();
        // Appended, and half of the next line still being written.
        let mut text = fs::read_to_string(&log).unwrap();
        text.push_str(&line("Second"));
        text.push_str(r#"{"type":"user","sess"#);
        fs::write(&log, &text).unwrap();
        let mut reads = vec![];
        let grown = cache.grown("claude", &log, |previous| {
            reads.push(previous.and_then(|p| p["_read"]["offset"].as_u64()));
            session_facts_from(&log, "claude", previous)
        });
        assert_eq!(reads, [Some(stopped)]);
        assert_eq!(grown["prompts"], 2);
        assert_eq!(grown["lastPrompt"], "Second");
        assert_eq!(grown["cwds"], json!({"/p":2}));
        assert_eq!(grown["ownershipComplete"], false, "an unfinished line is not proof yet");
        // The writer finishes the line: only that line is read, and ownership is complete again.
        let finished = format!("{}{}\n", text.trim_end_matches(r#"{"type":"user","sess"#), line("Third").trim_end());
        fs::write(&log, &finished).unwrap();
        let done = cache.grown("claude", &log, |previous| session_facts_from(&log, "claude", previous));
        assert_eq!((done["prompts"].clone(), done["ownershipComplete"].clone()), (json!(3), json!(true)));
        // A rewritten log is read again from the start, not stitched onto the old read.
        fs::write(&log, line("Only")).unwrap();
        let rewritten = cache.grown("claude", &log, |previous| session_facts_from(&log, "claude", previous));
        assert_eq!(rewritten["prompts"], 1);
        assert_eq!(rewritten["firstPrompt"], "Only");
    }
    #[test]
    fn a_stub_left_by_resume_points_to_where_the_conversation_went() {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("stub.jsonl");
        put(
            &log,
            &[
                json!({"type":"system","subtype":"local_command","sessionId":ID,"cwd":"/p","content":"<command-name>/resume</command-name>"}),
                json!({"type":"continued-in","sessionId":ID,"continuedInSessionId":CHILD}),
                json!({"type":"cost-state","sessionId":ID,"totalLinesAdded":12,"totalLinesRemoved":3}),
            ],
        );
        let facts = session_facts(&log, "claude");
        assert_eq!(facts["continuedIn"], CHILD);
        assert_eq!(facts["prompts"], 0);
        assert!(facts["title"].is_null());
        assert_eq!((facts["linesAdded"].clone(), facts["linesRemoved"].clone()), (json!(12), json!(3)));
    }
    #[test]
    fn previous_cache_schema_cannot_hide_shared_ownership() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let log = env.home.join(".codex/sessions/session.jsonl");
        put(
            &log,
            &[
                json!({"type":"session_meta","payload":{"id":ID,"cwd":"/projects/live"}}),
                json!({"type":"turn_context","payload":{"cwd":"/projects/gone"}}),
            ],
        );
        let mut old = Cache::load(&env);
        old.facts(
            "cwd:codex:cwd",
            &log,
            || json!({"cwd":"/projects/gone","cwds":{"/projects/gone":1},"ownershipComplete":true}),
        );
        old.save(&env);
        fs::rename(env.cache_dir.join("v5-agent-facts.json"), env.cache_dir.join("v4-agent-facts.json")).unwrap();
        let history = read_all(&env, &connectors(&env, &json!({"presets":["codex"]})));
        let item = history.items.values().next().unwrap();
        assert_eq!(item["cwds"], json!({"/projects/live":1,"/projects/gone":1}));
        assert_eq!(item["ownershipComplete"], true);
    }
    #[test]
    fn title_index_rename_invalidates_without_touching_log_and_uses_latest_title_record() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let log = env.home.join(".codex/sessions/main.jsonl");
        put(&log, &[json!({"type":"session_meta","payload":{"id":ID,"cwd":env.home,"source":"cli"}})]);
        let index = env.home.join(".codex/session_index.jsonl");
        put(
            &index,
            &[
                json!({"id":ID,"thread_name":"Latest title","updated_at":"2026-10-02"}),
                json!({"id":ID,"thread_name":"Older title","updated_at":"2026-10-01"}),
            ],
        );
        let before = fs::metadata(&log).unwrap().modified().unwrap();
        let on = connectors(&env, &json!({"presets":["codex"]}));
        assert_eq!(read_all(&env, &on).sessions[0]["title"], "Latest title");
        put(&index, &[json!({"id":ID,"thread_name":"Renamed title","updated_at":"2026-10-03"})]);
        let next = read_all(&env, &on);
        assert_eq!(next.sessions[0]["title"], "Renamed title");
        assert_eq!(next.sessions[0]["titleSource"], "index");
        assert_eq!(before, fs::metadata(&log).unwrap().modified().unwrap());
    }
    #[test]
    fn antigravity_only_known_last_conversations_can_resume() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let dir = env.home.join(".gemini/antigravity-cli");
        put(&dir.join("history.jsonl"), &[json!({"workspace":env.home,"prompt":"Do a thing"})]);
        fs::create_dir(dir.join("cache")).unwrap();
        fs::write(dir.join("cache/last_conversations.json"), json!({env.home.to_str().unwrap():ID}).to_string())
            .unwrap();
        let on = connectors(&env, &json!({"presets":["antigravity"]}));
        let history = read_all(&env, &on);
        assert_eq!(history.sessions.len(), 1);
        assert_eq!(history.sessions[0]["sessionId"], ID);
        assert_eq!(history.sessions[0]["cleanupCapability"], "unsupported");
        assert!(
            history.items.values().any(|s| s["sourceKind"] == "history" && s["resumeCapability"] == "history-only")
        );
    }
    #[test]
    fn claude_child_logs_cannot_resume_parent_and_titles_come_from_real_user_text() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let root = env.home.join(".claude/projects").join(paths::enc(env.home.to_str().unwrap()));
        put(
            &root.join(format!("{ID}.jsonl")),
            &[
                json!({"type":"user","sessionId":ID,"cwd":env.home,"message":{"role":"user","content":"<local-command-caveat>Ignore me"}}),
                json!({"type":"user","sessionId":ID,"cwd":env.home,"message":{"role":"user","content":"Explain the new feature"}}),
            ],
        );
        put(
            &root.join(format!("{ID}/subagents/agent-small.jsonl")),
            &[
                json!({"type":"user","sessionId":ID,"cwd":env.home,"message":{"role":"user","content":"Check this module"}}),
            ],
        );
        let history = read_all(&env, &connectors(&env, &json!({"presets":["claude"]})));
        let parent = history.sessions.iter().find(|s| s["sessionId"] == ID).unwrap();
        assert_eq!(parent["title"], "Explain the new feature");
        let child = history.sessions.iter().find(|s| s["parentId"] == ID).unwrap();
        assert_eq!(child["resumeCapability"], "history-only");
        assert_ne!(child["sessionId"], ID);
    }
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
