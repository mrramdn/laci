//! The user's Path, which Windows keeps in the registry under HKEY_CURRENT_USER\Environment. Laci's installer puts the
//! console program's folder on it, and its uninstaller takes it off, through `laci __path`. Never through setx, which
//! cuts the Path at 1,024 characters.
use super::ffi;
use crate::{Result, platform};
use std::path::Path;

/// See [`platform::edit_user_path`]. Programs that start from now on get the new Path once the running ones, Explorer
/// among them, hear of it.
pub fn edit_user_path(dir: &Path, add: bool) -> Result<bool> {
    let changed = edit(ffi::ENVIRONMENT, dir, add)?;
    if changed {
        // The change is saved either way: a program that misses the news gets the new Path after the next sign-in.
        let _ = ffi::environment_changed();
    }
    Ok(changed)
}

/// Puts `dir` on the Path in `key`, a key under HKEY_CURRENT_USER, or takes it off, and answers whether it changed.
fn edit(key: &str, dir: &Path, add: bool) -> Result<bool> {
    if !dir.is_absolute() {
        return Err(format!("{} isn't a full folder path, so the Path was left as it was", dir.display()));
    }
    let dir = dir.to_str().ok_or("Laci can't put a folder whose name isn't valid text on the Path")?;
    let (path, kind) = match ffi::read_path(key) {
        Ok(Some((value, kind))) => {
            let text = String::from_utf16(&value).ok().filter(|text| !text.contains('\0'));
            (text.ok_or("The user's Path holds something other than text, so Laci left it as it was")?, kind)
        }
        Ok(None) => (String::new(), ffi::EXPANDABLE),
        Err(error) => return Err(format!("Couldn't read the user's Path: {error}")),
    };
    let edited = if add { platform::path_with(&path, dir)? } else { platform::path_without(&path, dir) };
    let Some(edited) = edited else {
        return Ok(false);
    };
    // Written back with the kind it had, so its %VARIABLES% mean what they meant.
    ffi::write_path(key, &edited, kind).map_err(|e| format!("Couldn't change the user's Path: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A key of its own under HKEY_CURRENT_USER\Software, removed when dropped, so the test never touches the user's
    /// real Path. reg.exe, Windows' own tool, writes the Paths Laci finds there and reads what Laci wrote.
    struct Scratch(String);
    impl Scratch {
        fn new() -> Self {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            Self(format!(r"Software\Laci test {} {now}", std::process::id()))
        }
        fn reg(&self, args: &[&str]) -> String {
            let key = format!(r"HKCU\{}", self.0);
            let out = Command::new("reg").arg(args[0]).arg(key).args(&args[1..]).output().unwrap();
            assert!(out.status.success(), "reg {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
        /// Makes the Path a value of the kind `kind` holding `value`.
        fn set(&self, kind: &str, value: &str) {
            self.reg(&["add", "/v", "Path", "/t", kind, "/d", value, "/f"]);
        }
        /// The Path's kind and text, as reg.exe lists them: `Path`, the kind and the text, apart.
        fn get(&self) -> (String, String) {
            let listed = self.reg(&["query", "/v", "Path"]);
            let line =
                listed.lines().map(str::trim).find(|line| line.starts_with("Path ") || line.starts_with("Path\t"));
            let rest = line.unwrap_or_else(|| panic!("no Path in {listed}"))["Path".len()..].trim_start();
            let (kind, value) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            (kind.to_owned(), value.trim().to_owned())
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = Command::new("reg").args(["delete", &format!(r"HKCU\{}", self.0), "/f"]).output();
        }
    }

    #[test]
    fn the_path_keeps_its_kind_and_its_variables_and_gets_back_what_it_had() {
        let scratch = Scratch::new();
        let key = scratch.0.as_str();
        let dir = Path::new(r"C:\Users\me\AppData\Local\Laci\bin");
        let laci = dir.to_str().unwrap();
        let expandable = || "REG_EXPAND_SZ".to_owned();

        // No Path yet: Laci makes one, expandable as Windows makes the user's.
        assert_eq!(ffi::read_path(key).unwrap(), None);
        assert!(!edit(key, dir, false).unwrap(), "nothing to take off");
        assert!(edit(key, dir, true).unwrap());
        assert_eq!(scratch.get(), (expandable(), laci.to_owned()));

        // As Windows writes the user's own: expandable, with a %VARIABLE%, and ending in a ';'. Laci reads it as it was
        // written and writes it back so.
        let windows = r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;";
        scratch.set("REG_EXPAND_SZ", windows);
        let (value, kind) = ffi::read_path(key).unwrap().unwrap();
        assert_eq!((String::from_utf16(&value).unwrap(), kind), (windows.to_owned(), ffi::EXPANDABLE));
        assert!(edit(key, dir, true).unwrap());
        assert!(!edit(key, Path::new(&laci.to_uppercase()), true).unwrap(), "there already");
        assert_eq!(scratch.get(), (expandable(), format!("{windows}{laci};")));
        assert!(!edit(key, Path::new(&format!(r"{laci}\")), false).unwrap(), "only the entry as it was added");
        assert!(edit(key, dir, false).unwrap());
        assert_eq!(scratch.get(), (expandable(), windows.to_owned()));

        // A Path kept as plain text stays plain text.
        scratch.set("REG_SZ", r"C:\Tools");
        assert!(edit(key, dir, true).unwrap());
        assert_eq!(scratch.get(), ("REG_SZ".to_owned(), format!(r"C:\Tools;{laci}")));

        // Laci leaves alone a Path that isn't text, and a folder named relative to where it runs.
        scratch.set("REG_DWORD", "1");
        assert!(edit(key, dir, true).unwrap_err().contains("isn't text"));
        assert_eq!(scratch.get().0, "REG_DWORD");
        assert!(edit(key, Path::new(r"relative\bin"), true).unwrap_err().contains("isn't a full folder path"));
    }

    /// Changes the signed-in user's real Path, tells the running programs, and puts it back as it was:
    /// `cargo test -p laci-core --lib user_path -- --ignored` on Windows.
    #[test]
    #[ignore = "changes the user's Path in the registry"]
    fn a_folder_goes_on_the_user_s_path_and_off_again_and_the_rest_stays_as_it_was() {
        let before = ffi::read_path(ffi::ENVIRONMENT).unwrap();
        let folder = tempfile::tempdir().unwrap();
        let dir = folder.path().join("bin");
        assert!(edit_user_path(&dir, true).unwrap());
        assert!(!edit_user_path(&dir, true).unwrap(), "there already");
        let (value, kind) = ffi::read_path(ffi::ENVIRONMENT).unwrap().unwrap();
        let value = String::from_utf16(&value).unwrap();
        assert!(value.split(';').any(|entry| Path::new(entry) == dir), "{value}");
        assert_eq!(kind, before.as_ref().map_or(ffi::EXPANDABLE, |(_, kind)| *kind), "the kind stays");
        assert!(edit_user_path(&dir, false).unwrap());
        assert!(!edit_user_path(&dir, false).unwrap(), "gone already");
        // Exactly as it was; a user without a Path before has an empty one now.
        assert_eq!(ffi::read_path(ffi::ENVIRONMENT).unwrap(), before.or(Some((Vec::new(), ffi::EXPANDABLE))));
    }
}
