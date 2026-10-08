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
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("laci",env!("CARGO_PKG_VERSION")))
            .with_instructions("Use laci for moving projects so their agent history travels with them. Destructive tools return a plan first; show it to the user before calling with confirm: true.")
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
                "list_projects" | "project_details" | "needs_attention" | "tidy_suggestions" | "recent_changes"
            ) {
                *scanned = Instant::now();
            }
            result
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
                .cloned()
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
            Ok(n)
        }
        "needs_attention" => {
            let s = service.snapshot()?;
            let projects: Vec<_> = s["nodes"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(_, n)| n)
                .filter(|n| !array(&n["issues"]).is_empty() || array(&n["tasks"]).iter().any(|t| t["done"] == false))
                .cloned()
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
            Ok(node)
        }
        "add_next_step" => {
            let node = project(service, string(args, "project"))?;
            service.request_as("todo", &json!({"id":node["id"],"op":"add","text":args["text"]}), "agent")
        }
        "complete_task" => {
            service.rescan()?;
            let node = project(service, string(args, "project"))?;
            let query = string(args, "text").to_lowercase();
            let done = args["done"].as_bool().unwrap_or(true);
            let matches: Vec<_> = array(&node["tasks"])
                .into_iter()
                .filter(|t| {
                    t["kind"] == "check" && t["done"] != done && string(t, "text").to_lowercase().contains(&query)
                })
                .collect();
            let task = match matches.as_slice() {
                [task] => task,
                [] => return Err("No checkbox matches that text".into()),
                _ => return Err("More than one checkbox matches; use more of its text".into()),
            };
            service.request_as("todo",&json!({"id":node["id"],"op":"toggle","file":task["file"],"line":task["line"],"text":task["text"],"done":args["done"].as_bool().unwrap_or(true)}),"agent")
        }
        "write_notes" => {
            service.rescan()?;
            let node = project(service, string(args, "project"))?;
            let text = if args["mode"] == "replace" || string(&node, "notes").is_empty() {
                string(args, "notes").to_owned()
            } else {
                format!("{}\n\n{}", string(&node, "notes"), string(args, "notes"))
            };
            service.request_as("notes", &json!({"id":node["id"],"text":text}), "agent")
        }
        _ => Err("Unknown tool".into()),
    }
}
use std::path::Path;
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
            "project_details",
            "Git, stack, README, to-dos, agent history and archive plan",
            json!({"project":project}),
            vec!["project"],
        ),
        ("needs_attention", "Work at risk, deadlines, open tasks and warnings", json!({}), vec![]),
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
            let readonly =
                ["list_projects", "project_details", "needs_attention", "tidy_suggestions", "recent_changes"]
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
