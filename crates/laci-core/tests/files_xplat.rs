//! Files on each OS: what a move, a copy and Undo keep, names Windows keeps for itself, what the listing hides and a
//! scan skips, files that are only online, links Laci doesn't read through, and what the move's preview warns about.
use laci_core::{create, env::Env, files, ops, paths, platform, scan, service::Service};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime},
};

mod support;

/// A home in a fresh temporary folder, spelled as the file system spells it: on Windows the temporary folder's path
/// can come with 8.3 short names.
fn home() -> (tempfile::TempDir, Env) {
    let temp = tempfile::tempdir().unwrap();
    let home = platform::path::canonical(temp.path()).unwrap().join("home");
    fs::create_dir(&home).unwrap();
    (temp, Env::for_home(home))
}
fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// When the files [`age`] touches last changed.
const THEN: Duration = Duration::from_secs(1_600_000_000);

/// Gives the file or folder `path` an old modification time, as a file that has been there a while.
fn age(path: &Path) {
    let mut options = fs::OpenOptions::new();
    #[cfg(unix)]
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_WRITE_ATTRIBUTES, and FILE_FLAG_BACKUP_SEMANTICS, without which a folder doesn't open.
        options.access_mode(0x100).custom_flags(0x0200_0000);
    }
    let at = SystemTime::UNIX_EPOCH + THEN;
    options.open(path).unwrap().set_times(fs::FileTimes::new().set_modified(at).set_accessed(at)).unwrap();
}
fn modified(path: &Path) -> SystemTime {
    fs::metadata(path).unwrap().modified().unwrap()
}
fn read_only(path: &Path) -> bool {
    fs::metadata(path).unwrap().permissions().readonly()
}
fn make_read_only(path: &Path) {
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).unwrap();
}
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn run(command: &mut Command) {
    let output = command.output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}
/// Marks `path` hidden as the system's file manager does: Windows' hidden attribute, macOS's `hidden` flag. Linux
/// has no such mark.
fn mark_hidden(path: &Path) {
    #[cfg(windows)]
    run(Command::new("attrib").arg("+H").arg(path));
    #[cfg(target_os = "macos")]
    run(Command::new("chflags").arg("hidden").arg(path));
    #[cfg(target_os = "linux")]
    let _ = path;
}
/// A scan that knows only the project at `path`, as `demo`.
fn snapshot(env: &Env, path: &Path) -> Value {
    json!({"roots":[env.home.join("project")],"nodes":{"demo":{"name":"demo","path":path,"kind":"project"}},"claude":{},"items":{},"connectors":[]})
}

/// Moving a project rewrites the paths in its Claude Code log and keeps the log's time and its read-only flag. Undo
/// puts back the very bytes and times, the project's folders included. On Windows a rewrite failed before, so Undo
/// had nothing to put back.
#[test]
fn undo_puts_back_the_bytes_and_times_of_a_rewritten_log_even_a_read_only_one() {
    let (_temp, env) = home();
    // One name at a time: on Windows a `/` given to join stays in the text, and the log holds the path as Laci spells it.
    let from = env.home.join("project").join("demo");
    let to = env.home.join("project").join("_archive").join("demo");
    write(&from.join("docs").join("README.md"), "# demo\n");
    age(&from.join("docs").join("README.md"));
    age(&from.join("docs"));
    let store = env.home.join(".claude/projects").join(paths::enc(&from.to_string_lossy()));
    let log = store.join("session.jsonl");
    let original = format!("{{\"cwd\":{}}}\n", json!(from));
    write(&log, &original);
    age(&log);
    make_read_only(&log);
    let mut known = snapshot(&env, &from);
    known["claude"] = json!({"old":{"dir":store,"path":from,"gone":[],"sessions":[{"cwd":from}]}});

    let journal = ops::move_project(&env, &known, "demo", to.to_str().unwrap(), &json!({})).unwrap();
    let moved = env.home.join(".claude/projects").join(paths::enc(&to.to_string_lossy())).join("session.jsonl");
    assert_eq!(fs::read_to_string(&moved).unwrap(), format!("{{\"cwd\":{}}}\n", json!(to)));
    assert_eq!(modified(&moved), SystemTime::UNIX_EPOCH + THEN);
    assert!(read_only(&moved));

    ops::undo(&env, journal["id"].as_str().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(&log).unwrap(), original);
    assert_eq!(modified(&log), SystemTime::UNIX_EPOCH + THEN);
    assert!(read_only(&log));
    for path in ["docs/README.md", "docs"] {
        assert_eq!(modified(&from.join(path)), SystemTime::UNIX_EPOCH + THEN, "{path}");
    }
}

/// A copy keeps the times of folders and files, and a read-only file stays read-only: a project made from a template
/// is copied the way a move to another drive copies a project.
#[test]
fn a_copy_keeps_the_times_of_folders_and_files_and_read_only_files() {
    let (_temp, env) = home();
    let template = env.config_dir.join("templates/docs");
    write(&template.join("notes/plan.md"), "# Plan\n");
    write(&template.join("LICENSE"), "MIT\n");
    for path in ["notes/plan.md", "notes", "LICENSE"] {
        age(&template.join(path));
    }
    make_read_only(&template.join("LICENSE"));
    let parent = env.home.join("project");
    fs::create_dir(&parent).unwrap();
    let made = create::create_project(
        &env,
        &json!({"name":"docs","parent":parent,"from":"template","template":"docs","remote":"none"}),
    )
    .unwrap();
    let dir = Path::new(made["path"].as_str().unwrap());
    for path in ["notes/plan.md", "notes", "LICENSE"] {
        assert_eq!(modified(&dir.join(path)), SystemTime::UNIX_EPOCH + THEN, "{path}");
    }
    assert!(read_only(&dir.join("LICENSE")));
    assert!(!read_only(&dir.join("notes/plan.md")));
}

/// Windows keeps CON, PRN, AUX, NUL, COM1–9 and LPT1–9 for devices, also with an extension, and drops a dot at the
/// end of a name, so a project can't be called that there. Elsewhere these are names like any other.
#[test]
fn names_windows_keeps_for_itself_are_refused_there() {
    let (_temp, env) = home();
    let parent = env.home.join("project");
    fs::create_dir(&parent).unwrap();
    // A place to push it that doesn't exist is refused after the name, before anything is made.
    let error = |name: &str| {
        create::create_project(&env, &json!({"name":name,"parent":parent,"from":"empty","remote":"nowhere"}))
            .unwrap_err()
    };
    for name in ["CON", "nul.txt", "Aux", "prn.tar.gz", "COM1", "lpt9.md", "demo."] {
        if cfg!(windows) {
            assert!(error(name).contains("Windows"), "{name}: {}", error(name));
        } else {
            assert_eq!(error(name), "Pick where to push it", "{name}");
        }
    }
    for name in ["console", "COM10", "com0", "lpt", "nullable", "aux-tools"] {
        assert_eq!(error(name), "Pick where to push it", "{name}");
    }
}

/// The listing says what a file manager hides: a dotted name on every OS, and what the system marks hidden. Only a
/// link is followed, and only into home or a chosen folder.
#[test]
fn the_listing_says_which_files_are_hidden_and_follows_only_links_that_stay_inside() {
    let (temp, env) = home();
    for name in [".env", "marked", "plain"] {
        write(&env.home.join(name), "x");
    }
    mark_hidden(&env.home.join("marked"));
    fs::create_dir(env.home.join("inside")).unwrap();
    support::link_dir(&env.home.join("inside"), &env.home.join("to-inside"));
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    support::link_dir(&outside, &env.home.join("to-outside"));

    let listing = Service::new(env.clone()).request("ls", &json!({"path":env.home})).unwrap();
    let entry = |name: &str| {
        listing["entries"].as_array().unwrap().iter().find(|e| e["name"] == name).unwrap_or_else(|| panic!("{name}"))
    };
    assert_eq!(entry(".env")["hidden"], true);
    assert_eq!(entry("marked")["hidden"], cfg!(any(target_os = "macos", windows)));
    assert_eq!(entry("plain")["hidden"], false);
    for (name, dir, link) in [("inside", true, false), ("to-inside", true, true), ("to-outside", false, true)] {
        assert_eq!((entry(name)["dir"].as_bool(), entry(name)["link"].as_bool()), (Some(dir), Some(link)), "{name}");
    }
    assert_eq!(entry("plain")["size"], 1);
    assert!(entry("plain")["at"].as_str().is_some_and(|at| !at.is_empty()));
}

/// A project's README, package.json and the like are read, but not a file whose content is only online, as OneDrive
/// and iCloud leave files: reading it would download it. Windows' offline attribute stands in for such a file here;
/// iCloud's mark can't be set by hand.
#[test]
fn a_file_that_is_only_online_is_not_read() {
    let (_temp, env) = home();
    let file = env.home.join("README.md");
    write(&file, "# demo\n");
    assert_eq!(files::text(&file).as_deref(), Some("# demo\n"));
    #[cfg(windows)]
    {
        run(Command::new("attrib").arg("+O").arg(&file));
        assert_eq!(files::text(&file), None);
    }
}

/// A repository a sync app keeps only online is listed, but Git isn't run in it: Git would download its history, and
/// its work tree with it. Here one repository's index is only online, and in another the pack that holds its history.
/// What wasn't read isn't taken for finished work: a check says so, and old files don't get it offered for archiving.
/// Nor does a scan read a report kept only online. Windows' offline attribute stands in for such files; elsewhere all
/// are read as before.
#[test]
fn a_scan_reads_no_repository_or_report_kept_only_online() {
    fn codes(list: &Value) -> Vec<&str> {
        list.as_array().into_iter().flatten().filter_map(|item| item["code"].as_str()).collect()
    }
    let (_temp, env) = home();
    let (indexed, packed) = (env.home.join("project").join("demo"), env.home.join("project").join("packed"));
    let commit = ["-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "-m", "first"];
    // Committed long ago, as the files were last changed: a project left alone.
    let then = format!("@{} +0000", THEN.as_secs());
    for repo in [&indexed, &packed] {
        write(&repo.join("package.json"), "{}\n");
        for args in [&["init", "-q"][..], &["add", "."], &commit, &["repack", "-a", "-d", "-q"]] {
            run(Command::new("git")
                .args(args)
                .current_dir(repo)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_DATE", &then)
                .env("GIT_COMMITTER_DATE", &then));
        }
        age(&repo.join("package.json"));
    }
    let reports = env.home.join("reports");
    write(&reports.join("2026-10-19-demo.md"), "# Demo work\n\n## Open\n- Ship it\n");
    let settings = json!({"roots":["~/project"],"reportsDir":reports,"presets":[],"custom":[],"apps":{}});
    laci_core::config::save(&env, &settings).unwrap();
    let online = cfg!(windows);
    #[cfg(windows)]
    {
        let packs: Vec<PathBuf> = fs::read_dir(packed.join(".git").join("objects").join("pack"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "pack"))
            .collect();
        assert!(!packs.is_empty());
        for file in [indexed.join(".git").join("index"), reports.join("2026-10-19-demo.md")].into_iter().chain(packs) {
            run(Command::new("attrib").arg("+O").arg(file));
        }
    }
    let snapshot = Service::new(env.clone()).snapshot().unwrap();
    let offered: Vec<&str> =
        snapshot["proposals"].as_array().into_iter().flatten().filter_map(|p| p["id"].as_str()).collect();
    for repo in [&indexed, &packed] {
        let node = &snapshot["nodes"][repo.to_str().unwrap()];
        assert_eq!(node["kind"], "project", "{node}");
        assert_eq!(node["git"].is_object(), !online, "{node}");
        assert_eq!(node["onlineOnly"] == true, online, "{node}");
        let issues = codes(&node["issues"]);
        assert!(!issues.contains(&"no-git"), "{issues:?}");
        assert_eq!(issues.contains(&"online-only"), online, "{issues:?}");
        assert_eq!(node["status"]["value"], "dormant", "{node}");
        let plan = &node["archivePlan"];
        assert!(plan["dest"].is_string(), "{plan}");
        let checks = codes(&plan["checks"]);
        assert_eq!(checks.contains(&"online-only"), online, "{checks:?}");
        let archive = format!("archive:{}", repo.to_str().unwrap());
        assert_eq!(offered.contains(&archive.as_str()), !online, "{offered:?}");
    }
    let report = &snapshot["reports"][0];
    assert_eq!(report["title"], if online { "Demo" } else { "Demo work" }, "{report}");
    assert_eq!(report["open"], if online { json!([]) } else { json!(["Ship it"]) }, "{report}");
    assert_eq!(report["onlineOnly"] == true, online, "{report}");
}

/// Laci's own settings are read even when a sync app keeps config.json only online: read as empty, they would be
/// replaced by the next save.
#[test]
fn settings_kept_only_online_are_still_read() {
    let (_temp, env) = home();
    fs::create_dir_all(&env.config_dir).unwrap();
    let file = env.config_dir.join("config.json");
    write(&file, r#"{"roots":["~/projects"],"theme":"dark"}"#);
    #[cfg(windows)]
    run(Command::new("attrib").arg("+O").arg(&file));
    let config = laci_core::config::load(&env);
    assert_eq!(config["theme"], "dark");
    assert_eq!(config["roots"][0], "~/projects");
}

/// Settings that are there but can't be read as settings were loaded as defaults, as when the app that syncs
/// config.json can't download it, or an edit left it broken. A save would put those defaults in their place, so it is
/// refused until the file reads again.
#[test]
fn settings_that_cannot_be_read_are_never_written_over() {
    let (_temp, env) = home();
    let file = env.config_dir.join("config.json");
    let template = env.home.join("starter");
    fs::create_dir(&template).unwrap();
    let broken = r#"{"roots":["~/projects"],"theme":"dark""#;
    write(&file, broken);
    assert!(laci_core::config::load(&env)["roots"].is_null(), "read as defaults");
    let error = create::add_template(&env, template.to_str().unwrap()).unwrap_err();
    assert!(error.starts_with("Laci couldn't read your settings in ~/.config/laci/config.json"), "{error}");
    assert_eq!(fs::read_to_string(&file).unwrap(), broken);
    // A file this user may not read, which is what an unreachable cloud file is to Laci. Not to root, though.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let whole = r#"{"roots":["~/projects"],"theme":"dark"}"#;
        write(&file, whole);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&file).is_err() {
            assert!(create::add_template(&env, template.to_str().unwrap()).is_err());
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(fs::read_to_string(&file).unwrap(), whole);
        } else {
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    write(&file, r#"{"roots":["~/projects"],"theme":"dark"}"#);
    create::add_template(&env, template.to_str().unwrap()).unwrap();
    let config = laci_core::config::load(&env);
    assert_eq!((config["theme"].as_str(), config["roots"][0].as_str()), (Some("dark"), Some("~/projects")));
    assert_eq!(config["templatePaths"][0], json!(template));
    // An empty file holds nothing to lose.
    write(&file, "");
    create::add_template(&env, template.to_str().unwrap()).unwrap();
    assert_eq!(laci_core::config::load(&env)["templatePaths"][0], json!(template));
}

/// A report is read without following a link put in its place, on Windows too.
#[test]
fn a_link_in_place_of_a_report_is_not_read() {
    let (temp, env) = home();
    let secret = temp.path().join("secret.md");
    write(&secret, "secret\n");
    let report = env.home.join("reports/2026-10-19-demo.md");
    fs::create_dir_all(report.parent().unwrap()).unwrap();
    support::link_file(&secret, &report);
    assert_eq!(files::text_nofollow(&report, 1000), None);
    assert_eq!(files::text_nofollow(&secret, 1000).as_deref(), Some("secret\n"));
}

/// The scan names the computer: on Linux from /etc/hostname, as Laci v1 did, elsewhere as the system names it.
#[test]
fn the_scan_names_the_computer() {
    let (_temp, env) = home();
    let host = Service::new(env).snapshot().unwrap()["host"].as_str().unwrap().to_owned();
    if cfg!(target_os = "linux") {
        let named = fs::read_to_string("/etc/hostname").map(|name| name.trim().to_owned());
        assert_eq!(host, named.unwrap_or_else(|_| "localhost".into()));
    } else {
        assert!(!host.is_empty() && host != "localhost", "{host}");
    }
}

/// Folder suggestions look for projects in the home folder, but not inside what the system and apps keep there,
/// which on macOS would also ask for access to other apps' data.
#[test]
fn folder_suggestions_skip_the_system_folders() {
    let (_temp, env) = home();
    let names = ["Projects", "Library", "AppData", "Tools.app", "$Recycle.Bin", "Marked"];
    for name in names {
        fs::create_dir_all(env.home.join(name).join("demo/.git")).unwrap();
    }
    mark_hidden(&env.home.join("Marked"));
    let found = Service::new(env.clone()).request("setup/discover", &json!({})).unwrap();
    let suggested: Vec<PathBuf> =
        found["candidates"].as_array().unwrap().iter().map(|c| PathBuf::from(c["path"].as_str().unwrap())).collect();
    let skipped: &[&str] = if cfg!(target_os = "macos") {
        &["Library", "Tools.app", "Marked"]
    } else if cfg!(windows) {
        &["AppData", "$Recycle.Bin", "Marked"]
    } else {
        &[]
    };
    for name in names {
        let shown = suggested.iter().any(|path| path.file_name().is_some_and(|n| n == name));
        assert_eq!(shown, !skipped.contains(&name), "{name}: {suggested:?}");
    }
}

/// A scan of home looks for projects in what a file manager shows, not in what the system and apps keep there, such
/// as ~/Library and apps on macOS and AppData on Windows: on macOS, looking inside would also ask for access to other
/// apps' data. Deeper down those names are the user's own, as a course's library exercise or a site named after its
/// domain. On Linux only a dotted name is hidden, and every other folder is looked in as before.
#[test]
fn a_scan_of_home_skips_hidden_and_system_folders() {
    let (_temp, env) = home();
    let names = ["Projects", "Library", "AppData", "Tools.app", "$Recycle.Bin", "Marked", ".hidden"];
    for name in names {
        fs::create_dir_all(env.home.join(name).join("demo").join(".git")).unwrap();
    }
    mark_hidden(&env.home.join("Marked"));
    let deeper = ["library", "shop.app", "Photos.photoslibrary", "AppData", "$Recycle.Bin"];
    for name in deeper {
        fs::create_dir_all(env.home.join("Projects").join(name).join(".git")).unwrap();
    }
    laci_core::config::save(&env, &json!({"roots":["~"],"presets":[],"custom":[],"apps":{}})).unwrap();
    let snapshot = Service::new(env.clone()).snapshot().unwrap();
    let skipped: &[&str] = if cfg!(target_os = "macos") {
        &["Library", "Tools.app", "Marked", ".hidden"]
    } else if cfg!(windows) {
        &["AppData", "$Recycle.Bin", "Marked", ".hidden"]
    } else {
        &[".hidden"]
    };
    for name in names {
        let found = snapshot["nodes"].get(env.home.join(name).join("demo").to_str().unwrap()).is_some();
        assert_eq!(found, !skipped.contains(&name), "{name}");
    }
    for name in deeper {
        let found = snapshot["nodes"].get(env.home.join("Projects").join(name).to_str().unwrap()).is_some();
        assert!(found, "Projects/{name}");
    }
}

/// pnpm and npm workspaces fill node_modules with links. On Windows they are junctions, which hold the full path of
/// where they lead, so the move's preview says to reinstall; elsewhere the links lead there by a relative path.
#[test]
fn the_move_preview_says_when_links_in_node_modules_keep_leading_to_the_old_place() {
    let (_temp, env) = home();
    let reinstall = |ops: &[Value]| {
        ops.iter().any(|op| op["kind"] == "keep" && op["label"] == "Reinstall dependencies after the move")
    };
    let linked = env.home.join("project/linked");
    let package = linked.join("node_modules/.pnpm/@types+node@24.0.0/node_modules/@types/node");
    fs::create_dir_all(&package).unwrap();
    fs::create_dir_all(linked.join("node_modules/@types")).unwrap();
    support::link_dir(&package, &linked.join("node_modules/@types/node"));
    let ops = scan::move_ops(&env, &linked, &env.home.join("archive/linked"), &json!({}));
    assert_eq!(reinstall(&ops), cfg!(windows), "{ops:?}");

    let plain = env.home.join("project/plain");
    fs::create_dir_all(plain.join("node_modules/left-pad")).unwrap();
    let ops = scan::move_ops(&env, &plain, &env.home.join("archive/plain"), &json!({}));
    assert!(!reinstall(&ops), "{ops:?}");
}

/// What a run of this test binary started by [`onedrive_preview`] prints before the preview it made.
#[cfg(windows)]
const PREVIEW: &str = "laci-preview: ";

/// The preview of a move from `from` to `to` while OneDrive's folder is `onedrive`. It is made in a run of its own of
/// the test that asks: a process reads its environment once.
#[cfg(windows)]
fn onedrive_preview(onedrive: &Path, from: &Path, to: &Path) -> Vec<String> {
    let test = "the_move_preview_says_when_a_folder_leaves_or_goes_into_onedrive";
    let output = support::program(test, "preview")
        .env("OneDrive", onedrive)
        .env_remove("OneDriveConsumer")
        .env_remove("OneDriveCommercial")
        .env("LACI_TEST_FROM", from)
        .env("LACI_TEST_TO", to)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    let ops = stdout.lines().find_map(|line| Some(line.split_once(PREVIEW)?.1)).unwrap_or_else(|| panic!("{stdout}"));
    let ops: Vec<Value> = serde_json::from_str(ops).unwrap();
    ops.iter().filter_map(|op| op["label"].as_str().map(str::to_owned)).collect()
}

/// Moving a folder out of OneDrive downloads what is only online first, and moving one in uploads it.
#[cfg(windows)]
#[test]
fn the_move_preview_says_when_a_folder_leaves_or_goes_into_onedrive() {
    if support::role().as_deref() == Some("preview") {
        let path = |key: &str| PathBuf::from(std::env::var_os(key).unwrap());
        let env = Env::for_home(std::env::temp_dir());
        println!(
            "{PREVIEW}{}",
            json!(scan::move_ops(&env, &path("LACI_TEST_FROM"), &path("LACI_TEST_TO"), &json!({})))
        );
        return;
    }
    let (_temp, env) = home();
    let onedrive = env.home.join("OneDrive");
    let out = onedrive_preview(&onedrive, &onedrive.join("demo"), &env.home.join("demo"));
    assert!(out.iter().any(|label| label == "Leaves OneDrive"), "{out:?}");
    let into = onedrive_preview(&onedrive, &env.home.join("demo"), &onedrive.join("demo"));
    assert!(into.iter().any(|label| label == "Goes into OneDrive"), "{into:?}");
    let within = onedrive_preview(&onedrive, &onedrive.join("a"), &onedrive.join("b"));
    assert!(!within.iter().any(|label| label.contains("OneDrive")), "{within:?}");
}

/// Antivirus scans, Search and OneDrive hold files for a moment, and a move waits for them instead of failing. A
/// program that keeps a file open makes the move fail with a message that says what to do, and nothing moves.
#[cfg(windows)]
#[test]
fn a_move_waits_a_moment_for_a_program_that_holds_a_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_temp, env) = home();
    let from = env.home.join("project/demo");
    let to = env.home.join("project/_archive/demo");
    write(&from.join("README.md"), "# demo\n");
    // Opened without sharing, as a program that keeps others out does.
    let hold = |path: &Path| fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap();

    let held = hold(&from.join("README.md"));
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        drop(held);
    });
    ops::move_project(&env, &snapshot(&env, &from), "demo", to.to_str().unwrap(), &json!({})).unwrap();
    release.join().unwrap();
    assert!(to.join("README.md").is_file());

    let held = hold(&to.join("README.md"));
    let error = ops::move_project(&env, &snapshot(&env, &to), "demo", from.to_str().unwrap(), &json!({})).unwrap_err();
    drop(held);
    assert!(error.contains("open in another program"), "{error}");
    assert!(to.join("README.md").is_file() && !from.exists());
}
