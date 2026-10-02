# Contributing

Use the Rust toolchain pinned in `rust-toolchain.toml`, Node 24 or newer, and pnpm. Install [Tauri's Linux prerequisites](https://v2.tauri.app/start/prerequisites/) before building. `pnpm install --frozen-lockfile` installs the React build tools and the Tauri CLI.

Install git, `gio` and `xdg-open` for project operations, trash and opening files or URLs. Debian/Ubuntu provide them in `git`, `libglib2.0-bin` and `xdg-utils`.

Run `pnpm dev` to launch the native window. The React source is under `ui/`; Rust commands are under `src-tauri/`, and the shared engine is under `crates/laci-core/`. Preserve the established interface in `prototype/app.html` when making behavior changes.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Core tests use temporary folders. Their v1 journal compatibility fixture requires Node; it contains the original journal algorithm so both directions remain checked after the TypeScript runtime is removed. Changes involving filesystem security, rollback, log parsing or migration compatibility need regression coverage. Small visual changes should be checked in the actual window.

## Native window validation

In the first terminal, build the native binary, create a demo home and start the driver:

```sh
node scripts/demo.ts /tmp/laci-demo
pnpm -C ui build
cargo build -p laci --features custom-protocol
cargo install tauri-driver --locked
LACI_HOME=/tmp/laci-demo tauri-driver
```

Keep the driver running. In a second terminal from the same checkout, run the harness with the same `LACI_HOME`:

```sh
LACI_HOME=/tmp/laci-demo node scripts/desktop-smoke.mjs target/debug/laci
```

Stop the driver with Ctrl+C after the check.

The smoke harness drives WebKitWebDriver through `tauri-driver` on port 4444. Install WebKitWebDriver alongside WebKitGTK. Run under `xvfb-run` in a headless environment. The harness exercises the built native application; Vite alone does not provide desktop IPC.

For focused keyboard regression checks, use a fresh demo home and run `LACI_HOME=/tmp/laci-demo LACI_KEYBOARD_ONLY=1 node scripts/desktop-smoke.mjs target/debug/laci`. The full harness includes the same checks: real keyboard shortcuts in dialogs and xterm, Enter on row buttons, connector focus and Tab containment, and terminal close confirmation. The terminal check starts a disposable shell and `sleep` process; Cancel and Escape must preserve both process identities, and confirmation must stop both. It also checks that a shell exiting with code zero closes without a prompt.

Use a disposable demo home when testing move, archive, undo or new-project flows. `LACI_HOME` isolates laci's files without changing the caller's `HOME`. Never replace the real home folder while running package managers or Rust tools.

## Demo scan benchmarks

Install GNU time at `/usr/bin/time` (or set `LACI_TIME` to its executable path), then build the release binary and measure it against disposable demo data:

```sh
pnpm build:binary
node scripts/benchmark.mjs target/release/laci
```

To compare against v1, pass its checkout as the second argument:

```sh
node scripts/benchmark.mjs target/release/laci /path/to/v1
```

Use a v1 checkout with its dependencies installed. The script creates a temporary demo home, runs one cold scan and three warm scans per version, then removes the fixture. It reports wall time, scanner time, peak process RSS in MiB and project count. These measurements cover CLI scans of the demo fixture; they do not measure desktop memory or scans of your own projects.

A local Linux x86-64 run on seven demo projects (2026-10-02, Rust 1.98.1 release profile, Node 26.4.0 and GNU time 1.10) produced:

| CLI | Cold wall time | Warm wall time, median of 3 | Cold peak RSS |
| --- | --- | --- | --- |
| Rust v2 | 1.24 s | 1.09 s | 49.7 MiB |
| TypeScript v1 | 2.62 s | 2.27 s | 89.8 MiB |

Cold runs clear laci's caches, without flushing the operating system's page cache. These are measurements from one local run, not desktop performance guarantees.

## Packages

`pnpm build` bundles AppImage, Debian and RPM packages in `target/release/bundle/`. Inspect and run the packages before distributing them. Building packages does not publish a release. The CI workflow validates source and uploads local build artifacts.

Linux bundles depend on the build host's system libraries. CI builds on Ubuntu 24.04; use the oldest Linux distribution you support when building packages for distribution.

Use Conventional Commits and keep changes focused. Commit only source, documentation and intentional assets; leave local prompts, agent configuration and handoff notes out of Git.
