//! The window's program, `laci`. Without a command it opens Laci's window; with one it answers as the console program
//! does (lib.rs). A release build for Windows gets no console, so none flashes up when Laci starts; there bin\laci.exe
//! answers commands.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod app;

fn main() {
    laci::main(laci::Program::Window(app::run));
}
