//! Where Laci keeps its files, and the system's bin: what goes there can be taken back out, and what can't go there
//! stays where it is.
use laci_core::{env::Env, ops, platform};
use serde_json::{Value, json};
use std::{ffi::OsStr, fs};

mod support;

/// What a run started by [`from_process`] prints before what it saw.
const SEEN: &str = "laci-env: ";

/// In a run [`from_process`] started, prints what `Env::from_process` makes of the environment it was given, and
/// says so: the test has nothing more to do there.
fn child() -> bool {
    if support::role().as_deref() != Some("env") {
        return false;
    }
    let seen = match Env::from_process() {
        Ok(env) => json!({"home":env.home,"config":env.config_dir,"data":env.data_dir,"cache":env.cache_dir}),
        Err(error) => json!({"error":error}),
    };
    println!("{SEEN}{seen}");
    true
}

/// What `Env::from_process` makes of this process's environment with `vars` set, or removed where `None`. It runs
/// in a run of its own of `test` (named in full), which starts with [`child`]: a process reads its environment once.
fn from_process(test: &str, vars: &[(&str, Option<&OsStr>)]) -> Value {
    let mut command = support::program(test, "env");
    for (key, value) in vars {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    // The test harness has written the test's name on the same line.
    let seen = stdout.lines().find_map(|line| Some(line.split_once(SEEN)?.1)).unwrap_or_else(|| panic!("{stdout}"));
    serde_json::from_str(seen).unwrap()
}

const ONE_LAYOUT: &str = "laci_home_keeps_one_layout_spelled_as_given";

#[test]
fn laci_home_keeps_one_layout_spelled_as_given() {
    if child() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let (real, linked) = (temp.path().join("real"), temp.path().join("linked"));
    fs::create_dir(&real).unwrap();
    support::link_dir(&real, &linked);
    // Home is kept as given, through the link.
    let home = linked.clone();
    let seen = from_process(ONE_LAYOUT, &[("LACI_HOME", Some(linked.as_os_str()))]);
    // Laci v1's folders.
    let expected = json!({
        "home":home,
        "config":home.join(".config").join("laci"),
        "data":home.join(".local").join("share").join("laci"),
        "cache":home.join(".cache").join("laci"),
    });
    assert_eq!(seen, expected);
    // A home that isn't there is taken as given too.
    let missing = temp.path().join("missing");
    let seen = from_process(ONE_LAYOUT, &[("LACI_HOME", Some(missing.as_os_str()))]);
    assert_eq!(seen["home"], json!(missing));
}

/// Linux keeps the words it always had, which desktop-smoke reads.
#[test]
fn undo_and_recovery_name_the_systems_own_bin() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let (name, bin) = ("System Trash", "system Trash");
    let gone = env.home.join("gone");
    let pure = json!({"id":"pure","state":"applied","title":"Fixture cleanup","at":"2026-10-04T00:00:00.000Z",
        "entries":[{"kind":"trash","path":gone}]});
    let journal = env.data_dir.join("journal");
    fs::create_dir_all(&journal).unwrap();
    fs::write(journal.join("pure.json"), pure.to_string()).unwrap();
    assert_eq!(
        ops::undo(&env, "pure").unwrap_err(),
        format!("Restore these files through {bin}; there is no Laci Undo")
    );
    assert_eq!(ops::recovery(&pure).unwrap(), format!("Restore these files through {bin}; Laci Undo is unavailable."));
    let mixed =
        json!({"entries":[{"kind":"trash","path":gone},{"kind":"move","from":gone,"to":env.home.join("kept")}]});
    assert_eq!(
        ops::recovery(&mixed).unwrap(),
        format!("Laci Undo restores moves and edits only. Restore trashed files separately through {bin}.")
    );
    // The UI's words for the bin are the same (`BIN` in ui/src/dialogs.tsx).
    assert_eq!(platform::BIN, platform::Bin { name, bare: bin });
}

mod linux {
    use super::*;

    const AS_GIVEN: &str = "linux::home_is_taken_as_given_and_settings_follow_xdg";

    /// As Laci always has on Linux: HOME as it is spelled, even where nothing is there yet.
    #[test]
    fn home_is_taken_as_given_and_settings_follow_xdg() {
        if child() {
            return;
        }
        let seen = from_process(
            AS_GIVEN,
            &[
                ("LACI_HOME", None),
                ("HOME", Some(OsStr::new("/home/someone"))),
                ("XDG_CONFIG_HOME", Some(OsStr::new("/xdg/config"))),
                ("XDG_CACHE_HOME", Some(OsStr::new("xdg/cache"))),
            ],
        );
        let expected = json!({"home":"/home/someone","config":"/xdg/config/laci",
            "data":"/home/someone/.local/share/laci","cache":"/home/someone/.cache/laci"});
        assert_eq!(seen, expected);
    }
}
