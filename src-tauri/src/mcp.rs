//! MCP over stdio; the window toolkit is never started on this path.
use laci_core::{
    env::Env,
    paths, scan,
    service::{Service, array, string},
};
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt, model::*, service::RequestContext};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Mcp {
    engine: Arc<Mutex<(Service, Instant)>>,
}
impl ServerHandler for Mcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_prompts().build())
            .with_server_info(Implementation::new("laci",env!("CARGO_PKG_VERSION")))
            .with_instructions("Use laci for moving projects so their agent history travels with them. Destructive tools return a plan first; show it to the user before calling with confirm: true. open_items lists every open to-do and report item; change to-dos with complete_task, edit_task, delete_task and move_task, and close report items with close_report_item, so each change shows in Laci's Log with Undo. Reports from earlier sessions are in list_reports and project_details; read a report's file for its full text. The review prompt goes through everything open with the user.")
    }
    async fn list_prompts(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        Ok(ListPromptsResult::with_all_items(prompts()))
    }
    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        let engine = Arc::clone(&self.engine);
        let args = Value::Object(request.arguments.unwrap_or_default());
        let name = request.name;
        let text = tokio::task::spawn_blocking(move || {
            let (service, scanned) = &mut *engine.lock().map_err(|_| "The engine stopped; restart laci".to_owned())?;
            if scanned.elapsed() > Duration::from_secs(60) {
                service.rescan()?;
                *scanned = Instant::now();
            }
            prompt(service, &name, &args)
        })
        .await
        .map_err(|e| ErrorData::internal_error(format!("The engine stopped: {e}"), None))?
        .map_err(|e| ErrorData::invalid_params(e, None))?;
        Ok(GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)]).into())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tools()))
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        tools().into_iter().find(|t| t.name == name)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let engine = Arc::clone(&self.engine);
        let name = request.name.into_owned();
        let args = Value::Object(request.arguments.unwrap_or_default());
        let result = tokio::task::spawn_blocking(move || {
            let (service, scanned) = &mut *engine.lock().map_err(|_| "The engine stopped; restart laci".to_owned())?;
            if scanned.elapsed() > Duration::from_secs(60) {
                service.rescan()?;
                *scanned = Instant::now();
            }
            let result = call(service, &name, &args);
            if !matches!(
                name.as_str(),
                "list_projects"
                    | "list_reports"
                    | "project_details"
                    | "needs_attention"
                    | "open_items"
                    | "tidy_suggestions"
                    | "recent_changes"
            ) {
                *scanned = Instant::now();
            }
            // A change answers with the whole refreshed scan for the desktop; an agent only needs its result.
            result.map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.remove("snapshot");
                }
                value
            })
        })
        .await;
        let result = match result {
            Ok(Ok(value)) => CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&value).unwrap_or_default(),
            )]),
            Ok(Err(error)) => CallToolResult::error(vec![ContentBlock::text(error)]),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(format!("The engine stopped: {error}"))]),
        };
        Ok(result.into())
    }
}
pub fn run(env: Env) -> Result<(), String> {
    let mut engine = Service::new(env);
    engine.current = None;
    let server = Mcp { engine: Arc::new(Mutex::new((engine, Instant::now() - Duration::from_secs(61)))) };
    tokio::runtime::Runtime::new().map_err(|e| e.to_string())?.block_on(async {
        let service = server.serve(rmcp::transport::stdio()).await.map_err(|e| e.to_string())?;
        service.waiting().await.map_err(|e| e.to_string())?;
        Ok(())
    })
}
fn project(service: &mut Service, raw: &str) -> Result<Value, String> {
    let snap = service.snapshot()?;
    let expanded = paths::expand(raw, &service.env.home).to_string_lossy().into_owned();
    if let Some(node) = snap["nodes"].get(&expanded) {
        return Ok(node.clone());
    }
    let matches: Vec<_> = snap["nodes"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, n)| n)
        .filter(|n| n["name"] == raw || n["label"] == raw)
        .collect();
    match matches.as_slice() {
        [node] => Ok((*node).clone()),
        [] => Err("Unknown project. Use list_projects to find its full path.".into()),
        _ => Err("That name is ambiguous; use the full project path.".into()),
    }
}
fn call(service: &mut Service, name: &str, args: &Value) -> Result<Value, String> {
    validate_args(name, args)?;
    match name {
        "list_projects" => {
            let snap = service.snapshot()?;
            let query = string(args, "query").to_lowercase();
            let filter = string(args, "filter");
            let nodes: Vec<_> = snap["nodes"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(_, n)| n)
                .filter(|n| n["kind"] == "project")
                .filter(|n| match filter {
                    "" | "all" => true,
                    "archived" => n["archived"] == true,
                    "at_risk" => array(&n["issues"]).iter().any(|i| {
                        ["no-remote", "no-commits", "dirty", "unpushed", "stash", "no-git"].contains(&string(i, "code"))
                    }),
                    f => n["status"]["value"] == f && n["archived"] != true,
                })
                .filter(|n| {
                    let haystack = format!(
                        "{} {} {} {}",
                        string(n, "name"),
                        string(n, "path"),
                        n["summary"],
                        n["stack"]["labels"]
                    )
                    .to_lowercase();
                    query.split_whitespace().all(|word| haystack.contains(word))
                })
                .map(|n| compact(n, Tasks::Count))
                .collect();
            let mut nodes = nodes;
            nodes.sort_by(|a, b| string(&b["lastActivity"], "at").cmp(string(&a["lastActivity"], "at")));
            Ok(json!(nodes))
        }
        "project_details" => {
            let mut n = project(service, string(args, "project"))?;
            let s = service.snapshot()?;
            n["agentSessions"] = json!(
                array(&s["sessions"])
                    .into_iter()
                    .filter(|session| session["cwd"]
                        .as_str()
                        .is_some_and(|cwd| Path::new(cwd).starts_with(string(&n, "path"))))
                    .collect::<Vec<_>>()
            );
            n["sessions"] = json!(
                array(&n["agents"]["claude"])
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|id| s["claude"][id].clone())
                    .collect::<Vec<_>>()
            );
            n["agentItems"] = json!(
                array(&n["agents"]["items"])
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|id| s["items"][id].clone())
                    .collect::<Vec<_>>()
            );
            if s["reportsDir"].is_object() {
                let under = Path::new(string(&n, "path")).to_owned();
                n["reports"] = laci_core::reports::list(&service.env, &s, Some(&under), None, 3)?["reports"].clone();
            }
            Ok(n)
        }
        "list_reports" => {
            let under = match args["project"].as_str() {
                Some(raw) => Some(std::path::PathBuf::from(string(&project(service, raw)?, "path"))),
                None => None,
            };
            let s = service.snapshot()?;
            laci_core::reports::list(&service.env, &s, under.as_deref(), args["query"].as_str(), 20)
        }
        "needs_attention" => {
            let s = service.snapshot()?;
            let projects: Vec<_> = s["nodes"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(_, n)| n)
                .filter(|n| !array(&n["issues"]).is_empty() || array(&n["tasks"]).iter().any(|t| t["done"] == false))
                .map(|n| compact(n, Tasks::Open))
                .collect();
            Ok(json!({"projects":projects,"warnings":s["warnings"]}))
        }
        "tidy_suggestions" => Ok(service.snapshot()?["proposals"].clone()),
        "recent_changes" => service.request_as("log", args, "agent"),
        "undo_change" => {
            let id = string(args, "id");
            let entries = array(&service.request_as("log", &json!({}), "agent")?["entries"]);
            let entry = entries.iter().find(|e| e["id"] == id);
            if args["confirm"] != true {
                // A move can be named by its journal id, which is what `move_project` returns.
                let shown = entry
                    .or_else(|| entries.iter().find(|e| e["journal"] == id))
                    .ok_or("Unknown change. Use recent_changes to find its id.")?;
                if shown["canUndo"] != true {
                    return Err("That change can no longer be undone".into());
                }
                return Ok(
                    json!({"plan":shown,"hint":"Nothing has changed yet. Show this change to the user; if they agree, call again with confirm: true."}),
                );
            }
            service.request_as(if entry.is_some() { "log/undo" } else { "undo" }, &json!({"id":id}), "agent")
        }
        "create_project" => {
            if args["confirm"] != true {
                let parent = paths::workspace_path(string(args, "parent"), &service.env)?;
                return Ok(
                    json!({"plan":format!("Create {} in {}",string(args,"name"),parent.display()),"request":args,"hint":"Nothing has changed yet. Show this plan to the user; if they agree, call again with confirm: true."}),
                );
            }
            // Only what the tool describes reaches the engine; its other creation options stay with the app.
            let mut body = json!({"from":"empty","remote":"none"});
            for key in ["parent", "name", "from", "summary", "template", "url", "remote"] {
                if !args[key].is_null() {
                    body[key] = args[key].clone();
                }
            }
            service.request_as("new", &body, "agent")
        }
        "apply_suggestion" => {
            service.rescan()?;
            let s = service.snapshot()?;
            let id = string(args, "id");
            let proposal = array(&s["proposals"]).into_iter().find(|p| p["id"] == id).ok_or("Unknown suggestion")?;
            let recovery = args["recovery"].as_str().unwrap_or("quarantine");
            if !["quarantine", "trash"].contains(&recovery) {
                return Err("Choose Quarantine or system Trash".into());
            }
            if args["confirm"] != true {
                return Ok(
                    json!({"plan":proposal,"selectedRecovery":recovery,"hint":if recovery=="trash" {"Orphan history will move to system Trash; restore it through the file manager. Show the exact source paths before confirming."}else{"Nothing has changed yet. Show this plan to the user; if they agree, call again with confirm: true."}}),
                );
            }
            service.request_as("apply", &json!({"id":id,"recovery":recovery}), "agent")
        }
        "delete_project" => {
            service.rescan()?;
            let node = project(service, string(args, "project"))?;
            let body = json!({"id":node["id"],"confirm":args["confirm"]});
            if args["confirm"] != true {
                return Ok(
                    json!({"plan":service.request("delete/plan", &body)?,"hint":"Nothing has changed yet. Show the checks and Trash plan to the user before calling with confirm: true."}),
                );
            }
            service.request_as("delete", &body, "agent")
        }
        "move_project" | "archive_project" => {
            service.rescan()?;
            let n = project(service, string(args, "project"))?;
            let id = string(&n, "id");
            let archive_plan = if name == "archive_project" {
                if n["kind"] != "project" || n["archived"] == true {
                    return Err("This folder cannot be archived".into());
                }
                Some(service.request("archive/plan", &json!({"id":id,"destination":args["destination"]}))?)
            } else {
                None
            };
            let destination = if let Some(plan) = &archive_plan {
                string(plan, "dest").to_owned()
            } else {
                paths::workspace_path(string(args, "destination"), &service.env)?.to_string_lossy().into_owned()
            };
            if args["confirm"] != true {
                if let Some(plan) = archive_plan {
                    return Ok(
                        json!({"plan":plan["ops"],"destination":plan["dest"],"checks":plan["checks"],"hint":"Nothing has changed yet. Show this plan to the user; if they agree, call again with confirm: true."}),
                    );
                }
                let s = service.snapshot()?;
                return Ok(
                    json!({"plan":scan::move_ops(&service.env,Path::new(id),Path::new(&destination),&s),"destination":destination,"checks":n["issues"],"hint":"Nothing has changed yet. Show this plan to the user; if they agree, call again with confirm: true."}),
                );
            }
            service.request_as(
                if name == "archive_project" { "archive" } else { "move" },
                &json!({"id":id,"destination":destination,"trashHeavy":args["trash_heavy"]==true}),
                "agent",
            )
        }
        "set_project_fields" => {
            if let Some(deadline) = args["deadline"].as_str()
                && !deadline.is_empty()
                && !regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap().is_match(deadline)
            {
                return Err("Invalid deadline".into());
            }
            let node = project(service, string(args, "project"))?;
            let id = string(&node, "id");
            let mut node = node.clone();
            for key in ["status", "priority", "deadline"] {
                if args[key].is_string() {
                    node = service.request_as("meta", &json!({"id":id,"key":key,"value":args[key]}), "agent")?;
                }
            }
            Ok(compact(&node, Tasks::All))
        }
        "add_next_step" => {
            let node = project(service, string(args, "project"))?;
            Ok(compact(
                &service.request_as("todo", &json!({"id":node["id"],"op":"add","text":args["text"]}), "agent")?,
                Tasks::All,
            ))
        }
        "complete_task" => {
            service.rescan()?;
            let node = project(service, string(args, "project"))?;
            let done = args["done"].as_bool().unwrap_or(true);
            let task = checkbox(&node, string(args, "text"), |t| t["done"] != done)?;
            Ok(compact(
                &service.request_as("todo",&json!({"id":node["id"],"op":"toggle","file":task["file"],"line":task["line"],"text":task["text"],"done":done}),"agent")?,
                Tasks::All,
            ))
        }
        "edit_task" => {
            service.rescan()?;
            let node = project(service, string(args, "project"))?;
            let task = checkbox(&node, string(args, "text"), |_| true)?;
            Ok(compact(
                &service.request_as("todo",&json!({"id":node["id"],"op":"edit","file":task["file"],"line":task["line"],"text":task["text"],"to":args["to"]}),"agent")?,
                Tasks::All,
            ))
        }
        "delete_task" => {
            service.rescan()?;
            let node = project(service, string(args, "project"))?;
            let task = checkbox(&node, string(args, "text"), |t| t["file"] == ".laci.md")?;
            Ok(compact(
                &service.request_as(
                    "todo",
                    &json!({"id":node["id"],"op":"delete","file":task["file"],"line":task["line"],"text":task["text"]}),
                    "agent",
                )?,
                Tasks::All,
            ))
        }
        "move_task" => {
            service.rescan()?;
            let from = project(service, string(args, "project"))?;
            let to = project(service, string(args, "to_project"))?;
            if from["id"] == to["id"] {
                return Err("That is the same project".into());
            }
            let task = checkbox(&from, string(args, "text"), |t| t["file"] == ".laci.md" && t["done"] == false)?;
            // Added first, so a failure leaves the to-do in both places rather than in neither.
            let to = service.request_as("todo", &json!({"id":to["id"],"op":"add","text":task["text"]}), "agent")?;
            let from = service.request_as(
                "todo",
                &json!({"id":from["id"],"op":"delete","file":task["file"],"line":task["line"],"text":task["text"]}),
                "agent",
            )?;
            Ok(json!({"from":compact(&from, Tasks::All),"to":compact(&to, Tasks::All)}))
        }
        "open_items" => open_items(service, args),
        "close_report_item" => {
            let s = service.snapshot()?;
            let words = string(args, "report").to_lowercase();
            let reports = array(&s["reports"]);
            let exact = reports.iter().find(|r| r["id"] == string(args, "report"));
            let report = match exact {
                Some(r) => r.clone(),
                None => {
                    let found: Vec<_> = reports
                        .iter()
                        .filter(|r| {
                            let hay = format!("{} {}", string(r, "id"), string(r, "title")).to_lowercase();
                            !words.trim().is_empty() && words.split_whitespace().all(|w| hay.contains(w))
                        })
                        .collect();
                    match found.as_slice() {
                        [one] => (*one).clone(),
                        [] => return Err("No report matches. Use list_reports to find its id.".into()),
                        _ => return Err("More than one report matches; use its id (the file name)".into()),
                    }
                }
            };
            let state = if string(args, "state").is_empty() { "done" } else { string(args, "state") };
            let mut out = service.request_as(
                "report/close",
                &json!({"report":report["id"],"item":args["item"],"state":state,"note":args["note"]}),
                "agent",
            )?;
            let now = service.snapshot()?;
            if let Some(r) = array(&now["reports"]).into_iter().find(|r| r["id"] == report["id"]) {
                out["open"] = r["open"].clone();
                out["openCount"] = r["openCount"].clone();
            }
            Ok(out)
        }
        "write_notes" => {
            service.rescan()?;
            let node = project(service, string(args, "project"))?;
            let text = if args["mode"] == "replace" || string(&node, "notes").is_empty() {
                string(args, "notes").to_owned()
            } else {
                format!("{}\n\n{}", string(&node, "notes"), string(args, "notes"))
            };
            Ok(compact(&service.request_as("notes", &json!({"id":node["id"],"text":text}), "agent")?, Tasks::All))
        }
        _ => Err("Unknown tool".into()),
    }
}
use std::path::Path;

/// Which of a project's to-dos a compact answer carries.
#[derive(Clone, Copy)]
enum Tasks {
    /// All of them, with the notes: the answer to a change.
    All,
    /// The open ones.
    Open,
    /// Only how many are open.
    Count,
}
/// What an agent needs about a project in a list or after a change, without the README text, archive plan,
/// stack and session lists that project_details gives.
fn compact(n: &Value, tasks: Tasks) -> Value {
    let mut out = json!({});
    for key in ["path", "name", "kind", "type", "archived", "status", "meta", "issues", "lastActivity"] {
        if !n[key].is_null() {
            out[key] = n[key].clone();
        }
    }
    if let Some(text) = n["summary"]["text"].as_str() {
        out["summary"] = json!(text);
    }
    let g = &n["git"];
    if g.is_object() {
        out["git"] = json!({"branch":g["branch"],"upstream":g["upstream"],"ahead":g["ahead"],"behind":g["behind"],
            "dirty":g["dirty"],"commits":g["commits"],"lastCommitAt":g["lastCommitAt"],
            "remotes":array(&g["remotes"]).iter().map(|r| r["web"].clone()).collect::<Vec<_>>()});
    }
    let all = array(&n["tasks"]);
    let open: Vec<&Value> = all.iter().filter(|t| t["done"] == false).collect();
    out["openTasks"] = json!(open.len());
    match tasks {
        Tasks::All => {
            out["tasks"] = json!(all);
            if !n["notes"].is_null() {
                out["notes"] = n["notes"].clone();
            }
        }
        Tasks::Open => out["tasks"] = json!(open),
        Tasks::Count => {}
    }
    out
}
/// The one checkbox of a project whose text holds `query`, among those `wanted` accepts.
fn checkbox(node: &Value, query: &str, wanted: impl Fn(&Value) -> bool) -> Result<Value, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Err("Give some of the to-do's text".into());
    }
    let matches: Vec<_> = array(&node["tasks"])
        .into_iter()
        .filter(|t| t["kind"] == "check" && wanted(t) && string(t, "text").to_lowercase().contains(&query))
        .collect();
    match matches.as_slice() {
        [task] => Ok(task.clone()),
        [] => Err("No checkbox matches that text".into()),
        _ => Err("More than one checkbox matches; use more of its text".into()),
    }
}
/// Every open to-do and report item, the most pressing projects first: priority, then the nearest deadline,
/// then the latest activity.
fn open_items(service: &mut Service, args: &Value) -> Result<Value, String> {
    const LIMIT: usize = 300;
    let s = service.snapshot()?;
    let only = match args["project"].as_str().filter(|p| !p.is_empty()) {
        Some(raw) => Some(string(&project(service, raw)?, "path").to_owned()),
        None => None,
    };
    let kind = string(args, "kind");
    let words: Vec<String> = string(args, "query").split_whitespace().map(str::to_lowercase).collect();
    let fits = |text: &str| {
        let text = text.to_lowercase();
        words.iter().all(|w| text.contains(w))
    };
    let rank = |n: &Value| match string(&n["meta"], "priority") {
        "high" => 0,
        "medium" => 1,
        "low" => 3,
        _ => 2,
    };
    let mut nodes: Vec<&Value> = s["nodes"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, n)| n)
        .filter(|n| n["kind"] == "project" && n["archived"] != true)
        .filter(|n| only.as_deref().is_none_or(|p| string(n, "path") == p))
        .collect();
    nodes.sort_by(|a, b| {
        let deadline = |n: &Value| string(&n["meta"], "deadline").to_owned();
        let soonest = |n: &Value| if deadline(n).is_empty() { "9999".to_owned() } else { deadline(n) };
        (rank(a), soonest(a), std::cmp::Reverse(string(&a["lastActivity"], "at"))).cmp(&(
            rank(b),
            soonest(b),
            std::cmp::Reverse(string(&b["lastActivity"], "at")),
        ))
    });
    let mut items = Vec::new();
    if kind.is_empty() || kind == "todo" {
        for n in &nodes {
            for t in array(&n["tasks"]).iter().filter(|t| t["done"] == false) {
                if !fits(&format!("{} {}", string(t, "text"), string(n, "name"))) {
                    continue;
                }
                let mut item = json!({"kind":"todo","project":n["path"],"projectName":n["name"],"text":t["text"],
                    "file":t["file"],"line":t["line"]});
                for key in ["section"] {
                    if !string(t, key).is_empty() {
                        item[key] = t[key].clone();
                    }
                }
                if t["kind"] == "list" {
                    item["note"] =
                        json!("A list item under a TODO heading, not a checkbox: edit its file to change it");
                }
                for key in ["priority", "deadline"] {
                    if !string(&n["meta"], key).is_empty() {
                        item[key] = n["meta"][key].clone();
                    }
                }
                items.push(item);
            }
        }
    }
    if kind.is_empty() || kind == "report" {
        for r in array(&s["reports"]) {
            let projects = array(&r["projects"]);
            if only.as_deref().is_some_and(|p| !projects.iter().any(|x| x.as_str() == Some(p))) {
                continue;
            }
            for (i, text) in array(&r["open"]).iter().enumerate() {
                if !fits(&format!("{} {}", text.as_str().unwrap_or(""), string(&r, "title"))) {
                    continue;
                }
                items.push(json!({"kind":"report","report":r["id"],"reportTitle":r["title"],"date":r["date"],
                    "item":i + 1,"text":text,"projects":projects,"file":r["file"]}));
            }
            let shown = array(&r["open"]).len() as u64;
            if r["openCount"].as_u64().unwrap_or(0) > shown && words.is_empty() {
                items.push(json!({"kind":"report","report":r["id"],"reportTitle":r["title"],"date":r["date"],
                    "more":r["openCount"].as_u64().unwrap_or(0) - shown,
                    "note":"More open items than shown; close some, or read the report's file for the rest"}));
            }
        }
    }
    let todos = items.iter().filter(|i| i["kind"] == "todo").count();
    let more = items.len() > LIMIT;
    items.truncate(LIMIT);
    Ok(
        json!({"items":items,"todos":todos,"reportItems":array(&s["reports"]).iter().filter_map(|r| r["openCount"].as_u64()).sum::<u64>(),"more":more}),
    )
}
fn prompts() -> Vec<Prompt> {
    vec![
        Prompt::new(
            "review",
            Some("Go through everything open across the projects with the user and agree on what to do next"),
            None,
        ),
        Prompt::new(
            "work_on",
            Some("Work on one open to-do in its project"),
            Some(vec![
                PromptArgument::new("project")
                    .with_description("Absolute path, ~/path, or unique project name")
                    .with_required(true),
                PromptArgument::new("task").with_description("Words from the to-do's text").with_required(true),
            ]),
        ),
    ]
}
fn prompt(service: &mut Service, name: &str, args: &Value) -> Result<String, String> {
    let s = service.snapshot()?;
    match name {
        "review" => Ok(laci_core::assistant::review(&service.env, &s)),
        "work_on" => {
            let node = project(service, string(args, "project"))?;
            let task = checkbox(&node, string(args, "task"), |t| t["done"] == false)?;
            Ok(laci_core::assistant::work_on(&service.env, &s, &node, &task))
        }
        _ => Err("Unknown prompt".into()),
    }
}
fn validate_args(name: &str, args: &Value) -> Result<(), String> {
    let tool = tools().into_iter().find(|t| t.name == name).ok_or("Unknown tool")?;
    let schema = Value::Object((*tool.input_schema).clone());
    for key in array(&schema["required"]).iter().filter_map(Value::as_str) {
        if args.get(key).is_none() {
            return Err(format!("Missing {key}"));
        }
    }
    for (key, value) in args.as_object().ok_or("Arguments must be an object")? {
        let rule = &schema["properties"][key];
        if rule.is_null() {
            return Err(format!("Unknown argument {key}"));
        }
        let valid = match string(rule, "type") {
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            _ => false,
        };
        if !valid {
            return Err(format!("Invalid {key}: expected {}", string(rule, "type")));
        }
        if let Some(choices) = rule["enum"].as_array()
            && !choices.contains(value)
        {
            return Err(format!("Invalid {key}"));
        }
        if let Some(text) = value.as_str() {
            let length = text.chars().count();
            if rule["minLength"].as_u64().is_some_and(|n| length < n as usize)
                || rule["maxLength"].as_u64().is_some_and(|n| length > n as usize)
            {
                return Err(format!("Invalid length for {key}"));
            }
        }
    }
    Ok(())
}
fn tools() -> Vec<Tool> {
    let text = json!({"type":"string"});
    let boolean = json!({"type":"boolean"});
    let project = json!({"type":"string","description":"Absolute path, ~/path, or unique project name"});
    let definitions = [
        (
            "list_projects",
            "List projects, filtered by status, work at risk, or search words",
            json!({"filter":{"type":"string","enum":["all","active","idle","dormant","archived","at_risk"]},"query":text}),
            vec![],
        ),
        (
            "list_reports",
            "Reports agents wrote after earlier sessions, newest first: summary, open items and the file to read",
            json!({"project":project,"query":{"type":"string","minLength":1,"maxLength":200,"description":"Words that must all appear in the report"}}),
            vec![],
        ),
        (
            "project_details",
            "Git, stack, README, to-dos, agent history, session reports and archive plan",
            json!({"project":project}),
            vec!["project"],
        ),
        ("needs_attention", "Work at risk, deadlines, open tasks and warnings", json!({}), vec![]),
        (
            "open_items",
            "Every open to-do and every open item of the session reports, the most pressing projects first",
            json!({"project":project,"kind":{"type":"string","enum":["","todo","report"]},"query":{"type":"string","maxLength":200,"description":"Words that must all appear"}}),
            vec![],
        ),
        (
            "edit_task",
            "Rewrite a checkbox's text, keeping whether it is done",
            json!({"project":project,"text":{"type":"string","description":"Words from its current text"},"to":{"type":"string","minLength":1,"maxLength":300}}),
            vec!["project", "text", "to"],
        ),
        (
            "delete_task",
            "Delete a checkbox from the project's .laci.md (the Log can undo it)",
            json!({"project":project,"text":{"type":"string","description":"Words from its text"}}),
            vec!["project", "text"],
        ),
        (
            "move_task",
            "Move an open checkbox from one project's .laci.md to another's Next",
            json!({"project":project,"text":{"type":"string","description":"Words from its text"},"to_project":project}),
            vec!["project", "text", "to_project"],
        ),
        (
            "close_report_item",
            "Close an open item of a session report as done, dropped or moved, or open it again. Laci keeps this itself and never writes to the reports folder",
            json!({"report":{"type":"string","description":"The report's id (its file name), or words from its title"},
                "item":{"type":"string","description":"The item's number among the report's open items (closed ones, for state open), or words from it"},
                "state":{"type":"string","enum":["","done","dropped","moved","open"]},
                "note":{"type":"string","maxLength":300}}),
            vec!["report", "item"],
        ),
        ("tidy_suggestions", "Preview cleanup suggestions and their exact operations", json!({}), vec![]),
        (
            "set_project_fields",
            "Set status, priority or deadline in .laci.md",
            json!({"project":project,"status":{"type":"string","enum":["","active","idle","dormant","idea","paused","done","archived"]},"priority":{"type":"string","enum":["","high","medium","low"]},"deadline":text}),
            vec!["project"],
        ),
        (
            "add_next_step",
            "Add a checkbox under Next in .laci.md",
            json!({"project":project,"text":{"type":"string","minLength":1,"maxLength":300}}),
            vec!["project", "text"],
        ),
        (
            "complete_task",
            "Tick or untick a checkbox in its source file",
            json!({"project":project,"text":text,"done":boolean}),
            vec!["project", "text"],
        ),
        (
            "write_notes",
            "Append or replace Notes in .laci.md",
            json!({"project":project,"notes":{"type":"string","maxLength":20000},"mode":{"type":"string","enum":["append","replace"]}}),
            vec!["project", "notes"],
        ),
        (
            "move_project",
            "Move a project with its agent history; requires confirm after preview",
            json!({"project":project,"destination":text,"confirm":boolean}),
            vec!["project", "destination"],
        ),
        (
            "archive_project",
            "Archive a project with its agent history; requires confirm after preview",
            json!({"project":project,"destination":text,"trash_heavy":boolean,"confirm":boolean}),
            vec!["project"],
        ),
        (
            "delete_project",
            "Move a project to system Trash only after live remote Git verification; requires confirm after preview",
            json!({"project":project,"confirm":boolean}),
            vec!["project"],
        ),
        (
            "apply_suggestion",
            "Apply a Tidy suggestion; requires confirm after preview",
            json!({"id":text,"confirm":boolean,"recovery":{"type":"string","enum":["quarantine","trash"],"description":"Orphan history only; Quarantine is the default and supports Laci Undo. System Trash recovery uses the file manager."}}),
            vec!["id"],
        ),
        (
            "create_project",
            "Create empty, template or cloned project; requires confirm after preview",
            json!({"parent":text,"name":text,"from":{"type":"string","enum":["empty","template","clone"]},"summary":{"type":"string","maxLength":300},"template":text,"url":text,"remote":{"type":"string","enum":["none","github","gitlab","both"]},"confirm":boolean}),
            vec!["parent", "name"],
        ),
        ("recent_changes", "Read the change log and which entries can be undone", json!({}), vec![]),
        (
            "undo_change",
            "Undo a journaled move or a current Log entry; requires confirm after preview",
            json!({"id":text,"confirm":boolean}),
            vec!["id"],
        ),
    ];
    definitions
        .into_iter()
        .map(|(name, description, properties, required)| {
            let schema =
                json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
            let readonly = [
                "list_projects",
                "list_reports",
                "project_details",
                "needs_attention",
                "open_items",
                "tidy_suggestions",
                "recent_changes",
            ]
            .contains(&name);
            Tool::new_with_raw(name, Some(description.into()), schema.as_object().cloned().unwrap_or_default())
                .with_annotations(
                    ToolAnnotations::new()
                        .read_only(readonly)
                        .destructive(
                            ["move_project", "archive_project", "delete_project", "apply_suggestion", "undo_change"]
                                .contains(&name),
                        )
                        .open_world(matches!(name, "create_project" | "delete_project")),
                )
        })
        .collect()
}
