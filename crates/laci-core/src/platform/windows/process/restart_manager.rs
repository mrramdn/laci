//! What the history check makes of Restart Manager's answer, and how it names the files to Restart Manager. Nothing
//! here calls Windows, so tests/process_guards.rs builds this file too and its tests run on every OS.

/// The files go to Restart Manager at most this many to a call. A session keeps what is registered with it in the
/// registry, so a history of any size goes over in calls of a bounded size.
pub const BATCH: usize = 256;

/// The reboot reason RmRebootReasonDetectedSelf: Laci itself has one of the files open, as its scan does while it
/// reads a log.
pub const DETECTED_SELF: u32 = 0x10;

/// MAX_PATH: the most UTF-16 units of a path, with the NUL that ends it, that Windows reads in the plain spelling.
pub const MAX_PATH: usize = 260;

/// The longest name, in UTF-16 units, that goes to Restart Manager in the `\\?\` spelling. Its documentation doesn't
/// say it reads that spelling, so Laci gives it such a name only once it has found Laci holding a file this long
/// named that way (see process.rs).
pub const LONGEST: usize = 1024;

// What the check says when it refuses, or when it can't answer.
pub const FAILED: &str = "Could not check running history writers";
pub const OPEN: &str = "History is open in another program. Stop the session before cleaning it up.";
const UNCHECKED: &str = "Laci couldn't check a program that has this history open, such as one running as \
    administrator or as another user. Close it and try again.";
pub const TOO_LONG: &str =
    "A file in this history has a path too long for Windows to check, so Laci won't clean it up.";
pub const ODD_NAME: &str = "A file in this history has a name that Windows' check can't look up, such as one that ends in \
    a dot or a space, so Laci won't clean it up.";

/// `names` in order, in batches of at most [`BATCH`], one to a call. No names make no batch.
pub fn batches<T>(names: &[T]) -> std::slice::Chunks<'_, T> {
    names.chunks(BATCH)
}

/// What the check does with what Restart Manager found.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Nothing but Laci itself and its helpers has a file open.
    Idle,
    /// Besides those, only another Laci process has one open, such as the desktop app's scan while `laci mcp` cleans
    /// up: Restart Manager is asked again in a moment.
    Wait,
    /// The history can't be cleaned up, for this reason.
    Refuse(&'static str),
}

/// [`Verdict`] on what Restart Manager found: the processes that have one of the files open (`pids`) and its reboot
/// reasons (`reasons`, RM_REBOOT_REASON bits). Any reason but [`DETECTED_SELF`] refuses: Restart Manager met a process
/// Laci may not look into or stop, such as one running as administrator (RmRebootReasonPermissionDenied), one in
/// another session, as another user's is (RmRebootReasonSessionMismatch), or one critical to Windows, so Laci can't
/// vouch for the files. Laci itself and its helpers (`own`) don't count. Any other process refuses at once, whether
/// it reads or writes, unless it is another Laci process (`laci`), which is waited for.
pub fn verdict(
    pids: impl IntoIterator<Item = u32>,
    reasons: u32,
    own: impl Fn(u32) -> bool,
    mut laci: impl FnMut(u32) -> bool,
) -> Verdict {
    if reasons & !DETECTED_SELF != 0 {
        return Verdict::Refuse(UNCHECKED);
    }
    let mut wait = false;
    for pid in pids.into_iter().filter(|&pid| !own(pid)) {
        if !laci(pid) {
            return Verdict::Refuse(OPEN);
        }
        wait = true;
    }
    if wait { Verdict::Wait } else { Verdict::Idle }
}

/// How a file is named to Restart Manager: in UTF-16, without the NUL that ends it.
#[derive(Debug, PartialEq)]
pub enum Name {
    /// `C:\…` or `\\server\share\…`, within MAX_PATH: the spelling all of Windows reads.
    Plain(Vec<u16>),
    /// `\\?\C:\…` or `\\?\UNC\server\share\…`, for a path too long for the plain spelling, up to [`LONGEST`].
    Long(Vec<u16>),
}

/// How to name the file at `path`, in UTF-16 as walkdir gives it, to Restart Manager. Before Windows opens a file by
/// its plain spelling, it drops a dot or a space at the end of a name, takes a name such as `aux` or `com1.jsonl` for
/// a device, and resolves `..` without looking at the disk. A path such a step would change would have Restart
/// Manager look at another file, or at none, and find nobody holding it, so it is refused in either spelling, as is
/// anything but a full path on a drive or a share.
pub fn name(path: &[u16]) -> Result<Name, &'static str> {
    let (root, names) = parse(path).ok_or(FAILED)?;
    if let Root::Share(server, share) = root {
        check(server)?;
        check(share)?;
    }
    for name in &names {
        check(name)?;
    }
    let mut plain = match root {
        Root::Drive(letter) => vec![letter, COLON],
        Root::Share(server, share) => [&[BACKSLASH, BACKSLASH][..], server, &[BACKSLASH][..], share].concat(),
    };
    for name in &names {
        plain.push(BACKSLASH);
        plain.extend_from_slice(name);
    }
    if plain.len() < MAX_PATH {
        return Ok(Name::Plain(plain));
    }
    let long: Vec<u16> = match root {
        Root::Drive(_) => r"\\?\".encode_utf16().chain(plain).collect(),
        // `\\server\…` becomes `\\?\UNC\server\…`.
        Root::Share(..) => r"\\?\UNC".encode_utf16().chain(plain.into_iter().skip(1)).collect(),
    };
    if long.len() > LONGEST {
        return Err(TOO_LONG);
    }
    Ok(Name::Long(long))
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

/// The root of `path` and the names after it, or `None` for anything but a full path on a drive or a share. In the
/// plain spelling `/` separates names too, as Windows reads it there; in the `\\?\` one only `\` does.
fn parse(path: &[u16]) -> Option<(Root<'_>, Vec<&[u16]>)> {
    let backslash = |c: u16| c == BACKSLASH;
    let (root, rest, verbatim) = if let Some(rest) = strip(path, r"\\?\UNC\") {
        let (server, rest) = split_once(rest, backslash)?;
        let (share, rest) = split_once(rest, backslash)?;
        (Root::Share(server, share), rest, true)
    } else if let Some(rest) = strip(path, r"\\?\") {
        let (letter, rest) = drive(rest, backslash)?;
        (Root::Drive(letter), rest, true)
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
        (Root::Share(server, share), rest, false)
    } else {
        let (letter, rest) = drive(path, separator)?;
        (Root::Drive(letter), rest, false)
    };
    let names =
        if verbatim { rest.split(|&c| backslash(c)).collect() } else { rest.split(|&c| separator(c)).collect() };
    Some((root, names))
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

/// Refuses a name that names no file, or that Windows reads as another in the plain spelling or can't read at all.
fn check(name: &[u16]) -> Result<(), &'static str> {
    if name.is_empty() || name == [DOT] || name == [DOT, DOT] {
        return Err(FAILED);
    }
    let reserved =
        |c: u16| c < 32 || matches!(u8::try_from(c), Ok(b'<' | b'>' | b':' | b'"' | b'/' | b'\\' | b'|' | b'?' | b'*'));
    if name.iter().any(|&c| reserved(c)) || matches!(name.last(), Some(&(DOT | SPACE))) || device(name) {
        return Err(ODD_NAME);
    }
    Ok(())
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

    fn named(path: &str) -> Result<Name, &'static str> {
        name(&wide(path))
    }

    #[test]
    fn only_laci_and_its_helpers_may_hold_the_history() {
        let own = |pid| pid == 10 || pid == 11;
        let laci = |_| false;
        assert_eq!(verdict([], 0, own, laci), Verdict::Idle);
        assert_eq!(verdict([10, 11], DETECTED_SELF, own, laci), Verdict::Idle, "Laci's own scan and a helper");
        assert_eq!(verdict([11], 0, own, laci), Verdict::Idle);
        assert_eq!(verdict([12], 0, own, laci), Verdict::Refuse(OPEN), "a reader counts as much as a writer");
        assert_eq!(verdict([10, 12], DETECTED_SELF, own, laci), Verdict::Refuse(OPEN));
    }

    #[test]
    fn another_laci_is_waited_for_and_anything_else_refuses_at_once() {
        let (own, laci) = (|pid| pid == 10, |pid| pid == 20);
        assert_eq!(verdict([20], 0, own, laci), Verdict::Wait, "the desktop app's scan while `laci mcp` cleans up");
        assert_eq!(verdict([10, 20], DETECTED_SELF, own, laci), Verdict::Wait);
        for pids in [[20, 12], [12, 20]] {
            assert_eq!(verdict(pids, 0, own, laci), Verdict::Refuse(OPEN), "{pids:?}");
        }
        let mut asked = Vec::new();
        verdict([10, 20], DETECTED_SELF, own, |pid| {
            asked.push(pid);
            true
        });
        assert_eq!(asked, [20], "Laci itself isn't looked up");
    }

    #[test]
    fn a_process_restart_manager_cant_look_into_refuses() {
        let (own, laci) = (|pid| pid == 10, |pid| pid == 20);
        // Permission denied, another session, a critical process, a critical service, and one Windows may add.
        for reason in [0x1, 0x2, 0x4, 0x8, 0x20] {
            assert_eq!(verdict([], reason, own, laci), Verdict::Refuse(UNCHECKED), "{reason:#x}");
            assert_eq!(verdict([10], reason | DETECTED_SELF, own, laci), Verdict::Refuse(UNCHECKED), "{reason:#x}");
            assert_eq!(verdict([20], reason, own, laci), Verdict::Refuse(UNCHECKED), "{reason:#x}");
            assert_eq!(verdict([12], reason, own, laci), Verdict::Refuse(UNCHECKED), "{reason:#x}");
        }
    }

    #[test]
    fn files_go_over_in_bounded_batches_in_order() {
        assert_eq!(batches::<u32>(&[]).count(), 0, "no files, no call");
        let files: Vec<usize> = (0..BATCH * 2 + 1).collect();
        assert_eq!(batches(&files).map(<[usize]>::len).collect::<Vec<_>>(), [BATCH, BATCH, 1]);
        assert_eq!(batches(&files).flatten().copied().collect::<Vec<_>>(), files, "each file once, in order");
    }

    #[test]
    fn a_full_path_goes_in_the_plain_spelling_of_the_same_file() {
        for path in [r"C:\Users\Me\.claude\projects\C--Users-Me-demo\a.jsonl", r"\\server\share\Me\.codex\b.jsonl"] {
            assert_eq!(named(path), Ok(Name::Plain(wide(path))), "{path}");
        }
        for (path, plain) in [
            (r"C:/Users/Me/a.jsonl", r"C:\Users\Me\a.jsonl"),
            (r"\\?\C:\Users\Me\a.jsonl", r"C:\Users\Me\a.jsonl"),
            (r"\\?\UNC\server\share\Me\a.jsonl", r"\\server\share\Me\a.jsonl"),
            (r"//server/share/Me/a.jsonl", r"\\server\share\Me\a.jsonl"),
        ] {
            assert_eq!(named(path), Ok(Name::Plain(wide(plain))), "{path}");
        }
        for path in [r"C:\h\auxiliary.jsonl", r"C:\h\com10", r"C:\h\console.log", r"C:\h\a.b.c", r"C:\h\ a", "C:\\h\\é"]
        {
            assert!(matches!(named(path), Ok(Name::Plain(_))), "{path}");
        }
    }

    /// A name Windows would change before it opens the file by its plain spelling, or would never find by its `\\?\`
    /// one, would have Restart Manager find nobody holding the file. Such a file is refused instead.
    #[test]
    fn a_name_windows_reads_as_another_is_refused() {
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
            r"C:\h\a:b",
            r"C:\h\a*b",
            "C:\\h\\a\u{1}b",
            r"\\?\C:\h\log.",
            r"\\?\C:\h\a/b",
            r"\\?\C:\h\nul",
            r"\\?\UNC\server\share\aux",
            r"\\server.\share\a",
            r"\\server\share \a",
        ] {
            assert_eq!(named(path), Err(ODD_NAME), "{path}");
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
            r"\\?\C:\h\..\log",
            r"\\?\C:",
            r"\\?\c:h",
            r"\\.\C:\h\log",
            r"//./C:/h/log",
            r"//?/C:/h/log",
            r"\??\C:\h\log",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\h\log",
            r"\\?\Volume{0b1c4d2e-0000-0000-0000-100000000000}\h\log",
            r"\\?\unc\server\share\log",
            r"\\server",
            r"\\server\share",
            r"\\server\share\",
            r"\\\share\log",
        ] {
            assert_eq!(named(path), Err(FAILED), "{path}");
        }
    }

    /// Past MAX_PATH only the `\\?\` spelling names a file, and only up to [`LONGEST`] it goes to Restart Manager.
    #[test]
    fn a_path_past_max_path_goes_in_the_verbatim_spelling_up_to_a_bound() {
        // `C:\`, then names of 100 and the rest, to `length` in all.
        let path = |length: usize| format!(r"C:\{}\{}", "a".repeat(100), "b".repeat(length - 104));
        assert_eq!(named(&path(MAX_PATH - 1)), Ok(Name::Plain(wide(&path(MAX_PATH - 1)))), "with its NUL, MAX_PATH");
        assert_eq!(named(&path(MAX_PATH)), Ok(Name::Long(wide(&format!(r"\\?\{}", path(MAX_PATH))))));
        let verbatim = format!(r"\\?\{}", path(MAX_PATH));
        assert_eq!(named(&verbatim), Ok(Name::Long(wide(&verbatim))));
        let share = format!(r"\\server\share\{}\{}", "a".repeat(100), "b".repeat(150));
        let long_share = format!(r"\\?\UNC\server\share\{}\{}", "a".repeat(100), "b".repeat(150));
        assert_eq!(named(&share), Ok(Name::Long(wide(&long_share))));
        assert_eq!(named(&long_share), Ok(Name::Long(wide(&long_share))));
        // `\\?\` and the names, with ones of 200 in between: LONGEST, then one more.
        let longest =
            |extra: usize| format!(r"\\?\C:\{}\{}", vec!["c".repeat(200); 4].join(r"\"), "d".repeat(213 + extra));
        assert_eq!(wide(&longest(0)).len(), LONGEST);
        assert_eq!(named(&longest(0)), Ok(Name::Long(wide(&longest(0)))));
        assert_eq!(named(&longest(1)), Err(TOO_LONG));
        assert_eq!(named(&longest(1)[4..]), Err(TOO_LONG), "in the plain spelling as well");
        assert_eq!(named(&format!(r"{}\log.", path(MAX_PATH))), Err(ODD_NAME), "a long path is checked as well");
    }
}
