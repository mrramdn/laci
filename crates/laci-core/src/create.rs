//! Creation options used by the desktop form and MCP tool.
use crate::{Result, config, env::Env, files, ops, paths, process, sidecar};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
pub mod generator;

pub fn templates(env: &Env) -> Vec<String> {
    let mut choices: Vec<_> = files::entries(&env.config_dir.join("templates"))
        .into_iter()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    choices.extend(
        config::load(env)["templatePaths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    choices.sort();
    choices.dedup();
    choices
}
pub fn add_template(env: &Env, raw: &str) -> Result<Value> {
    let path = paths::selected_directory(raw, env)?;
    sidecar::plain_path(&path)?;
    ops::with_lock(env, || {
        let mut c = config::load(env);
        let mut list = c["templatePaths"].as_array().cloned().unwrap_or_default();
        let value = json!(path);
        if !list.contains(&value) {
            list.push(value);
        }
        c["templatePaths"] = json!(list);
        config::save(env, &c)?;
        Ok(json!({"templates":templates(env),"path":path}))
    })
}
pub fn hosts() -> Value {
    std::thread::scope(|scope| {
        let github = scope.spawn(|| process::run("gh", &["auth", "status"], None, Duration::from_secs(8)).is_ok());
        let gitlab = process::run("glab", &["auth", "status"], None, Duration::from_secs(8)).is_ok();
        json!({"github": github.join().unwrap_or(false), "gitlab": gitlab})
    })
}
fn git(dir: &Path, args: &[&str]) -> Result<String> {
    process::run("git", args, Some(dir), Duration::from_secs(60))
}
/// Questions about the new repository, asked the same guarded way as everywhere else.
fn git_read(dir: &Path, args: &[&str]) -> Result<String> {
    crate::git::plain(dir, args, Duration::from_secs(60))
}

pub fn create_project(env: &Env, request: &Value) -> Result<Value> {
    create_with_progress(env, request, &AtomicBool::new(false), &|_| {})
}
pub fn create_with_progress(env: &Env, request: &Value, cancel: &AtomicBool, progress: &dyn Fn(&str)) -> Result<Value> {
    ops::with_lock(env, || create_unlocked(env, request, cancel, progress))
}
fn create_unlocked(env: &Env, r: &Value, cancel: &AtomicBool, progress: &dyn Fn(&str)) -> Result<Value> {
    let name = r["name"].as_str().unwrap_or("").trim();
    if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$").unwrap().is_match(name) {
        return Err("Name: letters, numbers, dots, dashes or underscores, no spaces".into());
    }
    let parent = paths::workspace_path(r["parent"].as_str().ok_or("Pick a location")?, env)?;
    sidecar::plain_path(&parent)?;
    if !parent.is_dir() {
        return Err("Location doesn't exist".into());
    }
    let dest = parent.join(name);
    if fs::symlink_metadata(&dest).is_ok() {
        return Err(format!("{} already exists", paths::tilde(&dest, &env.home)));
    }
    let summary = r["summary"]
        .as_str()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(300)
        .collect::<String>();
    let from = r["from"].as_str().unwrap_or("");
    let remote = r["remote"].as_str().unwrap_or("none");
    if !["none", "github", "gitlab", "both"].contains(&remote) {
        return Err("Pick where to push it".into());
    }
    let url = r["url"].as_str().unwrap_or("").trim();
    if from == "clone"
        && !regex::Regex::new(r"^(https://[^\s]+|git@[^\s:]+:[^\s]+|ssh://[^\s]+)$").unwrap().is_match(url)
    {
        return Err("Repo URL: https://… or git@host:owner/repo".into());
    }
    let template = r["template"].as_str().unwrap_or("");
    if from == "template" && !templates(env).iter().any(|t| t == template) {
        return Err("Unknown template".into());
    }
    let template_source = if from == "template" {
        let source = if Path::new(template).is_absolute() {
            Path::new(template).to_owned()
        } else {
            env.config_dir.join("templates").join(template)
        };
        let source = paths::normalize(&source);
        sidecar::plain_path(&source)?;
        if !source.is_dir() {
            return Err("The template folder is unavailable".into());
        }
        if dest.starts_with(&source) {
            return Err("The new project cannot be inside its template folder".into());
        }
        Some(source)
    } else {
        None
    };
    if !["empty", "template", "clone", "generator"].contains(&from) {
        return Err("Pick how to start".into());
    }
    let generator = if from == "generator" { Some(generator::plan(env, r)?) } else { None };
    if cancel.load(Ordering::Relaxed) {
        return Err("Creation cancelled".into());
    }
    fs::create_dir(&dest).map_err(|e| e.to_string())?;
    let mut warnings = vec![];
    let made = (|| {
        if from == "clone" {
            git(&dest, &["clone", "-q", "--", url, "."])
                .map_err(|_| "git clone failed. Check the URL and that you're logged in to the host.".to_owned())?;
        } else {
            if let Some(plan) = &generator {
                generator::run(plan, &parent, cancel, progress)?;
                // A scaffold may have replaced paths; never initialize through links.
                sidecar::plain_path(&dest)?;
                if fs::symlink_metadata(dest.join(".git")).is_ok() {
                    return Err("The generator created Git metadata. Review the generated repository before initializing it manually.".into());
                }
            }
            if let Some(src) = &template_source {
                sidecar::plain_path(src)?;
                for e in files::entries(src) {
                    if e.file_name() != ".git" {
                        ops::copy_template(&e.path(), &dest.join(e.file_name()))?;
                    }
                }
            }
            if cancel.load(Ordering::Relaxed) {
                return Err("Creation cancelled".into());
            }
            progress("Scaffold ready. Initializing project metadata…\n");
            sidecar::plain_path(&dest.join(".git"))?;
            sidecar::plain_path(&dest.join(sidecar::SIDECAR))?;
            let readme = dest.join("README.md");
            if fs::symlink_metadata(&readme).is_err() {
                files::replace(
                    &readme,
                    format!("# {name}\n{}", if summary.is_empty() { String::new() } else { format!("\n{summary}\n") })
                        .as_bytes(),
                )?;
            }
            git(&dest, &["init", "-q", "-b", "main"])?;
            sidecar::ensure_excluded(&dest)?;
            git(&dest, &["add", "-A"])?;
            if git(&dest, &["commit", "-qm", "chore: initial commit"]).is_err() {
                warnings.push("No first commit: set your name and email with git config".to_owned());
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Creation cancelled".into());
        }
        files::replace(
            &dest.join(sidecar::SIDECAR),
            format!(
                "---\nstatus: active\n---\n{}\n## Next\n\n## Notes\n",
                if summary.is_empty() { String::new() } else { format!("\n## Summary\n\n{summary}\n") }
            )
            .as_bytes(),
        )?;
        sidecar::ensure_excluded(&dest)
    })();
    if let Err(e) = made {
        if from == "generator" {
            return Err(format!(
                "{e}\nPartial output kept at {}. Inspect it before choosing a new destination.",
                dest.display()
            ));
        }
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }
    if cancel.load(Ordering::Relaxed) {
        warnings.push("Project created; cancellation prevented any remaining remote creation.".into());
    }
    if remote != "none" && from != "clone" && !cancel.load(Ordering::Relaxed) {
        if git_read(&dest, &["rev-parse", "--verify", "HEAD"]).is_err() {
            warnings.push("Nothing committed yet, so no remote was created".into());
        } else {
            let mut github = None;
            if (remote == "github" || remote == "both") && !cancel.load(Ordering::Relaxed) {
                let dest_s = dest.to_string_lossy();
                if process::run(
                    "gh",
                    &["repo", "create", name, "--private", "--source", &dest_s, "--remote", "origin", "--push"],
                    None,
                    Duration::from_secs(120),
                )
                .is_ok()
                {
                    github = git_read(&dest, &["remote", "get-url", "origin"]).ok();
                } else {
                    warnings.push(
                        "Creating the GitHub repo failed. Check `gh auth status`, or whether the name is taken.".into(),
                    );
                }
            }
            if (remote == "gitlab" || remote == "both") && !cancel.load(Ordering::Relaxed) {
                let made = process::run(
                    "glab",
                    &["repo", "create", name, "--private", "--skipGitInit", "--defaultBranch", "main"],
                    None,
                    Duration::from_secs(60),
                );
                let url = made
                    .and_then(|_| process::run("glab", &["api", "user"], None, Duration::from_secs(15)))
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .and_then(|v| v["web_url"].as_str().map(|s| format!("{s}/{name}.git")));
                if let Some(url) = url {
                    let setup = if let Some(gh) = github {
                        git(&dest, &["remote", "set-url", "--add", "--push", "origin", &gh])
                            .and_then(|_| git(&dest, &["remote", "set-url", "--add", "--push", "origin", &url]))
                            .and_then(|_| git(&dest, &["remote", "add", "gitlab", &url]))
                    } else {
                        git(&dest, &["remote", "add", "origin", &url])
                    };
                    if setup.and_then(|_| git(&dest, &["push", "-q", "-u", "origin", "main"])).is_err() {
                        warnings.push("Pushing to GitLab failed; run git push later".into());
                    }
                } else {
                    warnings.push(
                        "Creating the GitLab repo failed. Check `glab auth status`, or whether the name is taken."
                            .into(),
                    );
                }
            }
        }
    }
    if r["scanProject"] == true {
        let mut c = config::load(env);
        let mut roots = c["roots"].as_array().cloned().unwrap_or_default();
        if !roots.iter().filter_map(Value::as_str).any(|root| dest.starts_with(paths::expand(root, &env.home))) {
            roots.push(json!(paths::tilde(&dest, &env.home)));
            c["roots"] = json!(roots);
            c["rootIdentities"] = config::root_identities(env, &c["roots"], &c["rootIdentities"]);
            if let Err(error) = config::save(env, &c) {
                warnings.push(format!("Project created, but adding its scan location failed: {error}"));
            }
        }
    }
    Ok(json!({"path": dest, "warnings": warnings}))
}
