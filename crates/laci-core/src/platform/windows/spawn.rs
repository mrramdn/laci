//! Finding and starting programs on Windows, and the apps the system picks for a file or a link.
use crate::{Result, process};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

/// What Laci starts of what PATH and PATHEXT find.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// An .exe or .com, which starts as it is.
    Program,
    /// A .cmd or .bat, which Windows runs through cmd.exe.
    Batch,
}

fn kind(path: &Path) -> Option<Kind> {
    let extension = path.extension()?.to_str()?;
    if ["exe", "com"].iter().any(|known| extension.eq_ignore_ascii_case(known)) {
        Some(Kind::Program)
    } else if ["cmd", "bat"].iter().any(|known| extension.eq_ignore_ascii_case(known)) {
        Some(Kind::Batch)
    } else {
        None
    }
}

/// The first file in `path`'s folders, in their order, named `program` or `program` plus an extension from PATHEXT,
/// as cmd finds it, that is a program or a batch file. Other kinds PATHEXT may list, such as .js and .vbs, are passed
/// over, and so is a file without an extension, such as the sh script npm puts beside its .cmd. A folder named
/// without its drive is too: it would be looked for in whatever folder Laci works in.
pub fn which(program: &str, path: &OsStr) -> Option<PathBuf> {
    let name = Path::new(program);
    if !name.is_absolute() && name.components().count() != 1 {
        return None;
    }
    let dirs = std::env::join_paths(std::env::split_paths(path).filter(|dir| dir.is_absolute())).ok()?;
    ::which::which_in_global(program, Some(dirs)).ok()?.find(|found| kind(found).is_some())
}

/// What starts `program` with `args`, found on `path`. A program starts as it is. cmd.exe, which runs a batch file,
/// reads some characters in its arguments as commands however they are quoted (BatBadBut), so a shim npm, pnpm or
/// yarn wrote starts as node with its script, as the shim itself would, and any other batch file only with arguments
/// cmd.exe can't misread.
pub fn program(program: &str, args: Vec<OsString>, path: &OsStr) -> Result<(PathBuf, Vec<OsString>)> {
    let found = which(program, path).ok_or_else(|| format!("{program} is not installed or is not on PATH"))?;
    if kind(&found) == Some(Kind::Program) {
        return Ok((found, args));
    }
    let Some(script) = shim(&found) else {
        process::batch_args(&found, &args)?;
        return Ok((found, args));
    };
    // The shim's own choice: a node.exe beside it, as npm leaves in Node.js's own folder, else node on PATH.
    let beside = found.with_file_name("node.exe");
    let node = if beside.is_file() {
        beside
    } else {
        which("node", path)
            .ok_or_else(|| format!("{program} runs on Node.js, which is not installed or is not on PATH"))?
    };
    let args: Vec<OsString> = std::iter::once(script.into_os_string()).chain(args).collect();
    if kind(&node) == Some(Kind::Batch) {
        process::batch_args(&node, &args)?;
    }
    Ok((node, args))
}

/// The script the batch file `cmd` starts with node, when it is a shim npm, pnpm or yarn wrote
/// ([`process::npm_shim`]) and the script is there.
fn shim(cmd: &Path) -> Option<PathBuf> {
    // A shim takes a few hundred bytes; read in part, a longer file could pass for one.
    const LIMIT: u64 = 64 * 1024;
    let mut text = String::new();
    File::open(cmd).ok()?.take(LIMIT + 1).read_to_string(&mut text).ok()?;
    if text.len() as u64 > LIMIT {
        return None;
    }
    let script = cmd.parent()?.join(process::npm_shim(&text)?);
    script.is_file().then_some(script)
}

/// ShellExecuteEx starts the app Windows picks, as a double click in Explorer does, and a folder opens in Explorer.
/// The target goes to it whole, never through `cmd /c start`, where a `&` in a link would start a command. The open
/// crate gives ShellExecuteEx no folder to start in, so the app starts in Laci's, not in `cwd`.
pub fn open(target: &str, _cwd: &Path) -> Result<()> {
    // The shell doesn't take `\\?\` paths; where the plain spelling names the same file, it is used. A link stays as
    // it is.
    ::open::that_detached(dunce::simplified(Path::new(target))).map_err(|e| format!("Couldn't open {target}: {e}"))
}
