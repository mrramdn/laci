use laci_core::{config, create, env::Env};
use serde_json::json;
use std::{
    fs,
    sync::{Arc, atomic::AtomicBool},
    thread,
    time::{Duration, Instant},
};

mod support;

fn setup() -> (support::TempDir, Env) {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().to_owned());
    fs::create_dir(temp.path().join("projects with spaces")).unwrap();
    (temp, env)
}
fn recipe(env: &Env, script: &str) {
    create::generator::save(env,&json!({"id":"fixture","name":"Fixture generator","program":"sh","args":["-c",script,"--","{name}"],"download":false})).unwrap();
}
fn request(name: &str) -> serde_json::Value {
    json!({"parent":"~/projects with spaces","name":name,"from":"generator","recipe":"fixture","remote":"none"})
}
#[test]
fn generator_finishes_before_metadata_and_preserves_failure_output() {
    let (_temp, env) = setup();
    recipe(
        &env,
        "test ! -e \"$1/.git\" && test ! -e \"$1/README.md\"; printf 'partial' > \"$1/scaffold.txt\"; echo 'visible output'; exit 7",
    );
    let error = create::create_project(&env, &request("broken")).unwrap_err();
    let path = env.home.join("projects with spaces/broken");
    assert!(error.contains("Partial output kept"));
    assert_eq!(fs::read_to_string(path.join("scaffold.txt")).unwrap(), "partial");
    assert!(!path.join(".git").exists());
    assert!(!path.join(".laci.md").exists());
    assert!(create::create_project(&env, &request("broken")).unwrap_err().contains("already exists"));
    recipe(&env, "printf '# Template\n' > \"$1/README.md\"");
    let made = create::create_project(&env, &request("complete")).unwrap();
    let path = std::path::Path::new(made["path"].as_str().unwrap());
    assert_eq!(fs::read_to_string(path.join("README.md")).unwrap(), "# Template\n");
    assert!(path.join(".git").is_dir());
    assert!(path.join(".laci.md").is_file());
}
#[test]
fn generator_cancellation_stops_owned_descendants_and_keeps_partial_folder() {
    let (_temp, env) = setup();
    recipe(&env, "printf ready > \"$1/ready\"; (sleep 1; printf escaped > \"$1/escaped\") & wait");
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let worker_env = env.clone();
    let worker = thread::spawn(move || {
        create::create_with_progress(&worker_env, &request("cancelled"), &worker_cancel, &|_| {})
    });
    let path = env.home.join("projects with spaces/cancelled");
    let start = Instant::now();
    while !path.join("ready").exists() && start.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(path.join("ready").exists());
    cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(worker.join().unwrap().unwrap_err().contains("cancelled"));
    thread::sleep(Duration::from_millis(1100));
    assert!(!path.join("escaped").exists());
    assert!(!path.join(".laci.md").exists());
}
#[test]
fn template_references_are_explicit_and_copy_without_git_history() {
    let (_temp, env) = setup();
    let template = env.home.join("custom starter");
    fs::create_dir(&template).unwrap();
    fs::create_dir(template.join(".git")).unwrap();
    fs::write(template.join(".git/private"), "not copied").unwrap();
    fs::write(template.join("README.md"), "# Starter").unwrap();
    create::add_template(&env, template.to_str().unwrap()).unwrap();
    let made=create::create_project(&env,&json!({"parent":"~/projects with spaces","name":"from-template","from":"template","template":template,"remote":"none"})).unwrap();
    let path = std::path::Path::new(made["path"].as_str().unwrap());
    assert!(!path.join(".git/private").exists());
    assert_eq!(fs::read_to_string(path.join("README.md")).unwrap(), "# Starter");
    assert_eq!(config::load(&env)["templatePaths"][0], template.to_string_lossy().as_ref());
}
#[test]
fn generator_preview_and_validation_do_not_execute_recipes() {
    let (_temp, env) = setup();
    recipe(&env, "touch executed");
    let preview = create::generator::plan(&env, &request("safe")).unwrap().preview();
    assert_eq!(preview["download"], false);
    assert!(!env.home.join("executed").exists());
    assert!(create::generator::plan(&env, &request("-flag")).is_err());
    assert!(create::generator::plan(&env, &request("bad;touch injected")).is_err());
    let default = create::generator::plan(&env, &json!({"name":"app"})).unwrap().preview();
    assert_eq!(default["download"], true);
    assert!(default["command"].as_str().unwrap().contains("vite@latest"));
    create::generator::save(&env,&json!({"id":"missing","name":"Missing runtime","program":"laci-no-such-runtime","args":["{name}"],"download":false})).unwrap();
    let mut r = request("missing");
    r["recipe"] = json!("missing");
    assert!(!create::generator::plan(&env, &r).unwrap().preview()["missing"].as_array().unwrap().is_empty());
}

#[test]
fn template_cannot_recursively_copy_into_itself() {
    let (_temp, env) = setup();
    let template = env.home.join("projects with spaces");
    create::add_template(&env, template.to_str().unwrap()).unwrap();
    let error = create::create_project(
        &env,
        &json!({"parent":template,"name":"recursive","from":"template","template":template}),
    )
    .unwrap_err();
    assert!(error.contains("inside its template"));
    assert!(!template.join("recursive").exists());
}

#[test]
fn a_template_added_by_path_is_found_by_another_spelling_of_that_path() {
    let (_temp, env) = setup();
    let template = env.home.join("custom starter");
    fs::create_dir(&template).unwrap();
    fs::write(template.join("README.md"), "# Starter").unwrap();
    create::add_template(&env, template.to_str().unwrap()).unwrap();
    let request = |name: &str, template: &str| json!({"parent":"~/projects with spaces","name":name,"from":"template","template":template,"remote":"none"});
    // An agent may name it from home, or with a separator at the end.
    for (name, spelling) in
        [("from-home", "~/custom starter".to_owned()), ("ended", format!("{}/", template.display()))]
    {
        let made = create::create_project(&env, &request(name, &spelling)).unwrap();
        let path = std::path::Path::new(made["path"].as_str().unwrap());
        assert_eq!(fs::read_to_string(path.join("README.md")).unwrap(), "# Starter", "{spelling}");
    }
    assert_eq!(create::create_project(&env, &request("other", "~/custom")).unwrap_err(), "Unknown template");
}

/// Where names that differ only in case lead to the same folder, a template named in another case is the one that was
/// added, and a location named in another case is still inside it.
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn a_template_named_in_another_case_is_never_copied_into_itself() {
    let (_temp, env) = setup();
    let template = env.home.join("projects with spaces");
    let parent = env.home.join("PROJECTS WITH SPACES");
    if !parent.is_dir() {
        eprintln!("This volume tells case apart; nothing to check.");
        return;
    }
    create::add_template(&env, template.to_str().unwrap()).unwrap();
    let error = create::create_project(
        &env,
        &json!({"parent":parent,"name":"recursive","from":"template","template":env.home.join("Projects With Spaces")}),
    )
    .unwrap_err();
    assert!(error.contains("inside its template"), "{error}");
    assert!(!template.join("recursive").exists());
}

#[test]
fn successful_generator_cannot_leave_descendants_writing_after_finalization() {
    let (_temp, env) = setup();
    recipe(&env, "printf ready > \"$1/ready\"; (sleep 1; printf late > \"$1/late\") & exit 0");
    create::create_project(&env, &request("background")).unwrap();
    thread::sleep(Duration::from_millis(1100));
    let path = env.home.join("projects with spaces/background");
    assert!(path.join("ready").exists());
    assert!(!path.join("late").exists(), "a generator child wrote after project initialization");
}

#[test]
fn generator_gitdir_reference_cannot_initialize_another_repository() {
    let (_temp, env) = setup();
    let outside = env.home.join("other-repo");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel"), "unchanged").unwrap();
    let script = format!("printf 'gitdir: %s\\n' '{}' > \"$1/.git\"", outside.display());
    recipe(&env, &script);
    let error = create::create_project(&env, &request("linked")).unwrap_err();
    assert!(error.contains("generator created Git metadata"));
    assert!(error.contains("Partial output kept"));
    assert!(env.home.join("projects with spaces/linked/.git").is_file());
    assert_eq!(fs::read_to_string(outside.join("sentinel")).unwrap(), "unchanged");
    assert!(!outside.join("HEAD").exists());
}

#[test]
fn configured_template_alias_cannot_bypass_self_copy_guard() {
    let (_temp, env) = setup();
    fs::create_dir(env.home.join("alias")).unwrap();
    let template = env.home.join("alias/../projects with spaces");
    config::save(&env, &json!({"templatePaths":[template]})).unwrap();
    let error = create::create_project(
        &env,
        &json!({
            "parent":"~/projects with spaces","name":"recursive-alias","from":"template","template":template
        }),
    )
    .unwrap_err();
    assert!(error.contains("inside its template"));
    assert!(!env.home.join("projects with spaces/recursive-alias").exists());
}
