// ui/src/selectors.ts against the views it was taken from. Each selector must give what the view's
// own code gives today: that code is copied below as the reference, and both run on the preview's
// fixtures and on scans made by hand. Then Simple's Home, and what is remembered for how long.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "../ui-module.mjs";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../ui/src/preview/fixtures.json", import.meta.url),
    "utf8",
  ),
);
const helpers = load("helpers.ts");
const selectors = load("selectors.ts");
const words = load("words.ts");
const HOME = "/home/demo";
const ROOT = `${HOME}/project`;
const DAY = 864e5;

/** A copy of the preview's scan of the demo home: no test sees another's changes or kept results. */
const fixture = () => structuredClone(fixtures.snapshot);
/**
 * Runs `body` with Date.now() standing still. Some orders compare two readings of the clock, so two
 * projects changed at the same moment could swap places if it ticked in between.
 */
function stillClock(body) {
  const real = Date.now;
  const at = real();
  Date.now = () => at;
  try {
    return body();
  } finally {
    Date.now = real;
  }
}
const iso = (ms) => new Date(ms).toISOString();

/**
 * The demo home with more in it: projects changed at the same moment, a folder and an archived
 * project with to-dos, a checked to-do, a handoff that is all done, a muted check, more sessions
 * (kept, only in the backup, short, a subagent's, one outside every project) and more reports.
 */
function busier() {
  const s = fixture();
  const now = Date.now();
  const node = (path) => s.nodes[path];
  const clients = node(`${ROOT}/clients`);
  clients.tasks = [
    { text: "Invoice September", done: false, kind: "check", file: "TODO.md", line: 2 },
    { text: "Call the printer", done: true, kind: "check", file: "TODO.md", line: 3 },
    { text: "Chase the deposit", done: false, kind: "list", file: "TODO.md", line: 6 },
  ];
  clients.taskFiles = [
    { file: "TODO.md", at: "2026-10-01T09:00:00.000Z", open: 2, done: 1 },
  ];
  const old = node(`${ROOT}/_archive/old-portfolio`);
  old.tasks = [
    { text: "Move the domain", done: false, kind: "check", file: ".laci.md", line: 5 },
    { text: "Old next step", done: false, kind: "list", file: "TODO.md", line: 2 },
  ];
  old.taskFiles = [{ file: "TODO.md", at: "2026-10-05T09:00:00.000Z", open: 1, done: 0 }];
  const dotfiles = node(`${ROOT}/side/dotfiles`);
  dotfiles.lastActivity = { ...node(`${ROOT}/infra-notes`).lastActivity };
  dotfiles.tasks = [
    { text: "Back up the keys", done: false, kind: "check", file: "README.md", line: 9 },
    { text: "All done here", done: true, kind: "list", file: "NOTES.md", line: 3 },
  ];
  dotfiles.taskFiles = [{ file: "NOTES.md", at: "2026-10-06T09:00:00.000Z", open: 0, done: 1 }];
  const habit = node(`${ROOT}/side/habit-app`);
  habit.meta = { ...habit.meta, quiet: "no-remote" };
  habit.issues = habit.issues.map((i) =>
    i.code === "no-remote" ? { ...i, muted: true } : i,
  );
  delete node(`${ROOT}/thesis`).lastActivity;
  const session = (sessionId, cwd, extra = {}) => ({
    provider: "claude",
    sessionId,
    title: sessionId,
    titleSource: "provider",
    cwd,
    sourceKind: "cli",
    updatedAt: iso(now - 40 * 60_000),
    resumeCapability: "supported",
    file: `/logs/${sessionId}.jsonl`,
    prompts: 9,
    filesChanged: 3,
    ...extra,
  });
  s.sessions.push(
    session("kept-one", `${ROOT}/clients/kopi-landing`, { kept: true, firstPrompt: "Fix the hero" }),
    session("backup-one", `${ROOT}/infra-notes`, { backup: true, lastPrompt: "swap file" }),
    session("quick", `${ROOT}/side/dotfiles`, { prompts: 1, filesChanged: 0 }),
    session("still-going", `${ROOT}/side/dotfiles`, {
      prompts: 1,
      filesChanged: 0,
      updatedAt: iso(now - 60_000),
    }),
    session("just-ended", `${ROOT}/side/dotfiles`, { updatedAt: iso(now - 4 * 60_000) }),
    session("helper", `${ROOT}/clients/kopi-landing`, {
      parentId: "kept-one",
      sourceKind: "subagent",
    }),
    session("elsewhere", "/mnt/scratch/tool", { updatedAt: iso(now - 50 * DAY) }),
    session("very-old", `${ROOT}/thesis/campus-lms`, { updatedAt: iso(now - 90 * DAY) }),
    { ...session("codex-one", `${ROOT}/clients/acme-store`), provider: "codex" },
  );
  s.reports.push({
    ...s.reports[0],
    id: "2026-10-07-second-look.md",
    title: "A second look at checkout",
    modified: "2026-10-07T18:00:00.000Z",
    open: [],
    openCount: 0,
  });
  return s;
}

// ── Today ──────────────────────────────────────────────────────────────────────────────────────────

/** views/today.tsx, lines 31-70, and the red "due" chip at line 114. */
function todayView(snapshot) {
  const { deadlinesOf, recency, risksOf } = helpers;
  const all = Object.values(snapshot.nodes);
  const risks = risksOf(snapshot);
  const deadlines = deadlinesOf(snapshot);
  const recent = all
    .filter((n) => n.kind === "project" && !n.archived)
    .sort(recency)
    .slice(0, 5);
  const activeCount = all.filter(
    (n) => n.kind === "project" && !n.archived && n.status.value === "active",
  ).length;
  const checks = all
    .filter((n) => !n.archived)
    .sort(recency)
    .flatMap((n) =>
      n.tasks
        .filter((t) => t.kind === "check" && !t.done)
        .map((t) => ({ n, t })),
    );
  const handoffs = all
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
    .sort((a, b) => b.f.at.localeCompare(a.f.at));
  const overdue = deadlines.some((d) => d.info.days <= 0);
  return { risks, deadlines, overdue, recent, activeCount, checks, handoffs };
}

export async function todayGivesWhatTodaysViewWorksOut() {
  for (const snapshot of [fixture(), busier()])
    stillClock(() =>
      assert.deepEqual(selectors.todayModel(snapshot), todayView(snapshot)),
    );
}

// ── Sidebar ────────────────────────────────────────────────────────────────────────────────────────

/** views/sidebar.tsx, lines 24-48. `s` is the store. */
function sidebarView(snapshot, s) {
  const { deadlinesOf, risksOf, todayBadge } = helpers;
  const hot = todayBadge(snapshot);
  // Same projects todayBadge counts: due today or overdue, or a high risk. One that is both counts once.
  const due = new Set(
    deadlinesOf(snapshot)
      .filter(({ info }) => info.days <= 0)
      .map(({ n }) => n.id),
  );
  const atRisk = risksOf(snapshot).filter(
    ({ n, issues }) =>
      !due.has(n.id) && issues.some((i) => i.severity === "high"),
  ).length;
  const suggestions = snapshot.proposals.filter((p) => p.action).length;
  const detached =
    snapshot.orphans.claude.length + snapshot.orphans.items.length;
  const reportsReady = Boolean(
    snapshot.reportsDir && !snapshot.reportsDir.error,
  );
  // useMemo(…, [snapshot.reports, s.reportsSeen])
  const newReports = (snapshot.reports ?? []).filter(
    (r) => Date.parse(r.modified) > s.reportsSeen,
  ).length;
  const freshReports = reportsReady && s.view !== "reports" ? newReports : 0;
  return { hot, due: due.size, atRisk, suggestions, detached, freshReports };
}

export async function theSidebarCountsAreTheSidebarsOwn() {
  const scans = [fixture(), busier()];
  // Overdue and at high risk at once: counted once.
  const both = fixture();
  both.nodes[`${ROOT}/clients/kopi-landing`].meta.deadline = "2020-01-01";
  const unreadable = fixture();
  unreadable.reportsDir = { ...unreadable.reportsDir, error: "Permission denied" };
  scans.push(both, unreadable);
  for (const snapshot of scans)
    for (const reportsSeen of [0, Date.parse("2026-10-05T12:00:00.000Z"), Date.now()]) {
      const view = sidebarView(snapshot, { reportsSeen, view: "today" });
      const badges = selectors.navBadges(snapshot, reportsSeen);
      assert.deepEqual(badges, {
        today: view.hot,
        due: view.due,
        atRisk: view.atRisk,
        suggestions: view.suggestions,
        detached: view.detached,
        reports: view.freshReports,
      });
    }
  assert.equal(
    selectors.navBadges(both, 0).today,
    selectors.navBadges(fixture(), 0).today,
  );
  assert.equal(selectors.navBadges(unreadable, 0).reports, 0);
  assert.equal(selectors.navBadges(fixture(), 0).reports, 7);
}

/** views/sidebar.tsx, lines 434-436: the count on one row of Places. */
const treeRowCount = (snapshot, path) =>
  Object.values(snapshot.nodes).filter(
    (n) => n.kind === "project" && helpers.within(n.path, path),
  ).length;

export async function placesCountTheProjectsInEachFolder() {
  const snapshot = fixture();
  const count = selectors.placesCounts(snapshot);
  const paths = new Set(["/", "/home", HOME, `${ROOT}/`, `${ROOT}/cl`, "/mnt/elsewhere"]);
  for (const path of [...snapshot.roots, ...Object.keys(snapshot.nodes)]) {
    paths.add(path);
    paths.add(helpers.parentOf(path));
  }
  for (const path of paths)
    assert.equal(count(path), treeRowCount(snapshot, path), path);
  assert.equal(count(ROOT), 7);
  assert.equal(count(`${ROOT}/clients`), 2);
  // The same function again, which has kept what it counted.
  assert.equal(selectors.placesCounts(snapshot), count);
}

// ── Palette ────────────────────────────────────────────────────────────────────────────────────────

/** palette.tsx, lines 35-179: what the palette lists for `query`. */
function paletteView(snapshot, query) {
  const {
    ago,
    allSessions,
    base,
    days,
    providerName,
    reportList,
    sessionKey,
    sessionsOf,
    shortDay,
    tilde,
  } = helpers;
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (hay) => terms.every((t) => hay.toLowerCase().includes(t));
  const hits = Object.values(snapshot.nodes)
    .filter((n) =>
      matches(
        `${n.label} ${n.path} ${n.summary?.text ?? ""} ${n.stack?.labels.join(" ") ?? ""}`,
      ),
    )
    .sort((a, b) => days(a.lastActivity?.at) - days(b.lastActivity?.at))
    .slice(0, 9)
    .map((n) => ({
      id: "node:" + n.id,
      section: n.kind === "folder" ? "Folders" : "Projects",
      label: n.label,
      sub: tilde(n.path, snapshot.home),
      icon: "",
      project: "",
      node: n,
      acc: ago(n.lastActivity?.at),
    }));
  const found = (id, section, label, sub, icon, acc, project = "") => ({
    id,
    section,
    label,
    sub,
    icon,
    acc,
    project,
    node: null,
  });
  // Sessions and to-dos only turn up for a typed query.
  const sessionHits = terms.length
    ? (() => {
        const owner = new Map();
        for (const n of Object.values(snapshot.nodes))
          for (const session of sessionsOf(n, snapshot))
            owner.set(sessionKey(session), n);
        return allSessions(snapshot)
          .filter(
            (session) =>
              session.sourceKind !== "subagent" &&
              matches(`${session.title} ${session.firstPrompt ?? ""}`),
          )
          .slice(0, 5)
          .map((session) => {
            const n = owner.get(sessionKey(session));
            return found(
              "session:" + sessionKey(session),
              "Sessions",
              session.title,
              `${providerName(snapshot, session.provider)} · ${
                n ? n.label : tilde(session.cwd ?? "", snapshot.home)
              }`,
              "history",
              ago(session.updatedAt),
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
            "",
            n.id,
          ),
        )
    : [];
  const projectNames = (paths) =>
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
            ago(r.modified),
          ),
        )
    : [];
  const actions = paletteActions(snapshot)
    .filter(([, label]) => matches(label))
    .map(([id, label, icon]) => ({
      id,
      label,
      icon,
      sub: "",
      section: "Actions",
      project: "",
      node: null,
      acc: "",
    }));
  return [
    ...hits.filter((i) => i.section === "Projects"),
    ...hits.filter((i) => i.section === "Folders"),
    ...sessionHits,
    ...reportHits,
    ...todoHits,
    ...actions,
  ];
}
/** palette.tsx, lines 149-160. */
const paletteActions = (snapshot) => [
  ["view:today", "Open Today", "inbox"],
  ["view:tidy", "Open Tidy up", "sparkles"],
  ["view:agents", "Open Agents", "history"],
  ...(snapshot.reportsDir ? [["view:reports", "Open Reports", "report"]] : []),
  ["view:log", "Open Log", "scroll"],
  ["new", "New project", "plus"],
  ["shortcuts", "Keyboard shortcuts", "keyboard"],
  ["view:settings", "Open Settings", "gear"],
  ["rescan", "Scan again", "refresh"],
  ["theme", "Switch theme", "moon"],
];

export async function theSearchFindsWhatThePaletteFinds() {
  const queries = [
    "",
    "  ",
    "acme",
    "ACME   store",
    "checkout",
    "kopi landing",
    "notes",
    "open",
    "scan",
    "safari",
    "ssh",
    "astro",
    "project",
    "clients",
    "/home/demo/project/side",
    "midtrans",
    "fix the hero",
    "swap",
    "elsewhere",
    "helper",
    "domain",
    "nothing matches this",
  ];
  for (const snapshot of [fixture(), busier()])
    for (const query of queries)
      stillClock(() => {
        const hits = selectors
          .searchAll(snapshot, query, paletteActions(snapshot))
          .map(({ at: _at, ...hit }) => ({
            ...hit,
            acc: selectors.hitTime({ ...hit, at: _at }),
          }));
        assert.deepEqual(hits, paletteView(snapshot, query), `"${query}"`);
      });
}

export async function theSearchListsActionsOnlyWhenGiven() {
  const hits = selectors.searchAll(fixture(), "");
  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit) => hit.node));
}

// ── Log ────────────────────────────────────────────────────────────────────────────────────────────

/** views/log.tsx, lines 7-49, and the counts on the filter chips at 87-91. `s` is the store. */
const LOG_FILTERS = [
  ["all", "All"],
  ["moves", "Moves and archives"],
  ["projects", "Project edits"],
  ["setup", "Settings"],
  ["agent", "By agents"],
];
function logView(log, s, query, undoable) {
  const { dayLabel, logKind } = helpers;
  const filter = (entry, key) =>
    key === "moves"
      ? logKind(entry) === "move"
      : key === "projects"
        ? ["meta", "todo", "notes", "new"].includes(logKind(entry))
        : key === "setup"
          ? logKind(entry) === "setup"
          : key === "agent"
            ? entry.by === "agent"
            : true;
  const needle = query.trim().toLowerCase();
  const canUndo = log?.entries.filter((e) => e.canUndo).length ?? 0;
  const narrow = (e) =>
    (!undoable || !!e.canUndo) &&
    (!needle ||
      [e.title, e.detail, e.path].some((text) =>
        text?.toLowerCase().includes(needle),
      ));
  const groups = new Map();
  for (const entry of log?.entries.filter(
    (e) => filter(e, s.logFilter) && narrow(e),
  ) ?? []) {
    const label = dayLabel(new Date(entry.at));
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }
  const counts = Object.fromEntries(
    LOG_FILTERS.filter(([key]) => key !== "all").map(([key]) => [
      key,
      log?.entries.filter((e) => filter(e, key)).length ?? 0,
    ]),
  );
  return { canUndo, groups, counts };
}

/** A Log of every kind of entry, over today, yesterday, last week and last year. */
function activity() {
  const now = Date.now();
  let serial = 0;
  const entry = (back, title, extra = {}) => ({
    id: `e${++serial}`,
    at: iso(now - back),
    by: "app",
    title,
    state: "applied",
    canUndo: false,
    ...extra,
  });
  return {
    entries: [
      entry(60_000, "Archived acme-store", {
        journal: "j1",
        canUndo: true,
        path: `${ROOT}/clients/acme-store`,
      }),
      entry(120_000, "Undid: Moved notes", { undoes: "e9", by: "agent" }),
      entry(DAY, "Set priority of kopi-landing", { key: "meta:priority", canUndo: true }),
      entry(DAY + 1000, "Ticked a to-do in acme-store", {
        key: "todo:toggle",
        by: "agent",
        detail: "Send staging link",
      }),
      entry(3 * DAY, "Edited notes", {
        key: "notes:x",
        canUndo: true,
        detail: "Context for the SSL renewal",
      }),
      entry(3 * DAY + 5, "Connected Codex", { key: "connector:codex" }),
      entry(8 * DAY, "Changed settings", { key: "settings", canUndo: true }),
      entry(9 * DAY, "Created habit-app", { path: `${ROOT}/side/habit-app` }),
      entry(400 * DAY, "Backed up agent logs", { superseded: true }),
      entry(30 * 60_000, "Moved late", { journal: "j2", by: "agent", canUndo: true }),
    ],
    file: "~/.local/share/laci/laci.log",
  };
}

export async function theLogGivesWhatTheLogViewWorksOut() {
  const logs = [fixtures.log, activity(), { entries: [], error: "Couldn’t read the log" }, null];
  for (const log of logs)
    for (const [filter] of LOG_FILTERS)
      for (const query of ["", "acme", "  SSL ", "zzz"])
        for (const undoable of [false, true]) {
          const view = logView(log, { logFilter: filter }, query, undoable);
          const model = selectors.activityModel(log, { filter, query, undoable });
          assert.equal(model.canUndo, view.canUndo);
          assert.deepEqual(
            model.days,
            [...view.groups].map(([label, entries]) => ({ label, entries })),
          );
          for (const [key, count] of Object.entries(view.counts))
            assert.equal(model.counts[key], count, key);
          assert.equal(model.counts.all, log?.entries.length ?? 0);
        }
  // One group a day, even for an entry out of order.
  const labels = selectors.activityModel(activity()).days.map((d) => d.label);
  assert.equal(new Set(labels).size, labels.length);
}

// ── Agents ─────────────────────────────────────────────────────────────────────────────────────────

/** views/agents.tsx, lines 309-364, with the counts and chips at 376, 385 and 428. */
function sessionsView(snapshot, { query = "", agent = "all", show = "all" }) {
  const { allSessions, conversations, deletable, sessionKey, sessionsOf } =
    helpers;
  const DAY = 86_400_000;
  const all = allSessions(snapshot);
  // useMemo(…, [snapshot])
  const owners = (() => {
    const map = new Map();
    for (const node of Object.values(snapshot.nodes))
      for (const session of sessionsOf(node, snapshot))
        map.set(sessionKey(session), node);
    return map;
  })();
  const list = conversations(all); // useMemo(…, [all])
  const providers = [...new Set(list.map((c) => c.session.provider))];
  const anyInBackup = list.some((c) => c.session.backup);
  // A filter whose last entry went away falls back to everything, so the list never strands empty.
  const current = show === "backup" && !anyInBackup ? "all" : show;
  const needle = query.trim().toLowerCase();
  const now = Date.now();
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
  // useMemo(…, [shown, owners])
  const groups = (() => {
    const map = new Map();
    for (const c of shown) {
      const node = owners.get(sessionKey(c.session));
      const key = node?.id ?? "";
      const group = map.get(key) ?? { node, items: [] };
      group.items.push(c);
      map.set(key, group);
    }
    // Projects by their newest conversation; chats outside projects last.
    return [...map.values()].sort((a, b) =>
      !a.node !== !b.node
        ? Number(!a.node) - Number(!b.node)
        : b.items[0].updatedAt.localeCompare(a.items[0].updatedAt),
    );
  })();
  const selectable = shown.filter((c) => deletable(c));
  const shortCount = list.filter((c) => c.short).length;
  const anyKept = list.some((c) => c.session.kept);
  return {
    owners,
    list,
    providers,
    anyInBackup,
    anyKept,
    shortCount,
    show: current,
    shown,
    groups,
    selectable,
  };
}

export async function theChatsAreTheConversationsAgentsLists() {
  const shows = ["all", "short", "old", "outside", "kept", "backup"];
  for (const snapshot of [fixture(), busier()])
    for (const show of shows)
      for (const agent of ["all", "claude", "codex"])
        for (const query of ["", "kopi", "  SWAP ", "/mnt"])
          stillClock(() => {
            const options = { query, agent, show };
            assert.deepEqual(
              selectors.chatsModel(snapshot, options, Date.now()),
              sessionsView(snapshot, options),
              JSON.stringify(options),
            );
          });
  // Nothing is only in the backup on the demo home, so that filter shows everything.
  assert.equal(selectors.chatsModel(fixture(), { show: "backup" }).show, "all");
  const busy = selectors.chatsModel(busier(), { show: "backup" });
  assert.equal(busy.show, "backup");
  assert.deepEqual(
    busy.shown.map((c) => c.session.sessionId),
    ["backup-one"],
  );
}

// ── Tidy ───────────────────────────────────────────────────────────────────────────────────────────

/** views/tidy.tsx, lines 6-25 and 34-36, and the groups it draws at 77-97. */
const CATS = {
  reconnect: [
    "Reconnect",
    "link",
    "History that lost its folder, and where it probably went",
  ],
  migration: [
    "Half-done moves",
    "route",
    "Folders moved before, with history still pointing at the old place",
  ],
  space: [
    "Free space",
    "drive",
    "Dependencies and build output in projects you don’t use",
  ],
  duplicate: ["Duplicates", "layers", "The same repo cloned more than once"],
  orphan: ["Orphaned", "unlink", "History for folders that no longer exist"],
  status: ["Archive", "archive", "Projects with no activity for a long time"],
};
function tidyView(snapshot) {
  const counts = {};
  for (const p of snapshot.proposals)
    counts[p.category] = (counts[p.category] ?? 0) + 1;
  const groups = Object.entries(CATS)
    .filter(([key]) => counts[key])
    .map(([key]) => ({
      kind: key,
      proposals: snapshot.proposals
        .filter((p) => p.category === key)
        .sort(
          (a, b) =>
            ({ high: 0, med: 1, low: 2 })[a.confidence] -
            { high: 0, med: 1, low: 2 }[b.confidence],
        ),
    }));
  return { total: snapshot.proposals.length, counts, groups };
}

export async function cleanUpHasTidysKindsCountsAndOrder() {
  const mixed = fixture();
  const proposal = (id, category, confidence) => ({
    id,
    category,
    title: id,
    why: "",
    confidence,
    ops: [],
  });
  mixed.proposals = [
    proposal("d1", "duplicate", "low"),
    proposal("s1", "space", "low"),
    proposal("s2", "space", "high"),
    proposal("s3", "space", "med"),
    proposal("s4", "space", "high"),
    proposal("o1", "orphan", "med"),
    proposal("x1", "someday", "high"),
    proposal("st1", "status", "sure"),
    proposal("st2", "status", "med"),
  ];
  for (const snapshot of [fixture(), mixed, { ...fixture(), proposals: [] }])
    assert.deepEqual(selectors.cleanupModel(snapshot), tidyView(snapshot));
  assert.deepEqual(
    selectors.cleanupModel(mixed).groups.map((g) => g.kind),
    ["space", "duplicate", "orphan", "status"],
  );
  assert.deepEqual(
    selectors
      .cleanupModel(mixed)
      .groups[0].proposals.map((p) => p.id),
    ["s2", "s4", "s3", "s1"],
  );
}

// ── Home ───────────────────────────────────────────────────────────────────────────────────────────

const NOW = new Date(2026, 9, 17, 12);
/** NOW's local day moved by `days`, as a due date: "2026-10-15". */
function dueIn(days) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days);
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
const issue = (code, severity, extra = {}) => ({
  code,
  severity,
  title: code,
  ...extra,
});
function project(name, { at, issues = [], deadline, priority, archived = false } = {}) {
  const path = `${ROOT}/${name}`;
  return {
    id: path,
    kind: "project",
    name,
    label: name,
    path,
    children: [],
    archived,
    stableId: name,
    meta: { ...(deadline ? { deadline } : {}), ...(priority ? { priority } : {}) },
    status: { value: archived ? "archived" : "active", auto: true },
    ...(at ? { lastActivity: { at, source: "files" } } : {}),
    tasks: [],
    taskFiles: [],
    sidecar: false,
    agents: { claude: [], items: [], aiFiles: [] },
    issues,
  };
}
function scan(...nodes) {
  return {
    revision: 1,
    scannedAt: NOW.toISOString(),
    home: HOME,
    host: "demo",
    roots: [ROOT],
    configured: true,
    rootIds: [],
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    claude: {},
    items: {},
    sessions: [],
    connectors: [],
    suggestions: [],
    global: { claude: [], items: [] },
    orphans: { claude: [], items: [] },
    unmatched: [],
    proposals: [],
    warnings: [],
    tookMs: 1,
  };
}
const brief = (need) =>
  need.kind === "risk"
    ? `${need.n.name}: ${need.issue.code}`
    : need.kind === "due"
      ? `${need.n.name}: ${need.due.label}`
      : `safe: ${need.n?.name ?? "nothing"}`;

export async function homeLeadsWithTheWorstProblemOfTheProjectWorkedOnLast() {
  const home = selectors.homeModel(
    scan(
      // High priority, but untouched since May: it comes after the project worked on today.
      project("habit-app", {
        at: "2026-05-11T09:00:00.000Z",
        priority: "high",
        issues: [issue("no-remote", "high")],
      }),
      project("acme-store", {
        at: "2026-10-16T09:00:00.000Z",
        issues: [issue("unpushed", "med")],
      }),
      project("kopi-landing", {
        at: "2026-10-17T08:00:00.000Z",
        issues: [issue("dirty", "med"), issue("no-remote", "high")],
      }),
      project("campus-lms", { at: "2026-10-10T09:00:00.000Z", deadline: dueIn(-2) }),
      project("calm", { at: "2026-10-15T09:00:00.000Z" }),
    ),
    NOW,
  );
  assert.equal(brief(home.main), "kopi-landing: no-remote");
  assert.deepEqual(home.needs.map(brief), [
    "kopi-landing: no-remote",
    "habit-app: no-remote",
    "campus-lms: Overdue by 2 days",
    "acme-store: unpushed",
  ]);
  assert.deepEqual(home.needsYou.map(brief), home.needs.slice(1).map(brief));
  assert.equal(home.projects, 5);
}

export async function aDueDateThatHasComeBeatsAMediumProblem() {
  const home = selectors.homeModel(
    scan(
      project("dotfiles", {
        at: "2026-10-16T09:00:00.000Z",
        issues: [issue("unpushed", "med")],
      }),
      // Due today, with a medium problem too: listed once, for the date.
      project("acme-store", {
        at: "2026-10-17T09:00:00.000Z",
        deadline: dueIn(0),
        issues: [issue("dirty", "med")],
      }),
      project("campus-lms", { at: "2026-09-19T09:00:00.000Z", deadline: dueIn(-3) }),
      project("thesis", { at: "2026-10-01T09:00:00.000Z", deadline: dueIn(5) }),
      // Overdue, but at high risk as well: listed once, for the risk.
      project("kopi-landing", {
        at: "2026-10-12T09:00:00.000Z",
        deadline: dueIn(-1),
        issues: [issue("no-commits", "high")],
      }),
    ),
    NOW,
  );
  assert.deepEqual(home.needs.map(brief), [
    "kopi-landing: no-commits",
    "campus-lms: Overdue by 3 days",
    "acme-store: Due today",
    "dotfiles: unpushed",
  ]);
  assert.deepEqual(
    home.comingUp.map(({ n, info }) => `${n.name} ${info.days}`),
    ["campus-lms -3", "kopi-landing -1", "acme-store 0", "thesis 5"],
  );
  const withoutTheRisk = selectors.homeModel(
    scan(
      project("dotfiles", { at: "2026-10-16T09:00:00.000Z", issues: [issue("unpushed", "med")] }),
      project("campus-lms", { at: "2026-09-19T09:00:00.000Z", deadline: dueIn(-3) }),
    ),
    NOW,
  );
  assert.equal(withoutTheRisk.main.kind, "due");
  assert.equal(brief(withoutTheRisk.main), "campus-lms: Overdue by 3 days");
  assert.equal(withoutTheRisk.main.due.tone, "bad");
}

export async function whenEverythingIsSafeHomeOffersTheProjectWorkedOnLast() {
  const home = selectors.homeModel(
    scan(
      project("older", { at: "2026-10-16T09:00:00.000Z" }),
      project("latest", { at: "2026-10-17T09:00:00.000Z" }),
      project("archived", { at: "2026-10-17T10:00:00.000Z", archived: true }),
      // A muted check and a check that loses no work don't count.
      project("muted", {
        at: "2026-10-01T09:00:00.000Z",
        issues: [issue("no-remote", "high", { muted: true })],
      }),
      project("no-readme", {
        at: "2026-10-02T09:00:00.000Z",
        issues: [issue("no-readme", "low")],
      }),
      project("later", { at: "2026-10-03T09:00:00.000Z", deadline: dueIn(9) }),
    ),
    NOW,
  );
  assert.equal(brief(home.main), "safe: latest");
  assert.deepEqual(home.needs, []);
  assert.deepEqual(home.needsYou, []);
  assert.equal(home.projects, 5);
  assert.deepEqual(home.comingUp.map(({ n }) => n.name), ["later"]);
  assert.deepEqual(
    home.pickUp.map(({ n }) => n.name),
    ["latest", "older", "later"],
  );
  const empty = selectors.homeModel({ ...scan(), roots: [] }, NOW);
  assert.equal(empty.noFolders, true);
  assert.equal(empty.main.kind, "safe");
  assert.equal(empty.main.n, undefined);
}

export async function homeSaysWhichProjectsHaveNoVersionHistory() {
  // The demo home with every problem solved: what is left is the notes folder, which has no version history.
  const snapshot = fixture();
  for (const n of Object.values(snapshot.nodes))
    if (n.kind === "project")
      n.issues = n.issues.filter((i) => !helpers.RISK.has(i.code));
  const at = new Date(2026, 9, 8, 12);
  const home = selectors.homeModel(snapshot, at);
  assert.equal(home.main.kind, "safe");
  assert.deepEqual(home.needs, []);
  assert.equal(home.projects, 6);
  assert.equal(home.noHistory, 1);
  assert.deepEqual(
    Object.values(snapshot.nodes)
      .filter((n) => n.kind === "project" && !n.archived && !n.git)
      .map((n) => n.name),
    ["infra-notes"],
  );
  assert.equal(
    words.home.safeBody(home.projects, home.noHistory),
    "5 projects are saved and online. 1 project has no version history.",
  );
  // An archived project is in neither number.
  const archived = Object.values(snapshot.nodes).find((n) => n.kind === "project" && n.archived);
  archived.git = null;
  const same = selectors.homeModel(structuredClone(snapshot), at);
  assert.deepEqual([same.projects, same.noHistory], [6, 1]);
  // With history turned on, the notes are a project like the others.
  const notes = Object.values(snapshot.nodes).find((n) => n.name === "infra-notes");
  notes.git = structuredClone(Object.values(snapshot.nodes).find((n) => n.name === "dotfiles").git);
  assert.equal(selectors.homeModel(structuredClone(snapshot), at).noHistory, 0);
}

export async function homeOnTheDemoHome() {
  const snapshot = fixture();
  // Noon on the day the demo home was made for, wherever the test runs.
  const made = new Date(2026, 9, 8, 12);
  const home = selectors.homeModel(snapshot, made);
  assert.deepEqual(home.needs.map(brief), [
    "kopi-landing: no-remote",
    "habit-app: no-remote",
    "acme-store: dirty",
    "dotfiles: unpushed",
    "campus-lms: unpushed",
    "old-portfolio: unpushed",
  ]);
  assert.deepEqual(home.needsYou.map(brief), home.needs.slice(1, 4).map(brief));
  assert.deepEqual(
    home.pickUp.map(({ n, session, report }) => [n.name, session?.title, report?.id]),
    [
      [
        "acme-store",
        "Checkout total wrong on mobile",
        "2026-10-07-checkout-total-on-mobile-safari.md",
      ],
      ["kopi-landing", "Untitled session", "2026-10-06-kopi-hero-and-contact-form.md"],
      [
        "infra-notes",
        "Why the droplet keeps running out of memory",
        "2026-10-03-droplet-memory-and-swap.md",
      ],
    ],
  );
  const today = selectors.todayModel(snapshot, made);
  assert.deepEqual(home.nextUp, today.checks.slice(0, 5));
  assert.equal(home.todos, 4);
  assert.deepEqual(home.comingUp.map(({ n, info }) => [n.name, info.label]), [
    ["acme-store", "Due in 5 days"],
  ]);
  // Nine days on, that due date has passed.
  const later = selectors.homeModel(snapshot, new Date(2026, 9, 17, 12));
  assert.equal(brief(later.needs[2]), "acme-store: Overdue by 4 days");
}

// ── What is kept ───────────────────────────────────────────────────────────────────────────────────

export async function theSameScanGivesTheSameObjectBack() {
  const snapshot = fixture();
  const log = activity();
  const now = new Date();
  const each = [
    (s) => selectors.todayModel(s),
    (s) => selectors.navBadges(s, 0),
    (s) => selectors.searchAll(s, "acme", paletteActions(s)),
    (s) => selectors.placesCounts(s),
    (s) => selectors.sessionOwners(s),
    (s) => selectors.chatsModel(s, { query: "kopi" }, now.getTime()),
    (s) => selectors.cleanupModel(s),
    (s) => selectors.homeModel(s),
  ];
  for (const select of each) {
    const first = select(snapshot);
    assert.equal(select(snapshot), first);
    // A new scan with the same content is worked out again.
    const copy = structuredClone(snapshot);
    assert.notEqual(select(copy), first);
    if (typeof first !== "function")
      assert.deepEqual(select(copy), select(structuredClone(snapshot)));
  }
  const model = selectors.activityModel(log, { filter: "moves" });
  assert.equal(selectors.activityModel(log, { filter: "moves" }), model);
  assert.notEqual(selectors.activityModel(log, { filter: "setup" }), model);
  assert.equal(selectors.activityModel(null), selectors.activityModel(null));
}

export async function whatReadsTheDateIsWorkedOutAgainTheNextDay() {
  const snapshot = fixture();
  const morning = new Date(2026, 9, 17, 8);
  const evening = new Date(2026, 9, 17, 22);
  const tomorrow = new Date(2026, 9, 18, 8);
  for (const select of [selectors.todayModel, selectors.homeModel]) {
    const today = select(snapshot, morning);
    assert.equal(select(snapshot, evening), today);
    const next = select(snapshot, tomorrow);
    assert.notEqual(next, today);
    assert.equal(select(snapshot, tomorrow), next);
  }
  const acme = (model) =>
    model.deadlines.find(({ n }) => n.name === "acme-store").info.days;
  assert.equal(
    acme(selectors.todayModel(snapshot, morning)) - 1,
    acme(selectors.todayModel(snapshot, tomorrow)),
  );
  const badges = selectors.navBadges(snapshot, 0, morning);
  assert.equal(selectors.navBadges(snapshot, 0, evening), badges);
  assert.notEqual(selectors.navBadges(snapshot, 1, evening), badges);
}

export async function chatsAreWorkedOutAgainEachMinuteButNotForEachKey() {
  const snapshot = busier();
  const now = Date.now();
  const first = selectors.chatsModel(snapshot, { query: "k" }, now);
  const typed = selectors.chatsModel(snapshot, { query: "ko" }, now);
  assert.notEqual(typed, first);
  assert.equal(typed.list, first.list);
  const later = selectors.chatsModel(snapshot, { query: "ko" }, now + 60_000);
  assert.notEqual(later.list, first.list);
  // A chat ended five minutes ago is still settling: not short, and not to be deleted yet.
  const going = (model) =>
    model.list.find((c) => c.session.sessionId === "still-going");
  assert.equal(going(first).short, false);
  assert.equal(
    first.selectable.some((c) => c.session.sessionId === "still-going"),
    false,
  );
  const hourLater = selectors.chatsModel(snapshot, {}, now + 60 * 60_000);
  assert.equal(going(hourLater).short, true);
  assert.equal(
    hourLater.selectable.some((c) => c.session.sessionId === "still-going"),
    true,
  );
}

// ── The chooser of the copy of AI chats ────────────────────────────────────────────────────────────

const CLIENTS = `${ROOT}/clients`;
const ACME = `${CLIENTS}/acme-store`;
const KOPI = `${CLIENTS}/kopi-landing`;
const SIDE = `${ROOT}/side`;
const allPaths = (tree) => tree.rows.map((row) => row.node.path);

export async function theCopyTreeNestsFoldersUnderTheirParentWithTheChatsOfEach() {
  const tree = selectors.copyTree(fixture());
  // Each level by label; a chat counts for the nearest project or folder holding its folder, so the two chats whose
  // project moved away belong to the folder they were in.
  assert.deepEqual(
    tree.rows.map((row) => [row.depth, row.node.name, row.chats]),
    [
      [0, "project", 2],
      [1, "_archive", 0],
      [2, "old-portfolio", 0],
      [1, "clients", 0],
      [2, "acme-store", 1],
      [2, "kopi-landing", 2],
      [1, "infra-notes", 1],
      [1, "side", 0],
      [2, "dotfiles", 0],
      [2, "habit-app", 0],
      [1, "thesis", 0],
      [2, "campus-lms", 1],
    ],
  );
  assert.deepEqual([tree.outside, tree.gone], [0, []]);
  // The same scan gives the same tree back.
  const snapshot = fixture();
  assert.equal(selectors.copyTree(snapshot).rows, selectors.copyTree(snapshot).rows);
}

export async function chatsInNoProjectAreCountedOutsideAndOnesOnlyTheCopyHoldsAreNot() {
  const s = fixture();
  const chat = (more) => ({ ...s.sessions[1], ...more });
  s.sessions.push(
    chat({ sessionId: "away", cwd: "/elsewhere", file: "/elsewhere/away.jsonl" }),
    // Started in the home folder itself, which is no project.
    chat({ sessionId: "home", cwd: HOME, file: `${HOME}/home.jsonl` }),
    // A chat whose folder Laci can't tell is copied whatever is chosen, so it is not "outside".
    chat({ sessionId: "unknown", cwd: null, file: "/elsewhere/unknown.jsonl" }),
    // A chat only the copy holds has nothing left to copy.
    chat({ sessionId: "kept", cwd: KOPI, file: "/copy/kept.jsonl", backup: true }),
    chat({ sessionId: "kept-away", cwd: "/elsewhere", file: "/copy/kept-away.jsonl", backup: true }),
  );
  const tree = selectors.copyTree(s);
  assert.equal(tree.outside, 2);
  assert.equal(tree.rows.find((row) => row.node.path === KOPI).chats, 2);
}

export async function aChosenFolderThatIsNoLongerScannedIsAGoneRow() {
  const tree = selectors.copyTree(fixture(), [`${ROOT}/old-name`, ACME, `${ROOT}/old-name`, `${HOME}/away`]);
  // Each once and sorted; a folder that is scanned is a row, not gone.
  assert.deepEqual(tree.gone, [`${HOME}/away`, `${ROOT}/old-name`]);
}

export async function aFoldersBoxIsMixedWhenItAndWhatIsInItDiffer() {
  const tree = selectors.copyTree(fixture());
  const pick = (...paths) => ({ paths, outside: false });
  assert.equal(selectors.copyTick(tree, pick(), CLIENTS), "off");
  assert.equal(selectors.copyTick(tree, pick(ACME), CLIENTS), "mixed");
  // The folder's own box on its own is mixed too: what is in it isn't ticked.
  assert.equal(selectors.copyTick(tree, pick(CLIENTS), CLIENTS), "mixed");
  assert.equal(selectors.copyTick(tree, pick(CLIENTS, ACME, KOPI), CLIENTS), "on");
  assert.equal(selectors.copyTick(tree, pick(ACME), ACME), "on");
  assert.equal(selectors.copyTick(tree, pick(ACME), KOPI), "off");
  // A level up, a folder ticked among the others is mixed all the way to the top.
  assert.equal(selectors.copyTick(tree, pick(CLIENTS, ACME, KOPI), ROOT), "mixed");
  // A path no folder has is its own box.
  assert.equal(selectors.copyTick(tree, pick("/gone"), "/gone"), "on");
  assert.equal(selectors.copyTick(tree, pick(), "/gone"), "off");
}

export async function aFoldersBoxTicksAndUnticksEverythingInIt() {
  const tree = selectors.copyTree(fixture());
  const sorted = (pick) => ({ ...pick, paths: [...pick.paths].sort() });
  // Off, or mixed, comes on with its whole subtree; the choices elsewhere stay.
  let pick = selectors.toggleCopy(tree, { paths: [SIDE], outside: true }, CLIENTS);
  assert.deepEqual(sorted(pick), { paths: [ACME, CLIENTS, KOPI, SIDE].sort(), outside: true });
  assert.equal(selectors.copyTick(tree, pick, CLIENTS), "on");
  // One project unticked makes its folder mixed, and the folder's box then ticks it again.
  pick = selectors.toggleCopy(tree, pick, KOPI);
  assert.equal(selectors.copyTick(tree, pick, CLIENTS), "mixed");
  assert.deepEqual(sorted(pick).paths, [ACME, CLIENTS, SIDE].sort());
  pick = selectors.toggleCopy(tree, pick, CLIENTS);
  assert.equal(selectors.copyTick(tree, pick, KOPI), "on");
  // On goes off with everything in it, and nothing is listed twice.
  pick = selectors.toggleCopy(tree, pick, CLIENTS);
  assert.deepEqual(pick, { paths: [SIDE], outside: true });
  // The top folder takes the whole tree.
  const everything = selectors.toggleCopy(tree, { paths: [ACME], outside: false }, ROOT);
  assert.deepEqual(sorted(everything).paths, allPaths(tree).sort());
  assert.deepEqual(selectors.toggleCopy(tree, everything, ROOT).paths, []);
  // A gone row is toggled alone.
  assert.deepEqual(selectors.toggleCopy(tree, { paths: ["/gone", ACME], outside: false }, "/gone").paths, [ACME]);
  assert.deepEqual(selectors.toggleCopy(tree, { paths: [ACME], outside: false }, "/gone").paths, [ACME, "/gone"]);
}

export async function everythingTickedIsEveryFolderAndTheChatsOutsideThem() {
  const tree = selectors.copyTree(fixture());
  assert.deepEqual(selectors.copyAllTicked(tree), { paths: allPaths(tree), outside: true });
  assert.equal(selectors.copyTick(tree, selectors.copyAllTicked(tree), ROOT), "on");
  // The folders of a choice that are gone stay ticked: ticking all stops nothing.
  const withGone = selectors.copyTree(fixture(), ["/gone"]);
  assert.deepEqual(selectors.copyAllTicked(withGone).paths, [...allPaths(withGone), "/gone"]);
  assert.deepEqual(selectors.copyNoneTicked(), { paths: [], outside: false });
}

export async function onlyProjectsAreCountedInAChoiceNotFoldersOrGoneOnes() {
  const s = fixture();
  assert.equal(selectors.copyProjects(s, { paths: [ROOT, CLIENTS, ACME, KOPI, "/gone"] }), 2);
  assert.equal(selectors.copyProjects(s, { paths: [] }), 0);
}
