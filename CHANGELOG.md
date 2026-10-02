# Changelog

What changed in laci, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Desktop runtime migrated to Rust and Tauri 2. React preserves the current interface, with local fonts and direct IPC.
- The desktop, CLI and 14 stdio MCP tools share one Rust engine. Installed builds no longer need Electron or Node.
- Existing config, `.laci.md`, activity logs, move journals and backups are read directly. Move journals can be undone by either v1 or v2.

### Added

- Linux AppImage, Debian and RPM packaging, native window checks and a CI build workflow.
- Cross-process regression checks for metadata/task/notes undo, linked paths, destination collisions and rollback.

### Fixed

- Dialogs retain drafts and keyboard focus when application shortcuts are pressed; Escape dismisses one layer, and custom connector forms focus their first field.
- Enter activates a focused row action without also activating its parent row.
- Closing a live terminal asks for confirmation with Cancel focused. Cancel and Escape keep its processes running; exited terminals close directly.

## [1.0.0] - 2026-09-30

The first tagged release: a file manager for your projects that keeps their agent history attached, now live and with a log of everything it changes.

### Added

- **Log.** A page listing every change laci made, from the app or from an agent over MCP: moves, archives, Tidy fixes, status, priority and deadline, to-dos, notes, connectors, settings and new projects. Most of them can be undone from there. A change that was changed again later says so instead of overwriting the newer one.
- **Live updates.** laci watches your project folders, each project's files and git state, the agent logs and the folders you have open. New folders, edits, commits and agent sessions show up by themselves; *Scan again* is only needed if something looks off.
- **Instant start.** The last scan shows right away while a fresh one runs in the background.
- **Display menu** in the folder view: sort by name, modified, size or agent sessions in either direction, and choose whether folders come first and whether hidden files and archived projects show.
- **Theme switch** (system, light, dark) in the sidebar.
- **`create_project`** MCP tool: agents can start a project the same way the app does, with a plan first.
- **Debug log** at `~/.local/share/laci/laci.log` (rotated at 1 MB), with a *Debug log* button on the Log page. `LACI_DEBUG=1` adds file watcher events.
- This changelog, and a README with new screenshots.

### Changed

- Times are real and relative: *just now*, *5 min*, *3 h*, *yesterday*, with the time of day where it helps (*yesterday 14:02*) and the full date on hover. They stay current while the app is open.
- *Modified* means the same on every row: when anything inside last changed (a file, a commit or an agent session). Plain folders now look inside too.
- Column headers show which ones sort and which way; the order is written above the list.
- Filters say what they cover: *All files* is this folder, the others list projects in this folder and every folder below it.
- Today's lists and Tidy's suggestions state their order. Tidy groups suggestions by kind, broken links first.
- Scans are about three times faster: agent logs are read once and cached (`~/.cache/laci`), and a growing log is read from where the last read stopped. The MCP server benefits too.
- The theme is saved in `~/.config/laci/config.json`, and the desktop window opens in it.

### Fixed

- The window no longer flashes the other theme's colors at start.
- A repo pushed to GitHub (`origin`) and mirrored to a second remote showed the mirror as its remote.
- A to-do containing `~/` or `snake_case` lost those characters (`~/.local` became `/.local`).
- Rewriting paths in an agent log made that session look like it just ran; logs now keep their time.
- Setting a status, to-do or note in laci no longer counts as activity on the project.

## [0.2.0] - 2026-09-30

### Added

- **Connectors** for agent history. Claude Code, Codex, Gemini CLI, Claude plans, Serena and Aider are in the catalog, and any other tool can be described in a form (log files that record the folder, one folder per project, inside the project, or files that mention it). Only the ones you add show; tools with data on this PC are suggested.
- **Browse everything** like a file manager, with filters for projects, projects that use laci, projects with agent sessions and projects that need attention.
- **Welcome screen and Settings**: which folders hold your projects, which AI tools you use, and which terminal, editor and file manager to open things with.
- **New project**: empty, from a template in `~/.config/laci/templates`, or cloned; with git, a first commit, `.laci.md`, and optionally a private repo on GitHub, GitLab or both.

### Fixed

- The terminal panel follows the light and dark theme.

## [0.1.0] - 2026-09-30

### Added

- Scanner that finds projects in your folders and reads their git state, README, stack, to-dos and agent sessions.
- Archive and move engine that carries agent history along, with an undo journal for every step.
- Desktop app (Electron) with Today, Tidy up, Agent history, a project inspector and a built-in terminal.
- MCP server so agents can list, sort and archive projects through laci instead of `mv`.
- README with screenshots from demo data (`node scripts/demo.ts <dir>`).
