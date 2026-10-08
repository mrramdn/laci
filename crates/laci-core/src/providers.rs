//! One description per agent Laci can start: its program, how its arguments are put together, the
//! models it offers and where it keeps its MCP servers. Built-in agents and the ones a user
//! describes in `config.json` share this type, so the rest of the engine knows no agent by name.
use crate::{Result, env::Env, paths};
use serde_json::{Value, json};
use std::sync::LazyLock;

/// The name Laci's MCP server is registered under in every agent.
pub const SERVER: &str = "laci";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Discovery {
    /// The list in the description is all there is; nothing is asked.
    Fixed,
    /// Asked from `codex app-server`, and only on request.
    Codex,
    /// Asked from `agy models`, and only on request.
    Agy,
}

/// Where an agent keeps its MCP servers and how one is added.
#[derive(Clone, Debug, PartialEq)]
pub struct Mcp {
    /// The agent's own file, with `~` for home. Read to tell whether Laci is registered.
    pub file: String,
    /// Dotted path to the table of servers inside that file.
    pub key: String,
    /// Arguments of the agent's own command for adding and removing a server.
    /// Without them Laci edits `file` itself, which must then be JSON.
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

/// A setting that makes the agent delete its own history after some days.
#[derive(Clone, Debug, PartialEq)]
pub struct Retention {
    pub file: String,
    pub key: String,
    /// What the agent does when the setting is absent.
    pub days: u64,
    /// What survives and what does not, for the warning.
    pub note: String,
}

/// Argument lists are templates: `{id}`, `{cwd}`, `{model}`, `{effort}` and `{prompt}` stand for
/// the value. An empty list means the agent cannot do that.
#[derive(Clone, Debug, PartialEq)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub command: String,
    pub builtin: bool,
    pub resume: Vec<String>,
    /// Picks up the most recent conversation in the folder, for agents whose sessions Laci cannot list.
    pub continue_last: Vec<String>,
    pub cwd: Vec<String>,
    pub model: Vec<String>,
    pub effort: Vec<String>,
    pub prompt: Vec<String>,
    /// `{id, label, efforts}` each.
    pub models: Vec<Value>,
    /// Effort levels that can be set while the model stays the agent's default.
    pub efforts: Vec<String>,
    /// A model that is not in the list may be typed in.
    pub custom_model: bool,
    pub discovery: Discovery,
    pub note: String,
    pub mcp: Option<Mcp>,
    pub retention: Option<Retention>,
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

/// Puts `value` where `{name}` stands. One template element stays one argument, so the value is
/// never split and never read by a shell.
pub fn fill(template: &[String], name: &str, value: &str) -> Vec<String> {
    let mark = format!("{{{name}}}");
    template.iter().map(|part| part.replace(&mark, value)).collect()
}

pub fn builtins() -> Vec<Provider> {
    let levels = ["low", "medium", "high", "xhigh", "max"];
    let model = |id: &str, label: &str, efforts: &[&str]| json!({"id":id,"label":label,"efforts":efforts});
    vec![
        Provider {
            id: "claude".into(),
            name: "Claude Code".into(),
            command: "claude".into(),
            builtin: true,
            resume: strings(&["--resume", "{id}"]),
            continue_last: strings(&["--continue"]),
            cwd: vec![],
            model: strings(&["--model", "{model}"]),
            effort: strings(&["--effort", "{effort}"]),
            prompt: strings(&["--", "{prompt}"]),
            // The names and levels the Claude Code CLI accepts for --model and --effort.
            models: vec![
                model("fable", "Fable", &levels),
                model("opus", "Opus", &levels),
                model("sonnet", "Sonnet", &levels),
                model("haiku", "Haiku", &[]),
            ],
            // The CLI takes an effort without a model, so it can be set while the model stays the default.
            efforts: strings(&levels),
            custom_model: true,
            discovery: Discovery::Fixed,
            note: "Model names are Claude Code aliases; which ones work depends on your account. Default keeps what Claude Code is set to. A custom model ID uses Default effort.".into(),
            mcp: Some(Mcp {
                file: "~/.claude.json".into(),
                key: "mcpServers".into(),
                add: strings(&["mcp", "add", SERVER, "--scope", "user", "--", "{laci}", "mcp"]),
                remove: strings(&["mcp", "remove", SERVER, "--scope", "user"]),
            }),
            retention: Some(Retention {
                file: "~/.claude/settings.json".into(),
                key: "cleanupPeriodDays".into(),
                days: 30,
                note: "Memory files are kept, conversation history is not.".into(),
            }),
        },
        Provider {
            id: "codex".into(),
            name: "Codex".into(),
            command: "codex".into(),
            builtin: true,
            resume: strings(&["resume", "{id}"]),
            continue_last: strings(&["resume", "--last"]),
            cwd: strings(&["-C", "{cwd}"]),
            model: strings(&["--model", "{model}"]),
            effort: strings(&["-c", "model_reasoning_effort=\"{effort}\""]),
            prompt: strings(&["--", "{prompt}"]),
            models: vec![],
            efforts: vec![],
            custom_model: false,
            discovery: Discovery::Codex,
            note: "Use Default to keep the provider's settings.".into(),
            mcp: Some(Mcp {
                file: "~/.codex/config.toml".into(),
                key: "mcp_servers".into(),
                add: strings(&["mcp", "add", SERVER, "--", "{laci}", "mcp"]),
                remove: strings(&["mcp", "remove", SERVER]),
            }),
            retention: None,
        },
        Provider {
            id: "antigravity".into(),
            name: "Antigravity".into(),
            command: "agy".into(),
            builtin: true,
            resume: strings(&["--conversation", "{id}"]),
            continue_last: strings(&["--continue"]),
            cwd: vec![],
            model: strings(&["--model", "{model}"]),
            effort: strings(&["--effort", "{effort}"]),
            prompt: strings(&["--prompt-interactive={prompt}"]),
            models: vec![],
            // `agy --effort` belongs to the session, not to one model.
            efforts: strings(&levels),
            custom_model: false,
            discovery: Discovery::Agy,
            note: "Use Default to keep the provider's settings.".into(),
            mcp: Some(Mcp {
                file: "~/.gemini/config/mcp_config.json".into(),
                key: "mcpServers".into(),
                add: strings(&["mcp", "add", SERVER, "{laci}", "mcp"]),
                remove: strings(&["mcp", "remove", SERVER]),
            }),
            retention: None,
        },
    ]
}

/// The agent a connector entry in `config.json` describes, if it describes one.
pub fn from_spec(spec: &Value) -> Option<Provider> {
    let agent = spec.get("agent").filter(|agent| agent.is_object())?;
    let list = |key: &str| -> Vec<String> {
        agent[key].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
    };
    let effort = list("effort");
    let efforts = if effort.is_empty() { vec![] } else { list("efforts") };
    let model = list("model");
    let models = if model.is_empty() {
        vec![]
    } else {
        agent["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = m["id"].as_str()?;
                Some(json!({"id":id,"label":m["label"].as_str().unwrap_or(id),"efforts":efforts}))
            })
            .collect()
    };
    let mcp = agent["mcp"]["file"].as_str().map(|file| Mcp {
        file: file.to_owned(),
        key: agent["mcp"]["key"].as_str().unwrap_or("mcpServers").to_owned(),
        add: agent["mcp"]["add"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        remove: agent["mcp"]["remove"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
    });
    Some(Provider {
        id: spec["id"].as_str()?.to_owned(),
        name: spec["name"].as_str()?.to_owned(),
        command: agent["command"].as_str()?.to_owned(),
        builtin: false,
        resume: vec![],
        continue_last: list("continue"),
        cwd: list("cwd"),
        custom_model: !model.is_empty(),
        note: if model.is_empty() && effort.is_empty() {
            "This tool starts with its own settings.".into()
        } else {
            "Models and effort levels are the ones listed for this tool in Laci's settings file. Default keeps the tool's own settings.".into()
        },
        model,
        effort,
        prompt: list("prompt"),
        models,
        efforts,
        discovery: Discovery::Fixed,
        mcp,
        retention: None,
    })
}

/// Every agent Laci can start here: the built-in ones, then the user's own.
pub fn all(env: &Env) -> Vec<Provider> {
    let mut out = builtins();
    for spec in crate::config::load(env)["custom"].as_array().into_iter().flatten() {
        if let Some(provider) = from_spec(spec)
            && !out.iter().any(|known| known.id == provider.id)
        {
            out.push(provider);
        }
    }
    out
}
pub fn get(env: &Env, id: &str) -> Result<Provider> {
    all(env)
        .into_iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| "This connector provides history only; choose a supported agent".into())
}

static COMMAND: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[\w.+-]{1,40}$").expect("command pattern"));
static MARK: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\{[A-Za-z]+\}").expect("mark pattern"));
static MODEL: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$").expect("model pattern"));
static EFFORT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[a-z0-9][a-z0-9_-]{0,29}$").expect("effort pattern"));
static KEY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z_][\w-]{0,40}(\.[A-Za-z_][\w-]{0,40}){0,3}$").expect("key pattern"));

/// Arguments as a list, or as one line that is split at spaces.
fn words(raw: &Value, what: &str) -> Result<Vec<String>> {
    match raw {
        Value::Null => Ok(vec![]),
        Value::String(line) => Ok(line.split_whitespace().map(str::to_owned).collect()),
        Value::Array(parts) => parts
            .iter()
            .map(|part| part.as_str().map(str::to_owned).ok_or_else(|| format!("{what}: use text")))
            .collect(),
        _ => Err(format!("{what}: use text")),
    }
}
/// `mark` is the one placeholder these arguments may hold, and must hold when `needed`.
fn template(raw: &Value, what: &str, mark: &str, needed: bool) -> Result<Vec<String>> {
    let parts = words(raw, what)?;
    if parts.len() > 16 {
        return Err(format!("{what}: use at most 16 arguments"));
    }
    for part in &parts {
        if part.is_empty() || part.chars().count() > 200 || part.chars().any(char::is_control) {
            return Err(format!("{what}: an argument is empty, too long or holds a control character"));
        }
        if let Some(other) = MARK.find_iter(part).map(|m| m.as_str()).find(|found| *found != mark) {
            return Err(if mark.is_empty() {
                format!("{what}: {other} has no meaning here")
            } else {
                format!("{what}: use {mark}, not {other}")
            });
        }
    }
    if needed && !parts.is_empty() && !parts.iter().any(|part| part.contains(mark)) {
        return Err(format!("{what}: put {mark} where the value goes"));
    }
    Ok(parts)
}

/// Checks the `agent` part of a connector entry and returns it in the form `from_spec` reads.
pub fn validate_agent(env: &Env, raw: &Value) -> Result<Value> {
    if !raw.is_object() {
        return Err("Describe how the tool is started".into());
    }
    let command = raw["command"].as_str().unwrap_or("").trim();
    if !COMMAND.is_match(command) {
        return Err("Command: use the program's name, such as aider".into());
    }
    let mut out = json!({"command":command});
    for (key, what, mark, needed) in [
        ("prompt", "First prompt", "{prompt}", true),
        ("continue", "Continue", "", false),
        ("cwd", "Folder", "{cwd}", true),
        ("model", "Model", "{model}", true),
        ("effort", "Effort", "{effort}", true),
    ] {
        let parts = template(&raw[key], what, mark, needed)?;
        if !parts.is_empty() {
            out[key] = json!(parts);
        }
    }
    let mut models = Vec::new();
    let listed: Vec<Value> = match &raw["models"] {
        Value::String(line) => line.split([',', ' ', '\n']).filter(|s| !s.is_empty()).map(|s| json!(s)).collect(),
        Value::Array(list) => list.clone(),
        Value::Null => vec![],
        _ => return Err("Models: list their names".into()),
    };
    for entry in listed {
        let id = entry.as_str().or_else(|| entry["id"].as_str()).unwrap_or("");
        if !MODEL.is_match(id) {
            return Err(format!("Models: {id:?} is not a model name"));
        }
        let mut model = json!({"id":id});
        if let Some(label) = entry["label"].as_str().map(str::trim).filter(|label| !label.is_empty()) {
            if label.chars().count() > 60 || label.chars().any(char::is_control) {
                return Err("Models: a label is too long".into());
            }
            model["label"] = json!(label);
        }
        if !models.iter().any(|known: &Value| known["id"] == id) {
            models.push(model);
        }
    }
    if models.len() > 60 {
        return Err("Models: list at most 60".into());
    }
    if !models.is_empty() {
        if out["model"].is_null() {
            return Err("Model: say how a model is passed, such as --model {model}".into());
        }
        out["models"] = json!(models);
    }
    let efforts = match &raw["efforts"] {
        Value::String(line) => line.split([',', ' ', '\n']).filter(|s| !s.is_empty()).map(str::to_owned).collect(),
        other => words(other, "Effort levels")?,
    };
    if efforts.len() > 10 || efforts.iter().any(|level| !EFFORT.is_match(level)) {
        return Err("Effort levels: use up to 10 short names, such as low, medium, high".into());
    }
    if !efforts.is_empty() {
        if out["effort"].is_null() {
            return Err("Effort: say how a level is passed, such as --effort {effort}".into());
        }
        out["efforts"] = json!(efforts);
    } else if !out["effort"].is_null() {
        return Err("Effort levels: list the levels the tool accepts".into());
    }
    if !raw["mcp"].is_null() {
        let mcp = &raw["mcp"];
        let file = paths::home_path(mcp["file"].as_str().ok_or("MCP settings file: pick a file")?, env)?;
        let key = mcp["key"].as_str().map(str::trim).filter(|key| !key.is_empty()).unwrap_or("mcpServers");
        if !KEY.is_match(key) {
            return Err("MCP settings: the key is a name, such as mcpServers".into());
        }
        let add = template(&mcp["add"], "MCP add", "{laci}", true)?;
        let remove = template(&mcp["remove"], "MCP remove", "", false)?;
        if add.is_empty() != remove.is_empty() {
            return Err("MCP: give both the add and the remove arguments, or neither".into());
        }
        if add.is_empty() && file.extension().is_none_or(|ext| ext != "json") {
            return Err("MCP settings file: Laci can only edit a .json file itself".into());
        }
        out["mcp"] = json!({"file":paths::tilde(&file, &env.home),"key":key});
        if !add.is_empty() {
            out["mcp"]["add"] = json!(add);
            out["mcp"]["remove"] = json!(remove);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_filled_template_keeps_one_argument_per_element() {
        let template = strings(&["--message={prompt}", "{prompt}", "--plain"]);
        let prompt = "two words; $(no) {prompt} 'x'";
        assert_eq!(
            fill(&template, "prompt", prompt),
            [format!("--message={prompt}"), prompt.to_owned(), "--plain".to_owned()]
        );
    }
    #[test]
    fn builtins_are_claude_codex_and_antigravity_and_each_can_register_an_mcp_server() {
        let all = builtins();
        assert_eq!(all.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["claude", "codex", "antigravity"]);
        assert_eq!(all.iter().map(|p| p.command.as_str()).collect::<Vec<_>>(), ["claude", "codex", "agy"]);
        for provider in &all {
            let mcp = provider.mcp.as_ref().unwrap();
            assert!(mcp.add.iter().any(|part| part == "{laci}") && mcp.add.iter().any(|part| part == SERVER));
            assert!(!provider.continue_last.is_empty() && !provider.resume.is_empty());
        }
        assert_eq!(all[2].efforts, ["low", "medium", "high", "xhigh", "max"]);
    }
    #[test]
    fn a_described_tool_is_checked_and_becomes_a_provider() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::for_home(home.path().to_owned());
        let agent = validate_agent(
            &env,
            &json!({"command":"aider","prompt":"--message {prompt}","continue":["--restore-chat-history"],
                "model":"--model {model}","models":"sonnet, gpt-5","effort":"--reasoning-effort {effort}","efforts":"low high",
                "mcp":{"file":"~/.tool/mcp.json"}}),
        )
        .unwrap();
        assert_eq!(agent["prompt"], json!(["--message", "{prompt}"]));
        assert_eq!(agent["models"], json!([{"id":"sonnet"},{"id":"gpt-5"}]));
        assert_eq!(agent["mcp"], json!({"file":"~/.tool/mcp.json","key":"mcpServers"}));
        let provider = from_spec(&json!({"id":"custom-aider","name":"Aider","agent":agent})).unwrap();
        assert_eq!((provider.command.as_str(), provider.builtin, provider.custom_model), ("aider", false, true));
        assert_eq!(provider.models[1], json!({"id":"gpt-5","label":"gpt-5","efforts":["low","high"]}));
        assert!(provider.resume.is_empty(), "Laci cannot list a described tool's sessions");
        assert!(from_spec(&json!({"id":"custom-plain","name":"Plain","link":{"kind":"cwd"}})).is_none());

        for (bad, why) in [
            (json!({"command":"/usr/bin/aider"}), "a path is not a program name"),
            (json!({"command":"aider","prompt":"--message"}), "nowhere to put the prompt"),
            (json!({"command":"aider","prompt":"{promt}"}), "misspelt placeholder"),
            (json!({"command":"aider","continue":"--resume {id}"}), "continue takes no value"),
            (json!({"command":"aider","models":"sonnet"}), "models without a way to pass one"),
            (json!({"command":"aider","model":"--model {model}","models":"--yes"}), "a flag is not a model"),
            (json!({"command":"aider","effort":"--effort {effort}"}), "an effort flag without levels"),
            (json!({"command":"aider","mcp":{"file":"/etc/mcp.json"}}), "outside home"),
            (json!({"command":"aider","mcp":{"file":"~/.tool/config.toml"}}), "Laci edits JSON only"),
            (
                json!({"command":"aider","mcp":{"file":"~/.tool/mcp.json","add":"mcp add laci {laci}"}}),
                "add without remove",
            ),
        ] {
            assert!(validate_agent(&env, &bad).is_err(), "{why}");
        }
    }
}
