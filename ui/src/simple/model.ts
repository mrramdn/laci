// What Simple's pages show, worked out from the scan: how safe a project is, which problems it shows
// and how each is fixed, the project list, and what Home hides until tomorrow. Pure: it imports only
// helpers.ts and selectors.ts, so the tests run it as it is.
import { deadlineInfo, liveIssues, recency, RISK, within } from "../helpers";
import { homeModel } from "../selectors";
import type { HomeModel, MainCard, Need } from "../selectors";
import type { Issue, Node, Severity, Snapshot } from "../types";

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
