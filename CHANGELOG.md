# Changelog

What changed in laci, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

2.0.1, 2.1.0, 2.2.0 and 2.3.0 were released from `main` without git tags or GitHub releases. They are the merges of pull requests #4 (`bf845a1`), #5 (`538da4e`), #6 (`8098403`) and #8 (`66956b2`).

## [Unreleased]

Laci stays Linux-only: Windows and macOS versions won't be made.

### Changed

- The root of the disk (`/`) can no longer be picked as a folder to scan, since it holds the system and everything else. One you picked in 2.5 stays, and Laci keeps looking through it.

## [2.5.2] - 2026-10-20

A security update for anyone who opens projects they didn't make themselves.

### Security

- Laci gives the programs it runs the names it reads from a project, such as Git tags, remotes and branches, always as names, never as options. Before, a project whose Git repository had a tag named like an option could make Laci overwrite a file when you selected that project ([GHSA-89vm-5q33-fffw](https://github.com/mrramdn/laci/security/advisories/GHSA-89vm-5q33-fffw)).

### Changed

- A package script whose name begins with a dash is no longer started from Laci; run it from a terminal.

## [2.5.1] - 2026-10-16

MCP answers an agent can read in full, and an archive that no longer trips over Laci's own Git.

### Fixed

- **MCP answers fit an agent's context.** On a busy home `recent_changes` answered with 404,000 characters, more than Claude Code accepts, and `project_details` (up to 178,000) and `open_items` (52,000) were cut off or saved to a file. On the same home they are now 12,500, 20,000 and 15,000.
  - The list tools answer a page at a time. `limit` sets the size of a page, the answer says `total` and `more`, and `offset` gives the next page. `list_projects`, `needs_attention` and `recent_changes` give 30 at a time, `open_items` 50 and `list_reports` 10.
  - `recent_changes` leaves out the undo data, where a notes change kept the whole previous notes. Long details are cut to 300 characters, and a long list of steps to its first five. It narrows by `project` (also finding a project's moves, archives and closed report items), words (`query`) or `undoable`, so an agent can find the id `undo_change` needs. It searches the newest 300 Log entries, fewer when they are long, and says how many in `searched`.
  - `project_details` gives the first 2,000 characters of the README, and the newest 10 conversations and agent items with a count of all, without their prompts and replies. Subagent logs no longer count as conversations. Claude history folders come without their per-session lists. Notes stay whole.
  - `open_items` names each report's title, date, file and projects once, in `reports`, instead of on every item.
  - `needs_attention` counts each project's open to-dos instead of listing them (they are in `open_items`) and lists the worst problems first. A check you muted is listed but not counted, as in the app.
  - Answers to changes leave out the project's notes, except the answer to `write_notes`. Answers are compact JSON.
- `close_report_item` takes the item number that `open_items` gives, as a string. The number 0 is refused; it used to be taken as words and could close another item.
- **Archive, move and Move to Trash no longer fail during a background scan** with "In use by git" (Move to Trash: "This project is in use by a running process"). Laci's own Git, which scans run inside each project, no longer counts as using the folder, and neither does a process that is gone a moment later. Git that another program runs there, such as the desktop app's scan while an agent archives through the MCP server, gets up to 3 seconds to finish. A shell, an editor or any other program that stays still blocks the change, and Move to Trash now names it, as archive and move do. Move to Trash waits for that Git before it checks the backup again, so nothing that Git wrote goes to the Trash unchecked.
- **The desktop check "custom archive accepted" no longer fails now and then.** CI's new diagnostics showed the archive itself went through: the test typed its destination while a scan re-rendered the dialog, so the path it typed was added to the default one. It now waits for scans before typing and checks the field. A failing desktop check now leaves a screenshot, the page text, the app status and the end of the log in CI.

### Changed

- `list_projects` answers with `projects`, `total`, `offset` and `more` instead of a bare list.
- `delete_task`, `edit_task`, `move_task` and `write_notes` are marked as destructive for MCP clients: they delete or overwrite, even with Undo in the Log.

## [2.5.0] - 2026-10-15

An agent that goes through everything open with you, and to-dos you can hand to one.

### Added

- **Review with an agent.** A button on Today starts Claude Code, Codex or Antigravity in the built-in terminal with a brief. The agent reads everything open through Laci's MCP server, checks what is already done, and proposes what to tick, delete, split or move. It agrees with you on three to five things for the week, and makes the agreed changes through Laci, so they show in the Log with Undo. The same brief is the MCP prompt `review`.
- **Work on it.** Every open to-do, on Today and in a project's To-do tab, can start an agent in the project's folder. Its first prompt holds the to-do, where it is listed, and the project's newest reports. The MCP prompt `work_on` gives the same text.
- **Close report items.** Close an open item of a report as done or dropped, from Today's report line or from the report's *Open items* in Reports, and open it again later. Laci keeps this in its own data and never changes the report file. Closed items leave Today and the counts, and the Log can undo each one.
- **MCP tools for tidying up:**
  - `open_items` lists every open to-do and report item, the most pressing projects first.
  - `edit_task` rewrites a to-do.
  - `delete_task` deletes a to-do from `.laci.md`.
  - `move_task` moves a to-do to another project.
  - `close_report_item` closes a report item or opens it again.

  Each change is in the Log with Undo.

### Changed

- **Smaller MCP answers.** `list_projects` and `needs_attention` give each project's status, priority, deadline, checks and to-dos. They no longer include its README, stack, archive plan and session lists; `project_details` still has them. A change answers with the changed project instead of the whole scan; creating a project used to answer with the entire scan.
- **Commits no remote has** count as not pushed, also on a branch without an upstream. The fix button then pushes with `-u`.
- **Deleted files** are named in the uncommitted-changes check.
- `laci doctor` prints each project on a line of its own above its checks and to-dos.

### Fixed

- A heading such as "Open questions" no longer makes the items under it count as to-dos.

## [2.4.1] - 2026-10-14

### Fixed

- **Shortened paths in reports.** A report header that names `~/project/personal/{raster, ledger}` links to both projects. It used to link to neither.
- **Code blocks inside code blocks.** A fenced block ends only at a fence of the same character and at least its length, as in Markdown. Headings, to-dos and checkboxes shown inside a longer fence are no longer taken for real ones, and a line with backticks at both ends no longer opens a fence. README sections also skip `~~~` fences now.

## [2.4.0] - 2026-10-14

Reports your agents write, next to their sessions and projects.

### Added

- **Reports.** Choose the folder your agents write session reports to, and Reports lists them, newest first, beside the one you read. Search covers titles, summaries and projects at once, and the full text a moment later. A long report gets a row of its sections. Laci only reads the folder.
- **Reports know their sessions and projects.** A report names them in its header, by path or by session id, and keeps the link when Laci moves a project. Session rows and the session dialog open their report, a project's Agents tab lists its newest reports, and Today shows the first item its latest report left open.
- **Copy agent instruction.** Settings copies the rule that makes Claude Code, Codex or another agent write these reports, with the folder filled in. The format is in the README.
- **Agents read reports too.** The MCP tool `list_reports` lists and searches them, and `project_details` includes a project's newest three, each with the file to read.
- The sidebar counts reports added since you last opened Reports, and the palette finds reports.

### Changed

- Rendered Markdown, in READMEs and reports, sets lists, quotes and rules apart more clearly.
- `laci doctor` says when the reports folder can't be read.

## [2.3.2] - 2026-10-11

### Fixed

- **The MCP server works with Claude Code 2.1.296.** Laci offered MCP protocol 2026-07-28, but its tool list lacked the caching hints that version requires (`ttlMs` and `cacheScope`), so Claude Code 2.1.296 and other clients on that version rejected Laci's tools and `claude mcp get` showed "tools fetch failed". rmcp 3.5.1, the MCP library Laci is built on, now fills them in.

## [2.3.1] - 2026-10-09

### Fixed

- **Freeing build output frees space.** "Delete build output…", Tidy up's *Free space* and the archive option delete dependencies and build output for good instead of moving them to the Trash, which kept the space taken while the Trash is on the same disk. They come back with the next install or build. A build folder that is a link to another disk is left alone.

## [2.3.0] - 2026-10-09

Sessions you can sort out, and fewer false alarms.

### Added

- **Sessions as conversations.** The session list counts and shows conversations: subagent logs and the stubs `/resume` leaves fold into the conversation they belong to. Sessions are grouped by project, newest first, with chats outside projects in one closed group, and chats of a couple of prompts that changed no file fold into one row.
- **What a session was about.** Each row says how many prompts it had, how many files it changed, the time spent in it, its size and its pull requests. Its details show the first and last prompt and the agent's last reply. Untitled sessions take their first prompt as title.
- **Delete and keep sessions.** Select sessions and delete them: they move, with their subagent logs and Laci's backup copy, to Laci's quarantine, and Undo in the Log puts them back. Kept sessions are never offered for cleanup. Filters for short chats, older than 30 days, outside projects, kept and backup-only sessions.
- **Laci's own storage.** Storage and cleanup lists what Laci keeps itself and frees the quarantine, undo copies of moves older than a week, and files left by Laci 1.
- **Mute a check** for one project from its Health tab. Muted checks are listed there and counted nowhere else.
- **Dismiss a Tidy up suggestion** for 90 days, and ask for it again.
- **Move build output to Trash** from a project's size line.
- **Search** sessions and to-dos from the palette, and the Log by text, with a *Can undo* filter.
- **Places at half-screen width.** The folder tree opens from a button on the icon rail.

### Changed

- **Diverged branches.** A branch that is both ahead and behind is one *Diverged* check, listed under Could lose work, without Push or Pull.
- **Archive suggestions** skip projects with uncommitted, unpushed, diverged or stashed work.
- **Less work while an agent runs.** A session log that only grew is read from where the last read stopped, and agent history is read at most every 15 seconds while a log keeps changing.
- Sidebar badges say what they count; archive suggestions say why on their row; a project lists every remote.

### Fixed

- **Author count.** A project's "authors" counts people, not spellings: commits under several names with one address, or made through GitHub with its `noreply` address, count as one person.
- A checkbox with nothing to do in it, such as `- [ ] —`, is no longer a to-do.
- Framework starter READMEs (NestJS, Vue, Svelte, Laravel, Expo, Nuxt) no longer give a project its summary.
- Clicking a session row always opens its details; its columns line up from row to row.
- Settings says an agent has no history yet instead of "not found" when only its history folder is missing. Browse column headers share one style.

## [2.2.0] - 2026-10-08

Laci works with any agent, not only Claude Code.

### Added

- **Provider registry.** Each agent Laci can start is described by its program, how its arguments are built, its models and effort levels, and where it keeps its MCP servers. Claude Code, Codex and Antigravity are built in.
- **Your own agents.** A tool described in `config.json`, or in "Add another AI tool" under "Something else", can be started from Laci like the built-in ones. Only a command name is needed. A history store is optional.
- **MCP setup in the app.** Each agent card on the Agents page shows whether Laci's MCP server is set up. "Set up…" shows the exact command or JSON first, then applies it. Laci keeps a copy of the agent's settings file in `~/.local/share/laci/mcp-backups/` before a change, and writes the change to the Log.
- **Continue the last conversation.** The Start dialog offers this for agents that support it: Claude Code, Codex, Antigravity, and your own tools when described.
- **Antigravity effort levels.** Low, medium, high, xhigh and max can be chosen, also with the default model.
- **Sessions only the backup holds.** A session its tool has deleted is listed from Laci's backup, marked "In backup only". Restore puts it back where the tool keeps it. Works for Claude Code and Codex sessions.

### Changed

- The "deletes session logs after N days" warning comes from each agent's description, not only Claude Code. The backup status counts sessions from every connected history store.
- When an agent cannot list its models, the Start dialog shows the agent's own reason, such as a request to sign in first.
- On the Agents page the built-in agents come first, then your own tools.
- Gemini CLI stays a history-only connector. Google replaced it with Antigravity CLI for personal accounts in June 2026, so the agent Laci starts is Antigravity. Old Gemini CLI logs can still be read.

## [2.1.0] - 2026-10-08

Today, Health, backup and agent management, reworked after the 2.0.0 audit.

### Added

- **Deadlines on Today.** Overdue projects and the next 14 days, soonest first, with priority. The Today badge in the sidebar counts overdue and due-today projects.
- **Priority and deadline everywhere.** In Today rows, the Browse name column and the palette. Browse can sort by priority or deadline and filter on "Has deadline" and "High priority".
- **Health tab details.** Each check lists what stands behind its number: the changed files, the commits not pushed, the stashes. New Release line (declared version, last tag, commits since) and Recent commits. The commit chart spans the project's real age instead of a fixed 26 weeks.
- **Backup you can see.** A backup is logged, Today shows when it last ran and how many sessions it keeps, and **Open backup folder** opens it. The retention warning goes away while the backup is current. Optional automatic backup, at most hourly.
- **Agents page.** One card per agent with connected and installed state, sessions, the model and effort it starts with, and **Start…**. One searchable session list replaces five separate lists. Storage and cleanup moved into its own collapsed section.
- **Start agent** button on a project's Agents tab.
- F6 and Shift+F6 move between the sidebar, the list, the details panel and the terminal.

### Changed

- "Could lose work" lists each project once, with every issue as a chip. Clicking a row highlights only that row.
- Each Today list opens the matching tab: a risk opens Health, a recent project opens Agents (or To-do), a deadline opens To-do.
- The start dialog has Claude Code's models and efforts ready when it opens (Fable, Opus, Sonnet and Haiku, effort up to max), remembers the last model and effort per agent, and allows an effort with the default model. Codex and Antigravity are still asked for their models only when you press **Load models**.
- At half-screen widths the sidebar becomes an icon rail and the details panel sits beside the list instead of covering it.
- The folder tree is one Tab stop; arrow keys move inside it.
- "Agent history" is now "Agents". "Add a connector" is "Add another AI tool", with known tools first and the technical form under "Something else".

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
