//! A move, an archive or a restore rewrites the old place in the moved project's own Claude Code memory, and Undo puts
//! the bytes back.
use laci_core::{activity, config, env::Env, paths, service::Service};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

mod support;

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn store(env: &Env, dir: &Path) -> PathBuf {
    env.home.join(".claude/projects").join(paths::enc(&dir.to_string_lossy()))
}
fn project(env: &Env, dir: &Path, memory: &str) {
    write(&dir.join("package.json"), "{}");
    write(&store(env, dir).join("first.jsonl"), &format!("{}\n", json!({"type":"user","cwd":dir})));
    write(&store(env, dir).join("memory/MEMORY.md"), memory);
}
fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

#[test]
fn memory_names_the_new_place_after_a_move_and_undo_puts_the_bytes_back() {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    let archive = temp.path().join("archive");
    for dir in [archive.clone(), env.home.join("project"), env.home.join("opensource")] {
        fs::create_dir_all(dir).unwrap();
    }
    config::save(&env, &json!({"roots":["~/project","~/opensource"],"presets":["claude"],"archiveDir":archive}))
        .unwrap();
    let laci = env.home.join("project/laci");
    let sibling = env.home.join("project/laci-old");
    let own = format!(
        "# Memory\n- Repo: ~/project/laci (see ~/project/laci/src).\n- Full path: {}/README.md\n\
         - Not this one: ~/project/laci-old, nor {}.bak\n",
        laci.display(),
        laci.display()
    );
    let other = "- Laci lives in ~/project/laci\n";
    project(&env, &laci, &own);
    project(&env, &sibling, other);
    // Notes outside the memory folder and global files aren't the project's memory.
    write(&store(&env, &laci).join("notes.md"), other);
    write(&env.home.join(".claude/CLAUDE.md"), other);
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    let id = laci.to_str().unwrap();
    let ops = snap["nodes"][id]["archivePlan"]["ops"].as_array().unwrap().clone();
    assert!(
        ops.iter().any(|op| op["kind"] == "rewrite" && op["label"] == "Update the old path in 1 memory file"),
        "{ops:?}"
    );
    let sibling_ops = snap["nodes"][sibling.to_str().unwrap()]["archivePlan"]["ops"].as_array().unwrap().clone();
    assert!(
        sibling_ops.iter().all(|op| !op["label"].as_str().unwrap_or("").starts_with("Update the old path")),
        "the near-miss name isn't the sibling's own path: {sibling_ops:?}"
    );

    let moved_to = env.home.join("opensource/laci");
    let moved = service.request("move", &json!({"id":id,"destination":moved_to})).unwrap();
    let memory = store(&env, &moved_to).join("memory/MEMORY.md");
    assert_eq!(
        read(&memory),
        format!(
            "# Memory\n- Repo: ~/opensource/laci (see ~/opensource/laci/src).\n- Full path: {}/README.md\n\
             - Not this one: ~/project/laci-old, nor {}.bak\n",
            moved_to.display(),
            laci.display()
        )
    );
    assert_eq!(read(&store(&env, &sibling).join("memory/MEMORY.md")), other);
    assert_eq!(read(&store(&env, &moved_to).join("notes.md")), other);
    assert_eq!(read(&env.home.join(".claude/CLAUDE.md")), other);
    let entries = moved["journal"]["entries"].as_array().unwrap();
    let rewrite = entries.iter().find(|e| e["kind"] == "rewrite" && e["path"] == json!(memory)).unwrap();
    assert!(rewrite["backup"].is_string() && rewrite["afterHash"].is_string(), "{rewrite}");
    assert_eq!(rewrite["what"], "memory");
    // The Log tells the memory files apart from the logs.
    let steps = activity::read_log(&env, 5)[0]["steps"].clone();
    let labels: Vec<_> =
        steps.as_array().unwrap().iter().filter(|s| s["kind"] == "rewrite").map(|s| &s["label"]).collect();
    assert_eq!(
        labels,
        [&json!("Rewrote the folder path in 1 log file"), &json!("Updated the old path in 1 memory file")]
    );

    service.request("undo", &json!({"id":moved["journal"]["id"]})).unwrap();
    assert_eq!(read(&store(&env, &laci).join("memory/MEMORY.md")), own);
    assert!(!store(&env, &moved_to).exists());

    // Into the archive on another disk: the place from ~/ becomes the full path there, and Restore puts the project's
    // own path back in it.
    service.request("archive", &json!({"id":id})).unwrap();
    let dest = archive.join("project/laci");
    let text = read(&store(&env, &dest).join("memory/MEMORY.md"));
    assert!(text.contains(&format!("- Repo: {} (see {}/src)", dest.display(), dest.display())), "{text}");
    assert!(text.contains("~/project/laci-old"), "{text}");
    service.rescan().unwrap();
    service.request("restore", &json!({"id":dest})).unwrap();
    let text = read(&store(&env, &laci).join("memory/MEMORY.md"));
    assert!(text.contains(&format!("- Repo: {} (see {}/src)", laci.display(), laci.display())), "{text}");
    assert_eq!(read(&store(&env, &sibling).join("memory/MEMORY.md")), other);
}

#[test]
fn a_memory_file_changed_after_the_move_keeps_undo_from_losing_it() {
    let temp = support::tempdir();
    let env = Env::for_home(temp.path().join("home"));
    fs::create_dir_all(env.home.join("project")).unwrap();
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"]})).unwrap();
    let app = env.home.join("project/app");
    project(&env, &app, "Path: ~/project/app\n");
    let mut service = Service::new(env.clone());
    service.snapshot().unwrap();
    let to = env.home.join("project/apps/app");
    let moved = service.request("move", &json!({"id":app,"destination":to})).unwrap();
    let memory = store(&env, &to).join("memory/MEMORY.md");
    assert_eq!(read(&memory), "Path: ~/project/apps/app\n");
    write(&memory, "Path: ~/project/apps/app\nLearned later.\n");
    let refused = service.request("undo", &json!({"id":moved["journal"]["id"]})).unwrap_err();
    assert!(refused.contains("MEMORY.md changed after this"), "{refused}");
    assert!(read(&memory).ends_with("Learned later.\n"));
}
