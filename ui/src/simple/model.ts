// What Simple's pages show, worked out from the scan: how safe a project is, which problems it shows
// and how each is fixed, the project list, and what Home hides until tomorrow. Pure: it imports only
// helpers.ts and selectors.ts, so the tests run it as it is.
import {
  APP_NAMES,
  base,
  cap,
  deadlineInfo,
  deletable,
  isWindowsPath,
  liveIssues,
  parentOf,
  pathKey,
  recency,
  RISK,
  sessionKey,
  tilde,
  within,
} from "../helpers";
import type { Conversation } from "../helpers";
import { activityModel, chatsModel, homeModel } from "../selectors";
import type { HomeModel, MainCard, Need } from "../selectors";
import type { AgentCapabilities } from "../agent-launch";
import type {
  ActivityLog,
  Apps,
  ConnectorState,
  Issue,
  LogEntry,
  McpStatus,
  Node,
  Proposal,
  Report,
  ReportsDir,
  SetupInfo,
  Severity,
  Snapshot,
  Storage,
  StoragePart,
  Suggestion,
  TerminalTarget,
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

// --- AI helpers -----------------------------------------------------------------------------------

/** The filters above Chats (design-research §3.3). */
export const CHAT_FILTERS = ["all", "week", "old", "outside", "kept", "backup"] as const;
export type ChatFilter = (typeof CHAT_FILTERS)[number];

const DAY_MS = 864e5;

/**
 * Whether `filter` shows a chat: changed in the last 7 days, untouched for 30, in no project, kept, or
 * only in Laci's copy. The last four mean what Detailed's filters of the same name mean.
 */
function showsChat(
  filter: ChatFilter,
  c: Conversation,
  owners: Map<string, Node>,
  now: number,
) {
  const age = now - Date.parse(c.updatedAt);
  switch (filter) {
    case "week":
      return age < 7 * DAY_MS;
    case "old":
      return age >= 30 * DAY_MS;
    case "outside":
      return !owners.has(sessionKey(c.session));
    case "kept":
      return Boolean(c.session.kept);
    case "backup":
      return Boolean(c.session.backup);
    default:
      return true;
  }
}

export interface ChatGroup {
  /** The project or folder the chats were in; none for the chats in no project. */
  node?: Node;
  /** The chats to list, newest first. Quick ones are folded away, unless there are only quick ones. */
  chats: Conversation[];
  /** The quick chats folded into one line. */
  quick: Conversation[];
}

export interface HelperChats {
  /** The filter in effect: one that is no longer offered goes back to All. */
  filter: ChatFilter;
  /** The filters to offer: Kept and Only in Laci's copy only while some chat is. */
  filters: ChatFilter[];
  /** How many chats each filter shows, before the search. */
  counts: Record<ChatFilter, number>;
  /** The chats the filter and the search let through, newest first. */
  shown: Conversation[];
  /** `shown` by project, the project with the newest chat first; the chats in no project last. */
  groups: ChatGroup[];
  /** The shown chats Laci can delete: the ones Select can pick. */
  selectable: Conversation[];
  /** Every chat, newest first. */
  all: Conversation[];
}

/**
 * AI helpers › Chats: the chats of every project, by project, through chatsModel (its search) and
 * Simple's filters. Quick chats fold into one line in each project.
 */
export function helperChats(
  snapshot: Snapshot,
  { filter, query }: { filter: ChatFilter; query: string },
  now = Date.now(),
): HelperChats {
  const model = chatsModel(snapshot, { query }, now);
  const { owners, list } = model;
  const filters = CHAT_FILTERS.filter((key) =>
    key === "kept" ? model.anyKept : key === "backup" ? model.anyInBackup : true,
  );
  const current = filters.includes(filter) ? filter : "all";
  const counts = Object.fromEntries(
    CHAT_FILTERS.map((key) => [
      key,
      list.filter((c) => showsChat(key, c, owners, now)).length,
    ]),
  ) as Record<ChatFilter, number>;
  const shown = model.shown.filter((c) => showsChat(current, c, owners, now));
  const byNode = new Map<string, { node?: Node; items: Conversation[] }>();
  for (const c of shown) {
    const node = owners.get(sessionKey(c.session));
    const group = byNode.get(node?.id ?? "") ?? { node, items: [] };
    group.items.push(c);
    byNode.set(node?.id ?? "", group);
  }
  const groups = [...byNode.values()]
    .sort((a, b) =>
      !a.node !== !b.node
        ? Number(!a.node) - Number(!b.node)
        : b.items[0].updatedAt.localeCompare(a.items[0].updatedAt),
    )
    .map(({ node, items }): ChatGroup => {
      const long = items.filter((c) => !c.short);
      return long.length
        ? { node, chats: long, quick: items.filter((c) => c.short) }
        : { node, chats: items, quick: [] };
    });
  return {
    filter: current,
    filters,
    counts,
    shown,
    groups,
    selectable: shown.filter((c) => deletable(c, now)),
    all: list,
  };
}

/** An AI tool as AI helpers › Tools shows it: one Laci shows the chats of, or one it knows of. */
export interface ToolCard {
  id: string;
  /** The AI's name in Laci's requests, such as `claude`. */
  provider: string;
  name: string;
  /** What Laci reads of it, in the engine's words. */
  about: string;
  /** Laci shows its chats: the tool as Laci added it. */
  connector?: ConnectorState;
  /** A tool Laci knows but hasn't added. */
  suggestion?: Suggestion;
  /** Laci can start it (once added): a new chat, or one picked up again. */
  launch: boolean;
  /** Laci can let it use Laci: it keeps a list of programs it may ask. */
  mcp: boolean;
  /** Its chats are on this computer: it has been used here. */
  found: boolean;
}

/**
 * The tools of Tools, in the order Detailed's Agents shows them: the ones Laci comes with that are
 * added, then the user's own, then the ones Laci knows but hasn't added.
 */
export function toolCards(snapshot: Snapshot): ToolCard[] {
  return [
    ...[...snapshot.connectors]
      .sort((a, b) => Number(b.builtin) - Number(a.builtin))
      .map(
        (c): ToolCard => ({
          id: c.id,
          provider: c.provider ?? c.id,
          name: c.name,
          about: c.about,
          connector: c,
          launch: c.capabilities?.launch === true,
          mcp: c.capabilities?.mcp === true,
          found: c.present,
        }),
      ),
    ...snapshot.suggestions.map(
      (x): ToolCard => ({
        id: x.id,
        provider: x.id,
        name: x.name,
        about: x.about,
        suggestion: x,
        launch: Boolean(x.launch),
        mcp: false,
        found: x.found,
      }),
    ),
  ];
}

export type Install = "installed" | "cant-start" | "missing";

/**
 * Whether an AI's program is there to start: installed; installed but out of Laci's reach (its chats
 * are on this computer, yet Laci can't find its program); or not installed. Unknown until
 * `agent/models` says.
 */
export function installOf(tool: ToolCard, installed?: boolean): Install | undefined {
  if (installed === undefined) return undefined;
  return installed ? "installed" : tool.found ? "cant-start" : "missing";
}

/** Whether an AI can use Laci: Yes, Not yet, Uses another Laci or Turned off (design-research). */
export type CanUse = "yes" | "not-yet" | "other" | "off";
const CAN_USE: Record<McpStatus["state"], CanUse> = {
  registered: "yes",
  missing: "not-yet",
  other: "other",
  off: "off",
};
/** From the `agent/mcp` request's state; unknown until it says. */
export const canUseOf = (status?: McpStatus): CanUse | undefined =>
  status ? CAN_USE[status.state] : undefined;

/**
 * What an AI starts with: the model, by its name, and the thinking effort it was started with last.
 * None of either means the AI's own default.
 */
export function startsWith(caps?: AgentCapabilities): { model?: string; effort?: string } {
  const saved = caps?.remembered;
  if (!caps || !saved) return {};
  const model = saved.model
    ? (caps.models.find((m) => m.id === saved.model)?.label ?? saved.model)
    : undefined;
  return { model, effort: saved.effort ?? undefined };
}

/**
 * The first AI that deletes its own chats while Laci's copy is behind, from the scan's warning: its
 * name in Laci's requests, and after how many days, which the AI's own setting decides. The scan
 * says the days only in the warning's title; without them, `days` is missing.
 */
export function chatsAtRisk(snapshot: Snapshot): { provider: string; days?: number } | undefined {
  const warning = snapshot.warnings.find((w) => w.code.endsWith("-cleanup"));
  if (!warning) return undefined;
  const days = Number(/\bafter (\d+) days?\b/.exec(warning.title)?.[1]);
  return {
    provider: warning.code.slice(0, -"-cleanup".length),
    ...(days > 0 ? { days } : {}),
  };
}

/** How many chats an AI has had, and when the newest of them changed. `chats` is newest first. */
export function toolUse(chats: Conversation[], provider: string) {
  const mine = chats.filter((c) => c.session.provider === provider);
  return { chats: mine.length, last: mine[0]?.updatedAt };
}

const HEADER_FIELD = /^[-*+]\s+\*\*\s*(date|sessions?|projects?)\s*:?\s*\*\*/i;
/**
 * A summary's text without its title and its date, chat and project lines, which the reader shows
 * above it already. As Detailed's Reports reads one (views/reports.tsx).
 */
export function summaryBody(raw: string) {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.startsWith("# ")) i++;
  for (;;) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length || !HEADER_FIELD.test(lines[i])) break;
    i++;
    while (i < lines.length && /^\s+\S/.test(lines[i])) i++;
  }
  return lines.slice(i).join("\n");
}

/**
 * The summary a link in a summary names: another file in the same folder, by its name or by its
 * path. As Detailed's Reports follows one (views/reports.tsx).
 */
export function summaryLink(href: string, reports: Report[], folder: string) {
  let name = href.split(/[?#]/)[0];
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not encoded: taken as written.
  }
  if (isWindowsPath(folder)) {
    if (isWindowsPath(name) && pathKey(parentOf(name)) === pathKey(folder))
      name = base(name);
    name = name.replace(/\\/g, "/");
  } else if (name.startsWith(folder + "/")) {
    name = name.slice(folder.length + 1);
  }
  name = name.replace(/^\.\//, "");
  return name.includes("/") ? undefined : reports.find((r) => r.id === name);
}

/**
 * Where the focus goes when the control that had it is gone: the first after it, of the controls
 * `around` it then, that can still take it, else the nearest before it. None when it wasn't one of
 * them.
 */
export function focusAfter<T>(around: T[], gone: T, usable: (control: T) => boolean) {
  const at = around.indexOf(gone);
  if (at < 0) return undefined;
  return [...around.slice(at + 1), ...around.slice(0, at).reverse()].find(usable);
}

// --- Settings -------------------------------------------------------------------------------------

/**
 * What Settings keeps until "Save changes": every field of the `setup/save` request, which saves them
 * all at once, as Detailed's Settings sends them.
 */
export interface SettingsDraft {
  roots: string[];
  /** Empty for the nearest _archive folder. */
  archiveDir: string;
  /** Empty for no summaries. */
  reportsDir: string;
  /** The AI tools Laci comes with that it shows the chats of. */
  presets: string[];
  apps: Apps;
  terminalTarget: TerminalTarget;
}

/** The settings as `setup/info` says they are saved. */
export function draftOf(info: SetupInfo): SettingsDraft {
  return {
    roots: [...info.roots],
    archiveDir: info.archiveDir ?? "",
    reportsDir: info.reportsDir ?? "",
    presets: [...info.presets],
    apps: { ...info.apps },
    terminalTarget: info.terminalTarget ?? "internal",
  };
}

const sameFolders = (a: string[], b: string[]) =>
  a.length === b.length &&
  a.every((path) => b.some((other) => pathKey(other) === pathKey(path)));
const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** Whether the draft differs from what is saved. The order of folders and tools doesn't count. */
export function draftChanged(draft: SettingsDraft, saved: SettingsDraft) {
  return (
    !sameFolders(draft.roots, saved.roots) ||
    draft.archiveDir !== saved.archiveDir ||
    draft.reportsDir !== saved.reportsDir ||
    !sameIds(draft.presets, saved.presets) ||
    draft.apps.editor !== saved.apps.editor ||
    draft.apps.files !== saved.apps.files ||
    draft.apps.terminal !== saved.apps.terminal ||
    draft.terminalTarget !== saved.terminalTarget
  );
}

/** The draft with `path` among the project folders, once: on Windows, case doesn't make another. */
export function withRoot(draft: SettingsDraft, path: string): SettingsDraft {
  return draft.roots.some((root) => pathKey(root) === pathKey(path))
    ? draft
    : { ...draft, roots: [...draft.roots, path] };
}

/** The draft without the project folder `path`. */
export function withoutRoot(draft: SettingsDraft, path: string): SettingsDraft {
  return {
    ...draft,
    roots: draft.roots.filter((root) => pathKey(root) !== pathKey(path)),
  };
}

/** The draft with the AI tool `id` shown or not. */
export function withTool(draft: SettingsDraft, id: string, on: boolean): SettingsDraft {
  const rest = draft.presets.filter((preset) => preset !== id);
  return { ...draft, presets: on ? [...rest, id] : rest };
}

/** The folders "Suggest folders" found that aren't project folders yet, the most projects first. */
export function suggestedFolders(
  candidates: { path: string; repos: number }[],
  roots: string[],
) {
  return candidates
    .filter((c) => !roots.some((root) => pathKey(root) === pathKey(c.path)))
    .sort((a, b) => b.repos - a.repos);
}

/** The apps Settings offers for one choice: those installed, and the one chosen even when it isn't. */
export function appChoices(installed: string[], chosen: string) {
  return [...new Set([...installed, chosen])].filter(Boolean).map((app) => ({
    app,
    name: APP_NAMES[app] ?? cap(app),
    installed: installed.includes(app),
  }));
}

/** The AI tools Settings lists: the ones Laci comes with, added or not, by name (as Detailed's do). */
export function catalogTools(snapshot: Snapshot) {
  return [
    ...snapshot.connectors
      .filter((c) => c.builtin)
      .map((c) => ({ id: c.id, name: c.name, found: c.present })),
    ...snapshot.suggestions.map((x) => ({ id: x.id, name: x.name, found: x.found })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where the summaries folder stands: changed and not saved yet, none chosen, one Laci can't read, or
 * one it reads.
 */
export type SummariesFolder = "unsaved" | "off" | "unreadable" | "read";
export function summariesFolder(draft: string, saved?: ReportsDir): SummariesFolder {
  if (draft !== (saved?.path ?? "")) return "unsaved";
  if (!saved) return "off";
  return saved.error ? "unreadable" : "read";
}

/** How often Laci looks for a new version: the `updates` request's choices. */
export const UPDATE_CHOICES = ["daily", "off"] as const;
export type UpdateChoice = (typeof UPDATE_CHOICES)[number];
