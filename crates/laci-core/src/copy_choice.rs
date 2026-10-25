//! Which chats the copy of AI chats takes. Unless projects were chosen for it in Settings (`backupOnly`), it takes
//! every chat. With a choice, a chat is copied when the nearest scanned folder holding the folder it was started in,
//! a project or a group, is one that was ticked, and a chat in none of them when `outside` was ticked. A project that
//! appears later is its own folder, not ticked, so it is copied only once it is ticked. A file whose folder Laci can't
//! tell, as an index a tool keeps for all its chats, is copied, and so is a setting Laci can't read: the choice errs on
//! keeping. A chat that moved to another folder as it went on is copied when either folder is chosen: the one it was
//! started in, or the one the scan files it under, its last. Unticking a project only stops new copies; nothing is
//! removed from the copy.
use crate::{Result, agents, env::Env, paths, platform::path::relocate};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

/// The most folders a choice may name, so a hand-edited setting can't make every run slow.
const MOST: usize = 10_000;
/// The most logs of a Claude Code folder read to find where its chats were started, when the folder is gone.
const LOGS: usize = 50;

/// A choice as config.json keeps it, read: the chosen folders as full paths, and whether chats outside every project
/// are copied.
struct Only {
    chosen: Vec<PathBuf>,
    outside: bool,
}

/// The choice `raw` (`backupOnly`), or `None` when it is `null`, missing, or not one Settings could have saved: a list
/// of full paths, at most [`MOST`], and `outside` true, false or left out. A choice that can't be read takes every
/// chat, as no choice does.
fn read(env: &Env, raw: &Value) -> Option<Only> {
    let only = raw.as_object()?;
    let list = only.get("paths")?.as_array()?;
    if list.len() > MOST {
        return None;
    }
    let chosen = list
        .iter()
        .map(|raw| Some(paths::expand(raw.as_str()?.trim(), &env.home)).filter(|path| path.is_absolute()))
        .collect::<Option<Vec<_>>>()?;
    let outside = match only.get("outside") {
        None => false,
        Some(Value::Bool(outside)) => *outside,
        Some(_) => return None,
    };
    Some(Only { chosen, outside })
}

/// The projects and groups chosen for the copy of AI chats, and the folders the last scan found, which tell the chats
/// of a project that wasn't ticked from those of the group around it.
pub struct Choice {
    chosen: Vec<PathBuf>,
    outside: bool,
    /// The scanned folders and the chosen ones: a chosen folder that is gone still holds its chats.
    known: Vec<PathBuf>,
    /// [`Choice::known`] and [`Choice::chosen`] to look up, so telling a chat's folder costs its depth, not the scan.
    known_set: HashSet<PathBuf>,
    chosen_set: HashSet<PathBuf>,
    /// Where the chats in each folder of a store that names its folders after a project were started.
    named: HashMap<String, Option<PathBuf>>,
    /// The folder the scan files each session log under ([`Choice::filed`]): the last one it ran in.
    filed: HashMap<PathBuf, PathBuf>,
}

impl Choice {
    /// The choice saved in `cfg`, told against the scanned folders `nodes` (the scan's `nodes`, by id), or `None` when
    /// every chat is copied.
    pub fn load(env: &Env, cfg: &Value, nodes: &Value) -> Option<Self> {
        Self::of(env, &cfg["backupOnly"], nodes)
    }

    /// The choice `only`, as `backupOnly` keeps it, told against `nodes`.
    pub fn of(env: &Env, only: &Value, nodes: &Value) -> Option<Self> {
        let folders =
            nodes.as_object().into_iter().flatten().filter_map(|(_, n)| n["path"].as_str()).map(PathBuf::from);
        Self::with(read(env, only)?, folders)
    }

    /// The choice a run copied by, as [`Choice::state`] recorded it, told against the folders that run knew: a folder
    /// scanned then but renamed or gone since still kept its chats out. A record without them, from before, is told
    /// against `nodes`.
    pub fn taken(env: &Env, state: &Value, nodes: &Value) -> Option<Self> {
        match state["known"].as_array() {
            Some(known) => {
                let folders = known.iter().filter_map(Value::as_str).map(PathBuf::from);
                Self::with(read(env, state)?, folders)
            }
            None => Self::of(env, state, nodes),
        }
    }

    fn with(Only { chosen, outside }: Only, folders: impl Iterator<Item = PathBuf>) -> Option<Self> {
        let mut known: Vec<PathBuf> = folders.chain(chosen.iter().cloned()).collect();
        known.sort();
        known.dedup();
        let (known_set, chosen_set) = (known.iter().cloned().collect(), chosen.iter().cloned().collect());
        Some(Self { chosen, outside, known, known_set, chosen_set, named: HashMap::new(), filed: HashMap::new() })
    }

    /// The choice, with the folder the scan `sessions` (the scan's, each with its `file` and `cwd`) files each log
    /// under, so a chat Laci shows in a chosen project is copied though it was started elsewhere.
    pub fn filed(mut self, sessions: &Value) -> Self {
        self.filed = sessions
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| {
                let (file, cwd) = (s["file"].as_str()?, s["cwd"].as_str()?);
                Some((paths::normalize(Path::new(file)), paths::normalize(Path::new(cwd))))
            })
            .collect();
        self
    }

    /// The chosen folders, as full paths.
    pub fn chosen(&self) -> &[PathBuf] {
        &self.chosen
    }

    /// Whether chats outside every scanned and chosen folder are copied.
    pub fn outside(&self) -> bool {
        self.outside
    }

    /// The choice as a run of the copy records it, with full paths and the folders it told chats apart by, so a later
    /// scan knows which chats it took ([`Choice::taken`]).
    pub fn state(&self) -> Value {
        // The chosen folders are in `paths` already.
        let known: Vec<&PathBuf> = self.known.iter().filter(|path| !self.chosen_set.contains(*path)).collect();
        json!({"paths":self.chosen,"outside":self.outside,"known":known})
    }

    /// Whether a chat started in `folder` is copied: by the nearest scanned or chosen folder that is it or holds it.
    pub fn wants(&self, folder: &Path) -> bool {
        match folder.ancestors().find(|ancestor| self.known_set.contains(*ancestor)) {
            Some(nearest) => self.chosen_set.contains(nearest),
            None => self.outside,
        }
    }

    /// Whether the file `relative`, in the history store `store` of the connector `c`, is copied: when the scan files
    /// its chat under a chosen folder, or when the folder it was started in is chosen.
    pub(crate) fn takes(&mut self, env: &Env, c: &Value, store: &Path, relative: &Path) -> bool {
        let file = paths::normalize(&store.join(relative));
        if self.filed.get(&file).is_some_and(|folder| self.wants(folder)) {
            return true;
        }
        let link = &c["link"];
        // A Claude Code session's subagent logs (`<folder>/<id>/…`) go with the session they belong to.
        let mut parts = relative.components();
        if link["kind"] == "named"
            && let (Some(folder), Some(id), Some(_)) = (parts.next(), parts.next(), parts.next())
        {
            let session = store.join(folder).join(format!("{}.jsonl", id.as_os_str().to_string_lossy()));
            if self.filed.get(&paths::normalize(&session)).is_some_and(|folder| self.wants(folder)) {
                return true;
            }
        }
        match link["kind"].as_str() {
            Some("cwd") => {
                let field = link["field"].as_str().unwrap_or("cwd");
                // A Codex session names the folder it was started in first; tool calls naming others don't count.
                if c["provider"] == "codex" {
                    return agents::first_location(&file, field).is_none_or(|folder| self.wants(&folder));
                }
                // Another tool's log can hold the chats of several folders, as Antigravity's one history does: it is
                // copied when one of them is chosen, and when it is longer than what is read of it.
                let (folders, whole) = agents::locations(&file, field);
                folders.is_empty() || !whole || folders.iter().any(|folder| self.wants(folder))
            }
            Some("named") => self.named_folder(env, link, store, relative).is_none_or(|folder| self.wants(&folder)),
            _ => true,
        }
    }

    /// Where the chats in `relative` were started, for a store that names its folders after the project: by the name
    /// of the store's folder it is in, as the scan tells it. A file at the top of the store is no project's.
    fn named_folder(&mut self, env: &Env, link: &Value, store: &Path, relative: &Path) -> Option<PathBuf> {
        let mut parts = relative.components();
        let name = parts.next()?.as_os_str().to_string_lossy().into_owned();
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

/// How many of the folders `only` chooses are projects among the scanned `nodes`, not groups: what the Log tells.
pub fn projects(env: &Env, only: &Value, nodes: &Value) -> usize {
    let Some(Only { chosen, .. }) = read(env, only) else { return 0 };
    nodes
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, n)| {
            n["kind"] == "project" && n["path"].as_str().is_some_and(|p| chosen.contains(&PathBuf::from(p)))
        })
        .count()
}

/// What a move did to the choice: the choice now, each chosen folder it moved from where to where, and the folders it
/// moved to that were chosen already, which Undo leaves chosen.
pub(crate) struct Moved {
    pub only: Value,
    pub relocated: Vec<(PathBuf, PathBuf)>,
    pub kept: Vec<PathBuf>,
}

/// The choice in `cfg` once each folder `from` of `pairs` has moved to its `to`, so a ticked project stays ticked
/// where it went, or `None` when the choice names none of them.
pub(crate) fn moved(env: &Env, cfg: &Value, pairs: &[(PathBuf, PathBuf)]) -> Option<Moved> {
    let Only { chosen, outside } = read(env, &cfg["backupOnly"])?;
    let relocated: Vec<(PathBuf, PathBuf)> = chosen
        .iter()
        .filter_map(|path| Some((path.clone(), pairs.iter().find_map(|(from, to)| relocate(from, to, path))?)))
        .collect();
    if relocated.is_empty() {
        return None;
    }
    let mut kept: Vec<PathBuf> =
        relocated.iter().filter(|(_, to)| chosen.contains(to)).map(|(_, to)| to.clone()).collect();
    kept.dedup();
    let now = chosen
        .iter()
        .map(|path| relocated.iter().find(|(from, _)| from == path).map_or_else(|| path.clone(), |(_, to)| to.clone()))
        .collect();
    Some(Moved { only: saved(env, now, outside), relocated, kept })
}

/// The choice in `cfg` once a move that [`moved`] the chosen folders `relocated` is undone: each goes back where it
/// was, unless it was unticked since, and a folder it moved to that was chosen already stays chosen. `None` when
/// nothing changes.
pub(crate) fn moved_back(env: &Env, cfg: &Value, relocated: &[(PathBuf, PathBuf)], kept: &[PathBuf]) -> Option<Value> {
    let Only { mut chosen, outside } = read(env, &cfg["backupOnly"])?;
    // Whether a folder it moved to is still chosen is asked of the choice as it is, before any goes back: two that
    // were joined in one come back both.
    let still = chosen.clone();
    let mut changed = false;
    for (from, to) in relocated.iter().filter(|(_, to)| still.contains(to)) {
        if !kept.contains(to) {
            chosen.retain(|path| path != to);
        }
        chosen.push(from.clone());
        changed = true;
    }
    changed.then(|| saved(env, chosen, outside))
}

/// The choice `only` with each folder it names carried through `moves` (from where to where, in order), as Laci moved
/// them since it was made; `null` stays `null`, and one that can't be read stays as it is.
pub(crate) fn followed(env: &Env, only: &Value, moves: &[(PathBuf, PathBuf)]) -> Value {
    let Some(Only { chosen, outside }) = read(env, only) else { return only.clone() };
    let chosen = chosen
        .into_iter()
        .map(|path| moves.iter().fold(path, |path, (from, to)| relocate(from, to, &path).unwrap_or(path)))
        .collect();
    saved(env, chosen, outside)
}

/// The choice once the change from `before` to `after` is undone, with `now` the choice as it is: what the change
/// ticked is unticked and what it unticked is ticked again, so what changed since, as a project Laci moved, stays as
/// it is. A change from every project goes back to every project, and one to every project to the choice before.
pub(crate) fn undone(env: &Env, before: &Value, after: &Value, now: &Value) -> Value {
    let Some(before) = read(env, before) else { return Value::Null };
    let (Some(after), Some(now)) = (read(env, after), read(env, now)) else {
        return saved(env, before.chosen, before.outside);
    };
    let ticked: Vec<&PathBuf> = after.chosen.iter().filter(|p| !before.chosen.contains(p)).collect();
    let mut chosen: Vec<PathBuf> = now.chosen.into_iter().filter(|p| !ticked.contains(&p)).collect();
    chosen.extend(before.chosen.iter().filter(|p| !after.chosen.contains(p)).cloned());
    let outside = if now.outside == after.outside { before.outside } else { now.outside };
    saved(env, chosen, outside)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes(paths: &[&str]) -> Value {
        Value::Object(paths.iter().map(|p| ((*p).to_owned(), json!({"id":p,"path":p}))).collect())
    }
    fn home() -> Env {
        Env::for_home(PathBuf::from("/home/me"))
    }

    #[test]
    fn a_chat_goes_with_the_nearest_folder_that_holds_it() {
        let env = home();
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
        // What a run records reads back as the same choice.
        let state = choice.state();
        assert_eq!(state["paths"], json!(["/home/me/project/app", "/home/me/project/app/fe"]));
        // The scanned folders it told chats apart by, past the chosen ones `paths` names.
        assert_eq!(state["known"], json!(["/home/me/project", "/home/me/project/app/be"]));
        assert!(!Choice::taken(&env, &state, &json!({})).unwrap().wants(Path::new("/home/me/project/app/be")));
    }

    #[test]
    fn a_chat_is_copied_when_the_scan_files_it_under_a_chosen_folder() {
        let env = home();
        let temp = tempfile::tempdir().unwrap();
        let store = temp.path().join("sessions");
        let file = store.join("2026/10/s.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // Started in be, which isn't ticked, and resumed in fe, which is: the scan shows it in fe.
        let lines = [
            json!({"type":"session_meta","payload":{"id":"s","cwd":"/home/me/project/app/be"}}),
            json!({"type":"turn_context","payload":{"cwd":"/home/me/project/app/fe"}}),
        ];
        std::fs::write(&file, format!("{}\n{}\n", lines[0], lines[1])).unwrap();
        let cfg = json!({"backupOnly":{"paths":["~/project/app/fe"]}});
        let scanned = nodes(&["/home/me/project/app", "/home/me/project/app/fe", "/home/me/project/app/be"]);
        let codex = json!({"id":"codex","provider":"codex","link":{"kind":"cwd","dir":store,"field":"cwd"}});
        let relative = Path::new("2026/10/s.jsonl");
        assert!(!Choice::load(&env, &cfg, &scanned).unwrap().takes(&env, &codex, &store, relative));
        let sessions = json!([{"file":file,"cwd":"/home/me/project/app/fe"}]);
        assert!(Choice::load(&env, &cfg, &scanned).unwrap().filed(&sessions).takes(&env, &codex, &store, relative));
    }

    #[test]
    fn a_choice_settings_could_not_have_saved_takes_every_chat() {
        let env = home();
        for bad in [
            json!({}),
            json!({"paths":"~/project/app"}),
            json!({"paths":["project/app"]}),
            json!({"paths":["~/project/app", 1]}),
            json!({"paths":[],"outside":"yes"}),
            json!(["~/project/app"]),
        ] {
            assert!(Choice::load(&env, &json!({"backupOnly":bad}), &json!({})).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_chosen_folder_that_is_gone_or_never_scanned_still_holds_its_chats() {
        let env = home();
        let cfg = json!({"backupOnly":{"paths":["~/old/site"]}});
        let choice = Choice::load(&env, &cfg, &json!({})).unwrap();
        assert!(choice.wants(Path::new("/home/me/old/site/docs")));
        assert!(!choice.wants(Path::new("/home/me/old")));
        // `/home/me/old/site-2` is another folder, not one inside it.
        assert!(!choice.wants(Path::new("/home/me/old/site-2")));
    }

    #[test]
    fn the_setting_keeps_each_folder_once_as_settings_does() {
        let env = home();
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
    fn the_log_counts_the_projects_chosen_not_the_groups() {
        let env = home();
        let scanned = json!({
            "/home/me/project/app":{"path":"/home/me/project/app","kind":"folder"},
            "/home/me/project/app/fe":{"path":"/home/me/project/app/fe","kind":"project"},
            "/home/me/project/app/be":{"path":"/home/me/project/app/be","kind":"project"},
        });
        let only = json!({"paths":["~/project/app","~/project/app/fe","~/old/site"]});
        assert_eq!(projects(&env, &only, &scanned), 1);
        assert_eq!(projects(&env, &Value::Null, &scanned), 0);
    }

    #[test]
    fn a_moved_folder_stays_ticked_where_it_went_and_comes_back_on_undo() {
        let env = home();
        let cfg = json!({"backupOnly":{"paths":["~/project/app","~/project/app/fe","~/notes"],"outside":true}});
        let pairs = [(PathBuf::from("/home/me/project/app"), PathBuf::from("/home/me/archive/app"))];
        let done = moved(&env, &cfg, &pairs).unwrap();
        assert_eq!(done.only, json!({"paths":["~/archive/app","~/archive/app/fe","~/notes"],"outside":true}));
        assert_eq!(done.relocated.len(), 2);
        assert!(done.kept.is_empty());
        let after = json!({"backupOnly":done.only});
        assert_eq!(
            moved_back(&env, &after, &done.relocated, &done.kept),
            Some(json!({"paths":["~/notes","~/project/app","~/project/app/fe"],"outside":true}))
        );
        let elsewhere = [(PathBuf::from("/home/me/project/other"), PathBuf::from("/home/me/archive/other"))];
        assert!(moved(&env, &cfg, &elsewhere).is_none());
        assert!(moved(&env, &json!({}), &pairs).is_none());
    }

    #[test]
    fn undoing_a_move_onto_a_folder_that_was_ticked_already_keeps_that_tick() {
        let env = home();
        // The folder was moved by hand: its old place is still ticked, and its new place was ticked as well.
        let cfg = json!({"backupOnly":{"paths":["~/old/site","~/project/site"]}});
        let pairs = [(PathBuf::from("/home/me/old/site"), PathBuf::from("/home/me/project/site"))];
        let done = moved(&env, &cfg, &pairs).unwrap();
        assert_eq!(done.only, json!({"paths":["~/project/site"],"outside":false}));
        assert_eq!(done.kept, vec![PathBuf::from("/home/me/project/site")]);
        let back = moved_back(&env, &json!({"backupOnly":done.only}), &done.relocated, &done.kept);
        assert_eq!(back, Some(json!({"paths":["~/old/site","~/project/site"],"outside":false})));
        // Unticked since the move: Undo leaves it unticked.
        let unticked = json!({"backupOnly":{"paths":[],"outside":false}});
        assert_eq!(moved_back(&env, &unticked, &done.relocated, &done.kept), None);
    }

    #[test]
    fn undoing_a_move_that_joined_two_ticked_folders_in_one_ticks_both_again() {
        let env = home();
        // A reconnect of chats started in two folders that are gone, both ticked, to the project they are now in.
        let cfg = json!({"backupOnly":{"paths":["~/mid/app","~/old/app"]}});
        let pairs = [
            (PathBuf::from("/home/me/old/app"), PathBuf::from("/home/me/project/app")),
            (PathBuf::from("/home/me/mid/app"), PathBuf::from("/home/me/project/app")),
        ];
        let done = moved(&env, &cfg, &pairs).unwrap();
        assert_eq!(done.only, json!({"paths":["~/project/app"],"outside":false}));
        let back = moved_back(&env, &json!({"backupOnly":done.only}), &done.relocated, &done.kept);
        assert_eq!(back, Some(json!({"paths":["~/mid/app","~/old/app"],"outside":false})));
    }

    #[test]
    fn a_choice_follows_the_folders_laci_moved_since() {
        let env = home();
        let moves = [
            (PathBuf::from("/home/me/project/x"), PathBuf::from("/home/me/archive/x")),
            (PathBuf::from("/home/me/archive/x"), PathBuf::from("/home/me/archive/x-2026")),
        ];
        let only = json!({"paths":["~/a","~/project/x/docs"],"outside":true});
        assert_eq!(followed(&env, &only, &moves), json!({"paths":["~/a","~/archive/x-2026/docs"],"outside":true}));
        assert_eq!(followed(&env, &Value::Null, &moves), Value::Null);
    }

    #[test]
    fn a_run_s_choice_is_told_against_the_folders_it_knew() {
        let env = home();
        let cfg = json!({"backupOnly":{"paths":["~/project/app"]}});
        let then = nodes(&["/home/me/project/app", "/home/me/project/app/fe"]);
        let state = Choice::load(&env, &cfg, &then).unwrap().state();
        // fe was renamed by hand since: today's scan doesn't have it, but the run kept fe's chats out.
        let now = nodes(&["/home/me/project/app", "/home/me/project/app/fe2"]);
        assert!(!Choice::taken(&env, &state, &now).unwrap().wants(Path::new("/home/me/project/app/fe")));
        assert!(Choice::load(&env, &cfg, &now).unwrap().wants(Path::new("/home/me/project/app/fe")));
        // A record from before the folders were kept goes by today's.
        let old = json!({"paths":["/home/me/project/app"],"outside":false});
        assert!(Choice::taken(&env, &old, &now).unwrap().wants(Path::new("/home/me/project/app/fe")));
    }

    #[test]
    fn undoing_a_choice_takes_back_only_what_it_changed() {
        let env = home();
        let before = json!({"paths":["~/project/fe"],"outside":false});
        let after = json!({"paths":["~/project/demo","~/project/fe"],"outside":true});
        // Nothing changed since: the choice before.
        assert_eq!(undone(&env, &before, &after, &after), json!({"paths":["~/project/fe"],"outside":false}));
        // fe was moved by Laci since, and stays ticked where it went; demo, which the change ticked, goes.
        let now = json!({"paths":["~/project/demo","~/web/fe"],"outside":true});
        assert_eq!(undone(&env, &before, &after, &now), json!({"paths":["~/web/fe"],"outside":false}));
        // What the change unticked comes back.
        assert_eq!(
            undone(&env, &after, &before, &json!({"paths":["~/project/fe","~/web/x"],"outside":false})),
            json!({"paths":["~/project/demo","~/project/fe","~/web/x"],"outside":true})
        );
        // From every project and back to it.
        assert_eq!(undone(&env, &Value::Null, &after, &now), Value::Null);
        assert_eq!(
            undone(&env, &before, &Value::Null, &Value::Null),
            json!({"paths":["~/project/fe"],"outside":false})
        );
    }
}
