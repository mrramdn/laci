//! Files that look like secrets, found by their names only: Laci never opens them. Before a first saved version or an
//! upload, both designs show the ones Git would take, including those in saved versions that aren't online yet, and
//! "Keep these out" lists them in the project's .gitignore, with Undo.
use crate::{
    Result, activity,
    env::Env,
    files,
    git::{self, Repo},
    ops, paths, platform,
    service::string,
    sidecar,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

/// Names that look like secrets, whatever their case. `*` stands for any run of characters.
const NAMES: [&str; 13] = [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.keystore",
    "*.jks",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    "*credentials*.json",
    "service-account*.json",
];
/// How a `.env.*` file that only shows which settings to fill in ends.
const EXAMPLES: [&str; 4] = ["example", "sample", "template", "dist"];
/// Folders of other people's packages, whose test keys and examples would bury the project's own. Build output is
/// checked: it is made from the project, often with copies of its secrets.
const DEPENDENCIES: [&str; 8] =
    ["node_modules", "vendor", ".venv", "venv", "__pycache__", ".gradle", ".dart_tool", ".parcel-cache"];
/// How many files a check lists; `more` counts the rest.
const SHOWN: usize = 50;
const WAIT: Duration = Duration::from_secs(20);
static SEQ: AtomicU64 = AtomicU64::new(0);

/// Whether `name` matches all of `pattern`, where `*` is any run of characters.
fn glob(pattern: &str, name: &str) -> bool {
    let mut parts = pattern.split('*');
    let Some(mut rest) = name.strip_prefix(parts.next().unwrap_or("")) else { return false };
    let mut parts: Vec<&str> = parts.collect();
    let Some(last) = parts.pop() else { return rest.is_empty() };
    for part in parts {
        let Some(at) = rest.find(part) else { return false };
        rest = &rest[at + part.len()..];
    }
    rest.ends_with(last)
}

/// Whether a file name looks like it holds a secret. Examples of a `.env` file and public SSH keys don't.
fn looks_secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let example =
        name.strip_prefix(".env.").is_some_and(|rest| EXAMPLES.contains(&rest.rsplit('.').next().unwrap_or("")));
    let public = name.starts_with("id_") && name.ends_with(".pub");
    NAMES.iter().any(|pattern| glob(pattern, &name)) && !example && !public
}

/// A file that looks like a secret and that Git would add, or that is in a saved version: one Git tracks, or one an
/// upload would take. `path` is relative to the project; when the name isn't valid text, `exact` is false and `path`
/// only shows it.
struct Found {
    path: String,
    tracked: bool,
    exact: bool,
}

/// Every such file in the project, once each: the ones in a saved version first, then the shallowest.
fn found(dir: &Path) -> Result<Vec<Found>> {
    // With this set, Git takes the patterns below as plain names and finds nothing.
    let literal = std::env::var("GIT_LITERAL_PATHSPECS").unwrap_or_default().to_ascii_lowercase();
    if !["", "0", "false", "no", "off"].contains(&literal.as_str()) {
        return Err("Laci can't look for secrets while GIT_LITERAL_PATHSPECS is set".into());
    }
    // A folder without Git of its own is checked the way a new repository there would see it, so a repository in a
    // folder above it doesn't answer for it.
    let scratch = if dir.join(".git").exists() { None } else { Some(tempfile::tempdir().map_err(|e| e.to_string())?) };
    let mut base = vec![];
    if let Some(scratch) = &scratch {
        let at = scratch.path().join("new.git");
        git::plain(dir, &["init", "--quiet", "--bare", "--template=", &at.to_string_lossy()], WAIT)?;
        base = vec![format!("--git-dir={}", at.display()), format!("--work-tree={}", dir.display())];
    }
    let repo = Repo::at(dir);
    let specs: Vec<String> = NAMES.iter().map(|name| format!(":(glob,icase)**/{name}")).collect();
    let list = |what: &[&str], tracked: bool| -> Result<Vec<Found>> {
        let mut args: Vec<&str> = base.iter().map(String::as_str).collect();
        args.extend_from_slice(what);
        args.push("--");
        args.extend(specs.iter().map(String::as_str));
        let listing = repo.run_bytes(&args, WAIT)?;
        Ok(git::names(&listing)
            .map(git::text)
            .filter(|(path, _)| {
                let mut parts: Vec<&str> = path.split('/').collect();
                let name = parts.pop().unwrap_or("");
                looks_secret(name) && !parts.iter().any(|part| DEPENDENCIES.contains(part))
            })
            .map(|(path, exact)| Found { path, tracked, exact })
            .collect())
    };
    let mut out = list(&["ls-files", "-z", "--cached"], true)?;
    out.extend(list(&["ls-files", "-z", "--others", "--exclude-standard"], false)?);
    if scratch.is_none() {
        // An upload takes every saved version that isn't online yet, with files Git has stopped tracking since. The
        // stash is never uploaded.
        let log = ["log", "-z", "--format=", "--name-only", "--diff-filter=d", "--exclude=refs/stash", "--all"];
        out.extend(list(&[&log[..], &["--not", "--remotes"]].concat(), true)?);
    }
    let depth = |found: &Found| found.path.matches('/').count();
    out.sort_by(|a, b| (!a.tracked, depth(a), &a.path).cmp(&(!b.tracked, depth(b), &b.path)));
    // A file in the middle of a merge is listed once for each side, and one can be both saved and untracked now.
    let mut seen = std::collections::BTreeSet::new();
    out.retain(|found| seen.insert(found.path.clone()));
    Ok(out)
}

fn project(env: &Env, node: &Value) -> Result<PathBuf> {
    if node["kind"] != "project" {
        return Err("Pick a project".into());
    }
    let dir = paths::workspace_path(string(node, "path"), env)?;
    sidecar::plain_path(&dir)?;
    if !dir.is_dir() {
        return Err("That project is gone".into());
    }
    Ok(dir)
}

/// `secrets/check`: the files that look like secrets and that Git would add or already tracks, by name.
pub fn check(env: &Env, node: &Value) -> Result<Value> {
    let found = found(&project(env, node)?)?;
    let shown: Vec<Value> =
        found.iter().take(SHOWN).map(|found| json!({"path":found.path,"tracked":found.tracked})).collect();
    Ok(json!({"files":shown,"more":found.len().saturating_sub(SHOWN)}))
}

/// The line ending most of the file's lines use, as Laci decides it for its notes file: CRLF needs more lines.
fn ending(text: &[u8]) -> &'static [u8] {
    let lines = text.iter().filter(|b| **b == b'\n').count();
    let crlf = text.windows(2).filter(|pair| *pair == b"\r\n").count();
    if crlf > lines - crlf { b"\r\n" } else { b"\n" }
}

/// A .gitignore line that matches this one path, from the project's top folder down.
fn pattern(path: &str) -> String {
    let mut line = String::from("/");
    for c in path.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            line.push('\\');
        }
        line.push(c);
    }
    // Git drops spaces at the end of a line unless each is escaped.
    let spaces = line.len() - line.trim_end_matches(' ').len();
    line.truncate(line.len() - spaces);
    line.push_str(&"\\ ".repeat(spaces));
    line
}

/// "it" or "them", for `count` files.
fn them(count: usize) -> &'static str {
    if count == 1 { "it" } else { "them" }
}

/// Creates `file` the way an editor would, with the usual permissions, and never over one that appeared meanwhile.
fn create(file: &Path, bytes: &[u8]) -> Result<()> {
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(file).map_err(|e| e.to_string())?;
    out.write_all(bytes).and_then(|()| out.sync_all()).map_err(|error| {
        let _ = fs::remove_file(file);
        error.to_string()
    })
}

/// Writes `after` over `file` with a journal in the form `ops` keeps, so Undo puts back the bytes `file` had, or
/// removes it if it was new, as long as it still holds `after`. Runs under the change lock.
fn write_journaled(
    env: &Env,
    title: &str,
    say: Value,
    file: &Path,
    before: Option<&[u8]>,
    after: &[u8],
) -> Result<Value> {
    let journals = ops::data(env, "journal")?;
    let id = loop {
        let id = format!(
            "{}-{:x}-{:x}",
            files::now().replace([':', '.'], "-"),
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        );
        if !journals.join(format!("{id}.json")).exists() {
            break id;
        }
    };
    let backup = match before {
        Some(bytes) => {
            let copies = ops::data(env, "backup")?.join(&id);
            let backup = copies.join(format!("1-{}", file.file_name().unwrap_or_default().to_string_lossy()));
            let kept = files::replace(&backup, bytes)
                .and_then(|()| platform::preserve(&fs::metadata(file).map_err(|e| e.to_string())?, &backup));
            if let Err(error) = kept {
                let _ = fs::remove_dir_all(&copies);
                return Err(error);
            }
            Some(backup)
        }
        None => None,
    };
    let mut journal = json!({"id":id,"at":files::now(),"title":title,"say":say,"state":"running","entries":[
        {"kind":"file","path":file,"existed":before.is_some(),"backup":backup,
            "afterHash":format!("{:x}", Sha256::digest(after))}
    ]});
    let save = |journal: &Value| {
        let text = serde_json::to_vec_pretty(journal).map_err(|e| e.to_string())?;
        files::replace(&journals.join(format!("{id}.json")), &text)
    };
    save(&journal)?;
    let written = if before.is_some() { files::replace(file, after) } else { create(file, after) };
    let failed = match written {
        // Nothing changed, so the journal has nothing to undo.
        Err(error) => Some(error),
        Ok(()) => {
            journal["state"] = json!("applied");
            let saved = save(&journal);
            if saved.is_err() {
                // No change stays without its journal: the file gets back the bytes it had, or goes again.
                let _ = match before {
                    Some(bytes) => files::replace(file, bytes),
                    None => fs::remove_file(file).map_err(|e| e.to_string()),
                };
            }
            saved.err()
        }
    };
    if let Some(error) = failed {
        journal["state"] = json!("undone");
        journal["error"] = json!(error);
        let _ = save(&journal);
        return Err(error);
    }
    journal["canUndo"] = json!(ops::can_undo(&journal));
    Ok(journal)
}

/// `secrets/keep-out`: adds `files`, which must be on the check's list, to the project's .gitignore, one line each
/// in the file's own line ending. Returns the change with its journal, which Undo reverts.
pub fn keep_out(env: &Env, node: &Value, list: &Value, by: &str) -> Result<Value> {
    let asked = list
        .as_array()
        .filter(|list| !list.is_empty())
        .ok_or("Choose the files to keep out")?
        .iter()
        .map(|file| file.as_str().ok_or("Invalid file name"))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for path in &asked {
        if path.is_empty() || Path::new(path).components().any(|part| !matches!(part, Component::Normal(_))) {
            return Err(format!("{path} isn't inside the project"));
        }
        if path.contains(['\n', '\r']) {
            return Err("A name with a line break can't be written in .gitignore".into());
        }
    }
    let dir = project(env, node)?;
    ops::with_lock(env, || {
        // Checked again here: only a file the check would list now can be kept out.
        let listed = found(&dir)?;
        let mut chosen: Vec<&Found> = vec![];
        for path in &asked {
            let found = listed
                .iter()
                .find(|found| found.path == *path)
                .ok_or_else(|| format!("{path} isn't on the list of files that look like secrets. Check again."))?;
            if !found.exact {
                return Err(format!(
                    "The name of {path} isn't valid text, so .gitignore can't name it. Rename it, then check again."
                ));
            }
            if !chosen.iter().any(|known| known.path == found.path) {
                chosen.push(found);
            }
        }
        let file = dir.join(".gitignore");
        paths::workspace_path(&file.to_string_lossy(), env)?;
        sidecar::plain_path(&file)?;
        let before = match fs::symlink_metadata(&file) {
            Ok(meta) if meta.is_file() => Some(fs::read(&file).map_err(|e| e.to_string())?),
            Ok(_) => return Err(".gitignore isn't a plain file".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        let text = before.clone().unwrap_or_default();
        let has = |line: &str| {
            text.split(|b| *b == b'\n').any(|have| have.strip_suffix(b"\r").unwrap_or(have) == line.as_bytes())
        };
        let tracked: Vec<&str> = chosen.iter().filter(|found| found.tracked).map(|found| found.path.as_str()).collect();
        // A file Git can still add needs its line even if one is there: a later rule may let the file back in, and
        // the last line that matches wins.
        let added: Vec<&Found> =
            chosen.into_iter().filter(|found| !found.tracked || !has(&pattern(&found.path))).collect();
        if added.is_empty() {
            let it = them(tracked.len());
            return Err(format!(
                "{} {} already in .gitignore, but Git still tracks {it}. Ask your AI to stop tracking {it} without \
deleting {it}.",
                tracked.join(", "),
                if tracked.len() == 1 { "is" } else { "are" }
            ));
        }
        let eol = ending(&text);
        let mut after = text.clone();
        if !after.is_empty() && !after.ends_with(b"\n") {
            after.extend_from_slice(eol);
        }
        for found in &added {
            after.extend_from_slice(pattern(&found.path).as_bytes());
            after.extend_from_slice(eol);
        }
        let names: Vec<&str> = added.iter().map(|found| found.path.as_str()).collect();
        let what = if let [one] = names.as_slice() { (*one).to_owned() } else { format!("{} files", names.len()) };
        let title = format!("Added {what} to .gitignore in {}", string(node, "name"));
        let say = json!({"form":"keptOut","files":names.len(),"name":string(node, "name")});
        let journal = write_journaled(env, &title, say.clone(), &file, before.as_deref(), &after)?;
        let mut warnings = vec![];
        if !tracked.is_empty() {
            let it = them(tracked.len());
            warnings.push(format!(
                "Git still tracks {}, so the saved versions keep {it}. Ask your AI to stop tracking {it} without \
deleting {it}.",
                tracked.join(", ")
            ));
        }
        match found(&dir) {
            Ok(now) => {
                let open: Vec<&str> = names
                    .iter()
                    .copied()
                    .filter(|path| now.iter().any(|found| !found.tracked && found.path == *path))
                    .collect();
                if !open.is_empty() {
                    let it = them(open.len());
                    warnings.push(format!("Git can still add {}: another .gitignore lets {it} in.", open.join(", ")));
                }
            }
            Err(error) => warnings.push(format!("Couldn't check the result: {error}")),
        }
        activity::record(
            env,
            json!({"by":by,"title":title,"say":say,"detail":names.join(", "),"path":dir,"journal":journal["id"],
                "key":format!("gitignore:{}",dir.display()),"undo":{"type":"journal","id":journal["id"]}}),
        );
        Ok(json!({"journal":journal,"warnings":warnings}))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_look_like_secrets() {
        for name in [
            ".env",
            ".ENV",
            ".env.local",
            ".env.production",
            ".env.example.local",
            "server.pem",
            "tls.KEY",
            "cert.p12",
            "cert.pfx",
            "release.keystore",
            "upload.jks",
            "id_rsa",
            "id_ed25519",
            "id_ecdsa_work",
            "credentials.json",
            "gcp-credentials-prod.json",
            "service-account.json",
            "Service-Account-ci.json",
        ] {
            assert!(looks_secret(name), "{name}");
        }
        for name in [
            ".env.example",
            ".env.local.sample",
            ".env.template",
            ".env.dist",
            ".envrc",
            "env",
            "id_rsa.pub",
            "id_ed25519.pub",
            "credentials.yaml",
            "account.json",
            "pem",
            "notes.txt",
            "key.pem.txt",
        ] {
            assert!(!looks_secret(name), "{name}");
        }
    }

    #[test]
    fn a_pattern_matches_its_path_and_nothing_else() {
        assert_eq!(pattern(".env"), "/.env");
        assert_eq!(pattern("config/credentials.json"), "/config/credentials.json");
        assert_eq!(pattern("odd[1]*?.pem"), "/odd\\[1]\\*\\?.pem");
        assert_eq!(pattern("back\\slash.key"), "/back\\\\slash.key");
        assert_eq!(pattern("#!.env"), "/#!.env");
        assert_eq!(pattern("trailing.key  "), "/trailing.key\\ \\ ");
    }

    #[test]
    fn the_line_ending_is_the_one_most_lines_use() {
        for (text, eol) in [
            (&b""[..], &b"\n"[..]),
            (b"one line", b"\n"),
            (b"a\nb\n", b"\n"),
            (b"a\r\nb\r\n", b"\r\n"),
            (b"a\r\nb\r\nc\n", b"\r\n"),
            (b"a\r\nb\n", b"\n"),
        ] {
            assert_eq!(ending(text), eol, "{text:?}");
        }
    }
}
