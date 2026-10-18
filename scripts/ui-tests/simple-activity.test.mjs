// Simple's Activity (ui/src/simple/Activity.tsx and its part of ui/src/simple/model.ts): one sentence
// per change, the filters by who made it and what can be undone, the filled Undo of the newest change
// that can be undone, and the Undo rules of Detailed's Log.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";
import { describe, heldDate, Host, simpleBlocks, standIn } from "./react-stand-in.mjs";

const { createElement } = requireUi("react");
/** A local time on a day of October 2026, so "yesterday" is the day before wherever the test runs. */
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const NOW = at(8, 15);
// Compiled once, with the clock held at NOW, and handed to each page drawn below.
const held = { Date: heldDate(NOW) };
const words = load("words.ts", {}, held);
const helpers = load("helpers.ts", {}, held);
const model = load("simple/model.ts", { "../helpers": helpers, "./helpers": helpers }, held);
const said = words.activity;
const KOPI = "/home/demo/project/clients/kopi-landing";
const STATUS = `meta:${KOPI}:status`;
const nothing = () => null;

/** The `log` reply, newest first: what the engine says about each change. */
const LOG = {
  entries: [
    {
      id: "e6",
      at: at(8, 14, 50),
      by: "agent",
      title: "Moved acme-store to clients",
      path: "/home/demo/project/clients/acme-store",
      journal: "j6",
      state: "applied",
      canUndo: true,
      superseded: false,
      steps: [
        { kind: "move", label: "Moved", from: "~/project/acme-store", to: "~/project/clients/acme-store" },
      ],
    },
    {
      id: "e5",
      at: at(8, 14, 40),
      by: "app",
      title: "Status of kopi-landing set to active",
      path: KOPI,
      key: STATUS,
      state: "applied",
      canUndo: true,
      superseded: false,
    },
    {
      id: "e4",
      at: at(8, 14, 30),
      by: "app",
      title: "Status of kopi-landing set to paused",
      path: KOPI,
      key: STATUS,
      state: "applied",
      canUndo: false,
      superseded: true,
    },
    {
      id: "e3",
      at: at(8, 14, 20),
      by: "auto",
      title: "Backed up 3 agent history files",
      detail: "6 sessions kept · 40.0 KB in ~/.local/share/laci/history",
      state: "applied",
      canUndo: false,
      superseded: false,
    },
    {
      id: "e2",
      at: at(7, 18),
      by: "app",
      title: "Archive old-portfolio",
      journal: "j2",
      state: "undone",
      canUndo: false,
      superseded: false,
    },
    {
      id: "e1",
      at: at(7, 17),
      by: "agent",
      title: "Archive habit-app",
      journal: "j1",
      state: "failed",
      canUndo: false,
      superseded: false,
      error: "habit-app is in use: close the program working there, then try again",
    },
  ],
};
const ids = (view) => view.days.flatMap((day) => day.entries.map((entry) => entry.id));

// --- What Activity lists -----------------------------------------------------------------------------

export async function activityFiltersByWhoMadeAChangeAndWhatCanBeUndone() {
  const view = (filter, query = "") => model.activityView(LOG, filter, query);
  assert.deepEqual(view("all").counts, { all: 6, mine: 3, ai: 2, undo: 2 });
  assert.deepEqual(ids(view("all")), ["e6", "e5", "e4", "e3", "e2", "e1"]);
  // A copy Laci made by itself is not "by me".
  assert.deepEqual(ids(view("mine")), ["e5", "e4", "e2"]);
  assert.deepEqual(ids(view("ai")), ["e6", "e1"]);
  assert.deepEqual(ids(view("undo")), ["e6", "e5"]);
  // The search reads what happened, its details and where; the filter still applies.
  assert.deepEqual(ids(view("all", "kopi")), ["e5", "e4"]);
  assert.deepEqual(ids(view("ai", "kopi")), []);
  assert.deepEqual(ids(view("all", "history")), ["e3"]);
  // By day, newest first.
  assert.deepEqual(view("all").days.map((day) => day.entries.length), [4, 2]);
  // A day's name in words: the month is written in full, as Home writes it.
  const now = Date.parse(NOW);
  assert.equal(said.day(at(8, 0, 1), now), "Today");
  assert.equal(said.day(at(7, 23, 59), now), "Yesterday");
  assert.match(said.day(at(1, 9), now), /October/);
  assert.doesNotMatch(said.day(at(1, 9), now), /\bOct\b|2026/);
  assert.match(said.day(new Date(2025, 9, 1, 9).toISOString(), now), /October.*2025|2025.*October/);
  // The filled Undo is the newest change that can be undone, whatever the list shows.
  assert.equal(view("mine").newest.id, "e6");
  assert.equal(view("all", "nothing like it").newest.id, "e6");
  assert.deepEqual(model.activityView(null, "all", ""), {
    counts: { all: 0, mine: 0, ai: 0, undo: 0 },
    days: [],
    newest: undefined,
  });
  assert.deepEqual(
    LOG.entries.map(model.actorOf),
    ["ai", "you", "you", "laci", "you", "ai"],
  );
}

export async function aChangeChangedAgainLaterNamesTheNewerOne() {
  const [e6, e5, e4, e3] = LOG.entries;
  assert.equal(model.newerChange(LOG, e4), e5);
  assert.equal(model.newerChange(LOG, e5), undefined, "not changed again");
  assert.equal(model.newerChange(LOG, e6), undefined);
  assert.equal(model.newerChange(LOG, e3), undefined);
  // The one to undo first is the newest change that still stands: an Undo, or a change already
  // undone, doesn't count.
  const entry = (id, extra) => ({ id, at: NOW, by: "app", title: id, key: STATUS, state: "applied", canUndo: false, ...extra });
  const log = {
    entries: [
      entry("undid-d", { undoes: "d", key: undefined }),
      entry("d", { state: "undone" }),
      entry("c", { canUndo: true }),
      entry("b", { superseded: true }),
      entry("a", { superseded: true }),
    ],
  };
  assert.equal(model.newerChange(log, log.entries[4]).id, "c");
  assert.equal(model.newerChange(log, log.entries[3]).id, "c");
}

// --- The page ----------------------------------------------------------------------------------------

/** Activity on the stand-in, at the fixtures' time, with the `log` reply in the store. */
function activityPage({ log = structuredClone(LOG), state = {} } = {}) {
  const page = standIn();
  const sent = [];
  const runs = [];
  const changes = [];
  let refreshed = 0;
  const app = page.store({
    activity: log,
    historyPending: false,
    working: "",
    modal: null,
    palette: false,
    sheets: 0,
    ...state,
  });
  const { Activity } = load(
    "simple/Activity.tsx",
    {
      "./cleanup-activity.css": {},
      "../helpers": helpers,
      "../words": words,
      "./model": model,
      react: page.react,
      "../api": {
        api: async (name, body) => {
          sent.push([name, body ?? {}]);
          return {};
        },
      },
      "../clock": { useNow: () => Date.parse(NOW) },
      "../common": { Icon: nothing },
      "../store": {
        useApp: app,
        run: async (task, working, options) => {
          runs.push([working, options]);
          try {
            return await task();
          } catch {
            return undefined;
          }
        },
        changed: (...args) => changes.push(args),
        refreshLog: async () => {
          refreshed++;
        },
      },
      "./ui": simpleBlocks(),
    },
    { ...held, document: page.document, HTMLElement: Host },
  );
  page.mount(createElement(Activity));
  return {
    ...page,
    app,
    sent,
    runs,
    changes,
    refreshed: () => refreshed,
    row: (id) => page.find((n) => n.props["data-id"] === id),
    shown: () =>
      page.all((n) => n.props["data-ui"] === "entry").map((n) => n.props["data-id"]),
    chip: (key) =>
      page.find(
        (n) =>
          n.type === "button" &&
          n.props["aria-pressed"] !== undefined &&
          n.textContent.startsWith(said.filters[key]),
      ),
    filled: () =>
      page.all((n) => n.type === "button" && n.props["data-kind"] === "filled"),
  };
}
const buttonsIn = (row) =>
  row
    .descendants()
    .filter((n) => n.type === "button")
    .map((n) => n.props["aria-label"] ?? n.textContent);

export async function eachChangeIsOneSentenceAndFollowsTheLogsUndoRules() {
  const page = activityPage();
  assert.equal(page.refreshed(), 1, "the page asks for the log when it opens");
  assert.deepEqual(page.shown(), ["e6", "e5", "e4", "e3", "e2", "e1"]);
  assert.deepEqual(
    page.all((n) => n.type === "h2").map((n) => n.textContent),
    ["Today", "Yesterday"],
  );
  // What happened, who and when.
  assert.match(page.row("e6").textContent, /^Moved acme-store to clientsYour AI, 10 minutes ago/);
  assert.match(page.row("e5").textContent, /^Status of kopi-landing set to activeYou, 20 minutes ago/);
  assert.match(page.row("e3").textContent, /Laci, by itself, 40 minutes ago/);
  assert.match(page.row("e2").textContent, /You, yesterday/);
  // Can be undone: its own Undo.
  assert.deepEqual(buttonsIn(page.row("e5")), [said.undo("Status of kopi-landing set to active")]);
  // Changed again later: no Undo, it says why, and it points to the newer change.
  assert.match(page.row("e4").textContent, new RegExp(said.changedLater));
  assert.deepEqual(buttonsIn(page.row("e4")), [said.showNewer]);
  const info = page.row("e4").descendants().find((n) => n.props["data-info"]);
  assert.ok(words.termOf(info.props["data-info"]), "its ⓘ has its word in Help");
  // Undone, or a change that didn't finish: no Undo.
  assert.match(page.row("e2").textContent, new RegExp(said.undone));
  assert.deepEqual(buttonsIn(page.row("e2")), []);
  assert.match(page.row("e1").textContent, new RegExp(said.didNotFinish));
  assert.match(page.row("e1").textContent, /habit-app is in use/, "why, in What changed");
  assert.deepEqual(buttonsIn(page.row("e1")), []);
  // Nothing to undo and nothing wrong: no button and no word about Undo.
  assert.deepEqual(buttonsIn(page.row("e3")), []);
  // The steps the engine names, behind What changed.
  assert.match(page.row("e6").textContent, /Moved~\/project\/acme-store → ~\/project\/clients\/acme-store/);

  // A row's Undo sends the request Detailed's Log sends, and the focus goes to that row.
  const undo = page.button(said.undo("Status of kopi-landing set to active"));
  page.act(() => undo.focus());
  page.act(() => undo.props.onClick());
  await page.settle();
  assert.deepEqual(page.sent, [["log/undo", { id: "e5" }]]);
  assert.deepEqual(page.runs, [[said.undoing, { history: true }]]);
  assert.deepEqual(page.changes[0].slice(1), [said.undone, "Status of kopi-landing set to active"]);
  assert.equal(page.focused(), describe(page.row("e5")));
}

export async function theFilledButtonUndoesTheNewestChangeThatCanBeUndone() {
  const page = activityPage();
  assert.deepEqual(
    page.filled().map((b) => b.textContent),
    [said.undo("Moved acme-store to clients")],
  );
  // Pressed from the keyboard, so the focus is on it.
  page.act(() => page.filled()[0].focus());
  page.act(() => page.filled()[0].props.onClick());
  await page.settle();
  assert.deepEqual(page.sent, [["log/undo", { id: "e6" }]]);
  // The button stays and names the next change: the focus moves to the change it undid instead, so
  // a second Enter doesn't undo another one.
  assert.equal(page.focused(), describe(page.row("e6")));
  // While the history is checked again, nothing can be undone.
  page.app.setState({ historyPending: true });
  await page.settle();
  assert.equal(page.filled()[0].props.disabled, true);
  assert.equal(page.button(said.undo("Status of kopi-landing set to active")).props.disabled, true);
  // With nothing left to undo there is no filled button.
  page.app.setState({
    historyPending: false,
    activity: { entries: LOG.entries.map((e) => ({ ...e, canUndo: false })) },
  });
  await page.settle();
  assert.deepEqual(page.filled().map(describe), []);
}

export async function theFiltersShowWhoMadeAChangeAndWhatCanBeUndone() {
  const page = activityPage();
  assert.equal(page.chip("all").props["aria-pressed"], true);
  assert.match(page.chip("mine").textContent, /3$/);
  page.act(() => page.chip("ai").props.onClick());
  assert.deepEqual(page.shown(), ["e6", "e1"]);
  assert.equal(page.chip("ai").props["aria-pressed"], true);
  page.act(() => page.chip("undo").props.onClick());
  assert.deepEqual(page.shown(), ["e6", "e5"]);
  page.act(() => page.chip("mine").props.onClick());
  assert.deepEqual(page.shown(), ["e5", "e4", "e2"]);
  // "Show the newer change" shows every change again and takes the focus to it.
  const search = page.find((n) => n.type === "input");
  page.act(() => search.props.onChange({ target: { value: "paused" } }));
  assert.deepEqual(page.shown(), ["e4"]);
  page.act(() => page.button(said.showNewer).props.onClick());
  assert.deepEqual(page.shown(), ["e6", "e5", "e4", "e3", "e2", "e1"]);
  assert.equal(page.chip("all").props["aria-pressed"], true);
  assert.equal(page.focused(), describe(page.row("e5")));
  // A search that finds nothing says so, and offers to clear it.
  page.act(() => page.find((n) => n.type === "input").props.onChange({ target: { value: "zebra" } }));
  assert.deepEqual(page.shown(), []);
  assert.match(page.text(), new RegExp(said.noMatch("zebra")));
  page.act(() => page.button(said.clearSearch).props.onClick());
  assert.equal(page.shown().length, 6);
}

export async function activitySaysWhileItReadsAndWhenItCant() {
  assert.match(activityPage({ log: null }).text(), new RegExp(said.reading));
  const empty = activityPage({ log: { entries: [] } });
  assert.match(empty.text(), new RegExp(said.emptyTitle));
  assert.deepEqual(empty.filled().map(describe), []);
  const failed = activityPage({ log: { entries: [], error: "The log is locked" } });
  assert.match(failed.text(), new RegExp(said.failed));
  assert.match(failed.text(), /The log is locked/);
  failed.act(() => failed.button(said.tryAgain).props.onClick());
  assert.equal(failed.refreshed(), 2);
  // The diagnostics log is in ⋯, as Detailed's Debug log.
  const page = activityPage();
  page.act(() => page.button(said.diagnostics).props.onClick());
  await page.settle();
  assert.deepEqual(page.sent, [["log/open", {}]]);
}
