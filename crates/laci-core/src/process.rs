use crate::Result;
use std::{
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub fn run(program: &str, args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Result<String> {
    // Files avoid pipe backpressure and reader threads surviving a child with inherited descriptors.
    let output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let errors = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(output.try_clone().map_err(|e| e.to_string())?)
        .stderr(errors.try_clone().map_err(|e| e.to_string())?)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(|e| format!("Couldn't start {program}: {e}"))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            use std::io::{Read, Seek, SeekFrom};
            let mut file = if status.success() { output } else { errors };
            file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
            let mut text = String::new();
            file.take(16_000_000).read_to_string(&mut text).map_err(|e| e.to_string())?;
            return if status.success() {
                Ok(text.trim_end().into())
            } else {
                Err(format!("{program} failed: {}", text.trim()))
            };
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{program} took too long"));
        }
        thread::sleep(Duration::from_millis(10));
    }
}
