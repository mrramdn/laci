//! Tells whether an agent knows Laci's MCP server, and adds or removes it.
//! Reading is passive: only the agent's settings file is opened. The agent's own program runs
//! only when the user asks for a change.
use crate::{
    Result,
    env::Env,
    files,
    launch::{self, located},
    paths, process,
    providers::{self, Mcp, Provider, SERVER},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

const LIMIT: u64 = 32 * 1024 * 1024;
static TOML_TEXT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#""((?:[^"\\]|\\.)*)"|'([^']*)'"#).expect("TOML text pattern"));

fn toml_texts(value: &str) -> Vec<String> {
    TOML_TEXT
        .captures_iter(value)
        .filter_map(|found| match (found.get(1), found.get(2)) {
            (Some(basic), _) => serde_json::from_str(&format!("\"{}\"", basic.as_str())).ok(),
            (_, Some(literal)) => Some(literal.as_str().to_owned()),
            _ => None,
        })
        .collect()
}
/// Enough TOML to read one server's table: `[key.laci]` followed by `command` and `args` lines.
fn toml_entry(text: &str, key: &str) -> Option<Value> {
    let header =
        regex::Regex::new(&format!(r#"^\[\s*{}\s*\.\s*["']?{SERVER}["']?\s*\]\s*(#.*)?$"#, regex::escape(key))).ok()?;
    let mut entry = None;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            if entry.is_some() {
                break;
            }
            if header.is_match(line) {
                entry = Some(json!({}));
            }
            continue;
        }
        let (Some(entry), Some((name, value))) = (entry.as_mut(), line.split_once('=')) else { continue };
        let value = value.trim();
        match name.trim() {
            "command" => entry["command"] = json!(toml_texts(value).first()),
            "args" => entry["args"] = json!(toml_texts(value)),
            "enabled" => entry["enabled"] = json!(!value.starts_with("false")),
            _ => {}
        }
    }
    entry
}
/// What the agent's settings hold under Laci's name.
fn entry(env: &Env, recipe: &Mcp) -> Option<Value> {
    let file = paths::home_path(&recipe.file, env).ok()?;
    let text = files::read_limit(&file, LIMIT)?;
    if file.extension().is_some_and(|ext| ext == "toml") {
        return toml_entry(&text, &recipe.key);
    }
    let root: Value = serde_json::from_str(&text).ok()?;
    let table = recipe.key.split('.').try_fold(&root, |table, part| table.get(part))?;
    table.get(SERVER).filter(|entry| entry.is_object()).cloned()
}
fn same_program(command: &str, laci: &Path) -> bool {
    let path = Path::new(command);
    let found = if path.is_absolute() {
        Some(path.to_owned())
    } else if command.contains(std::path::is_separator) {
        None
    } else {
        located(command)
    };
    let actual = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_owned());
    found.is_some_and(|found| actual(&found) == actual(laci))
}
/// The shell a command shown for setting MCP up by hand is written for: PowerShell on Windows, which its terminal
/// opens, and a POSIX shell elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shell {
    Posix,
    PowerShell,
}
const SHELL: Shell = if cfg!(windows) { Shell::PowerShell } else { Shell::Posix };

/// A command as it would be typed in this system's shell, for showing and copying. Nothing is ever run from this text.
fn typed(program: &str, args: &[String]) -> String {
    typed_for(SHELL, program, args)
}
fn typed_for(shell: Shell, program: &str, args: &[String]) -> String {
    let line = std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(|word| shell_word(shell, word))
        .collect::<Vec<_>>()
        .join(" ");
    // PowerShell takes a quoted first word for text to print; the call operator runs it.
    if shell == Shell::PowerShell && line.starts_with('\'') { format!("& {line}") } else { line }
}
/// One word as `shell` reads it: as it is when nothing in it means anything to the shell, else in single quotes. A
/// POSIX shell ends a single-quoted word at any `'`, so one is written `'\''`. In PowerShell two quotes stand for one,
/// and the curly quotes count as quotes too. A plain word there starts with a letter, `_`, `\` or `/`, since one that
/// starts with a digit or a dot can be read as a number; and one with a leading dash stays plain only as a flag such as
/// `--scope`: PowerShell may drop a bare `--` before a program sees it, and splits a word such as `-a.b`.
fn shell_word(shell: Shell, word: &str) -> String {
    match shell {
        Shell::Posix => {
            if !word.is_empty() && word.bytes().all(|c| c.is_ascii_alphanumeric() || b"_./:=@%+,-".contains(&c)) {
                word.to_owned()
            } else {
                format!("'{}'", word.replace('\'', "'\\''"))
            }
        }
        Shell::PowerShell => {
            let plain = match word.strip_prefix('-') {
                Some(flag) => {
                    let name = flag.strip_prefix('-').unwrap_or(flag);
                    name.starts_with(|c: char| c.is_ascii_alphanumeric())
                        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                }
                None => {
                    word.starts_with(|c: char| c.is_ascii_alphabetic() || "_\\/".contains(c))
                        && word.chars().all(|c| c.is_ascii_alphanumeric() || "_./\\:-".contains(c))
                }
            };
            if plain {
                return word.to_owned();
            }
            let mut quoted = String::with_capacity(word.len() + 2);
            quoted.push('\'');
            for c in word.chars() {
                if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
                    quoted.push(c);
                }
                quoted.push(c);
            }
            quoted.push('\'');
            quoted
        }
    }
}
fn server(env: &Env) -> Value {
    json!({"command":env.program,"args":["mcp"]})
}

/// `state` is `missing`, `registered` (this Laci), `other` (another program under Laci's name)
/// or `off` (registered but switched off in the agent).
pub fn status(env: &Env, provider: &Provider) -> Value {
    let Some(recipe) = &provider.mcp else {
        return json!({"provider":provider.id,"name":provider.name,"supported":false});
    };
    let laci = env.program.to_string_lossy().into_owned();
    let found = entry(env, recipe);
    let state = match &found {
        None => "missing",
        Some(entry) if entry["disabled"] == true || entry["enabled"] == false => "off",
        Some(entry)
            if entry["command"].as_str().is_some_and(|command| same_program(command, &env.program))
                && entry["args"] == json!(["mcp"]) =>
        {
            "registered"
        }
        Some(_) => "other",
    };
    let mut status = json!({
        "provider":provider.id,"name":provider.name,"supported":true,"state":state,"file":recipe.file,"laci":laci,
        "installed":located(&provider.command).is_some(),"command":provider.command,
    });
    if let Some(entry) = &found {
        let args: Vec<String> =
            entry["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_owned)).collect();
        status["current"] = json!(typed(entry["command"].as_str().unwrap_or("?"), &args));
    }
    // What sets Laci up by hand is left out while its program won't stay ([`Env::fleeting`]): `apply` refuses it too.
    let lasting = env.fleeting().is_none();
    if recipe.add.is_empty() {
        // Shown so the same lines can be put in by hand.
        let nested = recipe.key.rsplit('.').fold(json!({SERVER:server(env)}), |inner, part| json!({part:inner}));
        status["how"] = json!("file");
        if lasting {
            status["snippet"] = json!(serde_json::to_string_pretty(&nested).unwrap_or_default());
        }
    } else {
        status["how"] = json!("command");
        if lasting {
            status["add"] = json!(typed(&provider.command, &providers::fill(&recipe.add, "laci", &laci)));
        }
        status["remove"] = json!(typed(&provider.command, &recipe.remove));
    }
    status
}

const KEPT: usize = 5;
/// Copies the agent's settings file into Laci's own folder before it changes.
fn backup(env: &Env, provider: &Provider, file: &Path) -> Result<Option<PathBuf>> {
    let Ok(meta) = fs::metadata(file) else { return Ok(None) };
    if !meta.is_file() || meta.len() > LIMIT {
        return Err(format!("{} is not a settings file Laci can copy", file.display()));
    }
    let dir = env.data_dir.join("mcp-backups").join(&provider.id);
    for folder in [&env.data_dir, &env.data_dir.join("mcp-backups"), &dir] {
        files::private_dir(folder)?;
    }
    let name = file.file_name().ok_or("Invalid settings file")?.to_string_lossy();
    let target = dir.join(format!("{}-{name}", chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ")));
    files::replace(&target, &fs::read(file).map_err(|e| e.to_string())?)?;
    // The agent's settings can hold account details, so the copy is the owner's alone.
    files::restrict(&target, 0o600).map_err(|e| e.to_string())?;
    let mut copies: Vec<_> = files::entries(&dir).into_iter().map(|entry| entry.path()).collect();
    copies.sort();
    for stale in copies.iter().rev().skip(KEPT) {
        let _ = fs::remove_file(stale);
    }
    Ok(Some(target))
}
fn edit_json(file: &Path, key: &str, entry: Option<Value>) -> Result<()> {
    let untouched = || format!("{} is not a JSON settings file Laci can edit; it was left alone", file.display());
    let mut root = match files::read_limit(file, LIMIT) {
        Some(text) if !text.trim().is_empty() => serde_json::from_str::<Value>(&text).map_err(|_| untouched())?,
        _ => json!({}),
    };
    let mut table = &mut root;
    for part in key.split('.') {
        if !table.is_object() {
            return Err(untouched());
        }
        if table[part].is_null() {
            table[part] = json!({});
        }
        table = &mut table[part];
    }
    let servers = table.as_object_mut().ok_or_else(untouched)?;
    match entry {
        Some(entry) => servers.insert(SERVER.into(), entry),
        None => servers.remove(SERVER),
    };
    let mut text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    text.push('\n');
    files::replace(file, text.as_bytes())
}

/// Adds Laci's server to the agent, or removes it. The settings file is copied first, and the
/// result is read back, so a change that did not land is reported instead of assumed.
pub fn apply(env: &Env, provider: &Provider, remove: bool) -> Result<Value> {
    let recipe = provider
        .mcp
        .as_ref()
        .ok_or_else(|| format!("Laci does not know where {} keeps its MCP servers", provider.name))?;
    let file = paths::home_path(&recipe.file, env)?;
    if !env.program.is_absolute() {
        return Err("Laci could not tell where its own program is installed".into());
    }
    // macOS runs a downloaded Laci from a copy it removes when Laci quits, or from the disk image, and an AppImage
    // runs from a folder that goes with it: an agent told to start that program would find nothing later. Taking the
    // server off needs no program and still works.
    if !remove && let Some(why) = env.fleeting() {
        return Err(why.into());
    }
    let before = status(env, provider);
    if remove && before["state"] == "missing" {
        return Err(format!("{} has no Laci server to remove", provider.name));
    }
    if !remove && before["state"] == "registered" {
        return Ok(json!({"status":before,"changed":false}));
    }
    let by_command = !recipe.add.is_empty();
    if by_command && located(&provider.command).is_none() {
        return Err(format!("{} is not installed or is not on PATH", provider.command));
    }
    let copy = backup(env, provider, &file)?;
    if by_command {
        // The agent must change the same home Laci reads, also when Laci runs on a demo home.
        let vars = launch::agent_home(env, &provider.command)?;
        let vars: Vec<_> = vars.iter().map(|(key, value)| (*key, Some(value.as_str()))).collect();
        let run = |args: &[String]| {
            let args: Vec<_> = args.iter().map(String::as_str).collect();
            process::run_env(&provider.command, &args, Some(&env.home), Duration::from_secs(40), &vars)
        };
        if before["state"] != "missing" {
            run(&recipe.remove)?;
        }
        if !remove {
            run(&providers::fill(&recipe.add, "laci", &env.program.to_string_lossy()))?;
        }
    } else {
        edit_json(&file, &recipe.key, (!remove).then(|| server(env)))?;
    }
    let after = status(env, provider);
    if after["state"] != if remove { "missing" } else { "registered" } {
        return Err(format!(
            "{} ran, but {} does not show the change. Nothing else was touched{}.",
            if by_command { provider.command.as_str() } else { "The edit" },
            recipe.file,
            copy.as_ref().map(|copy| format!("; the earlier file is kept at {}", copy.display())).unwrap_or_default()
        ));
    }
    Ok(json!({"status":after,"changed":true,"backup":copy}))
}

/// One status per connected agent that keeps MCP servers.
pub fn statuses(env: &Env) -> Value {
    let known = providers::all(env);
    let mut out: Vec<Value> = Vec::new();
    for connector in crate::agents::connectors(env, &crate::config::load(env)) {
        let Some(provider) = known.iter().find(|p| connector["provider"] == p.id.as_str()) else { continue };
        if provider.mcp.is_some() && !out.iter().any(|status| status["provider"] == provider.id.as_str()) {
            out.push(status(env, provider));
        }
    }
    json!(out)
}
/// The change a person asked for on an agent's card, written to the Log when it lands.
pub fn change(env: &Env, id: &str, remove: bool, by: &str) -> Result<Value> {
    if !crate::agents::connectors(env, &crate::config::load(env)).iter().any(|c| c["provider"] == id) {
        return Err("Connect this agent before changing its MCP servers".into());
    }
    let provider = providers::get(env, id)?;
    let result = crate::ops::with_lock(env, || apply(env, &provider, remove))?;
    if result["changed"] == true {
        let status = &result["status"];
        let how = if status["how"] == "command" {
            format!("Ran {}", status[if remove { "remove" } else { "add" }].as_str().unwrap_or(&provider.command))
        } else {
            format!("Edited {}", status["file"].as_str().unwrap_or(""))
        };
        let kept = result["backup"]
            .as_str()
            .map(|copy| format!(" · earlier file kept at {}", paths::tilde(Path::new(copy), &env.home)))
            .unwrap_or_default();
        crate::activity::record(
            env,
            json!({"by":by,"title":if remove {
                format!("Removed Laci's MCP server from {}", provider.name)
            } else {
                format!("Added Laci's MCP server to {}", provider.name)
            },"detail":format!("{how}{kept}")}),
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(home: &Path) -> Env {
        let mut env = Env::for_home(home.to_owned());
        env.program = home.join("bin/laci");
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::write(&env.program, "").unwrap();
        env
    }
    fn tool(env: &Env, mcp: Value) -> Provider {
        let agent = providers::validate_agent(env, &json!({"command":"tool","mcp":mcp})).unwrap();
        providers::from_spec(&json!({"id":"custom-tool","name":"Tool","agent":agent})).unwrap()
    }
    #[test]
    fn a_json_settings_file_gains_and_loses_the_server_and_keeps_everything_else() {
        let home = tempfile::tempdir().unwrap();
        let env = env(home.path());
        let provider = tool(&env, json!({"file":"~/.tool/mcp.json","key":"mcp.servers"}));
        let file = home.path().join(".tool/mcp.json");
        let first = status(&env, &provider);
        assert_eq!((&first["state"], &first["how"]), (&json!("missing"), &json!("file")));
        assert!(first["snippet"].as_str().unwrap().contains("\"servers\""));
        assert!(apply(&env, &provider, true).is_err(), "nothing to remove yet");

        // No file yet: it is created, and there is nothing to copy first.
        let done = apply(&env, &provider, false).unwrap();
        assert_eq!((&done["status"]["state"], &done["backup"]), (&json!("registered"), &Value::Null));
        fs::write(&file, r#"{"theme":"dark","mcp":{"servers":{"other":{"command":"x"}}}}"#).unwrap();
        let done = apply(&env, &provider, false).unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["theme"], "dark");
        assert_eq!(saved["mcp"]["servers"]["other"]["command"], "x");
        assert_eq!(saved["mcp"]["servers"]["laci"], json!({"command":env.program,"args":["mcp"]}));
        let copy = PathBuf::from(done["backup"].as_str().unwrap());
        assert!(fs::read_to_string(&copy).unwrap().contains("\"theme\":\"dark\""), "the copy is the file as it was");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&copy).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(apply(&env, &provider, false).unwrap()["changed"], false, "already there");

        apply(&env, &provider, true).unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert!(saved["mcp"]["servers"]["laci"].is_null() && saved["mcp"]["servers"]["other"].is_object());

        fs::write(&file, "// comments make this something else\n{}").unwrap();
        assert!(apply(&env, &provider, false).unwrap_err().contains("left alone"));
        assert!(fs::read_to_string(&file).unwrap().starts_with("// comments"));
    }
    #[test]
    fn another_program_under_the_same_name_and_a_switched_off_server_are_told_apart() {
        let home = tempfile::tempdir().unwrap();
        let env = env(home.path());
        let provider = tool(&env, json!({"file":"~/.tool/mcp.json"}));
        let file = home.path().join(".tool/mcp.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let write = |entry: Value| fs::write(&file, json!({"mcpServers":{"laci":entry}}).to_string()).unwrap();
        write(json!({"command":"/somewhere/else/laci","args":["mcp"]}));
        let other = status(&env, &provider);
        assert_eq!((&other["state"], &other["current"]), (&json!("other"), &json!("/somewhere/else/laci mcp")));
        write(json!({"command":env.program,"args":["mcp","--verbose"]}));
        assert_eq!(status(&env, &provider)["state"], "other");
        write(json!({"command":env.program,"args":["mcp"],"disabled":true}));
        assert_eq!(status(&env, &provider)["state"], "off");
        write(json!({"command":env.program,"args":["mcp"],"disabled":false}));
        assert_eq!(status(&env, &provider)["state"], "registered");
        // Putting it right replaces what was there.
        write(json!({"command":"/somewhere/else/laci","args":["mcp"]}));
        assert_eq!(apply(&env, &provider, false).unwrap()["status"]["state"], "registered");
    }
    #[test]
    fn a_codex_style_table_is_read_from_toml() {
        let home = tempfile::tempdir().unwrap();
        let env = env(home.path());
        let codex = providers::builtins().into_iter().find(|p| p.id == "codex").unwrap();
        assert_eq!(status(&env, &codex)["state"], "missing");
        let laci = env.program.to_str().unwrap();
        // A basic TOML string writes the `\` of a Windows path as `\\`.
        let escaped = laci.replace('\\', r"\\");
        fs::create_dir_all(home.path().join(".codex")).unwrap();
        let write = |body: String| fs::write(home.path().join(".codex/config.toml"), body).unwrap();
        write(format!(
            "model = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"x\"\n\n[mcp_servers.laci] # ours\ncommand = \"{escaped}\"\nargs = [\"mcp\"]\n\n[mcp_servers.laci.env]\nA = \"b\"\n"
        ));
        let found = status(&env, &codex);
        assert_eq!((&found["state"], &found["how"]), (&json!("registered"), &json!("command")));
        // The program as it would be typed in this system's shell.
        assert_eq!(
            found["add"],
            format!("codex mcp add laci {} {} mcp", shell_word(SHELL, "--"), shell_word(SHELL, laci))
        );
        assert_eq!(found["remove"], "codex mcp remove laci");
        write(format!("[mcp_servers.laci]\ncommand = '{laci}'\nargs = ['mcp']\nenabled = false\n"));
        assert_eq!(status(&env, &codex)["state"], "off");
        write("[mcp_servers.lacinia]\ncommand = \"x\"\n".into());
        assert_eq!(status(&env, &codex)["state"], "missing");
    }
    #[test]
    fn a_command_is_shown_quoted_for_the_shell_of_its_system() {
        let line = |shell, words: &[&str]| {
            typed_for(shell, words[0], &words[1..].iter().map(|word| word.to_string()).collect::<Vec<_>>())
        };
        let claude = |laci| ["claude", "mcp", "add", "laci", "--scope", "user", "--", laci, "mcp"];
        // A POSIX shell, as on Linux and macOS.
        let posix = |words: &[&str]| line(Shell::Posix, words);
        assert_eq!(
            posix(&claude("/Applications/Laci.app/Contents/MacOS/laci")),
            "claude mcp add laci --scope user -- /Applications/Laci.app/Contents/MacOS/laci mcp"
        );
        assert_eq!(
            posix(&["codex", "mcp", "add", "laci", "--", "/Users/o'brien/My Apps/Laci.app/Contents/MacOS/laci", "mcp"]),
            r"codex mcp add laci -- '/Users/o'\''brien/My Apps/Laci.app/Contents/MacOS/laci' mcp"
        );
        assert_eq!(
            posix(&["/opt/My Agent/agent", "mcp", "remove", "laci", ""]),
            "'/opt/My Agent/agent' mcp remove laci ''"
        );
        // PowerShell, as on Windows: `--` quoted so that it reaches the agent, and two quotes for one.
        let powershell = |words: &[&str]| line(Shell::PowerShell, words);
        assert_eq!(
            powershell(&claude(r"C:\Users\me\AppData\Local\Laci\bin\laci.exe")),
            r"claude mcp add laci --scope user '--' C:\Users\me\AppData\Local\Laci\bin\laci.exe mcp"
        );
        for (program, shown) in [
            (r"C:\Program Files\Laci\bin\laci.exe", r"'C:\Program Files\Laci\bin\laci.exe'"),
            (r"C:\Users\O'Brien\Laci\bin\laci.exe", r"'C:\Users\O''Brien\Laci\bin\laci.exe'"),
            ("C:\\Users\\O\u{2019}Brien\\laci.exe", "'C:\\Users\\O\u{2019}\u{2019}Brien\\laci.exe'"),
            (r"C:\Users\RUNNER~1\Laci\bin\laci.exe", r"'C:\Users\RUNNER~1\Laci\bin\laci.exe'"),
            (r"$env:USERPROFILE\laci.exe", r"'$env:USERPROFILE\laci.exe'"),
            ("D:\\雨\\laci.exe", "'D:\\雨\\laci.exe'"),
            ("a;b", "'a;b'"),
            ("-a.b", "'-a.b'"),
            ("-", "'-'"),
            ("---", "'---'"),
            ("", "''"),
            // PowerShell could read these as numbers: 1kb is 1024 to it.
            ("1kb", "'1kb'"),
            (r".\laci.exe", r"'.\laci.exe'"),
            ("-v", "-v"),
            ("--a-b", "--a-b"),
            (r"\\server\tools\laci.exe", r"\\server\tools\laci.exe"),
            ("/opt/laci", "/opt/laci"),
        ] {
            assert_eq!(
                powershell(&["codex", "mcp", "add", "laci", "--", program, "mcp"]),
                format!("codex mcp add laci '--' {shown} mcp")
            );
        }
        // A quoted program is run with the call operator; PowerShell would print it otherwise.
        assert_eq!(
            powershell(&[r"C:\Program Files\Agent\agent.exe", "mcp", "remove", "laci"]),
            r"& 'C:\Program Files\Agent\agent.exe' mcp remove laci"
        );
        assert_eq!(powershell(&[r"C:\Tools\agent.exe", "mcp"]), r"C:\Tools\agent.exe mcp");
    }
    #[test]
    fn a_program_that_is_gone_once_laci_quits_is_never_offered_to_an_agent() {
        let home = tempfile::tempdir().unwrap();
        let mut env = env(home.path());
        let by_file = tool(&env, json!({"file":"~/.tool/mcp.json"}));
        let by_command = tool(&env, json!({"file":"~/.agent/mcp.json","add":"add {laci} mcp","remove":"remove"}));
        let file = home.path().join(".tool/mcp.json");
        let moved = "Move Laci to Applications first, then connect it again.";
        let unpacked = "Laci can't tell which AppImage file it runs from, and the folder it runs in is gone once it \
                        quits. Start Laci from its AppImage file, then connect it again.";
        let (mac, linux) = (cfg!(target_os = "macos"), cfg!(target_os = "linux"));
        for (program, refused) in [
            // macOS: the copy it made of a download, or a disk image.
            ("/Volumes/Laci/Laci.app/Contents/MacOS/laci", mac.then_some(moved)),
            ("/private/var/folders/x/T/AppTranslocation/0F1E/d/Laci.app/Contents/MacOS/laci", mac.then_some(moved)),
            // Linux: the folder an AppImage runs from, when Laci couldn't make sure which AppImage that is.
            ("/tmp/.mount_LaciAbC/usr/bin/laci", linux.then_some(unpacked)),
            ("/tmp/appimage_extracted_9f2/usr/bin/laci", linux.then_some(unpacked)),
            ("/opt/Laci/usr/bin/laci", None),
        ] {
            env.program = PathBuf::from(program);
            assert_eq!(env.fleeting(), refused, "{program}");
            // Nothing to set it up by hand either; taking it off is still shown.
            let (shown, typed) = (status(&env, &by_file), status(&env, &by_command));
            assert_eq!(
                (shown["snippet"].is_string(), typed["add"].is_string()),
                (refused.is_none(), refused.is_none())
            );
            assert_eq!(typed["remove"], "tool remove", "{program}");
            let added = apply(&env, &by_file, false);
            if let Some(why) = refused {
                assert_eq!(added.unwrap_err(), why);
                assert!(!file.exists(), "nothing was written");
            } else {
                // Elsewhere such a path is like any other.
                assert!(added.err().is_none_or(|error| !error.contains("connect it again")), "{program}");
                let _ = fs::remove_file(&file);
            }
        }
        // Taking the server off needs no program that lasts. (On Windows a path without a drive is no program at all.)
        if cfg!(unix) {
            env.program = PathBuf::from("/Volumes/Laci/Laci.app/Contents/MacOS/laci");
            let entry = json!({"command":"/Applications/Laci.app/Contents/MacOS/laci","args":["mcp"]});
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, json!({"mcpServers":{"laci":entry}}).to_string()).unwrap();
            assert_eq!(apply(&env, &by_file, true).unwrap()["status"]["state"], "missing");
        }
    }
    #[cfg(unix)]
    #[test]
    fn the_agents_own_command_is_run_in_laci_home_and_a_change_that_did_not_land_is_reported() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let env = env(home.path());
        // A stand-in for an agent's CLI: it records its arguments in the settings file under $HOME.
        let stub = home.path().join("bin/agent");
        fs::write(
            &stub,
            "#!/bin/sh\nmkdir -p \"$HOME/.agent\"\nif [ \"$1\" = add ]; then\n  printf '{\"mcpServers\":{\"laci\":{\"command\":\"%s\",\"args\":[\"%s\"]}}}' \"$2\" \"$3\" > \"$HOME/.agent/mcp.json\"\nelif [ \"$1\" = remove ]; then\n  printf '{\"mcpServers\":{}}' > \"$HOME/.agent/mcp.json\"\nfi\n",
        )
        .unwrap();
        fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).unwrap();
        let mut provider = tool(&env, json!({"file":"~/.agent/mcp.json","add":"add {laci} mcp","remove":"remove"}));
        provider.command = stub.to_string_lossy().into_owned();
        let first = status(&env, &provider);
        assert_eq!((&first["state"], &first["installed"]), (&json!("missing"), &json!(true)));
        assert!(first["add"].as_str().unwrap().ends_with(&format!("add {} mcp", env.program.display())));
        assert_eq!(apply(&env, &provider, false).unwrap()["status"]["state"], "registered");
        let done = apply(&env, &provider, true).unwrap();
        assert_eq!(done["status"]["state"], "missing");
        assert!(Path::new(done["backup"].as_str().unwrap()).starts_with(env.data_dir.join("mcp-backups/custom-tool")));

        provider.mcp.as_mut().unwrap().add = vec!["nothing".into()];
        assert!(apply(&env, &provider, false).unwrap_err().contains("does not show the change"));
        provider.command = "laci-test-no-such-agent".into();
        assert!(apply(&env, &provider, false).unwrap_err().contains("not installed"));
        assert_eq!(status(&env, &provider)["installed"], false);
    }
    /// Runs the real `claude`, `codex` and `agy` when they are installed, against a home made for the test.
    /// `cargo test -p laci-core --lib real_agents -- --ignored`
    #[test]
    #[ignore = "starts the installed agent CLIs"]
    fn real_agents_take_and_drop_the_server_in_a_throwaway_home() {
        let mut checked = Vec::new();
        for provider in providers::builtins() {
            if located(&provider.command).is_none() {
                continue;
            }
            let home = tempfile::tempdir().unwrap();
            let env = env(home.path());
            assert_eq!(status(&env, &provider)["state"], "missing", "{}", provider.id);
            let added = apply(&env, &provider, false).unwrap();
            assert_eq!(added["status"]["state"], "registered", "{}", provider.id);
            assert_eq!(apply(&env, &provider, false).unwrap()["changed"], false);
            let removed = apply(&env, &provider, true).unwrap();
            assert_eq!(removed["status"]["state"], "missing", "{}", provider.id);
            assert!(removed["backup"].is_string(), "the file that held the server was copied first");
            checked.push(provider.id);
        }
        println!("checked: {checked:?}");
    }
}
