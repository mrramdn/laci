// Exercise the real store with reordered native replies, without a browser or new dependencies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../ui/package.json", import.meta.url));
const ts = require("typescript");
const source = readFileSync(new URL("../ui/src/store.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function store(api = () => Promise.resolve({ entries: [] })) {
  const exports = {};
  let timerId = 0;
  const timers = new Map();
  const native = {
    api,
    errorText: (error) => error instanceof Error ? error.message : String(error),
  };
  new Function("require", "exports", "document", "localStorage", "setTimeout", "clearTimeout", compiled)(
    (name) => name === "./api" ? native : require(name),
    exports,
    { documentElement: { dataset: {} } },
    { getItem: () => null, setItem: () => {} },
    (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    (id) => timers.delete(id),
  );
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
