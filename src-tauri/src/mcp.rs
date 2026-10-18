//! MCP over stdio; the window toolkit is never started on this path.
use laci_core::{
    env::Env,
    paths, platform, scan,
    service::{Service, array, string},
};
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt, model::*, service::RequestContext};
use serde_json::{Value, json};
use std::{
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

struct Mcp {
    engine: Arc<Mutex<(Service, Instant)>>,
}
impl ServerHandler for Mcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_prompts().build())
            .with_server_info(Implementation::new("laci",env!("CARGO_PKG_VERSION")))
            .with_instructions("Use laci for moving projects so their agent history travels with them. Destructive tools return a plan first; show it to the user before calling with confirm: true. Lists answer a page at a time: when more is true, call again with offset. open_items lists the open to-dos and report items, the most pressing projects first; change to-dos with complete_task, edit_task, delete_task and move_task, and close report items with close_report_item, so each change shows in Laci's Log with Undo. recent_changes reads the Log, narrowed by project or words, and gives the ids undo_change needs. Reports from earlier sessions are in list_reports and project_details; read a report's file for its full text. The review prompt goes through everything open with the user.")
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
        // Compact JSON: indentation alone made answers a fifth to a third longer.
        let result = match result {
            Ok(Ok(value)) => {
                CallToolResult::success(vec![ContentBlock::text(serde_json::to_string(&value).unwrap_or_default())])
            }
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
            Ok(Page::of(args, 30).answer("projects", nodes))
        }
        "project_details" => {
            let n = project(service, string(args, "project"))?;
            let s = service.snapshot()?;
            details(&service.env, &s, n)
        }
        "list_reports" => {
            let under = match args["project"].as_str() {
                Some(raw) => Some(std::path::PathBuf::from(string(&project(service, raw)?, "path"))),
                None => None,
            };
            let s = service.snapshot()?;
            let page = Page::of(args, 10);
            let mut out = laci_core::reports::list(
                &service.env,
                &s,
                under.as_deref(),
                args["query"].as_str(),
                page.offset,
                page.limit,
            )?;
            out["offset"] = json!(page.offset);
            Ok(out)
        }
        "needs_attention" => {
            let s = service.snapshot()?;
            // A check the user muted is listed with the project but never counted, as in the app.
            let live = |n: &Value| array(&n["issues"]).into_iter().filter(|i| i["muted"] != true).collect::<Vec<_>>();
            let worst = |n: &Value| {
                live(n)
                    .iter()
                    .map(|i| match string(i, "severity") {
                        "high" => 0,
                        "med" => 1,
                        _ => 2,
                    })
                    .min()
                    .unwrap_or(3)
            };
            let soonest = |n: &Value| match string(&n["meta"], "deadline") {
                "" => "9999".to_owned(),
                day => day.to_owned(),
            };
            let mut nodes: Vec<&Value> = s["nodes"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(_, n)| n)
                .filter(|n| !live(n).is_empty() || array(&n["tasks"]).iter().any(|t| t["done"] == false))
                .collect();
            // Work that could be lost first, then the nearest deadline, then the latest activity.
            nodes.sort_by(|a, b| {
                (worst(a), soonest(a), std::cmp::Reverse(string(&a["lastActivity"], "at"))).cmp(&(
                    worst(b),
                    soonest(b),
                    std::cmp::Reverse(string(&b["lastActivity"], "at")),
                ))
            });
            // The to-dos themselves are in open_items; repeating them here doubled what a review reads first.
            let projects = nodes.into_iter().map(|n| compact(n, Tasks::Count)).collect();
            let mut out = Page::of(args, 30).answer("projects", projects);
            out["warnings"] = s["warnings"].clone();
            Ok(out)
        }
        "tidy_suggestions" => {
            let s = service.snapshot()?;
            // Read in place: the proposals of a busy home are hundreds of KB, and a page keeps a few KB of them.
            let suggestions = s["proposals"].as_array().into_iter().flatten().map(suggestion).collect();
            Ok(Page::of(args, 30).answer("suggestions", suggestions))
        }
        "recent_changes" => {
            let log = service.request_as("log", &json!({}), "agent")?;
            let under = match args["project"].as_str().filter(|p| !p.is_empty()) {
                Some(raw) => Some(match project(service, raw) {
                    Ok(node) => string(&node, "path").to_owned(),
                    // A moved or deleted project is gone from the scan, while its changes stay in the Log. On Windows
                    // a path can also start with a drive or a share.
                    Err(_) if raw.starts_with('/') || raw.starts_with('~') || Path::new(raw).is_absolute() => {
                        paths::expand(raw, &service.env.home).to_string_lossy().into_owned()
                    }
                    Err(_) => {
                        return Err(
                            "Unknown project. Use its path, or the path it had before it moved or was removed.".into(),
                        );
                    }
                }),
                None => None,
            };
            let s = service.snapshot()?;
            let home = service.env.home.clone();
            // A change belongs to a project when it happened there: its own path, a step that moved something in or
            // out (a move keeps the path it started from), or a closed item of a report linked to the project.
            let touches = |e: &Value, p: &str| {
                let inside = |raw: &str| !raw.is_empty() && paths::expand(raw, &home).starts_with(p);
                inside(string(e, "path"))
                    || array(&e["steps"]).iter().any(|step| inside(string(step, "from")) || inside(string(step, "to")))
                    || (e["undo"]["type"] == "report-item"
                        && array(&s["reports"]).iter().any(|r| {
                            r["id"] == e["undo"]["report"]
                                && array(&r["projects"])
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .any(|x| Path::new(x).starts_with(p))
                        }))
            };
            let words = words(args);
            let read = array(&log["entries"]);
            let searched = read.len();
            let entries: Vec<Value> = read
                .into_iter()
                .filter(|e| under.as_deref().is_none_or(|p| touches(e, p)))
                .filter(|e| args["undoable"] != true || e["canUndo"] == true)
                .filter(|e| {
                    let text = format!("{} {} {}", string(e, "title"), string(e, "detail"), string(e, "path"));
                    has_words(&words, &text)
                })
                .map(|e| change(&e))
                .collect();
            let mut out = Page::of(args, 30).answer("entries", entries);
            // total counts matches among the entries read: the newest 300, or fewer when they are long.
            out["searched"] = json!(searched);
            out["file"] = log["file"].clone();
            Ok(out)
        }
        "undo_change" => {
            let id = string(args, "id");
            let entries = array(&service.request_as("log", &json!({}), "agent")?["entries"]);
            let entry = entries.iter().find(|e| e["id"] == id);
            if args["confirm"] != true {
                // A move can be named by its journal id, which is what `move_project` returns.
                let shown = entry
                    .or_else(|| entries.iter().find(|e| e["journal"] == id))
                    .ok_or("Unknown change. Find its id with recent_changes, narrowed by project or words.")?;
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
                return Err(format!("Choose Quarantine or {}", platform::BIN.bare));
            }
            if args["confirm"] != true {
                return Ok(
                    json!({"plan":preview(&proposal, args),"selectedRecovery":recovery,"hint":if recovery=="trash" {format!("Orphan history will move to {}; restore it through the file manager. Show the exact source paths before confirming.",platform::BIN.bare)}else{"Nothing has changed yet. Show this plan to the user; if they agree, call again with confirm: true.".into()}}),
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
            Ok(compact(
                &service.request_as("notes", &json!({"id":node["id"],"text":text}), "agent")?,
                Tasks::AllWithNotes,
            ))
        }
        _ => Err("Unknown tool".into()),
    }
}
use std::path::Path;

/// Which of a project's to-dos a compact answer carries.
#[derive(Clone, Copy)]
enum Tasks {
    /// All of them: the answer to a change.
    All,
    /// All of them, with the notes: the answer to write_notes. Other changes leave the notes out, which were
    /// most of each answer on a project with long notes.
    AllWithNotes,
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
    out["openTasks"] = json!(all.iter().filter(|t| t["done"] == false).count());
    match tasks {
        Tasks::All | Tasks::AllWithNotes => {
            if matches!(tasks, Tasks::AllWithNotes) && !n["notes"].is_null() {
                out["notes"] = n["notes"].clone();
            }
            out["tasks"] = json!(all);
        }
        Tasks::Count => {}
    }
    out
}
/// One page of a list, from the `limit` and `offset` arguments. validate_args has already checked their ranges.
struct Page {
    offset: usize,
    limit: usize,
}
impl Page {
    fn of(args: &Value, default: usize) -> Self {
        Self {
            offset: args["offset"].as_u64().unwrap_or(0) as usize,
            limit: args["limit"].as_u64().map_or(default, |n| n as usize),
        }
    }
    /// `{<key>: this page, total, offset, more}`, so an agent knows whether to ask for the next page.
    fn answer(&self, key: &str, items: Vec<Value>) -> Value {
        let total = items.len();
        let shown: Vec<Value> = items.into_iter().skip(self.offset).take(self.limit).collect();
        let more = self.offset + shown.len() < total;
        json!({key:shown,"total":total,"offset":self.offset,"more":more})
    }
}
fn words(args: &Value) -> Vec<String> {
    string(args, "query").split_whitespace().map(str::to_lowercase).collect()
}
fn has_words(words: &[String], text: &str) -> bool {
    let text = text.to_lowercase();
    words.iter().all(|w| text.contains(w.as_str()))
}
/// `text` cut to at most `max` characters, marked with an ellipsis when cut.
fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}
/// A Log entry as an agent reads it: what happened and whether it can be undone, without the stored undo data
/// (a notes change keeps the whole previous notes there, which made the Log too long to read).
fn change(e: &Value) -> Value {
    let mut out = json!({});
    for key in ["id", "at", "by", "title", "path", "canUndo", "journal", "undoes", "error"] {
        if !e[key].is_null() {
            out[key] = e[key].clone();
        }
    }
    if let Some(detail) = e["detail"].as_str() {
        out["detail"] = json!(clip(detail, 300));
    }
    if e["state"].as_str().is_some_and(|state| state != "applied") {
        out["state"] = e["state"].clone();
    }
    if e["superseded"] == true {
        out["superseded"] = json!(true);
    }
    // The first steps name what moved where or went to the Trash; a longer list is only counted.
    if let Some(steps) = e["steps"].as_array() {
        out["steps"] = json!(steps.iter().take(5).collect::<Vec<_>>());
        if steps.len() > 5 {
            out["moreSteps"] = json!(steps.len() - 5);
        }
    }
    out
}
/// A Tidy suggestion as an agent reads it in the list: what it is, why it is offered and its first operations. The
/// preview that apply_suggestion gives lists all of them, a page at a time.
fn suggestion(p: &Value) -> Value {
    // Two operations keep a page of 30 inside the size budget, even when every suggestion is a long group.
    const SHOWN: usize = 2;
    let mut out = json!({});
    for key in ["id", "category", "title", "confidence", "nodeId"] {
        if !p[key].is_null() {
            out[key] = p[key].clone();
        }
    }
    if let Some(why) = p["why"].as_str() {
        out["why"] = json!(clip(why, 300));
    }
    if p["blocked"] == true {
        out["blocked"] = json!(true);
    }
    // A group of orphan history files has one operation per file; the rest of a long list is only counted.
    let ops = p["ops"].as_array().map(Vec::as_slice).unwrap_or_default();
    out["ops"] = json!(ops.iter().take(SHOWN).map(operation).collect::<Vec<_>>());
    if ops.len() > SHOWN {
        out["moreOps"] = json!(ops.len() - SHOWN);
    }
    out
}
/// A suggestion as apply_suggestion shows it before confirm: its operations a page at a time. The action and the
/// review token (a move and a hash for each history file of a group) stay out: they make a long group unreadable,
/// and applying checks them against the scan.
fn preview(proposal: &Value, args: &Value) -> Value {
    let mut plan = suggestion(proposal);
    let page = Page::of(args, 40).answer("ops", array(&proposal["ops"]).iter().map(operation).collect());
    plan.as_object_mut().map(|fields| fields.remove("moreOps"));
    for key in ["ops", "total", "offset", "more"] {
        plan[key] = page[key].clone();
    }
    plan
}
/// One operation of a suggestion, with any text over 300 characters cut: a half-done move names every old path of a
/// session folder in one `from`.
fn operation(op: &Value) -> Value {
    let mut op = op.clone();
    for value in op.as_object_mut().into_iter().flat_map(|fields| fields.values_mut()) {
        if let Some(text) = value.as_str() {
            *value = json!(clip(text, 300));
        }
    }
    op
}
/// An agent session or item, as project_details lists it: enough to tell it apart and resume it, without its
/// prompts and replies. One with no title keeps the start of its first prompt.
fn brief(session: &Value) -> Value {
    let mut out = json!({});
    for key in [
        "id",
        "sessionId",
        "provider",
        "connector",
        "title",
        "at",
        "startedAt",
        "endedAt",
        "prompts",
        "filesChanged",
        "branch",
        "cwd",
        "file",
        "model",
        "sourceKind",
        "resumeCapability",
        "backup",
    ] {
        if !session[key].is_null() {
            out[key] = session[key].clone();
        }
    }
    if out["title"].is_null()
        && let Some(prompt) = session["firstPrompt"].as_str()
    {
        out["firstPrompt"] = json!(clip(prompt, 120));
    }
    out
}
/// The newest `max` of `items` by their `at` time.
fn newest(mut items: Vec<Value>, max: usize) -> Vec<Value> {
    items.sort_by(|a, b| string(b, "at").cmp(string(a, "at")));
    items.truncate(max);
    items
}
/// project_details: the project without the parts that made it too long for an agent. The README is cut to its
/// start (the file is named for the rest), Claude history folders lose their per-session lists, and only the newest
/// sessions and agent items are listed, with how many there are in all.
fn details(env: &Env, s: &Value, mut n: Value) -> Result<Value, String> {
    const README: usize = 2000;
    const NEWEST: usize = 10;
    if let Some(raw) = n["readme"]["raw"].as_str() {
        let cut = raw.chars().count() > README;
        n["readme"]["text"] = json!(clip(raw, README));
        n["readme"]["truncated"] = json!(cut);
    }
    if let Some(readme) = n["readme"].as_object_mut() {
        readme.remove("raw");
    }
    let path = string(&n, "path").to_owned();
    // Conversations, as the app counts them: a subagent's log belongs to the conversation that ran it.
    let sessions: Vec<Value> = array(&s["sessions"])
        .into_iter()
        .filter(|session| session["sourceKind"] != "subagent")
        .filter(|session| session["cwd"].as_str().is_some_and(|cwd| Path::new(cwd).starts_with(&path)))
        .map(|session| brief(&session))
        .collect();
    n["agentSessionCount"] = json!(sessions.len());
    n["agentSessions"] = json!(newest(sessions, NEWEST));
    n["sessions"] = json!(
        array(&n["agents"]["claude"])
            .iter()
            .filter_map(Value::as_str)
            .map(|id| {
                let mut record = s["claude"][id].clone();
                let logs = array(&record["sessions"]).len();
                record["sessionCount"] =
                    json!(logs.saturating_sub(record["subagentLogs"].as_u64().unwrap_or(0) as usize));
                if let Some(record) = record.as_object_mut() {
                    for heavy in ["sessions", "gone", "cwds"] {
                        record.remove(heavy);
                    }
                }
                record
            })
            .collect::<Vec<_>>()
    );
    let items: Vec<Value> =
        array(&n["agents"]["items"]).iter().filter_map(Value::as_str).map(|id| brief(&s["items"][id])).collect();
    n["agentItemCount"] = json!(items.len());
    n["agentItems"] = json!(newest(items, NEWEST));
    // Every item's id again; agentItems and agentItemCount say the same in less.
    if let Some(agents) = n["agents"].as_object_mut() {
        agents.remove("items");
    }
    if s["reportsDir"].is_object() {
        let mut reports = laci_core::reports::list(env, s, Some(Path::new(&path)), None, 0, 3)?["reports"].clone();
        for report in reports.as_array_mut().into_iter().flatten() {
            if let Some(report) = report.as_object_mut() {
                report.remove("projects");
                report.remove("sessions");
            }
        }
        n["reports"] = reports;
    }
    Ok(n)
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
/// The open to-dos and report items, the most pressing projects first: priority, then the nearest deadline,
/// then the latest activity. A page at a time; each report's title, date, file and projects are listed once, in
/// `reports`, instead of on every item.
fn open_items(service: &mut Service, args: &Value) -> Result<Value, String> {
    let s = service.snapshot()?;
    let only = match args["project"].as_str().filter(|p| !p.is_empty()) {
        Some(raw) => Some(string(&project(service, raw)?, "path").to_owned()),
        None => None,
    };
    let kind = string(args, "kind");
    let words = words(args);
    let fits = |text: &str| has_words(&words, text);
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
    let mut reports = serde_json::Map::new();
    let mut hidden_items = 0;
    if kind.is_empty() || kind == "report" {
        for r in array(&s["reports"]) {
            let projects = array(&r["projects"]);
            if only.as_deref().is_some_and(|p| !projects.iter().any(|x| x.as_str() == Some(p))) {
                continue;
            }
            let mut listed = false;
            for (i, text) in array(&r["open"]).iter().enumerate() {
                if !fits(&format!("{} {}", text.as_str().unwrap_or(""), string(&r, "title"))) {
                    continue;
                }
                // A string, as close_report_item takes it.
                items.push(json!({"kind":"report","report":r["id"],"item":(i + 1).to_string(),"text":text}));
                listed = true;
            }
            // A report lists its first open items. Words can't match the rest, unless the title alone holds them all.
            let shown = array(&r["open"]).len() as u64;
            let hidden = if words.is_empty() || fits(string(&r, "title")) {
                r["openCount"].as_u64().unwrap_or(0).saturating_sub(shown)
            } else {
                0
            };
            if !listed && hidden > 0 {
                // A report whose first items are all closed shows none of the rest; one row stands for them.
                items.push(json!({"kind":"report","report":r["id"],"hidden":hidden}));
                listed = true;
            }
            if !listed {
                continue;
            }
            let mut detail = json!({"title":r["title"],"date":r["date"],"file":r["file"],"projects":projects});
            if hidden > 0 {
                detail["hidden"] = json!(hidden);
                hidden_items += hidden as usize;
            }
            reports.insert(string(&r, "id").to_owned(), detail);
        }
    }
    let todos = items.iter().filter(|i| i["kind"] == "todo").count();
    let report_items = items.len() - todos + hidden_items;
    let mut out = Page::of(args, 50).answer("items", items);
    let on_page: std::collections::HashSet<String> =
        array(&out["items"]).iter().filter_map(|i| i["report"].as_str().map(str::to_owned)).collect();
    reports.retain(|id, _| on_page.contains(id));
    if reports.values().any(|r| r["hidden"].is_u64()) {
        out["note"] = json!(
            "A report shows its first open items; reports[id].hidden counts the rest. Close some, or read the report's file"
        );
    }
    out["reports"] = Value::Object(reports);
    out["todos"] = json!(todos);
    out["reportItems"] = json!(report_items);
    Ok(out)
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
            "integer" => value.is_i64() || value.is_u64(),
            _ => false,
        };
        if !valid {
            return Err(format!("Invalid {key}: expected {}", string(rule, "type")));
        }
        if let Some(choices) = rule["enum"].as_array()
            && !choices.contains(value)
        {
            let named: Vec<String> = choices.iter().map(Value::to_string).collect();
            return Err(format!("Invalid {key}: use one of {}", named.join(", ")));
        }
        // A whole number past i64 is still a number; it counts as too large rather than skipping the check.
        if let Some(number) = value.as_i64().or_else(|| value.as_u64().map(|_| i64::MAX)) {
            let (low, high) = (rule["minimum"].as_i64(), rule["maximum"].as_i64());
            if low.is_some_and(|n| number < n) || high.is_some_and(|n| number > n) {
                return Err(match (low, high) {
                    (Some(low), Some(high)) => format!("Invalid {key}: use {low} to {high}"),
                    (Some(low), None) => format!("Invalid {key}: use {low} or more"),
                    _ => format!("Invalid {key}: too large"),
                });
            }
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
/// What delete_project says it does, with the system's own name for its bin.
static DELETE_PROJECT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "Move a project to {} only after live remote Git verification; requires confirm after preview",
        platform::BIN.bare
    )
});
fn tools() -> Vec<Tool> {
    let text = json!({"type":"string"});
    let boolean = json!({"type":"boolean"});
    let project = json!({"type":"string","description":"Absolute path, ~/path, or unique project name"});
    let limit = |default: u64, max: u64| json!({"type":"integer","minimum":1,"maximum":max,"description":format!("How many to return (default {default})")});
    let offset =
        json!({"type":"integer","minimum":0,"description":"How many to skip; use when the last answer said more"});
    let definitions = [
        (
            "list_projects",
            "List projects, filtered by status, work at risk, or search words; the most recently active first",
            json!({"filter":{"type":"string","enum":["all","active","idle","dormant","archived","at_risk"]},"query":text,
                "limit":limit(30, 200),"offset":offset}),
            vec![],
        ),
        (
            "list_reports",
            "Reports agents wrote after earlier sessions, newest first: summary, open items and the file to read",
            json!({"project":project,"query":{"type":"string","minLength":1,"maxLength":200,"description":"Words that must all appear in the report"},
                "limit":limit(10, 50),"offset":offset}),
            vec![],
        ),
        (
            "project_details",
            "Git, stack, the start of the README, to-dos, notes, the newest agent sessions, session reports and archive plan",
            json!({"project":project}),
            vec!["project"],
        ),
        (
            "needs_attention",
            "Work at risk, deadlines, open to-do counts and warnings, the worst first; the to-dos themselves are in open_items",
            json!({"limit":limit(30, 200),"offset":offset}),
            vec![],
        ),
        (
            "open_items",
            "Open to-dos and open items of the session reports, the most pressing projects first, a page at a time",
            json!({"project":project,"kind":{"type":"string","enum":["","todo","report"]},"query":{"type":"string","maxLength":200,"description":"Words that must all appear"},
                "limit":limit(50, 300),"offset":offset}),
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
                "item":{"type":"string","description":"The item's number among the report's open items (closed ones, for state open), counted from 1, or words from it"},
                "state":{"type":"string","enum":["","done","dropped","moved","open"]},
                "note":{"type":"string","maxLength":300}}),
            vec!["report", "item"],
        ),
        (
            "tidy_suggestions",
            "Cleanup suggestions, a page at a time: why each is offered and its first operations. apply_suggestion without confirm lists all the operations of one suggestion, a page at a time",
            json!({"limit":limit(30, 100),"offset":offset}),
            vec![],
        ),
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
        ("delete_project", DELETE_PROJECT.as_str(), json!({"project":project,"confirm":boolean}), vec!["project"]),
        (
            "apply_suggestion",
            "Apply a Tidy suggestion; requires confirm after preview. The preview lists its operations a page at a time",
            json!({"id":text,"confirm":boolean,"recovery":{"type":"string","enum":["quarantine","trash"],"description":format!("Orphan history only; Quarantine is the default and supports Laci Undo. {} recovery uses the file manager.",platform::BIN.name)},
                "limit":limit(40, 100),"offset":offset}),
            vec!["id"],
        ),
        (
            "create_project",
            "Create empty, template or cloned project; requires confirm after preview",
            json!({"parent":text,"name":text,"from":{"type":"string","enum":["empty","template","clone"]},"summary":{"type":"string","maxLength":300},"template":text,"url":text,"remote":{"type":"string","enum":["none","github","gitlab","both"]},"confirm":boolean}),
            vec!["parent", "name"],
        ),
        (
            "recent_changes",
            "Read the change log, newest first, and which entries can be undone. It searches the newest entries, up to 300; searched says how many",
            json!({"project":{"type":"string","description":"Only changes under this project: absolute path, ~/path, or unique project name"},
                "query":{"type":"string","maxLength":200,"description":"Words that must all appear in the title, detail or path"},
                "undoable":{"type":"boolean","description":"Only changes that can still be undone"},
                "limit":limit(30, 100),"offset":offset}),
            vec![],
        ),
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
                        // A delete or a rewrite isn't additive, even with Undo in the Log.
                        .destructive(
                            [
                                "move_project",
                                "archive_project",
                                "delete_project",
                                "apply_suggestion",
                                "undo_change",
                                "delete_task",
                                "edit_task",
                                "move_task",
                                "write_notes",
                            ]
                            .contains(&name),
                        )
                        .open_world(matches!(name, "create_project" | "delete_project")),
                )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_number_arguments_are_checked_against_their_range() {
        assert!(validate_args("recent_changes", &json!({"limit":5,"offset":0})).is_ok());
        for bad in [
            json!({"limit":0}),
            json!({"limit":101}),
            json!({"limit":"5"}),
            json!({"limit":2.5}),
            json!({"limit":u64::MAX}),
            json!({"offset":-1}),
        ] {
            let error = validate_args("recent_changes", &bad).unwrap_err();
            assert!(error.starts_with("Invalid limit") || error.starts_with("Invalid offset"), "{bad}: {error}");
        }
        assert!(validate_args("tidy_suggestions", &json!({"limit":100,"offset":0})).is_ok());
        for bad in [json!({"limit":0}), json!({"limit":101}), json!({"offset":-1}), json!({"query":"orphan"})] {
            assert!(validate_args("tidy_suggestions", &bad).is_err(), "{bad}");
        }
        // The item number is a string, as open_items gives it: clients that keep to a subset of JSON Schema accept
        // one type per argument.
        assert!(validate_args("close_report_item", &json!({"report":"r","item":"2"})).is_ok());
        assert!(validate_args("close_report_item", &json!({"report":"r","item":"some words"})).is_ok());
        let error = validate_args("close_report_item", &json!({"report":"r","item":2})).unwrap_err();
        assert!(error.contains("expected string"), "{error}");
        let error = validate_args("set_project_fields", &json!({"project":"p","status":"nope"})).unwrap_err();
        assert!(error.contains("\"paused\""), "{error}");
    }

    #[test]
    fn a_log_entry_is_read_without_its_undo_data() {
        let entry = json!({"id":"a","at":"2026-10-16T00:00:00.000Z","by":"agent","title":"Edited the notes of alpha",
            "key":"notes:/p","path":"/p","detail":"é".repeat(400),"state":"applied","superseded":false,"canUndo":true,
            "undo":{"type":"notes","text":"y".repeat(18_000)},"steps":[1,2]});
        let shown = change(&entry);
        for gone in ["undo", "key", "state", "superseded", "moreSteps"] {
            assert!(shown.get(gone).is_none(), "{gone}");
        }
        assert_eq!(shown["canUndo"], true);
        assert_eq!(shown["steps"], json!([1, 2]), "a short list of steps names what moved or went to the Trash");
        let long = change(&json!({"steps":(0..7).collect::<Vec<_>>()}));
        assert_eq!((long["steps"].clone(), long["moreSteps"].clone()), (json!([0, 1, 2, 3, 4]), json!(2)));
        assert_eq!(shown["detail"].as_str().unwrap().chars().count(), 301, "300 characters and the ellipsis");
        assert_eq!(change(&json!({"state":"undone","superseded":true}))["state"], "undone");
    }

    #[test]
    fn a_suggestion_is_listed_without_its_per_file_data() {
        let op = |i: usize| {
            json!({"kind":"move","label":"Quarantine (restorable)","from":format!("~/.codex/sessions/{i}.jsonl"),
                "to":"~/.local/share/laci/orphans/codex"})
        };
        let group = json!({"id":"orphan:codex:/p/gone:abc","category":"orphan","title":"5 Codex sessions for deleted gone",
            "why":"w".repeat(400),"confidence":"med","availability":"unavailable","blocked":true,"reason":"Not sure",
            "ops":(0..5).map(op).collect::<Vec<_>>(),"action":{"type":"quarantine","moves":[{"from":"/a","to":"b"}]},
            "recovery":{"default":"quarantine"},"validation":{"sources":[{"path":"/a","identity":"h".repeat(64)}]}});
        let shown = suggestion(&group);
        for gone in ["action", "recovery", "validation", "availability", "reason", "nodeId"] {
            assert!(shown.get(gone).is_none(), "{gone}");
        }
        assert_eq!((shown["id"].clone(), shown["blocked"].clone()), (json!("orphan:codex:/p/gone:abc"), json!(true)));
        assert_eq!(shown["why"].as_str().unwrap().chars().count(), 301, "300 characters and the ellipsis");
        assert_eq!((shown["ops"].as_array().unwrap().len(), shown["moreOps"].clone()), (2, json!(3)));
        assert_eq!(shown["ops"][1]["from"], "~/.codex/sessions/1.jsonl");
        // A short list is all of it: nothing is counted, and a suggestion nothing blocks says nothing about it.
        let reconnect =
            suggestion(&json!({"id":"reconnect:x","category":"reconnect","nodeId":"/p","ops":[op(0), op(1)]}));
        assert_eq!((reconnect["ops"].as_array().unwrap().len(), reconnect["nodeId"].clone()), (2, json!("/p")));
        assert!(reconnect.get("moreOps").is_none() && reconnect.get("blocked").is_none());
        // A half-done move names every old path of a folder in one `from`; the other paths stay whole.
        let long = suggestion(&json!({"ops":[{"kind":"rewrite","from":"~/old/path, ".repeat(60),"to":"~/new"}]}));
        assert_eq!(long["ops"][0]["from"].as_str().unwrap().chars().count(), 301);
        assert_eq!(long["ops"][0]["to"], "~/new");
        assert_eq!(suggestion(&json!({}))["ops"], json!([]));
    }

    #[test]
    fn a_page_says_whether_there_is_more() {
        let items: Vec<Value> = (0..5).map(|i| json!(i)).collect();
        let first = Page::of(&json!({"limit":2}), 30).answer("items", items.clone());
        assert_eq!(
            (first["items"].clone(), first["total"].clone(), first["more"].clone()),
            (json!([0, 1]), json!(5), json!(true))
        );
        let last = Page::of(&json!({"limit":2,"offset":4}), 30).answer("items", items.clone());
        assert_eq!((last["items"].clone(), last["more"].clone()), (json!([4]), json!(false)));
        let past = Page::of(&json!({"offset":9}), 30).answer("items", items);
        assert_eq!((past["items"].clone(), past["more"].clone()), (json!([]), json!(false)));
    }

    /// What Tidy up offers on a busy home, in the scan's order: 4 reconnects, one half-done move across 12 session
    /// folders, space from 15 projects, 3 duplicates, 120 orphans (100 Claude folders, 3 of them blocked, and 20 groups
    /// of 2 to 500 Codex sessions) and 8 archives. Each is shaped as the scan makes it, with a move and a hash for every
    /// history file besides its operations.
    fn busy_proposals(home: &Path) -> Vec<Value> {
        let home = home.display().to_string();
        let tilde = |path: &str| path.replacen(&home, "~", 1);
        let project = |i: usize| format!("{home}/project/p{i}");
        let hash = |i: usize| format!("{:064x}", (i as u128 + 1) * 0x9e37_79b9_7f4a_7c15);
        let quarantine = |id: String, title: String, why: String, kind: &str, files: &[String]| {
            let to = format!("~/.local/share/laci/orphans/{kind}");
            json!({"id":id,"category":"orphan","title":title,"why":why,"confidence":"med",
                "ops":files.iter().map(|f| json!({"kind":"move","label":"Quarantine (restorable)","from":tilde(f),"to":to})).collect::<Vec<_>>(),
                "action":{"type":"quarantine","moves":files.iter().map(|f| json!({"from":f,"to":format!("{kind}/{}", f.rsplit('/').next().unwrap_or(f))})).collect::<Vec<_>>()},
                "recovery":{"default":"quarantine","choices":["quarantine","trash"],
                    "quarantine":"Laci Undo restores these exact history paths.",
                    "trash":format!("Restore these history paths through {}; Laci Undo is unavailable.",platform::BIN.bare)},
                "availability":"missing",
                "validation":{"projects":[format!("{home}/project/gone")],"roots":[{"path":format!("{home}/project"),"online":true}],
                    "sources":files.iter().enumerate().map(|(i, f)| json!({"path":f,"identity":hash(i)})).collect::<Vec<_>>()}})
        };
        let mut out = Vec::new();
        for i in 0..2 {
            let (old, new) = (format!("{home}/project/old{i}"), format!("{home}/project/_archive/p{i}"));
            out.push(json!({"id":format!("reconnect:-home-me-project-old{i}"),"category":"reconnect","confidence":"high",
                "title":format!("Reconnect 4 sessions + 1 memory file to p{i}"),"nodeId":new,
                "why":"The folder was moved into _archive, but its agent history stayed at the old address. Claude cannot find these at the new address.",
                "ops":[{"kind":"rename","label":"Move Claude sessions + memory","from":tilde(&old),"to":tilde(&new),"detail":"4 sessions · 1 memory file · 3.2 MB"},
                    {"kind":"rewrite","label":"Rewrite cwd in Claude logs","detail":format!("40 lines → {}", tilde(&new))}],
                "action":{"type":"reconnect-claude","dir":format!("{home}/.claude/projects/old{i}"),"pairs":[[old,new]]}}));
            // Codex sessions that still name the old folder: one rewrite, and every file in the action.
            let files: Vec<String> =
                (0..150).map(|k| format!("{home}/.codex/sessions/2026/09/rollout-{i}-{k:04}.jsonl")).collect();
            out.push(json!({"id":format!("orphan:codex:{old}"),"category":"reconnect","confidence":"high",
                "title":format!("Reconnect 150 Codex sessions to p{i}"),"nodeId":new,
                "why":format!("p{i} used to live at {}: its Claude logs still say so. These sessions stayed at the old address.", tilde(&old)),
                "ops":[{"kind":"rewrite","label":"Rewrite paths in Codex logs","from":tilde(&old),"to":tilde(&new),"detail":"3000 lines in 150 files"}],
                "action":{"type":"rewrite-logs","field":"payload.cwd","files":files,"pairs":[[old,new]]}}));
        }
        let stale = |i: usize| {
            (0..14).map(|k| format!("~/project/old/p{i}/packages/module-{k}")).collect::<Vec<_>>().join(", ")
        };
        out.push(json!({"id":"migration:stale-cwd","category":"migration","confidence":"high","title":"Finish 12 half-done moves",
            "why":"These session folders were renamed after a move, but their logs still record the old path. Search, stats and the next move would get it wrong.",
            "ops":(0..12).map(|i| json!({"kind":"rewrite","label":tilde(&project(i)),"from":stale(i),"to":tilde(&project(i)),"detail":"31 lines"})).collect::<Vec<_>>(),
            "action":{"type":"rewrite-claude","items":(0..12).map(|i| json!({"dir":format!("{home}/.claude/projects/p{i}"),"pairs":[[stale(i),project(i)]]})).collect::<Vec<_>>()}}));
        out.push(json!({"id":"space:inactive","category":"space","confidence":"high","title":"Free 6.6 GB from 15 inactive projects",
            "why":"Dependencies and build output in archived or dormant projects. They are deleted for good; a fresh install or build brings them back.",
            "ops":(0..15).map(|i| json!({"kind":"delete","label":format!("p{i}"),"detail":"440 MB · node_modules, target, dist"})).collect::<Vec<_>>(),
            "action":{"type":"clear","paths":(0..15).flat_map(|i| ["node_modules", "target", "dist"].map(|part| format!("{}/{part}", project(i)))).collect::<Vec<_>>()}}));
        for i in 0..3 {
            let copies = [project(i), format!("{home}/project/copies/p{i}"), format!("{home}/Downloads/p{i}")];
            let shown: Vec<String> = copies.iter().map(|c| tilde(c)).collect();
            out.push(json!({"id":format!("dup:{}",hash(i)),"category":"duplicate","confidence":"med",
                "title":format!("p{i} exists in 3 places"),
                "why":format!("{} share their first commit. One is probably a stale copy.", shown.join(" and ")),
                "ops":shown.iter().map(|c| json!({"kind":"keep","label":c,"detail":"last commit 2026-09-01 · 120 commits"})).collect::<Vec<_>>()}));
        }
        for i in 0..100 {
            let name = format!("-home-me-project-gone{i}");
            let dir = format!("{home}/.claude/projects/{name}");
            let title = "3 sessions + 2 memory files for a folder that is gone".to_owned();
            let why = format!("Nothing on disk matches {name}. Last used 2026-09-12.");
            let mut orphan = quarantine(format!("orphan:{name}:{}", hash(i)), title, why, "claude", &[dir]);
            // A folder whose history Laci couldn't read in full: the scan keeps its operations but won't act on them.
            if i % 40 == 7 {
                let reason = "Laci couldn't read all of this history, so it won't clean it up";
                orphan["id"] = json!(format!("orphan:{name}"));
                orphan["title"] = json!("Detached history needs a location check");
                orphan["why"] = json!(reason);
                orphan["availability"] = json!("unavailable");
                orphan["blocked"] = json!(true);
                orphan["reason"] = json!(reason);
                orphan.as_object_mut().unwrap().remove("validation");
            }
            out.push(orphan);
        }
        for i in 0..20 {
            // 2, 5, 12 and 40 Codex sessions in turn, and 500 in one group.
            let count = if i == 11 { 500 } else { [2, 5, 12, 40][i % 4] };
            let gone = format!("{home}/project/deleted-{i}");
            let files: Vec<String> = (0..count)
                .map(|k| {
                    let day = 1 + k % 28;
                    format!(
                        "{home}/.codex/sessions/2026/09/{day:02}/rollout-2026-09-{day:02}T10-11-12-{i:04}{k:08}-aaaa-bbbb-cccc-dddddddddddd.jsonl"
                    )
                })
                .collect();
            let id = format!("orphan:codex:{gone}:{}", hash(1000 + i));
            let title = format!("{count} Codex sessions for deleted deleted-{i}");
            let why = format!("{} no longer exists. Last used 2026-09-12.", tilde(&gone));
            out.push(quarantine(id, title, why, "codex", &files));
        }
        for i in 0..8 {
            let (from, to) = (tilde(&project(i)), format!("~/project/_archive/p{i}"));
            out.push(json!({"id":format!("archive:{}",project(i)),"category":"status","confidence":"med",
                "title":format!("Archive p{i}?"),"nodeId":project(i),
                "why":"No commits, file changes or agent sessions for 150 days.",
                "ops":[{"kind":"move","label":"Move folder","from":from,"to":to},
                    {"kind":"rename","label":"Move Claude sessions + memory","from":from,"to":to,"detail":"64 sessions · 2 memory files · 8.1 MB"},
                    {"kind":"rewrite","label":"Rewrite cwd in Claude logs","detail":format!("120 lines → {to}")},
                    {"kind":"keep","label":"Travels with the folder","detail":".laci.md, CLAUDE.md, AGENTS.md"},
                    {"kind":"write","label":"Set status: archived","to":format!("{to}/.laci.md")},
                    {"kind":"write","label":"Write undo journal","to":"~/.local/share/laci/journal/"}],
                "action":{"type":"archive","nodeId":project(i)}}));
        }
        out
    }

    /// A home about twice as busy as a real one: 60 projects with 20 to-dos each, one with a 60 KB README, 64
    /// conversations, 30 newer subagent logs and 20 Codex sessions, ten projects whose only check is muted, 22 session
    /// reports, 300 Log entries that each keep 18 KB of previous notes, and 137 Tidy up suggestions.
    fn busy_home() -> (tempfile::TempDir, Service, String) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let env = Env::for_home(home.clone());
        let at = |i: usize| format!("2026-10-{:02}T{:02}:00:00.000Z", 1 + i % 28, i % 24);
        let project = |i: usize| format!("{}/project/p{i}", home.display());
        let mut log = String::new();
        for i in 0..300 {
            log += &json!({"id":format!("e{i}"),"at":at(i),"by":"agent","title":format!("Edited the notes of p{}", i % 60),
                "key":format!("notes:{}", project(i % 60)),"path":project(i % 60),
                "undo":{"type":"notes","id":project(i % 60),"text":"n".repeat(18_000)}})
            .to_string();
            log.push('\n');
        }
        std::fs::create_dir_all(&env.data_dir).unwrap();
        std::fs::write(env.data_dir.join("activity.jsonl"), log).unwrap();
        let session = |i: usize| {
            json!({"id":format!("s{i}"),"sessionId":format!("00000000-0000-0000-0000-{i:012}"),"provider":"claude",
                "connector":"claude","title":"A session title of a few words","at":at(i),"startedAt":at(i),"endedAt":at(i),
                "updatedAt":at(i),"prompts":12,"filesChanged":4,"branch":"main","cwd":project(0),"activeSeconds":900,
                "bytes":120_000,"file":format!("{}/.claude/projects/p0/{i}.jsonl", home.display()),"parentId":null,
                "resumeCapability":"resume","sourceKind":"cli","titleSource":"prompt",
                "firstPrompt":"f".repeat(300),"lastPrompt":"l".repeat(300),"lastReply":"r".repeat(400)})
        };
        let subagent = |i: usize| {
            let mut log = session(100 + i);
            log["sourceKind"] = json!("subagent");
            log["resumeCapability"] = json!("history-only");
            log["at"] = json!(format!("2026-10-29T{:02}:00:00.000Z", i % 24));
            log
        };
        let mut items = serde_json::Map::new();
        for i in 0..20 {
            items.insert(
                format!("codex:{i}"),
                json!({"id":format!("codex:{i}"),"connector":"codex","cwd":project(0),
                "file":format!("{}/.codex/sessions/{i}.jsonl", home.display()),"at":at(i),"bytes":90_000,"lines":400,
                "prompts":8,"firstPrompt":"p".repeat(400),"lastPrompt":"q".repeat(400),"lastReply":"r".repeat(400),
                "cwds":["c".repeat(200)],"prs":["https://github.com/example/p/pull/1"]}),
            );
        }
        let mut nodes = serde_json::Map::new();
        for i in 0..60 {
            let tasks: Vec<Value> = (0..20)
                .map(|t| {
                    json!({"done":t % 3 == 0,"file":".laci.md","kind":"check","line":5 + t,"section":"Next",
                    "text":format!("To-do {t} of p{i}: {}", "a few more words ".repeat(8))})
                })
                .collect();
            let issues = if i % 2 == 0 {
                json!([{"code":"no-remote","severity":"high","title":"No remote","detail":"10 commits exist only on this disk"}])
            } else if i % 6 == 1 {
                json!([{"code":"no-remote","severity":"high","title":"No remote","muted":true}])
            } else {
                json!([])
            };
            nodes.insert(project(i), json!({"id":project(i),"path":project(i),"name":format!("p{i}"),"label":format!("p{i}"),
                "kind":"project","type":"code","archived":false,"status":{"auto":true,"value":"active"},
                "meta":{"priority":"high","deadline":"2026-11-01"},"issues":issues,
                "lastActivity":{"at":at(i),"source":"files"},"summary":{"text":"What this project is about, in a line. ".repeat(4)},
                "git":{"branch":"main","upstream":"origin/main","ahead":2,"behind":0,"dirty":3,"commits":120,
                    "lastCommitAt":at(i),"remotes":[{"web":"https://github.com/example/p"}]},
                "tasks":tasks,"notes":"Notes about the project. ".repeat(120),
                "readme":{"raw":"readme text ".repeat(5000),"title":"P","tagline":"A tagline","file":"README.md","sections":["Install"]},
                "stack":{"labels":["Rust","React"]},"archivePlan":{"dest":"/mnt/archive/p"},
                "agents":{"claude":[format!("claude-{i}")],
                    "items":if i == 0 { json!((0..20).map(|k| format!("codex:{k}")).collect::<Vec<_>>()) } else { json!([]) }}}));
        }
        let reports: Vec<Value> = (0..22)
            .map(|i| json!({"id":format!("2026-10-{:02}-report-{i}.md", 1 + i),"title":format!("Report {i}: {}", "title words ".repeat(6)),
                "date":"2026-10-15","file":format!("{}/notes/2026-10-{:02}-report-{i}.md", home.display(), 1 + i),
                "projects":(0..4).map(|p| project((i + p) % 60)).collect::<Vec<_>>(),"sessions":["a","b"],
                "summary":"s".repeat(400),"open":(0..i % 9).map(|k| format!("Open item {k}: {}", "words ".repeat(20))).collect::<Vec<_>>(),
                "openCount":i % 9 + usize::from(i % 9 == 8) * 3,"closedCount":1}))
            .collect();
        let mut claude = serde_json::Map::new();
        let logs: Vec<Value> = (0..64).map(session).chain((0..30).map(subagent)).collect();
        claude.insert(
            "claude-0".into(),
            json!({"dir":"p0","path":project(0),"name":"p0","memory":"memory","bytes":1,
            "sessions":logs,"subagentLogs":30,"gone":["x".repeat(1000)],"cwds":["y".repeat(1000)]}),
        );
        let snapshot = json!({"nodes":nodes,"sessions":logs,"claude":claude,"items":items,
            "reports":reports,"reportsDir":{"path":format!("{}/notes", home.display()),"total":22},"proposals":busy_proposals(&home),
            "warnings":[{"code":"claude-cleanup","severity":"high","title":"Claude Code deletes session logs after 30 days"}]});
        let mut service = Service::new(env);
        service.current = Some(snapshot);
        (dir, service, project(0))
    }

    #[test]
    fn every_read_answer_fits_an_agent_on_a_busy_home() {
        let (_dir, mut service, big) = busy_home();
        for (name, args) in [
            ("list_projects", json!({})),
            ("list_reports", json!({})),
            ("needs_attention", json!({})),
            ("open_items", json!({})),
            ("open_items", json!({"kind":"report"})),
            ("tidy_suggestions", json!({})),
            ("recent_changes", json!({})),
            ("project_details", json!({"project":big})),
        ] {
            let answer = call(&mut service, name, &args).unwrap_or_else(|e| panic!("{name}: {e}"));
            let size = serde_json::to_string(&answer).unwrap().len();
            assert!(size < 25_000, "{name} {args}: {size} characters");
        }
        // As the scan makes them, the suggestions are far over the budget: a group of history files has a move and a
        // hash for each file. The list keeps two operations of each; apply_suggestion has the rest.
        let unpaged = serde_json::to_string(&service.current.as_ref().unwrap()["proposals"]).unwrap().len();
        assert!(unpaged > 500_000, "{unpaged} characters before paging");
        let changes = call(&mut service, "recent_changes", &json!({"limit":100})).unwrap();
        assert!(!serde_json::to_string(&changes).unwrap().contains("nnnnnnnn"), "no undo data in the Log answer");
        let details = call(&mut service, "project_details", &json!({"project":big})).unwrap();
        assert!(details["readme"].get("raw").is_none());
        assert_eq!(details["readme"]["truncated"], true);
        assert_eq!(details["agentSessionCount"], 64, "conversations, not the subagent logs they ran");
        let sessions = details["agentSessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 10);
        assert!(sessions.iter().all(|s| s["sourceKind"] != "subagent" && s.get("lastReply").is_none()));
        assert_eq!(details["sessions"][0]["sessionCount"], 64);
        assert!(details["sessions"][0].get("sessions").is_none());
        assert_eq!(details["agentItemCount"], 20);
        let items = details["agentItems"].as_array().unwrap();
        assert_eq!(items.len(), 10);
        assert!(
            items.iter().all(|i| i["connector"] == "codex" && i.get("lastReply").is_none() && i.get("cwds").is_none())
        );
        assert_eq!(items[0]["firstPrompt"].as_str().unwrap().chars().count(), 121, "the start of the first prompt");
        assert!(details["agents"].get("items").is_none(), "the item ids are not listed a second time");
        assert!(details["reports"][0].get("projects").is_none());
    }

    #[test]
    fn lists_page_and_filter_on_a_busy_home() {
        let (_dir, mut service, big) = busy_home();
        let first = call(&mut service, "open_items", &json!({})).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 50);
        assert_eq!(first["more"], true);
        let total = first["total"].as_u64().unwrap() as usize;
        let mut seen = 0;
        let mut offset = 0;
        loop {
            let page = call(&mut service, "open_items", &json!({"offset":offset,"limit":300})).unwrap();
            seen += page["items"].as_array().unwrap().len();
            for item in page["items"].as_array().unwrap().iter().filter(|i| i["kind"] == "report") {
                let id = string(item, "report");
                assert!(page["reports"][id]["title"].is_string(), "every report on a page is described once");
                assert!(item.get("projects").is_none() && item.get("reportTitle").is_none());
            }
            if page["more"] != true {
                break;
            }
            offset += 300;
        }
        assert_eq!(seen, total);
        let reports = call(&mut service, "open_items", &json!({"kind":"report"})).unwrap();
        assert_eq!(reports["todos"], 0);
        assert!(reports["reportItems"].as_u64().unwrap() > 0);
        let changes = call(&mut service, "recent_changes", &json!({"project":big,"limit":100})).unwrap();
        assert!(changes["entries"].as_array().unwrap().iter().all(|e| string(e, "path") == big));
        assert!(changes["total"].as_u64().unwrap() > 0);
        let words = call(&mut service, "recent_changes", &json!({"query":"notes p1"})).unwrap();
        // The words are looked for in each entry's path too, which starts with this run's random temp folder.
        if !service.env.home.to_string_lossy().to_lowercase().contains("p1") {
            assert!(words["entries"].as_array().unwrap().iter().all(|e| string(e, "title").contains("p1")));
        }
        let projects = call(&mut service, "list_projects", &json!({"limit":5,"offset":5})).unwrap();
        assert_eq!((projects["projects"].as_array().unwrap().len(), projects["total"].clone()), (5, json!(60)));
        let attention = call(&mut service, "needs_attention", &json!({"limit":200})).unwrap();
        let first = &attention["projects"][0];
        assert_eq!(first["issues"][0]["severity"], "high", "work that could be lost comes first");
        assert!(first["issues"][0]["muted"].is_null(), "a muted check doesn't count as work at risk");
        assert!(first.get("tasks").is_none());
        let ranks: Vec<bool> = array(&attention["projects"])
            .iter()
            .map(|n| array(&n["issues"]).iter().any(|i| i["severity"] == "high" && i["muted"] != true))
            .collect();
        assert!(ranks.windows(2).all(|w| w[0] >= w[1]), "every live high check before the rest");
        let reports = call(&mut service, "list_reports", &json!({"limit":5,"offset":20})).unwrap();
        assert_eq!((reports["reports"].as_array().unwrap().len(), reports["total"].clone()), (2, json!(22)));
        assert_eq!(reports["more"], false);
        // Tidy up: every suggestion once, in the scan's order, 30 to a page, and each page small enough to read.
        let offered = array(&service.current.as_ref().unwrap()["proposals"]);
        let mut listed = Vec::new();
        let mut offset = 0;
        loop {
            let page = call(&mut service, "tidy_suggestions", &json!({"offset":offset})).unwrap();
            let size = serde_json::to_string(&page).unwrap().len();
            assert!(size < 25_000, "tidy_suggestions at {offset}: {size} characters");
            assert_eq!((page["total"].clone(), page["offset"].clone()), (json!(offered.len()), json!(offset)));
            listed.extend(array(&page["suggestions"]));
            if page["more"] != true {
                break;
            }
            offset += 30;
        }
        let ids = |list: &[Value]| list.iter().map(|p| string(p, "id").to_owned()).collect::<Vec<_>>();
        assert_eq!(ids(&listed), ids(&offered));
        for entry in &listed {
            for gone in ["action", "validation", "recovery", "availability", "reason"] {
                assert!(entry.get(gone).is_none(), "{gone}");
            }
            assert!(entry["ops"].as_array().unwrap().len() <= 2, "{}", entry["id"]);
        }
        // A group of 500 history files lists two and counts the rest, while a reconnect keeps both of its own.
        let group = listed.iter().find(|e| string(e, "title").starts_with("500 Codex")).unwrap();
        assert_eq!((group["ops"].as_array().unwrap().len(), group["moreOps"].clone()), (2, json!(498)));
        assert_eq!(group["ops"][0]["kind"], "move");
        // Its preview in apply_suggestion lists all 500 operations, a page at a time, without the review token.
        let full = offered.iter().find(|p| p["id"] == group["id"]).unwrap();
        let mut ops = Vec::new();
        loop {
            let plan = preview(full, &json!({"offset":ops.len()}));
            let size = serde_json::to_string(&plan).unwrap().len();
            assert!(size < 25_000, "preview at {}: {size} characters", ops.len());
            for gone in ["action", "validation", "moreOps"] {
                assert!(plan.get(gone).is_none(), "{gone}");
            }
            assert_eq!((plan["total"].clone(), plan["offset"].clone()), (json!(500), json!(ops.len())));
            ops.extend(array(&plan["ops"]));
            if plan["more"] != true {
                break;
            }
        }
        assert_eq!(ops.len(), 500);
        assert_eq!(ops[0], group["ops"][0]);
        let reconnect = listed.iter().find(|e| string(e, "title").starts_with("Reconnect 4 sessions")).unwrap();
        assert!(reconnect["ops"].as_array().unwrap().len() == 2 && reconnect.get("moreOps").is_none());
        assert_eq!(reconnect["nodeId"], offered[0]["nodeId"]);
        // The scan's operations are kept for the three it won't act on, and they say so.
        let blocked: Vec<_> = listed.iter().filter(|e| e["blocked"] == true).collect();
        assert_eq!(blocked.len(), 3);
        assert!(
            blocked.iter().all(|e| string(e, "why").contains("won't clean it up") && e["ops"][0]["from"].is_string())
        );
        // A half-done move keeps its folders as operations and cuts the old paths that one of them lists.
        let migration = listed.iter().find(|e| e["id"] == "migration:stale-cwd").unwrap();
        assert_eq!((migration["ops"].as_array().unwrap().len(), migration["moreOps"].clone()), (2, json!(10)));
        assert_eq!(migration["ops"][0]["from"].as_str().unwrap().chars().count(), 301);
        let past = call(&mut service, "tidy_suggestions", &json!({"offset":offered.len() + 40})).unwrap();
        assert_eq!(
            (past["suggestions"].clone(), past["total"].clone(), past["more"].clone()),
            (json!([]), json!(offered.len()), json!(false))
        );
        let end = call(&mut service, "tidy_suggestions", &json!({"limit":5,"offset":offered.len() - 3})).unwrap();
        assert_eq!((end["suggestions"].as_array().unwrap().len(), end["more"].clone()), (3, json!(false)));
        let most = call(&mut service, "tidy_suggestions", &json!({"limit":100})).unwrap();
        assert_eq!((most["suggestions"].as_array().unwrap().len(), most["more"].clone()), (100, json!(true)));
    }

    #[test]
    fn a_full_page_of_long_groups_still_fits_an_agent() {
        let (_dir, mut service, _) = busy_home();
        // Thirty copies of the longest group of the busy home: 500 history files each.
        let group = array(&service.current.as_ref().unwrap()["proposals"])
            .into_iter()
            .max_by_key(|p| array(&p["ops"]).len())
            .unwrap();
        assert_eq!(array(&group["ops"]).len(), 500);
        let groups: Vec<Value> = (0..30)
            .map(|i| {
                let mut copy = group.clone();
                copy["id"] = json!(format!("{}-{i}", string(&group, "id")));
                copy
            })
            .collect();
        service.current.as_mut().unwrap()["proposals"] = json!(groups);
        let page = call(&mut service, "tidy_suggestions", &json!({})).unwrap();
        let size = serde_json::to_string(&page).unwrap().len();
        assert!(size < 25_000, "{size} characters");
        assert_eq!((page["suggestions"].as_array().unwrap().len(), page["more"].clone()), (30, json!(false)));
    }
}
