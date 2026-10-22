//! Laci's copy of AI chats: where it is, and its files, each one packed with zstd. The copy is in Laci's data folder
//! (`history`) unless the user chose another folder in Settings (`backupDir`), which may be on another drive. Laci
//! never makes a chosen folder and never removes a chat from the copy; only temporary files of a run that stopped
//! part-way, and plain files once their packed copy is checked, ever go.
use crate::{
    Result, config,
    env::Env,
    files, ops, paths,
    platform::{self, path::stays_below},
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
/// How a move to another drive names the folder it copies into, beside where the copy goes (`ops::rename_across`).
const MOVE: &str = ".laci-move-";
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

/// Where the copy is, checked: `<data dir>/history`, or the chosen folder, which must still be there as the folder
/// that was chosen, reached without a link.
pub fn dir(env: &Env) -> Result<PathBuf> {
    let cfg = config::load(env);
    match chosen(env, &cfg) {
        None => ops::data(env, "history"),
        Some(dir) => check(&dir, &cfg).map(|()| dir),
    }
}

/// [`dir`], made ready for a run: the default folder is made when it is missing (a chosen one never is), and the
/// marker is written.
pub(crate) fn ready(env: &Env) -> Result<PathBuf> {
    let dir = dir(env)?;
    if chosen(env, &config::load(env)).is_none() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    mark(&dir)?;
    Ok(dir)
}

/// Whether the chosen folder `dir` can hold the copy now, by the rules of `scan::check_root_identity`.
fn check(dir: &Path, cfg: &Value) -> Result<()> {
    let shown = dir.display();
    if !dir.is_absolute() {
        return Err(format!(
            "The folder for the copy of AI chats isn't a full path: {shown}. Choose it again in Settings."
        ));
    }
    if !fs::metadata(dir).is_ok_and(|meta| meta.is_dir()) {
        return Err(format!(
            "The folder for the copy of AI chats isn't there: {shown}. Connect its drive, or choose another folder in \
             Settings."
        ));
    }
    if sidecar::plain_path(dir).is_err() {
        return Err(format!(
            "The folder for the copy of AI chats is reached through a link: {shown}. Choose the folder itself in \
             Settings."
        ));
    }
    // An empty mount point, where the drive isn't connected, is another folder than the one chosen.
    crate::scan::check_root_identity(dir, cfg).map_err(|_| {
        format!(
            "The folder for the copy of AI chats isn't the one Laci knows: {shown}. Connect its drive, or choose the \
             folder again in Settings."
        )
    })
}

/// Whether `path` is the copy folder `root` or inside it, with no link and no `..` on the way.
pub(crate) fn inside(root: &Path, path: &Path) -> bool {
    path.is_absolute()
        && paths::within(path, root)
        && path.strip_prefix(root).is_ok_and(stays_below)
        && sidecar::plain_path(path).is_ok()
}

/// Writes the marker into `dir`, unless it is there.
pub(crate) fn mark(dir: &Path) -> Result<()> {
    let marker = dir.join(MARKER);
    if fs::symlink_metadata(&marker).is_ok() {
        return Ok(());
    }
    files::replace(&marker, MARKER_TEXT.as_bytes())
}

/// Whether `dir` holds a copy Laci made: its top has the marker.
pub fn marked(dir: &Path) -> bool {
    fs::symlink_metadata(dir.join(MARKER)).is_ok_and(|meta| meta.is_file())
}

/// Whether the copy at `dir` holds no chat: nothing but its marker and what runs that stopped part-way left.
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

/// Packs the first `len` bytes of `src`, its length when it was listed, into `target`, through a temporary file beside
/// it that takes its place once it is complete and on the disk. False when `src` holds fewer bytes by now: `target`
/// then stays as it was.
pub(crate) fn pack(src: &Path, len: u64, target: &Path) -> Result<bool> {
    let input = File::open(src).map_err(|e| e.to_string())?;
    let mut temp = temp_in(target.parent().ok_or("Missing folder")?)?;
    if !write_packed(input.take(len), len, temp.as_file_mut()).map_err(|e| e.to_string())? {
        return Ok(false);
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(target).map_err(|e| e.error.to_string())?;
    Ok(true)
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

/// Packs each plain file the copy at `root` still holds, as copies before Laci 3.1 kept them, into `<file>.zst`. The
/// packed file is checked byte for byte before the plain one goes. One that can't be packed stays as it is, and
/// laci.log says why: the run goes on.
pub(crate) fn convert(env: &Env, root: &Path) {
    let plain: Vec<PathBuf> = kept_files(root)
        .map(walkdir::DirEntry::into_path)
        .filter(|path| path.extension().is_some_and(|ext| KINDS.iter().any(|kind| ext == *kind)))
        .collect();
    for file in plain {
        if let Err(error) = convert_one(&file, &packed(&file)) {
            crate::service::debug_log(env, &format!("copy of AI chats: {} stays plain: {error}", file.display()));
        }
    }
}
fn convert_one(plain: &Path, target: &Path) -> Result<()> {
    sidecar::plain_path(plain)?;
    match fs::symlink_metadata(target) {
        // The packed file is the newer copy: it was made since, by a run that copied the chat again.
        Ok(meta) if meta.is_file() => return fs::remove_file(plain).map_err(|e| e.to_string()),
        Ok(_) => return Err(format!("{} is in the way", target.display())),
        Err(_) => {}
    }
    let meta = fs::metadata(plain).map_err(|e| e.to_string())?;
    let input = File::open(plain).map_err(|e| e.to_string())?;
    let mut temp = temp_in(target.parent().ok_or("Missing folder")?)?;
    if !write_packed(input.take(meta.len()), meta.len(), temp.as_file_mut()).map_err(|e| e.to_string())? {
        return Err("it got shorter while Laci packed it".into());
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    if !same(plain, temp.path()).map_err(|e| e.to_string())? {
        return Err("its packed copy doesn't unpack to the same bytes".into());
    }
    temp.persist_noclobber(target).map_err(|e| e.error.to_string())?;
    platform::preserve(&meta, target)?;
    fs::remove_file(plain).map_err(|e| e.to_string())
}

/// Removes, inside the copy at `root` only, what runs that stopped part-way left: Laci's own temporary files
/// (`.laci-copy-…`), those of the way it wrote before 3.1 (`.tmp` and six letters or digits), and the folders a move
/// from another drive copies into (`.laci-move-` and six letters or digits). Only a run, under the change lock,
/// writes these, so none of them is in use; the source of a move that stopped is still where it was. What a move
/// set aside under another `.laci-move-…` name is a source, and stays.
pub(crate) fn remove_leftovers(root: &Path) {
    let mut found = Vec::new();
    let mut walk = walkdir::WalkDir::new(root).follow_links(false).into_iter();
    while let Some(entry) = walk.next() {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.depth() == 0 {
            continue;
        }
        if entry.file_type().is_dir() && staged(&name) {
            walk.skip_current_dir();
            found.push(entry.into_path());
        } else if entry.file_type().is_file() && (name.starts_with(TEMP) || old_temp(&name)) {
            found.push(entry.into_path());
        }
    }
    for path in found {
        let _ = platform::remove_all(&path);
    }
}
/// Whether a name at the top of the copy is something a run that stopped part-way left, not a chat.
fn leftover(name: &str) -> bool {
    name.starts_with(TEMP) || old_temp(name) || staged(name)
}
/// `prefix` and the six letters or digits the `tempfile` crate adds to a name it makes up.
fn made_up(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix).is_some_and(|rest| rest.len() == 6 && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}
/// A temporary file of the way the copy was written before 3.1.
fn old_temp(name: &str) -> bool {
    made_up(name, ".tmp")
}
/// The folder a move from another drive copies into before the copy takes its place.
fn staged(name: &str) -> bool {
    made_up(name, MOVE)
}

/// The copy folder `dir` as a journal records it, so Undo can tell later that it is still that folder.
pub(crate) fn journal_root(dir: &Path) -> Result<Value> {
    let meta = fs::metadata(dir).map_err(|e| e.to_string())?;
    let mut root = platform::identity(dir, &meta)?.to_json();
    root["path"] = json!(dir);
    Ok(root)
}

/// `raw`, a path that a journal entry which touched the copy names, checked against the copy folders the entry
/// recorded (`journal_root`): `None` when it is in none of them, and an error when the one it is in isn't there as it
/// was, as when its drive isn't connected. Nothing is made on an empty mount point.
pub(crate) fn journal_path(raw: &str, roots: &Value) -> Result<Option<PathBuf>> {
    let path = PathBuf::from(raw);
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
        if same && inside(dir, &path) {
            return Ok(Some(path));
        }
        return Err(format!(
            "The folder of the copy of AI chats that this change touched isn't there as it was: {}. Connect its \
             drive, then try again.",
            dir.display()
        ));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_a_stopped_run_leaves_counts_as_left_over() {
        for name in [".laci-copy-a1B2c3", ".tmpYmKbQv", ".laci-move-Ab12Cd"] {
            assert!(leftover(name), "{name}");
        }
        // The marker, a chat, and what a move set aside (its source) are not.
        for name in [MARKER, ".tmpYmKbQ", ".tmpYmKbQvx", ".laci-move-1f2e-3", "session.jsonl.zst", "tmpYmKbQv"] {
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
        assert!(pack(&src, text.len() as u64, &target).unwrap());
        assert_eq!(content_size(&target), Some(text.len() as u64));
        assert!(fs::metadata(&target).unwrap().len() < text.len() as u64 / 4);
        let mut back = String::new();
        open(&target).unwrap().read_to_string(&mut back).unwrap();
        assert_eq!(back, text);
        assert!(same(&src, &target).unwrap());
        // A source that is shorter than it was listed leaves the copy as it was.
        let before = fs::read(&target).unwrap();
        assert!(!pack(&src, text.len() as u64 + 10, &target).unwrap());
        assert_eq!(fs::read(&target).unwrap(), before);
        assert_eq!(original(&target), src);
        assert!(is_log(&target) && is_log(&src) && !is_log(&temp.path().join("x.md.zst")));
    }
}
