//! Session reports live in a folder Laci only reads; each must reach exactly the sessions and projects it names.
use laci_core::{
    activity, config,
    env::Env,
    paths, platform,
    service::{Refresh, Service},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

mod support;

const SESSION: &str = "0adaa996-bb83-4ac2-a823-963b6afc49b0";

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

struct Fixture {
    _temp: support::TempDir,
    env: Env,
    reports: PathBuf,
    project: PathBuf,
}
impl Fixture {
    fn path(&self, name: &str) -> PathBuf {
        self.project.join(name)
    }
}

/// Projects in home, a Claude session that worked in gamma, and reports on a disk outside home.
fn fixture() -> Fixture {
    let temp = support::tempdir();
    let mut env = Env::for_home(temp.path().join("home"));
    env.app_overrides.insert("editor", "true".into());
    env.app_overrides.insert("files", "true".into());
    let project = env.home.join("project");
    for name in ["alpha", "beta", "gamma", "group/one"] {
        write(&project.join(name).join("package.json"), "{}");
    }
    let gamma = project.join("gamma");
    let store = env.home.join(".claude/projects").join(paths::enc(gamma.to_str().unwrap()));
    write(
        &store.join(format!("{SESSION}.jsonl")),
        &format!(
            "{}\n",
            json!({"type":"user","sessionId":SESSION,"cwd":gamma,"message":{"role":"user","content":"Fix the build"}})
        ),
    );
    let reports = temp.path().join("disk").join("reports");
    write(
        &reports.join("2026-10-01-alpha.md"),
        &format!(
            "# Alpha tokenizer\n\n- **Date:** 2026-10-01\n- **Session:** /somewhere · not-an-id\n\
             - **Projects:** `{}`, {}, /etc/hosts\n\n## Summary\nRewrote the alpha tokenizer.\n\n## Open\n- Ship it\n",
            project.join("alpha").display(),
            project.join("group").display()
        ),
    );
    write(
        &reports.join("2026-10-02-beta.md"),
        &format!(
            "# Beta\n\n- **Date:** 2026-10-02\n- **Session:** {} · \n\n## Summary\nBeta work.\n",
            project.join("beta").display()
        ),
    );
    write(
        &reports.join("2026-10-03-gamma.md"),
        &format!(
            "# Gamma\n\n- **Date:** 2026-10-03\n- **Session:** `{}` · `{}`\n- **Projects:** Figma file \"Gamma\"\n\n\
             ## Summary\nGamma work.\n\n## Open\nNothing open.\n",
            env.home.display(),
            SESSION.to_uppercase()
        ),
    );
    write(&reports.join("README.md"), "| Date | Title |\n");
    write(&reports.join(".draft.md"), "# Draft\n");
    config::save(&env, &json!({"roots":["~/project"],"presets":["claude"],"custom":[],"apps":{}})).unwrap();
    Fixture { _temp: temp, env, reports, project }
}

fn save_reports_dir(service: &mut Service, dir: &Value) -> laci_core::Result<Value> {
    service.request("setup/save", &json!({"roots":["~/project"],"presets":["claude"],"apps":{},"reportsDir":dir}))
}
fn ids(snapshot: &Value) -> Vec<String> {
    snapshot["reports"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect()
}
fn report<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["reports"].as_array().unwrap().iter().find(|r| r["id"] == id).unwrap()
}

#[test]
fn reports_on_another_disk_link_by_projects_session_start_and_session_id() {
    let f = fixture();
    let mut service = Service::new(f.env.clone());
    let snapshot = save_reports_dir(&mut service, &json!(f.reports)).unwrap();
    let dir = platform::path::canonical(&f.reports).unwrap();
    assert_eq!(snapshot["reportsDir"], json!({"path":dir,"total":3}));
    assert_eq!(ids(&snapshot), ["2026-10-03-gamma.md", "2026-10-02-beta.md", "2026-10-01-alpha.md"]);
    let alpha = report(&snapshot, "2026-10-01-alpha.md");
    assert_eq!(alpha["projects"], json!([f.path("alpha")]), "a folder of projects and /etc link nothing");
    assert_eq!(alpha["summary"], "Rewrote the alpha tokenizer.");
    assert_eq!(alpha["open"], json!(["Ship it"]));
    assert_eq!(alpha["file"], json!(dir.join("2026-10-01-alpha.md")));
    assert_eq!(report(&snapshot, "2026-10-02-beta.md")["projects"], json!([f.path("beta")]));
    let gamma = report(&snapshot, "2026-10-03-gamma.md");
    assert_eq!(gamma["sessions"], json!([SESSION]));
    assert_eq!(gamma["projects"], json!([f.path("gamma")]), "linked through the session that worked there");
    assert_eq!((gamma["open"].clone(), gamma["openCount"].clone()), (json!([]), json!(0)));
    assert!(
        laci_core::paths::workspace_path(dir.join("2026-10-01-alpha.md").to_str().unwrap(), &f.env).is_err(),
        "a reports folder grants no project actions"
    );
}

#[test]
fn open_items_close_and_reopen_in_laci_and_the_report_stays_as_written() {
    let f = fixture();
    let alpha = f.reports.join("2026-10-01-alpha.md");
    let text =
        fs::read_to_string(&alpha).unwrap().replace("- Ship it\n", "- Ship it\n- Measure the parser\n- Write docs\n");
    write(&alpha, &text);
    let mut service = Service::new(f.env.clone());
    save_reports_dir(&mut service, &json!(f.reports)).unwrap();
    let open = |service: &mut Service| {
        let r = report(&service.snapshot().unwrap(), "2026-10-01-alpha.md").clone();
        (r["open"].clone(), r["openCount"].clone(), r["closedCount"].clone())
    };
    assert_eq!(open(&mut service).0, json!(["Ship it", "Measure the parser", "Write docs"]));

    let closed = service
        .request("report/close", &json!({"report":"2026-10-01-alpha.md","item":"measure","state":"done"}))
        .unwrap();
    assert_eq!(closed["item"], "Measure the parser");
    assert_eq!(open(&mut service), (json!(["Ship it", "Write docs"]), json!(2), json!(1)));
    // A number counts among the items still open.
    service.request("report/close", &json!({"report":"2026-10-01-alpha.md","item":2,"state":"dropped"})).unwrap();
    assert_eq!(open(&mut service), (json!(["Ship it"]), json!(1), json!(2)));
    assert!(
        service.request("report/close", &json!({"report":"2026-10-01-alpha.md","item":"nothing like it"})).is_err()
    );

    let last = activity::read_log(&f.env, 100)
        .into_iter()
        .find(|e| e["undo"]["type"] == "report-item" && e["canUndo"] == true)
        .unwrap();
    service.request("log/undo", &json!({"id":last["id"]})).unwrap();
    assert_eq!(open(&mut service).0, json!(["Ship it", "Write docs"]));
    service.request("report/close", &json!({"report":"2026-10-01-alpha.md","item":"measure","state":"open"})).unwrap();
    assert_eq!(open(&mut service), (json!(["Ship it", "Measure the parser", "Write docs"]), json!(3), Value::Null));
    assert_eq!(fs::read_to_string(&alpha).unwrap(), text, "the reports folder is only read");
}

#[test]
fn a_moved_project_keeps_its_reports_through_their_session() {
    let f = fixture();
    let mut service = Service::new(f.env.clone());
    save_reports_dir(&mut service, &json!(f.reports)).unwrap();
    let dest = f.path("gamma-moved");
    let moved = service.request("move", &json!({"id":f.path("gamma"),"destination":dest})).unwrap();
    assert_eq!(report(&moved["snapshot"], "2026-10-03-gamma.md")["projects"], json!([dest]));
}

#[test]
fn a_window_names_an_item_by_its_whole_text_and_a_stale_click_closes_nothing_else() {
    let f = fixture();
    let alpha = f.reports.join("2026-10-01-alpha.md");
    let text = fs::read_to_string(&alpha).unwrap().replace("- Ship it\n", "- Ship it\n- Fix login\n- Fix login page\n");
    write(&alpha, &text);
    let mut service = Service::new(f.env.clone());
    save_reports_dir(&mut service, &json!(f.reports)).unwrap();
    let close = |service: &mut Service, text: &str, state: &str| {
        service.request("report/close", &json!({"report":"2026-10-01-alpha.md","text":text,"state":state}))
    };
    // Its whole text names it, though its words are in another item too.
    assert_eq!(close(&mut service, "Fix login", "done").unwrap()["item"], "Fix login");
    // A second click on a list drawn before the first names an item closed now: nothing else closes, and the
    // Log doesn't get a second entry.
    let logged = activity::read_log(&f.env, 100).len();
    assert_eq!(close(&mut service, "Fix login", "done").unwrap()["item"], "Fix login");
    assert_eq!(activity::read_log(&f.env, 100).len(), logged);
    assert!(close(&mut service, "Not in the report", "done").unwrap_err().contains("isn't in the report"));
    let open = report(&service.snapshot().unwrap(), "2026-10-01-alpha.md")["open"].clone();
    assert_eq!(open, json!(["Ship it", "Fix login page"]));
    assert_eq!(close(&mut service, "Fix login", "open").unwrap()["item"], "Fix login");
    let logged = activity::read_log(&f.env, 100).len();
    close(&mut service, "Fix login", "open").unwrap();
    assert_eq!(activity::read_log(&f.env, 100).len(), logged);
}

#[test]
fn reading_searching_and_opening_reach_only_reports_of_the_last_scan() {
    let f = fixture();
    let mut service = Service::new(f.env.clone());
    save_reports_dir(&mut service, &json!(f.reports)).unwrap();
    let read = service.request("reports/read", &json!({"id":"2026-10-01-alpha.md"})).unwrap();
    assert_eq!(read["raw"], json!(fs::read_to_string(f.reports.join("2026-10-01-alpha.md")).unwrap()));
    for id in ["README.md", ".draft.md", "../reports/2026-10-01-alpha.md", "", "2026-10-09-new.md"] {
        if id == "2026-10-09-new.md" {
            write(&f.reports.join(id), "# Written after the scan\n");
        }
        assert!(service.request("reports/read", &json!({"id":id})).is_err(), "{id}");
    }
    let hits = service.request("reports/search", &json!({"query":"ALPHA tokenizer"})).unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 1);
    assert_eq!(hits[0]["id"], "2026-10-01-alpha.md");
    assert!(hits[0]["snippet"].as_str().unwrap().to_lowercase().contains("alpha tokenizer"));
    assert_eq!(service.request("reports/search", &json!({"query":"zzz"})).unwrap(), json!([]));
    assert!(service.request("reports/search", &json!({"query":"  "})).is_err());
    assert!(service.request("reports/search", &json!({"query":"x".repeat(201)})).is_err());
    service.request("reports/open", &json!({"what":"editor","id":"2026-10-01-alpha.md"})).unwrap();
    service.request("reports/open", &json!({"what":"folder"})).unwrap();
    assert!(service.request("reports/open", &json!({"what":"editor","id":"README.md"})).is_err());
    assert!(service.request("reports/open", &json!({"what":"run","id":"2026-10-01-alpha.md"})).is_err());
    fs::remove_file(f.reports.join("2026-10-02-beta.md")).unwrap();
    assert!(service.request("reports/read", &json!({"id":"2026-10-02-beta.md"})).is_err());
    support::link_file(Path::new("/etc/hostname"), &f.reports.join("2026-10-02-beta.md"));
    assert!(service.request("reports/read", &json!({"id":"2026-10-02-beta.md"})).is_err(), "a link is never read");
}

#[test]
fn an_offline_or_replaced_folder_shows_why_and_lists_nothing() {
    let f = fixture();
    let mut service = Service::new(f.env.clone());
    save_reports_dir(&mut service, &json!(f.reports)).unwrap();
    let away = f.reports.with_file_name("unplugged");
    fs::rename(&f.reports, &away).unwrap();
    let snapshot = service.request("rescan", &json!({})).unwrap();
    assert_eq!(snapshot["reportsDir"]["error"], "Folder not found");
    assert_eq!(snapshot["reports"], json!([]));
    assert!(service.request("reports/read", &json!({"id":"2026-10-01-alpha.md"})).is_err());
    // Saving the same folder again still works while its drive is away.
    save_reports_dir(&mut service, &json!(f.reports)).unwrap();
    support::link_dir(&away, &f.reports);
    let snapshot = service.request("rescan", &json!({})).unwrap();
    assert!(snapshot["reportsDir"]["error"].as_str().unwrap().contains("link"));
    assert_eq!(snapshot["reports"], json!([]));
}

#[test]
fn the_reports_setting_is_validated_logged_and_undone() {
    let f = fixture();
    let mut service = Service::new(f.env.clone());
    fs::create_dir_all(&f.env.data_dir).unwrap();
    for bad in
        [json!(f.reports.join("missing")), json!("reports"), json!(f.env.home), json!("/"), json!(f.env.data_dir)]
    {
        assert!(save_reports_dir(&mut service, &bad).is_err(), "{bad}");
    }
    // A name at a time, as Laci spells `~/notes/reports`: on Windows a `/` given to `join` stays in the text.
    let inside = f.env.home.join("notes").join("reports");
    fs::create_dir_all(&inside).unwrap();
    save_reports_dir(&mut service, &json!("~/notes/reports")).unwrap();
    assert_eq!(config::load(&f.env)["reportsDir"], "~/notes/reports");
    assert_eq!(service.request("setup/info", &json!({})).unwrap()["reportsDir"], json!(inside));
    save_reports_dir(&mut service, &json!(f.reports)).unwrap();
    let outside = platform::path::canonical(&f.reports).unwrap();
    assert_eq!(config::load(&f.env)["reportsDir"], json!(outside));
    let entry =
        activity::read_log(&f.env, 100).into_iter().find(|e| e["key"] == "settings" && e["canUndo"] == true).unwrap();
    assert!(entry["detail"].as_str().unwrap().contains("Reports folder:"), "{}", entry["detail"]);
    service.request("setup/save", &json!({"roots":["~/project"],"presets":["claude"],"apps":{}})).unwrap();
    assert_eq!(config::load(&f.env)["reportsDir"], json!(outside), "leaving the key out keeps the folder");
    let cleared = save_reports_dir(&mut service, &json!("")).unwrap();
    assert_eq!(config::load(&f.env)["reportsDir"], "");
    assert!(cleared.get("reportsDir").is_none() && cleared.get("reports").is_none());
    let entry =
        activity::read_log(&f.env, 100).into_iter().find(|e| e["key"] == "settings" && e["canUndo"] == true).unwrap();
    service.request("log/undo", &json!({"id":entry["id"]})).unwrap();
    assert_eq!(config::load(&f.env)["reportsDir"], json!(outside));
    assert_eq!(service.snapshot().unwrap()["reports"].as_array().unwrap().len(), 3);
}

#[test]
fn a_reports_refresh_reads_only_the_folder_and_folds_into_wider_ones() {
    let mut merged = Refresh::agents();
    merged.merge(Refresh::reports());
    assert_eq!(merged, Refresh::agents(), "an agent pass reads the reports too");
    let mut merged = Refresh::reports();
    merged.merge(Refresh::full());
    assert!(merged.full && !merged.reports);
    assert!(Refresh::reports().needed());
    let f = fixture();
    let mut service = Service::new(f.env.clone());
    let before = save_reports_dir(&mut service, &json!(f.reports)).unwrap();
    write(&f.reports.join("2026-10-04-delta.md"), "# Delta\n\n## Open\n- Review\n");
    let (after, topology) = Refresh::reports().read(&f.env, Some(before.clone())).unwrap();
    assert!(!topology);
    assert_eq!(ids(&after)[0], "2026-10-04-delta.md");
    assert_eq!(after["nodes"], before["nodes"], "projects are not read again");
}
