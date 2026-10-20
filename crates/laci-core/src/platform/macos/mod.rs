//! macOS. What POSIX gives comes from `unix`; the rest isn't written for macOS yet and fails with a plain message.
mod dirs;
mod files;
mod process;
mod programs;
mod terminal;
mod trash;

pub use super::unix::{
    Group, IDENTITY_FIELDS, Lock, change_stamp, copy_link, exited, file_change_stamp, home_dir, identity, lock,
    preserve, remove_all, rename_noreplace, spawn_group, which,
};
pub use super::unix::{explain, keep_attributes, move_notes, open_nofollow, retry};
pub use dirs::user_dirs;
pub use files::{hidden_flag, placeholder, system_folder};
pub use process::{ensure_idle, pid_alive, processes_in};
pub use programs::{git, login_path, program, shell_path};
pub use terminal::{DEFAULT_APPS, KNOWN_APPS, terminal_args, terminal_script_args};
pub use trash::{open, trash};

pub fn host_name() -> Option<String> {
    sysinfo::System::host_name()
}

fn not_yet<T>(what: &str) -> crate::Result<T> {
    Err(format!("Laci can't {what} on macOS yet"))
}
