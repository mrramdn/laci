//! Rules for paths. Linux compares them byte by byte, as Laci always has: `Foo` and `foo` are two names.
use crate::Result;
use std::{
    ffi::OsStr,
    fs, io,
    path::{Component, Path, PathBuf},
};

/// `path` with every link and every `.` or `..` resolved.
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

/// Whether `path` is `root` or inside it.
pub fn contains(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// Whether `a` and `b` are the same path, by the rules of [`contains`].
pub fn same_path(a: &Path, b: &Path) -> bool {
    a == b
}

/// Whether `path` could be `root` or inside it, for the checks that refuse.
pub fn may_contain(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// What `path` holds below `root`: nothing for `root` itself, and `None` when `path` isn't [inside](contains) `root`.
pub fn below(root: &Path, path: &Path) -> Option<PathBuf> {
    path.strip_prefix(root).ok().map(Path::to_owned)
}

/// Where `path` is once `from`, the folder it is in, has moved to `to`. The part below `from` keeps its spelling.
pub fn relocate(from: &Path, to: &Path, path: &Path) -> Option<PathBuf> {
    below(from, path).map(|rest| if rest.as_os_str().is_empty() { to.to_owned() } else { to.join(rest) })
}

/// The text a tool would record for `recorded`, a path it recorded inside `from`, once `from` has moved to `to`, or
/// `None` when `recorded` isn't inside `from`: `recorded` [`relocate`]d.
pub fn moved_text(from: &Path, to: &Path, recorded: &str) -> Option<String> {
    Some(relocate(from, to, Path::new(recorded))?.to_string_lossy().into_owned())
}

/// `text`, a path as a log recorded it, with `from` at its start replaced by `to`, when it is `from` or a path inside
/// it.
pub fn rewrite_prefix(text: &str, from: &str, to: &str) -> Option<String> {
    let rest = text.strip_prefix(from)?;
    (rest.is_empty() || rest.starts_with('/')).then(|| format!("{to}{rest}"))
}

/// Whether `relative`, joined to a folder, stays below it: no `..`, and no root, from which the join would start over
/// somewhere else.
pub fn stays_below(relative: &Path) -> bool {
    !relative.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
}

/// Whether a folder named `name` is where Git looks for a repository, `.git`.
pub fn git_dir_name(name: &OsStr) -> bool {
    name.as_encoded_bytes() == b".git"
}

/// Reject linked files and linked ancestor directories before writing notes or task files.
pub fn plain_path(path: &Path) -> Result<()> {
    for p in path.ancestors() {
        if fs::symlink_metadata(p).is_ok_and(|m| m.is_symlink()) {
            return Err(format!("Refusing to edit linked path {}", p.display()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_path_is_rewritten_only_at_a_whole_name() {
        let rewrite = |text| rewrite_prefix(text, "/home/u/old", "/home/u/new");
        assert_eq!(rewrite("/home/u/old").as_deref(), Some("/home/u/new"));
        assert_eq!(rewrite("/home/u/old/src").as_deref(), Some("/home/u/new/src"));
        assert_eq!(rewrite("/home/u/older"), None);
        assert_eq!(rewrite("/home/u/ol"), None);
        assert_eq!(rewrite_prefix("/HOME/u/old/x", "/home/u/old", "/n"), None, "Linux keeps case");
    }

    #[test]
    fn git_finds_its_folder_under_each_name_the_os_reads_as_git() {
        for (name, read_as_git) in [
            (".git", true),
            (".GIT", false),
            (".Git", false),
            (".git.", false),
            (".GIT . .", false),
            (".git ", false),
            ("git", false),
            (".gitignore", false),
            ("..git", false),
            (". git", false),
            (".", false),
        ] {
            assert_eq!(git_dir_name(OsStr::new(name)), read_as_git, "{name:?}");
        }
    }
}
