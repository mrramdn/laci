//! The `laci` command on macOS: setup/info says whether Laci runs from a place macOS keeps and whether the command line
//! tool is installed, and cli/install makes its link. Elsewhere the installer puts the command on the PATH, and Laci
//! says nothing about it.
use laci_core::{env::Env, service::Service};
use serde_json::json;
use std::{fs, path::PathBuf};

mod support;

/// An Env whose program is the one inside a Laci.app in `root`.
fn app(root: &std::path::Path) -> Env {
    let mut env = Env::for_home(root.join("home"));
    env.program = root.join("Applications").join("Laci.app").join("Contents").join("MacOS").join("laci");
    fs::create_dir_all(env.program.parent().unwrap()).unwrap();
    fs::write(&env.program, "").unwrap();
    env
}

#[test]
fn setup_info_tells_of_the_command_line_tool_only_on_macos() {
    let temp = support::tempdir();
    let env = app(temp.path());
    let info = Service::new(env.clone()).request("setup/info", &json!({})).unwrap();
    if cfg!(target_os = "macos") {
        assert_eq!(info["translocated"], false);
        let link = env.home.join(".local").join("bin").join("laci");
        assert_eq!(info["cli"]["link"], json!(link.to_string_lossy()));
        assert_eq!(info["cli"]["installed"], false);
        assert!(info["cli"]["onPath"].is_boolean(), "{info}");
    } else {
        assert!(info.get("translocated").is_none() && info.get("cli").is_none(), "{info}");
    }
}

#[test]
fn only_macos_installs_the_command_line_tool_itself() {
    let temp = support::tempdir();
    let env = app(temp.path());
    let mut service = Service::new(env.clone());
    let installed = service.request("cli/install", &json!({}));
    if !cfg!(target_os = "macos") {
        assert_eq!(installed.unwrap_err(), "Laci's installer adds the command line tool on this system.");
        assert!(!env.home.join(".local").exists());
        return;
    }
    let cli = installed.unwrap();
    assert_eq!(cli["installed"], true);
    let link = env.home.join(".local").join("bin").join("laci");
    assert_eq!(fs::read_link(&link).unwrap(), env.program);
    assert_eq!(service.request("setup/info", &json!({})).unwrap()["cli"], cli);

    // Opened straight from the disk image: macOS would remove what the link leads to.
    let mut mounted = env.clone();
    mounted.program = PathBuf::from("/Volumes/Laci/Laci.app/Contents/MacOS/laci");
    let mut service = Service::new(mounted);
    assert_eq!(service.request("setup/info", &json!({})).unwrap()["translocated"], true);
    assert_eq!(
        service.request("cli/install", &json!({})).unwrap_err(),
        "Move Laci to Applications first, then install the command line tool."
    );
    assert_eq!(fs::read_link(&link).unwrap(), env.program, "the link stays as it was");
}

/// `onPath` says whether typing `laci` in a terminal finds the link: whether ~/.local/bin is on the PATH the login
/// shell sets up. Laci's own programs get that folder whenever it exists, so their PATH can't tell. This test runs itself
/// again with a home that has the folder and a login shell whose PATH doesn't, since both PATHs are taken once.
#[cfg(target_os = "macos")]
#[test]
fn on_path_is_the_login_shell_s_path_not_the_one_laci_s_programs_get() {
    use laci_core::platform;
    use std::os::unix::fs::PermissionsExt;
    const ROLE: &str = "LACI_TEST_ON_PATH_ROOT";
    if let Some(root) = std::env::var_os(ROLE) {
        let env = app(std::path::Path::new(&root));
        let bin = env.home.join(".local").join("bin");
        let given = platform::child_path().unwrap();
        assert!(std::env::split_paths(&given).any(|dir| dir == bin), "{given:?}");
        assert_eq!(platform::shell_path(), Some("/usr/bin:/bin".into()));
        let info = Service::new(env).request("setup/info", &json!({})).unwrap();
        assert_eq!(info["cli"]["onPath"], false, "{info}");
        return;
    }
    let temp = support::tempdir();
    let env = app(temp.path());
    fs::create_dir_all(env.home.join(".local").join("bin")).unwrap();
    // A login shell whose PATH leaves the folder out, as macOS's own zsh does.
    let shell = temp.path().join("zsh");
    fs::write(&shell, "#!/bin/sh\necho __laci_path__\necho /usr/bin:/bin\necho __laci_path__\n").unwrap();
    fs::set_permissions(&shell, fs::Permissions::from_mode(0o755)).unwrap();
    let again = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "on_path_is_the_login_shell_s_path_not_the_one_laci_s_programs_get", "--nocapture"])
        .env(ROLE, temp.path())
        .env("HOME", &env.home)
        .env("SHELL", &shell)
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap();
    let said = format!("{}{}", String::from_utf8_lossy(&again.stdout), String::from_utf8_lossy(&again.stderr));
    assert!(again.status.success() && said.contains("1 passed"), "{said}");
}
