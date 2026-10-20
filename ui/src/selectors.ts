// What the views show, worked out from the scan once and shared by both designs. Pure: it imports
// only helpers.ts, so ui-state-smoke can run it. Each result is kept for the snapshot (or log) it came
// from, and while the day it read stays the same (the minute, for chats), so a view that draws again
// gets the same object back.
import {
  ago,
  allSessions,
  base,
  conversations,
  dayLabel,
  deadlinesOf,
  deletable,
  latestReport,
  logKind,
  providerName,
  recency,
  reportList,
  risksOf,
  sessionKey,
  sessionsOf,
  shortDay,
  tilde,
  within,
} from "./helpers";
import type { Conversation, deadlineInfo } from "./helpers";
import type {
  ActivityLog,
  Issue,
  LogEntry,
  Node,
  Proposal,
  Report,
  Session,
  Snapshot,
  Task,
  TaskFile,
} from "./types";

/**
 * One selector's results: for each snapshot (or log) the last one, with the key it was worked out
 * for, such as the day and the options. An entry goes when its snapshot does.
 */
function cache<K extends object, T>() {
  const results = new WeakMap<K, { key: string; value: T }>();
  return (owner: K, key: string, compute: () => T): T => {
    const hit = results.get(owner);
    if (hit && hit.key === key) return hit.value;
    const value = compute();
    results.set(owner, { key, value });
    return value;
  };
}
/** The local day, for results that read the date: they are worked out again the next day. */
const dayKey = (now: Date) =>
  `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

export type DeadlineInfo = NonNullable<ReturnType<typeof deadlineInfo>>;

export interface TodayModel {
  /** Projects that could lose work: worst first, then by priority, then the most recent. */
  risks: ReturnType<typeof risksOf>;
  /** Due dates that have passed or come in the next 14 days, soonest first. */
  deadlines: ReturnType<typeof deadlinesOf>;
  /** A due date is today or has passed. */
  overdue: boolean;
  /** The five projects worked on last, archived ones left out. */
  recent: Node[];
  /** Projects not archived whose status is active. */
  activeCount: number;
  /** Open checkboxes of projects and folders not archived, the one worked on last first. */
  checks: { n: Node; t: Task }[];
  /** Files with open items under a TODO heading, the one edited last first. */
  handoffs: { n: Node; f: TaskFile; open: number }[];
}
const todayCache = cache<Snapshot, TodayModel>();
/** Detailed's Today. */
export function todayModel(snapshot: Snapshot, now = new Date()): TodayModel {
  return todayCache(snapshot, dayKey(now), () => {
    const all = Object.values(snapshot.nodes);
    const deadlines = deadlinesOf(snapshot, now);
    return {
      risks: risksOf(snapshot),
      deadlines,
      overdue: deadlines.some((d) => d.info.days <= 0),
      recent: all
        .filter((n) => n.kind === "project" && !n.archived)
        .sort(recency)
        .slice(0, 5),
      activeCount: all.filter(
        (n) =>
          n.kind === "project" && !n.archived && n.status.value === "active",
      ).length,
      checks: all
        .filter((n) => !n.archived)
        .sort(recency)
        .flatMap((n) =>
          n.tasks
            .filter((t) => t.kind === "check" && !t.done)
            .map((t) => ({ n, t })),
        ),
      handoffs: all
        .flatMap((n) =>
          n.taskFiles
            .map((f) => ({
              n,
              f,
              open: n.tasks.filter(
                (t) => t.file === f.file && t.kind === "list" && !t.done,
              ).length,
            }))
            .filter((h) => h.open && !n.archived),
        )
        .sort((a, b) => b.f.at.localeCompare(a.f.at)),
    };
  });
}

export interface NavBadges {
  /** Projects due today or overdue, or at high risk; one that is both counts once. */
  today: number;
  /** Of those, the projects due today or overdue. */
  due: number;
  /** Of those, the others: at high risk. */
  atRisk: number;
  /** Suggestions Laci can apply. */
  suggestions: number;
  /** Agent histories whose project folder is missing or unavailable. */
  detached: number;
  /**
   * Reports changed since `reportsSeen`, while the reports folder can be read. Detailed leaves the
   * count out while Reports is open.
   */
  reports: number;
}
const badgeCache = cache<Snapshot, NavBadges>();
/** The counts beside the places in the sidebar. */
export function navBadges(
  snapshot: Snapshot,
  reportsSeen: number,
  now = new Date(),
): NavBadges {
  return badgeCache(snapshot, `${dayKey(now)} ${reportsSeen}`, () => {
    const { risks, deadlines } = todayModel(snapshot, now);
    const due = new Set(
      deadlines.filter(({ info }) => info.days <= 0).map(({ n }) => n.id),
    );
    const atRisk = risks.filter(
      ({ n, issues }) =>
        !due.has(n.id) && issues.some((i) => i.severity === "high"),
    ).length;
    const reportsReady = Boolean(
      snapshot.reportsDir && !snapshot.reportsDir.error,
    );
    return {
      today: due.size + atRisk,
      due: due.size,
      atRisk,
      suggestions: snapshot.proposals.filter((p) => p.action).length,
      detached: snapshot.orphans.claude.length + snapshot.orphans.items.length,
      reports: reportsReady
        ? (snapshot.reports ?? []).filter(
            (r) => Date.parse(r.modified) > reportsSeen,
          ).length
        : 0,
    };
  });
}

const placeCache = new WeakMap<Snapshot, (path: string) => number>();
/**
 * How many projects a folder holds, itself included: the count beside each folder in Places. The
 * same function comes back for the same snapshot, and it remembers each folder it was asked about.
 */
export function placesCounts(snapshot: Snapshot): (path: string) => number {
  let count = placeCache.get(snapshot);
  if (!count) {
    const projects = Object.values(snapshot.nodes).filter(
      (n) => n.kind === "project",
    );
    const counts = new Map<string, number>();
    count = (path) => {
      let n = counts.get(path);
      if (n === undefined) {
        n = projects.filter((p) => within(p.path, path)).length;
        counts.set(path, n);
      }
      return n;
    };
    placeCache.set(snapshot, count);
  }
  return count;
}

const ownerCache = new WeakMap<Snapshot, Map<string, Node>>();
/** The project or folder each session belongs to, by `sessionKey`. Sessions outside them have none. */
export function sessionOwners(snapshot: Snapshot) {
  let owners = ownerCache.get(snapshot);
  if (!owners) {
    owners = new Map();
    for (const node of Object.values(snapshot.nodes))
      for (const session of sessionsOf(node, snapshot))
        owners.set(sessionKey(session), node);
    ownerCache.set(snapshot, owners);
  }
  return owners;
}

export type SearchSection =
  | "Projects"
  | "Folders"
  | "Sessions"
  | "Reports"
  | "To-dos"
  | "Actions";
export interface SearchHit {
  /** Says what it is: `node:`, `session:`, `report:` or `todo:` and its id, or the action's own id. */
  id: string;
  section: SearchSection;
  label: string;
  sub: string;
  /** Empty for a project or folder, which shows its kind instead. */
  icon: string;
  /** The project or folder, for those hits. */
  node: Node | null;
  /** The project a to-do is in. */
  project: string;
  /** When it last changed: `hitTime` says it as "3 d". */
  at?: string;
}
/** Something the palette can do: its id, its name, its icon, and what it says beside its name. */
export type SearchAction = readonly [
  id: string,
  label: string,
  icon: string,
  sub?: string,
];
/** Newest first, as `days()` orders them, without reading the clock: ties keep their order. */
const age = (at?: string) => (at ? -Date.parse(at) : Infinity);
const searchCache = cache<Snapshot, SearchHit[]>();
/**
 * The palette's results for `query`: every word must match. Projects and folders always show; sessions,
 * reports and to-dos only for a typed query. `actions` are matched by name and come last.
 */
export function searchAll(
  snapshot: Snapshot,
  query: string,
  actions: readonly SearchAction[] = [],
): SearchHit[] {
  // Report dates read the clock for their year.
  const key = JSON.stringify([dayKey(new Date()), query, actions]);
  return searchCache(snapshot, key, () => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (hay: string) =>
      terms.every((t) => hay.toLowerCase().includes(t));
    const found = (
      id: string,
      section: SearchSection,
      label: string,
      sub: string,
      icon: string,
      at?: string,
      project = "",
    ): SearchHit => ({
      id,
      section,
      label,
      sub,
      icon,
      node: null,
      project,
      at,
    });
    const hits = Object.values(snapshot.nodes)
      .filter((n) =>
        matches(
          `${n.label} ${n.path} ${n.summary?.text ?? ""} ${n.stack?.labels.join(" ") ?? ""}`,
        ),
      )
      .sort((a, b) => age(a.lastActivity?.at) - age(b.lastActivity?.at))
      .slice(0, 9)
      .map(
        (n): SearchHit => ({
          id: "node:" + n.id,
          section: n.kind === "folder" ? "Folders" : "Projects",
          label: n.label,
          sub: tilde(n.path, snapshot.home),
          icon: "",
          node: n,
          project: "",
          at: n.lastActivity?.at,
        }),
      );
    // Sessions, reports and to-dos only turn up for a typed query.
    const sessionHits = terms.length
      ? (() => {
          const owners = sessionOwners(snapshot);
          return allSessions(snapshot)
            .filter(
              (session) =>
                session.sourceKind !== "subagent" &&
                matches(`${session.title} ${session.firstPrompt ?? ""}`),
            )
            .slice(0, 5)
            .map((session) => {
              const n = owners.get(sessionKey(session));
              return found(
                "session:" + sessionKey(session),
                "Sessions",
                session.title,
                `${providerName(snapshot, session.provider)} · ${
                  n ? n.label : tilde(session.cwd ?? "", snapshot.home)
                }`,
                "history",
                session.updatedAt,
              );
            });
        })()
      : [];
    const todoHits = terms.length
      ? Object.values(snapshot.nodes)
          .filter((n) => n.kind === "project" && !n.archived)
          .flatMap((n) =>
            n.tasks
              .filter((t) => t.kind === "check" && !t.done)
              .map((t) => ({ n, t })),
          )
          .filter(({ n, t }) => matches(`${t.text} ${n.label}`))
          .slice(0, 5)
          .map(({ n, t }) =>
            found(
              `todo:${n.id}:${t.file}:${t.line}`,
              "To-dos",
              t.text,
              n.label,
              "check",
              undefined,
              n.id,
            ),
          )
      : [];
    const projectNames = (paths: string[]) =>
      paths.map((p) => snapshot.nodes[p]?.label ?? base(p)).join(", ");
    const reportHits = terms.length
      ? reportList(snapshot)
          .filter((r) =>
            matches(
              `${r.title} ${r.summary ?? ""} ${r.scope ?? ""} ${projectNames(r.projects)}`,
            ),
          )
          .slice(0, 5)
          .map((r) =>
            found(
              "report:" + r.id,
              "Reports",
              r.title,
              [shortDay(r.date), projectNames(r.projects)]
                .filter(Boolean)
                .join(" · "),
              "report",
              r.modified,
            ),
          )
      : [];
    return [
      ...hits.filter((i) => i.section === "Projects"),
      ...hits.filter((i) => i.section === "Folders"),
      ...sessionHits,
      ...reportHits,
      ...todoHits,
      ...actions
        .filter(([, label]) => matches(label))
        .map(([id, label, icon, sub = ""]) =>
          found(id, "Actions", label, sub, icon),
        ),
    ];
  });
}
/** How long ago a hit changed, as the palette shows it beside the hit: nothing for to-dos and actions. */
export const hitTime = (hit: SearchHit) =>
  hit.section === "To-dos" || hit.section === "Actions" ? "" : ago(hit.at);

/** The Log's filters. */
export const LOG_FILTERS = [
  "all",
  "moves",
  "projects",
  "setup",
  "agent",
] as const;
export type LogFilter = (typeof LOG_FILTERS)[number];
/** Whether the Log's filter `key` shows `entry`. All, and a key it doesn't know, show everything. */
export function inLogFilter(entry: LogEntry, key: string) {
  return key === "moves"
    ? logKind(entry) === "move"
    : key === "projects"
      ? ["meta", "todo", "notes", "new"].includes(logKind(entry))
      : key === "setup"
        ? logKind(entry) === "setup"
        : key === "agent"
          ? entry.by === "agent"
          : true;
}
export interface ActivityModel {
  /** How many entries each filter shows, before the search. */
  counts: Record<LogFilter, number>;
  /** Entries that can be undone now. */
  canUndo: number;
  /** The entries the filter, `undoable` and the search let through, by day, newest first. */
  days: { label: string; entries: LogEntry[] }[];
}
const NO_LOG: ActivityLog = { entries: [] };
const activityCache = cache<ActivityLog, ActivityModel>();
/** The Log, from the `log` reply: nothing yet when it is null. */
export function activityModel(
  log: ActivityLog | null,
  {
    filter = "all",
    query = "",
    undoable = false,
  }: { filter?: string; query?: string; undoable?: boolean } = {},
): ActivityModel {
  const source = log ?? NO_LOG;
  // Day names ("Today", "Yesterday") read the clock.
  const key = JSON.stringify([dayKey(new Date()), filter, query, undoable]);
  return activityCache(source, key, () => {
    const all = source.entries;
    const needle = query.trim().toLowerCase();
    const narrow = (e: LogEntry) =>
      (!undoable || !!e.canUndo) &&
      (!needle ||
        [e.title, e.detail, e.path].some((text) =>
          text?.toLowerCase().includes(needle),
        ));
    const days = new Map<string, LogEntry[]>();
    for (const entry of all.filter(
      (e) => inLogFilter(e, filter) && narrow(e),
    )) {
      const label = dayLabel(new Date(entry.at));
      const day = days.get(label);
      if (day) day.push(entry);
      else days.set(label, [entry]);
    }
    return {
      counts: Object.fromEntries(
        LOG_FILTERS.map((key) => [
          key,
          all.filter((e) => inLogFilter(e, key)).length,
        ]),
      ) as Record<LogFilter, number>,
      canUndo: all.filter((e) => e.canUndo).length,
      days: [...days].map(([label, entries]) => ({ label, entries })),
    };
  });
}

/**
 * Which conversations a list shows. `short`: a couple of prompts and no file changed. `old`: untouched
 * for 30 days. `outside`: in no project. `kept`: the user keeps them. `backup`: only in Laci's copy.
 */
export type ChatShow = "all" | "short" | "old" | "outside" | "kept" | "backup";
export interface ChatsModel {
  /** sessionOwners: the project or folder each session is in. */
  owners: Map<string, Node>;
  /** Every conversation, newest first. */
  list: Conversation[];
  /** The agents that have conversations. */
  providers: string[];
  /** Some conversation is only in Laci's copy, or kept: the filters that exist only then. */
  anyInBackup: boolean;
  anyKept: boolean;
  /** Short conversations, which lists fold away. */
  shortCount: number;
  /** The filter in effect: one that has nothing left falls back to all, so the list never strands empty. */
  show: ChatShow;
  /** The conversations the filters and the search let through, newest first. */
  shown: Conversation[];
  /** `shown` by project, the project with the newest conversation first; those in no project last. */
  groups: { node?: Node; items: Conversation[] }[];
  /** The shown conversations Laci can delete. */
  selectable: Conversation[];
}
const DAY = 86_400_000;
const MINUTE = 60_000;
const conversationCache = cache<Snapshot, Conversation[]>();
const chatsCache = cache<Snapshot, ChatsModel>();
/**
 * The agents' conversations, as Agents lists them. What is short, old or can be deleted depends on
 * the time, not only the day, so these are worked out again each minute.
 */
export function chatsModel(
  snapshot: Snapshot,
  {
    query = "",
    agent = "all",
    show = "all",
  }: { query?: string; agent?: string; show?: ChatShow } = {},
  now = Date.now(),
): ChatsModel {
  const minute = String(Math.floor(now / MINUTE));
  const key = JSON.stringify([minute, query, agent, show]);
  return chatsCache(snapshot, key, () => {
    const owners = sessionOwners(snapshot);
    // The search runs at every key; the conversations only once a minute.
    const list = conversationCache(snapshot, minute, () =>
      conversations(allSessions(snapshot), now),
    );
    const anyInBackup = list.some((c) => c.session.backup);
    const current: ChatShow = show === "backup" && !anyInBackup ? "all" : show;
    const needle = query.trim().toLowerCase();
    const shown = list.filter((c) => {
      const node = owners.get(sessionKey(c.session));
      if (agent !== "all" && c.session.provider !== agent) return false;
      if (current === "short" && !c.short) return false;
      if (current === "old" && now - Date.parse(c.updatedAt) < 30 * DAY)
        return false;
      if (current === "outside" && node) return false;
      if (current === "kept" && !c.session.kept) return false;
      if (current === "backup" && !c.session.backup) return false;
      if (!needle) return true;
      return [
        c.title,
        c.session.firstPrompt,
        c.session.lastPrompt,
        node?.label,
        node?.path,
        c.session.cwd,
      ].some((text) => text?.toLowerCase().includes(needle));
    });
    const byProject = new Map<string, { node?: Node; items: Conversation[] }>();
    for (const c of shown) {
      const node = owners.get(sessionKey(c.session));
      const key = node?.id ?? "";
      const group = byProject.get(key) ?? { node, items: [] };
      group.items.push(c);
      byProject.set(key, group);
    }
    return {
      owners,
      list,
      providers: [...new Set(list.map((c) => c.session.provider))],
      anyInBackup,
      anyKept: list.some((c) => c.session.kept),
      shortCount: list.filter((c) => c.short).length,
      show: current,
      shown,
      groups: [...byProject.values()].sort((a, b) =>
        !a.node !== !b.node
          ? Number(!a.node) - Number(!b.node)
          : b.items[0].updatedAt.localeCompare(a.items[0].updatedAt),
      ),
      selectable: shown.filter((c) => deletable(c, now)),
    };
  });
}

/** Tidy's kinds of suggestion, in the order it lists them. */
export const CLEANUP_KINDS = [
  "reconnect",
  "migration",
  "space",
  "duplicate",
  "orphan",
  "status",
] as const;
const CONFIDENCE: Record<string, number> = { high: 0, med: 1, low: 2 };
export interface CleanupModel {
  /** Every suggestion, of any kind. */
  total: number;
  /** Suggestions of each kind. */
  counts: Record<string, number>;
  /** The kinds that have suggestions, in Tidy's order, each with its suggestions surest first. */
  groups: { kind: Proposal["category"]; proposals: Proposal[] }[];
}
const cleanupCache = cache<Snapshot, CleanupModel>();
/** Tidy's suggestions by kind. */
export function cleanupModel(snapshot: Snapshot): CleanupModel {
  return cleanupCache(snapshot, "", () => {
    const counts: Record<string, number> = {};
    for (const p of snapshot.proposals)
      counts[p.category] = (counts[p.category] ?? 0) + 1;
    return {
      total: snapshot.proposals.length,
      counts,
      groups: CLEANUP_KINDS.filter((kind) => counts[kind]).map((kind) => ({
        kind,
        proposals: snapshot.proposals
          .filter((p) => p.category === kind)
          .sort((a, b) => CONFIDENCE[a.confidence] - CONFIDENCE[b.confidence]),
      })),
    };
  });
}

/** Something on Home that needs the user: a safety problem, or a due date that has come. */
export type Need =
  /** The worst safety problem the project has. */
  | { kind: "risk"; n: Node; issue: Issue }
  /** Due today or overdue. */
  | { kind: "due"; n: Node; due: DeadlineInfo };
/** Home's main card: what needs the user most, else the project to carry on with, if there is one. */
export type MainCard = Need | { kind: "safe"; n?: Node };
/** A project to pick up: its last chat, and its latest report while that has open items. */
export interface PickUp {
  n: Node;
  session?: Session;
  report?: Report;
}
export interface HomeModel {
  main: MainCard;
  /**
   * Every project that needs the user, once each, most pressing first: serious safety problems, then
   * due dates that have come, then the other safety problems. Within each, the project worked on last
   * comes first, except due dates: the longest overdue first. The main card is the first. An archived
   * project can still lose work, so it counts, as on Today.
   */
  needs: Need[];
  /** The three after the main card: "Needs you". */
  needsYou: Need[];
  /** The three projects worked on last, archived ones left out. */
  pickUp: PickUp[];
  /** The first five open to-dos, in Today's order. */
  nextUp: { n: Node; t: Task }[];
  /** All open to-dos. */
  todos: number;
  /** Due dates that have passed or come in the next 14 days, soonest first. */
  comingUp: { n: Node; info: DeadlineInfo }[];
  /** Projects not archived. */
  projects: number;
  /**
   * Of those, the ones with no version history, such as a folder of notes: nothing of them is saved
   * or uploaded.
   */
  noHistory: number;
  /** No project folder is chosen yet. */
  noFolders: boolean;
}
const homeCache = cache<Snapshot, HomeModel>();
/** Simple's Home. */
export function homeModel(snapshot: Snapshot, now = new Date()): HomeModel {
  return homeCache(snapshot, dayKey(now), () => {
    const today = todayModel(snapshot, now);
    const serious = today.risks
      .filter(({ issues }) => issues[0].severity === "high")
      .sort((a, b) => recency(a.n, b.n));
    const listed = new Set(serious.map(({ n }) => n.id));
    const due = today.deadlines.filter(
      ({ n, info }) => info.days <= 0 && !listed.has(n.id),
    );
    for (const { n } of due) listed.add(n.id);
    const other = today.risks
      .filter(({ n }) => !listed.has(n.id))
      .sort((a, b) => recency(a.n, b.n));
    const risk = ({ n, issues }: { n: Node; issues: Issue[] }): Need => ({
      kind: "risk",
      n,
      issue: issues[0],
    });
    const needs: Need[] = [
      ...serious.map(risk),
      ...due.map(({ n, info }): Need => ({ kind: "due", n, due: info })),
      ...other.map(risk),
    ];
    const projects = Object.values(snapshot.nodes).filter(
      (n) => n.kind === "project" && !n.archived,
    );
    return {
      main: needs[0] ?? { kind: "safe", n: today.recent[0] },
      needs,
      needsYou: needs.slice(1, 4),
      pickUp: today.recent.slice(0, 3).map((n) => {
        const report = latestReport(snapshot, n.path);
        return {
          n,
          session: sessionsOf(n, snapshot).find((s) => !s.parentId),
          report: report?.open.length ? report : undefined,
        };
      }),
      nextUp: today.checks.slice(0, 5),
      todos: today.checks.length,
      comingUp: today.deadlines,
      projects: projects.length,
      noHistory: projects.filter((n) => !n.git).length,
      noFolders: !snapshot.roots.length,
    };
  });
}
