//! How paths compare: byte for byte, as Laci always has.
use laci_core::{config, env::Env, platform::path};
use serde_json::json;

mod support;

#[test]
fn a_history_path_inside_a_project_stays_inside() {
    let env = Env::for_home(std::env::temp_dir().join("laci-paths-home"));
    let inside = |p: &str| config::validate_connector(&env, &json!({"name":"Notes","link":{"kind":"inside","path":p}}));
    for p in ["notes", "docs/notes", "a.b/c", "docs/"] {
        assert!(inside(p).is_ok(), "{p}");
    }
    for p in ["/x", "../x", "a/../../x", "a//b", "", "/"] {
        assert!(inside(p).is_err(), "{p}");
    }
    // Plain names, which only Windows would read as a way out of the project.
    for p in [r"..\x", r"\x", r"C:\x", "C:x", r"a\..\..\x"] {
        assert!(inside(p).is_ok(), "{p}");
    }
}

/// A log names folders with the OS's own separator. What a moved folder held moves with it in the log; a folder whose
/// name only begins the same, or is spelled in another case, stays.
#[test]
fn a_log_path_below_a_moved_folder_is_rewritten_with_its_own_separator() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(path::canonical(temp.path()).unwrap().join("home"));
    let (old, new) = (env.home.join("project").join("Old"), env.home.join("project").join("New"));
    let older = env.home.join("project").join("Older");
    let other_case = env.home.join("project").join("OLD").join("docs");
    let log = env.home.join("history").join("session.jsonl");
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    let lines = [old.join("src").join("lib"), older.clone(), other_case].map(|cwd| json!({"cwd":cwd}).to_string());
    std::fs::write(&log, lines.join("\n") + "\n").unwrap();
    let action = json!({"type":"rewrite-logs","pairs":[[old, new]],"files":[log],"field":"cwd"});
    laci_core::ops::apply_action(&env, &json!({}), "Rewrite", &action).unwrap();
    let text = std::fs::read_to_string(&log).unwrap();
    let has = |cwd: std::path::PathBuf| text.contains(&json!({"cwd":cwd}).to_string());
    assert!(has(new.join("src").join("lib")), "{text}");
    assert!(has(older), "{text}");
    assert!(!has(new.join("docs")), "another case is another folder");
}

/// Laci 2.5's path functions, kept here to show that the new ones answer exactly as they did.
mod linux {
    use super::*;
    use laci_core::paths;
    use std::{
        fs,
        path::{Component, Path, PathBuf},
    };

    fn old_normalize(path: &Path) -> PathBuf {
        let mut out = PathBuf::new();
        for c in path.components() {
            match c {
                Component::CurDir => (),
                Component::ParentDir => {
                    out.pop();
                }
                c => out.push(c.as_os_str()),
            }
        }
        out
    }
    fn old_expand(raw: &str, home: &Path) -> PathBuf {
        old_normalize(&if raw == "~" {
            home.to_owned()
        } else if let Some(rest) = raw.strip_prefix("~/") {
            home.join(rest)
        } else {
            PathBuf::from(raw)
        })
    }
    fn old_tilde(path: &Path, home: &Path) -> String {
        path.strip_prefix(home)
            .map(|p| if p.as_os_str().is_empty() { "~".to_owned() } else { format!("~/{}", p.display()) })
            .unwrap_or_else(|_| path.to_string_lossy().into_owned())
    }
    fn old_rewrite(old: &str, from: &str, to: &str) -> Option<String> {
        old.strip_prefix(from).filter(|rest| rest.is_empty() || rest.starts_with('/')).map(|rest| format!("{to}{rest}"))
    }
    /// Called, as in Laci 2.5, only once `old` starts with `from`.
    fn old_relocated(from: &Path, to: &Path, old: &Path) -> PathBuf {
        let relative = old.strip_prefix(from).expect("validated project prefix");
        if relative.as_os_str().is_empty() { to.to_owned() } else { to.join(relative) }
    }
    fn old_plain_path(path: &Path) -> Result<(), String> {
        for p in path.ancestors() {
            if fs::symlink_metadata(p).is_ok_and(|m| m.is_symlink()) {
                return Err(format!("Refusing to edit linked path {}", p.display()));
            }
        }
        Ok(())
    }
    /// The deepest existing ancestor made canonical, then the rest, as `paths.rs` checked a path below a root.
    fn old_resolved(path: &Path) -> Option<PathBuf> {
        let mut ancestor = path;
        while fs::symlink_metadata(ancestor).is_err() {
            ancestor = ancestor.parent()?;
        }
        let actual = ancestor.canonicalize().ok()?;
        let rest = path.strip_prefix(ancestor).ok()?;
        Some(if rest.as_os_str().is_empty() { actual } else { actual.join(rest) })
    }

    /// POSIX paths with what tends to go wrong: case, trailing and double slashes, `.` and `..`, a name that only
    /// begins the same, `\`, `:` and `~` that are plain characters here, macOS's and Windows' spellings, and text
    /// beyond ASCII.
    const CORPUS: &[&str] = &[
        "",
        "/",
        "//",
        "/home",
        "/home/",
        "/home/u",
        "/home/u/",
        "/home/U",
        "/HOME/u",
        "/home/u/p",
        "/home/u/p/",
        "/home/u/p2",
        "/home/u/p/src",
        "/home/u/P/src",
        "/home/u//p/src",
        "/home/u/./p",
        "/home/u/p/../q",
        "/home/u/p\\src",
        "/home/u/C:",
        "/home/u/PROJEC~1/src",
        "/home/u/p q/r",
        "/home/u/π/Straße",
        "/home/u/π/STRASSE",
        "C:\\Users\\u",
        "c:/users/u",
        "\\\\server\\share\\x",
        "\\\\?\\C:\\x",
        "~",
        "~/",
        "~/p",
        "~/p/src",
        "~\\p",
        "~u/p",
        "relative",
        "relative/p",
        "./p",
        "../p",
        "/var/folders/x",
        "/private/var/folders/x",
        "/tmp/x",
    ];

    #[test]
    fn containment_and_sameness_answer_byte_for_byte() {
        for raw in CORPUS.iter().map(Path::new) {
            let before = !(raw.is_absolute() || raw.components().any(|c| c == Component::ParentDir));
            assert_eq!(path::stays_below(raw), before, "{}", raw.display());
        }
        for a in CORPUS.iter().map(Path::new) {
            for b in CORPUS.iter().map(Path::new) {
                let what = format!("{} / {}", a.display(), b.display());
                assert_eq!(path::contains(a, b), b.starts_with(a), "{what}");
                assert_eq!(path::may_contain(a, b), b.starts_with(a), "{what}");
                assert_eq!(paths::within(b, a), b.starts_with(a), "{what}");
                assert_eq!(path::same_path(a, b), a == b, "{what}");
                assert_eq!(path::below(a, b), b.strip_prefix(a).ok().map(Path::to_owned), "{what}");
            }
        }
    }

    #[test]
    fn moved_paths_and_rewritten_logs_answer_as_before() {
        let to = Path::new("/srv/moved");
        for from in CORPUS {
            for old in CORPUS {
                let what = format!("{from} / {old}");
                let before =
                    Path::new(old).starts_with(from).then(|| old_relocated(Path::new(from), to, Path::new(old)));
                assert_eq!(path::relocate(Path::new(from), to, Path::new(old)), before, "{what}");
                assert_eq!(
                    path::moved_text(Path::new(from), to, old),
                    before.map(|p| p.to_string_lossy().into_owned()),
                    "{what}"
                );
                assert_eq!(
                    path::rewrite_prefix(old, from, "/srv/moved"),
                    old_rewrite(old, from, "/srv/moved"),
                    "{what}"
                );
            }
        }
    }

    #[test]
    fn typed_paths_expand_and_shorten_as_before() {
        for home in ["/home/u", "/home/u/", "/", "/home/π"].map(Path::new) {
            for raw in CORPUS {
                assert_eq!(paths::expand(raw, home), old_expand(raw, home), "{raw} in {}", home.display());
                let p = Path::new(raw);
                assert_eq!(paths::tilde(p, home), old_tilde(p, home), "{raw} in {}", home.display());
            }
        }
    }

    #[test]
    fn real_paths_resolve_and_count_as_plain_as_before() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("real/sub")).unwrap();
        fs::write(root.join("real/file"), "x").unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        std::os::unix::fs::symlink(root.join("gone"), root.join("dangling")).unwrap();
        let tried = [
            "",
            "real",
            "real/",
            "real/sub",
            "real/file",
            "real/missing/deeper",
            "link",
            "link/sub",
            "link/missing",
            "dangling",
            "dangling/x",
            "missing",
            "missing/deeper",
            "real/../link/sub",
            "real/./sub",
        ];
        for rel in tried {
            let p = root.join(rel);
            let what = p.display().to_string();
            assert_eq!(path::canonical(&p).ok(), p.canonicalize().ok(), "{what}");
            assert_eq!(path::resolve_existing(&p).ok(), old_resolved(&p), "{what}");
            assert_eq!(path::plain_path(&p), old_plain_path(&p), "{what}");
            for q in tried.iter().map(|rel| root.join(rel)) {
                assert_eq!(path::same_path(&p, &q), p == q, "{what} / {}", q.display());
                assert_eq!(path::contains(&p, &q), q.starts_with(&p), "{what} / {}", q.display());
                assert_eq!(path::may_contain(&p, &q), q.starts_with(&p), "{what} / {}", q.display());
            }
        }
        // Two names for one file, which a case-insensitive system would give, are still two paths on Linux.
        fs::hard_link(root.join("real/file"), root.join("real/FILE")).unwrap();
        assert!(!path::same_path(&root.join("real/file"), &root.join("real/FILE")));
    }
}
