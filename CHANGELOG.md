# Changelog

What changed in laci, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.0.1] - 2026-10-08

Fixes and hardening found in an audit of 2.0.0. No data format changes.

### Security

- Reading a folder's Git state no longer starts programs that the folder's own Git settings name (file monitor, filters, hooks, pager, signature checker), and never fetches missing objects. Filters from your own Git settings, such as Git LFS, keep working. This matters for projects copied in from elsewhere: the scan runs without a click.
- A link in a README opens only inside its project, also after links on disk are followed. Documents and images open in their default app; any other file is shown in its folder instead of being started.
- README rendering allows text structure only: no styles, classes, forms or media, so a README cannot restyle or cover the app. Images from the web load after you choose **Load images**.
- MCP `undo_change` returns a preview first and runs with `confirm: true`, like the other tools that change files. Arguments a tool does not list are rejected.
- The web inspector is no longer built into release packages.
- Laci's data and cache folders are private to your user (`0700`), and the activity and debug logs are `0600`. The debug log is never written through a link.

### Fixed

- Deadlines are counted in your local calendar day. Before 07:00 in UTC+7 every deadline was a day off. Wording is now "Due today", "Due tomorrow", "Due in 3 days" and "Overdue by 2 days"; only overdue and the next two days are marked urgent.
- Issue wording: "10 commits not pushed", "2 forgotten stashes", "1 commit exists only on this disk", "Finish 1 half-done move", and history that holds only memory files no longer reads "0 sessions".
- An untracked `.laci.md` made by hand no longer counts as an uncommitted change.
- Saving Settings while `LACI_EDITOR`, `LACI_FILES` or `LACI_TERMINAL` is set no longer writes that one-run value into `config.json`.
- Log: a Settings save says what changed and is skipped when nothing did; titles start with a capital.
- Today: the **active** count is the number of active projects, not the length of the recent list; fix buttons are visible without hovering; with no folders selected there is a **Choose folders** button.
- First run ticks the AI tools found on this PC. The tool list in Settings keeps one order.
- Session rows outside project folders are styled like the rest of the list.
- README: `mailto:` links open the mail app, and links to headings scroll to them.

### Changed

- A submodule with uncommitted changes still counts as one change on its parent, but Laci reads it directly instead of letting Git start itself inside the submodule.

## [2.0.0] - 2026-10-05

Stable Linux release, built on GitHub Actions for Ubuntu 24.04. MIT licensed.

### Compared with v1

- Replaced the Electron runtime with Rust and Tauri 2. Desktop, CLI and MCP now share the same native engine; installed builds do not require Node.js.
- Added configurable scan locations and archive destinations, richer Claude Code/Codex/Antigravity session history, provider-aware resume and guided project creation.
- Added project removal to system Trash, guarded by fresh remote Git verification and preservation of external agent history.
- Improved refresh responsiveness, recovery after interrupted operations and native keyboard/focus behavior.

## [2.0.0-rc.2] - 2026-10-04

### Added

- Explicit scan locations, including an empty selection and unavailable-drive status. Optional folder suggestions use a bounded search.
- Claude Code, Codex and Antigravity connectors with provider capabilities, readable session titles, grouped child sessions and provider-aware resume in Laci or an external terminal.
- Optional agent launch after project creation, with a prompt and provider-supported model/effort overrides. Model discovery runs only on request.
- Referenced local template folders and generator recipes, including Vite. Preview the command, prerequisites and download requirement before starting; view progress, cancel the owned generator process, and retain partial output on failure.
- Orphan-history system Trash alongside the default Quarantine action. Fresh path, source, mounted-root and process checks block stale or ambiguous cleanup.

### Fixed

- Orphan cleanup requires complete ownership evidence and confirms every recorded project is missing. Shared, bounded, unreadable or unfinished histories remain protected.
- Recent Codex cwd and Claude title metadata refresh beyond the transcript head window. Codex child sessions recognize top-level and nested parent IDs.
- Archive preview and execution reject a replaced selected destination folder; a valid alternative or explicit Settings reselection remains available.
- New-project progress, cancellation and optional agent continuation recover after a WebView reload. Repeated continuation requests launch once; an explicit failed-launch retry keeps the created project.
- Token-styled dropdowns follow the app theme, retain keyboard/typeahead behavior and close before their enclosing dialog. Forms keep drafts until submission or explicit discard.
- One sidebar search entrypoint, a Terminal control beside Copy path, visible sort direction, external-root breadcrumbs and keyboard navigation.
- Archive remains accessible when its default destination is invalid, with a field for another destination.
- Pure Trash actions no longer advertise Laci Undo; mixed journals explain recovery through system Trash.
- Per-user launcher installs available icon sizes and resolves its icon through an absolute path.
- AppImage launches host tools without its bundled Python, library and plugin paths leaking into their environment.
- Non-Git projects no longer claim to be committed and pushed. Removed Git trailer reporting and its extra history query.

### Changed

- New installations start with no selected roots or connectors. Existing explicit and custom connector settings remain readable.
- Raw prototype captures are excluded from source; maintained documentation captures use synthetic data.

## [2.0.0-rc.1]

Release candidate for Linux x86-64. The distribution build targets Ubuntu 24.04; the license remains undecided.

### Changed

- Desktop runtime migrated to Rust and Tauri 2. React preserves the current interface, with local fonts and direct IPC.
- The desktop, CLI and 15 stdio MCP tools share one Rust engine. Installed builds no longer need Electron or Node.
- Existing config, `.laci.md`, activity logs, move journals and backups are read directly. Legacy home-folder move journals can be undone by either v1 or v2; external workspace and config-guarded moves require v2.
- Desktop actions acknowledge committed filesystem changes before refreshing the view. One background worker batches refresh requests and refuses results overtaken by a newer edit.
- Agent-log changes refresh history without rereading every project's git state, README and size when the detected project graph is unchanged. Watch directories are enumerated when their topology changes.

### Added

- Linux AppImage, Debian and RPM packaging, native window checks and a CI build workflow.
- Independent scan locations on mounted drives, a default archive folder in Settings, and per-project archive destination previews.
- Project removal to system Trash from the inspector, Tidy and the `delete_project` MCP tool. Live remote refs and fresh local Git/process checks gate removal; external agent history stays intact.
- Cross-process regression checks for metadata/task/notes undo, linked paths, destination collisions and rollback.

### Fixed

- Dialogs retain drafts and keyboard focus when application shortcuts are pressed; Escape dismisses one layer, and custom connector forms focus their first field.
- Enter activates a focused row action without also activating its parent row.
- Closing a live terminal asks for confirmation with Cancel focused. Cancel and Escape keep its processes running; exited terminals close directly.
- Fixed scanner/config/markdown regexes compile once, avoiding repeated Unicode regex work during refreshes. Streaming status updates no longer starve useful newer snapshots.
- Tidy's Applying changes overlay no longer waits for a full post-action scan. Duplicate submissions are blocked, and stale history actions wait for a successful refresh.
- A refresh failure after a committed action appears as a warning and keeps Undo available. An older dialog's completion cannot close a newer dialog.
- Undo refreshes the Log once; metadata and task changes avoid an unrelated full project scan.
- Failed scan retries preserve a completed action's Undo. A snapshot from before the failure cannot clear the refresh warning.
- Git events from a linked worktree's external git directory refresh that worktree's branch and status.
- A custom MCP archive destination works when the default destination is occupied.
- Trash refuses index flags that can conceal tracked changes and local backups that borrow objects from another repository.
- Moves and archives cannot relocate Laci's own config, cache or recovery data directories.

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
