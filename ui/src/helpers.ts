import type { Node, Snapshot, LogEntry, Task, Session } from "./types";
export function taskIdentity(node: Node, task: Task) {
  const matching = node.tasks.filter(
    (candidate) =>
      candidate.kind === "check" &&
      candidate.file === task.file &&
      candidate.text === task.text,
  );
  return {
    occurrence: matching.findIndex((candidate) => candidate.line === task.line),
    count: matching.length,
  };
}
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const base = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1) || "/";
export const parentOf = (path: string) =>
  path.slice(0, path.lastIndexOf("/")) || "/";
export const within = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
export const tilde = (path: string | undefined, home: string) =>
  path === home
    ? "~"
    : path?.startsWith(home + "/")
      ? "~" + path.slice(home.length)
      : (path ?? "");
export const days = (at?: string) =>
  at ? (Date.now() - Date.parse(at)) / 864e5 : Infinity;
export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;
export const bytes = (b?: number) =>
  !b
    ? "—"
    : b >= 1e9
      ? `${(b / 1e9).toFixed(1)} GB`
      : b >= 1e6
        ? `${Math.round(b / 1e6)} MB`
        : b >= 1e3
          ? `${Math.round(b / 1e3)} KB`
          : `${b} B`;
export const date = (at?: string) =>
  at
    ? new Date(at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        ...(new Date(at).getFullYear() !== new Date().getFullYear()
          ? { year: "numeric" }
          : {}),
      })
    : "—";
export function daysBack(d: Date) {
  const midnight = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((midnight(new Date()) - midnight(d)) / 864e5);
}
export function ago(at?: string) {
  if (!at) return "—";
  const seconds = (Date.now() - Date.parse(at)) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  const back = daysBack(new Date(at));
  if (back <= 1) return "yesterday";
  if (back < 14) return `${back} d`;
  if (back < 60) return `${Math.floor(back / 7)} wk`;
  if (back < 365) return `${Math.floor(back / 30.4)} mo`;
  return `${Math.floor(back / 365)} yr`;
}
export function when(at?: string) {
  if (!at) return "—";
  const d = new Date(at);
  const seconds = (Date.now() - d.getTime()) / 1000;
  const clock = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const back = daysBack(d);
  if (back === 0) return `${Math.floor(seconds / 3600)} h ago · ${clock}`;
  if (back === 1) return `yesterday ${clock}`;
  if (back < 7)
    return `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${clock}`;
  return `${date(at)}${d.getFullYear() === new Date().getFullYear() ? ` ${clock}` : ""}`;
}
export const recency = (a: Node, b: Node) =>
  (b.lastActivity?.at ?? "").localeCompare(a.lastActivity?.at ?? "");
export function descendants(node: Node, snapshot: Snapshot): Node[] {
  return node.children.flatMap((id) =>
    snapshot.nodes[id]
      ? [snapshot.nodes[id], ...descendants(snapshot.nodes[id], snapshot)]
      : [],
  );
}
export const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};
export const sessionKey = (session: Session) =>
  `${session.provider}:${session.sessionId}:${session.file}`;
interface SessionIndex {
  all: Session[];
  byNode: Map<string, Session[]>;
  global: Session[];
  files: Set<string>;
}
const sessionIndexes = new WeakMap<Snapshot, SessionIndex>();
function indexSessions(snapshot: Snapshot): SessionIndex {
  const cached = sessionIndexes.get(snapshot);
  if (cached) return cached;
  const all = (
    snapshot.sessions ??
    Object.values(snapshot.claude).flatMap((dir) =>
      dir.sessions.map((session) => ({
        provider: "claude",
        sessionId: session.id,
        title: session.title ?? `Untitled · ${session.id.slice(0, 8)}`,
        titleSource: session.title ? "provider" : "fallback",
        cwd: session.cwd ?? dir.path,
        sourceKind: "cli",
        updatedAt: session.at,
        resumeCapability: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          session.id,
        )
          ? ("supported" as const)
          : ("history-only" as const),
        file: `${dir.dir}/${session.id}.jsonl`,
      })),
    )
  )
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const byPath = new Map(
    Object.values(snapshot.nodes).map((node) => [node.path, node]),
  );
  const index: SessionIndex = {
    all,
    byNode: new Map(),
    global: [],
    files: new Set(all.map((session) => session.file)),
  };
  for (const session of all) {
    if (session.cwd === snapshot.home) {
      index.global.push(session);
      continue;
    }
    let cwd = session.cwd;
    let node: Node | undefined;
    while (cwd) {
      node = byPath.get(cwd);
      if (node || cwd === "/") break;
      cwd = parentOf(cwd);
    }
    if (node) {
      const list = index.byNode.get(node.id) ?? [];
      list.push(session);
      index.byNode.set(node.id, list);
    } else index.global.push(session);
  }
  sessionIndexes.set(snapshot, index);
  return index;
}
export function sessionsOf(node: Node, snapshot: Snapshot) {
  return indexSessions(snapshot).byNode.get(node.id) ?? [];
}
export function globalSessions(snapshot: Snapshot) {
  return indexSessions(snapshot).global;
}
export function allSessions(snapshot: Snapshot) {
  return indexSessions(snapshot).all;
}
export function hasSessionFile(file: string, snapshot: Snapshot) {
  return indexSessions(snapshot).files.has(file);
}
export function counted(id: string, snapshot: Snapshot) {
  const item = snapshot.items[id];
  return (
    !!item &&
    ["cwd", "named"].includes(
      snapshot.connectors.find((c) => c.id === item.connector)?.link.kind ?? "",
    )
  );
}
export function agentCount(node: Node, snapshot: Snapshot) {
  return (
    sessionsOf(node, snapshot).length +
    node.agents.items.filter(
      (id) =>
        counted(id, snapshot) &&
        !hasSessionFile(snapshot.items[id].file, snapshot),
    ).length
  );
}
export interface SessionGroup {
  session: Session;
  children: SessionGroup[];
}
export function groupSessions(sessions: Session[]): SessionGroup[] {
  const groups = new Map(
    sessions.map((session) => [
      sessionKey(session),
      { session, children: [] as SessionGroup[] },
    ]),
  );
  const parents = new Map<string, SessionGroup>();
  for (const group of groups.values()) {
    const identity = `${group.session.provider}:${group.session.sessionId}`;
    if (!parents.has(identity)) parents.set(identity, group);
  }
  const roots: SessionGroup[] = [];
  for (const group of groups.values()) {
    const { session } = group;
    const parent = session.parentId
      ? parents.get(`${session.provider}:${session.parentId}`)
      : undefined;
    let cursor = parent;
    const visited = new Set([sessionKey(session)]);
    while (cursor && !visited.has(sessionKey(cursor.session))) {
      visited.add(sessionKey(cursor.session));
      cursor = cursor.session.parentId
        ? parents.get(`${cursor.session.provider}:${cursor.session.parentId}`)
        : undefined;
    }
    // Malformed or missing parent metadata must never hide a session or create a render loop.
    if (parent && !cursor) parent.children.push(group);
    else roots.push(group);
  }
  return roots;
}
export const RISK = new Set([
  "no-commits",
  "no-remote",
  "dirty",
  "unpushed",
  "stash",
  "no-git",
]);
export function risksOf(snapshot: Snapshot) {
  return Object.values(snapshot.nodes)
    .flatMap((n) =>
      n.issues.filter((i) => RISK.has(i.code)).map((i) => ({ n, i })),
    )
    .sort((a, b) =>
      a.i.severity === b.i.severity
        ? days(a.n.lastActivity?.at) - days(b.n.lastActivity?.at)
        : a.i.severity === "high"
          ? -1
          : 1,
    );
}
export const FIX_LABEL: Record<string, string> = {
  "no-remote": "Create remote",
  "no-commits": "First commit",
  dirty: "Review changes",
  unpushed: "Push",
  stash: "Show stash",
  "no-git": "Start tracking",
  behind: "Pull",
};
export const APP_NAMES: Record<string, string> = {
  code: "VS Code",
  codium: "VSCodium",
  subl: "Sublime Text",
  "gnome-terminal": "Terminal",
  "gnome-text-editor": "Text Editor",
  "xfce4-terminal": "Terminal",
  pcmanfm: "PCManFM",
};
export function logKind(e: LogEntry) {
  if (e.undoes) return "undo";
  if (e.journal) return "move";
  const key = e.key?.split(":")[0];
  if (key && ["meta", "todo", "notes"].includes(key)) return key;
  return key === "connector" || key === "settings"
    ? "setup"
    : e.title.startsWith("Created")
      ? "new"
      : "other";
}
