//! macOS. What POSIX gives comes from `unix`; the rest isn't written for macOS yet and fails with a plain message.
mod dirs;
mod process;
mod programs;
mod terminal;
mod trash;

pub use super::unix::{
    Group, IDENTITY_FIELDS, Lock, change_stamp, copy_link, exited, file_change_stamp, home_dir, identity, lock,
    preserve, rename_noreplace, spawn_group, which,
};
pub use dirs::user_dirs;
pub use process::{ensure_idle, pid_alive, processes_in};
pub use programs::{git, login_path, program};
pub use terminal::{DEFAULT_APPS, KNOWN_APPS, terminal_args, terminal_script_args};
pub use trash::{open, trash};

fn not_yet<T>(what: &str) -> crate::Result<T> {
    Err(format!("Laci can't {what} on macOS yet"))
}
