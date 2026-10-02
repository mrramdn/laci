# Architecture and compatibility

laci is a Linux desktop application with three layers. `laci-core` reads projects and agent stores and implements filesystem changes. The `laci` binary exposes that engine through Tauri IPC, CLI subcommands and stdio MCP. React owns the interface and talks to typed IPC requests; terminal output uses Tauri channels.

## Snapshot and updates

The scanner discovers project/group folders, enriches projects with git, README, stack, tasks, metadata and history, then creates cleanup proposals and archive plans. Connector readers cache parsed history using file metadata. The snapshot cache is separate from the v1 cache and includes the home/config fingerprint so an isolated demo cannot reuse a real-home scan.

The desktop returns its latest snapshot while a full scan runs on a worker thread. Nonrecursive filesystem watches are bounded to avoid exhausting Linux watch descriptors. Events are debounced and refresh the owning project; changes to roots, settings or agent stores trigger a full scan. Activity changes notify the Log. Dependency and build directories are excluded.

PTY sessions belong to the Rust process. Each tab has its shell, input writer, resize handle, exit status and bounded output replay. Reattaching after a window reload replays recent output. Closing a tab or exiting the app terminates its shell.

## Shared disk contracts

| Location | Contract |
| --- | --- |
| `~/.config/laci/config.json` | Existing roots, presets, custom connectors, apps and theme |
| `<project>/.laci.md` | Existing frontmatter and Summary/Next/Notes sections |
| `~/.local/share/laci/journal/` | v1 move/rewrite/metadata steps and completion state |
| `~/.local/share/laci/backup/` | Original rewritten bytes and timestamps for undo |
| `~/.local/share/laci/activity.jsonl` | Existing Log entries, supersession keys and undo records |
| `~/.local/share/laci/lock` | Cross-process PID lock compatible with v1 |
| `~/.cache/laci/` | Disposable parser/snapshot caches; v2 cache names are separate |

The environment honors `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`. Data retains the v1 location under the home folder. `LACI_HOME` redirects all locations to an isolated home and ignores the caller's XDG overrides.

## Filesystem changes

Move/archive/Tidy actions validate paths and active processes, acquire a cross-process lock, persist a journal, then execute the steps. Destination collisions and linked write paths are refused. Cross-filesystem copies preserve content and timestamps before removing their source. A failed step rolls completed steps back. Undo restores rewrites before moving folders to their original paths, while refusing collisions with newer data.

Archive Undo restores the saved whole `.laci.md`, so edits made to that file while archived can be replaced. Dependency cleanup uses the system trash; those folders must be recovered there rather than through journal Undo.

Metadata, task, notes and settings changes also share the lock and activity log. Task paths must belong to the selected project. Checkbox changes retain the displayed file, text and occurrence so unrelated line shifts do not target a duplicate. A changed duplicate count or ambiguous legacy record is refused. New task-delete records store the removed bytes, their original position and a fingerprint of the file after deletion. Undo restores them only while that file is unchanged. Activity keys prevent undoing an older edit over a later one. `.laci.md` is excluded through git's local `info/exclude`, preserving repository ignore files.

## Desktop and MCP boundaries

The desktop creates one local window and uses Tauri IPC with a local-content policy. Markdown is sanitized. Local README images are scoped to scanned project directories. Commands selected by the interface are allowlisted; script/session arguments must exist in the snapshot and are shell quoted.

`laci mcp` serves the same 14 tool names as v1 over stdio without starting GTK or a window. Read calls reuse a recent snapshot. Move/archive/Tidy/create calls return a preview until `confirm: true` is supplied. Confirmed destructive operations refresh the scan and use the same engine as the desktop.
