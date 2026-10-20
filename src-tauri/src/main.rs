//! Laci's program, `laci`. Without a command it opens Laci's window; with one it answers on the command line (lib.rs).
mod app;

fn main() {
    laci::main(app::run);
}
