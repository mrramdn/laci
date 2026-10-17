// ui/src/actions.ts on the real store: each change sends the request the views send today, shows
// what they show, and waits behind the same guards.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const APP = "/home/demo/project/app";
const errorText = (error) =>
  error instanceof Error ? error.message : String(error);

/**
 * The actions on a store of their own, which holds a scan with one project. `reply` answers the
 * requests, and `requests` lists them, each with what the store was busy with as it was sent. The
 * reply is at first the project with the request's fields on it, so a test sees it reach the store.
 */
function app(reply = async (_name, body) => ({ ...node(), revision: 2, ...body })) {
  const requests = [];
  const api = {
    api: async (name, body) => {
      requests.push({ name, body, working: store.useApp.getState().working });
      return reply(name, body);
    },
    errorText,
  };
  const store = load(
    "store.ts",
    { "./api": api },
    {
      document: { documentElement: { dataset: {} } },
      localStorage: { getItem: () => null, setItem: () => {} },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  );
  const actions = load("actions.ts", { "./api": api, "./store": store });
  store.useApp.getState().load({
    revision: 1,
    configured: true,
    home: "/home/demo",
    roots: ["/home/demo/project"],
    nodes: { [APP]: node() },
    proposals: [],
  });
  return { ...store, ...actions, requests, state: () => store.useApp.getState() };
}
/** A project with the same to-do twice in its notes, a checkbox elsewhere and two muted checks. */
function node() {
  return {
    id: APP,
    path: APP,
    kind: "project",
    name: "app",
    label: "app",
    meta: { quiet: "stash,dirty" },
    tasks: [
      { text: "Ship it", done: false, kind: "check", file: ".laci.md", line: 3 },
      { text: "Ship it", done: false, kind: "check", file: ".laci.md", line: 7 },
      { text: "Ship it", done: false, kind: "check", file: "TODO.md", line: 1 },
    ],
    issues: [],
  };
}

export async function aTodoIsTickedAddedAndDeletedAsTheViewsDoIt() {
  const a = app();
  const twin = a.state().snapshot.nodes[APP].tasks[1];
  await a.toggleTodo(a.state().snapshot.nodes[APP], twin, true);
  assert.deepEqual(a.requests.at(-1).body, {
    id: APP,
    op: "toggle",
    file: ".laci.md",
    line: 7,
    text: "Ship it",
    occurrence: 1,
    count: 2,
    done: true,
  });
  // The project as the reply has it is the one the window shows.
  assert.equal(a.state().snapshot.nodes[APP].done, true);
  assert.equal(a.state().revision, 2);

  await a.deleteTodo(a.state().snapshot.nodes[APP], twin);
  assert.deepEqual(a.requests.at(-1).body, {
    id: APP,
    op: "delete",
    file: ".laci.md",
    line: 7,
    text: "Ship it",
    occurrence: 1,
    count: 2,
  });

  assert.equal(await a.addTodo(node(), "  Write the tests  "), true);
  assert.deepEqual(a.requests.at(-1).body, { id: APP, op: "add", text: "Write the tests" });
  const sent = a.requests.length;
  assert.equal(await a.addTodo(node(), "   "), false);
  assert.equal(a.requests.length, sent, "blank text sends nothing");
  // A to-do is not a labelled change: nothing covers the window while it is sent.
  assert.ok(a.requests.every((request) => request.working === ""));
}

export async function aTodoThatCannotBeAddedSaysWhy() {
  const a = app(async () => {
    throw "The project's .laci.md is not writable";
  });
  assert.equal(await a.addTodo(node(), "Next"), false);
  assert.equal(a.state().toast.title, "Couldn’t finish");
  assert.equal(a.state().toast.message, "The project's .laci.md is not writable");
  assert.equal(a.state().toast.error, true);
}

export async function aReportItemClosesAndOpensAgain() {
  const a = app(async () => ({}));
  await a.closeReportItem("2026-10-07-checkout.md", 1, "done", "Send the link");
  assert.deepEqual(a.requests.at(-1), {
    name: "report/close",
    body: { report: "2026-10-07-checkout.md", item: 1, state: "done" },
    working: "",
  });
  assert.deepEqual(
    [a.state().toast.title, a.state().toast.message],
    ["Closed in the report", "Send the link"],
  );
  await a.closeReportItem("r.md", 2, "dropped", "Promo codes");
  assert.equal(a.state().toast.title, "Closed in the report");
  await a.closeReportItem("r.md", 1, "open", "Promo codes");
  assert.deepEqual(a.requests.at(-1).body, { report: "r.md", item: 1, state: "open" });
  assert.equal(a.state().toast.title, "Opened again");
}

export async function aFieldIsSetAndAMutedCheckKeepsTheOthers() {
  const a = app();
  await a.setMeta(node(), "priority", "high");
  assert.deepEqual(a.requests.at(-1), {
    name: "meta",
    body: { id: APP, key: "priority", value: "high" },
    working: "",
  });
  assert.equal(a.state().snapshot.nodes[APP].value, "high");
  const quiet = [];
  for (const [code, on] of [
    ["no-remote", true],
    ["dirty", true],
    ["stash", false],
    ["unpushed", false],
  ]) {
    await a.muteCheck(node(), code, on);
    assert.equal(a.requests.at(-1).body.key, "quiet");
    quiet.push(a.requests.at(-1).body.value);
  }
  assert.deepEqual(quiet, ["stash,dirty,no-remote", "stash,dirty", "dirty", "stash,dirty"]);
  await a.muteCheck({ ...node(), meta: {} }, "dirty", true);
  assert.equal(a.requests.at(-1).body.value, "dirty");
}

export async function undoWaitsForTheLastChangeAndCoversTheWindow() {
  const change = { revision: 3, journal: { id: "j1", title: "Moved", canUndo: true } };
  const a = app(async () => change);
  a.useApp.setState({ historyPending: true });
  assert.equal(await a.undoJournal("j0"), undefined);
  assert.equal(await a.undoLogEntry("e0"), undefined);
  assert.equal(a.requests.length, 0, "nothing is sent while a change is still being read");
  a.useApp.setState({ historyPending: false });

  await a.undoJournal("j0");
  assert.deepEqual(a.requests.at(-1), { name: "undo", body: { id: "j0" }, working: "Undoing…" });
  assert.equal(a.state().toast.title, "Journaled changes undone");
  assert.equal(a.state().toast.undo, "j1");
  assert.equal(a.state().working, "");

  a.useApp.setState({ historyPending: false });
  await a.undoLogEntry("e0");
  assert.deepEqual(a.requests.at(-1), { name: "log/undo", body: { id: "e0" }, working: "Undoing…" });
  assert.equal(a.state().toast.title, "Undone");
}

export async function aSecondUndoWhileOneRunsIsIgnored() {
  let finish;
  const a = app(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ journal: { id: "j9", title: "Moved" } });
      }),
  );
  const first = a.undoJournal("j1");
  assert.equal(await a.undoJournal("j1"), undefined);
  assert.equal(a.requests.length, 1);
  finish();
  await first;
  assert.equal(a.state().working, "");
}

export async function aSuggestionIsAppliedOrOpensItsDialog() {
  const a = app(async () => ({ revision: 4, journal: { id: "j2", title: "Reconnected" } }));
  const proposal = (id, category, action) => ({
    id,
    category,
    title: id,
    why: "",
    confidence: "high",
    ops: [],
    action,
  });
  await a.applyProposal(
    proposal("orphan:x", "orphan", { type: "quarantine", moves: [] }),
  );
  assert.deepEqual(a.state().modal, { kind: "orphan", id: "orphan:x" });
  a.useApp.setState({ modal: null });
  await a.applyProposal(
    proposal("archive:x", "status", { type: "archive", nodeId: APP }),
  );
  assert.deepEqual(a.state().modal, { kind: "archive", id: APP });
  a.useApp.setState({ modal: null });
  await a.applyProposal(proposal("duplicate:x", "duplicate"));
  assert.equal(a.requests.length, 0, "dialogs come first, and without an action nothing is applied");
  assert.equal(a.state().modal, null);

  const reconnect = proposal("reconnect:x", "reconnect", {
    type: "reconnect-claude",
    dir: "d",
    target: "t",
    pairs: [],
  });
  a.useApp.setState({ historyPending: true });
  await a.applyProposal(reconnect);
  assert.equal(a.requests.length, 0);
  a.useApp.setState({ historyPending: false });
  await a.applyProposal(reconnect);
  assert.deepEqual(a.requests.at(-1), {
    name: "apply",
    body: { id: "reconnect:x" },
    working: "Applying changes…",
  });
  assert.equal(a.state().toast.title, "Changes applied");
  assert.equal(a.state().toast.undo, "j2");
}

export async function aSuggestionIsHiddenAndOfferedAgain() {
  const a = app(async () => ({}));
  await a.dismissProposal("space:x");
  assert.deepEqual(a.requests.at(-1).body, { id: "space:x" });
  assert.equal(a.state().toast.title, "Suggestion dismissed");
  await a.dismissProposal("space:x", true);
  assert.deepEqual(a.requests.at(-1).body, { id: "space:x", undo: true });
  assert.equal(a.state().toast.title, "Suggestion is back");
}
