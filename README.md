# laci

A desktop file manager for your projects folder that knows what's inside each project: git state, README summary, stack, and the agent sessions (Claude Code, Codex) that worked in it. When you move or archive a project, its agent history and memory move with it.

Linux first. Needs git; `pnpm install` brings Electron. The CLI commands and `pnpm web` also need Node 23.6+.

## Run

```sh
pnpm install     # Electron, node-pty (built locally), xterm.js
pnpm start       # desktop app: scans, then opens the window. Electron's own Node runs the server, no system Node needed
pnpm web         # same UI in your browser instead (needs Node 23.6+)
```

The terminal panel (F4 or Ctrl+`) runs a real shell per tab, in the project's folder. Resume session, scripts and fix buttons open there. Fix commands are typed but only run when you press Enter.

Other commands:

```sh
pnpm ls          # table of every project, newest first
pnpm doctor      # what could lose work, open checkboxes, tidy-up suggestions
pnpm proto       # read-only HTML snapshot at prototype/dist/index.html
pnpm test        # move engine + API security tests (throwaway HOME)
sh scripts/install-desktop.sh   # optional: add laci to your app launcher
```

Settings via env: `LACI_PORT` (4747), `LACI_TERMINAL` (kitty; konsole also works), `LACI_EDITOR` (code), `LACI_FILES` (dolphin).

## What it reads

- Folders under `~/project`, `~/tugas`, `~/Documents`, `~/Desktop`, `~/Downloads` (and `~/code`, `~/dev`, `~/src`, `~/repos`, `~/work` if they exist). A folder is a project when it has `.git` or a build file; a folder of projects is a group.
- `~/.claude/projects`, `~/.claude/plans`, `~/.codex/sessions`, and `.serena/` inside projects.
- Scanning is read-only. `git status` runs with `GIT_OPTIONAL_LOCKS=0` so it never touches the index.

## What it writes, and only when you click

| Action | Writes |
| --- | --- |
| Status, priority, deadline, next steps, notes | `.laci.md` in the project folder, added to `.git/info/exclude` so it never gets committed |
| Tick a checkbox | that line in the file it came from (e.g. `NOTES.md`) |
| Archive, reconnect, finish a half-done move | moves folders, renames `~/.claude/projects/<dir>`, rewrites `"cwd"` fields in Claude/Codex logs |
| Free space | sends `node_modules`, `.next`, etc. to the system trash |
| Back up logs | copies agent logs to `~/.local/share/laci/history` |

Every move/rewrite is recorded in `~/.local/share/laci/journal/` before it happens, with the original files kept in `~/.local/share/laci/backup/`. **Undo** (in Tidy up, or the toast after a change) restores them byte for byte. A folder that a running process has open (a `claude` session, a dev server) is refused until you close it.

`.laci.md` looks like this:

```markdown
---
status: active
priority: high
deadline: 2026-10-15
---

## Summary
One or two sentences about the project (overrides the README tagline).

## Next
- [ ] Ship the pricing section

## Notes
Client wants dark mode.
```

## Layout

```
src/core/      scanner, parsers, health checks, tidy-up suggestions, move engine
src/cli.ts     terminal commands
src/server.ts  local API for the UI (127.0.0.1 only, per-launch token)
src/term.ts    terminal sessions (node-pty), streamed to the UI
electron/      desktop window; starts the server with Electron's Node
prototype/     the UI (single HTML file)
test/          move engine and API security tests
```
