//! Provider commands are argv, never terminal input or interpolated shell programs.
use crate::{
    Result,
    env::Env,
    paths,
    providers::{self, Discovery},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
pub struct LaunchRequest {
    pub provider: String,
    pub session_id: Option<String>,
    pub project_path: String,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Pick up the agent's most recent conversation in the folder instead of starting a new one.
    pub continue_last: bool,
    pub target: String,
}
impl LaunchRequest {
    pub fn from_value(value: &Value) -> Result<Self> {
        fn optional(value: &Value, key: &str, limit: usize) -> Result<Option<String>> {
            let Some(raw) = value.get(key).filter(|v| !v.is_null()) else { return Ok(None) };
            let text = raw.as_str().ok_or_else(|| format!("{key} must be text"))?;
            if text.len() > limit || text.contains('\0') {
                return Err(format!("Invalid {key}"));
            }
            if text.is_empty() || (matches!(key, "model" | "effort") && text == "default") {
                return Ok(None);
            }
            Ok(Some(text.to_owned()))
        }
        let provider = optional(value, "provider", 60)?.ok_or("Choose a provider")?;
        // Whether such an agent exists is checked against the registry when the command is built.
        if !provider.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
            return Err("This connector provides history only; choose a supported agent".into());
        }
        let target = optional(value, "target", 20)?.unwrap_or_else(|| "internal".into());
        if !matches!(target.as_str(), "internal" | "external") {
            return Err("Choose Laci or an external terminal".into());
        }
        Ok(Self {
            provider,
            session_id: optional(value, "sessionId", 100)?,
            project_path: optional(value, "projectPath", 4096)?.unwrap_or_default(),
            prompt: optional(value, "prompt", 64 * 1024)?,
            model: optional(value, "model", 200)?,
            effort: optional(value, "effort", 30)?,
            continue_last: value["continue"] == true,
            target,
        })
    }
}

#[derive(Clone, Debug)]
pub struct LaunchCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub title: String,
    pub target: String,
}

/// Where the host's PATH finds a program, if it does.
pub(crate) fn located(program: &str) -> Option<PathBuf> {
    crate::platform::which(program, &crate::process::host_path())
}
fn installed(program: &str) -> bool {
    located(program).is_some()
}
pub fn session_id_valid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(
            |(i, c)| {
                if [8, 13, 18, 23].contains(&i) { c == b'-' } else { c.is_ascii_hexdigit() }
            },
        )
}

/// The caller supplies a session from the current snapshot, never one constructed by the UI.
pub fn resolve(env: &Env, request: &LaunchRequest, session: Option<&Value>) -> Result<LaunchCommand> {
    let caps = if request.model.is_some() || request.effort.is_some() {
        capabilities(env, &request.provider, false)?
    } else {
        defaults(env, &request.provider)?
    };
    let mut command = resolve_with_capabilities(env, request, session, &caps)?;
    if !installed(&command.executable) {
        return Err(format!("{} is not installed or is not on PATH", command.executable));
    }
    // The terminal starts what Laci's own children would: on Windows the file itself, never a name it looks up its
    // own way, and node for an npm script.
    let (executable, args) =
        crate::process::program(&command.executable, command.args.iter().map(OsString::from).collect())?;
    let text = |value: OsString| {
        value.into_string().map_err(|value| format!("Laci can't hand {} to a terminal", value.to_string_lossy()))
    };
    command.executable = text(executable.into_os_string())?;
    command.args = args.into_iter().map(text).collect::<Result<_>>()?;
    Ok(command)
}
fn resolve_with_capabilities(
    env: &Env,
    r: &LaunchRequest,
    session: Option<&Value>,
    caps: &Value,
) -> Result<LaunchCommand> {
    let provider = providers::get(env, &r.provider)?;
    let session = if let Some(id) = &r.session_id {
        let s = session.ok_or("That session is no longer available; refresh history")?;
        if provider.resume.is_empty()
            || !session_id_valid(id)
            || s["provider"] != r.provider
            || s["sessionId"] != *id
            || s["resumeCapability"] != "supported"
        {
            return Err("This provider cannot resume that session".into());
        }
        Some(s)
    } else {
        None
    };
    let raw_cwd = if r.project_path.is_empty() {
        session.and_then(|s| s["cwd"].as_str()).ok_or("Choose a project folder")?
    } else {
        &r.project_path
    };
    let cwd = paths::workspace_path(raw_cwd, env)?;
    if !cwd.is_dir() {
        return Err("The project folder is missing or unavailable".into());
    }
    let chosen =
        r.model.as_ref().and_then(|model| caps["models"].as_array()?.iter().find(|entry| entry["id"] == *model));
    if let Some(model) = &r.model {
        if model.starts_with('-') || model.chars().any(char::is_control) || model.len() > 200 {
            return Err("Invalid model ID".into());
        }
        if chosen.is_none() && caps["customModel"] != true {
            return Err("That model is not in the provider's current model list; use Default or refresh models".into());
        }
    }
    if let Some(effort) = &r.effort {
        // With the default model, only levels the provider accepts for any model are known to be safe.
        let supported = if r.model.is_some() {
            chosen.and_then(|m| m["efforts"].as_array())
        } else {
            caps["defaultEfforts"].as_array()
        };
        if !supported.is_some_and(|list| list.iter().any(|v| v == effort)) {
            return Err("That effort is not supported for the selected model; use Default".into());
        }
    }
    let mut args = Vec::new();
    if let Some(id) = &r.session_id {
        args.extend(providers::fill(&provider.resume, "id", id));
    } else if r.continue_last {
        if provider.continue_last.is_empty() {
            return Err(format!("{} cannot continue its last conversation from here", provider.name));
        }
        args.extend(provider.continue_last.iter().cloned());
    }
    args.extend(providers::fill(&provider.cwd, "cwd", &cwd.to_string_lossy()));
    if let Some(model) = &r.model {
        if provider.model.is_empty() {
            return Err(format!("{} takes no model from Laci; use Default", provider.name));
        }
        args.extend(providers::fill(&provider.model, "model", model));
    }
    if let Some(effort) = &r.effort {
        args.extend(providers::fill(&provider.effort, "effort", effort));
    }
    if let Some(prompt) = &r.prompt {
        if prompt.contains('\0') || prompt.len() > 64 * 1024 {
            return Err("Invalid prompt".into());
        }
        if provider.prompt.is_empty() {
            return Err(format!("{} takes no first prompt from Laci; leave it empty", provider.name));
        }
        args.extend(providers::fill(&provider.prompt, "prompt", prompt));
    }
    let title = session.and_then(|s| s["title"].as_str()).unwrap_or(&provider.name).to_owned();
    Ok(LaunchCommand { executable: provider.command, args, cwd, title, target: r.target.clone() })
}

fn defaults(env: &Env, provider: &str) -> Result<Value> {
    let p = providers::get(env, provider)?;
    Ok(json!({
        "provider":p.id,"name":p.name,"executable":p.command,"installed":installed(&p.command),"launch":true,
        "resume":!p.resume.is_empty(),"continue":!p.continue_last.is_empty(),"prompt":!p.prompt.is_empty(),
        "models":p.models,"defaultEfforts":p.efforts,"customModel":p.custom_model,
        "discovery":if p.discovery == Discovery::Fixed { "aliases" } else { "unavailable" },"message":p.note,
    }))
}
/// The model and effort last used to start this agent, so the next start offers them again.
pub fn remembered(env: &Env, provider: &str) -> Value {
    let saved = crate::config::load(env)["agentDefaults"][provider].clone();
    json!({"model":saved["model"].as_str(),"effort":saved["effort"].as_str()})
}
pub fn remember(env: &Env, request: &LaunchRequest) -> Result<()> {
    let choice = json!({"model":request.model,"effort":request.effort});
    if remembered(env, &request.provider) == choice {
        return Ok(());
    }
    crate::ops::with_lock(env, || {
        let mut config = crate::config::load(env);
        if !config["agentDefaults"].is_object() {
            config["agentDefaults"] = json!({});
        }
        config["agentDefaults"][&request.provider] = choice;
        crate::config::save(env, &config)
    })
}
type CapabilityCache = BTreeMap<String, (Instant, Value)>;
static CAPABILITIES: LazyLock<Mutex<CapabilityCache>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// Called only by an explicit model request or a launch with overrides, never by scanning.
pub fn capabilities(env: &Env, provider: &str, refresh: bool) -> Result<Value> {
    let mut result = discover(env, provider, refresh)?;
    result["listed"] = json!(true);
    result["remembered"] = remembered(env, provider);
    Ok(result)
}
/// What is known without starting the provider's program: its fixed list, or the last list it reported.
/// Opening a dialog asks this way; asking the provider itself stays an explicit request.
pub fn known(env: &Env, provider: &str) -> Result<Value> {
    let key = format!("{}:{provider}", env.home.display());
    let cached = CAPABILITIES.lock().ok().and_then(|cache| cache.get(&key).map(|(_, value)| value.clone()));
    let mut result = match cached {
        Some(value) => value,
        None => defaults(env, provider)?,
    };
    // A fixed list is known as it stands; the other agents list their models only when asked.
    let listed = result["discovery"] == "aliases" || result["discovery"] == "available";
    if !listed {
        result["message"] = json!("Default uses the provider's own settings. Load models to choose another one.");
    }
    result["listed"] = json!(listed);
    result["remembered"] = remembered(env, provider);
    Ok(result)
}
fn discover(env: &Env, provider: &str, refresh: bool) -> Result<Value> {
    let key = format!("{}:{provider}", env.home.display());
    if !refresh
        && let Ok(cache) = CAPABILITIES.lock()
        && let Some((at, value)) = cache.get(&key)
        && at.elapsed() < Duration::from_secs(300)
    {
        return Ok(value.clone());
    }
    let mut result = defaults(env, provider)?;
    let discovery = providers::get(env, provider)?.discovery;
    if result["installed"] == true && discovery != Discovery::Fixed {
        let found = if discovery == Discovery::Codex {
            codex_models(&env.home)
        } else {
            // The agent keeps its state under home; it must be the home Laci reads, also on a demo home. Windows
            // programs read it from USERPROFILE.
            let home = env.home.to_string_lossy();
            crate::process::run_env(
                "agy",
                &["models"],
                Some(&env.home),
                Duration::from_secs(12),
                &[("HOME", Some(home.as_ref())), ("USERPROFILE", Some(home.as_ref()))],
            )
            .and_then(|s| parse_agy_models(&s))
            .map(|mut models| {
                // The listing names no effort levels; --effort belongs to the session, so every model takes it.
                for model in models.as_array_mut().into_iter().flatten() {
                    model["efforts"] = result["defaultEfforts"].clone();
                }
                models
            })
        };
        match found {
            Ok(models) => {
                result["models"] = models;
                result["discovery"] = json!("available");
                result["message"] = json!(if discovery == Discovery::Agy {
                    "Models reported by agy. Effort is passed as --effort; a model uses the levels it supports."
                } else {
                    "Models and supported efforts reported by Codex. Default keeps provider settings."
                });
            }
            Err(error) => {
                result["message"] = json!(match discovery_reason(&error) {
                    Some(reason) => format!(
                        "Model discovery is unavailable: {reason}. Default still uses your provider's settings."
                    ),
                    None => "Model discovery is unavailable. Default still uses your provider's settings; try Refresh models later.".into(),
                })
            }
        }
    }
    if let Ok(mut cache) = CAPABILITIES.lock() {
        if cache.len() >= 30 {
            cache.clear();
        }
        cache.insert(key, (Instant::now(), result.clone()));
    }
    Ok(result)
}
/// The agent's own last line about a failed listing, such as a request to sign in first.
fn discovery_reason(error: &str) -> Option<String> {
    let said = error.split_once(" failed:").map_or(error, |(_, said)| said);
    let line = said.lines().rev().map(str::trim).find(|line| !line.is_empty())?;
    let line = line.trim_start_matches("Error:").trim().trim_end_matches('.');
    (!line.is_empty() && line.chars().count() <= 200 && !line.chars().any(char::is_control)).then(|| line.to_owned())
}
fn parse_agy_models(text: &str) -> Result<Value> {
    let models: Vec<_> = text
        .lines()
        .filter_map(|line| {
            let (id, label) = line.split_once('\t')?;
            if id.is_empty()
                || !id.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-:/".contains(&c))
                || label.trim().is_empty()
            {
                return None;
            }
            Some(json!({"id":id,"label":label.trim(),"efforts":[]}))
        })
        .take(200)
        .collect();
    if models.is_empty() { Err("Unrecognized agy model list".into()) } else { Ok(json!(models)) }
}
fn parse_codex_models(result: &Value) -> Result<Vec<Value>> {
    let data = result["data"].as_array().ok_or("Unrecognized Codex model list")?;
    Ok(data.iter().filter(|m| m["hidden"] != true).filter_map(|m| {
        let id = m["model"].as_str()?;
        let efforts: Vec<_> = m["supportedReasoningEfforts"].as_array().into_iter().flatten().filter_map(|e| e["reasoningEffort"].as_str()).collect();
        Some(json!({"id":id,"label":m["displayName"].as_str().unwrap_or(id),"efforts":efforts,"defaultEffort":m["defaultReasoningEffort"],"isDefault":m["isDefault"]}))
    }).collect())
}
/// `cwd` is Laci's home, which is also where Codex must look for its own settings.
fn codex_models(cwd: &Path) -> Result<Value> {
    // Only initialize/model-list messages; discovery never starts a thread or a turn.
    let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut child = crate::process::start("codex", &["app-server", "--listen", "stdio://"])?
        .current_dir(cwd)
        .env("HOME", cwd)
        .env("USERPROFILE", cwd)
        .stdin(Stdio::piped())
        .stdout(output.reopen().map_err(|e| e.to_string())?)
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<Value> {
        let mut input = child.stdin.take().ok_or("No Codex input")?;
        writeln!(input, "{}", json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"laci","version":env!("CARGO_PKG_VERSION")}}})).map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(output.reopen().map_err(|e| e.to_string())?);
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut buffer = String::new();
        let mut bytes = 0;
        let mut models = Vec::new();
        let mut page_id = 2u64;
        while Instant::now() < deadline && bytes < 2 * 1024 * 1024 {
            let n = reader
                .by_ref()
                .take((2 * 1024 * 1024 - bytes) as u64)
                .read_line(&mut buffer)
                .map_err(|e| e.to_string())?;
            bytes += n;
            if n == 0 {
                if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
                continue;
            }
            if !buffer.ends_with('\n') {
                continue;
            }
            let message: Value = serde_json::from_str(&buffer).map_err(|e| e.to_string())?;
            buffer.clear();
            if message["error"].is_object() {
                return Err("Codex rejected model discovery".into());
            }
            if message["id"] == 1 {
                writeln!(
                    input,
                    "{}\n{}",
                    json!({"method":"initialized","params":{}}),
                    json!({"id":page_id,"method":"model/list","params":{"limit":100,"includeHidden":false}})
                )
                .map_err(|e| e.to_string())?;
            } else if message["id"] == page_id {
                models.extend(parse_codex_models(&message["result"])?);
                if let Some(cursor) = message["result"]["nextCursor"].as_str().filter(|s| !s.is_empty()) {
                    if page_id >= 5 {
                        return Err("Codex model list exceeds the discovery limit".into());
                    }
                    page_id += 1;
                    writeln!(input, "{}", json!({"id":page_id,"method":"model/list","params":{"limit":100,"cursor":cursor,"includeHidden":false}})).map_err(|e| e.to_string())?;
                } else {
                    return if models.is_empty() { Err("No available models".into()) } else { Ok(json!(models)) };
                }
            }
        }
        Err("Codex model discovery timed out".into())
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// The arguments for terminal `app` that run `command` in its folder, with its argv passed on unchanged.
pub fn external_args(app: &str, command: &LaunchCommand) -> Result<Vec<String>> {
    crate::platform::terminal_args(app, &command.cwd, &command.executable, &command.args, quote)
}
pub fn external(app: &str, command: &LaunchCommand) -> Result<()> {
    crate::service::detach(app, &external_args(app, command)?, &command.cwd)
}
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    const ID: &str = "12345678-1234-1234-1234-123456789abc";
    fn request(env: &Env, provider: &str) -> LaunchRequest {
        LaunchRequest::from_value(&json!({"provider":provider,"projectPath":env.home})).unwrap()
    }
    #[test]
    fn defaults_omit_overrides_and_provider_commands_keep_exact_prompt_bytes() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join("a space ' $(echo no)");
        fs::create_dir(&project).unwrap();
        let env = Env::for_home(home.path().to_owned());
        let prompt = "--help\n$(touch /tmp/laci-not-created); `echo no` ' \" \\ 雨";
        for provider in ["claude", "codex", "antigravity"] {
            let mut r = request(&env, provider);
            r.project_path = project.to_string_lossy().into_owned();
            r.prompt = Some(prompt.into());
            let c = resolve_with_capabilities(&env, &r, None, &defaults(&env, provider).unwrap()).unwrap();
            assert_eq!(c.cwd, project);
            assert!(!c.args.iter().any(|a| a == "--model" || a == "--effort" || a == "-c"));
            assert_eq!(
                c.args.last().unwrap(),
                if provider == "antigravity" { format!("--prompt-interactive={prompt}") } else { prompt.into() }
                    .as_str()
            );
            if provider != "antigravity" {
                assert_eq!(c.args[c.args.len() - 2], "--");
            }
            if provider == "codex" {
                assert_eq!(c.args[..2], ["-C", project.to_str().unwrap()]);
            }
        }
    }
    #[test]
    fn resume_requires_exact_provider_and_session_and_explicit_cwd_wins() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let selected = home.path().join("selected");
        fs::create_dir(&selected).unwrap();
        let mut r = request(&env, "codex");
        r.session_id = Some(ID.into());
        r.project_path = selected.to_string_lossy().into_owned();
        let mut session = json!({"provider":"codex","sessionId":ID,"cwd":env.home,"resumeCapability":"supported","title":"Readable name"});
        let caps = defaults(&env, "codex").unwrap();
        let c = resolve_with_capabilities(&env, &r, Some(&session), &caps).unwrap();
        assert_eq!(c.args, ["resume", ID, "-C", selected.to_str().unwrap()]);
        assert_eq!(c.title, "Readable name");
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_err());
        session["provider"] = json!("claude");
        assert!(resolve_with_capabilities(&env, &r, Some(&session), &caps).is_err());
        session["provider"] = json!("codex");
        session["resumeCapability"] = json!("history-only");
        assert!(resolve_with_capabilities(&env, &r, Some(&session), &caps).is_err());
        r.project_path = home.path().join("missing").to_string_lossy().into_owned();
        r.session_id = None;
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_err());
    }
    #[test]
    fn model_effort_pairs_are_provider_specific_and_unknown_discovery_keeps_defaults() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let mut r = request(&env, "codex");
        let caps = json!({"customModel":false,"models":[{"id":"test-model","efforts":["medium"]}]});
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_ok());
        r.effort = Some("medium".into());
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_err());
        r.model = Some("test-model".into());
        let c = resolve_with_capabilities(&env, &r, None, &caps).unwrap();
        assert_eq!(&c.args[c.args.len() - 2..], ["-c", "model_reasoning_effort=\"medium\""]);
        r.effort = Some("max".into());
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_err());
        r.model = Some("made-up".into());
        r.effort = None;
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_err());
        r.provider = "claude".into();
        assert!(resolve_with_capabilities(&env, &r, None, &defaults(&env, "claude").unwrap()).is_ok());
        r.model = Some("--model=bad".into());
        assert!(resolve_with_capabilities(&env, &r, None, &defaults(&env, "claude").unwrap()).is_err());
        let defaults =
            LaunchRequest::from_value(&json!({"provider":"codex","model":"default","effort":"default"})).unwrap();
        assert!(defaults.model.is_none() && defaults.effort.is_none());
        assert!(LaunchRequest::from_value(&json!({"provider":"codex","prompt":"nul\u{0000}"})).is_err());
    }
    #[test]
    fn claude_takes_an_effort_with_the_default_model_and_the_last_choice_is_remembered() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let caps = defaults(&env, "claude").unwrap();
        let ids: Vec<_> = caps["models"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["fable", "opus", "sonnet", "haiku"]);
        let mut r = request(&env, "claude");
        r.effort = Some("xhigh".into());
        let c = resolve_with_capabilities(&env, &r, None, &caps).unwrap();
        assert_eq!(c.args, ["--effort", "xhigh"]);
        r.effort = Some("extreme".into());
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_err());
        r.model = Some("haiku".into());
        r.effort = Some("high".into());
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_err(), "Haiku lists no effort levels");

        assert_eq!(capabilities(&env, "claude", false).unwrap()["remembered"], json!({"model":null,"effort":null}));
        let passive = known(&env, "claude").unwrap();
        assert_eq!((&passive["listed"], passive["models"].as_array().unwrap().len()), (&json!(true), 4));
        let codex = known(&env, "codex").unwrap();
        assert_eq!(
            (&codex["listed"], &codex["models"]),
            (&json!(false), &json!([])),
            "Codex is not asked until requested"
        );
        r.model = Some("fable".into());
        r.effort = Some("max".into());
        remember(&env, &r).unwrap();
        assert_eq!(capabilities(&env, "claude", false).unwrap()["remembered"], json!({"model":"fable","effort":"max"}));
        assert_eq!(remembered(&env, "codex"), json!({"model":null,"effort":null}));
        r.model = None;
        r.effort = None;
        remember(&env, &r).unwrap();
        assert_eq!(remembered(&env, "claude"), json!({"model":null,"effort":null}));
    }
    #[test]
    fn a_described_tool_starts_from_its_own_arguments_and_agents_continue_their_last_conversation() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        crate::config::save(
            &env,
            &json!({"roots":[],"presets":[],"custom":[{"id":"custom-aider","name":"Aider","agent":{
                "command":"aider","prompt":"--message {prompt}","continue":"--restore-chat-history",
                "model":"--model {model}","models":"sonnet","effort":"--reasoning-effort {effort}","efforts":"low high"}}]}),
        )
        .unwrap();
        let caps = known(&env, "custom-aider").unwrap();
        assert_eq!((&caps["listed"], &caps["continue"], &caps["resume"]), (&json!(true), &json!(true), &json!(false)));
        assert_eq!(caps["models"], json!([{"id":"sonnet","label":"sonnet","efforts":["low","high"]}]));
        let mut r = request(&env, "custom-aider");
        r.prompt = Some("fix the $(bug)".into());
        r.model = Some("sonnet".into());
        r.effort = Some("high".into());
        let c = resolve_with_capabilities(&env, &r, None, &caps).unwrap();
        assert_eq!(c.executable, "aider");
        assert_eq!(c.args, ["--model", "sonnet", "--reasoning-effort", "high", "--message", "fix the $(bug)"]);
        assert_eq!(c.title, "Aider");
        r.effort = Some("max".into());
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_err(), "not one of its levels");
        r.effort = None;
        r.model = Some("typed-by-hand".into());
        assert!(resolve_with_capabilities(&env, &r, None, &caps).is_ok());
        r.session_id = Some(ID.into());
        let session = json!({"provider":"custom-aider","sessionId":ID,"cwd":env.home,"resumeCapability":"supported"});
        assert!(resolve_with_capabilities(&env, &r, Some(&session), &caps).is_err(), "it has no resume arguments");
        assert!(resolve_with_capabilities(&env, &request(&env, "custom-gone"), None, &caps).is_err());

        let home_text = home.path().to_str().unwrap();
        for (provider, expected) in [
            ("claude", vec!["--continue"]),
            ("codex", vec!["resume", "--last", "-C", home_text]),
            ("antigravity", vec!["--continue"]),
            ("custom-aider", vec!["--restore-chat-history"]),
        ] {
            let mut r = request(&env, provider);
            r.continue_last = true;
            let c = resolve_with_capabilities(&env, &r, None, &defaults(&env, provider).unwrap()).unwrap();
            assert_eq!(c.args, expected, "{provider}");
        }
        // Antigravity takes an effort for the session, whichever model is in use.
        let mut r = request(&env, "antigravity");
        r.effort = Some("xhigh".into());
        let c = resolve_with_capabilities(&env, &r, None, &known(&env, "antigravity").unwrap()).unwrap();
        assert_eq!(c.args, ["--effort", "xhigh"]);
    }
    #[test]
    fn discovery_preserves_per_model_efforts_and_rejects_unrecognized_agy_output() {
        let models = parse_codex_models(&json!({"data":[
            {"model":"small","displayName":"Small","supportedReasoningEfforts":[{"reasoningEffort":"low"}]},
            {"model":"large","supportedReasoningEfforts":[{"reasoningEffort":"high"},{"reasoningEffort":"max"}]},
            {"model":"hidden","hidden":true}
        ]}))
        .unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["efforts"], json!(["low"]));
        assert_eq!(models[1]["efforts"], json!(["high", "max"]));
        assert!(parse_agy_models("Fetching available models...\nPlease sign in").is_err());
        assert_eq!(
            discovery_reason(
                "agy failed: Fetching available models...\nError: Please sign in to view available models."
            )
            .as_deref(),
            Some("Please sign in to view available models")
        );
        assert_eq!(discovery_reason("agy failed: "), None, "an agent that says nothing gives no reason");
        assert_eq!(discovery_reason("codex took too long").as_deref(), Some("codex took too long"));
        let models = parse_agy_models("Fetching available models...\nmodel-a\tModel A\nmodel-b\tModel B\n").unwrap();
        assert_eq!(models[0]["id"], "model-a");
        assert_eq!(models[0]["efforts"], json!([]));
    }
    // Linux's terminals, and `sh` to read the quoting back.
    #[cfg(target_os = "linux")]
    #[test]
    fn terminal_transport_keeps_argv_and_shell_quoting_round_trips() {
        let home = tempfile::tempdir().unwrap();
        let args = vec!["--".into(), "--dash\n$(echo injected); 'quote' \"backtick`\" \\ 雨".into()];
        let c = LaunchCommand {
            executable: "codex".into(),
            args: args.clone(),
            cwd: home.path().to_owned(),
            title: "Test".into(),
            target: "external".into(),
        };
        for app in ["kitty", "konsole", "alacritty", "wezterm", "gnome-terminal", "foot", "ghostty", "xterm"] {
            let transport = external_args(app, &c).unwrap();
            assert_eq!(&transport[transport.len() - args.len()..], &args);
        }
        // Exercise the only string transport boundary with an inert argv printer.
        let words =
            std::iter::once("printf").chain(["%s\\0", &args[0], &args[1]]).map(quote).collect::<Vec<_>>().join(" ");
        let output = std::process::Command::new("sh").args(["-c", &words]).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, format!("{}\0{}\0", args[0], args[1]).as_bytes());
        assert!(external_args("unknown-terminal", &c).is_err());
    }
}
