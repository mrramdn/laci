//! Explicit recipes run as argv, with bounded output and owned-process cancellation.
use crate::{Result, config, env::Env, ops, process, service::shell_quote};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub fn recipes(env: &Env) -> Vec<Value> {
    let mut recipes = vec![
        json!({"id":"vite","name":"Vite","program":"pnpm","args":["create","vite@latest","{name}","--template","{template}","--no-interactive"],"runtime":"node","download":true}),
    ];
    recipes.extend(config::load(env)["recipes"].as_array().into_iter().flatten().filter_map(|r| validate(r).ok()));
    recipes
}
fn validate(r: &Value) -> Result<Value> {
    let name = r["name"].as_str().unwrap_or("").trim();
    let id = r["id"].as_str().unwrap_or("");
    let program = r["program"].as_str().unwrap_or("");
    let simple = regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$").unwrap();
    if name.is_empty() || name.len() > 100 || !simple.is_match(id) || id == "vite" || !simple.is_match(program) {
        return Err("Recipe needs a name, a unique ID (other than vite), and a program name".into());
    }
    let args = r["args"].as_array().ok_or("Recipe args must be an array of strings")?;
    if args.len() > 50
        || !args.iter().all(|v| v.as_str().is_some_and(|s| s.len() <= 2000 && !s.contains('\0')))
        || !args.iter().any(|v| v.as_str().is_some_and(|s| s.contains("{name}")))
    {
        return Err("Recipe args must include {name} and contain at most 50 arguments".into());
    }
    let runtime = r["runtime"].as_str().unwrap_or("");
    if !runtime.is_empty() && !simple.is_match(runtime) {
        return Err("Use a runtime program name".into());
    }
    Ok(
        json!({"id":id,"name":name,"program":program,"args":args,"runtime":runtime,"download":r["download"].as_bool().unwrap_or(true)}),
    )
}
pub fn save(env: &Env, recipe: &Value) -> Result<Value> {
    let recipe = validate(recipe)?;
    ops::with_lock(env, || {
        let mut c = config::load(env);
        let mut recipes = c["recipes"].as_array().cloned().unwrap_or_default();
        recipes.retain(|r| r["id"] != recipe["id"]);
        recipes.push(recipe);
        c["recipes"] = json!(recipes);
        config::save(env, &c)?;
        Ok(json!({"recipes":self::recipes(env)}))
    })
}
pub struct Plan {
    pub recipe: String,
    pub program: String,
    pub args: Vec<String>,
    pub runtime: String,
    pub download: bool,
}
impl Plan {
    pub fn preview(&self) -> Value {
        let mut missing = Vec::new();
        for program in [&self.program, &self.runtime].into_iter().filter(|s| !s.is_empty()) {
            if !available(program) {
                missing.push(program.clone());
            }
        }
        let runtime_version = if self.runtime == "node" && available("node") {
            process::run("node", &["--version"], None, Duration::from_secs(3)).ok()
        } else {
            None
        };
        if self.recipe == "vite"
            && let Some(version) = &runtime_version
        {
            let parts: Vec<u32> = version.trim_start_matches('v').split('.').filter_map(|v| v.parse().ok()).collect();
            if parts.len() < 2
                || !(parts[0] == 20 && parts[1] >= 19 || parts[0] == 22 && parts[1] >= 12 || parts[0] > 22)
            {
                missing.push("Node.js 20.19+ or 22.12+".into());
            }
        }
        json!({"command":std::iter::once(&self.program).chain(self.args.iter()).map(|s|shell_quote(s)).collect::<Vec<_>>().join(" "),"program":self.program,"args":self.args,"runtime":self.runtime,"runtimeVersion":runtime_version,"download":self.download,"missing":missing})
    }
}
fn available(program: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .any(|p| p.join(program).metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}
pub fn plan(env: &Env, r: &Value) -> Result<Plan> {
    let id = r["recipe"].as_str().unwrap_or("vite");
    let recipe = recipes(env).into_iter().find(|v| v["id"] == id).ok_or("Unknown generator recipe")?;
    let name = r["name"].as_str().unwrap_or("my-app");
    if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$").unwrap().is_match(name) {
        return Err("Choose a valid project name for the preview".into());
    }
    let template = r["generatorTemplate"].as_str().unwrap_or("react-ts");
    if id == "vite"
        && ![
            "vanilla",
            "vanilla-ts",
            "vue",
            "vue-ts",
            "react",
            "react-ts",
            "react-swc",
            "react-swc-ts",
            "preact",
            "preact-ts",
            "lit",
            "lit-ts",
            "svelte",
            "svelte-ts",
            "solid",
            "solid-ts",
            "qwik",
            "qwik-ts",
        ]
        .contains(&template)
    {
        return Err("Unknown Vite template".into());
    }
    Ok(Plan {
        recipe: id.into(),
        program: recipe["program"].as_str().unwrap().into(),
        args: recipe["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().replace("{name}", name).replace("{template}", template))
            .collect(),
        runtime: recipe["runtime"].as_str().unwrap_or("").into(),
        download: recipe["download"] == true,
    })
}
pub fn run(plan: &Plan, cwd: &Path, cancel: &AtomicBool, progress: &dyn Fn(&str)) -> Result<()> {
    let preview = plan.preview();
    if preview["missing"].as_array().is_some_and(|a| !a.is_empty()) {
        return Err(format!("Missing prerequisite: {}", preview["missing"]));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("Generator cancelled".into());
    }
    progress(&format!("{}\n", preview["command"].as_str().unwrap_or("")));
    let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut reader = output.reopen().map_err(|e| e.to_string())?;
    let mut child = Command::new(&plan.program)
        .args(&plan.args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(output.as_file().try_clone().map_err(|e| e.to_string())?)
        .stderr(output.as_file().try_clone().map_err(|e| e.to_string())?)
        .process_group(0)
        .env("NO_COLOR", "1")
        .spawn()
        .map_err(|e| format!("Couldn't start {}: {e}", plan.program))?;
    let group = rustix::process::Pid::from_raw(child.id() as i32).ok_or("Invalid generator process")?;
    let started = Instant::now();
    let mut offset = 0;
    let outcome = (|| -> Result<()> {
        loop {
            drain(&mut reader, &mut offset, progress)?;
            if cancel.load(Ordering::Relaxed) {
                return Err("Generator cancelled".into());
            }
            if started.elapsed() > Duration::from_secs(900) {
                return Err("Generator exceeded 15 minutes".into());
            }
            if offset > 16_000_000 {
                return Err("Generator output exceeded 16 MB".into());
            }
            // Leave the leader unreaped until all its descendants have been stopped.
            // Its PID cannot be reused as an unrelated process group during cleanup.
            use rustix::process::{WaitId, WaitIdOptions, waitid};
            if waitid(WaitId::Pid(group), WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT)
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(40));
        }
    })();
    // A successful leader can still leave children running. Finalization must never race them.
    let _ = rustix::process::kill_process_group(group, rustix::process::Signal::TERM);
    thread::sleep(Duration::from_millis(150));
    let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
    let status = child.wait().map_err(|e| e.to_string());
    drain(&mut reader, &mut offset, progress)?;
    outcome?;
    if offset > 16_000_000 {
        return Err("Generator output exceeded 16 MB".into());
    }
    let status = status?;
    if status.success() { Ok(()) } else { Err(format!("Generator exited with {status}")) }
}

fn drain(file: &mut File, offset: &mut u64, progress: &dyn Fn(&str)) -> Result<()> {
    let end = file.metadata().map_err(|e| e.to_string())?.len();
    if end > *offset {
        // Reading the latest output stays bounded even when a noisy generator floods stdout.
        file.seek(SeekFrom::Start((*offset).max(end.saturating_sub(32_768)))).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        (&mut *file).take(32_768).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        *offset = end;
        progress(&String::from_utf8_lossy(&bytes));
    }
    Ok(())
}
