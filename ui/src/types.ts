export type Severity = "high" | "med" | "low";

export interface Issue {
  code: string;
  severity: Severity;
  title: string;
  detail?: string;
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
  | { kind: "mentions"; dir: string; ext: string };

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
  };
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
    | "reconnect"
    | "migration"
    | "orphan"
    | "status"
    | "space"
    | "duplicate";
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
  warnings: Issue[];
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
export type View = "today" | "folder" | "tidy" | "agents" | "log" | "settings";
export type Tab = "health" | "todo" | "agents" | "readme";
