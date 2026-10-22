// Simple's Activity (ui/src/simple/Activity.tsx and its part of ui/src/simple/model.ts): one sentence
// per change in Simple's words, the filters by who made it and what can be undone, the filled Undo of
// the newest change that can be undone, and the Undo rules of Detailed's Log.
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
      title: "Move acme-store → ~/project/clients/acme-store",
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
    /** What a change's What changed holds, as words. */
    whatChanged: (id) =>
      page
        .find((n) => n.props["data-id"] === id)
        .descendants()
        .find((n) => n.props["data-disclosure"] === said.whatChanged)?.textContent,
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
  // What happened, who and when, in Simple's words.
  assert.match(page.row("e6").textContent, /^Moved acme-storeYour AI, 10 minutes ago/);
  assert.match(page.row("e5").textContent, /^Set the status of kopi-landing to ActiveYou, 20 minutes ago/);
  assert.match(page.row("e3").textContent, /Laci, by itself, 40 minutes ago/);
  assert.match(page.row("e2").textContent, /You, yesterday/);
  // Can be undone: its own Undo.
  assert.deepEqual(buttonsIn(page.row("e5")), [said.undo("Set the status of kopi-landing to Active")]);
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
  // The engine's title and the steps it names, behind What changed.
  assert.equal(
    page.whatChanged("e6"),
    "Move acme-store → ~/project/clients/acme-store" +
      "Moved~/project/acme-store → ~/project/clients/acme-store",
  );

  // A row's Undo sends the request Detailed's Log sends, and the focus goes to that row.
  const undo = page.button(said.undo("Set the status of kopi-landing to Active"));
  page.act(() => undo.focus());
  page.act(() => undo.props.onClick());
  await page.settle();
  assert.deepEqual(page.sent, [["log/undo", { id: "e5" }]]);
  assert.deepEqual(page.runs, [[said.undoing, { history: true }]]);
  assert.deepEqual(page.changes[0].slice(1), [said.undone, "Set the status of kopi-landing to Active"]);
  assert.equal(page.focused(), describe(page.row("e5")));
}

export async function theFilledButtonUndoesTheNewestChangeThatCanBeUndone() {
  const page = activityPage();
  assert.deepEqual(
    page.filled().map((b) => b.textContent),
    [said.undo("Moved acme-store")],
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
  assert.equal(page.button(said.undo("Set the status of kopi-landing to Active")).props.disabled, true);
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

// --- In Simple's words ---------------------------------------------------------------------------

const PORTFOLIO = "/home/demo/project/_archive/old-portfolio";
const ACME = "/home/demo/project/clients/acme-store";
/** A change as the engine records it, with its title in the engine's words. */
const change = (id, title, more = {}) => ({
  id,
  at: NOW,
  by: "app",
  title,
  state: "applied",
  canUndo: false,
  superseded: false,
  ...more,
});

/**
 * The engine's titles of each kind of change, with its keys and journals as it records them
 * (laci-core: service.rs, ops.rs, scan.rs, reports.rs, secrets.rs, storage.rs, mcp_setup.rs), and
 * what Activity says for each.
 */
const SAID = [
  // Suggestions applied in Clean up: the journal takes the suggestion's title.
  [
    change("a1", "Reconnect 1 session + 1 memory file to old-portfolio", { journal: "j1", path: PORTFOLIO }),
    "Reconnected the AI chats of old-portfolio",
  ],
  [change("a2", "Finish 2 half-done moves", { journal: "j2" }), "Finished 2 unfinished moves"],
  [change("a3", "Free 440 MB from 1 inactive project", { journal: "j3" }), "Freed 440 MB in 1 project"],
  [
    change("a4", "3 Codex sessions for deleted habit-app", {
      journal: "j4",
      steps: [{ kind: "move", label: "Moved", from: "~/.codex/sessions/1.jsonl", to: "~/.local/share/laci/orphans/codex" }],
    }),
    "Set aside the AI chats left from habit-app",
  ],
  [
    change("a5", "2 sessions + 1 memory file for a folder that is gone", {
      journal: "j5",
      steps: [{ kind: "delete", label: "Moved to the trash", from: "~/.claude/projects/-home-demo-gone" }],
    }),
    "Moved leftover AI chats to the Trash",
  ],
  // An older entry comes without its journal's steps: the detail, written only for what went to the
  // bin, tells the two apart.
  [
    change("a4b", "3 Codex sessions for deleted habit-app", { journal: "j4b" }),
    "Set aside the AI chats left from habit-app",
  ],
  [
    change("a5b", "2 sessions + 1 memory file for a folder that is gone", {
      journal: "j5b",
      detail: "Restore it through your system Trash.",
    }),
    "Moved leftover AI chats to the Trash",
  ],
  // Changes Undo takes back step by step.
  [change("a6", "Archive habit-app", { journal: "j6", path: "/home/demo/project/side/habit-app" }), "Archived habit-app"],
  [
    change("a7", "Move kopi-landing → ~/project/clients/kopi-landing", { journal: "j7", by: "agent", path: KOPI }),
    "Moved kopi-landing",
  ],
  [change("a8", "Deleted the build output of acme-store", { journal: "j8", path: ACME }), "Freed up space in acme-store"],
  [change("a9", "Deleted the session “Fix the checkout”", { journal: "j9" }), "Deleted the chat “Fix the checkout”"],
  [change("a10", "Deleted 3 sessions", { journal: "j10" }), "Deleted 3 chats"],
  [
    change("a11", "Added .env to .gitignore in kopi-landing", { journal: "j11", key: `gitignore:${KOPI}`, path: KOPI }),
    "Kept 1 file of kopi-landing out of saved versions",
  ],
  [
    change("a12", "Added 2 files to .gitignore in kopi-landing", { journal: "j12", key: `gitignore:${KOPI}`, path: KOPI }),
    "Kept 2 files of kopi-landing out of saved versions",
  ],
  // A project's Laci notes file, the settings and the summaries, by their keys.
  [change("b1", "Status of kopi-landing set to dormant", { key: STATUS, path: KOPI }), "Set the status of kopi-landing to Inactive"],
  [change("b2", "Status of kopi-landing cleared", { key: STATUS, path: KOPI }), "Let Laci set the status of kopi-landing"],
  [
    change("b3", "Priority of kopi-landing set to high", { key: `meta:${KOPI}:priority`, path: KOPI }),
    "Set the priority of kopi-landing to high",
  ],
  [
    change("b4", "Deadline of kopi-landing set to 2026-10-20", { key: `meta:${KOPI}:deadline`, path: KOPI }),
    /^Set the due date of kopi-landing to (20 October|October 20)$/,
  ],
  [change("b5", "Deadline of kopi-landing cleared", { key: `meta:${KOPI}:deadline`, path: KOPI }), "Removed the due date of kopi-landing"],
  [change("b6", "Muted “No remote” on kopi-landing", { key: `meta:${KOPI}:quiet`, path: KOPI }), "Hid a warning about kopi-landing"],
  [
    change("b7", "Unmuted “No remote” on kopi-landing", { key: `meta:${KOPI}:quiet`, path: KOPI }),
    "Asked Laci to warn about kopi-landing again",
  ],
  [
    change("b8", "Ticked a to-do in kopi-landing", { key: `todo:${KOPI}:.laci.md:Ship it:0`, path: KOPI }),
    "Ticked a to-do in kopi-landing",
  ],
  [
    change("b9", "Deleted a next step from kopi-landing", { key: `todo:${KOPI}:.laci.md:Ship it:0`, path: KOPI }),
    "Deleted a next step from kopi-landing",
  ],
  [change("b10", "Edited the notes of kopi-landing", { key: `notes:${KOPI}`, path: KOPI }), "Edited the notes of kopi-landing"],
  [change("b11", "Added Codex history", { key: "connector:codex" }), "Laci shows the chats of Codex"],
  [change("b12", "Removed Codex history", { key: "connector:codex" }), "Laci no longer shows the chats of Codex"],
  [change("b13", "Removed My runner", { key: "connector:my-runner" }), "Removed My runner"],
  [
    change("b14", "Closed an item of the report “Checkout flow”", { key: "report:2026-10-08-checkout.md:ship" }),
    "Closed an item of the summary “Checkout flow”",
  ],
  [change("b15", "Changed settings", { key: "settings" }), "Changed settings"],
  // What the engine only records.
  [change("c1", "Moved kopi-landing to system Trash", { path: KOPI }), "Moved kopi-landing to the Trash"],
  [change("c2", "Dismissed: Archive habit-app?"), "Hid a suggestion for 90 days"],
  [change("c3", "Backed up 3 agent history files", { by: "auto" }), "Copied 3 chat files"],
  [change("c4", "Agent history backup is up to date"), "The copy of AI chats was up to date"],
  [change("c5", "Automatic history backup turned on"), "Laci now copies new chats by itself"],
  [change("c6", "Restored a Claude Code session from the backup"), "Put back a Claude Code chat from Laci’s copy"],
  [change("c7", "Emptied the quarantine of deleted sessions and history"), "Emptied Kept for Undo"],
  [change("c8", "Added Laci's MCP server to Claude Code"), "Let Claude Code use Laci"],
  [change("c9", "Created landing-page", { path: "/home/demo/project/landing-page" }), "Created landing-page"],
  // An Undo names the change it undid the same way, or says only that it undid one.
  [change("d1", "Undid: Archive habit-app", { undoes: "a6" }), "Undid: Archived habit-app"],
  [change("d2", "Undid: Move kopi → ~/work/kopi", { undoes: "j:gone" }), "Undid a change"],
  // A title this page doesn't know yet keeps the engine's words.
  [change("e1", "Renamed kopi to kopi-landing", { key: "rename:kopi" }), "Renamed kopi to kopi-landing"],
];

export async function eachKindOfChangeIsSaidInSimplesWords() {
  const page = activityPage({ log: { entries: SAID.map(([entry]) => entry) } });
  const sentence = (id) =>
    page.row(id).descendants().find((n) => n.type === "span").textContent;
  for (const [entry, said] of SAID) {
    if (said instanceof RegExp) assert.match(sentence(entry.id), said, entry.title);
    else assert.equal(sentence(entry.id), said, entry.title);
  }
  // None of the engine's words or paths, which Simple keeps behind What changed (rule 5).
  for (const [entry] of SAID.slice(0, -1))
    assert.doesNotMatch(
      sentence(entry.id),
      /\b(sessions?|agents?|memory|half-done|history|report|quarantine|MCP|output|backup|Dismissed)\b|~\/|→/i,
      entry.title,
    );
  // There the engine's own title waits, and nothing more where the words are the same.
  assert.equal(page.whatChanged("a7"), "Move kopi-landing → ~/project/clients/kopi-landing");
  assert.equal(page.whatChanged("a1"), "Reconnect 1 session + 1 memory file to old-portfolio");
  assert.equal(page.whatChanged("b10"), undefined);
  assert.equal(page.whatChanged("e1"), undefined);
}

export async function theUndoButtonsTheToastAndTheSearchUseThoseWordsToo() {
  // Chats reconnected in Clean up, then chats deleted in AI helpers.
  const page = activityPage({
    log: {
      entries: [
        change("x2", "Deleted 3 sessions", { journal: "j2", canUndo: true }),
        change("x1", "Reconnect 1 session + 1 memory file to old-portfolio", {
          journal: "j1",
          canUndo: true,
          path: PORTFOLIO,
        }),
      ],
    },
  });
  assert.deepEqual(page.filled().map((b) => b.textContent), [said.undo("Deleted 3 chats")]);
  assert.deepEqual(buttonsIn(page.row("x1")), [said.undo("Reconnected the AI chats of old-portfolio")]);
  page.act(() => page.filled()[0].props.onClick());
  await page.settle();
  assert.deepEqual(page.sent, [["log/undo", { id: "x2" }]]);
  assert.deepEqual(page.changes[0].slice(1), [said.undone, "Deleted 3 chats"]);
  // The search finds a change by the words it shows.
  const search = (value) =>
    page.act(() => page.find((n) => n.type === "input").props.onChange({ target: { value } }));
  search("AI chats");
  assert.deepEqual(page.shown(), ["x1"]);
  search("chats");
  assert.deepEqual(page.shown(), ["x2", "x1"]);
}

// --- Told from the parts the engine records -----------------------------------------------------------

/** A change Laci 3.0 recorded: its form and parts, under a title Activity no longer has to read. */
const saying = (id, say, more = {}) => change(id, `Engine title ${id}`, { say, ...more });
const MOVED_TO_KEPT = [{ kind: "move", label: "Moved", from: "~/.codex/sessions/1.jsonl", to: "~/.local/share/laci/orphans/codex" }];
const MOVED_TO_TRASH = [{ kind: "delete", label: "Moved to the trash", from: "~/.claude/projects/-home-demo-gone" }];

/** Each form the engine records (laci-core, src-tauri), with parts as it writes them, and its sentence. */
const FORMS = [
  [{ form: "moved", name: "kopi-landing" }, "Moved kopi-landing"],
  [{ form: "archived", name: "habit-app" }, "Archived habit-app"],
  [{ form: "reconnected", name: "old-portfolio" }, "Reconnected the AI chats of old-portfolio"],
  [{ form: "chatsForGone" }, "Set aside leftover AI chats", { steps: MOVED_TO_KEPT }],
  [{ form: "chatsForGone" }, "Moved leftover AI chats to the Trash", { steps: MOVED_TO_TRASH }],
  [{ form: "chatsForDeleted", name: "habit-app" }, "Set aside the AI chats left from habit-app", { steps: MOVED_TO_KEPT }],
  [{ form: "chatsForDeleted", name: "habit-app" }, "Moved the AI chats left from habit-app to the Trash", { steps: MOVED_TO_TRASH }],
  [{ form: "finishedMoves", moves: 2 }, "Finished 2 unfinished moves"],
  [{ form: "freed", size: "440 MB", projects: 1 }, "Freed 440 MB in 1 project"],
  [{ form: "clearedBuild", name: "acme-store" }, "Freed up space in acme-store"],
  [{ form: "deletedChat", title: "Fix the checkout" }, "Deleted the chat “Fix the checkout”"],
  [{ form: "deletedChats", chats: 3 }, "Deleted 3 chats"],
  [{ form: "keptOut", files: 2, name: "kopi-landing" }, "Kept 2 files of kopi-landing out of saved versions"],
  [{ form: "setStatus", name: "kopi-landing", status: "dormant" }, "Set the status of kopi-landing to Inactive"],
  [{ form: "clearedStatus", name: "kopi-landing" }, "Let Laci set the status of kopi-landing"],
  [{ form: "setPriority", name: "kopi-landing", priority: "high" }, "Set the priority of kopi-landing to high"],
  [{ form: "clearedPriority", name: "kopi-landing" }, "Removed the priority of kopi-landing"],
  [
    { form: "setDeadline", name: "kopi-landing", deadline: "2026-10-20" },
    /^Set the due date of kopi-landing to (20 October|October 20)$/,
  ],
  [{ form: "clearedDeadline", name: "kopi-landing" }, "Removed the due date of kopi-landing"],
  [{ form: "setClient", name: "kopi-landing", client: "Kopi Co" }, "Set the client of kopi-landing to Kopi Co"],
  [{ form: "clearedClient", name: "kopi-landing" }, "Removed the client of kopi-landing"],
  [{ form: "muted", name: "kopi-landing", check: "no-remote" }, "Hid a warning about kopi-landing"],
  [{ form: "unmuted", name: "kopi-landing", check: "no-remote" }, "Asked Laci to warn about kopi-landing again"],
  [{ form: "changedMuted", name: "kopi-landing" }, "Changed the hidden warnings of kopi-landing"],
  [{ form: "addedStep", name: "kopi-landing" }, "Added a next step to kopi-landing"],
  [{ form: "ticked", name: "kopi-landing" }, "Ticked a to-do in kopi-landing"],
  [{ form: "unticked", name: "kopi-landing" }, "Unticked a to-do in kopi-landing"],
  [{ form: "editedTodo", name: "kopi-landing" }, "Edited a to-do in kopi-landing"],
  [{ form: "deletedStep", name: "kopi-landing" }, "Deleted a next step from kopi-landing"],
  [{ form: "editedNotes", name: "kopi-landing" }, "Edited the notes of kopi-landing"],
  [{ form: "addedHistory", ai: "Codex" }, "Laci shows the chats of Codex"],
  [{ form: "removedHistory", ai: "Codex" }, "Laci no longer shows the chats of Codex"],
  [{ form: "addedTool", ai: "My runner" }, "Added My runner"],
  [{ form: "removedTool", ai: "My runner" }, "Removed My runner"],
  [{ form: "closedItem", title: "Checkout flow" }, "Closed an item of the summary “Checkout flow”"],
  [{ form: "reopenedItem", title: "Checkout flow" }, "Opened an item of the summary “Checkout flow” again"],
  [{ form: "trashed", name: "kopi-landing" }, "Moved kopi-landing to the Trash"],
  [{ form: "dismissed", title: "Archive habit-app?" }, "Hid a suggestion for 90 days"],
  [{ form: "suggestedAgain", title: "Archive habit-app?" }, "Brought back a hidden suggestion"],
  [{ form: "backedUp", files: 3 }, "Copied 3 chat files"],
  [{ form: "backupUpToDate" }, "The copy of AI chats was up to date"],
  [{ form: "autoBackupOn" }, "Laci now copies new chats by itself"],
  [{ form: "autoBackupOff" }, "Laci now copies chats only when you ask"],
  [{ form: "restoredChat", ai: "Claude Code" }, "Put back a Claude Code chat from Laci’s copy"],
  [{ form: "restoredChat" }, "Put back a chat from Laci’s copy"],
  [{ form: "movedCopy", dir: "/mnt/archive/ai-chats" }, "Moved the copy of AI chats to /mnt/archive/ai-chats"],
  // Laci's own folder is said by its name, not by its path.
  [{ form: "movedCopy", dir: "~/.local/share/laci/history", own: true }, "Moved the copy of AI chats to Laci’s own folder"],
  [{ form: "keptCopyIn", dir: "/mnt/archive/ai-chats" }, "Laci keeps the copy of AI chats in /mnt/archive/ai-chats from now on"],
  [
    { form: "keptCopyIn", dir: "~/.local/share/laci/history", own: true },
    "Laci keeps the copy of AI chats in its own folder from now on",
  ],
  [{ form: "emptiedKept" }, "Emptied Kept for Undo"],
  [{ form: "removedOldUndo" }, "Removed the old undo records"],
  [{ form: "removedLaci1" }, "Removed the leftovers of Laci 1"],
  [{ form: "letUse", ai: "Claude Code" }, "Let Claude Code use Laci"],
  [{ form: "stoppedUse", ai: "Claude Code" }, "Stopped Claude Code from using Laci"],
  [{ form: "created", name: "landing-page" }, "Created landing-page"],
  [{ form: "changedSettings" }, "Changed settings"],
  [{ form: "undid" }, "Undid a change"],
];

/** Each sentence on Activity's rows, by entry id. */
function sentences(entries) {
  const page = activityPage({ log: { entries } });
  return (id) => page.row(id).descendants().find((n) => n.type === "span").textContent;
}

export async function eachFormTheEngineRecordsIsToldWithItsOwnSentence() {
  const entries = FORMS.map(([say, , more], i) => saying(`f${i}`, say, more));
  const sentence = sentences(entries);
  FORMS.forEach(([say, told], i) => {
    if (told instanceof RegExp) assert.match(sentence(`f${i}`), told, say.form);
    else assert.equal(sentence(`f${i}`), told, say.form);
  });
  // Every form words.ts has a sentence for is one the engine records, and each is told above.
  const told = new Set(FORMS.map(([say]) => say.form));
  for (const form of Object.keys(words.logForms).filter((f) => f !== "restoredChatAny"))
    assert.ok(told.has(form), `${form} is told`);
  assert.deepEqual([...told].filter((f) => !Object.hasOwn(words.logForms, f)), []);
}

export async function anUndoNamesTheChangeItUndidFromItsParts() {
  const sentence = sentences([
    saying("u1", { form: "undid" }, { undoes: "m1" }),
    saying("m1", { form: "moved", name: "kopi-landing" }, { journal: "j1", state: "undone" }),
    saying("u2", { form: "undid" }, { undoes: "j:gone" }),
  ]);
  assert.equal(sentence("u1"), "Undid: Moved kopi-landing");
  assert.equal(sentence("u2"), "Undid a change");
}

export async function anEntryWithoutPartsItKnowsIsToldFromItsTitleAsBefore() {
  const sentence = sentences([
    // A form this window doesn't know yet, or one missing a part, is told from its title.
    change("n1", "Archive habit-app", { journal: "j1", say: { form: "renamed", name: "habit-app" } }),
    change("n2", "Status of kopi-landing set to dormant", { key: STATUS, say: { form: "setStatus", name: "kopi-landing" } }),
    change("n3", "Deleted 3 sessions", { journal: "j3", say: { form: "deletedChats", chats: "3" } }),
    // A Log written by Laci 2.5 or earlier has no parts at all.
    change("n4", "Backed up 3 agent history files"),
    // And a title nothing knows keeps the engine's words.
    change("n5", "Renamed kopi to kopi-landing", { say: { form: "renamed" } }),
  ]);
  assert.equal(sentence("n1"), "Archived habit-app");
  assert.equal(sentence("n2"), "Set the status of kopi-landing to Inactive");
  assert.equal(sentence("n3"), "Deleted 3 chats");
  assert.equal(sentence("n4"), "Copied 3 chat files");
  assert.equal(sentence("n5"), "Renamed kopi to kopi-landing");
}

export async function aToldChangeKeepsTheEnginesTitleBehindWhatChanged() {
  const page = activityPage({
    log: {
      entries: [
        change("w1", "Move kopi-landing → ~/project/clients/kopi-landing", {
          journal: "j1",
          canUndo: true,
          say: { form: "moved", name: "kopi-landing" },
        }),
      ],
    },
  });
  assert.equal(page.whatChanged("w1"), "Move kopi-landing → ~/project/clients/kopi-landing");
  assert.deepEqual(page.filled().map((b) => b.textContent), [said.undo("Moved kopi-landing")]);
}
