//! What Laci asks an agent to do: go through everything open with the user, or work on one to-do in its project.
//! The desktop app starts an agent with these as its first prompt; the MCP server offers the same text as prompts.
use crate::{
    env::Env,
    paths,
    service::{array, string},
};
use chrono::{Local, NaiveDate};
use serde_json::Value;
use std::path::Path;

fn projects(snapshot: &Value) -> impl Iterator<Item = &Value> {
    snapshot["nodes"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, n)| n)
        .filter(|n| n["kind"] == "project" && n["archived"] != true)
}

/// The brief for a session that goes through everything open with the user and leaves a short, agreed list.
pub fn review(_env: &Env, snapshot: &Value) -> String {
    let today = Local::now().date_naive();
    let (mut count, mut todos, mut soon, mut late) = (0, 0, 0, 0);
    for n in projects(snapshot) {
        count += 1;
        todos += array(&n["tasks"]).iter().filter(|t| t["done"] == false && t["kind"] == "check").count();
        if let Ok(day) = NaiveDate::parse_from_str(string(&n["meta"], "deadline"), "%Y-%m-%d") {
            let days = (day - today).num_days();
            if days < 0 {
                late += 1;
            } else if days <= 14 {
                soon += 1;
            }
        }
    }
    let report_items: u64 = array(&snapshot["reports"]).iter().filter_map(|r| r["openCount"].as_u64()).sum();
    format!(
        "Help me go through everything open across my projects, using Laci, my project manager. Laci's MCP server is \
called \"laci\". If its tools aren't available here, tell me and stop: Laci's Agents page can set it up.

The goal of this session: I end with a short list of what to do next that I agree with, and less clutter. Talk \
with me in the language I use.

1. Read what is open: open_items (to-dos and report items), needs_attention (work that could be lost, deadlines) \
and tidy_suggestions (cleanups). open_items answers a page at a time: while it says more, call it again with \
offset. Read a report only when an item needs its context.
2. Check items against reality before you call them done: the git log, the pull request, the file. If you can't \
check, keep the item open.
3. Propose, in a few short lists:
   - done items to tick (complete_task) and report items to close (close_report_item);
   - duplicates and stale items to delete (delete_task), long items to split (edit_task, add_next_step), items in \
the wrong project to move (move_task);
   - three to five things to focus on this week, and why;
   - questions only I can answer, each with two to four options.
4. Change nothing until I agree. Then make the changes with Laci's tools, so they show in Laci's Log with Undo. \
Don't edit .laci.md by hand.
5. Work that belongs to one project isn't done in this session: leave it as a to-do in that project, so I can \
start it with \"Work on it\" in Laci.
6. Moves, archives and cleanups go through Laci too (move_project, archive_project, apply_suggestion): show me the \
plan first, and confirm only after I say yes.

Today is {}. Laci knows {} {}, {} open {}, {} open report {}, {} {} due in the next 14 days and {} overdue.",
        today.format("%A %-d %B %Y"),
        count,
        if count == 1 { "project" } else { "projects" },
        todos,
        if todos == 1 { "to-do" } else { "to-dos" },
        report_items,
        if report_items == 1 { "item" } else { "items" },
        soon,
        if soon == 1 { "deadline" } else { "deadlines" },
        late,
    )
}

/// The first prompt for an agent started in a project's folder on one of its open to-dos.
pub fn work_on(env: &Env, snapshot: &Value, node: &Value, task: &Value) -> String {
    let path = string(node, "path");
    let shown = paths::tilde(Path::new(path), &env.home);
    let mut out = format!(
        "Work on this to-do in {} ({shown}):\n\n  {}\n\nIt is listed in {}:{}",
        string(node, "label"),
        string(task, "text"),
        string(task, "file"),
        task["line"]
    );
    if !string(task, "section").is_empty() {
        out.push_str(&format!(", under \"{}\"", string(task, "section")));
    }
    out.push('.');
    let meta = &node["meta"];
    let facts: Vec<String> = [("priority", "priority"), ("deadline", "deadline")]
        .iter()
        .filter(|(key, _)| !string(meta, key).is_empty())
        .map(|(key, label)| format!("{label} {}", string(meta, key)))
        .collect();
    if !facts.is_empty() {
        out.push_str(&format!(" The project's {}.", facts.join(", ")));
    }
    let reports: Vec<String> = array(&snapshot["reports"])
        .iter()
        .filter(|r| array(&r["projects"]).iter().any(|p| p.as_str() == Some(path)))
        .take(3)
        .map(|r| {
            format!(
                "- {} · {} ({})",
                string(r, "date"),
                string(r, "title"),
                paths::tilde(Path::new(string(r, "file")), &env.home)
            )
        })
        .collect();
    if !reports.is_empty() {
        out.push_str(&format!(
            "\n\nReports from earlier sessions in this project, newest first. Read them if the to-do needs \
their context:\n{}",
            reports.join("\n")
        ));
    }
    out.push_str(&format!(
        "\n\nFirst check where things stand: part of it may be done already. Ask me before anything destructive or \
outward-facing, such as deleting, pushing, deploying or sending messages. If it turns out to be several things, \
say so, and split it with Laci's edit_task and add_next_step. When it is done, tick it in Laci: complete_task \
with project \"{path}\" and text \"{}\".",
        string(task, "text")
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_review_counts_what_is_open_and_names_the_tools() {
        let env = Env::for_home("/home/u".into());
        let snapshot = json!({"nodes":{
            "/home/u/a":{"kind":"project","meta":{"deadline":"2000-01-01"},"tasks":[{"kind":"check","done":false},{"kind":"check","done":true}]},
            "/home/u/b":{"kind":"project","archived":true,"tasks":[{"kind":"check","done":false}]}},
            "reports":[{"openCount":3}]});
        let brief = review(&env, &snapshot);
        assert!(brief.contains("1 project, 1 open to-do, 3 open report items"), "{brief}");
        assert!(brief.contains("1 overdue"));
        for tool in ["open_items", "needs_attention", "close_report_item", "delete_task", "edit_task", "move_task"] {
            assert!(brief.contains(tool), "{tool}");
        }
    }

    #[test]
    fn a_to_do_prompt_names_where_it_is_and_how_to_tick_it() {
        let env = Env::for_home("/home/u".into());
        let node = json!({"label":"shop","path":"/home/u/project/shop","meta":{"priority":"high"}});
        let task = json!({"text":"Fix the total on Safari","file":".laci.md","line":7,"section":"Next"});
        let snapshot = json!({"reports":[
            {"date":"2026-10-14","title":"Safari","file":"/home/u/notes/r.md","projects":["/home/u/project/shop"]},
            {"date":"2026-10-13","title":"Other","file":"/home/u/notes/o.md","projects":["/home/u/project/other"]}]});
        let prompt = work_on(&env, &snapshot, &node, &task);
        assert!(prompt.contains("Work on this to-do in shop (~/project/shop)"), "{prompt}");
        assert!(prompt.contains(".laci.md:7, under \"Next\"."));
        assert!(prompt.contains("The project's priority high."));
        assert!(prompt.contains("- 2026-10-14 · Safari (~/notes/r.md)"));
        assert!(!prompt.contains("Other"));
        assert!(prompt.contains("text \"Fix the total on Safari\""));
    }
}
