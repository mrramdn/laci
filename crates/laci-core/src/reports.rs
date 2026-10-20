//! Session reports: Markdown files that agents write at the end of a session, in a folder chosen in Settings.
//! Laci only reads that folder. A report links to the sessions and projects its header names.
use crate::{
    Result, activity, agents, config,
    env::Env,
    files, ops, paths,
    platform::path::{canonical, same_path},
    readers,
};
use chrono::{DateTime, Local, NaiveDate, SecondsFormat, Utc};
use regex::{Regex, RegexBuilder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, Instant},
};

/// Reports a snapshot carries; a folder with more keeps its newest.
pub const LIMIT: usize = 1_000;
const MAX_BYTES: u64 = 2_000_000;
const ENTRIES: usize = 20_000;
const CACHE: &str = "reports-v2.json";
/// Open items a report shows in the snapshot.
const OPEN_ITEMS: usize = 8;
/// Open items the parse cache keeps per report, so each can be closed on its own.
const ALL_ITEMS: usize = 40;
/// Open items the user closed, in Laci's data folder: the reports folder itself is never written.
const CLOSED: &str = "report-items.json";

static FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[-*+]\s+\*\*\s*([A-Za-z][A-Za-z ]{0,30}?)\s*:?\s*\*\*\s*:?\s*(.*)$").expect("field pattern")
});
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").expect("uuid pattern")
});
static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d{4}-\d{2}-\d{2}\b").expect("date pattern"));
static NAME_DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4}-\d{2}-\d{2})").expect("name date pattern"));
static TICKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`\n]+)`").expect("code span pattern"));
static BRACES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"((?:~|/)[^\s{}`,;()\[\]<>"]*)\{([^{}\n]*)\}([^\s{}`,;()\[\]<>"]*)"#).expect("brace pattern")
});
/// [`BRACES`] for paths on Windows, which can also start with a drive letter or `\\`.
static WINDOWS_BRACES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"((?:~|/|\\\\|\b[A-Za-z]:[\\/])[^\s{}`,;()\[\]<>"]*)\{([^{}\n]*)\}([^\s{}`,;()\[\]<>"]*)"#)
        .expect("Windows brace pattern")
});
static BULLET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$").expect("bullet pattern"));
static CHECKBOX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[[ xX]\]\s*").expect("checkbox pattern"));
static NOTHING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(nothing( is)?( left)?( open)?|none|n/?a|-+)[.!]?$").expect("nothing pattern"));

/// A file in the reports folder that is a report: Markdown, not hidden, not the folder's own README.
pub fn is_report_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !name.starts_with('.') && lower.len() > 3 && lower.ends_with(".md") && lower != "readme.md"
}

/// The folder chosen in Settings, or why it cannot be read now. `None` when no folder is set.
pub fn folder(env: &Env, cfg: &Value) -> Option<std::result::Result<PathBuf, (PathBuf, String)>> {
    let raw = cfg["reportsDir"].as_str().map(str::trim).filter(|s| !s.is_empty())?;
    let path = paths::expand(raw, &env.home);
    Some(usable(&path).map(|()| path.clone()).map_err(|error| (path, error)))
}

/// The stored folder was canonical when it was chosen. A link put in its place since, at the folder or
/// above it, would make Laci read somewhere else.
fn usable(path: &Path) -> std::result::Result<(), String> {
    if !path.is_absolute() {
        return Err("Choose the reports folder again in Settings".into());
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "Folder not found".to_owned())?;
    if meta.file_type().is_symlink() {
        return Err("The folder was replaced by a link. Choose it again in Settings".into());
    }
    if !meta.is_dir() {
        return Err("This is no longer a folder".into());
    }
    if !same_path(&canonical(path).map_err(|_| "Folder not found".to_owned())?, path) {
        return Err("The folder's path now leads through a link. Choose it again in Settings".into());
    }
    fs::read_dir(path).map(drop).map_err(|_| "Laci can't read this folder".into())
}

struct Candidate {
    name: String,
    path: PathBuf,
    modified: String,
    bytes: u64,
}

/// Report files directly in the folder, newest first by name date and mtime, before any is read.
fn candidates(dir: &Path) -> (Vec<Candidate>, usize) {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).into_iter().flatten().take(ENTRIES).filter_map(|e| e.ok()) {
        let Ok(name) = entry.file_name().into_string() else { continue };
        // The entry's own type: a link is not followed, so it is never a report.
        if !is_report_name(&name) || !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_BYTES {
            continue;
        }
        let modified = meta
            .modified()
            .map(|t| DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Millis, true))
            .unwrap_or_default();
        out.push(Candidate { path: entry.path(), name, modified, bytes: meta.len() });
    }
    let total = out.len();
    let day = |c: &Candidate| name_date(&c.name).unwrap_or_else(|| local_day(&c.modified));
    out.sort_by(|a, b| (day(b), &b.modified, &b.name).cmp(&(day(a), &a.modified, &a.name)));
    out.truncate(LIMIT);
    (out, total)
}

fn valid_date(text: &str) -> bool {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok()
}
fn name_date(name: &str) -> Option<String> {
    NAME_DATE.captures(name).map(|c| c[1].to_owned()).filter(|d| valid_date(d))
}
fn local_day(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|t| t.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.truncate(out.trim_end().len());
    out.push('…');
    out
}

/// `~/project/{api, web}/src` names `~/project/api/src` and `~/project/web/src`.
fn expand_braces(text: &str, separator: &str, windows: bool) -> String {
    let braces = if windows { &WINDOWS_BRACES } else { &BRACES };
    braces
        .replace_all(text, |c: &regex::Captures| {
            c[2].split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(64)
                .map(|item| format!("{}{item}{}", &c[1], &c[3]))
                .collect::<Vec<_>>()
                .join(separator)
        })
        .into_owned()
}

/// Whether `text` starts like a path a report names: `/…` or `~/…`, and on Windows also `~\…`, `C:\…`, `C:/…` and
/// `\\server\share\…`.
fn starts_like_path(text: &str, windows: bool) -> bool {
    let drive = |t: &[u8]| t.len() > 2 && t[0].is_ascii_alphabetic() && t[1] == b':' && matches!(t[2], b'\\' | b'/');
    text.starts_with('/')
        || text.starts_with("~/")
        || (windows && (text.starts_with(r"~\") || text.starts_with(r"\\") || drive(text.as_bytes())))
}

/// Paths named in a header field. A path in backticks may hold spaces; elsewhere words and punctuation
/// separate them, and a web address or a branch name is never a path.
fn path_tokens(text: &str) -> Vec<String> {
    tokens(text, cfg!(windows))
}
fn tokens(text: &str, windows: bool) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut rest = String::new();
    let mut last = 0;
    for c in TICKS.captures_iter(text) {
        let whole = c.get(0).expect("whole match");
        rest.push_str(&text[last..whole.start()]);
        rest.push(' ');
        let inner = c[1].trim();
        if starts_like_path(inner, windows) {
            tokens.extend(expand_braces(inner, "\n", windows).split('\n').map(|t| t.trim().to_owned()));
        } else {
            rest.push_str(inner);
            rest.push(' ');
        }
        last = whole.end();
    }
    rest.push_str(&text[last..]);
    let rest = expand_braces(&rest, " ", windows);
    tokens.extend(
        rest.split(|c: char| c.is_whitespace() || ",;()[]<>\"`".contains(c))
            .filter(|t| starts_like_path(t, windows) && !t.starts_with("//"))
            .map(str::to_owned),
    );
    let mut seen = BTreeSet::new();
    let trailing = |c: char| matches!(c, '.' | ':' | '/' | '*') || (windows && c == '\\');
    tokens
        .into_iter()
        .map(|t| t.trim_end_matches(trailing).to_owned())
        .filter(|t| t.len() > 1 && t != "~" && seen.insert(t.clone()))
        .collect()
}

/// What a report says about itself, before it is linked to the scan. `modified` dates a report whose name
/// and header carry no date.
pub fn parse(name: &str, text: &str, modified: &str) -> Value {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n");
    let mut lines: Vec<&str> = text.lines().collect();
    // A front matter block is metadata, never the title or a header field.
    let meta = readers::parse_meta(&text);
    if lines.first() == Some(&"---")
        && let Some(end) = lines.iter().skip(1).position(|l| l.trim_end() == "---")
    {
        lines.drain(..end + 2);
    }
    let mut title = None;
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut in_header = true;
    let mut fence = readers::Fence::default();
    let mut section = String::new();
    let mut summary: Vec<&str> = Vec::new();
    let mut summary_seen = false;
    let mut open: Option<Vec<&str>> = None;
    for line in lines {
        if fence.skip(line) {
            continue;
        }
        if let Some(h) = line.strip_prefix("## ") {
            in_header = false;
            let heading = h.trim().trim_end_matches('#').trim().trim_end_matches(':').trim().to_lowercase();
            section = if heading == "summary" && !summary_seen {
                summary_seen = true;
                "summary".into()
            } else if heading == "open" || heading.starts_with("open ") {
                // A later Open section replaces an earlier one: reports that grow keep their newest state.
                open = Some(Vec::new());
                "open".into()
            } else {
                String::new()
            };
            continue;
        }
        if let Some(heading) = line.strip_prefix("# ") {
            if title.is_none() {
                title = Some(readers::strip_md(heading));
            }
            continue;
        }
        if in_header {
            let continued = line.starts_with([' ', '\t']) && !line.trim().is_empty();
            if let Some(c) = FIELD.captures(line) {
                fields.push((c[1].trim().to_lowercase(), c[2].trim().to_owned()));
            } else if continued && let Some((_, value)) = fields.last_mut() {
                // Indented lines continue the field above; a nested bullet is one more entry in it.
                let (separator, text) = match BULLET.captures(line) {
                    Some(b) => ("; ", b.get(2).map_or("", |m| m.as_str()).trim()),
                    None => (" ", line.trim()),
                };
                if !value.is_empty() {
                    value.push_str(separator);
                }
                value.push_str(text);
            } else if fields.last().is_some_and(|(key, _)| !key.is_empty()) {
                // A blank or unindented line ends the field.
                fields.push((String::new(), String::new()));
            }
            continue;
        }
        match section.as_str() {
            "summary" => summary.push(line),
            "open" => open.get_or_insert_with(Vec::new).push(line),
            _ => {}
        }
    }
    let field = |names: &[&str]| -> String {
        fields
            .iter()
            .filter(|(k, _)| names.contains(&k.as_str()))
            .map(|(_, v)| v.as_str())
            .collect::<Vec<_>>()
            .join("; ")
    };
    let from_meta = |key: &str| match &meta[key] {
        Value::String(s) => s.clone(),
        Value::Array(list) => list.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
        _ => String::new(),
    };
    let mut date_field = field(&["date"]);
    let mut session_field = field(&["session", "sessions"]);
    let mut project_field = field(&["project", "projects"]);
    for (value, key) in [(&mut date_field, "date"), (&mut session_field, "session"), (&mut project_field, "projects")] {
        if value.is_empty() {
            *value = from_meta(key);
        }
    }
    let date = DATE
        .find_iter(&date_field)
        .map(|m| m.as_str())
        .find(|d| valid_date(d))
        .map(str::to_owned)
        .or_else(|| name_date(name))
        .unwrap_or_else(|| local_day(modified));
    let mut seen = BTreeSet::new();
    let sessions: Vec<String> = UUID
        .find_iter(&session_field)
        .map(|m| m.as_str().to_ascii_lowercase())
        .filter(|id| seen.insert(id.clone()))
        .collect();
    let title = title.filter(|t| !t.is_empty()).map(|t| clip(&t, 200)).unwrap_or_else(|| title_from(name));
    let mut facts = json!({
        "title": title,
        "date": date,
        "sessions": sessions,
        "sessionPaths": path_tokens(&session_field),
        "projectPaths": path_tokens(&project_field),
        "open": [],
        "openCount": 0,
    });
    let scope = readers::strip_md(&project_field);
    if !scope.is_empty() {
        facts["scope"] = json!(clip(&scope, 300));
    }
    let summary = first_paragraph(&summary);
    if !summary.is_empty() {
        facts["summary"] = json!(clip(&summary, 400));
    }
    let items = open_items(open.as_deref().unwrap_or_default());
    facts["openCount"] = json!(items.len());
    facts["open"] = json!(items.iter().take(OPEN_ITEMS).map(|i| clip(i, 240)).collect::<Vec<_>>());
    facts["items"] = json!(items.iter().take(ALL_ITEMS).map(|i| clip(i, 240)).collect::<Vec<_>>());
    facts
}

/// The open items the user closed: report file name, then item key, then how and when. The list is read even when a
/// sync app keeps it only online, and one that is there but can't be read is an error: read as empty, the next
/// closure would replace every earlier one.
pub fn closed_items(env: &Env) -> Result<Value> {
    let file = env.data_dir.join(CLOSED);
    if fs::symlink_metadata(&file).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Ok(json!({}));
    }
    files::text_even_online(&file)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .ok_or_else(|| {
            format!(
                "Laci can't read {}, where it keeps the report items you closed, so nothing was changed. Remove that \
                 file to start the list again.",
                paths::tilde(&file, &env.home)
            )
        })
}
/// An item is known by its text, so it stays closed while the report keeps it and reopens when it is
/// reworded.
pub fn item_key(text: &str) -> String {
    format!("{:x}", Sha256::digest(readers::strip_md(text).as_bytes()))[..16].to_owned()
}
fn save_closed(env: &Env, closed: &Value) -> Result<()> {
    files::private_dir(&env.data_dir)?;
    files::replace(&env.data_dir.join(CLOSED), serde_json::to_string_pretty(closed).unwrap_or_default().as_bytes())
}
/// The items of a report still open after the user's closures, and how many were closed.
fn still_open(items: &[String], closed: &Value) -> (Vec<String>, usize) {
    let (done, open): (Vec<&String>, Vec<&String>) = items.iter().partition(|i| closed[item_key(i)].is_object());
    (open.into_iter().cloned().collect(), done.len())
}

/// Closes an open item of a report (state `done`, `dropped` or `moved`) or opens a closed one again (`open`).
/// `item` is its number among the items it can apply to, from 1, or words that match only one of them.
/// How a request names one of a report's items.
pub enum ItemName<'a> {
    /// Its place among the items in that state, from 1, or words from it: what an agent sends.
    Loose(&'a str),
    /// Its whole text: what a window sends, so a click on a list drawn before another change still names that item,
    /// or none, never the next one nor one whose words include its words.
    Exact(&'a str),
}

pub fn close_item(
    env: &Env,
    snapshot: &Value,
    id: &str,
    item: ItemName<'_>,
    state: &str,
    note: &str,
    by: &str,
) -> Result<Value> {
    if !["done", "dropped", "moved", "open"].contains(&state) {
        return Err("Choose done, dropped, moved or open".into());
    }
    let file = listed(env, snapshot, id)?;
    let text = files::text_nofollow(&file, MAX_BYTES)
        .ok_or("That report can't be read: it is gone, over 2 MB, or not UTF-8 text")?;
    let facts = parse(id, &text, "");
    let all: Vec<String> =
        facts["items"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    let closed = closed_items(env)?;
    let pool: Vec<&String> = all.iter().filter(|i| closed[id][item_key(i)].is_object() == (state == "open")).collect();
    let chosen = match item {
        ItemName::Exact(exact) => match pool.iter().find(|i| i.as_str() == exact) {
            Some(found) => *found,
            // A second click finds it done already, and changes nothing: no second Log entry, no error.
            None if all.iter().any(|i| i == exact) => {
                return Ok(json!({"report":id,"item":exact,"state":state}));
            }
            None => return Err("That item isn't in the report any more".into()),
        },
        ItemName::Loose(item) => match item.trim().parse::<usize>() {
            // Without this, 0 would be taken as words and close whichever item happens to contain a 0.
            Ok(0) => return Err("Items are numbered from 1".into()),
            Ok(n) => *pool.get(n - 1).ok_or("No item has that number")?,
            _ => {
                let words: Vec<String> = item.split_whitespace().map(str::to_lowercase).collect();
                if words.is_empty() {
                    return Err("Name the item by its number or by words from it".into());
                }
                let matches: Vec<&&String> =
                    pool.iter().filter(|i| words.iter().all(|w| i.to_lowercase().contains(w))).collect();
                match matches.as_slice() {
                    [one] => **one,
                    [] => {
                        return Err(
                            if state == "open" { "No closed item matches" } else { "No open item matches" }.into()
                        );
                    }
                    _ => return Err("More than one item matches; use more of its words or its number".into()),
                }
            }
        },
    };
    let key = item_key(chosen);
    let title = snapshot["reports"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["id"] == id)
        .map_or(id, |r| r["title"].as_str().unwrap_or(id));
    ops::with_lock(env, || {
        let mut closed = closed_items(env)?;
        let previous = closed[id][key.as_str()].clone();
        if state == "open" {
            if let Some(items) = closed[id].as_object_mut() {
                items.remove(&key);
            }
        } else {
            if !closed[id].is_object() {
                closed[id] = json!({});
            }
            closed[id][key.as_str()] = json!({"state":state,"at":files::now(),"by":by,"note":note,"text":chosen});
        }
        save_closed(env, &closed)?;
        activity::record(
            env,
            json!({"by":by,"title":format!("{} an item of the report “{}”",if state == "open" { "Reopened" } else { "Closed" },clip(title, 80)),
                "detail":chosen,"path":file,"key":format!("report:{id}:{key}"),
                "undo":{"type":"report-item","report":id,"item":key,"previous":previous}}),
        );
        Ok(())
    })?;
    Ok(json!({"report":id,"item":chosen,"state":state}))
}
/// Puts an item's closure back as it was before a change, for the Log's Undo.
pub(crate) fn restore_item(env: &Env, undo: &Value) -> Result<()> {
    let id = undo["report"].as_str().ok_or("Unknown report")?;
    let key = undo["item"].as_str().ok_or("Unknown report item")?;
    let mut closed = closed_items(env)?;
    if undo["previous"].is_object() {
        if !closed[id].is_object() {
            closed[id] = json!({});
        }
        closed[id][key] = undo["previous"].clone();
    } else if let Some(items) = closed[id].as_object_mut() {
        items.remove(key);
    }
    save_closed(env, &closed)
}

fn title_from(name: &str) -> String {
    let stem = name.get(..name.len().saturating_sub(3)).unwrap_or(name);
    let stem = NAME_DATE.replace(stem, "");
    let words = stem.replace(['-', '_'], " ");
    let words = words.split_whitespace().collect::<Vec<_>>().join(" ");
    if words.is_empty() { name.to_owned() } else { files::capitalize(&words) }
}

fn first_paragraph(lines: &[&str]) -> String {
    let text: Vec<String> = lines
        .iter()
        .skip_while(|l| l.trim().is_empty())
        .take_while(|l| !l.trim().is_empty())
        .map(|l| BULLET.captures(l).map_or_else(|| l.trim().to_owned(), |b| b[2].trim().to_owned()))
        .collect();
    readers::strip_md(&text.join(" "))
}

/// One entry per bullet or numbered line; indented lines belong to the entry above. A section without a
/// list counts each paragraph as one entry.
fn open_items(lines: &[&str]) -> Vec<String> {
    let mut items: Vec<String> = Vec::new();
    let mut current: Option<String> = None;
    let mut paragraph = false;
    for line in lines {
        if line.trim().is_empty() {
            items.extend(current.take());
            continue;
        }
        if line.trim_start().starts_with('#') {
            items.extend(current.take());
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        match BULLET.captures(line) {
            Some(b) if indent <= 1 => {
                items.extend(current.take());
                current = Some(CHECKBOX.replace(b[2].trim(), "").into_owned());
                paragraph = false;
            }
            Some(b) => match current.as_mut() {
                Some(item) => {
                    item.push_str("; ");
                    item.push_str(&CHECKBOX.replace(b[2].trim(), ""));
                }
                None => current = Some(CHECKBOX.replace(b[2].trim(), "").into_owned()),
            },
            None => match current.as_mut() {
                Some(item) if indent > 0 || paragraph => {
                    item.push(' ');
                    item.push_str(line.trim());
                }
                _ => {
                    items.extend(current.take());
                    current = Some(line.trim().to_owned());
                    paragraph = true;
                }
            },
        }
    }
    items.extend(current);
    items
        .into_iter()
        .map(|i| readers::strip_md(&i))
        .filter(|i| i.chars().any(char::is_alphanumeric) && !NOTHING.is_match(i))
        .collect()
}

/// Projects that the scan knows, deepest first, and where each session that may be named last worked.
struct Linker {
    projects: Vec<PathBuf>,
    sessions: HashMap<String, Vec<PathBuf>>,
}
impl Linker {
    fn new(env: &Env, snapshot: &Value) -> Self {
        let mut projects: Vec<PathBuf> = snapshot["nodes"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, n)| n)
            .filter(|n| n["kind"] == "project")
            .filter_map(|n| n["path"].as_str().map(PathBuf::from))
            // Home and the folders above it hold everything; naming a file in them names no project.
            .filter(|p| !paths::within(&env.home, p))
            .collect();
        projects.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        let mut sessions: HashMap<String, Vec<PathBuf>> = HashMap::new();
        // Antigravity's last conversations are listed as items, with a session id like any other.
        let listed = snapshot["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(snapshot["items"].as_object().into_iter().flatten().map(|(_, i)| i));
        for s in listed {
            if let (Some(id), Some(cwd)) = (s["sessionId"].as_str(), s["cwd"].as_str().filter(|c| !c.is_empty())) {
                sessions.entry(id.to_ascii_lowercase()).or_default().push(PathBuf::from(cwd));
            }
        }
        Self { projects, sessions }
    }
    fn project(&self, path: &Path) -> Option<&PathBuf> {
        self.projects.iter().find(|p| paths::within(path, p))
    }
    /// A report names projects by path, by the folder its session started in, and through its session
    /// ids. The last survives a project that Laci moved: moves rewrite the paths in session logs.
    fn link(&self, env: &Env, facts: &Value) -> Vec<String> {
        let named = facts["projectPaths"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(facts["sessionPaths"].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
            .map(|raw| paths::expand(raw, &env.home))
            .filter(|p| p.is_absolute());
        let worked = facts["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .flat_map(|id| self.sessions.get(id).into_iter().flatten().cloned());
        let linked: BTreeSet<String> =
            named.chain(worked).filter_map(|p| self.project(&p)).map(|p| p.to_string_lossy().into_owned()).collect();
        linked.into_iter().collect()
    }
}

/// Puts the reports folder's state and its reports into a snapshot, linked to the snapshot's projects and
/// sessions. Without a folder in Settings, both keys are left out.
pub fn attach(env: &Env, snapshot: &mut Value) {
    let Some(state) = folder(env, &config::load(env)) else {
        if let Some(object) = snapshot.as_object_mut() {
            object.remove("reportsDir");
            object.remove("reports");
        }
        return;
    };
    let dir = match state {
        Ok(dir) => dir,
        Err((path, error)) => {
            // The parse cache stays as it is, ready for when the drive is back.
            snapshot["reportsDir"] = json!({"path":path,"error":error});
            snapshot["reports"] = json!([]);
            return;
        }
    };
    let (found, total) = candidates(&dir);
    let linker = Linker::new(env, snapshot);
    // A list that can't be read shows every item open; closing one then says why it can't.
    let closed = closed_items(env).unwrap_or_else(|_| json!({}));
    let mut cache = agents::Cache::open(env, CACHE);
    let mut reports: Vec<Value> = found
        .iter()
        .filter_map(|c| {
            let facts = cache.facts("report", &c.path, || {
                files::text_nofollow(&c.path, MAX_BYTES).map_or(Value::Null, |text| parse(&c.name, &text, &c.modified))
            });
            if facts.is_null() {
                return None;
            }
            let listed = if facts["items"].is_array() { &facts["items"] } else { &facts["open"] };
            let items: Vec<String> =
                listed.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            let (open, done) = still_open(&items, &closed[c.name.as_str()]);
            let mut report = json!({
                "id": c.name,
                "file": c.path,
                "title": facts["title"],
                "date": facts["date"],
                "modified": c.modified,
                "bytes": c.bytes,
                "sessions": facts["sessions"],
                "projects": linker.link(env, &facts),
                "open": open.into_iter().take(OPEN_ITEMS).collect::<Vec<_>>(),
                "openCount": (facts["openCount"].as_u64().unwrap_or(0) as usize).saturating_sub(done),
            });
            if done > 0 {
                report["closedCount"] = json!(done);
                // In the report's order, so a closed item can be opened again by its number.
                report["closed"] = json!(
                    items.iter().filter(|i| closed[c.name.as_str()][item_key(i)].is_object()).collect::<Vec<_>>()
                );
            }
            for key in ["scope", "summary"] {
                if facts[key].is_string() {
                    report[key] = facts[key].clone();
                }
            }
            Some(report)
        })
        .collect();
    cache.save(env);
    let key =
        |r: &Value| (r["date"].as_str().unwrap_or("").to_owned(), r["modified"].as_str().unwrap_or("").to_owned());
    reports.sort_by(|a, b| (key(b), b["id"].as_str().unwrap_or("")).cmp(&(key(a), a["id"].as_str().unwrap_or(""))));
    snapshot["reportsDir"] = json!({"path":dir,"total":total});
    snapshot["reports"] = json!(reports);
}

/// The folder a request may read, as of the scan the request was made from.
fn scanned_folder(env: &Env, snapshot: &Value) -> Result<PathBuf> {
    let dir = match folder(env, &config::load(env)) {
        None => return Err("No reports folder is set in Settings".into()),
        Some(Err((_, error))) => return Err(error),
        Some(Ok(dir)) => dir,
    };
    if snapshot["reportsDir"]["path"].as_str() != Some(dir.to_string_lossy().as_ref()) {
        return Err("The reports folder changed. Refresh and try again.".into());
    }
    Ok(dir)
}

/// A report from the last scan, still a plain file directly in the folder.
fn listed(env: &Env, snapshot: &Value, id: &str) -> Result<PathBuf> {
    if id.contains(['/', '\0']) || !is_report_name(id) {
        return Err("That is not a report".into());
    }
    if !snapshot["reports"].as_array().into_iter().flatten().any(|r| r["id"] == id) {
        return Err("That report is not in the last scan. Refresh and try again.".into());
    }
    let dir = scanned_folder(env, snapshot)?;
    let file = dir.join(id);
    let plain = fs::symlink_metadata(&file).is_ok_and(|m| m.is_file());
    if !plain || !canonical(&file).ok().as_deref().and_then(Path::parent).is_some_and(|parent| same_path(parent, &dir))
    {
        return Err("That report is gone".into());
    }
    Ok(file)
}

pub fn read(env: &Env, snapshot: &Value, id: &str) -> Result<Value> {
    let file = listed(env, snapshot, id)?;
    let raw = files::text_nofollow(&file, MAX_BYTES)
        .ok_or("That report can't be read: it is gone, over 2 MB, or not UTF-8 text")?;
    Ok(json!({"id":id,"file":file,"raw":raw}))
}

fn boundary(text: &str, mut at: usize, forward: bool) -> usize {
    while !text.is_char_boundary(at) {
        if forward { at += 1 } else { at -= 1 }
    }
    at
}

/// Reports whose text holds every word of `query`, newest first, each with the text around its first match.
/// Only reports of the last scan are read, and the search stops early on a slow or very large folder.
pub fn search(env: &Env, snapshot: &Value, ids: &[&str], query: &str, limit: usize) -> Result<Vec<Value>> {
    search_until(env, snapshot, ids, query, limit).map(|(hits, _)| hits)
}
/// [`search`], and whether it stopped on its time or size budget before reading every report.
fn search_until(env: &Env, snapshot: &Value, ids: &[&str], query: &str, limit: usize) -> Result<(Vec<Value>, bool)> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 200 {
        return Err("Search for 1 to 200 characters".into());
    }
    let pattern = |text: &str| RegexBuilder::new(text).case_insensitive(true).build().map_err(|e| e.to_string());
    let terms: Vec<&str> = query.split_whitespace().take(12).collect();
    let words: Vec<Regex> = terms.iter().map(|w| pattern(&regex::escape(w))).collect::<Result<_>>()?;
    // The snippet shows the words together where they are, else the most telling one.
    let phrase = pattern(&terms.iter().map(|w| regex::escape(w)).collect::<Vec<_>>().join(r"\s+"))?;
    let longest = terms.iter().enumerate().max_by_key(|(_, w)| w.chars().count()).map_or(0, |(i, _)| i);
    let dir = scanned_folder(env, snapshot)?;
    let started = Instant::now();
    let mut budget: u64 = 64 * 1024 * 1024;
    let mut hits = Vec::new();
    for id in ids {
        if hits.len() >= limit {
            break;
        }
        if budget == 0 || started.elapsed() > Duration::from_secs(3) {
            return Ok((hits, true));
        }
        if id.contains(['/', '\0']) || !is_report_name(id) {
            continue;
        }
        let Some(text) = files::text_nofollow(&dir.join(id), MAX_BYTES) else { continue };
        budget = budget.saturating_sub(text.len() as u64);
        if !words.iter().all(|w| w.is_match(&text)) {
            continue;
        }
        let Some(found) = phrase.find(&text).or_else(|| words[longest].find(&text)) else { continue };
        let start = boundary(&text, found.start().saturating_sub(60), false);
        let end = boundary(&text, (found.end() + 60).min(text.len()), true);
        let mut snippet = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
        if start > 0 {
            snippet.insert(0, '…');
        }
        if end < text.len() {
            snippet.push('…');
        }
        hits.push(json!({"id":id,"snippet":snippet}));
    }
    Ok((hits, false))
}

/// Opens a report in the editor, or the reports folder in the file manager.
pub fn open(env: &Env, snapshot: &Value, apps: &Value, what: &str, id: &str) -> Result<Value> {
    match what {
        "editor" => {
            let file = listed(env, snapshot, id)?;
            let dir = file.parent().unwrap_or(&env.home).to_owned();
            let app = apps["editor"].as_str().unwrap_or(crate::platform::DEFAULT_APPS.editor);
            crate::service::detach(app, &[file.to_string_lossy().into()], &dir)?;
        }
        "folder" => {
            let dir = scanned_folder(env, snapshot)?;
            let app = apps["files"].as_str().unwrap_or(crate::platform::DEFAULT_APPS.files);
            crate::service::detach(app, &[dir.to_string_lossy().into()], &dir)?;
        }
        _ => return Err("Unknown action".into()),
    }
    Ok(json!({"ok":true}))
}

/// The read-only report requests, answered from a snapshot without the engine lock.
pub fn request(env: &Env, snapshot: &Value, apps: &Value, name: &str, body: &Value) -> Result<Value> {
    let text = |key: &str| body[key].as_str().unwrap_or("");
    match name {
        "reports/read" => read(env, snapshot, text("id")),
        "reports/search" => {
            let ids: Vec<&str> =
                snapshot["reports"].as_array().into_iter().flatten().filter_map(|r| r["id"].as_str()).collect();
            search(env, snapshot, &ids, text("query"), 100).map(Value::from)
        }
        "reports/open" => open(env, snapshot, apps, text("what"), text("id")),
        _ => Err(format!("Unknown action: {name}")),
    }
}

/// Reports for an agent: newest first, those linked to a project under `under`, matching `query` if given, `limit`
/// of them from `offset`.
pub fn list(
    env: &Env,
    snapshot: &Value,
    under: Option<&Path>,
    query: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<Value> {
    let Some(dir) = snapshot.get("reportsDir").filter(|d| d.is_object()) else {
        return Ok(
            json!({"folder":null,"reports":[],"total":0,"more":false,"note":"No reports folder is set in Laci's Settings"}),
        );
    };
    if let Some(error) = dir["error"].as_str() {
        return Ok(json!({"folder":{"path":dir["path"],"error":error},"reports":[],"total":0,"more":false}));
    }
    let mut reports: Vec<&Value> = snapshot["reports"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            under.is_none_or(|under| {
                r["projects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .any(|p| paths::within(Path::new(p), under))
            })
        })
        .collect();
    let mut snippets: HashMap<String, Value> = HashMap::new();
    let mut partial = false;
    if let Some(query) = query {
        let ids: Vec<&str> = reports.iter().filter_map(|r| r["id"].as_str()).collect();
        // Every match, so the total is right on every page, unless the search runs out of its time or size budget.
        let (hits, stopped) = search_until(env, snapshot, &ids, query, ids.len())?;
        partial = stopped;
        for hit in hits {
            snippets.insert(hit["id"].as_str().unwrap_or("").to_owned(), hit["snippet"].clone());
        }
        reports.retain(|r| snippets.contains_key(r["id"].as_str().unwrap_or("")));
    }
    let total = reports.len();
    let more = partial || total > offset.saturating_add(limit);
    let out: Vec<Value> = reports
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|r| {
            let mut out = json!({});
            for key in
                ["id", "title", "date", "file", "projects", "sessions", "summary", "open", "openCount", "closedCount"]
            {
                if !r[key].is_null() {
                    out[key] = r[key].clone();
                }
            }
            if let Some(snippet) = snippets.get(r["id"].as_str().unwrap_or("")) {
                out["snippet"] = snippet.clone();
            }
            out
        })
        .collect();
    let mut answer =
        json!({"folder":{"path":dir["path"],"total":dir["total"]},"reports":out,"total":total,"more":more});
    if partial {
        answer["partial"] = json!(true);
        answer["note"] = json!("The search stopped early on a large folder; total counts the reports it read");
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODIFIED: &str = "2026-10-14T00:00:00.000Z";

    #[test]
    fn header_fields_keep_paths_and_session_ids_and_ignore_what_is_no_path() {
        let text = "# Raster `design` system\n\n- **Date:** 2026-10-13 (work ran into 2026-10-14)\n\
            - **Session:** `/home/u` · `FBC5DAE5-6918-497a-99ce-e36400938bb6`, continued in \
            183b6f12-d98d-4339-ba72-2460c4d50eb3 (session name `portfolio-90`)\n\
            - **Projects:** /home/u/project/raster, ~/project/infra, Figma file \"Raster\",\n  \
            /home/u/project/laci (branch `feat/x`, PR #16), see https://github.com/x/y; Gmail me@example.com\n  \
            - `/home/u/my project/site` (github.com/u/site)\n\n## Summary\nFirst line\nsecond line.\n\n\
            Later paragraph.\n\n## Open\n- one\n";
        let facts = parse("2026-10-13-raster.md", text, MODIFIED);
        assert_eq!(facts["title"], "Raster design system");
        assert_eq!(facts["date"], "2026-10-13");
        assert_eq!(
            facts["sessions"],
            json!(["fbc5dae5-6918-497a-99ce-e36400938bb6", "183b6f12-d98d-4339-ba72-2460c4d50eb3"])
        );
        assert_eq!(facts["sessionPaths"], json!(["/home/u"]));
        assert_eq!(
            facts["projectPaths"],
            json!(["/home/u/my project/site", "/home/u/project/raster", "~/project/infra", "/home/u/project/laci"])
        );
        let scope = facts["scope"].as_str().unwrap();
        assert!(scope.starts_with("/home/u/project/raster, ~/project/infra") && !scope.contains('`'), "{scope}");
        assert!(scope.ends_with("; /home/u/my project/site (github.com/u/site)"), "{scope}");
        assert_eq!(facts["summary"], "First line second line.");
        assert_eq!(facts["open"], json!(["one"]));
        assert_eq!(facts["openCount"], 1);
    }

    #[test]
    fn missing_fields_fall_back_to_the_file_name_and_its_time() {
        let facts = parse("2026-02-03-fix-the-build.md", "Just text\n", MODIFIED);
        assert_eq!((facts["title"].as_str(), facts["date"].as_str()), (Some("Fix the build"), Some("2026-02-03")));
        assert_eq!(facts["sessions"], json!([]));
        assert!(facts["summary"].is_null() && facts["scope"].is_null());
        assert_eq!(facts["open"], json!([]));
        assert_eq!(parse("notes.md", "", MODIFIED)["date"], json!(local_day(MODIFIED)));
        assert_eq!(parse("notes.md", "", MODIFIED)["title"], "Notes");
        let invalid = parse("2026-01-02-x.md", "- **Date:** 2026-13-40\n", MODIFIED);
        assert_eq!(invalid["date"], "2026-01-02", "an impossible date is no date");
        assert_eq!(parse("x.md", "- **Date**: 2026-07-08\n", MODIFIED)["date"], "2026-07-08");
        let front = "---\ndate: 2026-03-04\nsession: 0adaa996-bb83-4ac2-a823-963b6afc49b0\n\
            projects: [~/project/a, ~/project/b]\n---\n# From front matter\n";
        let facts = parse("x.md", front, MODIFIED);
        assert_eq!(facts["title"], "From front matter");
        assert_eq!(facts["date"], "2026-03-04");
        assert_eq!(facts["sessions"], json!(["0adaa996-bb83-4ac2-a823-963b6afc49b0"]));
        assert_eq!(facts["projectPaths"], json!(["~/project/a", "~/project/b"]));
        let windows = parse("x.md", "\u{feff}# Title\r\n\r\n- **Date:** 2026-01-02\r\n## Open\r\n- a\r\n", MODIFIED);
        assert_eq!((windows["title"].as_str(), windows["date"].as_str()), (Some("Title"), Some("2026-01-02")));
        assert_eq!(windows["open"], json!(["a"]));
    }

    #[test]
    fn the_last_open_section_counts_and_its_entries_join_their_lines() {
        let text = "# T\n\n## Open\n- old\n\n## Later\nx\n\n## Open items\n- [ ] first\n  continued line\n  - sub item\n\
            - [x] **second**\n1. third\n\nNothing open.\n\n```\n## Open\n- inside a code block\n```\n";
        let facts = parse("t.md", text, MODIFIED);
        assert_eq!(facts["open"], json!(["first continued line; sub item", "second", "third"]));
        assert_eq!(facts["openCount"], 3);
        let paragraphs = parse("t.md", "## Open\nFirst thing to do\nstill first.\n\nSecond thing.\n", MODIFIED);
        assert_eq!(paragraphs["open"], json!(["First thing to do still first.", "Second thing."]));
        assert_eq!(parse("t.md", "## Open\nNothing open.\n", MODIFIED)["openCount"], 0);
        let many: String = (0..10).map(|i| format!("- item {i} {}\n", "x".repeat(300))).collect();
        let capped = parse("t.md", &format!("## Open\n{many}"), MODIFIED);
        assert_eq!(capped["openCount"], 10);
        let open = capped["open"].as_array().unwrap();
        assert_eq!(open.len(), OPEN_ITEMS);
        assert!(open.iter().all(|i| i.as_str().unwrap().chars().count() == 240 && i.as_str().unwrap().ends_with('…')));
    }

    #[test]
    fn path_tokens_trim_punctuation_and_skip_network_paths() {
        assert_eq!(
            path_tokens("/a/b. and /c/d: ~/e/ //net/x `~/with space/x` (/f), \"/g\""),
            ["~/with space/x", "/a/b", "/c/d", "~/e", "/f", "/g"]
        );
        assert!(path_tokens("feat/x https://a.b/c ~ / github.com/a").is_empty());
    }

    #[test]
    fn windows_reports_name_paths_by_drive_share_or_home() {
        let text = r"C:\Users\me\proj. and `C:\Users\me\my proj` \\nas\share\x, ~\notes c:/dev/{a,b} D: /c/d";
        assert_eq!(
            tokens(text, true),
            [r"C:\Users\me\my proj", r"C:\Users\me\proj", r"\\nas\share\x", r"~\notes", "c:/dev/a", "c:/dev/b", "/c/d"]
        );
        assert_eq!(tokens(r"C:\Users\me `D:\x` ~\notes \\nas\share\x /c/d", false), ["/c/d"], "elsewhere no paths");
        assert_eq!(
            tokens(r"`C:\p\{api,web}\src` C:\q\{a, b}", true),
            [r"C:\p\api\src", r"C:\p\web\src", r"C:\q\a", r"C:\q\b"]
        );
    }

    #[test]
    fn shorthand_paths_name_every_project_in_the_braces() {
        assert_eq!(
            path_tokens("/home/u/personal/{raster, ledger} and `~/p/{api,web}/src`, {not, a, path}"),
            ["~/p/api/src", "~/p/web/src", "/home/u/personal/raster", "/home/u/personal/ledger"]
        );
        let header = "# Catalog\n\n- **Projects:** /home/u/project/portfolio (PR #16), /home/u/project/personal/{raster, ledger,\n  verso} (each a repo), Figma \"{Name} Design System\"\n";
        assert_eq!(
            parse("x.md", header, MODIFIED)["projectPaths"],
            json!([
                "/home/u/project/portfolio",
                "/home/u/project/personal/raster",
                "/home/u/project/personal/ledger",
                "/home/u/project/personal/verso"
            ])
        );
    }

    #[test]
    fn a_longer_fence_can_show_a_shorter_one() {
        let text = "# Notes on reports\n\n## Summary\nHow a report looks.\n\n````markdown\n## Summary\nNot this one.\n```\n## Open\n- Not an item\n```\n````\n\n## Open\n- The real item\n~~~\n- Inside a tilde fence\n~~~\n";
        let facts = parse("x.md", text, MODIFIED);
        assert_eq!(facts["summary"], "How a report looks.");
        assert_eq!(facts["open"], json!(["The real item"]));
    }

    #[test]
    fn report_names_skip_the_index_and_hidden_files() {
        for name in ["a.md", "2026-01-02-x.MD"] {
            assert!(is_report_name(name), "{name}");
        }
        for name in ["README.md", "readme.MD", ".draft.md", ".md", "notes.txt", "md"] {
            assert!(!is_report_name(name), "{name}");
        }
    }

    #[test]
    fn reports_link_to_projects_never_to_folders_or_home() {
        // `/h/…`, an absolute path on this OS: on Windows on drive C.
        let at = |path: &str| if cfg!(windows) { format!("C:{}", path.replace('/', r"\")) } else { path.to_owned() };
        let env = Env::for_home(PathBuf::from(at("/h")));
        let mut nodes = json!({});
        let kinds = [("/h", "project"), ("/h/p", "project"), ("/h/p/nested", "project"), ("/h/q", "project")];
        for (path, kind) in kinds.into_iter().chain([("/h/group", "folder")]) {
            nodes[at(path)] = json!({"kind":kind,"path":at(path)});
        }
        let snapshot = json!({
            "nodes": nodes,
            "sessions": [{"sessionId":"AAAAAAAA-0000-0000-0000-000000000000","cwd":at("/h/p/nested/src")}],
            "items": {"x": {"sessionId":"bbbbbbbb-0000-0000-0000-000000000000","cwd":at("/h/q")}},
        });
        let linker = Linker::new(&env, &snapshot);
        let facts = json!({
            "projectPaths": [at("/h/p/file.md"), at("/h/group"), at("/etc/x"), "~/q/readme"],
            "sessionPaths": [at("/h")],
            "sessions": ["aaaaaaaa-0000-0000-0000-000000000000"],
        });
        assert_eq!(linker.link(&env, &facts), [at("/h/p"), at("/h/p/nested"), at("/h/q")]);
        let antigravity =
            json!({"projectPaths":[],"sessionPaths":[at("/h")],"sessions":["bbbbbbbb-0000-0000-0000-000000000000"]});
        assert_eq!(linker.link(&env, &antigravity), [at("/h/q")], "conversations listed as items link too");
        let nothing = json!({"projectPaths":[at("/h/group/a"), "~/notes"],"sessionPaths":[at("/h")],"sessions":[]});
        assert!(linker.link(&env, &nothing).is_empty());
    }

    #[test]
    fn only_plain_markdown_files_directly_in_the_folder_are_reports() {
        let temp = tempfile::tempdir().unwrap();
        let env = Env::for_home(temp.path().join("home"));
        let dir = temp.path().join("reports");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join("dir.md")).unwrap();
        fs::create_dir_all(&env.home).unwrap();
        fs::write(dir.join("2026-01-02-ok.md"), "# Ok\n\n## Open\n- one\n").unwrap();
        for name in ["README.md", "readme.MD", ".hidden.md", "notes.txt", "sub/x.md"] {
            fs::write(dir.join(name), "# Not a report\n").unwrap();
        }
        fs::write(dir.join("bad.md"), [0xff, 0xfe, 0xfd]).unwrap();
        fs::write(dir.join("big.md"), "x".repeat(MAX_BYTES as usize + 1)).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("2026-01-02-ok.md"), dir.join("link.md")).unwrap();
        let (found, total) = candidates(&dir);
        // Without a date in its name, a file is dated by its time: today, so first.
        assert_eq!(found.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["bad.md", "2026-01-02-ok.md"]);
        assert_eq!(total, 2);
        config::save(&env, &json!({"reportsDir":dir})).unwrap();
        let mut snapshot = json!({"nodes":{},"sessions":[],"items":{}});
        attach(&env, &mut snapshot);
        assert_eq!(snapshot["reportsDir"], json!({"path":dir,"total":2}));
        let reports = snapshot["reports"].as_array().unwrap();
        assert_eq!(reports.len(), 1, "a file that is not UTF-8 text is left out");
        assert_eq!(reports[0]["id"], "2026-01-02-ok.md");
        assert_eq!(reports[0]["open"], json!(["one"]));
        assert!(env.cache_dir.join(CACHE).is_file());
        config::save(&env, &json!({})).unwrap();
        attach(&env, &mut snapshot);
        assert!(snapshot.get("reportsDir").is_none() && snapshot.get("reports").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_moved_or_became_a_link_is_not_read() {
        let temp = tempfile::tempdir().unwrap();
        let env = Env::for_home(temp.path().join("home"));
        let dir = temp.path().join("drive/reports");
        fs::create_dir_all(&dir).unwrap();
        let cfg = json!({"reportsDir":dir});
        assert_eq!(folder(&env, &cfg).unwrap().unwrap(), dir);
        assert!(folder(&env, &json!({"reportsDir":""})).is_none());
        fs::rename(&dir, temp.path().join("elsewhere")).unwrap();
        assert_eq!(folder(&env, &cfg).unwrap().unwrap_err().1, "Folder not found");
        std::os::unix::fs::symlink(temp.path().join("elsewhere"), &dir).unwrap();
        assert!(folder(&env, &cfg).unwrap().unwrap_err().1.contains("replaced by a link"));
        fs::remove_file(&dir).unwrap();
        fs::rename(temp.path().join("drive"), temp.path().join("old-drive")).unwrap();
        fs::create_dir_all(temp.path().join("old-drive/reports")).unwrap();
        std::os::unix::fs::symlink(temp.path().join("old-drive"), temp.path().join("drive")).unwrap();
        assert!(folder(&env, &cfg).unwrap().unwrap_err().1.contains("leads through a link"));
        let mut snapshot = json!({"nodes":{}});
        config::save(&env, &cfg).unwrap();
        attach(&env, &mut snapshot);
        assert_eq!(snapshot["reports"], json!([]));
        assert!(snapshot["reportsDir"]["error"].is_string());
    }
}
