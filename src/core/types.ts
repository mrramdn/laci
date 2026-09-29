export type Severity = 'high' | 'med' | 'low'

export interface Issue {
  code: string
  severity: Severity
  title: string
  detail?: string
}

/** A to-do found in a file. `check` = `- [ ]` checkbox, `list` = item under a TODO/Next heading. */
export interface Task {
  text: string
  done: boolean
  kind: 'check' | 'list'
  file: string
  line: number
  section?: string
}

export interface TaskFile {
  file: string
  at: string
  open: number
  done: number
}

/** User-owned fields from `.laci.md` frontmatter. */
export interface Meta {
  status?: string
  priority?: string
  deadline?: string
  client?: string
  tags?: string[]
}

export interface Remote {
  name: string
  url: string
  web?: string
  host?: string
}

export interface GitInfo {
  rootCommit?: string
  firstCommitAt?: string
  lastCommitAt?: string
  lastSubject?: string
  commits: number
  branch?: string
  remotes: Remote[]
  upstream?: string
  dirty: number
  ahead: number
  behind: number
  stashes: number
  /** Commits per week for the last 26 weeks, oldest first. */
  weekly: number[]
  authors: number
  aiTrailers: number
  worktree: boolean
}

export interface ReadmeInfo {
  file: string
  title?: string
  weakTitle: boolean
  tagline?: string
  template: boolean
  links: { label: string; url: string }[]
  sections: string[]
  images: number
  raw: string
}

export interface StackInfo {
  labels: string[]
  languages: { name: string; files: number }[]
  packageManager?: string
  scripts: { name: string; cmd: string }[]
  services: string[]
  env: string[]
  deploy: string[]
  ci: string[]
}

export interface ClaudeSession {
  id: string
  title?: string
  at: string
  cwd?: string
  branch?: string
  bytes: number
}

export interface ClaudeDir {
  name: string
  dir: string
  /** Folder this session dir belongs to, resolved from its encoded name. Undefined = orphan. */
  path?: string
  sessions: ClaudeSession[]
  subagentLogs: number
  memory: string[]
  bytes: number
  /** cwd value -> number of lines that carry it, across every log in the dir. */
  cwds: Record<string, number>
  /** cwd values that no longer exist on disk (left behind by a move or a delete). */
  gone: string[]
}

export interface CodexSession {
  file: string
  at: string
  cwd?: string
  subagent: boolean
  cwdLines: number
}

export interface Plan {
  file: string
  title: string
  at: string
}

export interface Agents {
  claude: string[]
  codex: string[]
  plans: string[]
  aiFiles: string[]
  serenaMemories: number
}

export interface Size {
  total: number
  reclaimable: number
  parts: { path: string; bytes: number }[]
}

export interface Op {
  kind: 'move' | 'rename' | 'rewrite' | 'delete' | 'write' | 'git' | 'keep'
  label: string
  from?: string
  to?: string
  detail?: string
}

export interface ArchivePlan {
  dest: string
  checks: Issue[]
  ops: Op[]
}

/** What the server runs when a proposal is applied. Recomputed from the scan, never sent by the client. */
export type Action =
  | { type: 'reconnect-claude'; dir: string; target: string; pairs: [string, string][] }
  | { type: 'rewrite-claude'; items: { dir: string; pairs: [string, string][] }[] }
  | { type: 'rewrite-codex'; files: string[]; pairs: [string, string][] }
  | { type: 'quarantine'; paths: string[] }
  | { type: 'trash'; paths: string[] }
  | { type: 'archive'; nodeId: string }

export interface Proposal {
  id: string
  category: 'reconnect' | 'migration' | 'orphan' | 'status' | 'space' | 'duplicate'
  title: string
  why: string
  confidence: 'high' | 'med' | 'low'
  nodeId?: string
  ops: Op[]
  action?: Action
}

export interface Node {
  id: string
  kind: 'project' | 'folder'
  type?: 'code' | 'docs'
  name: string
  /** Name that stays unambiguous in a flat list: `19sixtyfive/docs` instead of `docs`. */
  label: string
  path: string
  parent?: string
  children: string[]
  archived: boolean
  stableId: string
  meta: Meta
  status: { value: string; auto: boolean }
  summary?: { text: string; source: string }
  createdAt?: { at: string; source: string }
  lastActivity?: { at: string; source: string }
  git?: GitInfo
  readme?: ReadmeInfo
  stack?: StackInfo
  tasks: Task[]
  taskFiles: TaskFile[]
  /** Body of the `## Notes` section in `.laci.md`. */
  notes?: string
  agents: Agents
  size?: Size
  issues: Issue[]
  archivePlan?: ArchivePlan
}

export interface Snapshot {
  scannedAt: string
  home: string
  host: string
  roots: string[]
  rootIds: string[]
  nodes: Record<string, Node>
  claude: Record<string, ClaudeDir>
  codex: Record<string, CodexSession>
  plans: Record<string, Plan>
  global: { claude: string[]; codex: string[] }
  orphans: { claude: string[]; codex: string[] }
  stores: { name: string; path: string; present: boolean; bytes: number; note: string }[]
  proposals: Proposal[]
  warnings: Issue[]
  tookMs: number
}
