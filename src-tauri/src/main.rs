mod app;
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
fn main() {
    let cli = Cli::parse();
    let result = Env::from_process().and_then(|env| match cli.command {
        None => app::run(env),
        Some(Action::Mcp) => mcp::run(env),
        Some(action) => {
            let snapshot = Service::new(env).rescan()?;
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
    });
    if let Err(error) = result {
        eprintln!("laci: {error}");
        std::process::exit(1);
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
