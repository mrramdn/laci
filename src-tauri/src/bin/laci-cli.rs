//! The console program, which Windows' installer ships as bin\laci.exe: the `laci` people type and agents start as
//! their MCP server there. It answers the same commands as the window's program; without one it starts the window and
//! returns. Built only with the `console` feature.
fn main() {
    laci::main(laci::Program::Console);
}
