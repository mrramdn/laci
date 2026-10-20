//! Every Git read goes through here. A folder under the scan roots is not trusted: it may have been copied in
//! from anywhere, and Git settings stored inside it can name programs for Git to start.
use crate::{Result, process};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Duration,
};

const WAIT: Duration = Duration::from_secs(20);

/// No hooks, including the one that follows an index refresh.
const NO_HOOKS: &str = "core.hooksPath=/dev/null";

/// Forced for every call, whatever the folder's own settings say.
const FIXED: [&str; 5] = [
    // `status` asks this program which files changed.
    "core.fsmonitor=false",
    NO_HOOKS,
    "core.pager=cat",
    // `log` would start the signature checker.
    "log.showSignature=false",
    // A remote URL must not be able to name a command.
    "protocol.ext.allow=never",
];

/// A read never fetches missing objects or prompts, and ignores a repository named by the parent process.
pub(crate) const ENV: [(&str, Option<&str>); 5] = [
    ("GIT_NO_LAZY_FETCH", Some("1")),
    ("GIT_TERMINAL_PROMPT", Some("0")),
    ("GIT_DIR", None),
    ("GIT_WORK_TREE", None),
    ("GIT_INDEX_FILE", None),
];

/// `args` after the settings every call forces.
fn full<'a>(settings: &'a [String], args: &[&'a str]) -> Vec<&'a str> {
    forced(FIXED.into_iter().chain(settings.iter().map(String::as_str)), args)
}

/// `args` after `settings`.
fn forced<'a>(settings: impl Iterator<Item = &'a str>, args: &[&'a str]) -> Vec<&'a str> {
    let mut full = vec!["--no-pager"];
    for setting in settings {
        full.extend(["-c", setting]);
    }
    full.extend_from_slice(args);
    full
}

/// Whether Git runs here, for the first run's note asking to install it.
pub(crate) fn runs() -> bool {
    process::run("git", &["--version"], None, Duration::from_secs(5)).is_ok()
}

fn call(dir: &Path, settings: &[String], args: &[&str], timeout: Duration) -> Result<String> {
    process::run_env("git", &full(settings, args), Some(dir), timeout, &ENV)
}

/// The names in a `-z` listing, as Git wrote them.
pub(crate) fn names(listing: &[u8]) -> impl Iterator<Item = &[u8]> {
    listing.split(|byte| *byte == 0).filter(|name| !name.is_empty())
}

/// A name from a listing as text, and whether that is all of it: a name that isn't valid text shows U+FFFD in place
/// of the bytes that aren't.
pub(crate) fn text(name: &[u8]) -> (String, bool) {
    match std::str::from_utf8(name) {
        Ok(text) => (text.to_owned(), true),
        Err(_) => (String::from_utf8_lossy(name).into_owned(), false),
    }
}

/// Where the name `name`, relative to `dir`, leads, also when it isn't valid text.
pub(crate) fn path(dir: &Path, name: &[u8]) -> PathBuf {
    dir.join(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(name))
}

/// For commands that never read file contents (`rev-parse`, `remote`, `config`).
/// Anything that compares the working tree, such as `status`, needs a [`Repo`].
pub(crate) fn plain(dir: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    call(dir, &[], args, timeout)
}

/// Git that makes a project: `clone`, `init`, `add`, `commit`, `remote`, `push`. The settings every call forces hold
/// here too, and Git asks no question. All but hooks: the repository is the one Laci just made (a template's own, under
/// any name, stays behind, and a clone brings none), so its hooks are the user's own, such as the pre-push hook Git
/// LFS puts there that uploads the files it tracks.
pub(crate) fn make(dir: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let settings = FIXED.into_iter().filter(|setting| *setting != NO_HOOKS);
    process::run_env("git", &forced(settings, args), Some(dir), timeout, &ENV)
}

/// The driver name in `filter.<name>.clean`, `.smudge` or `.process`: commands Git runs on file contents.
fn filter_name(key: &str) -> Option<&str> {
    let rest = key.strip_prefix("filter.")?;
    [".clean", ".smudge", ".process"].iter().find_map(|end| rest.strip_suffix(end)).filter(|name| !name.is_empty())
}

/// Overrides that switch off the filter commands the folder defines. Ones from the user's own settings, such as
/// Git LFS, keep their value. `listing` is `git config -z --list`, with `--show-scope` when `scoped`.
fn filter_overrides(listing: &str, scoped: bool) -> Result<Vec<String>> {
    let mut own = BTreeMap::new();
    let mut foreign = BTreeSet::new();
    let mut fields = listing.split('\0');
    loop {
        let scope = if scoped { fields.next() } else { Some("") };
        let (Some(scope), Some(entry)) = (scope, fields.next()) else { break };
        let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
        if filter_name(key).is_none() {
            continue;
        }
        if matches!(scope, "system" | "global" | "command") {
            own.insert(key, value);
        } else {
            foreign.insert(key);
        }
    }
    let mut out = Vec::new();
    let mut names = BTreeSet::new();
    for key in foreign {
        let name = filter_name(key).unwrap_or_default();
        // `-c` splits at the first `=`, so such a name could not be overridden.
        if name.contains('=') {
            return Err("This folder's Git settings can't be read safely".into());
        }
        out.push(format!("{key}={}", own.get(key).copied().unwrap_or("")));
        names.insert(name);
    }
    for name in names {
        if !own.keys().any(|key| filter_name(key) == Some(name)) {
            // Otherwise Git stops because the filter it was told to require did not run.
            out.push(format!("filter.{name}.required=false"));
        }
    }
    Ok(out)
}

/// One folder's Git, with the filter commands its own settings define switched off.
pub(crate) struct Repo {
    dir: PathBuf,
    settings: Result<Vec<String>>,
}

impl Repo {
    pub(crate) fn at(dir: &Path) -> Self {
        let settings = plain(dir, &["config", "--show-scope", "-z", "--list"], WAIT)
            .and_then(|listing| filter_overrides(&listing, true))
            // Git before 2.26 cannot say where a setting came from, so every named filter is switched off.
            .or_else(|_| {
                plain(dir, &["config", "-z", "--list"], WAIT).and_then(|listing| filter_overrides(&listing, false))
            });
        Self { dir: dir.to_owned(), settings }
    }

    pub(crate) fn run(&self, args: &[&str], timeout: Duration) -> Result<String> {
        call(&self.dir, self.settings.as_ref().map_err(Clone::clone)?, args, timeout)
    }

    /// Like [`Repo::run`], with the output as Git wrote it: for `-z` lists of names that may not be valid text.
    pub(crate) fn run_bytes(&self, args: &[&str], timeout: Duration) -> Result<Vec<u8>> {
        let settings = self.settings.as_ref().map_err(Clone::clone)?;
        process::run_env_bytes("git", &full(settings, args), Some(&self.dir), timeout, &ENV)
    }

    /// Output of a read, or nothing when Git fails.
    pub(crate) fn read(&self, args: &[&str]) -> String {
        self.run(args, WAIT).unwrap_or_default()
    }

    /// Lines of `git status --porcelain=v1 -b`, plus one for each submodule with changed files. Git is told not
    /// to look inside submodules, where it would start itself under their settings; each is read here instead.
    pub(crate) fn status(&self) -> Vec<String> {
        let mut lines: Vec<String> = self
            .read(&["status", "--porcelain=v1", "-b", "--untracked-files=normal", "--ignore-submodules=dirty"])
            .lines()
            .map(str::to_owned)
            .collect();
        if !self.dir.join(".gitmodules").is_file() {
            return lines;
        }
        for entry in self.read(&["ls-files", "--stage", "-z"]).split('\0') {
            let Some(path) = entry.strip_prefix("160000 ").and_then(|rest| rest.split_once('\t')).map(|p| p.1) else {
                continue;
            };
            let sub = self.dir.join(path);
            if lines.iter().any(|line| line.get(3..) == Some(path)) || !sub.join(".git").exists() {
                continue;
            }
            let changed =
                Repo::at(&sub).read(&["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=dirty"]);
            if !changed.is_empty() {
                lines.push(format!(" M {path}"));
            }
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing(entries: &[(&str, &str, &str)]) -> String {
        entries.iter().map(|(scope, key, value)| format!("{scope}\0{key}\n{value}\0")).collect()
    }

    #[test]
    fn folder_defined_filters_are_switched_off_and_user_filters_kept() {
        let text = listing(&[
            ("global", "filter.lfs.clean", "git-lfs clean -- %f"),
            ("global", "filter.lfs.process", "git-lfs filter-process"),
            ("global", "filter.lfs.required", "true"),
            ("local", "core.bare", "false"),
            ("local", "filter.lfs.process", "other"),
            ("local", "filter.pack.v2.clean", "other"),
            ("worktree", "filter.pack.v2.smudge", "other"),
            ("local", "filter.pack.v2.required", "true"),
        ]);
        assert_eq!(
            filter_overrides(&text, true).unwrap(),
            [
                "filter.lfs.process=git-lfs filter-process",
                "filter.pack.v2.clean=",
                "filter.pack.v2.smudge=",
                "filter.pack.v2.required=false",
            ]
        );
        assert!(
            filter_overrides(&listing(&[("global", "filter.lfs.clean", "git-lfs clean -- %f")]), true)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn without_scopes_every_named_filter_is_switched_off() {
        let text = "user.name\nTest\0filter.lfs.clean\ngit-lfs clean -- %f\0core.bare\0";
        assert_eq!(filter_overrides(text, false).unwrap(), ["filter.lfs.clean=", "filter.lfs.required=false"]);
    }

    #[test]
    fn a_filter_name_that_cannot_be_overridden_is_refused() {
        assert!(filter_overrides(&listing(&[("local", "filter.a=b.clean", "other")]), true).is_err());
        assert_eq!(filter_name("filter..clean"), None);
        assert_eq!(filter_name("filter.x.required"), None);
    }
}
