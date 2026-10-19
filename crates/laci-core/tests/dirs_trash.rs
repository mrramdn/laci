//! Where Laci keeps its files on each OS, and the system's bin: what goes there can be taken back out, and what can't
//! go there stays where it is.
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

/// A name no other run uses, for what goes to the system's bin, which every run shares.
#[cfg(any(target_os = "macos", windows))]
fn unique(temp: &tempfile::TempDir) -> String {
    format!("laci-bin-test-{}", temp.path().file_name().unwrap().to_string_lossy().trim_start_matches('.'))
}

const ONE_LAYOUT: &str = "laci_home_keeps_one_layout_spelled_as_the_disk_spells_it_outside_linux";

#[test]
fn laci_home_keeps_one_layout_spelled_as_the_disk_spells_it_outside_linux() {
    if child() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let (real, linked) = (temp.path().join("real"), temp.path().join("linked"));
    fs::create_dir(&real).unwrap();
    support::link_dir(&real, &linked);
    // Linux keeps home as given. macOS and Windows spell it as the disk does: through the link, without short names.
    let home = if cfg!(target_os = "linux") { linked.clone() } else { platform::path::canonical(&real).unwrap() };
    let seen = from_process(ONE_LAYOUT, &[("LACI_HOME", Some(linked.as_os_str()))]);
    // Laci v1's folders, joined one name at a time, so Windows has no `/` in them.
    let expected = json!({
        "home":home,
        "config":home.join(".config").join("laci"),
        "data":home.join(".local").join("share").join("laci"),
        "cache":home.join(".cache").join("laci"),
    });
    assert_eq!(seen, expected);
    // A home that isn't there: Linux takes it as given; macOS and Windows can't spell it, so they refuse it.
    let missing = temp.path().join("missing");
    let seen = from_process(ONE_LAYOUT, &[("LACI_HOME", Some(missing.as_os_str()))]);
    if cfg!(target_os = "linux") {
        assert_eq!(seen["home"], json!(missing));
    } else {
        let error = seen["error"].as_str().unwrap_or_default();
        assert!(error.starts_with(&format!("Couldn't open the home folder {}", missing.display())), "{seen}");
    }
}

/// Linux keeps the words it always had, which desktop-smoke reads.
#[test]
fn undo_and_recovery_name_the_systems_own_bin() {
    let temp = tempfile::tempdir().unwrap();
    let env = Env::for_home(temp.path().join("home"));
    let (name, bin) = if cfg!(windows) { ("Recycle Bin", "the Recycle Bin") } else { ("System Trash", "system Trash") };
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{io, os::unix::ffi::OsStrExt, path::PathBuf};

    const AS_LINUX: &str = "macos::home_is_spelled_as_the_disk_spells_it_and_settings_follow_xdg_as_on_linux";

    #[test]
    fn home_is_spelled_as_the_disk_spells_it_and_settings_follow_xdg_as_on_linux() {
        if child() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let (real, linked, xdg) = (temp.path().join("real"), temp.path().join("linked"), temp.path().join("xdg"));
        fs::create_dir(&real).unwrap();
        support::link_dir(&real, &linked);
        let seen = from_process(
            AS_LINUX,
            &[
                ("LACI_HOME", None),
                ("HOME", Some(linked.as_os_str())),
                ("XDG_CONFIG_HOME", Some(xdg.as_os_str())),
                ("XDG_CACHE_HOME", Some(OsStr::new("relative/cache"))),
            ],
        );
        let home = platform::path::canonical(&real).unwrap();
        let expected = json!({"home":home,"config":xdg.join("laci"),
            "data":home.join(".local/share/laci"),"cache":home.join(".cache/laci")});
        assert_eq!(seen, expected);
    }

    #[test]
    fn a_name_that_is_not_text_is_refused_and_what_its_escaped_spelling_names_stays() {
        let temp = tempfile::tempdir().unwrap();
        // The trash crate would spell the name below as this one, and move this file instead.
        let escaped = temp.path().join("bad%FF");
        fs::write(&escaped, "stays\n").unwrap();
        let error = platform::trash(&temp.path().join(OsStr::from_bytes(b"bad\xff"))).unwrap_err();
        assert!(error.ends_with("its name isn't valid text"), "{error}");
        assert_eq!(fs::read_to_string(&escaped).unwrap(), "stays\n");
    }

    /// `open` starts in the folder it is given. Where that folder is gone, nothing starts, so no app opens here.
    #[test]
    fn open_hands_the_target_to_usr_bin_open_in_the_given_folder() {
        let temp = tempfile::tempdir().unwrap();
        let error = platform::open("https://example.invalid/", &temp.path().join("gone")).unwrap_err();
        assert!(error.starts_with("Couldn't open /usr/bin/open: "), "{error}");
    }

    #[test]
    fn a_folder_goes_to_the_trash_whole_and_can_be_taken_back_out() {
        let temp = tempfile::tempdir().unwrap();
        let name = unique(&temp);
        let folder = temp.path().join(&name);
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("notes.md"), "kept\n").unwrap();
        platform::trash(&folder).unwrap();
        assert!(fs::symlink_metadata(&folder).is_err(), "gone from its place");
        // The temporary folder is on the same volume as home, so its Trash is ~/.Trash.
        let trashed = PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash").join(&name);
        match fs::read_to_string(trashed.join("notes.md")) {
            Ok(text) => {
                assert_eq!(text, "kept\n");
                fs::rename(&trashed, &folder).unwrap();
                assert_eq!(fs::read_to_string(folder.join("notes.md")).unwrap(), "kept\n");
            }
            // Looking into the Trash takes Full Disk Access, which a test run may not have.
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
                eprintln!("The Trash can't be read here; that {name} is in it is not checked.");
            }
            Err(e) => panic!("{name} is not in ~/.Trash: {e}"),
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        ffi::OsString,
        os::windows::ffi::OsStringExt,
        path::{Component, Path, PathBuf, Prefix},
    };

    const PROFILE: &str = "windows::home_is_the_profile_and_files_go_to_local_app_data_never_where_home_says";

    #[test]
    fn home_is_the_profile_and_files_go_to_local_app_data_never_where_home_says() {
        if child() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let canonical = |path: PathBuf| platform::path::canonical(&path).unwrap();
        // Git Bash sets HOME as a POSIX path, and a shell can set LOCALAPPDATA to anything: Laci's files follow
        // neither, but the profile and the Local AppData Windows keeps for it, where WebView2's data is too.
        let elsewhere = temp.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let seen = from_process(
            PROFILE,
            &[
                ("LACI_HOME", None),
                ("HOME", Some(OsStr::new("/c/Users/nobody"))),
                ("LOCALAPPDATA", Some(elsewhere.as_os_str())),
            ],
        );
        // This run's LOCALAPPDATA, which Windows set from that folder at sign-in.
        let app = canonical(std::env::var_os("LOCALAPPDATA").unwrap().into()).join("io.github.mrramdn.laci");
        let expected = json!({"home":canonical(std::env::home_dir().unwrap()),"config":app,
            "data":app.join("data"),"cache":app.join("cache")});
        assert_eq!(seen, expected);
        // USERPROFILE names home. A profile has its own Local AppData, which Windows may look for in it.
        let profile = temp.path().join("profile");
        fs::create_dir_all(profile.join("AppData").join("Local")).unwrap();
        let seen = from_process(PROFILE, &[("LACI_HOME", None), ("USERPROFILE", Some(profile.as_os_str()))]);
        assert_eq!(seen["home"], json!(canonical(profile)), "{seen}");
        // Without a full path, Laci doesn't guess.
        let relative =
            from_process(PROFILE, &[("LACI_HOME", None), ("USERPROFILE", Some(OsStr::new(r"Users\nobody")))]);
        assert_eq!(relative, json!({"error":"Set USERPROFILE to an absolute folder path"}));
    }

    #[test]
    fn a_path_the_shell_would_read_as_another_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let kept = temp.path().join("kept");
        fs::create_dir(&kept).unwrap();
        // The shell would read this path up to the NUL, and recycle `kept`.
        let mut cut = kept.clone().into_os_string();
        cut.push("\0inside");
        let error = platform::trash(Path::new(&cut)).unwrap_err();
        assert!(error.ends_with("it isn't a full path"), "{error}");
        assert!(platform::trash(Path::new("kept")).is_err());
        assert!(kept.is_dir());
    }

    /// Where the item an `$I…` record describes came from. Version 2 (Windows 10 and later) gives the path's length;
    /// version 1 kept 260 characters.
    fn original(record: &[u8]) -> Option<PathBuf> {
        let version = u64::from_le_bytes(record.get(..8)?.try_into().ok()?);
        let path = match version {
            2 => {
                let length = u32::from_le_bytes(record.get(24..28)?.try_into().ok()?) as usize;
                record.get(28..28 + 2 * length)?
            }
            1 => record.get(24..24 + 520)?,
            _ => return None,
        };
        let units: Vec<u16> = path.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
        let end = units.iter().position(|&unit| unit == 0).unwrap_or(units.len());
        Some(OsString::from_wide(&units[..end]).into())
    }

    /// What the Recycle Bin of `path`'s drive holds that came from a path ending in `name`: each item Windows keeps
    /// as `$R…`, with the `$I…` record next to it that says where it came from.
    fn in_recycle_bin(path: &Path, name: &str) -> Vec<(PathBuf, PathBuf)> {
        let bins = path.ancestors().last().unwrap().join("$Recycle.Bin");
        let mut found = Vec::new();
        // One folder per user; another user's can't be opened.
        for user in fs::read_dir(&bins).unwrap().flatten() {
            let Ok(entries) = fs::read_dir(user.path()) else { continue };
            for entry in entries.flatten() {
                let file = entry.file_name().to_string_lossy().into_owned();
                let Some(id) = file.strip_prefix("$I") else { continue };
                let Ok(record) = fs::read(entry.path()) else { continue };
                if original(&record).is_some_and(|from| from.file_name() == Some(OsStr::new(name))) {
                    found.push((user.path().join(format!("$R{id}")), entry.path()));
                }
            }
        }
        found
    }

    #[test]
    fn a_folder_goes_to_the_recycle_bin_whole_and_can_be_taken_back_out() {
        let temp = tempfile::tempdir().unwrap();
        let name = unique(&temp);
        let folder = temp.path().join(&name);
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("notes.md"), "kept\n").unwrap();
        platform::trash(&folder).unwrap();
        assert!(fs::symlink_metadata(&folder).is_err(), "gone from its place");
        let found = in_recycle_bin(&folder, &name);
        let [(item, record)] = found.as_slice() else { panic!("{name} once in the Recycle Bin: {found:?}") };
        assert_eq!(fs::read_to_string(item.join("notes.md")).unwrap(), "kept\n");
        // Restore it as Explorer does: the item goes back, and its record goes.
        fs::rename(item, &folder).unwrap();
        fs::remove_file(record).unwrap();
        assert_eq!(fs::read_to_string(folder.join("notes.md")).unwrap(), "kept\n");
    }

    /// `path` reached through its drive's administrative share, `\\localhost\C$\…` for drive C: the same file, on a
    /// network path, which has no Recycle Bin.
    fn on_admin_share(path: &Path) -> PathBuf {
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else { panic!("{} has no drive", path.display()) };
        let (Prefix::Disk(drive) | Prefix::VerbatimDisk(drive)) = prefix.kind() else {
            panic!("{} is not on a drive", path.display())
        };
        let mut shared = PathBuf::from(format!(r"\\localhost\{}$\", drive as char));
        shared.extend(components.filter(|c| matches!(c, Component::Normal(_))));
        shared
    }

    #[test]
    fn a_file_on_a_share_without_a_recycle_bin_is_refused_and_stays() {
        let temp = tempfile::tempdir().unwrap();
        let name = unique(&temp);
        let file = temp.path().join(&name);
        fs::write(&file, "stays\n").unwrap();
        let shared = on_admin_share(&file);
        if fs::read_to_string(&shared).is_err() {
            // GitHub's runners reach their drives' administrative shares; a computer elsewhere may have them off.
            assert!(std::env::var_os("CI").is_none(), "{} can't be read", shared.display());
            eprintln!("No administrative share here; the refusal without a Recycle Bin is not checked.");
            return;
        }
        let error = platform::trash(&shared).unwrap_err();
        assert!(error.starts_with("Windows can't put "), "{error}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "stays\n", "not deleted for good");
        assert!(in_recycle_bin(&file, &name).is_empty(), "nor put in a Recycle Bin");
    }
}
