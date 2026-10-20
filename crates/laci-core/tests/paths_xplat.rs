//! How paths compare on each OS. Linux keeps its byte-for-byte answers. On macOS and Windows another spelling of a
//! place (case, an 8.3 short name, `\\?\`, `/private/var`) counts as that place only once the file system confirms it.
use laci_core::{config, env::Env, platform::path};
use serde_json::json;

mod support;

#[test]
fn a_history_path_inside_a_project_stays_inside_on_every_os() {
    let env = Env::for_home(std::env::temp_dir().join("laci-paths-home"));
    let inside = |p: &str| config::validate_connector(&env, &json!({"name":"Notes","link":{"kind":"inside","path":p}}));
    for p in ["notes", "docs/notes", "a.b/c", "docs/"] {
        assert!(inside(p).is_ok(), "{p}");
    }
    for p in ["/x", "../x", "a/../../x", "a//b", "", "/"] {
        assert!(inside(p).is_err(), "{p}");
    }
    // Plain names on Linux and macOS, a way out of the project on Windows.
    for p in [r"..\x", r"\x", r"C:\x", "C:x", r"a\..\..\x"] {
        assert_eq!(inside(p).is_err(), cfg!(windows), "{p}");
    }
}

/// A log names folders with the OS's own separator, and on macOS and Windows maybe in another case. What a moved
/// folder held moves with it in the log; a folder whose name only begins the same stays.
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
    assert_eq!(has(new.join("docs")), path::FOLDS_CASE, "another case is the same folder only where case is ignored");
}

/// Laci 2.5's path functions, kept here to show that on Linux the new ones answer exactly as they did.
#[cfg(target_os = "linux")]
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
        const { assert!(!path::FOLDS_CASE) };
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
                assert!(!path::renames_case(a, b), "{what}");
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
        assert!(!path::renames_case(&root.join("real/file"), &root.join("real/FILE")));
    }
}

/// macOS and Windows: their default volumes ignore case, and both can have folders or volumes that don't.
#[cfg(any(target_os = "macos", windows))]
mod folding {
    use super::*;
    use laci_core::{paths, service::Service};
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    /// `path` with every letter in the other case, so the file system has to say whether it is the same.
    fn swapped(path: &Path) -> PathBuf {
        let text = path.to_string_lossy();
        PathBuf::from(
            text.chars()
                .map(|c| if c.is_uppercase() { c.to_ascii_lowercase() } else { c.to_ascii_uppercase() })
                .collect::<String>(),
        )
    }

    fn folder() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = path::canonical(temp.path()).unwrap();
        (temp, root)
    }

    /// Whether the volume holding `dir` ignores case, as macOS's and Windows' do unless set up otherwise.
    fn folds(dir: &Path) -> bool {
        let probe = dir.join("CaseProbe");
        fs::write(&probe, "").unwrap();
        let folds = fs::symlink_metadata(dir.join("caseprobe")).is_ok();
        fs::remove_file(probe).unwrap();
        folds
    }

    #[test]
    fn another_case_counts_once_the_file_system_confirms_it() {
        let (_temp, root) = folder();
        if !folds(&root) {
            eprintln!("This volume tells case apart; nothing to confirm.");
            return;
        }
        let project = root.join("Projects/Demo");
        fs::create_dir_all(&project).unwrap();
        let other = swapped(&project);
        assert!(path::same_path(&project, &other), "{}", other.display());
        assert!(path::contains(&project, &other.join("src/new")));
        assert!(path::contains(&root, &other));
        assert!(path::may_contain(&project, &other.join("x")));
        assert_eq!(path::below(&project, &other.join("src/new")), Some(Path::new("src").join("new")));
        assert_eq!(
            path::relocate(&project, &root.join("moved"), &other.join("src")),
            Some(root.join("moved").join("src"))
        );
        assert!(path::renames_case(&project, &root.join("Projects/demo")));
        assert!(!path::renames_case(&project, &project));
        assert!(!path::renames_case(&project, &root.join("projects/Demo")), "the folder above, not the name, differs");
        // A name in another case that leads nowhere confirms nothing, but a refusal still counts it.
        let gone = root.join("Gone/inside");
        assert!(!path::contains(&root.join("Gone"), &swapped(&gone)));
        assert!(path::may_contain(&root.join("Gone"), &swapped(&gone)));
        // A name that only begins the same is never inside.
        fs::create_dir_all(root.join("Projects/Demo2")).unwrap();
        assert!(!path::contains(&project, &root.join("projects/demo2")));
        assert!(!path::may_contain(&project, &root.join("projects/demo2")));
        // Home in another case still shortens to ~.
        assert_eq!(paths::tilde(&other.join("src"), &project), format!("~/{}", Path::new("src").display()));
    }

    /// Claude names its history after the working folder as the terminal spelled it, such as `c:\` in VS Code's.
    #[test]
    fn claude_history_spelled_in_another_case_finds_its_project() {
        let (_temp, root) = folder();
        if !folds(&root) {
            return;
        }
        let env = Env::for_home(root.join("home"));
        let project = env.home.join("project").join("Demo");
        fs::create_dir_all(&project).unwrap();
        let name = paths::enc(&swapped(&project).to_string_lossy());
        assert_eq!(laci_core::agents::resolve_encoded(&env, &name), Some(project));
        let gone = paths::enc(&swapped(&env.home.join("project").join("Gone")).to_string_lossy());
        assert_eq!(laci_core::agents::resolve_encoded(&env, &gone), None);
    }

    /// An agent may name a scanned project in another spelling of its path, such as in another case: the scan's project
    /// is found all the same, once the file system confirms it.
    #[test]
    fn a_project_named_in_another_spelling_is_found_in_the_scan() {
        let (_temp, root) = folder();
        let env = Env::for_home(root.join("home"));
        let project = env.home.join("project").join("Demo");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("package.json"), "{}").unwrap();
        config::save(&env, &json!({"roots":["~/project"],"presets":[]})).unwrap();
        let mut service = Service::new(env.clone());
        assert!(service.snapshot().unwrap()["nodes"][project.to_str().unwrap()].is_object());
        let gone = swapped(&env.home.join("project").join("Gone"));
        assert!(service.node(&gone.to_string_lossy()).is_err());
        if !folds(&root) {
            eprintln!("This volume tells case apart; nothing else to find.");
            return;
        }
        let other = swapped(&project);
        assert_eq!(service.node(&other.to_string_lossy()).unwrap()["path"], json!(project));
    }

    /// A scan location saved while its disk was there may come back spelled through macOS's own link /var while the
    /// disk is away. It is kept, as when spelled the same.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_saved_location_spelled_through_var_is_kept_while_its_disk_is_away() {
        let (_temp, root) = folder();
        let env = Env::for_home(root.join("home"));
        let (saved, asked) = (Path::new("/private/var/laci-gone-disk"), Path::new("/var/laci-gone-disk"));
        config::save(&env, &json!({"roots":[saved],"presets":[],"archiveDir":saved})).unwrap();
        assert_eq!(config::validate_roots(&env, &json!([asked])).unwrap(), json!([asked]));
        assert_eq!(config::validate_archive_dir(&env, &json!(asked)).unwrap(), json!(asked));
    }

    /// A relative path would be asked about wherever Laci runs, so another spelling of it confirms nothing.
    #[test]
    fn a_relative_spelling_confirms_nothing() {
        // Tests run in the crate's folder, which holds Cargo.toml.
        assert!(Path::new("Cargo.toml").is_file());
        assert!(!path::same_path(Path::new("Cargo.toml"), Path::new("CARGO.TOML")));
        assert!(path::same_path(Path::new("Cargo.toml"), Path::new("Cargo.toml")));
    }

    #[test]
    fn a_link_never_stands_in_for_the_folder_it_leads_to() {
        let (_temp, root) = folder();
        let (real, link) = (root.join("real"), root.join("linked"));
        fs::create_dir(&real).unwrap();
        support::link_dir(&real, &link);
        // The link is one more folder in the way, wherever it leads.
        assert!(!path::same_path(&real, &link));
        assert!(!path::contains(&real, &link.join("x")));
        assert!(path::may_contain(&real, &link.join("x")), "a refusal follows it");
    }

    /// A path through a link spelled in another case leads through that same link, a symlink or one of the junctions
    /// pnpm makes on Windows: the file system tells which link it is. Names that differ by more than case are never
    /// asked about, so whether a link is taken for the folder it leads to is tried with short names in `windows`.
    #[test]
    fn a_link_spelled_in_another_case_is_the_same_link() {
        let (_temp, root) = folder();
        if !folds(&root) {
            return;
        }
        let real = root.join("Real");
        fs::create_dir(&real).unwrap();
        let linked = root.join("Linked");
        support::link_dir(&real, &linked);
        #[cfg(windows)]
        let links = {
            let junction = root.join("Junction");
            support::junction(&real, &junction);
            [linked, junction]
        };
        #[cfg(not(windows))]
        let links = [linked];
        for link in links {
            let other = swapped(&link);
            assert!(path::same_path(&link, &other), "{}", other.display());
            assert!(path::contains(&link, &other.join("src")), "{}", other.display());
        }
    }

    /// Laci's own folders stay out of a move however they are spelled. These checks come before Laci asks which
    /// programs use the folder, so they run before port:P5 too.
    #[test]
    fn laci_data_cannot_be_moved_under_another_spelling() {
        let (_temp, root) = folder();
        if !folds(&root) {
            return;
        }
        let env = Env::for_home(root.join("home"));
        let project = env.home.join("project").join("demo");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("package.json"), "{}").unwrap();
        let snap = json!({"nodes":{"demo":{"kind":"project","path":project,"name":"demo"}}});
        for owned in [&env.config_dir, &env.data_dir] {
            fs::create_dir_all(owned).unwrap();
            let destination = swapped(&owned.join("misplaced"));
            let error = laci_core::ops::move_project(&env, &snap, "demo", &destination.to_string_lossy(), &json!({}))
                .unwrap_err();
            assert!(error.contains("Laci's settings"), "{error}");
        }
        // Nor can home itself, which holds them, spelled in another case.
        let home = json!({"nodes":{"home":{"kind":"project","path":swapped(&env.home),"name":"home"}}});
        let cold = env.home.join("cold").to_string_lossy().into_owned();
        let error = laci_core::ops::move_project(&env, &home, "home", &cold, &json!({})).unwrap_err();
        assert!(error.contains("home folder"), "{error}");
        assert!(project.join("package.json").is_file());
        assert!(laci_core::ops::journals(&env, 10).is_empty());
    }

    /// A tool's log kept inside the project, found through a folder spelled in another case, moves with the project
    /// and names its new place.
    #[test]
    fn a_log_kept_inside_the_project_under_another_spelling_moves_with_it() {
        let (_temp, root) = folder();
        if !folds(&root) {
            return;
        }
        let env = Env::for_home(root.join("home"));
        let (project, moved) = (env.home.join("project").join("Demo"), env.home.join("project").join("Moved"));
        let log = project.join("logs").join("session.jsonl");
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, json!({"cwd":project}).to_string() + "\n").unwrap();
        let store = swapped(&project).join("logs");
        let snap = json!({
            "nodes":{"demo":{"kind":"project","path":project,"name":"Demo"}},
            "connectors":[{"id":"tool","link":{"kind":"cwd","dir":store,"field":"cwd"}}],
            "items":{"tool:session":{"cwd":project,"connector":"tool","file":store.join("session.jsonl")}},
        });
        laci_core::ops::move_project(&env, &snap, "demo", &moved.to_string_lossy(), &json!({})).unwrap();
        let text = fs::read_to_string(moved.join("logs").join("session.jsonl")).unwrap();
        assert_eq!(text, json!({"cwd":moved}).to_string() + "\n");
    }

    /// A project renamed to another case of its name is a rename, not a clash with itself, and Undo renames it back.
    #[test]
    fn a_project_renamed_to_another_case_moves_and_undo_brings_the_old_name_back() {
        let (_temp, root) = folder();
        if !folds(&root) {
            return;
        }
        let env = Env::for_home(root.join("home"));
        let project = env.home.join("project").join("Demo");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("package.json"), "{}").unwrap();
        config::save(&env, &json!({"roots":["~/project"],"presets":[]})).unwrap();
        let mut service = Service::new(env.clone());
        service.snapshot().unwrap();
        let renamed = env.home.join("project").join("demo");
        let names =
            || fs::read_dir(env.home.join("project")).unwrap().map(|e| e.unwrap().file_name()).collect::<Vec<_>>();
        let change = service.request("move", &json!({"id":project,"destination":renamed})).unwrap();
        assert_eq!(names(), ["demo"]);
        service.request("undo", &json!({"id":change["journal"]["id"]})).unwrap();
        assert_eq!(names(), ["Demo"]);
        assert!(project.join("package.json").is_file());
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use laci_core::{paths, platform};
    use std::{
        fs,
        io::Write,
        os::windows::process::CommandExt,
        path::{Path, PathBuf},
        process::Command,
        thread,
        time::Duration,
    };

    fn folder() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = path::canonical(temp.path()).unwrap();
        (temp, root)
    }

    /// The 8.3 short form of `path`, as cmd gives it. A volume that makes no short names gives the long one back.
    fn short(path: &Path) -> PathBuf {
        let out = Command::new("cmd")
            .raw_arg(format!(r#"/d /c for %I in ("{}") do @echo %~sI"#, path.display()))
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())
    }

    #[test]
    fn a_relative_path_with_a_root_or_a_drive_leaves_its_folder() {
        for raw in [r"\x", "/x", "C:x", r"C:\x", r"..\x", r"a\..\..\x", r"\\server\share\x"] {
            assert!(!path::stays_below(Path::new(raw)), "{raw}");
        }
        for raw in ["node_modules", r"web\node_modules", "web/dist"] {
            assert!(path::stays_below(Path::new(raw)), "{raw}");
        }
    }

    /// Joined to a folder, `\x` starts over at the drive's root and `C:x` on drive C, so Laci's own folders refuse
    /// them as names below them. These checks come before Laci asks which programs use a folder.
    #[test]
    fn names_with_a_root_or_a_drive_never_lead_out_of_laci_folders() {
        let (_temp, root) = folder();
        let env = Env::for_home(root.join("home"));
        let store = env.home.join("store");
        fs::create_dir_all(&store).unwrap();
        for to in [r"\x", "C:x"] {
            let action = json!({"type":"quarantine","moves":[{"from":store,"to":to}]});
            let error = laci_core::ops::apply_action(&env, &json!({}), "Clean up", &action).unwrap_err();
            assert_eq!(error, "Bad quarantine path", "{to}");
        }
        let snap = json!({"connectors":[{"id":"C:x","link":{"kind":"cwd","dir":store}}]});
        assert_eq!(laci_core::ops::backup_history(&env, &snap).unwrap_err(), "Invalid connector id");
        let session = store.join("session.jsonl");
        let snap = json!({
            "connectors":[{"id":"C:x","link":{"kind":"cwd","dir":store}}],
            "sessions":[{"file":session,"provider":"codex","connector":"C:x","title":"Old"}],
        });
        let files = [session.to_string_lossy().into_owned()];
        assert_eq!(laci_core::ops::delete_sessions(&env, &snap, &files).unwrap_err(), "Unknown agent");
        assert!(store.is_dir());
    }

    #[test]
    fn canonical_paths_have_no_verbatim_prefix_and_long_names() {
        let (_temp, root) = folder();
        assert!(!root.to_string_lossy().starts_with(r"\\?\"), "{}", root.display());
        let long = root.join("A folder with a long name");
        fs::create_dir(&long).unwrap();
        let short = short(&long);
        assert_eq!(path::canonical(&short).unwrap(), long, "{}", short.display());
    }

    #[test]
    fn a_drive_letter_in_either_case_names_the_same_place() {
        let (_temp, root) = folder();
        let text = root.to_string_lossy();
        let lower = PathBuf::from(format!("{}{}", text[..1].to_lowercase(), &text[1..]));
        assert_ne!(lower.as_os_str(), root.as_os_str());
        assert!(path::same_path(&root, &lower));
        assert!(path::contains(&root, &lower.join("new")));
        assert!(path::contains(&lower, &root.join("new")));
        assert_eq!(paths::tilde(&lower.join("x"), &root), r"~/x");
        assert_eq!(paths::tilde(&root.join("x").join("y"), &root), "~/x/y", "as config.json keeps it on every OS");
        assert_eq!(paths::expand(r"~\x\y", &root), root.join("x").join("y"));
        assert_eq!(paths::expand("~/x/y", &root), root.join("x").join("y"));
    }

    #[test]
    fn a_verbatim_spelling_names_the_same_place() {
        let (_temp, root) = folder();
        let verbatim = PathBuf::from(format!(r"\\?\{}", root.display()));
        assert!(path::same_path(&root, &verbatim));
        assert!(path::contains(&verbatim, &root.join("x")));
        assert!(path::contains(&root, &verbatim.join("x")));
        assert!(!path::contains(&root.join("x"), &verbatim));
    }

    /// With `\\?\` Windows reads a name as written; without, it drops a trailing dot first. So `\\?\…\x.` is a folder
    /// of its own, which the plain spelling `…\x.` never reaches.
    #[test]
    fn a_verbatim_name_with_a_trailing_dot_is_another_folder() {
        let (_temp, root) = folder();
        let verbatim = |path: &Path| PathBuf::from(format!(r"\\?\{}", path.display()));
        let dotted = root.join("x.");
        fs::create_dir(verbatim(&dotted)).unwrap();
        fs::create_dir(root.join("x")).unwrap();
        assert!(!path::same_path(&verbatim(&dotted), &dotted));
        assert!(!path::contains(&verbatim(&dotted), &dotted.join("y")));
        assert!(path::same_path(&verbatim(&dotted), &verbatim(&dotted)));
        assert!(path::same_path(&verbatim(&root.join("x")), &root.join("x")));
    }

    #[test]
    fn an_8_3_short_name_names_the_same_folder() {
        let (_temp, root) = folder();
        let long = root.join("A folder with a long name");
        fs::create_dir_all(long.join("src")).unwrap();
        let short = short(&long);
        if short == long {
            eprintln!("This volume makes no 8.3 names; nothing to compare.");
            return;
        }
        assert!(path::same_path(&long, &short), "{}", short.display());
        assert!(path::contains(&long, &short.join("src")));
        assert!(path::contains(&short, &long.join("src")));
        assert!(path::may_contain(&long, &short.join("new")));
        assert_eq!(path::below(&long, &short.join("src")), Some(PathBuf::from("src")));
        // Another folder whose short name could look alike is still another folder.
        let beside = root.join("A folder with a long name too");
        fs::create_dir(&beside).unwrap();
        assert!(!path::same_path(&beside, &short));
    }

    /// A name with `~` could be the short name of another, so there Laci asks the file system whether both lead to the
    /// same file. A link is asked about itself, a symlink or a junction alike, so it is never the folder it leads to.
    #[test]
    fn a_link_named_like_a_short_name_is_not_the_folder_it_leads_to() {
        let (_temp, root) = folder();
        let real = root.join("A folder with a long name");
        fs::create_dir(&real).unwrap();
        let (link, junction) = (root.join("LINK~1"), root.join("JUNCTI~1"));
        support::link_dir(&real, &link);
        support::junction(&real, &junction);
        // The folder by its long name, and by its short one where the volume makes them.
        for real in [real.clone(), short(&real)] {
            for link in [&link, &junction] {
                let what = format!("{} / {}", real.display(), link.display());
                assert!(!path::same_path(&real, link), "{what}");
                assert!(!path::same_path(link, &real), "{what}");
                assert!(!path::contains(&real, &link.join("src")), "{what}");
                assert!(path::may_contain(&real, &link.join("src")), "a refusal follows it: {what}");
            }
        }
    }

    /// Per-folder case sensitivity needs the Windows Subsystem for Linux's support; without it there is nothing to try.
    #[test]
    fn a_case_sensitive_folder_keeps_names_apart() {
        let (_temp, root) = folder();
        let dir = root.join("cs");
        fs::create_dir(&dir).unwrap();
        let set =
            Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&dir).arg("enable").output().unwrap();
        if !set.status.success() {
            eprintln!("No case-sensitive folders here: {}", String::from_utf8_lossy(&set.stdout).trim());
            return;
        }
        let (upper, lower) = (dir.join("Foo"), dir.join("foo"));
        fs::create_dir(&upper).unwrap();
        assert!(!path::contains(&upper, &lower.join("x")), "foo is not there yet");
        assert!(!path::renames_case(&upper, &lower));
        let claude = paths::enc(&lower.to_string_lossy());
        assert_eq!(laci_core::agents::resolve_encoded(&Env::for_home(dir.clone()), &claude), None, "history of foo");
        fs::create_dir(&lower).unwrap();
        assert!(!path::same_path(&upper, &lower));
        assert!(!path::contains(&upper, &lower.join("x")));
        assert!(path::may_contain(&upper, &lower.join("x")), "a refusal still counts it");
        assert!(!path::renames_case(&upper, &lower));
        // Two names for one file, in two cases, are still two names.
        fs::write(dir.join("Note"), "x").unwrap();
        fs::hard_link(dir.join("Note"), dir.join("note")).unwrap();
        assert!(!path::renames_case(&dir.join("Note"), &dir.join("note")));
    }

    #[test]
    fn a_change_stamp_moves_when_a_file_is_written_or_replaced() {
        let (_temp, root) = folder();
        let log = root.join("log.jsonl");
        fs::write(&log, "{}\n").unwrap();
        let stamp = |p: &Path| platform::change_stamp(p, &fs::metadata(p).unwrap()).unwrap();
        let before = stamp(&log);
        assert_eq!(before.identity, platform::identity(&log, &fs::metadata(&log).unwrap()).unwrap());
        let file = fs::File::open(&log).unwrap();
        assert_eq!(platform::file_change_stamp(&file, &file.metadata().unwrap()).unwrap(), before, "open or not");
        drop(file);
        let mut written = before;
        for _ in 0..100 {
            fs::OpenOptions::new().append(true).open(&log).unwrap().write_all(b"{}\n").unwrap();
            written = stamp(&log);
            if written.changed != before.changed {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_ne!(written.changed, before.changed, "a write moves the change time");
        assert_eq!(written.identity, before.identity, "still the same file");
        let replacement = root.join("new");
        fs::write(&replacement, "{}\n").unwrap();
        fs::rename(&replacement, &log).unwrap();
        assert_ne!(stamp(&log).identity, before.identity, "another file in its place");
        // A folder has a stamp too, which takes FILE_FLAG_BACKUP_SEMANTICS to open.
        let dir = root.join("history");
        fs::create_dir(&dir).unwrap();
        assert_eq!(stamp(&dir).identity, platform::identity(&dir, &fs::metadata(&dir).unwrap()).unwrap());
        // The time is the one std reads too, in seconds since 1970.
        let modified = fs::metadata(&log).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap();
        assert_eq!(stamp(&log).modified, (modified.as_secs() as i64, i64::from(modified.subsec_nanos())));
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
    };

    #[test]
    fn the_system_links_at_the_top_are_trusted_and_others_are_not() {
        for top in ["/var", "/tmp", "/etc"] {
            let below = Path::new(top).join("laci-paths-test/notes.md");
            path::plain_path(&below).unwrap();
            let private = Path::new("/private").join(below.strip_prefix("/").unwrap());
            assert!(path::same_path(&below, &private), "{}", below.display());
            assert!(path::contains(Path::new(top), &private));
            assert!(path::contains(&Path::new("/private").join(&top[1..]), &below));
        }
        assert!(!path::same_path(Path::new("/var/x"), Path::new("/private/tmp/x")));
        let temp = tempfile::tempdir().unwrap();
        let root = path::canonical(temp.path()).unwrap();
        fs::create_dir(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        assert!(path::plain_path(&root.join("link/notes.md")).is_err(), "a link of the user's own");
    }

    /// The default temporary folder is below /var. Laci works there as anywhere else.
    #[test]
    fn a_home_below_var_is_writable_and_its_canonical_spelling_is_home_too() {
        let temp = tempfile::tempdir_in("/var/tmp").unwrap();
        let env = Env::for_home(temp.path().join("home"));
        fs::create_dir_all(&env.home).unwrap();
        // The change lock is written only through a path without links of the user's own.
        laci_core::ops::with_lock(&env, || Ok(())).unwrap();
        let picked = laci_core::paths::selected_directory(&env.home.to_string_lossy(), &env).unwrap();
        assert!(picked.starts_with("/private/var"), "{}", picked.display());
        assert!(laci_core::paths::workspace_path(&picked.join("x").to_string_lossy(), &env).is_ok());
        assert!(laci_core::paths::workspace_path(&env.home.join("x").to_string_lossy(), &env).is_ok());
    }

    /// A volume formatted case-sensitive, mounted from a disk image.
    struct Volume {
        mount: PathBuf,
        _temp: tempfile::TempDir,
    }
    impl Volume {
        fn case_sensitive() -> Option<Self> {
            let temp = tempfile::tempdir().unwrap();
            let (image, mount) = (temp.path().join("cs.dmg"), temp.path().join("mount"));
            let made = Command::new("hdiutil")
                .args(["create", "-quiet", "-size", "16m", "-fs", "Case-sensitive APFS", "-volname", "LaciCS"])
                .arg(&image)
                .status()
                .ok()?;
            fs::create_dir(&mount).unwrap();
            let attached = made.success()
                && Command::new("hdiutil")
                    .args(["attach", "-quiet", "-nobrowse", "-mountpoint"])
                    .arg(&mount)
                    .arg(&image)
                    .status()
                    .is_ok_and(|s| s.success());
            attached.then(|| Self { mount: path::canonical(&mount).unwrap(), _temp: temp })
        }
    }
    impl Drop for Volume {
        fn drop(&mut self) {
            let _ = Command::new("hdiutil").args(["detach", "-quiet", "-force"]).arg(&self.mount).status();
        }
    }

    #[test]
    fn a_case_sensitive_volume_keeps_names_apart() {
        let Some(volume) = Volume::case_sensitive() else {
            eprintln!("No disk image could be mounted here; nothing to try.");
            return;
        };
        let (upper, lower) = (volume.mount.join("Foo"), volume.mount.join("foo"));
        fs::create_dir(&upper).unwrap();
        assert!(!path::contains(&upper, &lower.join("x")), "foo is not there");
        assert!(!path::renames_case(&upper, &lower));
        let claude = laci_core::paths::enc(&lower.to_string_lossy());
        let env = Env::for_home(volume.mount.clone());
        assert_eq!(laci_core::agents::resolve_encoded(&env, &claude), None, "history of foo");
        fs::create_dir(&lower).unwrap();
        assert!(!path::same_path(&upper, &lower));
        assert!(!path::contains(&upper, &lower.join("x")));
        assert!(path::may_contain(&upper, &lower.join("x")), "a refusal still counts it");
        // Two names for one file, in two cases, are still two names.
        fs::write(volume.mount.join("Note"), "x").unwrap();
        fs::hard_link(volume.mount.join("Note"), volume.mount.join("note")).unwrap();
        assert!(!path::renames_case(&volume.mount.join("Note"), &volume.mount.join("note")));
    }
}
