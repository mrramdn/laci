//! Laci's command line. Without a command, `laci` opens the window.
mod mcp;

use clap::{Parser, Subcommand};
use laci_core::{
    config,
    env::Env,
    paths, scan,
    service::{self, Service, array, string},
};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    path::Path,
};

#[derive(Parser)]
#[command(version, about = "Projects, agent history and safe moves")]
struct Cli {
    #[command(subcommand)]
    command: Option<Action>,
}
#[derive(Subcommand)]
enum Action {
    Ls,
    Doctor,
    Json,
    Mcp,
    /// Copy new and changed AI chats into Laci's copy of them, as "Back up now" does, without the window
    Backup,
    /// Show where Laci looks for projects and keeps the archive, the copy of AI chats and reports, or change one
    Settings {
        #[command(subcommand)]
        change: Option<Setting>,
    },
}
/// A folder `laci settings` changes as Settings in the window does: the same checks, Log entry and Undo.
#[derive(Subcommand)]
enum Setting {
    /// Keep archived projects in DIR ("" for an _archive folder beside each scan location)
    Archive { dir: String },
    /// Move the copy of AI chats to DIR, an empty folder or one that holds a copy Laci made ("" for Laci's own folder)
    Copy {
        dir: String,
        /// Start a new copy in DIR when the one kept now can't be reached, as on a drive that isn't connected
        #[arg(long)]
        fresh: bool,
    },
    /// Read the reports agents write from DIR ("" for none)
    Reports { dir: String },
}

/// Does what the command line asks, opening the window with `open` without a command, and exits with 1 after saying
/// why when that fails.
pub fn main(open: fn(Env) -> laci_core::Result<()>) {
    let cli = Cli::parse();
    if let Err(error) = run(cli.command, open) {
        eprintln!("laci: {error}");
        std::process::exit(1);
    }
}

fn run(action: Option<Action>, open: fn(Env) -> laci_core::Result<()>) -> laci_core::Result<()> {
    match action {
        None => open(Env::from_process()?),
        Some(Action::Mcp) => mcp::run(Env::from_process()?),
        // No scan: the copy needs only the agents Laci connects and their history folders.
        Some(Action::Backup) => say(&service::backup_now(&Env::from_process()?, "cli")?),
        // No scan either: a change goes through the request the window sends, and the next scan reads it.
        Some(Action::Settings { change }) => {
            let env = Env::from_process()?;
            let said = match change {
                None => settings(&env),
                Some(change) => {
                    let here = std::env::current_dir().map_err(|e| e.to_string())?;
                    change_setting(&env, change, &here)?
                }
            };
            say(&said)
        }
        Some(action) => {
            let mut snapshot = Service::new(Env::from_process()?).rescan()?;
            unsaid(&mut snapshot);
            let mut out = io::stdout().lock();
            let written = match action {
                Action::Json => writeln!(out, "{snapshot:#}"),
                Action::Doctor => doctor(&snapshot, &mut out),
                _ => list(&snapshot, &mut out),
            };
            match written {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
    }
}

/// Prints `said`, which a closed pipe cuts short without an error.
fn say(said: &str) -> laci_core::Result<()> {
    match writeln!(io::stdout().lock(), "{said}") {
        Err(e) if e.kind() != io::ErrorKind::BrokenPipe => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// `laci settings`: the scan locations, and the folders of the archive, the copy of AI chats and the reports, each
/// with why it can't be used now when its drive isn't there.
fn settings(env: &Env) -> String {
    let cfg = config::load(env);
    let shown = |path: &Path| paths::tilde(path, &env.home);
    let away = |status: &Value| {
        status["reason"].as_str().filter(|_| status["available"] == false).map(|why| format!(" (unavailable: {why})"))
    };
    let mut lines = vec!["Scan locations:".to_owned()];
    if !cfg["roots"].is_array() {
        lines.push("  none yet: open Laci to choose them".to_owned());
    }
    for root in scan::root_status(env, &cfg) {
        lines.push(format!("  {}{}", shown(Path::new(string(&root, "path"))), away(&root).unwrap_or_default()));
    }
    let chosen =
        |key: &str| cfg[key].as_str().filter(|dir| !dir.trim().is_empty()).map(|dir| paths::expand(dir, &env.home));
    let archive =
        chosen("archiveDir").map_or_else(|| "an _archive folder beside each scan location".into(), |d| shown(&d));
    lines.push(format!("Archive folder: {archive}"));
    let copy = match scan::copy_status(env, &cfg) {
        Some(status) => format!("{}{}", shown(Path::new(string(&status, "path"))), away(&status).unwrap_or_default()),
        None => shown(&env.data_dir.join("history")),
    };
    lines.push(format!("Copy of AI chats: {copy}"));
    let reports = chosen("reportsDir").map_or_else(|| "none".into(), |d| shown(&d));
    lines.push(format!("Reports folder: {reports}"));
    lines.join("\n")
}

/// `dir` as typed in the folder `here`: a path from `~/` or a full one as it is, another one from `here`, and `""` as
/// it is, which each setting takes as its default.
fn typed_folder(dir: &str, here: &Path) -> String {
    let dir = dir.trim();
    if dir.is_empty() || dir.starts_with('~') || Path::new(dir).is_absolute() {
        dir.to_owned()
    } else {
        here.join(dir).to_string_lossy().into_owned()
    }
}

/// `laci settings archive|copy|reports DIR`: the change through the request the window sends for it, `setup/save` or
/// `backup/move`, told in the Log as made from the command line. Gives what it prints.
fn change_setting(env: &Env, change: Setting, here: &Path) -> laci_core::Result<String> {
    let (key, label, dir) = match &change {
        Setting::Archive { dir } => ("archiveDir", "Archive folder", typed_folder(dir, here)),
        Setting::Reports { dir } => ("reportsDir", "Reports folder", typed_folder(dir, here)),
        Setting::Copy { dir, fresh } => {
            let body = json!({"dir":typed_folder(dir, here),"fresh":fresh});
            let moved = service::long_action(env, &json!({}), "backup/move", &body, "cli")?.value;
            let dest = string(&moved, "dest");
            return Ok(if moved["moved"] == true {
                format!("Moved the copy of AI chats to {dest} ({})", string(&moved, "size"))
            } else {
                format!("The copy of AI chats is kept in {dest} from now on")
            });
        }
    };
    let mut service = Service::new(env.clone());
    // Every other setting as it is saved, as the window's Settings sends them.
    let info = service.setup_info()?;
    if info["configured"] != true {
        return Err("Laci isn't set up yet. Open it once and choose the folders to scan first.".into());
    }
    let mut body = json!({"roots":info["roots"],"archiveDir":info["archiveDir"],"reportsDir":info["reportsDir"],
        "presets":info["presets"],"apps":info["apps"],"terminalTarget":info["terminalTarget"]});
    let before = config::load(env)[key].clone();
    body[key] = json!(dir);
    service.execute("setup/save", &body, "cli")?;
    let after = config::load(env)[key].clone();
    let now =
        after.as_str().filter(|dir| !dir.is_empty()).map(|dir| paths::tilde(&paths::expand(dir, &env.home), &env.home));
    let now = now.unwrap_or_else(|| {
        if key == "archiveDir" { "an _archive folder beside each scan location".into() } else { "none".into() }
    });
    Ok(if before == after { format!("{label} is {now} already") } else { format!("{label}: {now}") })
}

fn list(s: &Value, out: &mut impl Write) -> io::Result<()> {
    let mut nodes: Vec<_> =
        s["nodes"].as_object().into_iter().flatten().map(|(_, v)| v).filter(|n| n["kind"] == "project").collect();
    nodes.sort_by_key(|n| std::cmp::Reverse(string(&n["lastActivity"], "at")));
    for n in nodes {
        writeln!(out, "{:<9} {:<30} {}", string(&n["status"], "value"), string(n, "label"), string(n, "path"))?;
    }
    Ok(())
}
fn doctor(s: &Value, out: &mut impl Write) -> io::Result<()> {
    for n in s["nodes"].as_object().into_iter().flatten().map(|(_, n)| n) {
        let issues = array(&n["issues"]);
        let open: Vec<_> = array(&n["tasks"]).into_iter().filter(|t| t["done"] == false).collect();
        if issues.is_empty() && open.is_empty() {
            continue;
        }
        // A project line of its own, so a project without issues doesn't list its to-dos under the one before.
        writeln!(out, "{}  {}", string(n, "label"), string(n, "path"))?;
        for issue in issues {
            writeln!(out, "  ! {}", string(&issue, "title"))?;
        }
        for task in open {
            writeln!(out, "  [ ] {} ({}:{})", string(&task, "text"), string(&task, "file"), task["line"])?;
        }
    }
    for proposal in array(&s["proposals"]) {
        writeln!(out, "Tidy: {}", string(&proposal, "title"))?;
    }
    if let Some(error) = s["reportsDir"]["error"].as_str() {
        writeln!(out, "Reports folder {}: {error}", string(&s["reportsDir"], "path"))?;
    }
    Ok(())
}

/// Leaves out the parts the Log tells an applied suggestion by ("say"): they are the window's, and `laci json` stays as
/// it was.
fn unsaid(snapshot: &mut Value) {
    for proposal in snapshot.get_mut("proposals").and_then(Value::as_array_mut).into_iter().flatten() {
        proposal.as_object_mut().map(|fields| fields.remove("say"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn public(args: &[&str]) -> Option<Action> {
        Cli::try_parse_from(args).unwrap_or_else(|e| panic!("{args:?}: {e}")).command
    }

    #[test]
    fn the_command_line_reads_its_commands_and_help_names_them() {
        assert!(public(&["laci"]).is_none());
        assert!(matches!(public(&["laci", "ls"]), Some(Action::Ls)));
        assert!(matches!(public(&["laci", "doctor"]), Some(Action::Doctor)));
        assert!(matches!(public(&["laci", "json"]), Some(Action::Json)));
        assert!(matches!(public(&["laci", "mcp"]), Some(Action::Mcp)));
        assert!(matches!(public(&["laci", "backup"]), Some(Action::Backup)));
        assert!(matches!(public(&["laci", "settings"]), Some(Action::Settings { change: None })));
        assert!(matches!(
            public(&["laci", "settings", "archive", "~/old"]),
            Some(Action::Settings { change: Some(Setting::Archive { dir }) }) if dir == "~/old"
        ));
        assert!(matches!(
            public(&["laci", "settings", "copy", "/mnt/disk/chats"]),
            Some(Action::Settings { change: Some(Setting::Copy { dir, fresh: false }) }) if dir == "/mnt/disk/chats"
        ));
        assert!(matches!(
            public(&["laci", "settings", "copy", "--fresh", ""]),
            Some(Action::Settings { change: Some(Setting::Copy { dir, fresh: true }) }) if dir.is_empty()
        ));
        assert!(matches!(
            public(&["laci", "settings", "reports", "notes"]),
            Some(Action::Settings { change: Some(Setting::Reports { dir }) }) if dir == "notes"
        ));
        for wrong in [
            &["laci", "nothing"][..],
            &["laci", "ls", "extra"],
            &["laci", "backup", "now"],
            &["laci", "settings", "archive"],
            &["laci", "settings", "theme", "dark"],
            &["laci", "settings", "reports", "a", "b"],
        ] {
            assert!(Cli::try_parse_from(wrong).is_err(), "{wrong:?}");
        }
        let help = Cli::command().render_long_help().to_string();
        for shown in ["ls", "doctor", "json", "mcp", "backup", "settings"] {
            assert!(help.contains(shown), "{help}");
        }
        // The version reads `laci 2.5.2`; package-smoke reads it.
        assert_eq!(Cli::command().render_version(), format!("laci {}\n", env!("CARGO_PKG_VERSION")));
    }

    /// What is built here carries every release in the changelog, so its version is never below the newest one: a
    /// package from it would otherwise install as a downgrade.
    #[test]
    fn the_version_is_at_least_the_newest_release() {
        let parts = |version: &str| -> Vec<u64> {
            version.split(['-', '+']).next().unwrap().split('.').map(|part| part.parse().unwrap()).collect()
        };
        let newest = include_str!("../../CHANGELOG.md")
            .lines()
            .find_map(|line| line.strip_prefix("## [")?.split(']').next().filter(|name| *name != "Unreleased"))
            .unwrap();
        assert!(parts(env!("CARGO_PKG_VERSION")) >= parts(newest), "{} < {newest}", env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn the_json_leaves_out_the_parts_the_log_tells_a_suggestion_by() {
        let mut snapshot = serde_json::json!({"proposals":[{"id":"space:inactive","title":"Free 1 MB","say":{"form":"freed"}},
            {"id":"dup:x","title":"x exists in 2 places"}],"nodes":{"/p/a":{"say":"kept"}}});
        unsaid(&mut snapshot);
        assert_eq!(
            snapshot,
            serde_json::json!({"proposals":[{"id":"space:inactive","title":"Free 1 MB"},{"id":"dup:x","title":"x exists in 2 places"}],
                "nodes":{"/p/a":{"say":"kept"}}})
        );
    }

    /// Each change goes through the request the window sends, so its checks, the Log and Undo are the window's.
    #[test]
    fn laci_settings_changes_each_folder_as_the_window_does_and_the_log_tells_it() {
        use laci_core::activity;
        let temp = tempfile::tempdir().unwrap();
        let root = laci_core::platform::path::canonical(temp.path()).unwrap();
        let env = Env::for_home(root.join("home"));
        for dir in ["home/project", "archive", "reports", "disk/chats"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let logged = |title: &str| activity::read_log(&env, 50).into_iter().find(|e| e["title"] == title);
        let refused = change_setting(&env, Setting::Archive { dir: "archive".into() }, &root).unwrap_err();
        assert!(refused.contains("Open it once"), "{refused}");
        assert!(config::load(&env)["archiveDir"].is_null(), "nothing is saved before the setup");
        config::save(&env, &json!({"roots":["~/project"],"presets":["claude"]})).unwrap();

        // A folder typed from where the command runs.
        let archive = root.join("archive");
        let said = change_setting(&env, Setting::Archive { dir: "archive".into() }, &root).unwrap();
        assert_eq!(said, format!("Archive folder: {}", archive.display()));
        let entry = logged("Changed settings").unwrap();
        assert_eq!(
            (&entry["by"], &entry["detail"]),
            (&json!("cli"), &json!(format!("Archive folder: {}", archive.display())))
        );
        assert_eq!(config::load(&env)["roots"], json!(["~/project"]), "the other settings stay as they were");
        let again = change_setting(&env, Setting::Archive { dir: archive.to_string_lossy().into() }, &root).unwrap();
        assert_eq!(again, format!("Archive folder is {} already", archive.display()));
        // Undo in the Log puts the archive folder back.
        let mut service = Service::new(env.clone());
        service.execute("log/undo", &json!({"id":entry["id"]}), "app").unwrap();
        assert_eq!(config::load(&env)["archiveDir"].as_str().unwrap_or(""), "");
        // The window's checks: a folder that isn't there is refused.
        assert!(change_setting(&env, Setting::Reports { dir: "nowhere".into() }, &root).is_err());
        let reports = root.join("reports");
        change_setting(&env, Setting::Reports { dir: reports.to_string_lossy().into() }, &root).unwrap();
        assert_eq!(config::load(&env)["reportsDir"], json!(reports));

        // The copy moves as "Move the copy" does, a change of its own in the Log.
        let chats = root.join("disk/chats");
        let said =
            change_setting(&env, Setting::Copy { dir: chats.to_string_lossy().into(), fresh: false }, &root).unwrap();
        assert_eq!(said, format!("The copy of AI chats is kept in {} from now on", chats.display()));
        let entry = logged(&format!("The copy of AI chats is kept in {} from now on", chats.display())).unwrap();
        assert_eq!((&entry["by"], &entry["say"]["form"]), (&json!("cli"), &json!("keptCopyIn")));
        assert_eq!(config::load(&env)["backupDir"], json!(chats));

        let shown = settings(&env);
        for line in [
            "Scan locations:\n  ~/project\n",
            "Archive folder: an _archive folder beside each scan location\n",
            &format!("Copy of AI chats: {}\n", chats.display()),
            &format!("Reports folder: {}", reports.display()),
        ] {
            assert!(shown.contains(line), "{line:?} in {shown}");
        }
        // A copy folder whose drive was taken out says so, as a scan location does.
        std::fs::rename(&chats, root.join("disk/away")).unwrap();
        assert!(settings(&env).contains(&format!("Copy of AI chats: {} (unavailable: ", chats.display())));
    }

    #[test]
    fn a_mistyped_command_gets_a_tip() {
        let said = Cli::try_parse_from(["laci", "doctr"]).err().unwrap().render().to_string();
        assert!(said.contains("doctor"), "{said}");
    }
}
