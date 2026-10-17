//! Edits the project's private Markdown notes without rewriting unrelated content. It writes the line ending the file
//! mostly uses, and the lines below the frontmatter that it leaves alone keep theirs.
use crate::{Result, files, git, readers};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::{
    fs,
    ops::Range,
    path::{Path, PathBuf},
    time::Duration,
};

pub const SIDECAR: &str = ".laci.md";
const TEMPLATE: &str = "---\n---\n\n## Next\n\n## Notes\n";
const CRLF: &str = "\r\n";

/// The line ending most of a file's lines use. CRLF has to have more of them than LF; a file with no lines, or
/// with as many of each, counts as LF.
fn ending(text: &str) -> &'static str {
    let crlf = text.matches(CRLF).count();
    if crlf > text.matches('\n').count() - crlf { CRLF } else { "\n" }
}
/// The frontmatter's fields and the body after it. The block closes at a `---` that starts a line, as `parse_meta`
/// reads it, so a value such as `summary: v1 --- v2` stays whole.
fn split(text: &str) -> (Vec<String>, String) {
    let re = Regex::new(r"\A---\r?\n((?:[\s\S]*?\r?\n)??)---(?:\r?\n)?").expect("valid frontmatter regex");
    if let Some(c) = re.captures(text) {
        (c[1].lines().map(str::to_owned).collect(), text[c.get(0).unwrap().end()..].into())
    } else {
        (vec![], text.into())
    }
}
fn join(fm: Vec<String>, body: &str, eol: &str) -> String {
    let fields = fm.into_iter().filter(|s| !s.trim().is_empty()).map(|s| format!("{s}{eol}")).collect::<String>();
    let blank = if body.starts_with('\n') || body.starts_with(CRLF) { "" } else { eol };
    format!("---{eol}{fields}---{eol}{blank}{body}")
}
/// A line without the `\r` that splitting at `\n` leaves on a CRLF line.
fn bare(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}
fn section(lines: &[String], name: &str) -> Option<(usize, usize)> {
    let start = lines.iter().position(|l| l.strip_prefix("##").is_some_and(|s| s.trim().eq_ignore_ascii_case(name)))?;
    let end = (start + 1..lines.len())
        .find(|&i| Regex::new(r"^#{1,2}\s").unwrap().is_match(bare(&lines[i])))
        .unwrap_or(lines.len());
    Some((start, end))
}
/// Replaces `lines[range]` with `new` lines that end the way the file's lines do. The last line of a file has no
/// newline after it: a line added behind it ends it, and the new last line stays open.
fn splice_lines(lines: &mut Vec<String>, range: Range<usize>, new: Vec<String>, eol: &str) {
    let (start, end) = (range.start, range.start + new.len());
    let behind = start > 0 && start == lines.len();
    lines.splice(range, new);
    if eol == CRLF && end > start {
        let last = lines.len() - 1;
        for line in &mut lines[start - usize::from(behind)..end.min(last)] {
            line.push('\r');
        }
    }
}
/// Reject linked files and linked ancestor directories before writing notes or task files.
pub(crate) fn plain_path(path: &Path) -> Result<()> {
    for p in path.ancestors() {
        if fs::symlink_metadata(p).is_ok_and(|m| m.is_symlink()) {
            return Err(format!("Refusing to edit linked path {}", p.display()));
        }
    }
    Ok(())
}
/// Hands `transform` the file's text and the line ending its new lines get. A byte order mark, which some Windows
/// editors write, is set aside so the frontmatter is still found, and written back in front.
fn edit(dir: &Path, transform: impl FnOnce(&str, &str) -> String) -> Result<()> {
    let path = dir.join(SIDECAR);
    plain_path(&path)?;
    if !dir.is_dir() {
        return Err("Project folder is gone".into());
    }
    let before = if path.exists() { fs::read_to_string(&path).map_err(|e| e.to_string())? } else { TEMPLATE.into() };
    let (bom, text) = before.strip_prefix('\u{feff}').map_or(("", before.as_str()), |rest| ("\u{feff}", rest));
    files::replace(&path, format!("{bom}{}", transform(text, ending(text))).as_bytes())?;
    ensure_excluded(dir)
}
pub(crate) fn exclude_file(dir: &Path) -> Option<PathBuf> {
    let raw = git::plain(dir, &["rev-parse", "--git-path", "info/exclude"], Duration::from_secs(5)).ok()?;
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    Some(if path.is_absolute() { path } else { dir.join(path) })
}
pub fn ensure_excluded(dir: &Path) -> Result<()> {
    let Some(path) = exclude_file(dir) else {
        return Ok(());
    };
    plain_path(&path)?;
    let before = if path.exists() { fs::read_to_string(&path).map_err(|e| e.to_string())? } else { String::new() };
    if before.lines().any(|s| s.trim() == SIDECAR) {
        return Ok(());
    }
    let eol = ending(&before);
    files::replace(
        &path,
        format!("{before}{}{SIDECAR}{eol}", if !before.is_empty() && !before.ends_with('\n') { eol } else { "" })
            .as_bytes(),
    )
}
pub fn set_meta(dir: &Path, key: &str, value: &str) -> Result<()> {
    let valid = match key {
        "status" => ["", "active", "idle", "dormant", "idea", "paused", "done", "archived"].contains(&value),
        "priority" => ["", "high", "medium", "low"].contains(&value),
        "deadline" => value.is_empty() || Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap().is_match(value),
        "client" => value.chars().count() <= 80 && !value.contains(['\n', '\r']),
        // Checks muted for this project: issue codes, comma separated.
        "quiet" => {
            value.len() <= 200
                && value
                    .split(',')
                    .map(str::trim)
                    .all(|code| !code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'))
                || value.is_empty()
        }
        _ => false,
    };
    if !valid {
        return Err("Unknown field or invalid value".into());
    }
    edit(dir, |text, eol| {
        let (mut fm, body) = split(text);
        let i = fm.iter().position(|s| s.starts_with(&format!("{key}:")));
        if value.is_empty() {
            if let Some(i) = i {
                fm.remove(i);
            }
        } else if let Some(i) = i {
            fm[i] = format!("{key}: {value}");
        } else {
            fm.push(format!("{key}: {value}"));
        }
        join(fm, &body, eol)
    })
}
pub fn add_next(dir: &Path, text: &str) -> Result<()> {
    add_next_checked(dir, text, false).map(|_| ())
}
pub(crate) fn add_next_checked(dir: &Path, text: &str, done: bool) -> Result<Checkbox> {
    let item = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if item.is_empty() {
        return Err("Write a next step".into());
    }
    let mut line = 0;
    edit(dir, |text, eol| {
        let (fm, body) = split(text);
        let mut lines = body.split('\n').map(str::to_owned).collect::<Vec<_>>();
        if section(&lines, "Next").is_none() {
            splice_lines(&mut lines, 0..0, vec!["".into(), "## Next".into(), "".into()], eol);
        }
        let (start, mut at) = section(&lines, "Next").unwrap();
        while at > start + 1 && lines[at - 1].trim().is_empty() {
            at -= 1;
        }
        splice_lines(&mut lines, at..at, vec![format!("- [{}] {item}", if done { "x" } else { " " })], eol);
        let body = lines.join("\n");
        let changed = join(fm, &body, eol);
        line = changed[..changed.len() - body.len()].bytes().filter(|b| *b == b'\n').count() + at + 1;
        changed
    })?;
    checkbox(&dir.join(SIDECAR), line, &readers::strip_md(&item))
}
pub fn set_notes(dir: &Path, text: &str) -> Result<()> {
    edit(dir, |src, eol| {
        let (fm, body) = split(src);
        let mut lines = body.split('\n').map(str::to_owned).collect::<Vec<_>>();
        // Notes that come with CRLF would end their lines twice in a file that is CRLF itself.
        let notes = if eol == CRLF { text.replace(CRLF, "\n") } else { text.to_owned() };
        let content = if notes.trim().is_empty() {
            vec![String::new()]
        } else {
            let mut v = vec![String::new()];
            v.extend(notes.trim_end().split('\n').map(str::to_owned));
            v.push(String::new());
            v
        };
        if let Some((start, end)) = section(&lines, "Notes") {
            splice_lines(&mut lines, start + 1..end, content, eol);
        } else {
            let end = lines.len();
            splice_lines(&mut lines, end..end, ["## Notes".into()].into_iter().chain(content).collect(), eol);
        }
        join(fm, &lines.join("\n"), eol)
    })
}
fn locate(lines: &[&str], line: usize, text: &str, re: &Regex) -> Result<usize> {
    let same = |s: &str| re.captures(s).is_some_and(|c| readers::strip_md(&c[4]) == text);
    if line > 0 && lines.get(line - 1).is_some_and(|s| same(s)) {
        return Ok(line - 1);
    }
    let mut matches = lines.iter().enumerate().filter(|(_, s)| same(s));
    match (matches.next(), matches.next()) {
        (Some((at, _)), None) => Ok(at),
        _ => Err(format!(
            "Couldn't identify \"{}\" anymore. Rescan and try again.",
            text.chars().take(60).collect::<String>()
        )),
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Checkbox {
    pub line: usize,
    pub occurrence: usize,
    pub count: usize,
    pub done: bool,
}
fn checkboxes(file: &Path, text: &str) -> Result<Vec<Checkbox>> {
    plain_path(file)?;
    let source = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let re = Regex::new(r"^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$").unwrap();
    // The same fences as the to-do reader, so a checkbox is found on the line it was listed from.
    let mut fence = readers::Fence::default();
    let mut matches = source
        .lines()
        .enumerate()
        .filter_map(|(at, line)| {
            if fence.skip(line) {
                return None;
            }
            let captures = re.captures(line)?;
            (readers::strip_md(&captures[4]) == text).then_some(Checkbox {
                line: at + 1,
                occurrence: 0,
                count: 0,
                done: captures[2].eq_ignore_ascii_case("x"),
            })
        })
        .collect::<Vec<_>>();
    let count = matches.len();
    for (occurrence, checkbox) in matches.iter_mut().enumerate() {
        checkbox.occurrence = occurrence;
        checkbox.count = count;
    }
    Ok(matches)
}
pub(crate) fn checkbox(file: &Path, line: usize, text: &str) -> Result<Checkbox> {
    let matches = checkboxes(file, text)?;
    if line > 0
        && let Some(task) = matches.iter().find(|task| task.line == line)
    {
        return Ok(*task);
    }
    match matches.as_slice() {
        [task] => Ok(*task),
        _ => Err("Couldn't identify that checkbox. Rescan and try again.".into()),
    }
}
pub(crate) fn checkbox_occurrence(file: &Path, text: &str, occurrence: usize, count: usize) -> Result<Checkbox> {
    let matches = checkboxes(file, text)?;
    if matches.len() != count {
        return Err("The matching checkboxes changed. Rescan and try again.".into());
    }
    matches.get(occurrence).copied().ok_or_else(|| "That checkbox is gone. Rescan and try again.".into())
}
pub(crate) struct RemovedCheckbox {
    pub raw: String,
    pub offset: usize,
    pub after_hash: String,
}
fn fingerprint(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub(crate) fn restore_check(
    dir: &Path,
    text: &str,
    done: bool,
    occurrence: usize,
    count: usize,
    context: Option<&RemovedCheckbox>,
) -> Result<()> {
    let file = dir.join(SIDECAR);
    let matches = checkboxes(&file, text)?;
    if count == 0 || occurrence >= count || matches.len() != count - 1 {
        return Err("The matching checkboxes changed. Rescan and try again.".into());
    }
    let Some(context) = context else {
        return if count == 1 {
            add_next_checked(dir, text, done).map(|_| ())
        } else {
            Err("The deleted checkbox has no safe location to restore.".into())
        };
    };
    let mut source = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    if fingerprint(&source) != context.after_hash {
        return Err(
            "The task file changed after this deletion. Restore the checkbox manually or undo the newer edit first."
                .into(),
        );
    }
    let re = Regex::new(r"^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$").unwrap();
    let line = context.raw.strip_suffix('\n').unwrap_or(&context.raw);
    let valid = !line.contains('\n')
        && source.is_char_boundary(context.offset)
        && (context.offset == 0 || source.as_bytes().get(context.offset - 1) == Some(&b'\n'))
        && (context.raw.ends_with('\n') || context.offset == source.len())
        && re.captures(line).is_some_and(|captures| {
            readers::strip_md(&captures[4]) == text && captures[2].eq_ignore_ascii_case("x") == done
        });
    if !valid {
        return Err("Invalid deleted checkbox context".into());
    }
    source.insert_str(context.offset, &context.raw);
    files::replace(&file, source.as_bytes())?;
    ensure_excluded(dir)
}
pub fn toggle_check(file: &Path, line: usize, text: &str, done: bool) -> Result<()> {
    plain_path(file)?;
    let src = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let mut lines = src.split('\n').collect::<Vec<_>>();
    let re = Regex::new(r"^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$").unwrap();
    let at = locate(&lines, line, text, &re)?;
    let c = re.captures(lines[at]).unwrap();
    let changed = format!("{}{}{}{}", &c[1], if done { "x" } else { " " }, &c[3], &c[4]);
    lines[at] = &changed;
    files::replace(file, lines.join("\n").as_bytes())
}
/// Rewrites a checkbox's text and keeps its mark, indentation and line ending. Returns the text it replaced, as
/// written, without the line ending.
pub(crate) fn edit_check(file: &Path, line: usize, text: &str, to: &str) -> Result<String> {
    if to.trim().is_empty() || to.contains(['\n', '\r']) {
        return Err("Write the new text on one line".into());
    }
    plain_path(file)?;
    let src = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let mut lines = src.split('\n').collect::<Vec<_>>();
    let re = Regex::new(r"^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$").unwrap();
    let at = locate(&lines, line, text, &re)?;
    let c = re.captures(lines[at]).unwrap();
    // The `\r` of a CRLF line is part of the text the pattern captured.
    let (before, cr) = c[4].strip_suffix('\r').map_or((&c[4], ""), |before| (before, "\r"));
    let before = before.to_owned();
    let changed = format!("{}{}{}{}{cr}", &c[1], &c[2], &c[3], to.trim());
    lines[at] = &changed;
    files::replace(file, lines.join("\n").as_bytes())?;
    Ok(before)
}
pub fn delete_check(file: &Path, line: usize, text: &str) -> Result<()> {
    delete_check_with_context(file, line, text).map(|_| ())
}
pub(crate) fn delete_check_with_context(file: &Path, line: usize, text: &str) -> Result<RemovedCheckbox> {
    plain_path(file)?;
    let src = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let lines = src.split('\n').collect::<Vec<_>>();
    let re = Regex::new(r"^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$").unwrap();
    let at = locate(&lines, line, text, &re)?;
    let offset: usize = lines[..at].iter().map(|line| line.len() + 1).sum();
    let mut end = offset + lines[at].len();
    if src.as_bytes().get(end) == Some(&b'\n') {
        end += 1;
    }
    let remaining = format!("{}{}", &src[..offset], &src[end..]);
    let context = RemovedCheckbox { raw: src[offset..end].to_owned(), offset, after_hash: fingerprint(&remaining) };
    files::replace(file, remaining.as_bytes())?;
    Ok(context)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_ending_is_the_one_most_lines_use() {
        for (text, eol) in [
            ("", "\n"),
            ("one line", "\n"),
            ("a\nb\n", "\n"),
            ("a\r\nb\r\n", CRLF),
            ("a\r\nb\r\nc\n", CRLF),
            ("a\nb\nc\r\n", "\n"),
            ("a\r\nb\n", "\n"),
        ] {
            assert_eq!(ending(text), eol, "{text:?}");
        }
    }
    #[test]
    fn frontmatter_ends_at_its_closing_line_whichever_way_lines_end() {
        for eol in ["\n", CRLF] {
            let (fm, body) = split(&format!("---{eol}status: active{eol}client: Acme{eol}---{eol}{eol}## Next{eol}"));
            assert_eq!(fm, ["status: active", "client: Acme"]);
            assert_eq!(body, format!("{eol}## Next{eol}"));
            assert_eq!(
                join(fm, &body, eol),
                format!("---{eol}status: active{eol}client: Acme{eol}---{eol}{eol}## Next{eol}")
            );
        }
    }
    #[test]
    fn lines_spliced_in_end_the_way_the_file_does_and_a_new_last_line_stays_open() {
        for (before, range, new, after) in [
            ("a\nb\n", 1..1, vec!["x"], "a\nx\nb\n"),
            ("a\nb\nc\n", 1..3, vec!["x", "y"], "a\nx\ny\n"),
            // The file's last line has no newline, and gets one.
            ("a\nb", 2..2, vec!["c"], "a\nb\nc"),
            // The empty piece after the last newline becomes a blank line.
            ("a\nb\n", 3..3, vec!["c"], "a\nb\n\nc"),
            // The new pieces take the place of the last one, which stays open.
            ("a\nb\nc\n", 1..4, vec!["x", ""], "a\nx\n"),
        ] {
            for eol in ["\n", CRLF] {
                let mut lines = before.replace('\n', eol).split('\n').map(str::to_owned).collect::<Vec<_>>();
                splice_lines(&mut lines, range.clone(), new.iter().map(|line| line.to_string()).collect(), eol);
                assert_eq!(lines.join("\n"), after.replace('\n', eol), "{before:?} {range:?} {eol:?}");
            }
        }
    }
}
