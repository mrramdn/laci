//! Windows. Files are told apart by volume and file ID, the change lock is a lock on an open file, renames never
//! replace, and a program Laci starts runs in a Job Object. The rest isn't written yet and fails with a plain message,
//! so Laci refuses what it can't check instead of guessing.
mod dirs;
mod ffi;
mod fs;
mod process;
mod recycle;
mod spawn;
mod terminal;

pub use dirs::{home_dir, user_dirs};
pub use fs::{
    IDENTITY_FIELDS, Lock, change_stamp, copy_link, file_change_stamp, identity, lock, preserve, rename_noreplace,
};
pub use fs::{explain, hidden_flag, move_notes, open_nofollow, placeholder, retry, system_folder};
pub use process::{Group, ensure_idle, exited, pid_alive, processes_in, spawn_group};
pub use recycle::trash;
pub use spawn::{open, program, which};
pub use terminal::{DEFAULT_APPS, KNOWN_APPS, terminal_args, terminal_script_args};

pub fn host_name() -> Option<String> {
    sysinfo::System::host_name()
}

/// What the user is told about something Laci can't do on Windows yet.
fn not_yet(what: &str) -> String {
    format!("Laci can't {what} on Windows yet")
}
