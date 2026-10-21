export type Severity = "high" | "med" | "low";

export interface Issue {
  code: string;
  severity: Severity;
  title: string;
  detail?: string;
  /** The user muted this check for the project (`quiet` in its .laci.md). Listed, never counted. */
  muted?: boolean;
}

/** A to-do found in a file. `check` = `- [ ]` checkbox, `list` = item under a TODO/Next heading. */
export interface Task {
  text: string;
  done: boolean;
  kind: "check" | "list";
  file: string;
  line: number;
  section?: string;
}

export interface TaskFile {
  file: string;
  at: string;
  open: number;
  done: number;
}

/** User-owned fields from `.laci.md` frontmatter. */
export interface Meta {
  status?: string;
  priority?: string;
  deadline?: string;
  client?: string;
  tags?: string[];
  /** Muted check codes, comma separated. */
  quiet?: string;
}

export interface Remote {
  name: string;
  url: string;
  web?: string;
  host?: string;
}

export interface GitInfo {
  rootCommit?: string;
  firstCommitAt?: string;
  lastCommitAt?: string;
  lastSubject?: string;
  commits: number;
  branch?: string;
  remotes: Remote[];
  upstream?: string;
  dirty: number;
  ahead: number;
  behind: number;
  stashes: number;
  /** Commits per week for the last 26 weeks, oldest first. */
  weekly: number[];
  authors: number;
  worktree: boolean;
}

export interface ReadmeInfo {
  file: string;
  title?: string;
  weakTitle: boolean;
  tagline?: string;
  template: boolean;
  links: { label: string; url: string }[];
  sections: string[];
  images: number;
  raw: string;
}

export interface StackInfo {
  labels: string[];
  languages: { name: string; files: number }[];
  packageManager?: string;
  scripts: { name: string; cmd: string }[];
  services: string[];
  env: string[];
  deploy: string[];
  ci: string[];
}

export interface ClaudeSession {
  id: string;
  title?: string;
  at: string;
  cwd?: string;
  branch?: string;
  bytes: number;
}

export interface ClaudeDir {
  name: string;
  dir: string;
  /** Folder this session dir belongs to, resolved from its encoded name. Undefined = orphan. */
  path?: string;
  sessions: ClaudeSession[];
  subagentLogs: number;
  memory: string[];
  bytes: number;
  /** cwd value -> number of lines that carry it, across every log in the dir. */
  cwds: Record<string, number>;
  /** cwd values that no longer exist on disk (left behind by a move or a delete). */
  gone: string[];
  availability?: "missing" | "unavailable";
}

export interface Session {
  /** Set by the engine; names the entry in requests such as `backup/restore`. */
  id?: string;
  connector?: string;
  provider: string;
  sessionId: string;
  title: string;
  titleSource: string;
  cwd?: string | null;
  parentId?: string | null;
  sourceKind: string;
  updatedAt: string;
  resumeCapability: "supported" | "history-only";
  file: string;
  /** The tool deleted this session; `file` is the copy in Laci's backup. */
  backup?: boolean;
  /** Where a restore puts the copy back. */
  restoreTo?: string;
  /** Log size in bytes. */
  bytes?: number;
  /** "unsupported" for entries that share one file with others and can't be removed alone. */
  cleanupCapability?: string;
  /** The user keeps it: cleanup never offers or deletes it. */
  kept?: boolean;
  // What the log tells about the conversation (Claude Code and Codex).
  /** Messages the user typed. */
  prompts?: number;
  filesChanged?: number;
  firstPrompt?: string;
  lastPrompt?: string;
  lastReply?: string;
  startedAt?: string;
  endedAt?: string;
  /** Time between its records, leaving out pauses of more than half an hour. */
  activeSeconds?: number;
  model?: string;
  prs?: { number: number | string; url: string }[];
  /** Claude Code left this stub when the conversation was resumed under this other session id. */
  continuedIn?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

/** One part of what Laci keeps on disk itself (`storage`). */
export interface StoragePart {
  id: "removed" | "undo" | "history" | "legacy" | "journal" | "cache";
  label: string;
  about: string;
  bytes: number;
  /** How much `storage/free` would free now; 0 when this part is not freed from Laci. */
  free: number;
}
export interface Storage {
  parts: StoragePart[];
  total: number;
  dir: string;
}

/** How a connector finds the project a piece of agent history belongs to. */
export type Link =
  /** Log files anywhere under `dir`; a JSON field in each (`cwd`) holds the project folder. */
  | { kind: "cwd"; dir: string; ext: string; field: string }
  /** One folder per project under `dir`, named after the project path. */
  | { kind: "named"; dir: string; naming: "dashes" | "sha256" }
  /** Lives inside the project folder itself, at `path`. Travels with the folder for free. */
  | { kind: "inside"; path: string }
  /** Files under `dir` that mention project paths in their text (plans, notes). */
  | { kind: "mentions"; dir: string; ext: string }
  /** A tool Laci only starts: it keeps no history Laci reads. */
  | { kind: "none" };

/** How a tool the user described is started. Each list is one argument per element. */
export interface AgentSpec {
  command: string;
  /** Holds `{prompt}` where the first prompt goes. */
  prompt?: string[];
  /** Picks up the tool's most recent conversation in the folder. */
  continue?: string[];
  cwd?: string[];
  model?: string[];
  models?: { id: string; label?: string }[];
  effort?: string[];
  efforts?: string[];
  mcp?: { file: string; key: string; add?: string[]; remove?: string[] };
}

export interface ConnectorSpec {
  id: string;
  name: string;
  link: Link;
}

/** A connector as the app shows it: what it reads, whether it's on, and what it found. */
export interface ConnectorState extends ConnectorSpec {
  provider?: string;
  capabilities?: {
    launch: boolean;
    resume: boolean;
    titles: boolean;
    modelDiscovery: string;
    /** Can pick up its most recent conversation in a folder. */
    continue?: boolean;
    /** Keeps MCP servers Laci can register itself with. */
    mcp?: boolean;
  };
  /** The program that starts it, when Laci can start it. */
  command?: string;
  /** Present on a tool the user described as startable. */
  agent?: AgentSpec;
  /** From laci's catalog, as opposed to one the user described. */
  builtin: boolean;
  /** One line on what it keeps, for the card. */
  about: string;
  /** What a move or archive does with it. */
  moves: string;
  where: string;
  present: boolean;
  bytes: number;
  count: number;
}

/** A catalog connector the user hasn't added, and whether this PC has data for it. */
export interface Suggestion {
  id: string;
  name: string;
  about: string;
  where: string;
  found: boolean;
  /** Laci can start it once it is connected. */
  launch?: boolean;
  /** e.g. "12 MB" or "in 3 projects", when found. */
  detail?: string;
}

/** One piece of agent history a connector found: a log file, or a project's folder in the tool's store. */
export interface Item {
  id: string;
  connector: string;
  file: string;
  at: string;
  bytes: number;
  /** Project folder it belongs to, when the connector can tell. */
  cwd?: string;
  /** Lines that record `cwd` (what a move rewrites). */
  lines: number;
  title?: string;
  availability?: "missing" | "unavailable";
}

export interface Agents {
  claude: string[];
  /** Ids into `Snapshot.items`, from every other connector. */
  items: string[];
  aiFiles: string[];
}

export interface Size {
  total: number;
  reclaimable: number;
  parts: { path: string; bytes: number }[];
}

export interface Op {
  kind: "move" | "rename" | "rewrite" | "delete" | "write" | "git" | "keep";
  label: string;
  from?: string;
  to?: string;
  detail?: string;
}

export interface ArchivePlan {
  dest: string;
  error?: string;
  checks: Issue[];
  ops: Op[];
}

export interface DeletePlan {
  allowed: boolean;
  checks: Issue[];
  ops: Op[];
  path: string;
  /**
   * Ignored files and folders that only this computer has, without dependencies and build output: the
   * first few, and how many more there are.
   */
  unbacked: { files: string[]; more: number };
}

/** What the server runs when a proposal is applied. Recomputed from the scan, never sent by the client. */
export type Action =
  | {
      type: "reconnect-claude";
      dir: string;
      target: string;
      pairs: [string, string][];
    }
  | {
      type: "rewrite-claude";
      items: { dir: string; pairs: [string, string][] }[];
    }
  | {
      type: "rewrite-logs";
      field: string;
      files: string[];
      pairs: [string, string][];
    }
  /** `to` is relative to laci's quarantine folder. */
  | { type: "quarantine"; moves: { from: string; to: string }[] }
  | { type: "trash"; paths: string[] }
  | { type: "archive"; nodeId: string };

export interface Proposal {
  id: string;
  category:
    "reconnect" | "migration" | "orphan" | "status" | "space" | "duplicate";
  title: string;
  why: string;
  confidence: "high" | "med" | "low";
  nodeId?: string;
  ops: Op[];
  action?: Action;
}

export interface Node {
  revision?: number;
  historyPending?: boolean;
  id: string;
  kind: "project" | "folder";
  type?: "code" | "docs";
  name: string;
  /** Name that stays unambiguous in a flat list: `19sixtyfive/docs` instead of `docs`. */
  label: string;
  path: string;
  parent?: string;
  children: string[];
  archived: boolean;
  stableId: string;
  meta: Meta;
  status: { value: string; auto: boolean };
  summary?: { text: string; source: string };
  createdAt?: { at: string; source: string };
  lastActivity?: { at: string; source: string };
  /** Newest file change or commit in the folder itself, before agent sessions and children count. */
  ownActivity?: { at: string; source: string };
  git?: GitInfo;
  readme?: ReadmeInfo;
  stack?: StackInfo;
  tasks: Task[];
  taskFiles: TaskFile[];
  /** Body of the `## Notes` section in `.laci.md`. */
  notes?: string;
  /** Has a `.laci.md`: the user gave it a status, deadline, to-do or notes in laci. */
  sidecar: boolean;
  agents: Agents;
  size?: Size;
  issues: Issue[];
  archivePlan?: ArchivePlan;
}

/** When agent history was last copied to Laci's own folder. `at` is missing until the first backup. */
export interface Backup {
  /** The user turned on automatic backups. */
  auto: boolean;
  at?: string;
  /** Session logs the backup holds, including ones their tool has since deleted. */
  sessions?: number;
  files?: number;
  bytes?: number;
  dest?: string;
  /** Sessions that changed after `at`. */
  pending?: number;
}
/** Whether an agent knows Laci's MCP server, and how it is added. From the `agent/mcp` request. */
export interface McpStatus {
  provider: string;
  name: string;
  supported: boolean;
  /** `other`: a different program is registered under Laci's name. `off`: registered but switched off. */
  state: "missing" | "registered" | "other" | "off";
  /** The agent's settings file, with `~` for home. */
  file: string;
  /** This Laci's program, the one that gets registered. */
  laci: string;
  /** The agent's own program is on PATH. */
  installed: boolean;
  command: string;
  /** What is registered now, as a command line. */
  current?: string;
  /** `command`: the agent's own program makes the change. `file`: Laci edits the settings file. */
  how: "command" | "file";
  add?: string;
  remove?: string;
  /** For `file`: the JSON that gets merged in. */
  snippet?: string;
}
export interface Commit {
  hash: string;
  subject: string;
  at: string;
  author: string;
}
/** What stands behind the counts on the Health tab. From the `health` request, not from the snapshot. */
export interface Health {
  /** `code` is the two-letter Git status: "M", "A", "D", "R", "??". */
  changes: { code: string; path: string }[];
  /** Changed files beyond the 200 listed. */
  changesMore?: number;
  unpushed: Commit[];
  /** Newest first, at most ten. */
  recent: Commit[];
  stashes: { ref: string; subject: string; at: string }[];
  /** `version` and `source` come from the project's manifest; `tag` is the latest Git tag reachable from HEAD. */
  release?: {
    version?: string;
    source?: string;
    tag?: string;
    tagAt?: string;
    /** Commits since `tag`. */
    since?: number;
  };
}
/** A Markdown report an agent wrote about one session, in the folder chosen in Settings. */
export interface Report {
  /** Its file name in the folder. */
  id: string;
  file: string;
  title: string;
  /** "YYYY-MM-DD": from its header, else its name, else its file time. */
  date: string;
  /** File time, ISO. */
  modified: string;
  bytes: number;
  /** Session ids its header names, lower case. */
  sessions: string[];
  /** Paths of the projects it names, through paths or its sessions. */
  projects: string[];
  /** Its Projects line as written, as plain text. */
  scope?: string;
  /** The first paragraph of its Summary. */
  summary?: string;
  /** The first entries under its last Open heading that the user hasn't closed. */
  open: string[];
  /** All entries under that heading, less the closed ones. */
  openCount: number;
  /**
   * With more than one project: the open entries about each, by path. An entry is about the projects it names, else
   * the one its sessions worked in, else none.
   */
  byProject?: Record<string, { open: string[]; openCount: number }>;
  /** Entries the user closed in Laci; the report itself is unchanged. */
  closedCount?: number;
  /** Those entries, in the report's order. */
  closed?: string[];
}
export interface ReportsDir {
  path: string;
  /** Report files found; the snapshot carries the newest. */
  total?: number;
  /** Why the folder can't be read now. */
  error?: string;
}
export interface ReportHit {
  id: string;
  snippet: string;
}
export interface ReportText {
  id: string;
  file: string;
  raw: string;
}
export interface Snapshot {
  revision?: number;
  historyPending?: boolean;
  scannedAt: string;
  home: string;
  host: string;
  roots: string[];
  rootStatus?: RootStatus[];
  terminalTarget?: TerminalTarget;
  /** False until the user saves their selections, which may be empty. */
  configured: boolean;
  rootIds: string[];
  nodes: Record<string, Node>;
  claude: Record<string, ClaudeDir>;
  items: Record<string, Item>;
  sessions?: Session[];
  /** Connectors the user added (or, before they chose, the ones with data here). */
  connectors: ConnectorState[];
  suggestions: Suggestion[];
  /** Agent history for folders outside the scanned roots. */
  global: { claude: string[]; items: string[] };
  /** Agent history whose folder is gone. */
  orphans: { claude: string[]; items: string[] };
  /** Folders in a hashed store that match no folder laci knows. They may still exist elsewhere. */
  unmatched: string[];
  proposals: Proposal[];
  /** Suggestions the user dismissed; Tidy up can offer them again. */
  dismissed?: { id: string; title: string; at: string }[];
  warnings: Issue[];
  /** Present while the Claude Code connector is on. */
  backup?: Backup;
  /** Present when a reports folder is set in Settings. */
  reportsDir?: ReportsDir;
  /** Newest first; empty while the folder can't be read. */
  reports?: Report[];
  tookMs: number;
}

export interface Apps {
  editor: string;
  files: string;
  terminal: string;
}
export type TerminalTarget = "internal" | "external";
export interface RootStatus {
  path: string;
  available: boolean;
  reason?: string;
}
export interface SetupInfo {
  configured: boolean;
  roots: string[];
  rootStatus?: RootStatus[];
  terminalTarget?: TerminalTarget;
  archiveDir?: string;
  reportsDir?: string;
  candidates: { path: string; repos: number }[];
  presets: string[];
  custom: number;
  apps: Apps;
  installed: AppsLists;
}
export interface AppsLists {
  editor: string[];
  files: string[];
  terminal: string[];
}
export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  link?: boolean;
  size?: number;
  at?: string;
  git?: boolean;
  newest?: string;
}
export interface Listing {
  path: string;
  entries: Entry[];
  error?: string;
  deep?: boolean;
}
export interface LogEntry {
  id: string;
  at: string;
  by: string;
  title: string;
  path?: string;
  detail?: string;
  key?: string;
  journal?: string;
  undoes?: string;
  state: string;
  canUndo: boolean;
  superseded?: boolean;
  error?: string;
  steps?: Op[];
  /**
   * The change in parts, which Simple tells in its own words: its form, such as "moved", and plain
   * values (names, titles, counts). Laci 3.0 records it with every entry; older entries lack it.
   */
  say?: LogSay;
}
export interface LogSay {
  form: string;
  [part: string]: string | number | boolean | undefined;
}
export interface ActivityLog {
  entries: LogEntry[];
  file?: string;
  error?: string;
}
export interface Change {
  revision?: number;
  historyPending?: boolean;
  snapshot?: Snapshot;
  node?: Node;
  journal?: { id: string; title: string; canUndo?: boolean; recovery?: string };
  path?: string;
  warnings?: string[];
}
export interface RefreshStatus {
  busy: boolean;
  revision?: number;
  historyPending?: boolean;
}
export interface NewInfo {
  templates: string[];
  templatesDir: string;
  hosts: { github: boolean; gitlab: boolean };
}
export interface TerminalInfo {
  id: string;
  cwd: string;
  title: string;
  exited?: number | boolean;
}
export type View =
  | "today"
  | "folder"
  | "tidy"
  | "agents"
  | "reports"
  | "log"
  | "settings"
  /** Simple's page for the selected project. Detailed shows a project beside the view instead. */
  | "project"
  /** Simple's Help page. Detailed opens Help as a dialog. */
  | "help";
export type Tab = "health" | "todo" | "agents" | "readme";
/** How much the window shows at once. */
export type Design = "simple" | "detailed";
/** The `prefs` reply: the choices saved in config.json. */
export interface Prefs {
  /** Null for the system's theme. */
  theme: "light" | "dark" | null;
  /** Null until the user chooses one. */
  design: Design | null;
  /** Null until the user chooses. */
  updates: "daily" | "off" | null;
  /** False until the user saves their setup. */
  configured: boolean;
  /** Where config.json is, with the home folder as `~`. */
  configPath: string;
}
