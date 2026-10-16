# Architecture and compatibility

laci is a Linux desktop application with three layers. `laci-core` reads projects and agent stores and implements filesystem changes. The `laci` binary exposes that engine through Tauri IPC, CLI subcommands and stdio MCP. React owns the interface and talks to typed IPC requests; terminal output uses Tauri channels.

## Snapshot and updates

The scanner discovers project/group folders, enriches projects with git, README, stack, tasks, metadata and history, then creates cleanup proposals and archive plans. Connector readers cache parsed history using file metadata. The snapshot cache is separate from the v1 cache and includes the home/config fingerprint so an isolated demo cannot reuse a real-home scan.

The desktop returns its latest snapshot while one worker handles queued refreshes. Filesystem events are batched for 900 ms. Refresh scopes merge: a full scan subsumes agent, report and project refreshes. Reads and watch-directory enumeration run outside the engine mutex. A result is installed only if its captured mutation revision is still current; continuous watcher events request one follow-up without rejecting each useful result.

Agent-store updates reread and relink history, retaining git, README, tasks and size when discovery finds the same project graph. A graph change promotes that work to a full scan, reusing the history already loaded. Project events refresh the owning project; task and metadata edits reread their markdown. Nonrecursive filesystem watches are bounded and enumerated again when directory topology, configuration or open listings change. Activity changes notify the Log. Dependency and build directories are excluded.

Session reports come from the folder chosen in Settings (`reportsDir`). Every scan and agent pass attaches them after history is linked, because a report reaches projects through the sessions it names. A change in that folder requests a reports-only refresh: the folder is listed again, changed files are parsed again (facts cached by size, mtime, ctime and inode in `reports-v2.json`, which keeps up to 40 open items per report) and every report is linked again, without a project or agent pass. The folder is watched even past the watch budget. A report links to the deepest project containing a path in its header, the folder its session started in, or the latest cwd of a session it names, so a project Laci moved keeps its reports. The snapshot carries the newest 1,000 with their plain-text summary and up to eight open items; the text is read on request. Open items the user closed are kept in Laci's data folder, keyed by report file name and a hash of the item's text. They are left out of a report's open items and counts, so an item stays closed while its text is unchanged and opens again when the report rewords it.

PTY sessions belong to the Rust process. Each tab has its shell, input writer, resize handle, exit status and bounded output replay. Reattaching after a window reload replays recent output. Closing a tab or exiting the app terminates its shell.

## Shared disk contracts

| Location | Contract |
| --- | --- |
| `~/.config/laci/config.json` | Existing roots, presets, custom connectors, apps and theme; optional archiveDir and reportsDir |
| The `reportsDir` folder | Read only: plain `*.md` files directly in it, except `README.md` and dotfiles |
| `<project>/.laci.md` | Existing frontmatter and Summary/Next/Notes sections |
| `~/.local/share/laci/journal/` | v1 move/rewrite/metadata steps and completion state |
| `~/.local/share/laci/backup/` | Original rewritten bytes and timestamps for undo |
| `~/.local/share/laci/activity.jsonl` | Existing Log entries, supersession keys and undo records |
| `~/.local/share/laci/report-items.json` | Report items closed in Laci: report file name → item key → state (done, dropped, moved), time, actor, note and text |
| `~/.local/share/laci/mcp-backups/` | Copy of an agent's settings file, taken before Laci changes its MCP setup |
| `~/.local/share/laci/lock` | Cross-process PID lock compatible with v1 |
| `~/.cache/laci/` | Disposable parser/snapshot caches, including `reports-v2.json`; v2 cache names are separate |

The environment honors `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`. Data retains the v1 location under the home folder. `LACI_HOME` redirects all locations to an isolated home and ignores the caller's XDG overrides.

## Filesystem changes

Project paths are authorized under home and explicitly selected scan/archive folders. Settings canonicalize selected external directories; replacing a selected root or a child with an escaping symlink is refused. Internal connector stores retain their home boundary. The reports folder is selected and canonicalized the same way but grants no project access; home, its ancestors and Laci's own folders are refused. Each read checks again that neither the folder nor its path became a link, opens the file without following a link, and accepts only a report listed in the snapshot. Fixed parser/config/scanner regexes initialize once.

Move/archive/Tidy actions validate paths and active processes, acquire a cross-process lock, persist a journal, then execute the steps. Destination collisions and linked write paths are refused. Cross-filesystem copies preserve content and timestamps before removing their source. A failed step rolls completed steps back. Undo restores rewrites before moving folders to their original paths, while refusing collisions with newer data.

Archive preview and execution share the same destination planner. Configured archive folders are scanned automatically. A custom destination outside the current scan roots adds only that project path to config, with the config bytes journaled for Undo. A later settings edit prevents that Undo from overwriting the new config. A move journal can restore a missing selected project root only under its original parent device and inode; ordinary browsing cannot use that exception. Mounted roots themselves are refused as move sources. An external XDG config override authorizes only its exact config.json for journal backup/restoration, without granting project access to adjacent files.

Every selected root containing an archive destination, including a nested or standalone archive folder, is checked against its saved device/inode at preview and again under the mutation lock. Ordinary Settings saves preserve that identity; clearing, saving and reselecting explicitly accepts a replacement. Legacy selections without identity remain compatible.

Project removal uses a separate Trash action and preserves external agent history. A live remote ref check is performed only when previewing/removing a selected project, never in background scans. Clean worktree, index flags, refs, stash, worktree topology and process guards are checked again after the remote answers. Only exact advertised branch/tag tips authorize removal, with conservative refusal for unmatched local branches, tags and other non-remote refs. Local backups must use independent object storage. Trash recovery belongs to the system file manager, so the activity entry does not advertise journal Undo. Moves and archives also refuse paths that would relocate Laci's config, cache or recovery data.

Archive Undo restores the saved whole `.laci.md`, so edits made to that file while archived can be replaced. Dependency cleanup uses the system trash; those folders must be recovered there rather than through journal Undo.

Metadata, task, notes and settings changes also share the lock and activity log. Task paths must belong to the selected project. Checkbox changes retain the displayed file, text and occurrence so unrelated line shifts do not target a duplicate. A changed duplicate count or ambiguous legacy record is refused. New task-delete records store the removed bytes, their original position and a fingerprint of the file after deletion. Undo restores them only while that file is unchanged. Activity keys prevent undoing an older edit over a later one. `.laci.md` is excluded through git's local `info/exclude`, preserving repository ignore files.

## Desktop and MCP boundaries

Core mutation execution returns the committed result and its refresh scope. Desktop acknowledgments include a revision and a history-pending flag, and return before expensive refresh work. History-changing actions clear old Tidy proposals and gate further history mutations until a suitable refresh succeeds: one shared history file can affect several projects. Cached startup data has the same guard until the initial scan succeeds, since a crash can leave the cache behind a committed change. Safe metadata edits and navigation remain usable. Scan errors after a commit are warnings, preserving the action's success and Undo. The UI orders busy notices separately from displayed data, so continuous scans do not starve useful snapshots. Mutation notices still fence stale proposals immediately. The UI applies snapshots in revision order, guards duplicate submissions synchronously, and closes dialogs only when their initiating dialog still owns the completion.

The desktop creates one local window and uses Tauri IPC with a local-content policy. Markdown is sanitized. Local images are scoped to scanned project directories and the reports folder. Report reads, searches and opens run outside the engine lock. Commands selected by the interface are allowlisted; script/session arguments must exist in the snapshot and are shell quoted.

`laci mcp` serves the 14 compatible v1 tool names plus `delete_project`, the read-only `list_reports` and `open_items`, the to-do edits `edit_task`, `delete_task` and `move_task`, and `close_report_item`, over stdio without starting GTK or a window. It also offers two prompts, `review` and `work_on`; the desktop gets the same text from `assistant/prompt` for its *Review with an agent* and *Work on it* buttons. Lists and answers to changes carry compact projects (status, meta, checks, to-dos) and never the snapshot a change returns to the desktop. The read tools answer a page at a time (`limit`, `offset`, `total`, `more`) and are shaped in `mcp.rs` after the core call, so the desktop's view of the same data, such as the Log with its undo data, is unchanged. Read calls reuse a recent snapshot. Move/archive/Trash/Tidy/create/undo calls return a preview until `confirm: true` is supplied. Arguments a tool does not list are rejected. Confirmed destructive operations refresh the scan and use the same engine as the desktop.

## Providers and MCP setup

`providers.rs` holds one description per agent Laci can start: its program, argument templates, models, effort levels and MCP settings. The built-ins are Claude Code, Codex and Antigravity. The user's own tools from `config.json` are read beside them.

`mcp_setup.rs` tells whether an agent knows Laci's MCP server, and adds or removes it. Reading is passive. A change runs the agent's own command, or edits its JSON settings file after copying that file to the backup folder.

## Session launch and creation

Sessions normalize provider, UUID, title provenance, cwd, parent, source kind, update time and resume capability separately from the store/file identity. Codex metadata uses session/turn cwd, not tool-call paths. Title-index changes invalidate the title cache. Antigravity's shared last-conversation index is read-only and excluded from relocation and cleanup plans.

Session logs are read in one pass from start to end, and the pass is resumable: its state (offset, inode, a hash of the 256 bytes before the offset, the head-window counters, changed files) is cached with the facts. A log that only grew is read from the offset; a rewritten or replaced one is read again from the start. A half-written last line is left for the next pass. Ownership is still decided by the head window alone, 8 MiB and 20,000 records: lines past it update display and resume metadata only, and a log longer than the window never proves cleanup ownership. Latest cwd is separate from the complete owning-cwd set. Parse/read/traversal failures mark ownership incomplete, including Claude folder aggregates. The same pass collects what a session was about (prompts, files changed, first and last prompt, last reply, model, time spent, pull requests, the session a resume stub continued in); `READER` in `agents.rs` and the cache file name are advanced when those facts change.

While an agent is working its log changes every second; the desktop reads agent history at most every 15 seconds for such changes (`AGENT_SETTLE`). A new or removed log is read at once.

Deleting sessions (`session/delete`) is a journaled move into `orphans/sessions/<journal>/` of the data folder: the log, Claude Code's folder of subagent logs, and Laci's backup copy, which would otherwise list the session again as backup-only. Undo moves them back. `storage/free` empties that quarantine for good and marks the journals that needed it, so the Log stops offering their Undo. Kept sessions live in `sessions.json` in the data folder, keyed by agent and session id.

The launch resolver (`launch.rs`) accepts a provider, optional session ID, project path, prompt, model, effort and terminal target. It builds each command from the provider's description: one argument per template element, and no shell. IPC resolves session membership from the snapshot and verifies an active connector. Internal PTYs receive executable/argv/cwd directly; external terminals use the same resolved arguments with quoted transport boundaries. Explicit model discovery is cached and does not start a conversation. Unsupported overrides fail without silently selecting another model or provider.

Desktop creation jobs run outside the snapshot mutex. They serialize filesystem creation through the existing process lock, bound output in memory, and fence mutations and stale snapshots from start through completion, failure or cancellation. Generator cancellation signals only its owned process group and reaps it before shutdown. Failed scaffolds stay on disk. Metadata, Git initialization and optional agent launch follow successful generation. Retrying a failed agent launch never repeats creation or remote operations.

Rust retains the submitted request and continuation in process memory until explicit acknowledgement. Startup restores the undismissed job after a WebView reload. Continuation claims are atomic and return cached results; explicit retries must match the failed attempt and always use the created project's path. A new creation cannot discard an undismissed job. No request or prompt is persisted for app-restart recovery.

Fresh configuration has no roots or connectors. Explicit empty roots survive save and Undo. Root identity records distinguish missing project paths from unavailable/replaced selected roots. Orphan proposals capture source fingerprints; applying one rechecks the proposal, confirmed project absence, protected paths, symlinks and active writers under the mutation lock. Quarantine remains the compatible default; Trash requires an explicit recovery choice and does not advertise Laci Undo.
