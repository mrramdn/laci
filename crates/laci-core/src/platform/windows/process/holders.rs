//! What the history check makes of the processes NTFS lists as having a file open, how it names each file to Windows,
//! and which programs count as Laci. Nothing here calls Windows, so tests/process_guards.rs builds this file too and
//! its tests run on every OS.
use std::path::{Path, PathBuf};

// What the check says when it refuses, or when it can't answer.
pub const FAILED: &str = "Could not check running history writers";
pub const OPEN: &str = "History is open in another program. Stop the session before cleaning it up.";

/// What a process that has one of the files open turned out to be when it was looked up.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Process {
    /// Another process that runs one of Laci's programs, such as the desktop app's scan while `laci mcp` cleans up.
    Laci,
    /// One that has ended since NTFS listed it, or is ending and no longer tells its program. A process lets go of
    /// its files before Windows marks it ended, so NTFS, asked again, tells whether it still holds the file.
    Gone,
    /// Any other program, also one that couldn't be looked up.
    Other,
}

/// What the check does about a file.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Nothing but Laci itself and its helpers has it open.
    Idle,
    /// Besides those, only another Laci process, or one that has ended or is ending, has it open: NTFS is asked again
    /// in a moment.
    Wait,
    /// The history can't be cleaned up, for this reason.
    Refuse(&'static str),
}

/// [`Verdict`] on the processes NTFS lists as having a file open (`pids`). Laci itself and its helpers (`own`) don't
/// count and aren't looked up. Each other process is looked up (`look`), and any but another Laci or one that is gone
/// refuses at once, whether it reads or writes.
pub fn verdict(
    pids: impl IntoIterator<Item = u32>,
    own: impl Fn(u32) -> bool,
    mut look: impl FnMut(u32) -> Process,
) -> Verdict {
    let mut wait = false;
    for pid in pids.into_iter().filter(|&pid| !own(pid)) {
        match look(pid) {
            Process::Laci | Process::Gone => wait = true,
            Process::Other => return Verdict::Refuse(OPEN),
        }
    }
    if wait { Verdict::Wait } else { Verdict::Idle }
}

/// Laci's programs, from `exe`, the one running. An install has two: the window, `laci.exe`, and the console program
/// agents start for MCP, `bin\laci.exe` next to it. So they are `exe` and `bin\laci.exe` next to it or, when `exe`
/// runs from a folder named `bin`, `exe` and `laci.exe` one folder up.
pub fn programs(exe: &Path) -> Vec<PathBuf> {
    let other = match exe.parent() {
        Some(bin) if bin.file_name().is_some_and(|name| name.eq_ignore_ascii_case("bin")) => {
            bin.parent().map(|install| install.join("laci.exe"))
        }
        Some(install) => Some(install.join("bin").join("laci.exe")),
        None => None,
    };
    std::iter::once(exe.to_owned()).chain(other).collect()
}

/// The `\\?\` spelling of `path`, a full path on a drive or a share in UTF-16 as Windows gives it. In that spelling
/// Windows opens exactly the file named, past MAX_PATH too, and a name that ends in a dot or a space, or one such as
/// `aux`, is that very file. The plain spelling, `C:\…` or `\\server\share\…`, Windows reads otherwise: it drops such
/// a dot or space, takes such a name for a device and resolves `..`, so a plain path one of those steps would change
/// names another file in the `\\?\` spelling. It is refused, as is anything but a full path on a drive or a share.
pub fn verbatim(path: &[u16]) -> Result<Vec<u16>, &'static str> {
    let (root, names, plain) = parse(path).ok_or(FAILED)?;
    let shares = match root {
        Root::Drive(_) => Vec::new(),
        Root::Share(server, share) => vec![server, share],
    };
    if shares.iter().chain(&names).any(|name| odd(name, plain)) {
        return Err(FAILED);
    }
    let mut spelled: Vec<u16> = match root {
        Root::Drive(letter) => r"\\?\".encode_utf16().chain([letter, COLON]).collect(),
        Root::Share(server, share) => r"\\?\UNC\"
            .encode_utf16()
            .chain(server.iter().copied())
            .chain([BACKSLASH])
            .chain(share.iter().copied())
            .collect(),
    };
    for name in names {
        spelled.push(BACKSLASH);
        spelled.extend_from_slice(name);
    }
    Ok(spelled)
}

const BACKSLASH: u16 = b'\\' as u16;
const SLASH: u16 = b'/' as u16;
const COLON: u16 = b':' as u16;
const DOT: u16 = b'.' as u16;
const SPACE: u16 = b' ' as u16;

/// What a full path is on: a drive, by its letter, or a share, by its server and name.
#[derive(Clone, Copy)]
enum Root<'a> {
    Drive(u16),
    Share(&'a [u16], &'a [u16]),
}

/// The root of `path`, the names after it, and whether it is in the plain spelling, or `None` for anything but a full
/// path on a drive or a share. In the plain spelling `/` separates names too, as Windows reads it there; in the `\\?\`
/// one only `\` does.
fn parse(path: &[u16]) -> Option<(Root<'_>, Vec<&[u16]>, bool)> {
    let backslash = |c: u16| c == BACKSLASH;
    let (root, rest, plain) = if let Some(rest) = strip(path, r"\\?\UNC\") {
        let (server, rest) = split_once(rest, backslash)?;
        let (share, rest) = split_once(rest, backslash)?;
        (Root::Share(server, share), rest, false)
    } else if let Some(rest) = strip(path, r"\\?\") {
        let (letter, rest) = drive(rest, backslash)?;
        (Root::Drive(letter), rest, false)
    } else if let [first, second, rest @ ..] = path
        && separator(*first)
        && separator(*second)
    {
        let (server, rest) = split_once(rest, separator)?;
        // `\\.\` and `\\?\` spelled with `/` are Windows' device spellings, not a server.
        if server == [DOT] || server == [u16::from(b'?')] {
            return None;
        }
        let (share, rest) = split_once(rest, separator)?;
        (Root::Share(server, share), rest, true)
    } else {
        let (letter, rest) = drive(path, separator)?;
        (Root::Drive(letter), rest, true)
    };
    let names = if plain { rest.split(|&c| separator(c)).collect() } else { rest.split(|&c| backslash(c)).collect() };
    Some((root, names, plain))
}

fn separator(c: u16) -> bool {
    c == BACKSLASH || c == SLASH
}

/// `path` without `prefix`, if it begins with it.
fn strip<'a>(path: &'a [u16], prefix: &str) -> Option<&'a [u16]> {
    path.strip_prefix(prefix.encode_utf16().collect::<Vec<_>>().as_slice())
}

/// `path` up to the first separator, and what follows it.
fn split_once(path: &[u16], separator: impl Fn(u16) -> bool) -> Option<(&[u16], &[u16])> {
    let at = path.iter().position(|&c| separator(c))?;
    Some((&path[..at], &path[at + 1..]))
}

/// The letter of the drive `path` begins with, as `C:\`, and what follows the separator.
fn drive(path: &[u16], separator: impl Fn(u16) -> bool) -> Option<(u16, &[u16])> {
    match path {
        [letter, COLON, after, rest @ ..] if u8::try_from(*letter).is_ok_and(|l| l.is_ascii_alphabetic()) => {
            separator(*after).then_some((*letter, rest))
        }
        _ => None,
    }
}

/// Whether `name` names no file or holds a character no file name has, or, in the plain spelling (`plain`), is one
/// Windows reads as another: one that ends in a dot or a space, or a device's.
fn odd(name: &[u16], plain: bool) -> bool {
    let reserved =
        |c: u16| c < 32 || matches!(u8::try_from(c), Ok(b'<' | b'>' | b':' | b'"' | b'/' | b'\\' | b'|' | b'?' | b'*'));
    name.is_empty()
        || name == [DOT]
        || name == [DOT, DOT]
        || name.iter().any(|&c| reserved(c))
        || (plain && (matches!(name.last(), Some(&(DOT | SPACE))) || device(name)))
}

/// Whether Windows takes `name` for a device, as it does `aux` and `com1.jsonl`: by what comes before the first dot,
/// without the spaces at its end. The names are Windows' own list, with the console's and the digits ¹²³ that Windows
/// also reads after COM and LPT.
fn device(name: &[u16]) -> bool {
    let stem = name.split(|&c| c == DOT).next().unwrap_or_default();
    let stem = String::from_utf16_lossy(stem).trim_end_matches(' ').to_ascii_uppercase();
    match stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT")) {
        Some(number) => number.chars().count() == 1 && "0123456789¹²³".contains(number),
        None => matches!(stem.as_str(), "AUX" | "CON" | "NUL" | "PRN" | "CONIN$" | "CONOUT$"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn spelled(path: &str) -> Result<Vec<u16>, &'static str> {
        verbatim(&wide(path))
    }

    #[test]
    fn only_laci_and_its_helpers_may_hold_the_history() {
        let (own, other) = (|pid| pid == 10 || pid == 11, |_| Process::Other);
        assert_eq!(verdict([], own, other), Verdict::Idle);
        assert_eq!(verdict([10, 11], own, other), Verdict::Idle, "Laci's own scan and a helper");
        assert_eq!(verdict([12], own, other), Verdict::Refuse(OPEN), "a reader counts as much as a writer");
        assert_eq!(verdict([10, 12], own, other), Verdict::Refuse(OPEN));
        let mut asked = Vec::new();
        verdict([10, 12, 11], own, |pid| {
            asked.push(pid);
            Process::Other
        });
        assert_eq!(asked, [12], "Laci itself and its helpers aren't looked up");
    }

    #[test]
    fn another_laci_or_a_process_that_ended_is_asked_about_again_and_anything_else_refuses_at_once() {
        let own = |pid| pid == 10;
        let look = |pid| match pid {
            20 => Process::Laci,
            30 => Process::Gone,
            _ => Process::Other,
        };
        assert_eq!(verdict([20], own, look), Verdict::Wait, "the desktop app's scan while `laci mcp` cleans up");
        assert_eq!(verdict([30], own, look), Verdict::Wait, "a process that ended after NTFS listed it");
        assert_eq!(verdict([10, 20, 30], own, look), Verdict::Wait);
        for pids in [[20, 12], [12, 20], [30, 12], [12, 30]] {
            assert_eq!(verdict(pids, own, look), Verdict::Refuse(OPEN), "{pids:?}");
        }
    }

    #[test]
    fn the_window_and_the_console_program_are_both_laci() {
        let install = Path::new("Laci");
        let (window, console) = (install.join("laci.exe"), install.join("bin").join("laci.exe"));
        assert_eq!(programs(&window), [window.clone(), console.clone()]);
        assert_eq!(programs(&console), [console, window.clone()]);
        let shouted = install.join("BIN").join("laci.exe");
        assert_eq!(programs(&shouted), [shouted.clone(), window], "Windows ignores case");
        // A test binary, which the tests take for Laci's program.
        let test = Path::new("deps").join("process_guards-0123.exe");
        assert_eq!(programs(&test), [test.clone(), Path::new("deps").join("bin").join("laci.exe")]);
    }

    #[test]
    fn a_full_path_goes_in_the_verbatim_spelling_of_the_same_file() {
        for (path, exact) in [
            (
                r"C:\Users\Me\.claude\projects\C--Users-Me-demo\a.jsonl",
                r"\\?\C:\Users\Me\.claude\projects\C--Users-Me-demo\a.jsonl",
            ),
            (r"C:/Users/Me/a.jsonl", r"\\?\C:\Users\Me\a.jsonl"),
            (r"c:\Users\RUNNER~1/a.jsonl", r"\\?\c:\Users\RUNNER~1\a.jsonl"),
            (r"\\server\share\Me\.codex\b.jsonl", r"\\?\UNC\server\share\Me\.codex\b.jsonl"),
            (r"//server/share/Me/b.jsonl", r"\\?\UNC\server\share\Me\b.jsonl"),
            (r"\\?\C:\Users\Me\a.jsonl", r"\\?\C:\Users\Me\a.jsonl"),
            (r"\\?\UNC\server\share\Me\a.jsonl", r"\\?\UNC\server\share\Me\a.jsonl"),
        ] {
            assert_eq!(spelled(path), Ok(wide(exact)), "{path}");
        }
        for name in ["auxiliary.jsonl", "com10", "console.log", "a.b.c", " a", "é"] {
            assert_eq!(spelled(&format!(r"C:\h\{name}")), Ok(wide(&format!(r"\\?\C:\h\{name}"))), "{name:?}");
        }
    }

    /// The `\\?\` spelling has no MAX_PATH: a path of any length names its file.
    #[test]
    fn a_path_past_max_path_is_named_whole() {
        let long = format!(r"C:\{}\log.jsonl", vec!["d".repeat(200); 40].join(r"\"));
        assert!(long.len() > 8000);
        assert_eq!(spelled(&long), Ok(wide(&format!(r"\\?\{long}"))));
        let share = format!(r"\\server\share\{}", "e".repeat(300));
        assert_eq!(spelled(&share), Ok(wide(&format!(r"\\?\UNC\server\share\{}", "e".repeat(300)))));
    }

    /// In the `\\?\` spelling, a name that ends in a dot or a space, or one such as `aux`, is the file of that name.
    #[test]
    fn a_verbatim_name_is_the_file_itself() {
        for path in [
            r"\\?\C:\h\log.",
            r"\\?\C:\h\log ",
            r"\\?\C:\h.\log",
            r"\\?\C:\h\nul",
            r"\\?\C:\h\aux.jsonl",
            r"\\?\C:\h\Com1.jsonl",
            r"\\?\UNC\server\share\aux",
        ] {
            assert_eq!(spelled(path), Ok(wide(path)), "{path}");
        }
    }

    /// A plain path with a name Windows would change before it opens the file names another file in the `\\?\`
    /// spelling, so it is refused.
    #[test]
    fn a_plain_name_windows_reads_as_another_is_refused() {
        for path in [
            r"C:\h\log.",
            r"C:\h\log ",
            r"C:\h\log. .",
            r"C:\h.\log",
            r"C:\h \log",
            r"C:\h\aux.jsonl",
            r"C:\h\AUX",
            r"C:\h\con .txt",
            r"C:\h\nul.tar.gz",
            r"C:\h\Com1.jsonl",
            r"C:\h\lpt0",
            r"C:\h\lpt¹",
            r"C:\h\conin$",
            r"C:\aux\log",
            r"\\server.\share\a",
            r"\\server\share \a",
        ] {
            assert_eq!(spelled(path), Err(FAILED), "{path}");
        }
    }

    #[test]
    fn what_isnt_a_full_path_on_a_drive_or_a_share_is_refused() {
        for path in [
            "",
            r"h\log",
            r"C:h\log",
            r"\h\log",
            r"C:\",
            r"C:\h\",
            r"C:\h\\log",
            r"C:\h\..\log",
            r"C:\h\.\log",
            r"C:\h\a:b",
            r"C:\h\a*b",
            "C:\\h\\a\u{1}b",
            r"\\?\C:",
            r"\\?\C:\",
            r"\\?\c:h",
            r"\\?\C:\h\..\log",
            r"\\?\C:\h\.\log",
            r"\\?\C:\h\\log",
            r"\\?\C:\h\a/b",
            r"\\?\C:\h\a:b",
            r"\\.\C:\h\log",
            r"//./C:/h/log",
            r"//?/C:/h/log",
            r"\??\C:\h\log",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\h\log",
            r"\\?\Volume{0b1c4d2e-0000-0000-0000-100000000000}\h\log",
            r"\\?\unc\server\share\log",
            r"\\?\UNC\server\share",
            r"\\server",
            r"\\server\share",
            r"\\server\share\",
            r"\\\share\log",
        ] {
            assert_eq!(spelled(path), Err(FAILED), "{path}");
        }
    }
}
