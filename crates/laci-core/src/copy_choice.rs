//! Which chats the copy of AI chats takes. Unless projects were chosen for it in Settings (`backupOnly`), it takes
//! every chat. With a choice, a chat is copied when the nearest scanned folder holding the folder it was started in,
//! a project or a group, is one that was ticked, and a chat in none of them when `outside` was ticked. A project that
//! appears later is its own folder, not ticked, so it is copied only once it is ticked. A file whose folder Laci can't
//! tell, as an index a tool keeps for all its chats, is copied: the choice errs on keeping. Unticking a project only
//! stops new copies; nothing is removed from the copy.
use crate::{Result, agents, env::Env, paths, platform::path::relocate};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

/// The most folders a choice may name, so a hand-edited setting can't make every run slow.
const MOST: usize = 10_000;
/// The most logs of a Claude Code folder read to find where its chats were started, when the folder is gone.
const LOGS: usize = 50;

/// The projects and groups chosen for the copy of AI chats, and the folders the last scan found, which tell the chats
/// of a project that wasn't ticked from those of the group around it.
pub struct Choice {
    chosen: Vec<PathBuf>,
    outside: bool,
    /// The scanned folders and the chosen ones: a chosen folder that is gone still holds its chats.
    known: Vec<PathBuf>,
    /// Where the chats in each folder of a store that names its folders after a project were started.
    named: HashMap<String, Option<PathBuf>>,
}

impl Choice {
    /// The choice saved in `cfg`, told against the scanned folders `nodes` (the scan's `nodes`, by id), or `None` when
    /// every chat is copied.
    pub fn load(env: &Env, cfg: &Value, nodes: &Value) -> Option<Self> {
        let only = cfg["backupOnly"].as_object()?;
        let chosen: Vec<PathBuf> = only
            .get("paths")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|raw| paths::expand(raw, &env.home))
            .filter(|path| path.is_absolute())
            .take(MOST)
            .collect();
        let mut known: Vec<PathBuf> = nodes
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(_, n)| n["path"].as_str())
            .map(PathBuf::from)
            .chain(chosen.iter().cloned())
            .collect();
        known.sort();
        known.dedup();
        Some(Self {
            chosen,
            outside: only.get("outside").and_then(Value::as_bool) == Some(true),
            known,
            named: HashMap::new(),
        })
    }

    /// Whether a chat started in `folder` is copied.
    pub fn wants(&self, folder: &Path) -> bool {
        match self.known.iter().filter(|known| paths::within(folder, known)).max_by_key(|known| known.as_os_str().len())
        {
            Some(nearest) => self.chosen.contains(nearest),
            None => self.outside,
        }
    }

    /// Whether the file `relative`, in the history store `store` of the connector `c`, is copied.
    pub(crate) fn takes(&mut self, env: &Env, c: &Value, store: &Path, relative: &Path) -> bool {
        match self.folder(env, c, store, relative) {
            Some(folder) => self.wants(&folder),
            None => true,
        }
    }

    /// The folder the chat in `relative` was started in, as the scan tells it: by the folder of the store it is in for
    /// a tool that names those after the project, or else by the first folder the log names.
    fn folder(&mut self, env: &Env, c: &Value, store: &Path, relative: &Path) -> Option<PathBuf> {
        let link = &c["link"];
        match link["kind"].as_str() {
            Some("cwd") => agents::first_location(&store.join(relative), link["field"].as_str().unwrap_or("cwd")),
            Some("named") => {
                let mut parts = relative.components();
                let name = parts.next()?.as_os_str().to_string_lossy().into_owned();
                // A file at the top of the store is no project's.
                parts.next()?;
                if let Some(found) = self.named.get(&name) {
                    return found.clone();
                }
                let found = if link["naming"] == "sha256" {
                    self.known.iter().find(|p| agents::store_name(link, &p.to_string_lossy()) == name).cloned()
                } else {
                    agents::resolve_encoded(env, &name)
                        .or_else(|| started_in(&store.join(&name)))
                        .or_else(|| self.known.iter().find(|p| paths::enc(&p.to_string_lossy()) == name).cloned())
                };
                self.named.insert(name, found.clone());
                found
            }
            _ => None,
        }
    }
}

/// Where the chats of the Claude Code folder `dir` were started, by the first of its logs that says: the folder they
/// name is gone, so the name of the store's folder can't be told back into it.
fn started_in(dir: &Path) -> Option<PathBuf> {
    walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|ext| ext == "jsonl"))
        .take(LOGS)
        .find_map(|e| agents::first_location(e.path(), "cwd"))
}

/// The choice `raw` as Settings saves it: `null` for every chat, or the chosen folders, each a full path, as `~/…` in
/// home, sorted and each once, and whether chats outside every project are copied.
pub fn setting(env: &Env, raw: &Value) -> Result<Value> {
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let list = raw["paths"].as_array().ok_or("Choose the projects to copy")?;
    if list.len() > MOST {
        return Err(format!("Choose at most {MOST} projects to copy"));
    }
    let mut chosen = Vec::with_capacity(list.len());
    for path in list {
        let path = paths::expand(path.as_str().ok_or("Each project to copy is a folder")?.trim(), &env.home);
        if !path.is_absolute() {
            return Err("Each project to copy is a full path".into());
        }
        chosen.push(path);
    }
    if !matches!(raw.get("outside"), None | Some(Value::Bool(_))) {
        return Err("Choose whether chats outside your projects are copied".into());
    }
    Ok(saved(env, chosen, raw["outside"] == true))
}

fn saved(env: &Env, mut chosen: Vec<PathBuf>, outside: bool) -> Value {
    chosen.sort();
    chosen.dedup();
    json!({"paths":chosen.iter().map(|p| paths::tilde(p, &env.home)).collect::<Vec<_>>(),"outside":outside})
}

/// The choice in `cfg` once each folder `from` of `pairs` has moved to its `to`, so a ticked project stays ticked
/// where it went, or `None` when the choice names none of them.
pub(crate) fn moved(env: &Env, cfg: &Value, pairs: &[(PathBuf, PathBuf)]) -> Option<Value> {
    let only = cfg["backupOnly"].as_object()?;
    let mut changed = false;
    let chosen: Vec<PathBuf> = only
        .get("paths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|raw| {
            let path = paths::expand(raw, &env.home);
            match pairs.iter().find_map(|(from, to)| relocate(from, to, &path)) {
                Some(now) => {
                    changed = true;
                    now
                }
                None => path,
            }
        })
        .collect();
    changed.then(|| saved(env, chosen, only.get("outside").and_then(Value::as_bool) == Some(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes(paths: &[&str]) -> Value {
        Value::Object(paths.iter().map(|p| ((*p).to_owned(), json!({"id":p,"path":p}))).collect())
    }

    #[test]
    fn a_chat_goes_with_the_nearest_folder_that_holds_it() {
        let env = Env::for_home(PathBuf::from("/home/me"));
        let cfg = json!({"backupOnly":{"paths":["~/project/app","~/project/app/fe"],"outside":false}});
        let scanned =
            nodes(&["/home/me/project", "/home/me/project/app", "/home/me/project/app/fe", "/home/me/project/app/be"]);
        let choice = Choice::load(&env, &cfg, &scanned).unwrap();
        // The group's own chats and a ticked project's, down to its subfolders.
        assert!(choice.wants(Path::new("/home/me/project/app")));
        assert!(choice.wants(Path::new("/home/me/project/app/fe/src")));
        // A project of the group that wasn't ticked, as one that appeared after the choice.
        assert!(!choice.wants(Path::new("/home/me/project/app/be")));
        assert!(!choice.wants(Path::new("/home/me/project")));
        // Outside every scanned folder only with `outside`.
        assert!(!choice.wants(Path::new("/home/me")));
        let outside = json!({"backupOnly":{"paths":[],"outside":true}});
        assert!(Choice::load(&env, &outside, &scanned).unwrap().wants(Path::new("/home/me/notes")));
        // No choice: every chat.
        assert!(Choice::load(&env, &json!({}), &scanned).is_none());
        assert!(Choice::load(&env, &json!({"backupOnly":null}), &scanned).is_none());
    }

    #[test]
    fn a_chosen_folder_that_is_gone_or_never_scanned_still_holds_its_chats() {
        let env = Env::for_home(PathBuf::from("/home/me"));
        let cfg = json!({"backupOnly":{"paths":["~/old/site"]}});
        let choice = Choice::load(&env, &cfg, &json!({})).unwrap();
        assert!(choice.wants(Path::new("/home/me/old/site/docs")));
        assert!(!choice.wants(Path::new("/home/me/old")));
        // `/home/me/old/site-2` is another folder, not one inside it.
        assert!(!choice.wants(Path::new("/home/me/old/site-2")));
    }

    #[test]
    fn the_setting_keeps_each_folder_once_as_settings_does() {
        let env = Env::for_home(PathBuf::from("/home/me"));
        let raw = json!({"paths":["/home/me/b","~/a","/home/me/b/","/srv/work"],"outside":true});
        assert_eq!(setting(&env, &raw).unwrap(), json!({"paths":["~/a","~/b","/srv/work"],"outside":true}));
        assert_eq!(setting(&env, &json!(null)).unwrap(), Value::Null);
        assert_eq!(setting(&env, &json!({"paths":[]})).unwrap(), json!({"paths":[],"outside":false}));
        for bad in
            [json!({}), json!({"paths":["relative/dir"]}), json!({"paths":[1]}), json!({"paths":[],"outside":"yes"})]
        {
            assert!(setting(&env, &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_moved_folder_stays_ticked_where_it_went() {
        let env = Env::for_home(PathBuf::from("/home/me"));
        let cfg = json!({"backupOnly":{"paths":["~/project/app","~/project/app/fe","~/notes"],"outside":true}});
        let pairs = [(PathBuf::from("/home/me/project/app"), PathBuf::from("/home/me/archive/app"))];
        assert_eq!(
            moved(&env, &cfg, &pairs),
            Some(json!({"paths":["~/archive/app","~/archive/app/fe","~/notes"],"outside":true}))
        );
        let elsewhere = [(PathBuf::from("/home/me/project/other"), PathBuf::from("/home/me/archive/other"))];
        assert_eq!(moved(&env, &cfg, &elsewhere), None);
        assert_eq!(moved(&env, &json!({}), &pairs), None);
    }
}
