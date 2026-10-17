//! A file keeps the line ending it has. Laci edits a CRLF file in CRLF and an LF file as it always did, so a to-do
//! file that Git checked out with CRLF on Windows does not end up with a mix of both.
use laci_core::{activity, config, env::Env, readers, service::Service, sidecar};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

// A project's `.laci.md` and a to-do file, written with LF line endings. The tests turn them into CRLF where needed.
const LACI_MD: &str =
    "---\nstatus: active\n---\n\n## Next\n\n- [ ] Write docs\n- [ ] Ship it\n\n## Notes\n\nbase notes\n";
const TODO_MD: &str = "# Todo\n\n- [ ] Fix bug\n- [x] Update docs\n";

/// `text` written with LF line endings, or with CRLF.
fn ending(text: &str, crlf: bool) -> String {
    if crlf { text.replace('\n', "\r\n") } else { text.to_owned() }
}
fn name(crlf: bool) -> &'static str {
    if crlf { "CRLF" } else { "LF" }
}
fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}
/// Edits a `.laci.md` that holds `before`, once with LF and once with CRLF line endings. Both must end up holding
/// `after`, with the same line endings.
fn edited(before: &str, after: &str, edit: impl Fn(&Path)) {
    for crlf in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join(".laci.md"), &ending(before, crlf));
        edit(temp.path());
        assert_eq!(read(&temp.path().join(".laci.md")), ending(after, crlf), "{}", name(crlf));
    }
}
fn fixture(crlf: bool) -> (tempfile::TempDir, Env, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let project = env.home.join("project/demo");
    write(&project.join("package.json"), r#"{"name":"demo"}"#);
    write(&project.join(".laci.md"), &ending(LACI_MD, crlf));
    write(&project.join("TODO.md"), &ending(TODO_MD, crlf));
    config::save(&env, &json!({"roots":["~/project"],"presets":[],"custom":[],"apps":{}})).unwrap();
    (temp, env, project)
}
fn loaded(env: &Env, project: &Path) -> Service {
    let mut service = Service::new(env.clone());
    let snap = service.snapshot().unwrap();
    assert!(snap["nodes"][project.to_str().unwrap()].is_object());
    service
}
fn latest(env: &Env, key: &str) -> Value {
    activity::read_log(env, 100).into_iter().find(|e| e["key"] == key && e["canUndo"] == true).unwrap()
}
fn undo_latest(service: &mut Service, key: &str) {
    let entry = latest(&service.env, key);
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
}
fn todo_key(project: &Path, file: &str, text: &str) -> String {
    format!("todo:{}:{file}:{text}:0", project.display())
}

#[test]
fn a_field_is_added_changed_and_cleared_inside_the_frontmatter_the_file_has() {
    let source = "---\nstatus: active\nclient: Acme\n---\n\n## Next\n\n- [ ] Write docs\n";
    edited(source, "---\nstatus: active\nclient: Acme\npriority: high\n---\n\n## Next\n\n- [ ] Write docs\n", |dir| {
        sidecar::set_meta(dir, "priority", "high").unwrap()
    });
    edited(source, "---\nstatus: done\nclient: Acme\n---\n\n## Next\n\n- [ ] Write docs\n", |dir| {
        sidecar::set_meta(dir, "status", "done").unwrap()
    });
    edited(source, "---\nclient: Acme\n---\n\n## Next\n\n- [ ] Write docs\n", |dir| {
        sidecar::set_meta(dir, "status", "").unwrap()
    });
    edited("---\nstatus: active\n---\n\n## Next\n", "---\n---\n\n## Next\n", |dir| {
        sidecar::set_meta(dir, "status", "").unwrap()
    });
}

#[test]
fn a_crlf_file_with_frontmatter_does_not_get_a_second_block() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join(".laci.md");
    write(&file, "---\r\nstatus: active\r\n---\r\n\r\n## Next\r\n\r\n- [ ] Write docs\r\n");
    sidecar::set_meta(temp.path(), "priority", "high").unwrap();
    let after = read(&file);
    assert_eq!(after, "---\r\nstatus: active\r\npriority: high\r\n---\r\n\r\n## Next\r\n\r\n- [ ] Write docs\r\n");
    assert_eq!(after.matches("---").count(), 2);
    let meta = readers::parse_meta(&after);
    assert_eq!((meta["status"].as_str(), meta["priority"].as_str()), (Some("active"), Some("high")));
}

#[test]
fn a_file_without_frontmatter_gets_a_block_in_its_own_line_ending() {
    edited("## Next\n\n- [ ] Write docs\n", "---\nstatus: active\n---\n\n## Next\n\n- [ ] Write docs\n", |dir| {
        sidecar::set_meta(dir, "status", "active").unwrap()
    });
    // A file with the frontmatter closed right above the first heading gets the blank line it always got.
    edited(
        "---\nstatus: active\n---\n## Next\n- [ ] a\n",
        "---\nstatus: active\npriority: low\n---\n\n## Next\n- [ ] a\n",
        |dir| sidecar::set_meta(dir, "priority", "low").unwrap(),
    );
    edited("---\n---\n", "---\nclient: Acme\n---\n\n", |dir| sidecar::set_meta(dir, "client", "Acme").unwrap());
}

#[test]
fn a_missing_sidecar_starts_from_the_template_with_lf() {
    let temp = tempfile::tempdir().unwrap();
    sidecar::set_meta(temp.path(), "status", "active").unwrap();
    assert_eq!(read(&temp.path().join(".laci.md")), "---\nstatus: active\n---\n\n## Next\n\n## Notes\n");
}

#[test]
fn a_next_step_goes_to_the_end_of_the_next_section_in_the_files_ending() {
    edited(
        "---\n---\n\n## Next\n\n- [ ] one\n\n## Notes\n\nkeep\n",
        "---\n---\n\n## Next\n\n- [ ] one\n- [ ] two\n\n## Notes\n\nkeep\n",
        |dir| sidecar::add_next(dir, "two").unwrap(),
    );
    edited("---\n---\n\n## Next\n\n- [ ] one\n", "---\n---\n\n## Next\n\n- [ ] one\n- [ ] two\n", |dir| {
        sidecar::add_next(dir, "two").unwrap()
    });
    // No Next section yet: it is made, in the same ending.
    edited("---\n---\n\n## Notes\n\nkeep\n", "---\n---\n\n## Next\n- [ ] one\n\n\n## Notes\n\nkeep\n", |dir| {
        sidecar::add_next(dir, "one").unwrap()
    });
    edited("---\nstatus: active\n---\n", "---\nstatus: active\n---\n\n## Next\n- [ ] one\n\n", |dir| {
        sidecar::add_next(dir, "one").unwrap()
    });
    // A heading line with nothing after its marks is no heading, whichever way the line ends.
    edited(
        "---\n---\n\n## Next\n\n- [ ] one\n##\n- [ ] two\n\n## Notes\n",
        "---\n---\n\n## Next\n\n- [ ] one\n##\n- [ ] two\n- [ ] three\n\n## Notes\n",
        |dir| sidecar::add_next(dir, "three").unwrap(),
    );
}

#[test]
fn a_next_step_added_behind_a_last_line_without_a_newline_ends_that_line() {
    edited("---\n---\n\n## Next\n\n- [ ] one", "---\n---\n\n## Next\n\n- [ ] one\n- [ ] two", |dir| {
        sidecar::add_next(dir, "two").unwrap()
    });
}

#[test]
fn notes_are_replaced_added_and_cleared_in_the_files_ending() {
    edited(
        "---\n---\n\n## Next\n\n- [ ] one\n\n## Notes\n\nold notes\n",
        "---\n---\n\n## Next\n\n- [ ] one\n\n## Notes\n\nnew notes\n",
        |dir| sidecar::set_notes(dir, "new notes").unwrap(),
    );
    edited(
        "---\n---\n\n## Notes\n\nold\n\n## Links\n\n- a\n",
        "---\n---\n\n## Notes\n\nline 1\n\nline 2\n\n## Links\n\n- a\n",
        |dir| sidecar::set_notes(dir, "line 1\n\nline 2\n\n").unwrap(),
    );
    edited(
        "---\n---\n\n## Next\n\n- [ ] one\n",
        "---\n---\n\n## Next\n\n- [ ] one\n\n## Notes\n\nhello\nworld\n",
        |dir| sidecar::set_notes(dir, "hello\nworld").unwrap(),
    );
    edited("---\n---\n\n## Next\n\n## Notes\n\nold\n", "---\n---\n\n## Next\n\n## Notes\n", |dir| {
        sidecar::set_notes(dir, "").unwrap()
    });
}

#[test]
fn notes_added_or_replaced_behind_a_last_line_without_a_newline_end_that_line() {
    edited("---\n---\n\n## Next\n\n- [ ] one", "---\n---\n\n## Next\n\n- [ ] one\n## Notes\n\nhello\n", |dir| {
        sidecar::set_notes(dir, "hello").unwrap()
    });
    edited("---\n---\n\n## Notes\n\nold", "---\n---\n\n## Notes\n\nnew\n", |dir| {
        sidecar::set_notes(dir, "new").unwrap()
    });
}

#[test]
fn notes_that_come_with_crlf_end_each_line_once() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join(".laci.md");
    write(&file, "---\r\n---\r\n\r\n## Notes\r\n\r\nold\r\n");
    sidecar::set_notes(temp.path(), "one\r\ntwo\r\n").unwrap();
    assert_eq!(read(&file), "---\r\n---\r\n\r\n## Notes\r\n\r\none\r\ntwo\r\n");
    assert_eq!(readers::section(&read(&file), "Notes").unwrap(), "one\ntwo");
}

#[test]
fn a_checkbox_is_ticked_and_unticked_without_changing_how_its_line_ends() {
    let source = "---\n---\n\n## Next\n\n- [ ] one\n- [x] two\n";
    edited(source, "---\n---\n\n## Next\n\n- [x] one\n- [x] two\n", |dir| {
        sidecar::toggle_check(&dir.join(".laci.md"), 6, "one", true).unwrap()
    });
    edited(source, "---\n---\n\n## Next\n\n- [ ] one\n- [ ] two\n", |dir| {
        sidecar::toggle_check(&dir.join(".laci.md"), 7, "two", false).unwrap()
    });
}

#[test]
fn an_edited_to_do_keeps_its_line_ending_and_undo_puts_the_old_text_back() {
    for crlf in [false, true] {
        let (_temp, env, project) = fixture(crlf);
        let mut service = loaded(&env, &project);
        let after = [
            (".laci.md", "Write docs", "Write the docs", LACI_MD.replace("Write docs", "Write the docs")),
            ("TODO.md", "Fix bug", "Fix the bug", TODO_MD.replace("Fix bug", "Fix the bug")),
        ];
        for (file, text, to, want) in after {
            let before = read(&project.join(file));
            service.request("todo", &json!({"id":project,"op":"edit","file":file,"text":text,"to":to})).unwrap();
            assert_eq!(read(&project.join(file)), ending(&want, crlf), "{} {file}", name(crlf));
            let entry = latest(&service.env, &todo_key(&project, file, to));
            assert_eq!(entry["undo"]["was"], text, "The text it replaced does not carry the line ending");
            undo_latest(&mut service, &todo_key(&project, file, to));
            assert_eq!(read(&project.join(file)), before, "{} {file}", name(crlf));
        }
    }
}

#[test]
fn an_edited_to_do_keeps_its_own_line_ending_also_in_a_file_that_mixes_them() {
    let (_temp, env, project) = fixture(true);
    write(&project.join("TODO.md"), "# Todo\r\n- [ ] one\n- [ ] two\r\n- [ ] three");
    let mut service = loaded(&env, &project);
    for (text, to) in [("one", "uno"), ("two", "dos"), ("three", "tres")] {
        service.request("todo", &json!({"id":project,"op":"edit","file":"TODO.md","text":text,"to":to})).unwrap();
    }
    assert_eq!(read(&project.join("TODO.md")), "# Todo\r\n- [ ] uno\n- [ ] dos\r\n- [ ] tres");
}

#[test]
fn ticking_a_to_do_in_a_to_do_file_and_undoing_it_restores_the_bytes() {
    for crlf in [false, true] {
        let (_temp, env, project) = fixture(crlf);
        let mut service = loaded(&env, &project);
        service
            .request("todo", &json!({"id":project,"op":"toggle","file":"TODO.md","text":"Fix bug","done":true}))
            .unwrap();
        assert_eq!(read(&project.join("TODO.md")), ending("# Todo\n\n- [x] Fix bug\n- [x] Update docs\n", crlf));
        undo_latest(&mut service, &todo_key(&project, "TODO.md", "Fix bug"));
        assert_eq!(read(&project.join("TODO.md")), ending(TODO_MD, crlf), "{}", name(crlf));
    }
}

#[test]
fn deleting_a_next_step_and_undoing_it_restores_the_bytes() {
    for crlf in [false, true] {
        let (_temp, env, project) = fixture(crlf);
        let file = project.join(".laci.md");
        let mut service = loaded(&env, &project);
        service.request("todo", &json!({"id":project,"op":"delete","file":".laci.md","text":"Ship it"})).unwrap();
        let remaining = "---\nstatus: active\n---\n\n## Next\n\n- [ ] Write docs\n\n## Notes\n\nbase notes\n";
        assert_eq!(read(&file), ending(remaining, crlf), "{}", name(crlf));
        undo_latest(&mut service, &todo_key(&project, ".laci.md", "Ship it"));
        assert_eq!(read(&file), ending(LACI_MD, crlf), "{}", name(crlf));
    }
}

#[test]
fn adding_a_next_step_and_undoing_it_restores_the_bytes() {
    for crlf in [false, true] {
        let (_temp, env, project) = fixture(crlf);
        let file = project.join(".laci.md");
        let mut service = loaded(&env, &project);
        service.request("todo", &json!({"id":project,"op":"add","text":"Plan release"})).unwrap();
        let added = "---\nstatus: active\n---\n\n## Next\n\n- [ ] Write docs\n- [ ] Ship it\n- [ ] Plan release\n\n## Notes\n\nbase notes\n";
        assert_eq!(read(&file), ending(added, crlf), "{}", name(crlf));
        undo_latest(&mut service, &todo_key(&project, ".laci.md", "Plan release"));
        assert_eq!(read(&file), ending(LACI_MD, crlf), "{}", name(crlf));
    }
}

#[test]
fn fields_and_notes_changed_through_the_service_undo_to_the_same_bytes() {
    for crlf in [false, true] {
        let (_temp, env, project) = fixture(crlf);
        let file = project.join(".laci.md");
        let mut service = loaded(&env, &project);
        service.request("meta", &json!({"id":project,"key":"priority","value":"high"})).unwrap();
        service.request("notes", &json!({"id":project,"text":"new notes"})).unwrap();
        let changed = "---\nstatus: active\npriority: high\n---\n\n## Next\n\n- [ ] Write docs\n- [ ] Ship it\n\n## Notes\n\nnew notes\n";
        assert_eq!(read(&file), ending(changed, crlf), "{}", name(crlf));
        undo_latest(&mut service, &format!("notes:{}", project.display()));
        undo_latest(&mut service, &format!("meta:{}:priority", project.display()));
        assert_eq!(read(&file), ending(LACI_MD, crlf), "{}", name(crlf));
    }
}

#[test]
fn lines_laci_does_not_touch_keep_the_ending_they_have() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join(".laci.md");
    // Mostly CRLF: the step and the frontmatter are written in CRLF, the one LF line stays as it is.
    write(&file, "---\r\nstatus: active\r\n---\r\n\r\n## Next\r\n\r\n- [ ] one\n- [ ] two\r\n\r\n## Notes\r\n");
    sidecar::add_next(temp.path(), "three").unwrap();
    sidecar::set_meta(temp.path(), "priority", "low").unwrap();
    assert_eq!(
        read(&file),
        "---\r\nstatus: active\r\npriority: low\r\n---\r\n\r\n## Next\r\n\r\n- [ ] one\n- [ ] two\r\n- [ ] three\r\n\r\n## Notes\r\n"
    );
    // Mostly LF: the one CRLF line stays as it is, and what Laci writes is LF.
    write(&file, "---\nstatus: active\n---\n\n## Next\n\n- [ ] one\r\n- [ ] two\n");
    sidecar::add_next(temp.path(), "three").unwrap();
    assert_eq!(read(&file), "---\nstatus: active\n---\n\n## Next\n\n- [ ] one\r\n- [ ] two\n- [ ] three\n");
    // As many of one as of the other: LF, as for a file with no line ending at all.
    write(&file, "---\r\n---\n");
    sidecar::set_meta(temp.path(), "status", "active").unwrap();
    assert_eq!(read(&file), "---\nstatus: active\n---\n\n");
}

fn repo(dir: &Path) {
    let out = Command::new("git").args(["init", "-q", "--initial-branch=main"]).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn the_exclude_file_gets_the_ending_it_already_uses() {
    for (before, after) in [
        ("# keep\n*.log\n", "# keep\n*.log\n.laci.md\n"),
        ("# keep\n*.log", "# keep\n*.log\n.laci.md\n"),
        ("# keep\r\n*.log\r\n", "# keep\r\n*.log\r\n.laci.md\r\n"),
        ("# keep\r\n*.log", "# keep\r\n*.log\r\n.laci.md\r\n"),
        ("# keep\r\n.laci.md\r\n", "# keep\r\n.laci.md\r\n"),
        ("# keep\n.laci.md\n", "# keep\n.laci.md\n"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        repo(temp.path());
        let exclude = temp.path().join(".git/info/exclude");
        write(&exclude, before);
        sidecar::ensure_excluded(temp.path()).unwrap();
        assert_eq!(read(&exclude), after, "{before:?}");
    }
    // No exclude file yet: it is made, with LF.
    let temp = tempfile::tempdir().unwrap();
    repo(temp.path());
    fs::remove_file(temp.path().join(".git/info/exclude")).ok();
    sidecar::ensure_excluded(temp.path()).unwrap();
    assert_eq!(read(&temp.path().join(".git/info/exclude")), ".laci.md\n");
}
