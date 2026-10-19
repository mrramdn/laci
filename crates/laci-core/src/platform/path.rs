//! Rules for paths. Linux compares them byte by byte, as Laci always has. On macOS and Windows one place can be
//! spelled more than one way: in another case, with `\\?\` or an 8.3 short name on Windows, and through macOS's own
//! links `/var`, `/tmp` and `/etc`. Another spelling counts as the same place only once the file system confirms that
//! both lead to the same file, since a folder or a whole volume can be case-sensitive there too.
use crate::Result;
use std::{
    ffi::OsStr,
    fs, io,
    path::{Component, Path, PathBuf, Prefix, PrefixComponent},
};

/// How an OS spells and compares paths.
#[derive(Clone, Copy, Debug)]
struct Rules {
    /// Names that differ only in case can name one file, as on macOS and Windows.
    fold: bool,
    /// `\` separates names as well as `/`, and a name with `~` in it can be the 8.3 short name of another.
    windows: bool,
}

const RULES: Rules = Rules { fold: cfg!(any(target_os = "macos", windows)), windows: cfg!(windows) };

/// Whether names that differ only in case can name the same file, as on macOS and Windows.
pub const FOLDS_CASE: bool = RULES.fold;

/// `path` with every link and every `.` or `..` resolved. On Windows without the `\\?\` std puts in front, where the
/// path means the same without it, so it compares with paths typed or picked by the user.
#[cfg(windows)]
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}
/// `path` with every link and every `.` or `..` resolved.
#[cfg(not(windows))]
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    path.canonicalize()
}

/// Where `path` is, or would be once made: its deepest existing ancestor made [`canonical`], then the rest as spelled.
pub fn resolve_existing(path: &Path) -> io::Result<PathBuf> {
    let mut ancestor = path;
    while fs::symlink_metadata(ancestor).is_err() {
        ancestor =
            ancestor.parent().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "No part of the path exists"))?;
    }
    let actual = canonical(ancestor)?;
    Ok(match path.strip_prefix(ancestor) {
        Ok(rest) if !rest.as_os_str().is_empty() => actual.join(rest),
        _ => actual,
    })
}

/// Whether `path` is `root` or inside it. On macOS and Windows another spelling of `root` counts only once the file
/// system confirms `path` passes through `root` itself: what can't be confirmed is outside.
pub fn contains(root: &Path, path: &Path) -> bool {
    path.starts_with(root) || (RULES.fold && folded(RULES, &parts(root), &parts(path), false))
}

/// Whether `a` and `b` are the same path, by the rules of [`contains`].
pub fn same_path(a: &Path, b: &Path) -> bool {
    a == b || (RULES.fold && same_parts(RULES, &parts(a), &parts(b)))
}

/// Whether `path` could be `root` or inside it, for the checks that refuse: there a doubt counts as inside. On macOS
/// and Windows a name that differs only in case counts as the same, both paths count also with their links resolved,
/// and a path that can't be resolved counts as inside.
pub fn may_contain(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
        || (RULES.fold
            && (folded(RULES, &parts(root), &parts(path), true)
                || match (resolve_existing(root), resolve_existing(path)) {
                    (Ok(root), Ok(path)) => folded(RULES, &parts(&root), &parts(&path), true),
                    _ => true,
                }))
}

/// What `path` holds below `root`: nothing for `root` itself, and `None` when `path` isn't [inside](contains) `root`.
pub fn below(root: &Path, path: &Path) -> Option<PathBuf> {
    if let Ok(rest) = path.strip_prefix(root) {
        return Some(rest.to_owned());
    }
    if !RULES.fold {
        return None;
    }
    let (root, path) = (parts(root), parts(path));
    folded(RULES, &root, &path, false).then(|| joined(&path[root.len()..]))
}

/// Where `path` is once `from`, the folder it is in, has moved to `to`. The part below `from` keeps its spelling.
pub fn relocate(from: &Path, to: &Path, path: &Path) -> Option<PathBuf> {
    below(from, path).map(|rest| if rest.as_os_str().is_empty() { to.to_owned() } else { to.join(rest) })
}

/// The text a tool would record for `recorded`, a path it recorded inside `from`, once `from` has moved to `to`, or
/// `None` when `recorded` isn't inside `from`. On Windows the part below `from` keeps the tool's own spelling, as some
/// tools name a folder after a hash of that text; elsewhere it is [`relocate`]d.
pub fn moved_text(from: &Path, to: &Path, recorded: &str) -> Option<String> {
    let moved = relocate(from, to, Path::new(recorded))?.to_string_lossy().into_owned();
    if !RULES.windows {
        return Some(moved);
    }
    Some(rewrite_prefix(recorded, &from.to_string_lossy(), &to.to_string_lossy()).unwrap_or(moved))
}

/// `text`, a path as a log recorded it, with `from` at its start replaced by `to`, when it is `from` or a path inside
/// it. A log on macOS or Windows can spell a path in another case, and on Windows with either separator; it names a
/// folder that has moved away, so nothing is left to ask the file system about.
pub fn rewrite_prefix(text: &str, from: &str, to: &str) -> Option<String> {
    rewrite_with(RULES, text, from, to)
}

/// Whether `relative`, joined to a folder, stays below it: no `..`, and no root or, on Windows, drive, from which the
/// join would start over somewhere else.
pub fn stays_below(relative: &Path) -> bool {
    !relative.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
}

/// Whether renaming `src` to `dest` only changes the case of its name: both spell the same entry, in the same folder.
/// Linux never has such a rename, since there `Foo` and `foo` are two names.
pub fn renames_case(src: &Path, dest: &Path) -> bool {
    RULES.fold && renamed_case(RULES, src, dest)
}

fn renamed_case(rules: Rules, src: &Path, dest: &Path) -> bool {
    src.file_name().zip(dest.file_name()).is_some_and(|(a, b)| a != b && fold_eq(a, b))
        && same_parts(rules, &parts(src), &parts(dest))
        // A case-sensitive folder can hold a second hard link to the file under the new name: that is another entry.
        && dest.parent().zip(dest.file_name()).is_some_and(|(dir, name)| {
            fs::read_dir(dir).is_ok_and(|mut entries| entries.all(|e| e.is_ok_and(|e| e.file_name().as_os_str() != name)))
        })
}

/// Reject linked files and linked ancestor directories before writing notes or task files. On macOS every path below
/// `/var`, `/tmp` or `/etc` passes through a link the system itself keeps there, so those links are trusted.
pub fn plain_path(path: &Path) -> Result<()> {
    for p in path.ancestors() {
        if fs::symlink_metadata(p).is_ok_and(|m| m.is_symlink()) && !system_link(p) {
            return Err(format!("Refusing to edit linked path {}", p.display()));
        }
    }
    Ok(())
}

/// Whether `path` is one of the system's own links at the top: `/tmp`, `/var` or `/etc` on macOS.
fn system_link(path: &Path) -> bool {
    path.parent() == Some(Path::new("/")) && path.file_name().is_some_and(system_top)
}

/// Whether `/name` is `/tmp`, `/var` or `/etc` on macOS: owned by root, and a link to the same name in `/private`.
#[cfg(target_os = "macos")]
fn system_top(name: &OsStr) -> bool {
    use std::{os::unix::fs::MetadataExt, sync::OnceLock};
    const NAMES: [&str; 3] = ["tmp", "var", "etc"];
    static TRUSTED: OnceLock<[bool; 3]> = OnceLock::new();
    let trusted = TRUSTED.get_or_init(|| {
        NAMES.map(|name| {
            let link = Path::new("/").join(name);
            fs::symlink_metadata(&link).is_ok_and(|m| m.is_symlink() && m.uid() == 0)
                && fs::read_link(&link)
                    .is_ok_and(|to| to == Path::new("private").join(name) || to == Path::new("/private").join(name))
        })
    });
    NAMES.iter().zip(trusted).any(|(top, trusted)| *trusted && name == OsStr::new(top))
}
/// Only macOS keeps links of its own above the user's folders.
#[cfg(not(target_os = "macos"))]
fn system_top(_name: &OsStr) -> bool {
    false
}

/// One part of a path as macOS and Windows compare it. Parts borrow from the path: comparing two paths that differ,
/// the usual answer when looking for the project a path is in, copies no names.
#[derive(Clone, Debug, PartialEq)]
enum Part<'a> {
    /// A drive or a share: `key` is the same for one in any case and with or without `\\?\`, `text` is as written,
    /// and `verbatim` tells whether it was written with `\\?\`.
    Volume { key: String, text: &'a OsStr, verbatim: bool },
    /// A folder or file name, which can lead to the same file under another spelling.
    Name(&'a OsStr),
    /// The root, `.`, `..` or another kind of prefix, compared as written.
    Other(&'a OsStr),
}
impl<'a> Part<'a> {
    fn text(&self) -> &'a OsStr {
        match *self {
            Part::Volume { text, .. } | Part::Name(text) | Part::Other(text) => text,
        }
    }
}

/// `path` in parts, and on macOS below `/private` where it starts in one of the system's own links.
fn parts(path: &Path) -> Vec<Part<'_>> {
    let mut parts: Vec<Part<'_>> = path
        .components()
        .map(|c| match c {
            Component::Prefix(prefix) => volume(prefix),
            Component::Normal(name) => Part::Name(name),
            other => Part::Other(other.as_os_str()),
        })
        .collect();
    if let [Part::Other(root), Part::Name(top), ..] = parts.as_slice()
        && *root == OsStr::new("/")
        && system_top(top)
    {
        parts.insert(1, Part::Name(OsStr::new("private")));
    }
    parts
}

/// A drive letter or a share, whichever way it was written: case doesn't matter in either.
fn volume(prefix: PrefixComponent<'_>) -> Part<'_> {
    let (key, verbatim) = match prefix.kind() {
        Prefix::Disk(drive) => (format!("{}:", char::from(drive.to_ascii_uppercase())), false),
        Prefix::VerbatimDisk(drive) => (format!("{}:", char::from(drive.to_ascii_uppercase())), true),
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => (
            format!(r"\\{}\{}", server.to_string_lossy(), share.to_string_lossy()).to_lowercase(),
            matches!(prefix.kind(), Prefix::VerbatimUNC(..)),
        ),
        _ => return Part::Other(prefix.as_os_str()),
    };
    Part::Volume { key, text: prefix.as_os_str(), verbatim }
}

fn joined(parts: &[Part<'_>]) -> PathBuf {
    parts.iter().map(Part::text).collect()
}

fn same_parts(rules: Rules, a: &[Part<'_>], b: &[Part<'_>]) -> bool {
    a.len() == b.len() && folded(rules, a, b, false)
}

/// Whether the first parts of `path` name `root`, as spelled or spelled another way: each name that differs must
/// differ only in case, or on Windows be an 8.3 short name, and lead to the same file as `root`'s name there. Windows
/// reads a path with `\\?\` exactly as written, and trims a trailing dot or space from the names of one without, so
/// with `\\?\` on one side only, every level has to lead to the same file. With `loose`, a difference in case or in
/// `\\?\` alone counts without asking the file system.
fn folded(rules: Rules, root: &[Part<'_>], path: &[Part<'_>], loose: bool) -> bool {
    if path.len() < root.len() {
        return false;
    }
    // Every part has to be able to match before the file system is asked about any of them.
    let mut ask = Vec::new();
    let mut respelled = false;
    for (depth, (r, p)) in root.iter().zip(path).enumerate() {
        match (r, p) {
            (Part::Volume { key: a, verbatim: x, .. }, Part::Volume { key: b, verbatim: y, .. }) if a == b => {
                respelled |= x != y && !loose;
            }
            (Part::Name(a), Part::Name(b)) if a == b => {}
            (Part::Name(a), Part::Name(b)) => {
                let case = fold_eq(a, b);
                if !case && !(rules.windows && (short_name(a) || short_name(b))) {
                    return false;
                }
                if !(case && loose) {
                    ask.push(depth);
                }
            }
            (Part::Other(a), Part::Other(b)) if a == b => {}
            _ => return false,
        }
    }
    if respelled {
        ask = (1..root.len()).collect();
    }
    ask.into_iter().all(|depth| same_file(&joined(&root[..=depth]), &joined(&path[..=depth])))
}

/// Whether two names differ at most in case.
fn fold_eq(a: &OsStr, b: &OsStr) -> bool {
    if a.is_ascii() && b.is_ascii() {
        return a.eq_ignore_ascii_case(b);
    }
    let (a, b) = (a.to_string_lossy(), b.to_string_lossy());
    a.to_lowercase() == b.to_lowercase() || a.to_uppercase() == b.to_uppercase()
}

/// Whether `name` could be an 8.3 short name, which Windows makes from the first letters of the long one, `~` and a
/// number.
fn short_name(name: &OsStr) -> bool {
    name.as_encoded_bytes().contains(&b'~')
}

/// Whether `a` and `b` lead to the same file. A link at their last name is not followed, so a link never stands in
/// for what it leads to. A relative path would be asked about wherever Laci happens to run, so it confirms nothing.
fn same_file(a: &Path, b: &Path) -> bool {
    let id = |p: &Path| fs::symlink_metadata(p).ok().and_then(|meta| super::identity(p, &meta).ok());
    a.is_absolute() && b.is_absolute() && id(a).is_some_and(|a| id(b) == Some(a))
}

fn rewrite_with(rules: Rules, text: &str, from: &str, to: &str) -> Option<String> {
    let rest = if rules.fold { strip_folded(rules, text, from)? } else { text.strip_prefix(from)? };
    let separator = |c: char| c == '/' || (rules.windows && c == '\\');
    (rest.is_empty() || rest.starts_with(separator)).then(|| format!("{to}{rest}"))
}

/// What follows `prefix` at the start of `text`, compared without case and, on Windows, with either separator.
fn strip_folded<'a>(rules: Rules, text: &'a str, prefix: &str) -> Option<&'a str> {
    let separator = |c: char| c == '/' || (rules.windows && c == '\\');
    let mut rest = text.char_indices();
    for p in prefix.chars() {
        let (_, t) = rest.next()?;
        if t != p && !(separator(t) && separator(p)) && !t.to_lowercase().eq(p.to_lowercase()) {
            return None;
        }
    }
    Some(&text[rest.offset()..])
}

/// The rules of macOS and Windows, checked on Linux: there a second hard link to a file stands in for a name in another
/// case, which only a case-insensitive file system gives. The real ones are tried in `tests/paths_xplat.rs`.
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    const LINUX: Rules = Rules { fold: false, windows: false };
    const MACOS: Rules = Rules { fold: true, windows: false };
    const WINDOWS: Rules = Rules { fold: true, windows: true };

    fn folded_path(rules: Rules, root: &Path, path: &Path, loose: bool) -> bool {
        folded(rules, &parts(root), &parts(path), loose)
    }

    #[test]
    fn a_log_path_is_rewritten_only_at_a_whole_name() {
        for rules in [LINUX, MACOS, WINDOWS] {
            let rewrite = |text| rewrite_with(rules, text, "/home/u/old", "/home/u/new");
            assert_eq!(rewrite("/home/u/old").as_deref(), Some("/home/u/new"));
            assert_eq!(rewrite("/home/u/old/src").as_deref(), Some("/home/u/new/src"));
            assert_eq!(rewrite("/home/u/older"), None, "{rules:?}");
            assert_eq!(rewrite("/home/u/ol"), None);
        }
        assert_eq!(rewrite_with(LINUX, "/HOME/u/old/x", "/home/u/old", "/n"), None, "Linux keeps case");
        assert_eq!(rewrite_with(MACOS, "/HOME/u/OLD/x", "/home/u/old", "/n").as_deref(), Some("/n/x"));
        assert_eq!(rewrite_with(MACOS, "/home/u/old\\x", "/home/u/old", "/n"), None, "a name may hold \\ on macOS");
        let windows = |text| rewrite_with(WINDOWS, text, r"C:\Users\me\old", r"D:\new");
        assert_eq!(windows(r"c:\users\ME\old\src\main").as_deref(), Some(r"D:\new\src\main"));
        assert_eq!(windows("C:/Users/me/old/src").as_deref(), Some(r"D:\new/src"), "either separator, kept as written");
        assert_eq!(windows(r"C:\Users\me\old"), Some(r"D:\new".to_owned()));
        assert_eq!(windows(r"C:\Users\me\olden\src"), None);
        assert_eq!(windows(r"C:\Users\me"), None, "text that ends inside the prefix");
        assert_eq!(rewrite_with(MACOS, "/Ärger/Δx/a", "/ärger/δX", "/n").as_deref(), Some("/n/a"), "beyond ASCII");
    }

    #[test]
    fn another_spelling_counts_once_it_leads_to_the_same_file() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().canonicalize().unwrap();
        fs::create_dir(dir.join("Projects")).unwrap();
        fs::write(dir.join("Projects/Notes"), "x").unwrap();
        // The same file under a name in another case, and under an 8.3-style name.
        fs::hard_link(dir.join("Projects/Notes"), dir.join("Projects/notes")).unwrap();
        fs::hard_link(dir.join("Projects/Notes"), dir.join("Projects/NOTES~1")).unwrap();
        fs::write(dir.join("Projects/NOTES"), "another file").unwrap();
        let (root, path) = (dir.join("Projects/Notes"), dir.join("Projects/notes/more"));
        for rules in [MACOS, WINDOWS] {
            assert!(folded_path(rules, &root, &path, false), "{rules:?}");
            assert!(!folded_path(rules, &root, &dir.join("Projects/NOTES/more"), false), "another file: {rules:?}");
            assert!(!folded_path(rules, &root, &dir.join("Projects/nOTES-gone/more"), false));
            assert!(!folded_path(rules, &root, &dir.join("Projects"), false), "above the root");
        }
        assert!(folded_path(WINDOWS, &root, &dir.join("Projects/NOTES~1/more"), false), "a short name on Windows");
        assert!(!folded_path(MACOS, &root, &dir.join("Projects/NOTES~1/more"), false), "but no short names on macOS");
        // An exact spelling needs no file at all.
        assert!(folded_path(MACOS, &dir.join("gone"), &dir.join("gone/x"), false));
        assert!(fold_eq(OsStr::new("Straße"), OsStr::new("STRASSE")), "a candidate, which the file system decides");
        assert!(!fold_eq(OsStr::new("Notes"), OsStr::new("Notes2")));
    }

    #[test]
    fn a_doubt_in_case_alone_counts_as_inside_for_refusals() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().canonicalize().unwrap();
        let (root, path) = (dir.join("Laci/data"), dir.join("laci/DATA/journal"));
        assert!(!folded_path(MACOS, &root, &path, false), "nothing there confirms it");
        assert!(folded_path(MACOS, &root, &path, true));
        assert!(folded_path(WINDOWS, &root, &path, true));
        assert!(!folded_path(WINDOWS, &root, &dir.join("Laci/other/journal"), true));
        assert!(!folded_path(WINDOWS, &root, &dir.join("LACI~1/data/journal"), true), "a short name must exist");
    }

    #[test]
    fn a_link_never_stands_in_for_what_it_leads_to() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().canonicalize().unwrap();
        fs::create_dir(dir.join("Real")).unwrap();
        std::os::unix::fs::symlink(dir.join("Real"), dir.join("real")).unwrap();
        for rules in [MACOS, WINDOWS] {
            assert!(!folded_path(rules, &dir.join("Real"), &dir.join("real/x"), false), "{rules:?}");
            assert!(!same_parts(rules, &parts(&dir.join("Real")), &parts(&dir.join("real"))));
        }
    }

    #[test]
    fn a_second_link_to_a_file_is_another_name_not_another_case() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().canonicalize().unwrap();
        fs::write(dir.join("Notes"), "x").unwrap();
        fs::hard_link(dir.join("Notes"), dir.join("notes")).unwrap();
        for rules in [MACOS, WINDOWS] {
            assert!(same_parts(rules, &parts(&dir.join("Notes")), &parts(&dir.join("notes"))), "one file");
            assert!(!renamed_case(rules, &dir.join("Notes"), &dir.join("notes")), "{rules:?}: but two entries");
        }
    }

    #[test]
    fn parts_keep_names_apart_from_the_rest() {
        assert_eq!(
            parts(Path::new("/a/../b/")),
            [
                Part::Other(OsStr::new("/")),
                Part::Name(OsStr::new("a")),
                Part::Other(OsStr::new("..")),
                Part::Name(OsStr::new("b")),
            ]
        );
        assert_eq!(joined(&parts(Path::new("/a/b"))), Path::new("/a/b"));
        // Nothing on Linux is one of macOS's links at the top.
        assert_eq!(parts(Path::new("/var/x")).len(), 3);
    }
}
