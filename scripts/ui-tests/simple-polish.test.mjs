// Simple's update parts (ui/src/simple/updates.tsx: the panel in Settings › Updates and the card on
// Home) on the update store with a desktop of the test's own, and the two follow-ups of M4's review:
// a summary item closed in Simple's words (ui/src/actions.ts) and a project's Recent changes told as
// Activity tells them (ui/src/simple/ProjectPage.tsx). The release notes' links are underlined as
// every link in Simple is (ui/src/simple/simple.css).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";
import { describe, heldDate, simpleBlocks, standIn } from "./react-stand-in.mjs";

const { createElement, Fragment } = requireUi("react");
const nothing = () => null;
const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);

/** A local time on a day of October 2026, so "3 days ago" is that wherever the test runs. */
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const NOW = at(8, 15);
// Compiled once, with the clock held at NOW, and handed to each page below: it is the slow part to compile.
const words = load("words.ts", {}, { Date: heldDate(NOW) });
const say = words.polish.updates;
const card = words.polish.card;

// ── The window's own store and actions ─────────────────────────────────────────────────────────────

const newStorage = () => ({ shelf: new Map(), broken: false });
/**
 * What the running test gives the window: the browser's storage, which refuses every read and write
 * once `broken`, and the requests it sends. The store and the actions are compiled once for the file's
 * tests, which run one after another.
 */
const world = { requests: [], storage: newStorage() };
const api = {
  api: async (name, body) => void world.requests.push([name, body]),
  errorText: String,
};
const windowStore = load("store.ts", { "./api": api }, {
  document: { documentElement: { dataset: {} } },
  localStorage: {
    getItem: (key) => {
      if (world.storage.broken) throw new Error("The storage is blocked");
      return world.storage.shelf.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (world.storage.broken) throw new Error("The storage is blocked");
      world.storage.shelf.set(key, value);
    },
  },
  setTimeout: () => 0,
  clearTimeout: () => {},
});
const windowActions = load("actions.ts", { "./api": api, "./store": windowStore });
/** The window started afresh: nothing sent, no toast, in `design`, on `storage`. */
function startWindow({ design = "detailed", storage = newStorage() } = {}) {
  world.requests = [];
  world.storage = storage;
  windowStore.useApp.setState({ design, toast: null });
  return {
    requests: world.requests,
    toast: () => {
      const { title, message } = windowStore.useApp.getState().toast ?? {};
      return { title, message };
    },
  };
}

// ── A summary item, closed in Simple's words ───────────────────────────────────────────────────────

export async function aSummaryItemClosedInSimpleIsToldInSimplesWords() {
  const session = startWindow({ design: "simple" });
  const said = [];
  for (const state of ["done", "dropped", "open"]) {
    await windowActions.closeReportItem("2026-10-07-checkout.md", "Send the link", state);
    said.push(session.toast());
  }
  // It sends what it always sent. Simple has summaries and Still to do, not a report to close an item in.
  assert.deepEqual(session.requests.at(-1), [
    "report/close",
    { report: "2026-10-07-checkout.md", text: "Send the link", state: "open" },
  ]);
  assert.deepEqual(said, [
    { title: "Marked as done", message: "Send the link" },
    { title: "Marked as not needed", message: "Send the link" },
    { title: "Back in Still to do", message: "Send the link" },
  ]);
  for (const { title } of said) assert.doesNotMatch(title, /report/i);
}

export async function aReportItemClosedInDetailedIsToldAsItWas() {
  const session = startWindow({ design: "detailed" });
  const said = [];
  for (const state of ["done", "dropped", "open"]) {
    await windowActions.closeReportItem("r.md", "Promo codes", state);
    said.push(session.toast().title);
  }
  assert.deepEqual(said, ["Closed in the report", "Closed in the report", "Opened again"]);
}

// ── Recent changes on a project's page ─────────────────────────────────────────────────────────────

const KOPI = "/home/demo/project/clients/kopi-landing";
const ACME = "/home/demo/project/clients/acme-store";
/** What the engine logged, as the `log` reply has it. */
const entry = (id, minutes, more) => ({
  id,
  at: new Date(Date.parse(NOW) - minutes * 60_000).toISOString(),
  by: "app",
  state: "applied",
  canUndo: false,
  superseded: false,
  path: KOPI,
  ...more,
});
const LOG = {
  entries: [
    entry("u1", 5, { by: "agent", title: "Undo Archive kopi-landing", undoes: "e6" }),
    entry("e8", 10, {
      title: "Added 2 files to .gitignore in kopi-landing",
      key: `gitignore:${KOPI}`,
      canUndo: true,
    }),
    entry("e7", 20, {
      by: "agent",
      title: "Deadline of kopi-landing set to 2026-10-20",
      key: `meta:${KOPI}:deadline`,
    }),
    entry("e6", 30, { title: "Archive kopi-landing", journal: "j6", canUndo: true }),
    entry("e5", 40, {
      by: "auto",
      title: "Backed up 3 agent history files",
      path: `${KOPI}/.claude`,
    }),
    entry("e4", 50, { title: "Status of kopi-landing set to paused", key: `meta:${KOPI}:status` }),
    entry("e3", 60, { title: "Muted “no-remote” on kopi-landing", key: `meta:${KOPI}:quiet` }),
    // Another project's change, and a change that names no folder, never show here.
    entry("e2", 70, { title: "Archive acme-store", journal: "j2", path: ACME, canUndo: true }),
    entry("e1", 80, { title: "Changed settings", key: "settings", path: undefined }),
  ],
};

// The project's page is compiled once too: its imports ask the test that runs now.
const now = { page: null, app: null, undone: [] };
const react = { Fragment };
for (const hook of ["useState", "useRef", "useId", "useMemo", "useCallback", "useEffect", "useLayoutEffect"])
  react[hook] = (...args) => now.page.react[hook](...args);
const appNow = Object.assign((select) => now.app(select), {
  getState: () => now.app.getState(),
  setState: (change) => now.app.setState(change),
});
let projectPage;

/** A project's page, on the stand-in: only its Recent changes card is drawn. */
function recentPage(activity = LOG) {
  const page = standIn();
  const undone = [];
  Object.assign(now, { page, app: page.store({ activity, historyPending: false }), undone });
  projectPage ??= load(
    "simple/ProjectPage.tsx",
    {
      react,
      "../words": words,
      "../actions": { undoLogEntry: (id) => void now.undone.push(id) },
      "../agent-launch": {},
      "../api": {},
      "../clock": { useNow: () => Date.parse(NOW) },
      "../common": { Icon: nothing },
      "../hooks": {},
      "../session-ui": {},
      "../store": { refreshLog: nothing, run: nothing, useApp: appNow, changed: nothing },
      "../terminal-api": {},
      "./act": {},
      "./fix": {},
      "./cleanup-activity.css": {},
      "./ui": simpleBlocks({
        Card: ({ title, children, footer }) => createElement("section", null, title, children, footer),
      }),
    },
    { Date: heldDate(NOW), document: {} },
  );
  page.mount(createElement(projectPage.RecentCard, { n: { id: KOPI, path: KOPI } }));
  return { ...page, undone };
}

export async function aProjectsRecentChangesAreToldAsActivityTellsThem() {
  const page = recentPage();
  const items = page.all((n) => n.type === "li").map((n) => n.textContent);
  // The month in full, in the order the machine writes it ("20 October" or "October 20").
  const due = new Date(2026, 9, 20).toLocaleDateString(undefined, { day: "numeric", month: "long" });
  // The newest five of this project's changes, one sentence each, with who made it and when.
  assert.deepEqual(items, [
    "Undid: Archived kopi-landingYour AI, 5 minutes ago",
    "Kept 2 files of kopi-landing out of saved versionsYou, 10 minutes agoUndo",
    `Set the due date of kopi-landing to ${due}Your AI, 20 minutes ago`,
    "Archived kopi-landingYou, 30 minutes agoUndo",
    "Copied 3 chat filesLaci, by itself, 40 minutes ago",
  ]);
  // Not a word of the engine's: Git's .gitignore, an ISO date, a title that names its own kind.
  assert.doesNotMatch(page.text(), /gitignore|2026-10-20|Backed up|Status of|Muted/);
}

export async function undoInRecentChangesNamesTheChangeAndSendsTheLogsUndo() {
  const page = recentPage();
  const kept = "Kept 2 files of kopi-landing out of saved versions";
  assert.deepEqual(
    page.all((n) => n.type === "button" && n.props["aria-label"]).map((n) => n.props["aria-label"]),
    [`Undo: ${kept}`, "Undo: Archived kopi-landing"],
  );
  page.act(() => page.button(`Undo: ${kept}`).props.onClick());
  assert.deepEqual(page.undone, ["e8"]);
}

export async function anUndoNamesTheChangeItUndidWhereverThatWasMade() {
  // The Undo is in this project and what it undid is in another: the whole log is told first.
  const log = {
    entries: [
      entry("u1", 5, { title: "Undo Archive acme-store", undoes: "e2" }),
      entry("e2", 70, { title: "Archive acme-store", journal: "j2", path: ACME }),
    ],
  };
  const page = recentPage(log);
  assert.deepEqual(
    page.all((n) => n.type === "li").map((n) => n.textContent),
    ["Undid: Archived acme-storeYou, 5 minutes ago"],
  );
}

export async function recentChangesKeepsItsWordsForTheLogThatIsNotThereOrHoldsNothingHere() {
  const loading = recentPage(null);
  assert.match(loading.text(), new RegExp(words.project.recent.loading));
  const empty = recentPage({ entries: [entry("x", 5, { path: ACME, title: "Archive acme-store" })] });
  assert.match(empty.text(), new RegExp(words.project.recent.empty));
}

// ── Where an update stands ─────────────────────────────────────────────────────────────────────────

/**
 * The window's update store (ui/src/update.ts) on a desktop of the test's own: each request waits until
 * the test answers it, `asked` lists them, and `emit` sends an event as the desktop does.
 */
function desktop() {
  const asked = [];
  const waiting = [];
  const listeners = [];
  const module = load("update.ts", {
    "./api": {
      api: (name, body) => {
        asked.push({ name, body });
        return new Promise((resolve, reject) => waiting.push({ name, resolve, reject }));
      },
      errorText: (error) => (error instanceof Error ? error.message : String(error)),
    },
    "@tauri-apps/api/event": {
      listen: (name, handler) => {
        listeners.push({ name, handler });
        return Promise.resolve(() => {});
      },
    },
  });
  const later = () => new Promise((resolve) => setImmediate(resolve));
  const answer = async (name, how, value) => {
    await later();
    const found = waiting.findIndex((request) => request.name === name);
    assert.ok(found >= 0, `nothing asked for ${name}; asked ${asked.map((a) => a.name)}`);
    waiting.splice(found, 1)[0][how](value);
    await later();
  };
  return {
    module,
    names: () => asked.map((a) => a.name),
    reply: (name, value) => answer(name, "resolve", value),
    refuse: (name, message) => answer(name, "reject", new Error(message)),
    emit: (payload) => {
      for (const l of listeners) if (l.name === "laci") l.handler({ payload: { type: "update", ...payload } });
    },
  };
}

const status = (state, more = {}) => ({ enabled: true, state, current: "3.0.0", install: "click", ...more });
const NEW = {
  version: "3.0.1",
  notes: "### Fixed\n- A project keeps its AI chats.",
  date: at(5, 10),
  url: "https://github.com/mrramdn/laci/releases/tag/v3.0.1",
};
const CHECKED = at(8, 12);

/** readme.ts without marked and its cleaner: what the notes are drawn from, and what asked for it. */
function fakeReadme() {
  const drawn = [];
  const clicks = [];
  return {
    drawn,
    clicks,
    renderReadme: (raw, project, remote) => {
      drawn.push({ raw, project, remote });
      return {
        html: `<p>${raw} <a href="https://example.test/x">a link</a> <abbr>abbr</abbr></p>`,
        remote: remote ? 0 : 2,
        headings: [],
      };
    },
    proseClick: (_event, how) => void clicks.push(how),
  };
}

/** A "Show details" that draws what it holds only once it is open, as the real one does. */
const disclosure = (page) =>
  function Disclosure({ label, openLabel, children }) {
    const [open, setOpen] = page.react.useState(false);
    return createElement(
      "div",
      { "data-disclosure": label },
      createElement("button", { type: "button", onClick: () => setOpen(!open) }, open ? openLabel : label),
      open ? children : null,
    );
  };

/**
 * One of the update parts on the stand-in, on the window's own store, the update store and a desktop of
 * the test's own. The browser's storage is `storage`; `inWindow` false draws it as the page tests do
 * in Node, where there is no document.
 */
function updatesPage(part, { storage = newStorage(), inWindow = true, props = null, document } = {}) {
  const page = standIn();
  const d = desktop();
  const session = startWindow({ storage });
  const refocused = [];
  const markdown = fakeReadme();
  const updates = load(
    "simple/updates.tsx",
    {
      react: page.react,
      "../words": words,
      "../common": { Icon: nothing, restoreFocus: (to) => void refocused.push(to) },
      "../store": {
        pref: windowStore.pref,
        savePref: windowStore.savePref,
        toast: windowStore.toast,
        urlOpen: windowStore.urlOpen,
      },
      "../update": d.module,
      "../readme": markdown,
      "./ui": simpleBlocks({ Disclosure: disclosure(page) }),
    },
    inWindow ? { document: document ?? { documentElement: { dataset: {} } } } : {},
  );
  page.mount(createElement(updates[part], props));
  return {
    ...page,
    d,
    storage,
    refocused,
    markdown,
    /** The last toast, as the window would show it. */
    toast: session.toast,
    /** The addresses the window was asked to open. */
    opened: () => session.requests.filter(([name]) => name === "open/url").map(([, body]) => body.url),
    /** The desktop's answer to the first look, and what the page makes of it. */
    async looks(first) {
      await d.reply("update/status", first);
      await page.settle();
      return page;
    },
    /** The desktop tells the window how the update stands. */
    async told(next) {
      d.emit(next);
      await page.settle();
    },
    buttons: () => page.all((n) => n.type === "button").map((n) => n.textContent),
    /** Where the focus is, in a few words: a failed assert prints a whole element, page and all. */
    focused: () => describe(page.document.activeElement),
    /** The status words, in the same few words. */
    regionWords: () => describe(page.find((n) => n.props.role === "status")),
  };
}

export async function eachStepOfAnUpdateHasItsOneAction() {
  const { stepOf, actionOf } = load("simple/updates.tsx", {
    "../words": words,
    "../common": {},
    "../store": {},
    "../update": {},
    "./ui": {},
  });
  const table = [
    [null, false, "loading", undefined],
    [null, true, "unread", { kind: "refresh", label: say.tryAgain }],
    [status("idle"), false, "unchecked", { kind: "check", label: say.checkNow }],
    [status("idle", { checkedAt: CHECKED }), false, "current", { kind: "check", label: say.checkNow }],
    [status("checking"), false, "checking", undefined],
    [status("available", NEW), false, "found", { kind: "install", label: say.install("3.0.1") }],
    [
      status("available", { ...NEW, install: "notice" }),
      false,
      "link",
      { kind: "open", label: say.openRelease, url: NEW.url },
    ],
    [status("downloading", { ...NEW, progress: 40 }), false, "downloading", undefined],
    [status("ready", NEW), false, "restart", { kind: "restart", label: say.restart }],
    [
      status("error", { ...NEW, error: "The download stopped." }),
      false,
      "failed",
      { kind: "check", label: say.checkAgain },
    ],
  ];
  for (const [given, refused, step, action] of table) {
    assert.equal(stepOf(given, refused), step, step);
    assert.deepEqual(actionOf(step, given), action, step);
  }
  // A link needs somewhere to go, even for a version the desktop gave no page.
  const bare = status("available", { version: "3.0.2", install: "notice" });
  assert.match(actionOf("link", bare).url, /^https:\/\/github\.com\/mrramdn\/laci\/releases/);
}

export async function aPageDrawnWithoutAWindowAsksTheDesktopNothing() {
  // The page tests draw Settings in Node. A page that asked the desktop there would change a store
  // that every page drawn before it, still listening, is told of.
  const page = updatesPage("UpdatePanel", { inWindow: false });
  await page.settle();
  assert.deepEqual(page.d.names(), []);
  assert.match(page.text(), new RegExp(say.loading));
}

export async function theSettingsPanelTellsWhereTheUpdateStandsStepByStep() {
  const page = updatesPage("UpdatePanel");
  // Nothing is known until the desktop answers; the first look asks for it.
  assert.match(page.text(), new RegExp(say.loading));
  await page.settle();
  assert.deepEqual(page.d.names(), ["update/status"]);
  assert.deepEqual(page.buttons(), []);
  // A copy that never looked can't call itself up to date.
  await page.looks(status("idle"));
  assert.match(page.text(), new RegExp(say.neverChecked));
  assert.match(page.text(), /You have version 3\.0\.0\./);
  assert.doesNotMatch(page.text(), new RegExp(say.upToDate));
  assert.deepEqual(page.buttons(), [say.checkNow]);
  assert.equal(page.find((n) => n.type === "button").props["data-kind"], "outline");

  // Check now: the button goes with the step, so the focus goes to the words that tell what comes next.
  page.act(() => page.button(say.checkNow).props.onClick());
  assert.equal(page.focused(), page.regionWords());
  await page.settle();
  assert.deepEqual(page.d.names(), ["update/status", "update/check"]);
  await page.told(status("checking"));
  assert.match(page.text(), new RegExp(say.checking));
  assert.deepEqual(page.buttons(), [], "nothing to do while Laci looks");
  await page.told(status("idle", { checkedAt: CHECKED }));
  await page.d.reply("update/check", status("idle", { checkedAt: CHECKED }));
  await page.settle();
  assert.match(page.text(), new RegExp(say.upToDate));
  assert.match(page.text(), /You have version 3\.0\.0\. Last checked 3 hours ago\./);

  // A new version: what it is, when it came out, and the one button.
  await page.told(status("available", { ...NEW, checkedAt: CHECKED }));
  assert.match(page.text(), new RegExp(say.readyToInstall("3.0.1")));
  assert.match(page.text(), new RegExp(say.released("3 days ago")));
  assert.deepEqual(page.buttons(), [say.whatsNew("3.0.1"), say.install("3.0.1")]);
  page.act(() => page.button(say.install("3.0.1")).props.onClick());
  assert.equal(page.focused(), page.regionWords());
  await page.settle();
  assert.deepEqual(page.d.names().slice(-1), ["update/install"]);
  await page.d.reply("update/install", { started: true });

  // The download, as far as the desktop says: a bar with its own name, the percent for the eye only.
  await page.told(status("downloading", { ...NEW, progress: 40 }));
  assert.match(page.text(), new RegExp(say.downloading("3.0.1").replace("…", "")));
  const bar = page.find((n) => n.type === "progress");
  assert.deepEqual([bar.props.value, bar.props.max, bar.props["aria-label"]], [40, 100, say.progressLabel]);
  const percent = page.find((n) => n.type === "p" && n.textContent === "40%");
  assert.equal(percent.props["aria-hidden"], "true");
  assert.deepEqual(page.buttons(), [], "no button while it downloads");
  // Without a known size there is a spinner and no bar to mislead.
  await page.told(status("downloading", NEW));
  assert.ok(!page.find((n) => n.type === "progress"), "no bar");

  // Ready: restarting closes terminals, and says so before the click.
  await page.told(status("ready", NEW));
  assert.match(page.text(), new RegExp(say.readyToRestart("3.0.1")));
  assert.match(page.text(), new RegExp(say.restartNote));
  assert.deepEqual(page.buttons(), [say.restart]);
  page.act(() => page.button(say.restart).props.onClick());
  await page.settle();
  assert.deepEqual(page.d.names().slice(-1), ["update/restart"]);
  assert.equal(page.button(say.restart).props.disabled, true, "once, not twice");
  // The desktop takes it, and the window goes a moment later: until then the button stays off.
  await page.d.reply("update/restart", {});
  await page.settle();
  assert.equal(page.button(say.restart).props.disabled, true, "a restart that was taken ends the window");
}

export async function nothingIsSaidAboutFolderAccessBeforeAnInstall() {
  for (const part of ["UpdatePanel", "UpdateCard"]) {
    const page = updatesPage(part);
    await page.looks(status("available", NEW));
    assert.doesNotMatch(page.text(), /macOS|folder access/, part);
  }
}

export async function aCopyThatOnlyLinksOffersTheReleasePageInsteadOfAnInstall() {
  const page = updatesPage("UpdatePanel");
  await page.looks(status("available", { ...NEW, install: "notice" }));
  assert.match(page.text(), new RegExp(say.isAvailable("3.0.1")));
  assert.match(page.text(), new RegExp(say.linkOnly));
  assert.deepEqual(page.buttons(), [say.whatsNew("3.0.1"), say.openRelease]);
  page.act(() => page.button(say.openRelease).props.onClick());
  await page.settle();
  assert.deepEqual(page.opened(), [NEW.url]);
  assert.deepEqual(page.d.names(), ["update/status"], "nothing is asked of the desktop");
  assert.equal(page.focused(), "null", "the button stays, and so does the focus");
}

export async function aRefusalIsShownInPlainWordsAndTheButtonIsThereToTryAgain() {
  const page = updatesPage("UpdatePanel");
  await page.looks(status("available", NEW));
  page.act(() => page.button(say.install("3.0.1")).props.onClick());
  assert.equal(page.button(say.install("3.0.1")).props.disabled, true, "once, not twice");
  await page.d.refuse("update/install", "Laci is busy with a change. Update when it's done.");
  await page.settle();
  const refusal = page.find((n) => n.textContent === "Laci is busy with a change. Update when it's done.");
  assert.equal(refusal.props["data-tone"], "soon", "a problem has its icon and words");
  assert.equal(page.button(say.install("3.0.1")).props.disabled, false);
  // The next request starts clean.
  page.act(() => page.button(say.install("3.0.1")).props.onClick());
  await page.settle();
  assert.doesNotMatch(page.text(), /Laci is busy/);
}

export async function aDesktopThatDoesNotAnswerIsToldSoAndAsksAgain() {
  const page = updatesPage("UpdatePanel");
  await page.d.refuse("update/status", "The desktop is not there.");
  await page.settle();
  assert.match(page.text(), new RegExp(say.unread));
  assert.match(page.text(), /The desktop is not there\./);
  assert.deepEqual(page.buttons(), [say.tryAgain]);
  page.act(() => page.button(say.tryAgain).props.onClick());
  await page.settle();
  assert.deepEqual(page.d.names(), ["update/status", "update/status"]);
  assert.match(page.text(), new RegExp(say.loading));
  await page.d.reply("update/status", status("idle", { checkedAt: CHECKED }));
  await page.settle();
  assert.match(page.text(), new RegExp(say.upToDate));
}

export async function aFailedUpdateSaysSoWithTheDesktopsReasonAndOffersToCheckAgain() {
  const page = updatesPage("UpdatePanel");
  await page.looks(
    status("error", { ...NEW, error: "The download stopped. Check the connection and try again." }),
  );
  const line = page.find((n) => n.textContent === say.failed);
  assert.equal(line.props["data-tone"], "soon");
  assert.match(page.text(), /The download stopped\. Check the connection and try again\./);
  assert.deepEqual(page.buttons(), [say.checkAgain]);
  page.act(() => page.button(say.checkAgain).props.onClick());
  await page.settle();
  assert.deepEqual(page.d.names().slice(-1), ["update/check"]);
}

export async function aRestartThatDidNotStartSaysWhyOnceInThePanel() {
  const page = updatesPage("UpdatePanel");
  await page.looks(status("ready", NEW));
  page.act(() => page.button(say.restart).props.onClick());
  await page.settle();
  // The new version didn't start: the desktop sends the failure and refuses the click with it.
  const why = "The new version didn't start. Try the update again.";
  await page.told(status("error", { ...NEW, error: why }));
  await page.d.refuse("update/restart", why);
  await page.settle();
  assert.equal(page.text().split(why).length, 2, "said once");
  assert.deepEqual(page.buttons(), [say.checkAgain]);
}

export async function theReleaseNotesAreDrawnWithTheReadmeCleanerOnlyOnceTheyAreAskedFor() {
  const page = updatesPage("UpdatePanel");
  await page.looks(status("available", NEW));
  assert.deepEqual(page.markdown.drawn, [], "marked loads when the notes are opened");
  page.act(() => page.button(say.whatsNew("3.0.1")).props.onClick());
  await page.settle();
  // As a README is drawn, and in no folder: a picture of the notes' own can't be a file of somebody's.
  const [first] = page.markdown.drawn;
  assert.equal(first.raw, NEW.notes);
  assert.equal(first.remote, false);
  assert.ok(!first.project.startsWith("/") && first.project !== "", first.project);
  // Drawn as the cleaner wrote them. Their links are underlined as every link in Simple is, by its
  // stylesheet (everyLinkInSimpleIsUnderlined), so they aren't known by their colour alone.
  const html = page.find((n) => n.props.className === "s-prose").props.dangerouslySetInnerHTML.__html;
  assert.equal(html, `<p>${NEW.notes} <a href="https://example.test/x">a link</a> <abbr>abbr</abbr></p>`);
  // Pictures from the web wait to be asked for.
  assert.match(page.text(), new RegExp(say.picturesHidden(2)));
  page.act(() => page.button(say.showPictures).props.onClick());
  await page.settle();
  assert.equal(page.markdown.drawn.at(-1).remote, true);
  assert.doesNotMatch(page.text(), new RegExp(say.picturesHidden(2)));
  // A click in the notes goes to the cleaner's link handling; a link to a file here is told not to open.
  page.find((n) => n.props.className === "s-prose").props.onClick({});
  const how = page.markdown.clicks.at(-1);
  how.relative("docs/a.md");
  assert.deepEqual(page.toast(), { title: say.linkNotOpened, message: say.linkBlocked });
  assert.equal(how.blocked, say.linkBlocked);
  // A version with no notes has no "What's new".
  await page.told(status("available", { ...NEW, notes: " " }));
  assert.ok(!page.button(say.whatsNew("3.0.1")), "no notes, no What's new");
}

/** What the rule for `selector` in a stylesheet of ui/src sets, as `{ property: value }`. */
function ruleOf(file, selector) {
  const css = readFileSync(new URL(`../../ui/src/${file}`, import.meta.url), "utf8");
  const quoted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`(?:^|\\n)\\s*${quoted}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  assert.ok(body !== undefined, `${file} has a rule for ${selector}`);
  return Object.fromEntries(
    body
      .split(";")
      .map((declaration) => declaration.split(":").map((part) => part.trim()))
      .filter(([property, value]) => property && value),
  );
}

export async function everyLinkInSimpleIsUnderlined() {
  // Simple's links sit in running text: a README, a summary, release notes. An underline tells them
  // apart by more than their colour (WCAG 1.4.1, axe's link-in-text-block). Simple's sheet is the
  // last layer, so its rule wins over Detailed's.
  const simple = ruleOf("simple/simple.css", ':root[data-design="simple"] a');
  assert.equal(simple["text-decoration"], "underline");
  assert.equal(simple.color, "var(--brand)");
  // Detailed's links stay as they were: underlined when pointed at.
  assert.equal(ruleOf("styles/detailed.css", "a")["text-decoration"], "none");
  assert.equal(ruleOf("styles/detailed.css", "a:hover")["text-decoration"], "underline");
}

// ── Home's card ────────────────────────────────────────────────────────────────────────────────────

const theCard = (page) => page.find((n) => n.props["data-ui"] === "update-card");

export async function theCardIsOnHomeOnlyWhileUpdatesAreOnAndOneIsWaiting() {
  const page = updatesPage("UpdateCard");
  await page.settle();
  assert.deepEqual(page.d.names(), ["update/status"], "Home's first look asks where the update stands");
  await page.looks(status("idle", { checkedAt: CHECKED }));
  assert.ok(!theCard(page), "nothing is waiting");
  const none = [
    status("checking"),
    // A failure with no version found is not about an update that is waiting.
    status("error", { error: "Laci couldn't reach the update server." }),
    // A version Laci found when asked, while it doesn't look by itself: Settings tells it, Home doesn't.
    status("available", { ...NEW, enabled: false }),
    status("ready", { ...NEW, enabled: false }),
  ];
  for (const next of none) {
    await page.told(next);
    assert.ok(!theCard(page), `${next.state}, ${next.enabled ? "on" : "off"}`);
  }
  for (const [next, step] of [
    [status("available", NEW), "found"],
    [status("available", { ...NEW, install: "notice" }), "link"],
    [status("downloading", { ...NEW, progress: 65 }), "downloading"],
    [status("ready", NEW), "restart"],
    [status("error", { ...NEW, error: "The download stopped." }), "failed"],
  ]) {
    await page.told(next);
    assert.equal(theCard(page)?.props["data-step"], step, step);
    assert.match(page.text(), new RegExp(card.title));
  }
}

export async function theSidebarsFootTellsOfAVersionFoundHoweverItWasFound() {
  const opened = [];
  const shown = [];
  const panel = {
    scrollIntoView: (options) => shown.push(["scroll", options]),
    focus: (options) => shown.push(["focus", options]),
  };
  const document = {
    documentElement: { dataset: {} },
    getElementById: (id) => (id === "simple-update-status" ? panel : null),
  };
  const page = updatesPage("UpdatePlace", { props: { onOpen: () => opened.push("settings") }, document });
  const place = () => page.find((n) => n.props["data-ui"] === "update-place");
  await page.looks(status("idle", { checkedAt: CHECKED, enabled: false }));
  assert.ok(!place(), "nothing is known");
  for (const next of [status("checking", { enabled: false }), status("error", { error: "Offline", enabled: false })]) {
    await page.told(next);
    assert.ok(!place(), next.state);
  }
  // Check now found it while Laci doesn't look by itself: the foot tells of it all the same.
  for (const [next, state] of [
    [status("available", { ...NEW, enabled: false }), "available"],
    [status("available", { ...NEW, install: "notice" }), "available"],
    [status("downloading", { ...NEW, progress: 40, enabled: false }), "downloading"],
    [status("error", { ...NEW, error: "The download stopped.", enabled: false }), "available"],
    [status("ready", { ...NEW, enabled: false }), "ready"],
  ]) {
    await page.told(next);
    assert.equal(place()?.textContent, say.foot[state], state);
    assert.equal(place().props.title, say.footNote[state]("3.0.1"));
    assert.equal(place().props["aria-label"], `${say.foot[state]}. ${say.footNote[state]("3.0.1")}`);
  }
  // It leads to Settings › Updates, and brings where the update stands into view.
  page.act(() => place().props.onClick());
  assert.deepEqual(opened, ["settings"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(shown, [
    ["scroll", { block: "center" }],
    ["focus", { preventScroll: true }],
  ]);
  // Restarted into the new version: nothing to tell.
  await page.told(status("idle", { current: "3.0.1", enabled: false }));
  assert.ok(!place());
}

export async function theCardHasOneButtonForTheNextStepAndNotNow() {
  const page = updatesPage("UpdateCard");
  await page.looks(status("available", NEW));
  assert.match(page.text(), new RegExp(card.canInstall("3.0.1")));
  assert.deepEqual(page.buttons(), [say.install("3.0.1"), card.notNow]);
  // The screen's one filled button is Home's own: this card has an outline button and a text one.
  assert.deepEqual(
    page.all((n) => n.type === "button").map((n) => n.props["data-kind"]),
    ["outline", "text"],
  );
  page.act(() => page.button(say.install("3.0.1")).props.onClick());
  assert.equal(page.focused(), page.regionWords());
  await page.settle();
  assert.deepEqual(page.d.names().slice(-1), ["update/install"]);
  await page.d.reply("update/install", { started: true });
  // While it downloads there is nothing to click, nor to hide.
  await page.told(status("downloading", { ...NEW, progress: 10 }));
  assert.deepEqual(page.buttons(), []);
  assert.equal(page.find((n) => n.type === "progress").props.value, 10);
  await page.told(status("ready", NEW));
  assert.match(page.text(), new RegExp(say.restartNote));
  assert.deepEqual(page.buttons(), [say.restart, card.notNow]);
  page.act(() => page.button(say.restart).props.onClick());
  await page.settle();
  assert.deepEqual(page.d.names().slice(-1), ["update/restart"]);
  // A refusal is said in the card, where the click was.
  await page.d.refuse("update/restart", "Laci is busy with a change. Update when it's done.");
  await page.settle();
  assert.match(page.text(), /Laci is busy with a change\./);
  assert.equal(page.button(say.restart).props.disabled, false);
}

export async function aFailureIsToldInTheCardWhereTheClickWasAndNotTwice() {
  const page = updatesPage("UpdateCard");
  await page.looks(status("available", NEW));
  page.act(() => page.button(say.install("3.0.1")).props.onClick());
  await page.settle();
  const why = "The download stopped. Check the connection and try again.";
  // The desktop tells how it failed, and answers the click with the same words.
  await page.told(status("error", { ...NEW, error: why }));
  await page.d.refuse("update/install", why);
  await page.settle();
  assert.equal(page.find((n) => n.textContent === say.failed).props["data-tone"], "soon");
  assert.equal(page.text().split(why).length, 2, "said once");
  assert.deepEqual(page.buttons(), [say.checkAgain, card.notNow]);
}

export async function aCopyThatOnlyLinksGetsALinkOnHomeToo() {
  const page = updatesPage("UpdateCard");
  await page.looks(status("available", { ...NEW, install: "notice" }));
  assert.match(page.text(), new RegExp(say.linkOnly));
  assert.deepEqual(page.buttons(), [say.openRelease, card.notNow]);
  page.act(() => page.button(say.openRelease).props.onClick());
  assert.deepEqual(page.opened(), [NEW.url]);
}

export async function notNowHidesTheCardForThatVersionAlone() {
  const storage = newStorage();
  const page = updatesPage("UpdateCard", { storage });
  await page.looks(status("available", NEW));
  page.act(() => page.button(card.notNow).props.onClick());
  // Remembered by version, in the browser's storage as the window keeps its other choices.
  assert.deepEqual([...storage.shelf], [["laci:update-hidden:3.0.1", "true"]]);
  // Said once, with where it can still be found, and the page takes the focus the button had.
  assert.deepEqual(page.toast(), { title: card.hidden("3.0.1"), message: card.hiddenNote });
  assert.deepEqual(page.refocused, [null]);
  assert.ok(!theCard(page));
  // Back on Home later it is still hidden; the next version is another matter.
  const again = updatesPage("UpdateCard", { storage });
  await again.looks(status("available", NEW));
  assert.ok(!theCard(again), "hidden for 3.0.1");
  await again.told(status("available", { ...NEW, version: "3.0.2" }));
  assert.ok(theCard(again), "a newer version asks again");
  assert.match(again.text(), new RegExp(card.canInstall("3.0.2")));
}

export async function aStorageThatRefusesEveryReadAndWriteIsNoTroubleToTheCard() {
  const storage = newStorage();
  storage.broken = true;
  const page = updatesPage("UpdateCard", { storage });
  await page.looks(status("available", NEW));
  assert.ok(theCard(page), "nothing can be read, so nothing is hidden");
  page.act(() => page.button(card.notNow).props.onClick());
  assert.ok(!theCard(page), "the card still goes, though nothing was kept");
  assert.deepEqual([...storage.shelf], []);
  // Only the version that was hidden stays hidden, until Home is drawn again.
  await page.told(status("available", { ...NEW, version: "3.0.2" }));
  assert.ok(theCard(page));
}

// ── Where the pieces sit ───────────────────────────────────────────────────────────────────────────

export async function settingsShowsThePanelAboveTheChoiceAndAsksAgainWhenItIsMade() {
  const page = standIn();
  const d = desktop();
  const asked = [];
  const app = page.store({
    snapshot: structuredClone(fixtures.snapshot),
    revision: 1,
    historyPending: false,
    setupPending: false,
    design: "simple",
    theme: "system",
    activity: null,
    navigate: nothing,
  });
  const info = fixtures["setup/info"];
  const prefs = {
    theme: null,
    design: "simple",
    updates: null,
    configured: true,
    configPath: "~/c.json",
  };
  const { SettingsPage } = load(
    "simple/SettingsPage.tsx",
    {
      react: page.react,
      "../words": words,
      "./settings.css": {},
      "@tauri-apps/api/app": { getVersion: async () => "3.0.0" },
      "../api": {
        api: async (name, body = {}) => {
          asked.push([name, body]);
          return name === "setup/info"
            ? structuredClone(info)
            : name === "updates"
              ? { ...prefs, ...body }
              : prefs;
        },
        errorText: String,
      },
      "../brand": { LaciMark: nothing },
      "../common": { Icon: nothing, restoreFocus: nothing },
      "../pick": { ChooseFolder: nothing },
      "../store": {
        changed: nothing,
        copyText: nothing,
        refreshLog: nothing,
        run: async (task) => task(),
        setDesign: nothing,
        setTheme: nothing,
        toast: nothing,
        urlOpen: nothing,
        useApp: app,
        pref: (_key, fallback) => fallback,
        savePref: nothing,
      },
      "../update": d.module,
      "./act": { aiTools: () => [] },
      "./AiHelpers": {
        setCopying: nothing,
        showTools: nothing,
        useCapabilities: () => ({}),
        useFocusStays: nothing,
        useHelpers: page.store({ technical: false }),
      },
      "./ui": simpleBlocks({
        Card: ({ title, children, footer }) =>
          createElement("section", { "data-card": title }, title, children, footer),
      }),
    },
    { document: { documentElement: { dataset: {} } }, requestAnimationFrame: (fn) => fn() },
  );
  page.mount(createElement(SettingsPage));
  await page.settle();
  await d.reply("update/status", status("idle", { checkedAt: CHECKED }));
  await page.settle();
  // The Updates card has the status and its button first, then the choice of how often Laci looks.
  const updates = page.find((n) => n.props["data-card"] === words.settings.updates);
  const order = updates.descendants().map((n) => n.textContent);
  const panel = order.findIndex((text) => text === say.checkNow);
  const choice = order.findIndex((text) => text === words.settings.updatesQuestion);
  assert.ok(panel > 0 && choice > panel, `${panel} before ${choice}`);
  assert.match(updates.textContent, new RegExp(say.upToDate));
  // About says the version, once, and the panel is not repeated there.
  const about = page.find((n) => n.props["data-card"] === words.settings.about);
  assert.match(about.textContent, /Version 3\.0\.0/);
  assert.doesNotMatch(about.textContent, new RegExp(say.checkNow));
  // Choosing how often to look saves it through its own request, then asks where the update stands.
  const radio = page
    .find((n) => n.type === "label" && n.textContent.startsWith(words.settings.updateChoices.daily))
    .children.find((n) => n.type === "input");
  page.act(() => radio.props.onChange());
  await page.settle();
  assert.deepEqual(
    asked.filter(([name]) => name === "updates"),
    [["updates", { updates: "daily" }]],
  );
  assert.deepEqual(d.names(), ["update/status", "update/status"], "asked again once it was saved");
  // Not looking points to Check now only while the panel shows it: a version found has Install there.
  const offNote = () =>
    page.find((n) => n.type === "label" && n.textContent.startsWith(words.settings.updateChoices.off)).textContent;
  assert.match(offNote(), /Use Check now to look once\./);
  d.emit(status("available", { ...NEW, notes: undefined, enabled: false }));
  await page.settle();
  assert.ok(!updates.descendants().some((n) => n.type === "button" && n.textContent === say.checkNow));
  assert.doesNotMatch(offNote(), /Check now/);
  assert.match(offNote(), new RegExp(words.settings.updateNoteOffFound));
  d.emit(status("idle", { checkedAt: CHECKED, enabled: false }));
  await page.settle();
  assert.match(offNote(), /Use Check now to look once\./);
}

export async function homeKeepsTheCardFirstInItsSideColumnAndTheOneFilledButtonIsStillOne() {
  const page = standIn();
  const d = desktop();
  const app = page.store({
    snapshot: structuredClone(fixtures.snapshot),
    busy: false,
    historyPending: false,
    error: null,
  });
  const { Home } = load(
    "simple/Home.tsx",
    {
      react: page.react,
      "../words": words,
      "../actions": { closeReportItem: nothing, toggleTodo: nothing },
      "../agent-launch": { askAgent: nothing },
      "../clock": { useNow: () => Date.parse(fixtures.meta.now) },
      "../common": { Icon: nothing, restoreFocus: nothing },
      "../pick": { chooseFolder: nothing },
      "../store": {
        goToProject: nothing,
        run: nothing,
        toast: nothing,
        useApp: app,
        pref: (_key, fallback) => fallback,
        savePref: nothing,
      },
      "../update": d.module,
      "./act": {
        addProjectFolder: nothing,
        aiName: () => "Claude Code",
        askFix: nothing,
        continueWithAi: nothing,
      },
      "./art": { Art: nothing },
      "./fix": { fixIcon: () => "cloud-upload", startFix: nothing },
      "./state": {
        clearNotNow: nothing,
        hideUntilTomorrow: nothing,
        readNotNow: () => new Set(),
        showProjects: nothing,
        useSimple: page.store({ notNow: 0 }),
      },
      "./ui": simpleBlocks(),
    },
    { document: { documentElement: { dataset: {} } } },
  );
  page.mount(createElement(Home));
  await d.reply("update/status", status("available", NEW));
  await page.settle();
  const side = page.find((n) => String(n.props.className) === "s-home-side");
  assert.equal(side.children[0].props["data-ui"], "update-card", "first in the side column");
  assert.equal(page.all((n) => n.props["data-ui"] === "update-card").length, 1);
  const filled = page.all((n) => n.type === "button" && n.props["data-kind"] === "filled");
  assert.equal(filled.length, 1, "the main card's button alone");
  // Not there while updates are off, and the rest of Home is as it was.
  d.emit(status("available", { ...NEW, enabled: false }));
  await page.settle();
  assert.ok(!page.find((n) => n.props["data-ui"] === "update-card"));
  assert.ok(page.text().includes(words.home.needsYou));
}
