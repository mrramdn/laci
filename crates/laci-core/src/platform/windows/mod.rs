//! Windows. Nothing is written for it yet: every call fails with a plain message, so Laci refuses what it can't check
//! instead of guessing.
mod ffi;
mod fs;
mod process;
mod recycle;
mod spawn;
mod terminal;

pub use fs::{
    Lock, change_stamp, file_change_stamp, home_dir, identity, lock, preserve, rename_noreplace, trash, user_dirs,
};
pub use process::{Group, ensure_idle, exited, pid_alive, processes_in, spawn_group};
pub use spawn::open;
pub use terminal::{DEFAULT_APPS, KNOWN_APPS, terminal_args, terminal_script_args};

/// What the user is told about something Laci can't do on Windows yet.
fn not_yet(what: &str) -> String {
    format!("Laci can't {what} on Windows yet")
}
