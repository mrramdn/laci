//! Laci's copy of AI chats: where it is, and its files, each one packed with zstd. The copy is in Laci's data folder
//! (`history`) unless the user chose another folder in Settings (`backupDir`), which may be on another drive. Laci
//! never makes a chosen folder and never removes a chat from the copy; only temporary files of a run that stopped
//! part-way, and plain files once their packed copy is checked, ever go.
use crate::{
    Result, config,
    env::Env,
    files, ops, paths,
    platform::{
        self,
        path::{same_path, stays_below},
    },
    sidecar,
};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{self, BufRead, Read},
    path::{Path, PathBuf},
};

/// The file Laci writes at the top of every folder that holds its copy, so such a folder can be told from others.
pub const MARKER: &str = ".laci-copy";
const MARKER_TEXT: &str = "This folder holds Laci's copy of your AI chats. Each file is packed with zstd: put a chat \
back from Laci, or unpack it with `zstd -d`.\n";
/// How the temporary files of a copy start, so a later run can tell those that a run which stopped left behind.
const TEMP: &str = ".laci-copy-";
/// How a move to another drive names what it sets aside and the folder it copies into (`ops::rename_across`).
pub(crate) const MOVE: &str = ".laci-move-";
/// The file in Laci's data folder that names the journal of a move of the copy while it runs, so that a move or an
/// Undo of one that stopped part-way is finished before the copy is used again (`ops::settle_copy`).
const MOVING: &str = "copy-move.json";
/// zstd's level 3 makes chat logs about five times smaller, at well over 100 MB a second.
const LEVEL: i32 = 3;
/// The longest zstd frame header: what [`content_size`] reads.
const HEADER: u64 = 18;
/// The kinds of file the copy takes from an agent's history.
pub(crate) const KINDS: [&str; 3] = ["jsonl", "json", "md"];

/// The folder chosen in Settings, as saved, or `None` for the default in Laci's data folder. Not checked.
pub fn chosen(env: &Env, cfg: &Value) -> Option<PathBuf> {
    cfg["backupDir"].as_str().map(str::trim).filter(|raw| !raw.is_empty()).map(|raw| paths::expand(raw, &env.home))
}

/// The settings, which say where the copy is. Refused while config.json is there but can't be read, as when the app
/// that syncs it can't download it: the defaults would name another folder than the user's, and a backup, a move or
/// one that stopped part-way and is finished would then put the chats where the setting, once it is back, doesn't look.
pub(crate) fn settings(env: &Env) -> Result<Value> {
    if let Some(file) = config::unreadable(env) {
        return Err(format!(
            "Laci couldn't read your settings in {}, so it doesn't know where the copy of AI chats is kept and leaves \
             it as it is. Make sure the app that syncs that folder is running, or fix the file, then try again.",
            paths::tilde(&file, &env.home)
        ));
    }
    Ok(config::load(env))
}

/// Where the copy is, checked: `<data dir>/history`, or the chosen folder, which must still be there as the folder
/// that was chosen, reached without a link, and hold the marker of a copy Laci made. Refused while the settings can't
/// be read ([`settings`]).
pub fn dir(env: &Env) -> Result<PathBuf> {
    let cfg = settings(env)?;
    match chosen(env, &cfg) {
        None => ops::data(env, "history"),
        Some(dir) => check(env, &dir, &cfg).map(|()| dir),
    }
}

/// [`dir`], and while a move of the copy that stopped part-way isn't finished yet, the other folder that holds part
/// of it. Listing, putting back and deleting look in both.
pub(crate) fn dirs(env: &Env) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = dir(env).ok().into_iter().collect();
    if let Some((journal, _)) = moving(env) {
        let halves = &journal["copyMove"];
        for key in ["from", "to"] {
            let Some(half) = halves[key].as_str() else { continue };
            if out.iter().any(|dir| same_path(dir, Path::new(half))) {
                continue;
            }
            if let Ok(Some(half)) = journal_path(env, half, &halves["roots"])
                && half.is_dir()
            {
                out.push(half);
            }
        }
    }
    out
}

/// [`dir`], made ready for a run: the default folder is made when it is missing (a chosen one never is), and the
/// marker is written.
pub(crate) fn ready(env: &Env) -> Result<PathBuf> {
    let dir = dir(env)?;
    if chosen(env, &settings(env)?).is_none() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    mark(&dir)?;
    Ok(dir)
}

/// Whether the chosen folder `dir` can hold the copy now. config.json can be edited by hand, so the rules a chosen
/// folder must meet are asked first: a folder that can never hold the copy, as home, is told why, whatever is on
/// record. Then it must be the folder that was chosen, by the rules of `scan::check_root_identity` and with its
/// identity on record, and a copy Laci made, with the marker at its top.
fn check(env: &Env, dir: &Path, cfg: &Value) -> Result<()> {
    let shown = paths::tilde(dir, &env.home);
    if !dir.is_absolute() {
        return Err(format!(
            "The folder for the copy of AI chats isn't a full path: {shown}. Choose the folder for the copy again."
        ));
    }
    config::backup_dir_refusal(env, dir, cfg).map_err(|why| format!("{why} ({shown})"))?;
    if !fs::metadata(dir).is_ok_and(|meta| meta.is_dir()) {
        return Err(format!(
            "The folder for the copy of AI chats isn't there: {shown}. Connect its drive, or choose another folder \
             for the copy."
        ));
    }
    if sidecar::plain_path(dir).is_err() {
        return Err(format!(
            "The folder for the copy of AI chats is reached through a link: {shown}. Choose the folder itself for \
             the copy."
        ));
    }
    // An empty mount point, where the drive isn't connected, is another folder than the one chosen.
    let known = cfg["rootIdentities"].get(dir.to_string_lossy().as_ref()).is_some();
    if !known || crate::scan::check_root_identity(dir, cfg).is_err() {
        return Err(format!(
            "The folder for the copy of AI chats isn't the one Laci knows: {shown}. Connect its drive, or choose \
             the folder for the copy again."
        ));
    }
    if !marked(dir) {
        return Err(format!(
            "The folder for the copy of AI chats doesn't hold a copy Laci made: {shown}. Choose the folder for the \
             copy again."
        ));
    }
    Ok(())
}

/// Whether `path` is the copy folder `root` or inside it, with no link and no `..` on the way.
pub(crate) fn inside(root: &Path, path: &Path) -> bool {
    path.is_absolute()
        && paths::within(path, root)
        && path.strip_prefix(root).is_ok_and(stays_below)
        && sidecar::plain_path(path).is_ok()
}

/// Writes the marker into `dir`, unless it is there, and makes sure it is on the disk.
pub(crate) fn mark(dir: &Path) -> Result<()> {
    let marker = dir.join(MARKER);
    if fs::symlink_metadata(&marker).is_err() {
        files::replace(&marker, MARKER_TEXT.as_bytes())?;
    }
    sync_dir(dir)
}

/// Writes to the disk what the folder `dir` lists, as a rename into it or out of it, so that a power cut can't undo
/// it while what comes after it is on the disk.
pub(crate) fn sync_dir(dir: &Path) -> Result<()> {
    File::open(dir).and_then(|folder| folder.sync_all()).map_err(|e| format!("{}: {e}", dir.display()))
}

/// Whether `dir` holds a copy Laci made: its top has the marker.
pub fn marked(dir: &Path) -> bool {
    fs::symlink_metadata(dir.join(MARKER)).is_ok_and(|meta| meta.is_file())
}

/// Whether the copy at `dir` holds no chat: nothing but its marker and the temporary files of runs that stopped
/// part-way. What a move set aside or copied into (`.laci-move-…`) can be the only copy of a chat, so it counts.
pub(crate) fn empty(dir: &Path) -> bool {
    files::entries(dir).iter().all(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        name == MARKER || leftover(&name)
    })
}

/// The packed copy of the file `path`: `<path>.zst`.
pub fn packed(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".zst");
    PathBuf::from(name)
}

/// Whether the copy's file `path` is packed.
pub fn is_packed(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "zst")
}

/// The file of the agent's history that the copy's file `path` holds: `path` without `.zst`.
pub fn original(path: &Path) -> PathBuf {
    if is_packed(path) { path.with_extension("") } else { path.to_owned() }
}

/// Whether the copy's file `path` holds a chat log: `.jsonl`, packed or still plain.
pub(crate) fn is_log(path: &Path) -> bool {
    original(path).extension().is_some_and(|ext| ext == "jsonl")
}

/// How many bytes the packed file `path` holds once unpacked, as its frame header says.
pub(crate) fn content_size(path: &Path) -> Option<u64> {
    let file = platform::open_nofollow(path).ok()?;
    let mut head = Vec::new();
    file.take(HEADER).read_to_end(&mut head).ok()?;
    zstd::zstd_safe::get_frame_content_size(&head).ok().flatten()
}

/// How long the chat the copy's file `path` holds is: what its frame header records once packed, or the file's own
/// length while still plain. What the copy takes on the disk is the file's length (`storage`).
pub(crate) fn chat_size(path: &Path) -> u64 {
    let size = if is_packed(path) { content_size(path) } else { fs::metadata(path).ok().map(|meta| meta.len()) };
    size.unwrap_or(0)
}

/// The chat log the copy's file `path` holds: unpacked as it is read, or read as it is while still plain.
pub fn open(path: &Path) -> io::Result<Box<dyn Read>> {
    let file = File::open(path)?;
    Ok(if is_packed(path) { Box::new(zstd::stream::read::Decoder::new(file)?) } else { Box::new(file) })
}

fn temp_in(dir: &Path) -> Result<tempfile::NamedTempFile> {
    tempfile::Builder::new().prefix(TEMP).tempfile_in(dir).map_err(|e| e.to_string())
}

/// Writes the `len` bytes `input` gives to `out` as one zstd frame that records their number and a checksum, a bit at
/// a time. False when `input` ends sooner: what is written then is no copy.
fn write_packed(mut input: impl Read, len: u64, out: &mut File) -> io::Result<bool> {
    let mut encoder = zstd::stream::write::Encoder::new(out, LEVEL)?;
    encoder.include_checksum(true)?;
    encoder.include_contentsize(true)?;
    encoder.set_pledged_src_size(Some(len))?;
    if io::copy(&mut input, &mut encoder)? != len {
        return Ok(false);
    }
    encoder.finish()?;
    Ok(true)
}

/// Packs `src` into `target`, through a temporary file beside it that takes its place once it is complete and on the
/// disk, and gives what `src` was as it was opened. Its length is taken from the file that is read, so a file its
/// tool replaced meanwhile is packed whole, as it is now. `None` when it got shorter while it was read, or isn't a
/// file: `target` then stays as it was.
pub(crate) fn pack(src: &Path, target: &Path) -> Result<Option<fs::Metadata>> {
    let input = platform::open_nofollow(src).map_err(|e| e.to_string())?;
    let meta = input.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Ok(None);
    }
    let folder = target.parent().ok_or("Missing folder")?;
    let mut temp = temp_in(folder)?;
    if !write_packed(input.take(meta.len()), meta.len(), temp.as_file_mut()).map_err(|e| e.to_string())? {
        return Ok(None);
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(target).map_err(|e| e.error.to_string())?;
    sync_dir(folder)?;
    Ok(Some(meta))
}

/// Writes the chat log the copy's file `src` holds to `target`, which must not exist, through a temporary file
/// beside it.
pub(crate) fn unpack(src: &Path, target: &Path) -> Result<()> {
    let parent = target.parent().ok_or("Missing folder")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = temp_in(parent)?;
    let mut input = open(src).map_err(|e| e.to_string())?;
    io::copy(&mut input, temp.as_file_mut()).and_then(|_| temp.as_file().sync_all()).map_err(|e| e.to_string())?;
    temp.persist_noclobber(target).map(drop).map_err(|e| e.error.to_string())
}

/// Whether the packed file `packed` unpacks to exactly the bytes of `plain`.
fn same(plain: &Path, packed: &Path) -> io::Result<bool> {
    let mut a = io::BufReader::new(File::open(plain)?);
    let mut b = io::BufReader::new(zstd::stream::read::Decoder::new(File::open(packed)?)?);
    loop {
        let (x, y) = (a.fill_buf()?, b.fill_buf()?);
        if x.is_empty() || y.is_empty() {
            return Ok(x.is_empty() && y.is_empty());
        }
        let n = x.len().min(y.len());
        if x[..n] != y[..n] {
            return Ok(false);
        }
        a.consume(n);
        b.consume(n);
    }
}

/// The files the copy at `root` holds, without what runs that stopped part-way left and without the marker.
fn kept_files(root: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with(MOVE))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            let name = e.file_name().to_string_lossy();
            name != MARKER && !leftover(&name)
        })
}

/// What the copy at `root` holds: `(sessions, files, bytes)`. A session is a `.jsonl` log, packed or still plain.
pub(crate) fn count(root: &Path) -> (u64, u64, u64) {
    let (mut sessions, mut kept, mut total) = (0u64, 0u64, 0u64);
    for item in kept_files(root) {
        kept += 1;
        total += item.metadata().map_or(0, |m| m.len());
        sessions += u64::from(is_log(item.path()));
    }
    (sessions, kept, total)
}

/// The folders of the copy at `root` that Laci writes: one per connector it knows, `<root>/<connector id>`. Only
/// these are ever packed or tidied, never anything else in the folder.
fn connector_dirs(env: &Env, root: &Path) -> Vec<PathBuf> {
    crate::agents::known_ids(env, &config::load(env))
        .into_iter()
        .filter(|id| !id.is_empty() && !id.starts_with('.') && !id.contains(['/', '\\']))
        .map(|id| root.join(id))
        .filter(|dir| fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir()) && inside(root, dir))
        .collect()
}

/// What [`convert`] packed: how many plain files, and how many bytes they and the packed copies beside them took
/// before and take now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Packing {
    pub files: u64,
    pub before: u64,
    pub after: u64,
}

/// Packs each plain file the copy at `root` still holds, as copies before Laci 3.1 kept them, into `<file>.zst`. The
/// packed file is checked byte for byte before the plain one goes. One that can't be packed stays as it is, and
/// laci.log says why: the run goes on. Says what it packed.
pub(crate) fn convert(env: &Env, root: &Path) -> Packing {
    let plain: Vec<PathBuf> = connector_dirs(env, root)
        .iter()
        .flat_map(|dir| kept_files(dir.as_path()))
        .map(walkdir::DirEntry::into_path)
        .filter(|path| path.extension().is_some_and(|ext| KINDS.iter().any(|kind| ext == *kind)))
        .collect();
    let mut packing = Packing::default();
    for file in plain {
        match convert_one(&file, &packed(&file)) {
            Ok((before, after)) => {
                packing.files += 1;
                packing.before += before;
                packing.after += after;
            }
            Err(error) => {
                crate::service::debug_log(env, &format!("copy of AI chats: {} stays plain: {error}", file.display()));
            }
        }
    }
    packing
}
/// Packs the plain file `plain` into `target`, and says how many bytes both took before and take now.
fn convert_one(plain: &Path, target: &Path) -> Result<(u64, u64)> {
    sidecar::plain_path(plain)?;
    let meta = fs::metadata(plain).map_err(|e| e.to_string())?;
    let folder = target.parent().ok_or("Missing folder")?;
    let (replace, old) = match fs::symlink_metadata(target) {
        // A run since copied the chat again, packed: that copy is the newer one unless it records that it holds
        // less, as when a Laci before 3.1 copied a log that had grown since into the plain file.
        Ok(packed) if packed.is_file() => {
            if !content_size(target).is_some_and(|size| size < meta.len()) {
                fs::remove_file(plain).map_err(|e| e.to_string())?;
                sync_dir(folder)?;
                return Ok((meta.len() + packed.len(), packed.len()));
            }
            (true, packed.len())
        }
        Ok(_) => return Err(format!("{} is in the way", target.display())),
        Err(_) => (false, 0),
    };
    let input = File::open(plain).map_err(|e| e.to_string())?;
    let mut temp = temp_in(folder)?;
    if !write_packed(input.take(meta.len()), meta.len(), temp.as_file_mut()).map_err(|e| e.to_string())? {
        return Err("it got shorter while Laci packed it".into());
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    if !same(plain, temp.path()).map_err(|e| e.to_string())? {
        return Err("its packed copy doesn't unpack to the same bytes".into());
    }
    let after = temp.as_file().metadata().map_err(|e| e.to_string())?.len();
    if replace {
        temp.persist(target).map_err(|e| e.error.to_string())?;
    } else {
        temp.persist_noclobber(target).map_err(|e| e.error.to_string())?;
    }
    platform::preserve(&meta, target)?;
    // The packed file is on the disk before the plain one goes.
    sync_dir(folder)?;
    fs::remove_file(plain).map_err(|e| e.to_string())?;
    sync_dir(folder)?;
    Ok((meta.len() + old, after))
}

/// Removes, inside the copy's connector folders at `root` only, the temporary files of runs that stopped part-way:
/// Laci's own (`.laci-copy-…`) and those of the way it wrote before 3.1 (`.tmp` and six letters or digits). Only a
/// run, under the change lock, writes these, so none of them is in use. Folders a move set aside or copied into
/// (`.laci-move-…`) stay: one can hold the only copy of a chat, and finishing that move puts it right.
pub(crate) fn remove_leftovers(env: &Env, root: &Path) {
    let mut found = Vec::new();
    for dir in connector_dirs(env, root) {
        let mut walk = walkdir::WalkDir::new(&dir).follow_links(false).into_iter();
        while let Some(entry) = walk.next() {
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.depth() > 0 && entry.file_type().is_dir() && name.starts_with(MOVE) {
                walk.skip_current_dir();
            } else if entry.file_type().is_file() && leftover(&name) {
                found.push(entry.into_path());
            }
        }
    }
    for path in found {
        let _ = fs::remove_file(&path);
    }
}
/// Whether a file's name is that of a temporary file a run that stopped part-way left, not a chat.
fn leftover(name: &str) -> bool {
    name.starts_with(TEMP) || old_temp(name)
}
/// A temporary file of the way the copy was written before 3.1: `.tmp` and the six letters or digits the `tempfile`
/// crate adds.
fn old_temp(name: &str) -> bool {
    name.strip_prefix(".tmp").is_some_and(|rest| rest.len() == 6 && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// The copy folder `dir` as a journal records it, so Undo can tell later that it is still that folder.
pub(crate) fn journal_root(dir: &Path) -> Result<Value> {
    let meta = fs::metadata(dir).map_err(|e| e.to_string())?;
    let mut root = platform::identity(dir, &meta)?.to_json();
    root["path"] = json!(dir);
    Ok(root)
}

/// `raw`, a path that a journal entry which moved something of the copy names, checked against the copy folders the
/// entry recorded (`journal_root`): `None` when it is in none of them, and an error when the one it is in isn't there
/// as it was, as when its drive isn't connected. Nothing is made on an empty mount point. Only a folder that is a copy
/// counts, `<data dir>/history` or one with the marker, so an entry edited by hand can't name any other folder.
pub(crate) fn journal_path(env: &Env, raw: &str, roots: &Value) -> Result<Option<PathBuf>> {
    let path = PathBuf::from(raw);
    let default = env.data_dir.join("history");
    for root in roots.as_array().into_iter().flatten() {
        let Some(dir) = root["path"].as_str().map(Path::new) else { continue };
        if !dir.is_absolute() || !paths::within(&path, dir) {
            continue;
        }
        let same = fs::metadata(dir)
            .ok()
            .filter(fs::Metadata::is_dir)
            .and_then(|meta| platform::identity(dir, &meta).ok())
            .is_some_and(|id| id.matches(root));
        if !same {
            return Err(format!(
                "The folder of the copy of AI chats that this change touched isn't there as it was: {}. Connect its \
                 drive, then try again.",
                dir.display()
            ));
        }
        if !(same_path(dir, &default) || marked(dir)) {
            return Err(format!("{} isn't a folder of the copy of AI chats", dir.display()));
        }
        if inside(dir, &path) {
            return Ok(Some(path));
        }
        return Err(format!("{} isn't inside the copy of AI chats", path.display()));
    }
    Ok(None)
}

/// The move of the copy that runs, or stopped part-way, and whether it is the Undo of one: its journal, as the file
/// [`MOVING`] names it.
pub(crate) fn moving(env: &Env) -> Option<(Value, bool)> {
    let record: Value = serde_json::from_str(&files::text(&ops::data(env, MOVING).ok()?)?).ok()?;
    let id = record["journal"].as_str().filter(|id| ops::valid_id(id))?;
    let journal = ops::read_journal(&ops::data(env, "journal").ok()?.join(format!("{id}.json"))).ok()?;
    Some((journal, record["undo"] == true))
}
/// Notes that the move of the copy in the journal `id`, or with `undo` its Undo, starts, on the disk before anything
/// moves.
pub(crate) fn begin_moving(env: &Env, id: &str, undo: bool) -> Result<()> {
    let file = ops::data(env, MOVING)?;
    files::replace(&file, json!({"journal":id,"undo":undo}).to_string().as_bytes())?;
    sync_dir(file.parent().ok_or("Missing folder")?)
}
/// Notes that no move of the copy runs any more.
pub(crate) fn end_moving(env: &Env) -> Result<()> {
    let file = ops::data(env, MOVING)?;
    match fs::remove_file(&file) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_a_stopped_run_leaves_counts_as_left_over() {
        for name in [".laci-copy-a1B2c3", ".tmpYmKbQv"] {
            assert!(leftover(name), "{name}");
        }
        // The marker, a chat, and what a move set aside or copied into, which can be the only copy, are not.
        for name in [MARKER, ".tmpYmKbQ", ".tmpYmKbQvx", ".laci-move-1f2e-3", ".laci-move-Ab12Cd", "session.jsonl.zst"]
        {
            assert!(!leftover(name), "{name}");
        }
    }

    #[test]
    fn a_packed_log_records_its_length_and_unpacks_to_the_same_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("session.jsonl");
        let text = "{\"type\":\"user\"}\n".repeat(5000);
        fs::write(&src, &text).unwrap();
        let target = packed(&src);
        assert_eq!(pack(&src, &target).unwrap().map(|meta| meta.len()), Some(text.len() as u64));
        assert_eq!(content_size(&target), Some(text.len() as u64));
        assert!(fs::metadata(&target).unwrap().len() < text.len() as u64 / 4);
        let mut back = String::new();
        open(&target).unwrap().read_to_string(&mut back).unwrap();
        assert_eq!(back, text);
        assert!(same(&src, &target).unwrap());
        // What a tool put in the log's place since it was listed is packed whole, as it is now.
        let longer = format!("{text}{{\"type\":\"assistant\"}}\n");
        let replacement = temp.path().join("replacement");
        fs::write(&replacement, &longer).unwrap();
        fs::rename(&replacement, &src).unwrap();
        assert_eq!(pack(&src, &target).unwrap().map(|meta| meta.len()), Some(longer.len() as u64));
        assert_eq!(content_size(&target), Some(longer.len() as u64));
        // A file that gets shorter while it is read leaves the copy as it was.
        let before = fs::read(&target).unwrap();
        let mut input = std::io::Cursor::new(b"short".to_vec());
        let mut out = tempfile::tempfile().unwrap();
        assert!(!write_packed(&mut input, 10, &mut out).unwrap());
        assert_eq!(fs::read(&target).unwrap(), before);
        assert_eq!(original(&target), src);
        assert!(is_log(&target) && is_log(&src) && !is_log(&temp.path().join("x.md.zst")));
    }
}
