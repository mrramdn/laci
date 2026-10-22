import type {
  Node,
  Snapshot,
  LogEntry,
  Task,
  Session,
  Report,
} from "./types";
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
// Paths are POSIX paths: an absolute one starts with "/", and "/" is the only separator (a backslash
// is an ordinary character in a name). store.ts keeps a copy of what `cd` needs, since it may import
// nothing but ./api; a test checks that the copy agrees.
/** "/" for an absolute path; "" for a path that isn't absolute. */
export const rootOf = (path: string) => (path.startsWith("/") ? "/" : "");
/** Whether the path names one place by itself, not one relative to where you are. */
export const isAbsolutePath = (path: string) => path.startsWith("/");
/** Whether the path is a whole disk: "/", with any separators at its end. */
export const isWholeDisk = (path: string) => /^\/+$/.test(path);
/** The folder names in a path, after its root. */
export function segments(path: string) {
  return path.split("/").filter(Boolean);
}
/** The last name in a path; a root is its own name. */
export function base(path: string) {
  return path.slice(path.lastIndexOf("/") + 1) || "/";
}
/** The folder a path is in; a root is its own parent. */
export function parentOf(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
/** Whether `path` is `root` or inside it. */
export function within(path: string, root: string) {
  return (
    path === root || path.startsWith(root.endsWith("/") ? root : root + "/")
  );
}
/** The path with the home folder written as "~". */
/**
 * What the toast says once `backup/move` for `dir` answered, in a design's `words`: `moved` only when the engine says
 * something moved, else `kept` (it held nothing, or a new copy starts), and Laci's own folder (`dir` "") by the
 * design's name for it, `own`, rather than its path.
 */
export function copyChangeSaid(
  dir: string,
  answer: { dest: string; moved?: boolean },
  words: { moved: (where: string) => string; kept: (where: string) => string; own: string },
) {
  const where = dir ? answer.dest : words.own;
  return answer.moved ? words.moved(where) : words.kept(where);
}

export function tilde(path: string | undefined, home: string) {
  return path === home
    ? "~"
    : path?.startsWith(home + "/")
      ? "~" + path.slice(home.length)
      : (path ?? "");
}
/** `names` inside `dir`. */
export function joinPath(dir: string, ...names: string[]) {
  return names.reduce(
    (path, name) => (path.endsWith("/") ? path : path + "/") + name,
    dir,
  );
}
/** The path without separators at its end, except a root's. */
export function trimSep(path: string) {
  return path.replace(/(.)\/+$/, "$1");
}
/** A typed path with "~" spelled out as the home folder; any other path as it was typed. */
export function expandHome(path: string, home: string) {
  if (path === "~") return home;
  if (!path.startsWith("~/")) return path;
  return home + path.slice(1);
}
/**
 * The places a breadcrumb trail passes from where it starts to `cwd`. It starts at Home when `cwd` is
 * inside it, else at the nearest scanned folder that holds it, else at "/".
 */
export function breadcrumbs(cwd: string, home: string, roots: string[]) {
  const holder = roots
    .filter((root) => within(cwd, root))
    .sort((a, b) => b.length - a.length)[0];
  const start = within(cwd, home) ? home : (holder ?? (rootOf(cwd) || "/"));
  const names = segments(cwd).slice(segments(start).length);
  return [
    start,
    ...names.map((_, i) => joinPath(start, ...names.slice(0, i + 1))),
  ];
}
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
/** The language dates are written in: the system's, or British English when the page doesn't say or doesn't know it. */
export const LOCALE = (() => {
  const tag = typeof navigator === "undefined" ? undefined : navigator.language;
  try {
    if (tag && Intl.DateTimeFormat.supportedLocalesOf(tag).length) return tag;
  } catch {
    // Not a language tag.
  }
  return "en-GB";
})();
export const date = (at?: string) =>
  at
    ? new Date(at).toLocaleDateString(LOCALE, {
        day: "numeric",
        month: "short",
        ...(new Date(at).getFullYear() !== new Date().getFullYear()
          ? { year: "numeric" }
          : {}),
      })
    : "—";
/** A "YYYY-MM-DD" day at local midnight. `new Date("2026-10-13")` is UTC midnight: the day before, west of
 * Greenwich. */
export function localDay(ymd?: string) {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd) : null;
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : undefined;
}
/** "Today", "Yesterday", else the weekday and the date. */
export function dayLabel(day: Date) {
  const back = daysBack(day);
  return back === 0
    ? "Today"
    : back === 1
      ? "Yesterday"
      : day.toLocaleDateString(LOCALE, {
          weekday: "long",
          day: "numeric",
          month: "short",
          ...(day.getFullYear() !== new Date().getFullYear()
            ? { year: "numeric" }
            : {}),
        });
}
/** "13 Oct" for a "YYYY-MM-DD" day, with the year when it is another year. */
export function shortDay(ymd: string) {
  const day = localDay(ymd);
  return day
    ? day.toLocaleDateString(LOCALE, {
        day: "numeric",
        month: "short",
        ...(day.getFullYear() !== new Date().getFullYear()
          ? { year: "numeric" }
          : {}),
      })
    : ymd;
}
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
  const clock = d.toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const back = daysBack(d);
  if (back === 0) return `${Math.floor(seconds / 3600)} h ago · ${clock}`;
  if (back === 1) return `yesterday ${clock}`;
  if (back < 7)
    return `${d.toLocaleDateString(LOCALE, { weekday: "short" })} ${clock}`;
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
/** The name an agent goes by: the name of the connector it is connected under. */
export function providerName(
  snapshot: Snapshot | null | undefined,
  provider: string | undefined,
) {
  if (!provider) return "";
  return (
    snapshot?.connectors.find((c) => (c.provider ?? c.id) === provider)?.name ??
    provider
  );
}
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
        file: joinPath(dir.dir, `${session.id}.jsonl`),
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
  const home = snapshot.home;
  for (const session of all) {
    if (session.cwd && session.cwd === home) {
      index.global.push(session);
      continue;
    }
    let cwd = session.cwd;
    let node: Node | undefined;
    while (cwd) {
      node = byPath.get(cwd);
      const above = parentOf(cwd);
      // A root is its own parent.
      if (node || above === cwd) break;
      cwd = above;
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
const chatsByNode = new WeakMap<Snapshot, Map<string, Conversation[]>>();
/**
 * A project's AI chats, as every list of chats shows them: the conversations of all sessions, each
 * in the project its newest session is in. A subagent's log is part of the chat that started it,
 * so a subagent that worked in another project is no chat of that project. Worked out once a scan.
 */
export function chatsOf(node: Node, snapshot: Snapshot): Conversation[] {
  let byNode = chatsByNode.get(snapshot);
  if (!byNode) {
    const owners = new Map<string, string>();
    for (const [id, sessions] of indexSessions(snapshot).byNode)
      for (const session of sessions) owners.set(sessionKey(session), id);
    byNode = new Map();
    for (const c of conversations(allSessions(snapshot))) {
      const id = owners.get(sessionKey(c.session));
      if (!id) continue;
      const list = byNode.get(id);
      if (list) list.push(c);
      else byNode.set(id, [c]);
    }
    chatsByNode.set(snapshot, byNode);
  }
  return byNode.get(node.id) ?? [];
}
const agentCounts = new WeakMap<Snapshot, WeakMap<Node, number>>();
/**
 * A project's conversations, and the agent history Laci has no session for. Worked out once for
 * each node of a scan: a folder's rows ask for every project under them each time they draw.
 */
export function agentCount(node: Node, snapshot: Snapshot) {
  let counts = agentCounts.get(snapshot);
  if (!counts) agentCounts.set(snapshot, (counts = new WeakMap()));
  let count = counts.get(node);
  if (count === undefined) {
    count =
      chatsOf(node, snapshot).length +
      node.agents.items.filter(
        (id) =>
          counted(id, snapshot) &&
          !hasSessionFile(snapshot.items[id].file, snapshot),
      ).length;
    counts.set(node, count);
  }
  return count;
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
/** One conversation as the user had it: its newest session, the stubs `/resume` left behind, and the
 * logs of the subagents that ran inside it. Lists and counts show conversations, not log files. */
export interface Conversation {
  session: Session;
  /** Earlier sessions that continued in this one, newest first. */
  parts: Session[];
  /** Subagent logs, nested the way `groupSessions` nests them. */
  children: SessionGroup[];
  title: string;
  /** Unknown when a log does not say (Antigravity, backups of old formats). */
  prompts?: number;
  filesChanged: number;
  bytes: number;
  startedAt?: string;
  updatedAt: string;
  /** Time spent in it, all parts together; pauses of over half an hour left out. */
  activeSeconds?: number;
  /** A couple of prompts and no file changed: folded away in lists, and first in line for cleanup. */
  short: boolean;
}
const SHORT_PROMPTS = 2;
/** A session still being written is never short: it may be the one the user is in right now. */
const SETTLING_MS = 30 * 60 * 1000;
export const conversationKey = (c: Conversation) => sessionKey(c.session);
export function conversations(
  sessions: Session[],
  now = Date.now(),
): Conversation[] {
  const groups = groupSessions(sessions);
  const byId = new Map(
    groups.map((g) => [`${g.session.provider}:${g.session.sessionId}`, g]),
  );
  // A stub belongs to the conversation it continued in; a broken or circular chain leaves it alone.
  const home = (group: SessionGroup) => {
    let cursor = group;
    const seen = new Set([group]);
    while (cursor.session.continuedIn) {
      const next = byId.get(
        `${cursor.session.provider}:${cursor.session.continuedIn}`,
      );
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return cursor;
  };
  const parts = new Map<SessionGroup, SessionGroup[]>();
  const roots: SessionGroup[] = [];
  for (const group of groups) {
    const target = home(group);
    if (target === group) roots.push(group);
    else parts.set(target, [...(parts.get(target) ?? []), group]);
  }
  const size = (g: SessionGroup): number =>
    (g.session.bytes ?? 0) + g.children.reduce((n, c) => n + size(c), 0);
  return roots.map((root) => {
    const earlier = (parts.get(root) ?? []).sort((a, b) =>
      b.session.updatedAt.localeCompare(a.session.updatedAt),
    );
    const all = [root, ...earlier];
    const known = all.every((g) => g.session.prompts !== undefined);
    const prompts = known
      ? all.reduce((n, g) => n + (g.session.prompts ?? 0), 0)
      : undefined;
    const filesChanged = all.reduce(
      (n, g) => n + (g.session.filesChanged ?? 0),
      0,
    );
    const titled =
      all.find((g) => g.session.titleSource !== "fallback") ?? root;
    const { session } = root;
    const started = all
      .map((g) => g.session.startedAt)
      .filter((at): at is string => !!at)
      .sort()[0];
    const settling = now - Date.parse(session.updatedAt) < SETTLING_MS;
    return {
      session,
      parts: earlier.map((g) => g.session),
      children: all.flatMap((g) => g.children),
      title:
        titled.session.titleSource === "fallback" && prompts === 0
          ? "Empty session"
          : titled.session.title,
      prompts,
      filesChanged,
      bytes: all.reduce((n, g) => n + size(g), 0),
      startedAt: started,
      updatedAt: session.updatedAt,
      activeSeconds: all.some((g) => g.session.activeSeconds !== undefined)
        ? all.reduce((n, g) => n + (g.session.activeSeconds ?? 0), 0)
        : undefined,
      short:
        prompts !== undefined &&
        prompts <= SHORT_PROMPTS &&
        filesChanged === 0 &&
        !all.some((g) => g.session.kept) &&
        !session.backup &&
        !settling,
    };
  });
}
/** Whether Laci can delete it: whole Claude Code and Codex sessions that are not kept or in use. */
export function deletable(c: Conversation, now = Date.now()) {
  return [c.session, ...c.parts].every(
    (s) =>
      (s.provider === "claude" || s.provider === "codex") &&
      !s.backup &&
      !s.kept &&
      s.cleanupCapability !== "unsupported" &&
      now - Date.parse(s.updatedAt) > 2 * 60 * 1000,
  );
}
/** Time spent, as people say it: "2 h 10 min", "4 min". Nothing under a minute. */
export function duration(seconds?: number) {
  const minutes = Math.round((seconds ?? 0) / 60);
  if (minutes < 1) return "";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
export const RISK = new Set([
  "no-commits",
  "no-remote",
  "dirty",
  "unpushed",
  "diverged",
  "stash",
  "no-git",
]);
const SEVERITY_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };
export const PRIORITY_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  none: 3,
};
export const priorityRank = (priority?: string) =>
  PRIORITY_RANK[priority ?? "none"] ?? PRIORITY_RANK.none;
export const byPriority = (a: Node, b: Node) =>
  priorityRank(a.meta.priority) - priorityRank(b.meta.priority);
/** The checks that count: muted ones are listed in the inspector but never counted. */
export const liveIssues = (n: Node) => n.issues.filter((i) => !i.muted);
export function risksOf(snapshot: Snapshot) {
  return Object.values(snapshot.nodes)
    .map((n) => ({
      n,
      issues: liveIssues(n)
        .filter((i) => RISK.has(i.code))
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    }))
    .filter((r) => r.issues.length)
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.issues[0].severity] -
          SEVERITY_RANK[b.issues[0].severity] ||
        byPriority(a.n, b.n) ||
        days(a.n.lastActivity?.at) - days(b.n.lastActivity?.at),
    );
}
export function deadlineInfo(deadline: string | undefined, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline ?? "");
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const due = new Date(y, mo - 1, d);
  if (
    due.getFullYear() !== y ||
    due.getMonth() !== mo - 1 ||
    due.getDate() !== d
  )
    return undefined;
  // Both sides are local midnights; rounding absorbs the 23 or 25 hour days around DST changes.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((due.getTime() - today.getTime()) / 864e5);
  const label =
    diff < 0
      ? `Overdue by ${plural(-diff, "day")}`
      : diff === 0
        ? "Due today"
        : diff === 1
          ? "Due tomorrow"
          : `Due in ${diff} days`;
  return {
    days: diff,
    label,
    tone: diff <= 0 ? "bad" : diff <= 2 ? "warn" : "",
  };
}
export function deadlinesOf(snapshot: Snapshot, now = new Date()) {
  return Object.values(snapshot.nodes)
    .filter(
      (n) => n.kind === "project" && !n.archived && n.status.value !== "done",
    )
    .flatMap((n) => {
      const info = deadlineInfo(n.meta.deadline, now);
      return info && info.days <= 14 ? [{ n, info }] : [];
    })
    .sort((a, b) => a.info.days - b.info.days || byPriority(a.n, b.n));
}
export function todayBadge(snapshot: Snapshot) {
  const ids = new Set<string>();
  for (const { n, issues } of risksOf(snapshot))
    if (issues.some((i) => i.severity === "high")) ids.add(n.id);
  for (const { n, info } of deadlinesOf(snapshot))
    if (info.days <= 0) ids.add(n.id);
  return ids.size;
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
/**
 * The fixes that save or upload versions. Before any of them both designs look for files that look
 * like passwords or keys (`secrets/check`); simple/model.ts lists the same ones as SECRET_CHECKED.
 */
export const SECRET_FIXES: ReadonlySet<string> = new Set([
  "no-remote",
  "no-commits",
  "no-git",
  "dirty",
  "unpushed",
]);
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

interface ReportIndex {
  all: Report[];
  byId: Map<string, Report>;
  bySession: Map<string, Report[]>;
  byProject: Map<string, Report[]>;
}
const NO_REPORTS: Report[] = [];
const reportIndexes = new WeakMap<Report[], ReportIndex>();
/** Keyed on the reports array, which survives the periodic snapshot copy. */
function indexReports(snapshot: Snapshot | null | undefined): ReportIndex {
  const reports = snapshot?.reports ?? NO_REPORTS;
  const cached = reportIndexes.get(reports);
  if (cached) return cached;
  const all = reports
    .slice()
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.modified.localeCompare(a.modified) ||
        b.id.localeCompare(a.id),
    );
  const index: ReportIndex = {
    all,
    byId: new Map(all.map((r) => [r.id, r])),
    bySession: new Map(),
    byProject: new Map(),
  };
  const add = (map: Map<string, Report[]>, key: string, report: Report) =>
    map.set(key, [...(map.get(key) ?? []), report]);
  for (const report of all) {
    for (const id of report.sessions)
      add(index.bySession, id.toLowerCase(), report);
    for (const path of report.projects)
      add(index.byProject, path, report);
  }
  reportIndexes.set(reports, index);
  return index;
}
/** Every report, newest first. */
export const reportList = (snapshot: Snapshot | null | undefined) =>
  indexReports(snapshot).all;
export const reportById = (
  snapshot: Snapshot | null | undefined,
  id: string | null | undefined,
) => (id ? indexReports(snapshot).byId.get(id) : undefined);
/** Reports that name any of these sessions, newest first. */
export function reportsOfSessions(
  snapshot: Snapshot | null | undefined,
  ids: string[],
) {
  const index = indexReports(snapshot);
  const found = new Set(
    ids.flatMap((id) => index.bySession.get(id.toLowerCase()) ?? []),
  );
  return index.all.filter((report) => found.has(report));
}
export const reportsOfProject = (
  snapshot: Snapshot | null | undefined,
  path: string,
) => indexReports(snapshot).byProject.get(path) ?? NO_REPORTS;
/**
 * The project's newest report, with only the open items about that project: a report on several projects says
 * which project each item is about.
 */
export function latestReport(
  snapshot: Snapshot | null | undefined,
  path: string,
): Report | undefined {
  const report = reportsOfProject(snapshot, path)[0];
  if (!report?.byProject) return report;
  const own = report.byProject[path] ?? { open: [], openCount: 0 };
  return { ...report, open: own.open, openCount: own.openCount };
}
/** The session ids one conversation went by: its newest session and those it continued. */
export const conversationIds = (c: Conversation) => [
  c.session.sessionId,
  ...c.parts.map((part) => part.sessionId),
];
/** The rule that makes an agent write reports Laci reads, for CLAUDE.md, AGENTS.md or GEMINI.md. */
export function agentInstruction(dir: string) {
  return `## Session reports

When a session finishes real work, write a report about it in \`${dir}\`. Skip quick questions that change nothing.

- One file per session, named \`YYYY-MM-DD-short-title.md\` after the day the session started. If the session continues later, update that file instead of writing a new one.
- Use this layout:

\`\`\`markdown
# Title saying what the session was about

- **Date:** YYYY-MM-DD
- **Session:** <folder you were started in> · <your session id, if you know it>
- **Projects:** <full path of each project you worked in>

## Summary
Two or three sentences: what was asked and where it ended up.

## What was done
What changed, grouped by project, and where it lives.

## State now
What works now, and how that was checked.

## Open
One line per thing still to do, most important first, or \`Nothing open.\`
\`\`\`

- No secrets in reports: name the file that holds a secret, never its value.
`;
}
