//! Laci's command line. Without a command, `laci` opens the window.
mod mcp;

use clap::{Parser, Subcommand};
use laci_core::{
    env::Env,
    service::{Service, array, string},
};
use serde_json::Value;
use std::io::{self, Write};

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
        for wrong in [&["laci", "nothing"][..], &["laci", "ls", "extra"]] {
            assert!(Cli::try_parse_from(wrong).is_err(), "{wrong:?}");
        }
        let help = Cli::command().render_long_help().to_string();
        for shown in ["ls", "doctor", "json", "mcp"] {
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

    #[test]
    fn a_mistyped_command_gets_a_tip() {
        let said = Cli::try_parse_from(["laci", "doctr"]).err().unwrap().render().to_string();
        assert!(said.contains("doctor"), "{said}");
    }
}
