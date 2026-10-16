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

Use a disposable demo home when testing move, archive, Trash, undo or new-project flows. For native Trash checks, create the fixture on the same filesystem as the caller's real home and set `XDG_DATA_HOME` to that demo home’s `.local/share` so system Trash stays isolated. `LACI_HOME` isolates laci's files without changing the caller's `HOME`. Never replace the real home folder while running package managers or Rust tools.

The watcher and full suites include Tidy orphan quarantine, a double Apply click, and Undo with exact session bytes and modification time preserved. Rust regressions hold a background scan open while committing a mutation, reject stale scan results, coalesce repeated agent events, and retain the history guard after a failed refresh. This covers the long Applying changes wait and scan churn without relying on timing thresholds from a small demo.

Run `node scripts/ui-state-smoke.mjs` for reordered refresh/status/mutation replies and duplicate-submit regression coverage. The full desktop suite also checks external scan roots, Settings archive defaults, edited archive destinations with Undo, and Trash rejection when local work appears after preview. `LACI_MODULAR_ONLY=1` runs those modular-action checks alone. Git remotes in these tests are disposable local bare repositories, not live GitHub proof.

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

Run `node scripts/package-smoke.mjs` after building. It extracts all three archives, checks version, embedded UI assets, build identity, launcher and icons, then exercises isolated CLI and MCP operations. Pass an output directory as the first argument to retain extracted packages for native testing. Extraction and execution do not verify package-manager installation. Local packages depend on the build host's libraries; use the Ubuntu CI artifacts for the distribution baseline.

Linux bundles depend on the build host's system libraries. CI builds on Ubuntu 24.04; use the oldest Linux distribution you support when building packages for distribution.

Use Conventional Commits and keep changes focused. Commit only source, documentation and intentional assets; leave local prompts, agent configuration and handoff notes out of Git.

## Patch regressions

Use `CARGO_TARGET_DIR` to reuse a build cache outside the checkout; the package checker honors it too. Run `cargo test --workspace --features custom-protocol`, strict Clippy, UI lint/typecheck/build and `node scripts/ui-state-smoke.mjs` before native checks.

`crates/laci-core/tests/roots_orphans.rs` exercises unavailable roots, stale proposals, reconnection, open writers, Quarantine restoration and Trash recovery using isolated data. `tests/creation.rs` exercises template safety, generator completion/failure and process-group cancellation. Agent/launch tests use synthetic transcripts and argv capture, so they do not spend provider tokens. MCP smoke checks all 21 tools, that changed orphan history invalidates a preview, and that the read tools page and stay small on a long Log and a long to-do list. The unit tests in `src-tauri/src/mcp.rs` hold every read answer to a size budget on a busy synthetic home.

`tests/history_ownership.rs` covers shared and all-missing owners, incomplete/bounded evidence, cached rewrites and Claude folder failures. `tests/external_workspace.rs` covers destination replacement before preview and after confirmation, valid alternatives, Undo and explicit reselection. Desktop creation unit regressions cover reload discovery, concurrent continuation claims and attempt-scoped retries.

When a desktop check fails, `scripts/desktop-smoke.mjs` saves the end of `laci.log`, the page and dialog text, a screenshot and the app status to `LACI_SMOKE_DIAGNOSTICS` (else a new `laci-smoke-diagnostics-*` folder in the temp folder); CI uploads them as the `laci-smoke-diagnostics` artifact.

For native QA, use a fresh demo home, a separate D-Bus session and test executables on PATH for provider launches. `LACI_HOME` isolates Laci data but does not isolate provider authentication or change shell HOME: never use real agent conversations as a transport test. Set a disposable `SHELL` wrapper with a neutral prompt for documentation captures. Check light Laci with a dark GTK theme, dark Laci, small windows, long dropdown options, keyboard/typeahead, one-layer Escape, Ctrl+K/F4 isolation, terminal cwd and external target arguments.

`LACI_PATCH_ONLY=1` runs the small-window dropdown, root-selection and generator regressions. `LACI_AGENT_ONLY=1` captures provider arguments through real native terminals with fake executables. Before starting the driver for that mode, set `PATH="$LACI_HOME/bin:/usr/bin:/bin"`, `LACI_AGENT_CAPTURE="$LACI_HOME/agent-capture.jsonl"` and `LACI_TERMINAL=kitty`; run `tauri-driver` by its absolute path. The harness populates the fixture's `bin` directory before opening the app. This keeps installed providers out of the transport check.

Verify generator progress and cancellation with a saved fixture recipe. Failed output must remain, and an agent-launch failure after creation must expose a retry that does not recreate the folder or remote. Verify empty-root settings across reload, offline-root indications, and Archive with an invalid default and a valid alternative. Keep screenshots synthetic and inspect staged paths before committing.

Reload during a slow generator and verify restored progress and Cancel. Let another requested-agent creation complete across reload, then reload again and confirm one project and one launch. These checks use in-process recovery and fake providers, not app-restart persistence or live accounts.
