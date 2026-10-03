# Architecture and compatibility

laci is a Linux desktop application with three layers. `laci-core` reads projects and agent stores and implements filesystem changes. The `laci` binary exposes that engine through Tauri IPC, CLI subcommands and stdio MCP. React owns the interface and talks to typed IPC requests; terminal output uses Tauri channels.

## Snapshot and updates

The scanner discovers project/group folders, enriches projects with git, README, stack, tasks, metadata and history, then creates cleanup proposals and archive plans. Connector readers cache parsed history using file metadata. The snapshot cache is separate from the v1 cache and includes the home/config fingerprint so an isolated demo cannot reuse a real-home scan.

The desktop returns its latest snapshot while one worker handles queued refreshes. Filesystem events are batched for 900 ms. Refresh scopes merge: a full scan subsumes agent and project refreshes. Reads and watch-directory enumeration run outside the engine mutex. A result is installed only if its captured mutation revision is still current; continuous watcher events request one follow-up without rejecting each useful result.

Agent-store updates reread and relink history, retaining git, README, tasks and size when discovery finds the same project graph. A graph change promotes that work to a full scan, reusing the history already loaded. Project events refresh the owning project; task and metadata edits reread their markdown. Nonrecursive filesystem watches are bounded and enumerated again when directory topology, configuration or open listings change. Activity changes notify the Log. Dependency and build directories are excluded.

PTY sessions belong to the Rust process. Each tab has its shell, input writer, resize handle, exit status and bounded output replay. Reattaching after a window reload replays recent output. Closing a tab or exiting the app terminates its shell.

## Shared disk contracts

| Location | Contract |
| --- | --- |
| `~/.config/laci/config.json` | Existing roots, presets, custom connectors, apps and theme; optional archiveDir |
| `<project>/.laci.md` | Existing frontmatter and Summary/Next/Notes sections |
| `~/.local/share/laci/journal/` | v1 move/rewrite/metadata steps and completion state |
| `~/.local/share/laci/backup/` | Original rewritten bytes and timestamps for undo |
| `~/.local/share/laci/activity.jsonl` | Existing Log entries, supersession keys and undo records |
| `~/.local/share/laci/lock` | Cross-process PID lock compatible with v1 |
| `~/.cache/laci/` | Disposable parser/snapshot caches; v2 cache names are separate |

The environment honors `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`. Data retains the v1 location under the home folder. `LACI_HOME` redirects all locations to an isolated home and ignores the caller's XDG overrides.

## Filesystem changes

Project paths are authorized under home and explicitly selected scan/archive folders. Settings canonicalize selected external directories; replacing a selected root or a child with an escaping symlink is refused. Internal connector stores retain their home boundary. Fixed parser/config/scanner regexes initialize once.

Move/archive/Tidy actions validate paths and active processes, acquire a cross-process lock, persist a journal, then execute the steps. Destination collisions and linked write paths are refused. Cross-filesystem copies preserve content and timestamps before removing their source. A failed step rolls completed steps back. Undo restores rewrites before moving folders to their original paths, while refusing collisions with newer data.

Archive preview and execution share the same destination planner. Configured archive folders are scanned automatically. A custom destination outside the current scan roots adds only that project path to config, with the config bytes journaled for Undo. A later settings edit prevents that Undo from overwriting the new config. A move journal can restore a missing selected project root only under its original parent device and inode; ordinary browsing cannot use that exception. Mounted roots themselves are refused as move sources. An external XDG config override authorizes only its exact config.json for journal backup/restoration, without granting project access to adjacent files.

Project removal uses a separate Trash action and preserves external agent history. A live remote ref check is performed only when previewing/removing a selected project, never in background scans. Clean worktree, index flags, refs, stash, worktree topology and process guards are checked again after the remote answers. Only exact advertised branch/tag tips authorize removal, with conservative refusal for unmatched local branches, tags and other non-remote refs. Local backups must use independent object storage. Trash recovery belongs to the system file manager, so the activity entry does not advertise journal Undo. Moves and archives also refuse paths that would relocate Laci's config, cache or recovery data.

Archive Undo restores the saved whole `.laci.md`, so edits made to that file while archived can be replaced. Dependency cleanup uses the system trash; those folders must be recovered there rather than through journal Undo.

Metadata, task, notes and settings changes also share the lock and activity log. Task paths must belong to the selected project. Checkbox changes retain the displayed file, text and occurrence so unrelated line shifts do not target a duplicate. A changed duplicate count or ambiguous legacy record is refused. New task-delete records store the removed bytes, their original position and a fingerprint of the file after deletion. Undo restores them only while that file is unchanged. Activity keys prevent undoing an older edit over a later one. `.laci.md` is excluded through git's local `info/exclude`, preserving repository ignore files.

## Desktop and MCP boundaries

Core mutation execution returns the committed result and its refresh scope. Desktop acknowledgments include a revision and a history-pending flag, and return before expensive refresh work. History-changing actions clear old Tidy proposals and gate further history mutations until a suitable refresh succeeds: one shared history file can affect several projects. Cached startup data has the same guard until the initial scan succeeds, since a crash can leave the cache behind a committed change. Safe metadata edits and navigation remain usable. Scan errors after a commit are warnings, preserving the action's success and Undo. The UI orders busy notices separately from displayed data, so continuous scans do not starve useful snapshots. Mutation notices still fence stale proposals immediately. The UI applies snapshots in revision order, guards duplicate submissions synchronously, and closes dialogs only when their initiating dialog still owns the completion.

The desktop creates one local window and uses Tauri IPC with a local-content policy. Markdown is sanitized. Local README images are scoped to scanned project directories. Commands selected by the interface are allowlisted; script/session arguments must exist in the snapshot and are shell quoted.

`laci mcp` serves the 14 compatible v1 tool names plus `delete_project` over stdio without starting GTK or a window. Read calls reuse a recent snapshot. Move/archive/Trash/Tidy/create calls return a preview until `confirm: true` is supplied. Confirmed destructive operations refresh the scan and use the same engine as the desktop.
