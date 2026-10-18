// What Simple's pages show, worked out from the scan: how safe a project is, which problems it shows
// and how each is fixed, the project list, and what Home hides until tomorrow. Pure: it imports only
// helpers.ts and selectors.ts, so the tests run it as it is.
import {
  base,
  deadlineInfo,
  liveIssues,
  recency,
  RISK,
  tilde,
  within,
} from "../helpers";
import { activityModel, homeModel } from "../selectors";
import type { HomeModel, MainCard, Need } from "../selectors";
import type {
  ActivityLog,
  Issue,
  LogEntry,
  Node,
  Proposal,
  Severity,
  Snapshot,
  Storage,
  StoragePart,
} from "../types";

/** How a status reads: safe (teal), soon (amber), act now (red) or good to know. */
export type Tone = "safe" | "soon" | "act" | "fyi";

export const toneOf = (severity: Severity): Tone =>
  severity === "high" ? "act" : severity === "med" ? "soon" : "fyi";

const RANK: Record<Severity, number> = { high: 0, med: 1, low: 2 };

/** The checks "Is it safe?" shows: what can lose work, a newer version online, and chats left behind. */
export const SAFETY: ReadonlySet<string> = new Set([
  ...RISK,
  "behind",
  "stale-cwd",
]);

/** A project's own problems with its safety, the worst first. Hidden warnings are left out. */
export function safetyIssues(n: Node): Issue[] {
  return liveIssues(n)
    .filter((issue) => SAFETY.has(issue.code))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** The warnings the user hid for this project. */
export const hiddenIssues = (n: Node) => n.issues.filter((i) => i.muted);

export interface Safety {
  tone: Tone;
  /** The worst problem, when there is one. */
  issue?: Issue;
  /** No problem, but no version history either: a folder of notes. */
  noHistory: boolean;
}

/** How safe a project is, for its badge. */
export function safetyOf(n: Node): Safety {
  const [issue] = safetyIssues(n);
  if (issue) return { tone: toneOf(issue.severity), issue, noHistory: false };
  return { tone: n.git ? "safe" : "fyi", noHistory: !n.git };
}

/** The number a problem is about: saved versions, files or sets of changes. */
export function issueCount(n: Node, issue: Issue): number {
  const git = n.git;
  const leading = Number(/^\s*(\d+)/.exec(issue.title)?.[1] ?? 0);
  switch (issue.code) {
    case "no-remote":
      return git?.commits ?? leading;
    case "no-commits":
      return git?.dirty ?? leading;
    case "dirty":
      return git?.dirty || leading;
    case "stash":
      return git?.stashes || leading;
    case "behind":
      return git?.behind || leading;
    default:
      // Unpushed versions may have no upstream to count from, so the engine's own count wins.
      return leading || git?.ahead || 0;
  }
}

/** The fixes that `assistant/prompt {kind: "fix"}` writes a prompt for. */
export const AI_FIXES: ReadonlySet<string> = new Set([
  "no-remote",
  "no-commits",
  "no-git",
  "dirty",
  "unpushed",
  "diverged",
  "stash",
]);
/** The fixes that save or upload versions: Laci looks for secret files before any of them. */
export const SECRET_CHECKED: ReadonlySet<string> = new Set([
  "no-remote",
  "no-commits",
  "no-git",
  "dirty",
  "unpushed",
]);
/** The fixes the terminal can run (the engine's `fix` action). Out of sync has none on purpose. */
export const TERMINAL_FIXES: ReadonlySet<string> = new Set([
  "no-remote",
  "no-commits",
  "no-git",
  "dirty",
  "unpushed",
  "stash",
  "behind",
]);

/** Whether Simple offers a fix for this problem at all. */
export const fixable = (code: string) =>
  AI_FIXES.has(code) || TERMINAL_FIXES.has(code);

// --- Home -----------------------------------------------------------------------------------------

/** What "Not now" remembers a need by: the project, and the problem or the due date. */
export const needKey = (need: Need) =>
  need.kind === "risk"
    ? `risk:${need.n.id}:${need.issue.code}`
    : `due:${need.n.id}:${need.n.meta.deadline ?? ""}`;

/** The local day, "2026-10-08": what is hidden with "Not now" comes back the next one. */
export const dayOf = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** The needs hidden today, from what "Not now" stored. Anything from another day, or unreadable, is none. */
export function hiddenToday(stored: unknown, day: string): Set<string> {
  if (!stored || typeof stored !== "object") return new Set();
  const { day: saved, keys } = stored as { day?: unknown; keys?: unknown };
  if (saved !== day || !Array.isArray(keys)) return new Set();
  return new Set(keys.filter((key): key is string => typeof key === "string"));
}

export type HomeMain =
  | MainCard
  /** Everything that needs the user is hidden until tomorrow. */
  | { kind: "quiet"; hidden: number };

export interface HomeCards {
  main: HomeMain;
  /** Up to three more, after the main card. */
  needsYou: Need[];
  /** Every need that shows, the main card's included: "See all" counts these. */
  shown: number;
}

/** Home's main card and "Needs you", once the needs hidden with "Not now" are left out. */
export function homeCards(model: HomeModel, hidden: ReadonlySet<string>): HomeCards {
  const shown = model.needs.filter((need) => !hidden.has(needKey(need)));
  const quiet = model.needs.length - shown.length;
  return {
    main: shown[0] ?? (quiet ? { kind: "quiet", hidden: quiet } : model.main),
    needsYou: shown.slice(1, 4),
    shown: shown.length,
  };
}

/**
 * Home's count in the sidebar: the needs that are "Act now" (a serious problem, or a due date that
 * has come), less the ones hidden today.
 */
export function urgentCount(model: HomeModel, hidden: ReadonlySet<string>) {
  return model.needs.filter(
    (need) =>
      (need.kind === "due" || need.issue.severity === "high") &&
      !hidden.has(needKey(need)),
  ).length;
}

/** How a due date reads: a problem only once it has come. */
export function dueTone(days: number): Tone {
  return days <= 0 ? "act" : days <= 2 ? "soon" : "fyi";
}

// --- Projects -------------------------------------------------------------------------------------

export const PROJECT_FILTERS = ["all", "needs", "active", "archived"] as const;
export type ProjectFilter = (typeof PROJECT_FILTERS)[number];
export const PROJECT_SORTS = ["recent", "name", "due", "size"] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

export interface ProjectsQuery {
  filter: ProjectFilter;
  query: string;
  sort: ProjectSort;
  /** Only the projects in this folder; none for every project folder. */
  folder: string | null;
}

export interface ProjectsModel {
  /** The projects the filter, the folder and the search let through, in the chosen order. */
  shown: Node[];
  /** How many each filter shows in the folder, before the search. */
  counts: Record<ProjectFilter, number>;
}

/** Whether every word of `query` is in the project's name, description or what it is built with. */
export function matchesQuery(n: Node, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [n.label, n.summary?.text, ...(n.stack?.labels ?? [])]
    .join(" ")
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

const dueDays = (n: Node, now: Date) =>
  deadlineInfo(n.meta.deadline, now)?.days ?? Infinity;

/**
 * Simple's project list. All leaves archived projects out; Needs you is the projects Home lists,
 * archived ones that can still lose work among them.
 */
export function projectsModel(
  snapshot: Snapshot,
  { filter, query, sort, folder }: ProjectsQuery,
  now = new Date(),
): ProjectsModel {
  const needs = new Set(homeModel(snapshot, now).needs.map((need) => need.n.id));
  const inFolder = Object.values(snapshot.nodes).filter(
    (n) => n.kind === "project" && (!folder || within(n.path, folder)),
  );
  const shows: Record<ProjectFilter, (n: Node) => boolean> = {
    all: (n) => !n.archived,
    needs: (n) => needs.has(n.id),
    active: (n) => !n.archived && n.status.value === "active",
    archived: (n) => n.archived,
  };
  const counts = Object.fromEntries(
    PROJECT_FILTERS.map((key) => [key, inFolder.filter(shows[key]).length]),
  ) as Record<ProjectFilter, number>;
  const byName = (a: Node, b: Node) => a.label.localeCompare(b.label);
  const order: Record<ProjectSort, (a: Node, b: Node) => number> = {
    recent: (a, b) => recency(a, b) || byName(a, b),
    name: byName,
    due: (a, b) => dueDays(a, now) - dueDays(b, now) || recency(a, b),
    size: (a, b) => (b.size?.total ?? 0) - (a.size?.total ?? 0) || byName(a, b),
  };
  return {
    shown: inFolder
      .filter((n) => shows[filter](n) && matchesQuery(n, query))
      .sort(order[sort]),
    counts,
  };
}

/** The folders "In:" offers: folders that hold projects, by path. */
export function projectFolders(snapshot: Snapshot): Node[] {
  const projects = Object.values(snapshot.nodes).filter(
    (n) => n.kind === "project",
  );
  return Object.values(snapshot.nodes)
    .filter(
      (n) =>
        n.kind === "folder" &&
        !n.archived &&
        projects.some((p) => p.path !== n.path && within(p.path, n.path)),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
}

// --- Clean up -------------------------------------------------------------------------------------

/**
 * Clean up's tiles, one for each kind of suggestion. AI chats that point to an old place and moves
 * left unfinished are one kind to a beginner: AI history to fix. "Space Laci uses" has a tile of
 * its own, from the `storage` request.
 */
export const CLEANUP_TILES = [
  "history",
  "space",
  "archive",
  "leftover",
  "twice",
] as const;
export type CleanupTile = (typeof CLEANUP_TILES)[number];
const TILE_OF: Record<Proposal["category"], CleanupTile> = {
  reconnect: "history",
  migration: "history",
  space: "space",
  status: "archive",
  orphan: "leftover",
  duplicate: "twice",
};

/**
 * A suggestion as the engine sends it. One about leftover AI chats is blocked when Laci can't
 * confirm that their folder is gone, with the reason; one it can confirm names the folders.
 */
export type CleanupProposal = Proposal & {
  blocked?: boolean;
  reason?: string;
  validation?: { projects?: string[] };
};

export interface CleanupItem {
  p: CleanupProposal;
  tile: CleanupTile;
  /** Laci can make the change: there is one to make, and the engine didn't block it. */
  ready: boolean;
  /** Undo can take the change back. Whatever it deletes is deleted for good. */
  undoable: boolean;
  /** The space it frees. */
  bytes: number;
  /** The projects it is about that are still here. */
  nodes: Node[];
  /** For leftover AI chats: the names of the project folders that are gone. */
  gone: string[];
}

export interface CleanupView {
  /**
   * The suggestions, those Laci can make first: the ones Undo can take back before the ones that
   * delete for good, the surest first. Those it can't make come last. Otherwise the engine's order.
   */
  items: CleanupItem[];
  /** The tiles that have suggestions, in Clean up's order: how many, what they free, the first. */
  tiles: { tile: CleanupTile; count: number; bytes: number; first: string }[];
  /** What the suggestions free together. */
  bytes: number;
  /**
   * The suggestion that is open to begin with: the first one Laci can make that Undo can take back.
   * A suggestion that deletes for good never opens by itself.
   */
  first?: string;
}

const SURE: Record<string, number> = { high: 0, med: 1, low: 2 };

/** What a suggestion deletes: the paths of freeing space, or of moving to the Trash. */
const deletes = (p: Proposal) =>
  p.action && "paths" in p.action ? p.action.paths : [];

function cleanupItem(
  snapshot: Snapshot,
  projects: Node[],
  p: CleanupProposal,
): CleanupItem {
  const paths = deletes(p);
  let nodes: Node[] = [];
  if (paths.length) {
    // Each path belongs to the project nearest to it, so a project inside another counts once.
    const owners = new Set<Node>();
    for (const path of paths) {
      const owner = projects
        .filter((n) => n.path !== path && within(path, n.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (owner) owners.add(owner);
    }
    nodes = [...owners];
  } else if (p.category === "duplicate") {
    // The engine names each copy by where it is, with the home folder as "~".
    nodes = p.ops.flatMap(
      (op) =>
        projects.find((n) => tilde(n.path, snapshot.home) === op.label) ?? [],
    );
  } else if (p.nodeId && snapshot.nodes[p.nodeId])
    nodes = [snapshot.nodes[p.nodeId]];
  return {
    p,
    tile: TILE_OF[p.category] ?? "history",
    ready: Boolean(p.action) && !p.blocked,
    undoable: !paths.length,
    bytes: paths.length
      ? nodes.reduce((sum, n) => sum + (n.size?.reclaimable ?? 0), 0)
      : 0,
    nodes,
    gone: (p.validation?.projects ?? []).map(base),
  };
}

/** Clean up's suggestions and tiles. */
export function cleanupView(snapshot: Snapshot): CleanupView {
  const rank = (item: CleanupItem) =>
    !item.ready ? 2 : item.undoable ? 0 : 1;
  const projects = Object.values(snapshot.nodes).filter(
    (n) => n.kind === "project",
  );
  const items = snapshot.proposals
    .map((p) => cleanupItem(snapshot, projects, p))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (SURE[a.p.confidence] ?? 3) - (SURE[b.p.confidence] ?? 3),
    );
  const freed = (list: CleanupItem[]) =>
    list.reduce((sum, item) => sum + (item.ready ? item.bytes : 0), 0);
  return {
    items,
    tiles: CLEANUP_TILES.flatMap((tile) => {
      const mine = items.filter((item) => item.tile === tile);
      return mine.length
        ? [{ tile, count: mine.length, bytes: freed(mine), first: mine[0].p.id }]
        : [];
    }),
    bytes: freed(items),
    first: items.find((item) => item.ready && item.undoable)?.p.id,
  };
}

/** The parts of the space Laci uses, in the order Clean up lists them: those it can empty first. */
const SPACE_ORDER: readonly string[] = [
  "removed",
  "undo",
  "legacy",
  "history",
  "journal",
  "cache",
];

/** The parts of the space Laci uses, in Clean up's order, and how much of it can be freed. */
export function laciSpace(storage: Storage): {
  parts: StoragePart[];
  free: number;
} {
  const at = (part: StoragePart) => {
    const i = SPACE_ORDER.indexOf(part.id);
    return i < 0 ? SPACE_ORDER.length : i;
  };
  return {
    parts: [...storage.parts].sort((a, b) => at(a) - at(b)),
    free: storage.parts.reduce((sum, part) => sum + Math.max(0, part.free), 0),
  };
}

// --- Activity -------------------------------------------------------------------------------------

export const ACTIVITY_FILTERS = ["all", "mine", "ai", "undo"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

/** Who made a change: you, your AI (through Laci's tools), or Laci by itself, as an automatic copy. */
export type Actor = "you" | "ai" | "laci";
export const actorOf = (entry: LogEntry): Actor =>
  entry.by === "agent" ? "ai" : entry.by === "auto" ? "laci" : "you";

const SHOWS: Record<ActivityFilter, (entry: LogEntry) => boolean> = {
  all: () => true,
  mine: (entry) => actorOf(entry) === "you",
  ai: (entry) => actorOf(entry) === "ai",
  undo: (entry) => entry.canUndo,
};

export interface ActivityView {
  /** How many changes each filter shows, before the search. */
  counts: Record<ActivityFilter, number>;
  /** The changes the filter and the search let through, by day, the newest first. */
  days: { label: string; entries: LogEntry[] }[];
  /** The newest change that can be undone, whatever the filter: the screen's filled Undo. */
  newest?: LogEntry;
}

/** Activity's changes, from the `log` reply: nothing yet while it is null. */
export function activityView(
  log: ActivityLog | null,
  filter: ActivityFilter,
  query: string,
): ActivityView {
  const all = log?.entries ?? [];
  const shows = SHOWS[filter];
  return {
    counts: Object.fromEntries(
      ACTIVITY_FILTERS.map((key) => [key, all.filter(SHOWS[key]).length]),
    ) as Record<ActivityFilter, number>,
    days: activityModel(log, { query })
      .days.map((day) => ({ ...day, entries: day.entries.filter(shows) }))
      .filter((day) => day.entries.length),
    newest: all.find((entry) => entry.canUndo),
  };
}

/**
 * The change that keeps `entry` from being undone, when it was changed again later: the newest
 * change of the same thing that still stands. Undo that one first.
 */
export function newerChange(
  log: ActivityLog | null,
  entry: LogEntry,
): LogEntry | undefined {
  if (!entry.superseded || !entry.key) return undefined;
  const all = log?.entries ?? [];
  const at = all.indexOf(entry);
  return all
    .slice(0, at < 0 ? 0 : at)
    .find(
      (newer) =>
        newer.key === entry.key && newer.state === "applied" && !newer.undoes,
    );
}
