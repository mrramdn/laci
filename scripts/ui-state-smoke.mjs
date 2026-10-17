// Exercise the real store with reordered native replies, without a browser or new dependencies.
// Every scripts/ui-tests/*.test.mjs runs here too.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { load } from "./ui-module.mjs";

function store(api = () => Promise.resolve({ entries: [] })) {
  let timerId = 0;
  const timers = new Map();
  const native = {
    api,
    errorText: (error) => error instanceof Error ? error.message : String(error),
  };
  const exports = load("store.ts", { "./api": native }, {
    document: { documentElement: { dataset: {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return { ...exports, timers };
}

function snapshot(revision, historyPending = false) {
  return {
    revision,
    historyPending,
    configured: true,
    home: "/fixture",
    roots: ["/fixture/project"],
    nodes: { project: { id: "project", notes: `revision ${revision}` } },
    proposals: [{ id: "quarantine:fixture" }],
  };
}

test("streaming scan status does not starve newer snapshots or regress status", () => {
  const { useApp, refreshStatus } = store();
  useApp.getState().load(snapshot(5));
  refreshStatus({ revision: 7, historyPending: false, busy: true });
  useApp.getState().load(snapshot(6), true);
  assert.equal(useApp.getState().snapshot.revision, 6);
  assert.equal(useApp.getState().busy, true);
  useApp.getState().load(snapshot(5), true);
  refreshStatus({ revision: 6, historyPending: false, busy: false });
  assert.equal(useApp.getState().snapshot.revision, 6);
  assert.equal(useApp.getState().busy, true);
  useApp.getState().load(snapshot(7), true);
  refreshStatus({ revision: 7, historyPending: false, busy: false });
  assert.equal(useApp.getState().revision, 7);
  assert.equal(useApp.getState().busy, false);
});

test("mutation status fences old proposals until an accepted snapshot", () => {
  const { useApp, refreshStatus } = store();
  useApp.getState().load(snapshot(5));
  refreshStatus({ revision: 8, historyPending: true, busy: true });
  useApp.getState().load(snapshot(7), true);
  assert.equal(useApp.getState().revision, 8);
  assert.deepEqual(useApp.getState().snapshot.proposals, []);
  refreshStatus({ revision: 9, historyPending: false, busy: false });
  assert.equal(useApp.getState().historyPending, true);
  useApp.getState().load(snapshot(9), true);
  assert.equal(useApp.getState().historyPending, false);
});

test("late acknowledgements, unversioned nested nodes and errors cannot undo newer data", () => {
  const { useApp, acknowledge, refreshError, refreshStatus } = store();
  useApp.getState().load(snapshot(9));
  acknowledge({ revision: 8, historyPending: true, node: { id: "project", notes: "old" } });
  useApp.getState().patch({ id: "project", notes: "old", revision: 8 });
  refreshError("old refresh failed", 8);
  refreshStatus({ revision: 8, historyPending: true, busy: true });
  assert.equal(useApp.getState().snapshot.nodes.project.notes, "revision 9");
  assert.equal(useApp.getState().historyPending, false);
  assert.equal(useApp.getState().error, null);
});

test("a refresh failure before the action reply preserves its warning and Undo", () => {
  const { useApp, refreshError, changed, timers } = store();
  useApp.getState().load(snapshot(5));
  refreshError("refresh failed", 8);
  useApp.getState().load(snapshot(7), true);
  assert.equal(useApp.getState().error, "refresh failed");
  changed({ revision: 8, historyPending: true, journal: { id: "undo-id" } }, "Changes applied");
  assert.equal(useApp.getState().toast.undo, "undo-id");
  assert.equal(useApp.getState().toast.message, "refresh failed");
  assert.equal(timers.size, 0, "Undo must remain available during a slow refresh");
  useApp.getState().load(snapshot(8, true), true);
  assert.equal(useApp.getState().error, "refresh failed");
  useApp.getState().load(snapshot(9), true);
  assert.equal(useApp.getState().error, null);
  assert.equal(useApp.getState().toast.undo, "undo-id");
  assert.equal([...timers.values()][0].delay, 14000);
});

test("a late same-revision snapshot cannot hide a failed ordinary refresh", () => {
  const { useApp, refreshError } = store();
  useApp.getState().load(snapshot(6));
  refreshError("permission denied", 6);
  useApp.getState().load(snapshot(6), true);
  assert.equal(useApp.getState().error, "permission denied");
  assert.equal(useApp.getState().errorRevision, 6);
  useApp.getState().load(snapshot(7), true);
  assert.equal(useApp.getState().error, null);
});

test("a failed manual refresh retry retains the committed action's Undo", async () => {
  const app = store(async (name) => {
    assert.equal(name, "rescan");
    app.refreshError("still cannot read history", 8);
    throw new Error("still cannot read history");
  });
  app.useApp.getState().load(snapshot(5));
  app.changed({ revision: 8, historyPending: true, journal: { id: "undo-id" } }, "Archived project");
  app.refreshError("cannot read history", 8);
  await app.rescan();
  assert.equal(app.useApp.getState().toast.undo, "undo-id");
  assert.equal(app.useApp.getState().toast.title, "Archived project");
  assert.equal(app.useApp.getState().toast.message, "still cannot read history");
  assert.equal(app.useApp.getState().working, "");
  assert.equal(app.timers.size, 0);
});

test("mutation ownership rejects a repeated click while read-only tasks still run", async () => {
  const { useApp, run } = store();
  let finish;
  let calls = 0;
  const first = run(() => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  }, "Applying changes…", { history: true });
  await run(async () => { calls++; }, "Applying changes…", { history: true });
  assert.equal(calls, 1);
  assert.equal(await run(async () => "read-only"), "read-only");
  assert.equal(useApp.getState().working, "Applying changes…");
  finish();
  await first;
  assert.equal(useApp.getState().working, "");
});

test("system Trash never offers Laci Undo and mixed recovery explains its limits", () => {
  const { useApp, changed } = store();
  useApp.getState().load(snapshot(1));
  changed(
    {
      journal: {
        id: "trash",
        canUndo: false,
        recovery: "Restore through system Trash.",
      },
    },
    "Moved history",
  );
  assert.equal(useApp.getState().toast.undo, undefined);
  assert.match(useApp.getState().toast.message, /system Trash/);
  changed(
    {
      journal: {
        id: "mixed",
        canUndo: true,
        recovery:
          "Undo restores moves; restore deleted files through system Trash.",
      },
    },
    "Archived project",
  );
  assert.equal(useApp.getState().toast.undo, "mixed");
  assert.match(
    useApp.getState().toast.message,
    /deleted files through system Trash/,
  );
});

const helpers = load("helpers.ts");
function session(provider, id, cwd, parentId) {
  return {
    provider,
    sessionId: id,
    cwd,
    parentId,
    title: id,
    updatedAt: "2026-10-04",
    file: `/logs/${provider}-${id}`,
    resumeCapability: "supported",
    sourceKind: "cli",
    titleSource: "index",
  };
}

test("session trees keep provider identities separate and retain malformed parent chains", () => {
  const groups = helpers.groupSessions([
    session("codex", "child", "/work", "same"),
    session("claude", "same", "/work"),
    session("codex", "same", "/work"),
    session("codex", "missing-parent", "/work", "absent"),
    session("codex", "cycle-a", "/work", "cycle-b"),
    session("codex", "cycle-b", "/work", "cycle-a"),
  ]);
  assert.equal(groups.length, 5);
  assert.equal(
    groups.find((group) => group.session.provider === "claude").children.length,
    0,
  );
  assert.deepEqual(
    groups
      .find(
        (group) =>
          group.session.provider === "codex" &&
          group.session.sessionId === "same",
      )
      .children.map((group) => group.session.sessionId),
    ["child"],
  );
  assert(groups.some((group) => group.session.sessionId === "missing-parent"));
  assert(groups.some((group) => group.session.sessionId === "cycle-a"));
});

test("metadata cwd maps sessions to the nearest project without double counting logs or moving Home sessions", () => {
  const parent = {
    id: "/work",
    path: "/work",
    agents: { claude: [], items: [] },
  };
  const project = {
    id: "/work/app",
    path: "/work/app",
    agents: { claude: [], items: ["normalized", "custom"] },
  };
  const home = {
    id: "/home/test",
    path: "/home/test",
    agents: { claude: [], items: [] },
  };
  const data = {
    home: home.path,
    nodes: { [parent.id]: parent, [project.id]: project, [home.id]: home },
    claude: {},
    sessions: [
      session("codex", "normalized", "/work/app/src"),
      session("claude", "home", home.path),
      session("codex", "external", "/mnt/other"),
    ],
    items: {
      normalized: { file: "/logs/codex-normalized", connector: "codex" },
      custom: { file: "/logs/custom", connector: "custom" },
    },
    connectors: [
      { id: "codex", link: { kind: "cwd" } },
      { id: "custom", link: { kind: "cwd" } },
    ],
  };
  assert.equal(helpers.sessionsOf(parent, data).length, 0);
  assert.equal(helpers.sessionsOf(project, data)[0].sessionId, "normalized");
  assert.equal(helpers.agentCount(project, data), 2);
  assert.deepEqual(
    helpers.globalSessions(data).map((session) => session.sessionId),
    ["home", "external"],
  );
  assert.equal(helpers.sessionsOf(home, data).length, 0);
});

test("reports open with their context, and project details leave full-width views", () => {
  const { useApp, goToProject, FULL_WIDTH } = store();
  useApp.getState().load(snapshot(1));
  useApp.setState({
    modal: { kind: "session", provider: "claude", sessionId: "s", file: "f" },
  });
  useApp.getState().openReport({ id: "a.md", sessions: ["s1", "s2"] });
  let state = useApp.getState();
  assert.equal(state.view, "reports");
  assert.equal(state.report, "a.md");
  assert.deepEqual(state.reportFilter, { sessions: ["s1", "s2"] });
  assert.equal(state.modal, null);
  state.navigate("reports");
  assert.equal(useApp.getState().reportFilter, null);
  assert.equal(useApp.getState().report, "a.md", "the open report stays open");
  useApp.getState().openReport({ project: "/work/app" });
  assert.deepEqual(useApp.getState().reportFilter, { project: "/work/app" });
  assert.equal(useApp.getState().report, null);
  assert.ok(FULL_WIDTH.includes("reports"));
  goToProject("project", "agents");
  state = useApp.getState();
  assert.equal(state.view, "today");
  assert.equal(state.selected, "project");
  assert.equal(state.tab, "agents");
});

test("reports already in a newly chosen folder do not count as new", () => {
  const { useApp } = store();
  useApp.getState().load(snapshot(1));
  assert.equal(useApp.getState().reportsSeen, 0);
  useApp
    .getState()
    .load({ ...snapshot(2), reportsDir: { path: "/reports", total: 0 }, reports: [] });
  assert.ok(useApp.getState().reportsSeen > 0);
});

function report(id, date, modified, sessions = [], projects = []) {
  return {
    id,
    file: `/reports/${id}`,
    title: id,
    date,
    modified,
    bytes: 1,
    sessions,
    projects,
    open: [],
    openCount: 0,
  };
}

test("reports are found by session and by project, newest first", () => {
  const data = {
    reports: [
      report("old.md", "2026-10-01", "2026-10-01T10:00:00.000Z", ["AAA"], ["/work/app"]),
      report("new.md", "2026-10-03", "2026-10-03T10:00:00.000Z", ["aaa", "bbb"], ["/work/app"]),
      report("later.md", "2026-10-03", "2026-10-04T08:00:00.000Z", [], ["/work/other"]),
    ],
  };
  assert.deepEqual(
    helpers.reportList(data).map((r) => r.id),
    ["later.md", "new.md", "old.md"],
  );
  assert.deepEqual(
    helpers.reportsOfSessions(data, ["AAA", "bbb"]).map((r) => r.id),
    ["new.md", "old.md"],
  );
  assert.equal(helpers.latestReport(data, "/work/app").id, "new.md");
  assert.equal(helpers.latestReport(data, "/nowhere"), undefined);
  assert.equal(helpers.reportById(data, "old.md").date, "2026-10-01");
  assert.equal(helpers.localDay("2026-10-13").getDate(), 13);
  assert.equal(helpers.localDay("13 Oct"), undefined);
  assert.deepEqual(
    helpers.conversationIds({ session: { sessionId: "x" }, parts: [{ sessionId: "y" }] }),
    ["x", "y"],
  );
  assert.ok(helpers.agentInstruction("/notes/reports").includes("`/notes/reports`"));
});

// The tests of later changes live in scripts/ui-tests/*.test.mjs, one file for each. Every function a file
// exports is a test, named after the function. A file can export a default function instead, which is given
// `test` to register its own tests with.
const testsDir = new URL("./ui-tests/", import.meta.url);
for (const name of readdirSync(testsDir).filter((file) => file.endsWith(".test.mjs")).sort()) {
  for (const [key, value] of Object.entries(await import(new URL(name, testsDir)))) {
    if (typeof value !== "function") continue;
    if (key === "default") await value(test);
    else test(`${name}: ${key}`, value);
  }
}
