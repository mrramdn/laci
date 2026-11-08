# Changelog

What changed in laci, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

2.0.1, 2.1.0, 2.2.0 and 2.3.0 were released from `main` without git tags or GitHub releases. They are the merges of pull requests #4 (`bf845a1`), #5 (`538da4e`), #6 (`8098403`) and #8 (`66956b2`).

## [3.4.0] - 2026-11-08

### Added

- **Archive a group from Laci.** A folder that holds projects can be archived whole, like a project: it moves into the archive with every project in it and the agent history of each, and its `.laci.md` says `status: archived`, where it came from and when (the file is made when it has none). It is then an archived group, which Restore puts back whole; Undo works for both. The archive plan of a group lists the risky checks of the projects in it (uncommitted, unpushed, no remote, stashes), each naming its project. A scan location, home, and a folder holding the archive folder or the copy of AI chats can't be archived. Folders carry `projectCount`, the projects below them, and those that can be archived `archivePlan`. Agents can do it with `archive_project` and a folder; its preview says how many projects go along.
- **A folder marked archived outside the archive can be restored where it is**, like a project archived by its status only: Restore clears its `status: archived`. It shows with those projects in the Archive view.
- **A group joins its place in the archive when one of its projects went there before.** Archiving one project of a folder alone makes the folder's place in the archive; archiving the folder as a group afterwards moves what it holds into that place, next to the project archived before, instead of refusing because the place exists. The plan says *Join the folder already in the archive (it holds N earlier archived items)* and carries `join: true`. Undo moves back only what the group archive moved, and the project archived before stays archived where it was; Restore puts the whole group back and clears that project's own mark. A place that already holds something by the same name, or that was archived whole, is refused: *&lt;place&gt; already holds &lt;name&gt; from an earlier archive. Choose another place.*
- **The archive plan of a group names a git worktree across its edge.** A repository in the group with a worktree outside it, or a worktree in the group of a repository outside it, gives a check (`worktree`, medium) naming the project: *&lt;project&gt;: a git worktree outside the group (&lt;path&gt;) will need git worktree repair*.
- **`laci settings`** prints the scan locations and the archive, backup and reports folders, and which of them can't be used now. `laci settings archive DIR`, `laci settings copy DIR` (with `--fresh` to start a new backup when the old one can't be reached) and `laci settings reports DIR` change one through the same steps as Settings in the window: the same checks and drive identity, a Log entry by the command line, and Undo. `copy` moves the whole backup, also across drives, as **Change…** does.

### Changed

- **Restoring a group puts back what is archived in it too.** Folders and projects inside an archived group whose `.laci.md` says `status: archived` have it cleared, with `archivedFrom` and `archivedAt`, in the same change, so one Undo brings all of them back. A project or group inside an archived group goes back with the whole group: alone, it is refused (`reason: "inGroup"`, with `group`, the archived group to restore instead) unless you choose a place for it outside the place the group goes back to. That refusal carries no `dest`: the place it came from is the group's.
- **`_archive` folders and an archive folder inside a scan location are looked through deeper**, as the archive folder elsewhere already was: a project keeps the depth it had where it came from. The archive folder adds one level (the name of the scan location), an `_archive` folder one; an `_archive` inside the archive or another `_archive` adds nothing more.
- **The copy of AI chats and the archive folder stay apart.** Settings refuse a folder for the copy that is the archive folder or holds it, and an archive folder that is the copy's folder or inside it; the copy may still be a folder of its own in the archive folder. The rule applies when a folder is chosen: a setup from before it keeps working, backups go on, and saving Settings with the archive folder unchanged is accepted. Undo of a settings change in the Log is refused when the archive folder it would put back is now the copy's folder or inside it. Archiving refuses clearly when the place the archive keeps a scan location's projects (`<archive>/<name>`) is the copy's folder.
- **The moved project's Claude Code memory names its new place.** A move, an archive or a restore rewrites the old path in the project's own memory files (`memory/*.md` in its Claude session folder), written in full or from `~/`, wherever it is a whole path: `~/project/laci` never touches `~/project/laci-old`. The plan shows it as *Update the old path in N memory files*, and so does the Log, apart from *Rewrote the folder path in N log files*; Undo puts each file back byte for byte. Other projects' memory and global files stay as they are.
- **A backup folder on a drive that was taken out is noticed without a rescan.** The scan tells it like a scan location that isn't there (`copyStatus`, with the reason), and the open window reads it again when the drive's mount point goes away or comes back.

### Fixed

- **A project in an archived group inside another is listed under the outer group**, in Detailed's Archive and under Simple's Archived, since that is the group Restore puts back with it; the group inside comes just before what it holds. Simple's heading for that group counts every project it puts back. As the engine no longer names a place for a project it refuses inside an archived group, Detailed's row says *Inside an archived group* rather than *Origin unknown* when the scan doesn't list that group.
- **A folder's heading in Simple counts what Archive group… moves.** When the folder holds more than its cards show (an archived project in it, a folder inside it with a heading of its own, or a filter or search), it says both, as *· 2 of 3 projects*. The names a screen reader gives the heading's buttons start with what they show (*Archive group… clients*, *Restore… the group old-clients*).
- **Simple's sheet for archiving a group says each project's problem in Simple's words**, counted as that project's card counts it, never in Git's, and speaks of the projects in it, not of "this project", also when a warning about one is hidden; a group Laci knows no origin of is called a group.
- **In Detailed's Archive, "Group of N projects" follows a folder's name and place**, for a folder only marked archived and a group inside another as for an archived group, rather than sitting in the middle of the row.
- **Undo of a move of the backup no longer freezes the window.** Like the move itself, it runs beside the window, which stays usable while the backup is copied back across drives; other changes asked for meanwhile are refused at once with *Laci is moving the copy of your AI chats*.

## [3.3.2] - 2026-11-08

Only dependencies change.

### Security

- DOMPurify 3.4.16 -> 3.4.17, which cleans a README and release notes before Laci shows them ([GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7), [GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr), [GHSA-c6gr-qvv4-5v3f](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f)). Each needs an option Laci doesn't use (`SAFE_FOR_TEMPLATES` with DOM output, `IN_PLACE` with a hook, or the XHTML parser), so Laci wasn't open to them.
- rustls-webpki 0.103.15 -> 0.103.16, which checks the certificates of the updater's downloads ([RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html), [RUSTSEC-2026-0383](https://rustsec.org/advisories/RUSTSEC-2026-0383.html)): certificates through the distrusted emSign intermediates were accepted.
- zod 4.6.5 -> 4.6.7 ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)), a build tool only: it checks the settings of a lint rule and is not in Laci.
- minimatch 10.2.6 -> 11.0.5 ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)), a build tool only: the TypeScript linter uses it and it is not in Laci.

## [3.3.1] - 2026-11-08

### Added

- **An archived group goes back whole.** A folder in the archive whose own `.laci.md` says `status: archived` is an archived group: Restore puts the whole folder back where it came from, with every project in it and their agent history, and clears its `status`, `archivedFrom` and `archivedAt`. It gets `restorePlan` like a project; other folders in the archive don't. `restore_project` takes a group by name or path; `list_projects` with `filter: archived` still lists projects only.
- **A link left where a folder was is removed on Restore.** When a project or group was moved into the archive by hand and a link left at its old place that leads to it, Restore removes that link first (a new step, *Remove the old link*, `kind: "unlink"`) and puts the folder there. Only a link that leads exactly to the folder being restored is removed; a link that leads anywhere else is still in the way (`occupied`). The Log says *Removed the old link*, and Undo moves the folder back into the archive and makes the link again, or refuses before changing anything when something else is there since. When the folder was moved somewhere else by hand since, Undo leaves the link out and says so, rather than make a link that leads nowhere.

### Changed

- **The archive folder is looked through one folder deeper** than other scan locations, since its first level is the name of the scan location a project came from: a project keeps the depth it had in `~/project` or `~/study`. `_archive/` folders inside scan locations are looked through as before.
- **A project inside a group that is linked back from the archive can't go back alone.** Its restore says why (`reason: "linked"`, with where it would have gone): the group's link would put it back into the archive. Restore the whole group, or remove that link first; `restore_project` then names the group (`group`, its path in the archive) so an agent can restore it instead. When the folder the link leads to isn't marked `status: archived`, the refusal asks to remove the link or mark that folder, rather than offer a group restore that isn't there.

## [3.3.0] - 2026-11-07

### Added

- **Restore** puts an archived project back where it came from, with its agent history: the folder, Claude's sessions and memory, the paths in agent logs (also of sessions from while it was archived), and `status: archived` cleared. A project archived only by its status is restored where it is. Without a recorded origin, Laci works it out from the archive's layout or the `_archive/` folder it is in, and asks for a place when it can't or something is already there. It shows in the Log with Undo, and agents can do it with the MCP tool `restore_project`.
- **The Archive view** in Detailed shows everything archived in one place; Simple's Projects has an *Archived* section.
- **Archiving records where a project came from**: `archivedFrom` and `archivedAt` in its `.laci.md`, next to `status: archived`. Undo takes them back with the rest. A path `.laci.md` would read back as another one, such as `~/study/Lab #2/demo`, is left out, so the archive's layout decides instead of a wrong place. Restore clears `status` only while it is still `archived`.
- **A restore that can't run says why** (`reason`: `occupied`, `unknown`, `inArchive` or `outside`) and, when Laci knows one, where it would have put the project (`dest`), in `restorePlan`, in `restore/plan` and in `restore_project`'s preview. A project archived only by its status refuses a destination.

### Changed

- **The archive folder keeps the layout of your scan locations.** With an archive folder in Settings, `~/study/course/demo` is archived to `<archive folder>/study/course/demo` instead of `<archive folder>/demo`, so projects with the same name don't collide and Restore knows where they belong. Projects already in the archive stay where they are.
- **A project archived only by its status can be moved into the archive**, in the app and with `archive_project`; a project already in the archive is refused with "Already in the archive".
- **Undo keeps what changed after the change.** Undo of a move, archive, restore or Tidy rewrite now refuses, before changing anything, when a session added lines to a log Laci rewrote or `.laci.md` was edited since, and names the file; it used to put the older bytes back. Changes made before this version undo as before.
- **Undo of a change a later one already reversed is refused** ("undo that instead"), such as an Archive after its Restore, instead of making the archived folder again around a few files. Undo no longer makes a missing folder again to put a file back.
- **An `_archive`-style folder counts only at or below the scan location** that holds a project, so a scan location inside a folder called `archive` is not all archived.

## [3.2.0] - 2026-10-25

### Added

- **Choose which projects the copy of AI chats takes.** Settings › *Which projects to back up* in Detailed, *Which chats* under AI helpers in Simple: every project, as before, or only the projects and groups you tick; a group's box ticks its projects, and a row covers chats started outside every project. A project that appears later isn't copied until you tick it, and Laci says how many folders hold chats that aren't copied. Unticking a project only stops new copies: Laci still never removes a chat from the copy. A project you move or reconnect in Laci stays ticked where it went, and Undo takes that back too. `laci backup` follows the choice and tells projects apart by the last scan the window made.
- **Simple's Projects shows each project under its group**, the folder that holds it, as your folders do: `app/` with the repositories `fe` and `be` is a heading with their two cards under it. Sections fold, and *Group by folder* turns the single list back on.

## [3.1.0] - 2026-10-23

### Added

- **Choose where the copy of AI chats is kept.** Settings › Backup folder in Detailed, *Where Laci keeps the copy* in Simple's AI helpers: any empty folder, also on another drive. Laci moves the copy there in one change, and Undo in the Log moves it back. *Use the default* brings it back to Laci's data folder. Laci never makes a chosen folder: when its drive isn't connected, nothing is copied and Laci says why, and the copy isn't moved; a new copy can start elsewhere instead, leaving the old one on its drive. Undo also takes back what the copy gained since, and other settings changed meanwhile don't stand in its way. A move or its Undo that stops part-way, as when Laci is closed, is finished by the next backup.
- **`laci backup`** makes the same backup without the window and without a scan, so a systemd timer can run it every hour (see the README). It adds to the Log only when it copied or packed something.

### Changed

- **The copy of AI chats is compressed** with zstd, about five times smaller. A copy from before 3.1 is compressed on the first backup: each file Laci packs is checked byte for byte before the plain one goes, and a plain file that already has a newer packed copy is removed. Each file can be unpacked with `zstd -d`, and Laci still never removes a chat from the copy.

### Fixed

- **Temporary files of an interrupted copy are removed** by the next backup, inside the copy only.
- **Backing up no longer freezes the window**: while a backup or a move of the copy runs, also the automatic one, the window keeps drawing and stays up to date. Changes asked for meanwhile are refused with a message until it is done. A backup or move you start shows that it is working.

## [3.0.0] - 2026-10-22

Laci 3.0: Simple, a second design for people new to Git and coding agents, a new mark, and updates the AppImage installs itself after asking.

Laci stays Linux-only: Windows and macOS versions won't be made.

**From Laci 2**, download 3.0 by hand once: Laci 2 can't update itself. If you use the AppImage, replace the old file, then set up the agents that use Laci again (*Fix…* on the Agents page, or *Use this Laci…* in Simple's AI helpers › Tools), since they still start the old file.

### Added

- **Simple, a new design.** The same projects, AI chats, to-dos and Undo, in a calmer layout in the colours of Laci's mark, with plain words: "saved version" for a commit, "upload" for a push, and each Git word named in Help. Its places are Home, Projects, AI helpers, Clean up and Activity, with Settings and Help at the foot of the sidebar.
  - **Home** puts the one project that needs you most on top, with its fix and *Ask Claude Code to do it* (or your own AI), then the others that need you, what's next, what's coming up and where you left off.
  - **A project's page** starts with *Is it safe?*: each problem in plain words, the button that fixes it, and a way to ask your AI to do it.
  - **When your AI is asked to fix something**, its prompt asks it to show each command first, and never to force a push, rewrite history or delete a branch.
  - **Clean up** shows one suggestion at a time and what each will change, with the space Laci itself uses.
  - **Activity** says each change in a plain sentence, such as "Reconnected the AI chats of shop", with *What changed* for the details, *By me* and *By AI* filters, and Undo on each row.
  - **AI helpers** has your chats, the summaries your agents write, and the tools: which AI tools Laci shows, and *Let it use Laci* to set up MCP.
  - **Archive, Delete and Free up space** have their own sheets. Archive is offered before Delete. Delete lists the files only this computer has and asks you to type the project's name before they go. Whatever can't be undone waits 5 seconds, with Cancel.
- **New installs open in Simple.** If you used Laci 2, Detailed stays your design, and a card on Today offers Simple once.
- **Switch designs at any time**: in Settings › Appearance, with the *Simple | Detailed* toggle at the foot of the sidebar, or with Ctrl K. The change shows at once and is saved as `design` in config.json.
- **The first-run screen** welcomes you, says what this computer still needs (such as Git), and ends with two questions: whether Laci may look for new versions once a day, and how it should look.
- **The open-drawer mark.** Laci has a new icon, an open drawer on turmeric, in the sidebar, on the first-run screen, as the window icon and in the packages, with scalable and symbolic versions for the app menu. The app menu and the window title now say "Laci".
- **Updates from inside Laci.** If you allow it, Laci asks GitHub once a day whether there is a new version, and *Check now* in Settings asks at any time. Nothing is downloaded or installed until you click, and a version Laci found is still offered after a restart.
  - The AppImage installs the new version itself: *Install* downloads it, checks Laci's signature and replaces the AppImage, and *Restart* finishes it, closing Laci's terminals and the AI chats running in them. A download without the signature is refused.
  - The deb, the rpm and copies you built get a link to the release page instead.
  - Detailed shows a new version at the foot of the sidebar and in Settings › About & updates, and Ctrl K offers *Check for updates*, *Install update* and *Restart to update*. Simple shows it on Home and in Settings › Updates.
  - A final version of Laci is offered only final versions, never a release candidate.
  - A check shows GitHub your IP address, as any website visit does, and sends nothing about your projects.
- **Laci asks once.** If you used Laci 2, or skipped the first-run screen, a card on Today (Detailed) or Home (Simple) asks whether Laci may look for new versions, with *Check daily* and *Don't check*. Change it later in Settings, or with `"updates": "daily"` or `"off"` in config.json.
- **Secrets stay off the internet.** Before a first commit, a new remote or a push, both designs look for files that look like passwords or keys, such as `.env`, by their names only. *Keep these out* adds them to `.gitignore`, with Undo.
- **Choose…** beside every folder field in Detailed opens the system's folder picker: Settings, the first-run screen, the Archive dialog, New project and a local template.
- **Help** in both designs: how Laci keeps your work safe, the words it uses (with the Git word behind each), and the keyboard shortcuts.

### Changed

- **Laci runs on Ubuntu 22.04 and the systems built on it**, such as Linux Mint 21, Zorin OS 17 and Pop!_OS 22.04, and on Debian 12. The packages are now built on Ubuntu 22.04 and need glibc 2.35; 2.5 needed 2.39.
- **Releases say where they come from.** Each one carries `SHA256SUMS`, `provenance.json` and a build attestation for every file. [Verify a download](https://github.com/mrramdn/laci/blob/main/RELEASING.md#verify-a-download) shows how to check them.
- **Detailed's text is at least 12 px.** Labels, counts, key hints, column heads and paths drew at 10 to 11.5 px. Where the folder list is narrow, such as beside the side panel, it leaves out Stack, then Size, then Summary and Agents, instead of squeezing them.
- **The window can be as small as 720 × 560**, and both designs fit it. In Detailed, from 880 px wide down, a project's details open as a sheet over the list, and filter bars wrap instead of sliding out of view.
- **The first window fits the screen**, also on Wayland, and opens centred.
- **Dates follow the language of your system** instead of always British English.
- **The foot of Detailed's sidebar says "Projects checked"** after a scan of your project folders, instead of "Up to date", which read as if Laci itself were current, and "Couldn't check projects" instead of "Scan failed".
- **Detailed starts faster** and draws less while a scan runs: Markdown loads when a README or report first opens, and each view draws again only when what it shows changes.
- The root of the disk (`/`) can no longer be picked as a folder to scan, since it holds the system and everything else. One you picked in 2.5 stays, and Laci keeps looking through it.
- **MCP:** `tidy_suggestions` answers a page at a time (30 by default) and lists only the first operations of each suggestion. `apply_suggestion` without `confirm` lists all of them, a page at a time: for a group of 500 history files it answered with 330,000 characters.

### Fixed

- **Settings that can't be read are never written over.** If config.json was broken, or a sync app hadn't downloaded it yet, the next save in Settings replaced it with the defaults. Laci now refuses and says what to do.
- **A double click on a report item, or a click on a list that changed meanwhile, closed the next item.** Both designs now name the item by its text, so a repeated click changes nothing and shows no error. Hiding a Tidy suggestion twice no longer ends on an error either.
- **`.laci.md` keeps its fields.** A value with ` --- ` in it, such as `summary: v1 --- v2`, ended the frontmatter early, so the next edit moved the fields after it into the body. A file that starts with a byte order mark got a second frontmatter block.
- **CRLF files stay CRLF.** Editing a `.laci.md` or to-do file with Windows line endings added a second frontmatter block and mixed in LF lines.
- **Automatic history backups run while the window stays open**, also when nothing changes on disk.
- **A move or Undo to another drive checks first that the project can leave its folder.** A source that can't be removed now stops the move before anything is copied. Before, it was copied first, and a half-deleted source beside the copy blocked the rollback and every later Undo.
- **Making a project never waits on a hidden password prompt.** The Git and `gh` that make it ask nothing, so a clone or push that needs a login fails with Git's message instead of waiting unseen until it timed out.
- **A project's summary from its README is its whole first paragraph.** A paragraph wrapped over several lines gave only its first line, and a long one was cut in the middle of a word. Now the lines are joined, and a summary that is too long ends after a whole word with "…".
- **Report items with a list under a label read as one sentence**, such as "Next: the review; the fonts", instead of "Next:; the review;; the fonts".
- **A report about several projects shows each project only its own items** on Today, Simple's Home and in MCP's `open_items`. An item belongs to the project it names, or else to the project its session worked in; the report itself still lists every item.
- **The first open after installing, or after the cache is cleared, is faster and says what it is doing.** Laci reads your AI chat history once at the start, which took minutes on a big history with only "Looking for your projects…" on screen. It now reads several chat files at a time, and the window says which step it is on and how far it has come, such as "120 of 2400 files · 900 MB of 4.4 GB".

### Security

- **The check for programs using a folder is stricter.** Before Laci moves, archives or trashes a folder, it makes sure no program is working in it. A program with a long name in another script, such as Cyrillic, could hide from that check, so the folder could be moved under it. A folder whose name isn't valid UTF-8 made the check fail, which refused every later change until Laci restarted. And when `/proc` can't be read, Laci now refuses the change instead of taking the folder as free.

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
