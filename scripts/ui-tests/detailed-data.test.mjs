// Detailed's data and what M5 adds to it (ui:X2a, ui:24 and the window's half of rel:U1):
// - Today, the sidebar's counts and the palette's search are worked out once for each scan (and day,
//   and query) through ui/src/selectors.ts, not again each time they draw; agentCount is kept per scan.
// - A fix button that saves or uploads versions (ui/src/common.tsx) looks for secret files first, as
//   Simple's fix sheet does, and asks before it goes on: "Keep these out", with Undo, or Continue.
// - A new version shows as a badge at the foot of the sidebar, and as commands in the palette.
// The views are drawn by the stand-in for React, on the app's own store and update store.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";
import { event, Host, standIn } from "./react-stand-in.mjs";

const { createElement: h } = requireUi("react");
const fixtures = requireUi("./src/preview/fixtures.json");
const noop = () => {};
const KOPI = "/home/demo/project/clients/kopi-landing";
// Pure modules, compiled once for every test: each world counts the helpers' calls on its own.
const shared = { words: load("words.ts"), helpers: load("helpers.ts") };
const words = shared.words.detailedData;

/** A copy of the preview's scan of the demo home. */
const scan = (revision = 1) => ({ ...structuredClone(fixtures.snapshot), revision });
/** Where updates stand, as the desktop says it. */
const status = (state, more = {}) => ({
  enabled: true,
  state,
  current: "3.0.0",
  install: "click",
  ...more,
});
const found = (state, more = {}) =>
  status(state, {
    version: "3.0.1",
    url: "https://github.com/mrramdn/laci/releases/tag/v3.0.1",
    ...more,
  });
const both = (name, module) => ({ [`./${name}`]: module, [`../${name}`]: module });

/**
 * Detailed's window parts on the app's store (store.ts) and on the update store (update.ts), drawn
 * by the stand-in for React. `answers` stands in for the desktop by request name, and `requests`
 * lists what was asked. The helpers named in `counted` count their calls in `calls`, whoever calls
 * them: a view, or a selector. `terminals` are the terminal tabs that are open.
 */
function world({ answers = {}, counted = [], terminals = [] } = {}) {
  const page = standIn();
  const requests = [];
  const api = {
    api: async (name, body = {}) => {
      requests.push([name, body]);
      if (!(name in answers)) throw new Error(`The test has no answer for ${name}`);
      const answer = answers[name];
      return structuredClone(typeof answer === "function" ? await answer(body) : answer);
    },
    errorText: (error) => (error instanceof Error ? error.message : String(error)),
  };
  // getElementById finds what a test puts here; timers wait until a test runs them.
  const elements = new Map();
  const timers = [];
  Object.assign(page.document, {
    documentElement: { dataset: { os: "linux", design: "detailed" } },
    getElementById: (id) => elements.get(id) ?? null,
  });
  const globals = {
    document: page.document,
    HTMLElement: Host,
    localStorage: { getItem: () => null, setItem: noop },
    setTimeout: (run) => timers.push(run),
    clearTimeout: noop,
  };
  const store = load("store.ts", { "./api": api }, globals);
  // The components read the store through a selector, and draw again when it changes.
  const redraw = page.store({});
  store.useApp.subscribe(() => redraw.setState({}));
  const useApp = Object.assign(
    (select = (state) => state) => select(store.useApp.getState()),
    store.useApp,
  );
  const update = load(
    "update.ts",
    { "./api": api, "@tauri-apps/api/event": { listen: async () => noop } },
    globals,
  );
  const { helpers } = shared;
  const calls = Object.fromEntries(counted.map((name) => [name, 0]));
  const spied = { ...helpers };
  for (const name of counted)
    spied[name] = (...args) => {
      calls[name]++;
      return helpers[name](...args);
    };
  const selectors = load("selectors.ts", { "./helpers": spied }, globals);
  const opened = [];
  let frame = null;
  const app = {
    page,
    store,
    update: update.useUpdate,
    requests,
    calls,
    opened,
    elements,
    state: () => store.useApp.getState(),
    asked: (name) => requests.filter(([asked]) => asked === name).map(([, body]) => body),
    /** Runs the timers that wait, the ones they start too, up to `most` of them. */
    runTimers(most = 100) {
      for (let ran = 0; timers.length && ran < most; ran++) timers.shift()();
      return timers.length;
    },
    /** The props a dialog frame was last drawn with. */
    frame: () => frame,
    /** Loads a file of the interface onto this app. */
    load: (file, more = {}) =>
      load(
        file,
        {
          react: page.react,
          "react-dom": { createPortal: (children) => children },
          ...both("api", api),
          ...both("store", { ...store, useApp }),
          ...both("clock", { useNow: () => Date.parse(fixtures.meta.now) }),
          ...both("helpers", spied),
          ...both("selectors", selectors),
          ...both("update", update),
          ...both("words", shared.words),
          ...both("terminal-api", {
            openTerminal: async (...args) => {
              opened.push(args);
              return { id: `t${opened.length}` };
            },
            useTerms: { getState: () => ({ tabs: terminals }) },
          }),
          "./dialogs": {
            DialogFrame: (props) => {
              frame = props;
              return h(
                "div",
                { role: "dialog" },
                h("h2", null, props.title),
                h("p", null, props.description),
                props.children,
                props.footer,
              );
            },
          },
          ...more,
        },
        globals,
      ),
  };
  return app;
}

// ── Worked out once ────────────────────────────────────────────────────────────────────────────────

/**
 * Today, with what it draws beside its own lists left out. The shared to-do action notes what it is
 * called with in `toggled`, then sends its request.
 */
function today(counted) {
  const app = world({ counted, answers: { todo: (body) => scan().nodes[body.id] } });
  app.store.useApp.getState().load(scan());
  const toggled = [];
  const actions = app.load("actions.ts");
  const { Today } = app.load("views/today.tsx", {
    "../backup": { BackupNotice: () => null },
    "../looks": { LookThumb: () => null },
    "../session-ui": { requestResume: noop },
    "../agent-launch": { askAgent: noop },
    "../deadline": { DeadlinePill: () => null },
    "../actions": {
      ...actions,
      toggleTodo: (node, task, done) => {
        toggled.push([node.id, task.text, done]);
        return actions.toggleTodo(node, task, done);
      },
    },
  });
  app.page.mount(h(Today));
  return { ...app, toggled };
}

export async function todayIsWorkedOutOnceForEachScan() {
  const app = today(["risksOf", "deadlinesOf"]);
  const first = { ...app.calls };
  assert.ok(first.risksOf && first.deadlinesOf, "Today worked out its lists");
  assert.match(app.page.text(), /Could lose work/);
  // Choosing a row draws Today again, and works nothing out again.
  app.page.act(() => app.state().select(KOPI, "health", `risk:${KOPI}`));
  app.page.act(() => app.store.toggleExpanded("risks"));
  assert.deepEqual(app.calls, first);
  // A new scan is worked out again.
  app.page.act(() => app.store.useApp.setState({ snapshot: scan(2) }));
  assert.ok(app.calls.risksOf > first.risksOf);
}

export async function todaysToDoBoxGoesThroughTheSharedAction() {
  const app = today([]);
  const box = app.page.find((n) => n.type === "input" && n.props.type === "checkbox");
  assert.ok(box, "an open to-do");
  const label = app.page.all((n) => n.props.className === "t")[0].textContent;
  app.page.act(() => box.props.onChange({ target: { checked: true } }));
  await app.page.settle();
  assert.equal(app.toggled.length, 1);
  assert.deepEqual(app.toggled[0].slice(1), [label, true]);
  const [body] = app.asked("todo");
  assert.deepEqual([body.id, body.op, body.text, body.done], [app.toggled[0][0], "toggle", label, true]);
}

/** The sidebar, on a desktop that says `update` about updates, or nothing at all. */
function sidebar({ update, counted = [] } = {}) {
  const app = world({
    counted,
    answers: {
      ls: (body) => fixtures.ls[body.path] ?? { path: body.path, entries: [] },
      ...(update ? { "update/status": update } : {}),
    },
  });
  app.store.useApp.getState().load(scan());
  const { Sidebar } = app.load("views/sidebar.tsx", {
    "../brand": { LaciMark: () => null },
    "../common": { Icon: () => null },
    "./common": { Icon: () => null, Highlight: ({ text }) => text, restoreFocus: noop },
    "./styles/looks.css": {},
    "./deadline": { DeadlinePill: () => null },
  });
  app.page.mount(h(Sidebar));
  return app;
}

export async function theSidebarsCountsAreWorkedOutOnceForEachScan() {
  const app = sidebar({ counted: ["risksOf", "deadlinesOf", "within"] });
  await app.page.settle();
  const first = { ...app.calls };
  // The first project folder is open, with a count beside each folder in it.
  const counts = app.page.all((n) => n.type === "span" && n.props.className === "n");
  assert.ok(counts.length > 2, "Places counts the projects in each folder");
  assert.ok(first.within, "Places counted");
  // Another view draws the sidebar again, and counts nothing again.
  app.page.act(() => app.state().navigate("log"));
  app.page.act(() => app.store.useApp.setState({ busy: true }));
  assert.deepEqual(app.calls, first);
  // Today's badge counts the projects that need you, once each.
  const badge = app.page.find((n) => n.props.className === "n hot");
  const { navBadges } = load("selectors.ts");
  assert.equal(badge?.textContent, String(navBadges(scan(), 0, new Date(fixtures.meta.now)).today));
}

export async function aProjectsAgentCountIsWorkedOutOncePerScan() {
  const { agentCount } = load("helpers.ts");
  const snapshot = scan();
  const kopi = snapshot.nodes[KOPI];
  const count = agentCount(kopi, snapshot);
  assert.ok(count > 0);
  // A record of an agent that no session has, added to this very scan, isn't counted: the count is kept.
  snapshot.items["codex:extra.jsonl"] = {
    ...snapshot.items[kopi.agents.items[0]],
    id: "codex:extra.jsonl",
    file: "/home/demo/.codex/sessions/extra.jsonl",
  };
  kopi.agents.items.push("codex:extra.jsonl");
  assert.equal(agentCount(kopi, snapshot), count);
  // The next scan counts it.
  const next = structuredClone(snapshot);
  assert.equal(agentCount(next.nodes[KOPI], next), count + 1);
}

/**
 * The palette, on a desktop that says `update` about updates. The stand-in's elements have no
 * querySelector, which the palette asks its list for the selected result: that answers nothing.
 */
async function palette({ update, counted = [], terminals, answers = {} } = {}) {
  const app = world({
    counted,
    terminals,
    answers: { ...(update ? { "update/status": update } : {}), ...answers },
  });
  app.store.useApp.getState().load(scan());
  app.store.useApp.setState({ palette: true });
  const module = app.load("palette.tsx", {
    "./styles/looks.css": {},
    "./common": {
      Icon: () => null,
      KindIcon: () => null,
      PriorityGlyph: () => null,
      Highlight: ({ text }) => text,
      restoreFocus: noop,
    },
    "./deadline": { DeadlinePill: () => null },
  });
  Host.prototype.querySelector = () => null;
  try {
    app.page.mount(h(module.Palette));
    await app.page.settle();
  } finally {
    delete Host.prototype.querySelector;
  }
  const option = (text) =>
    app.page.find((n) => n.props.role === "option" && n.textContent.includes(text));
  return { ...app, ...module, option };
}

export async function thePaletteSearchesOnceForEachScanAndQuery() {
  const app = await palette({ update: status("idle"), counted: ["tilde", "allSessions"] });
  const first = { ...app.calls };
  assert.ok(first.tilde, "the palette listed projects");
  // Pointing at another result draws the palette again, and searches nothing again.
  Host.prototype.querySelector = () => null;
  try {
    const options = app.page.all((n) => n.props.role === "option");
    app.page.act(() => options[3].props.onMouseEnter());
    assert.deepEqual(app.calls, first);
    // A query is searched once.
    const input = app.page.find((n) => n.type === "input");
    app.page.act(() => input.props.onChange({ target: { value: "checkout" } }));
    assert.ok(app.calls.allSessions > first.allSessions, "sessions are searched for a query");
    const searched = { ...app.calls };
    app.page.act(() => app.page.all((n) => n.props.role === "option")[1].props.onMouseEnter());
    assert.deepEqual(app.calls, searched);
  } finally {
    delete Host.prototype.querySelector;
  }
  // Detailed's groups and times are as they were.
  const groups = app.page.all((n) => n.props.className === "pal-sec").map((n) => n.textContent);
  assert.deepEqual(groups, ["Projects", "Sessions", "Reports", "To-dos"]);
  const times = app.page.all((n) => n.props.className === "acc").map((n) => n.textContent);
  assert.ok(times.every((time) => !/ago$/.test(time)), times.join(", "));
}

// ── A new version ──────────────────────────────────────────────────────────────────────────────────

export async function detailedsPaletteOffersWhatCanBeDoneAboutANewVersion() {
  const { actionsFor } = await palette();
  const ids = (update, terminals) =>
    actionsFor("detailed", true, update, terminals)
      .map(([id]) => id)
      .filter((id) => id.startsWith("update:"));
  const action = (update, id, terminals) =>
    actionsFor("detailed", true, update, terminals).find(([at]) => at === id);
  // Nothing until the desktop has said where updates stand, and the switch stays last.
  assert.deepEqual(ids(null), []);
  assert.deepEqual(actionsFor("detailed", true, status("idle")).at(-1)[0], "design");
  assert.deepEqual(ids(status("idle")), ["update:check"]);
  assert.deepEqual(ids(status("idle", { enabled: false })), ["update:check"]);
  assert.deepEqual(ids(found("available")), ["update:check", "update:install"]);
  assert.deepEqual(action(found("available"), "update:install").slice(1), [
    words.update.install,
    "cloud-download",
    "Laci 3.0.1",
  ]);
  // A copy a package manager put in place links to the release instead.
  assert.deepEqual(ids(found("available", { install: "notice" })), ["update:check", "update:page"]);
  // A download that failed can be tried again; one under way has nothing to add.
  assert.deepEqual(ids(found("error", { error: "The download stopped." })), [
    "update:check",
    "update:install",
  ]);
  assert.deepEqual(ids(found("downloading", { progress: 40 })), []);
  assert.deepEqual(ids(found("ready")), ["update:restart"]);
  // A restart closes the terminals that are open, and says so.
  assert.equal(action(found("ready"), "update:restart")[3], "Laci 3.0.1");
  assert.equal(
    action(found("ready"), "update:restart", 2)[3],
    `Laci 3.0.1 · ${words.update.closes(2)}`,
  );
  assert.equal(action(found("ready"), "update:restart")[1], words.update.restart);
  assert.equal(action(status("idle"), "update:check")[1], words.update.check);
  // Simple's palette is its own.
  assert.ok(!actionsFor("simple", true, found("ready")).some(([id]) => id.startsWith("update:")));
}

export async function thePaletteListsTheCommandsOnceTheDesktopHasSaid() {
  // The palette asks where updates stand when nobody has yet.
  const quiet = await palette();
  assert.equal(quiet.asked("update/status").length, 1);
  assert.equal(quiet.option(words.update.check), undefined);
  const app = await palette({ update: found("ready"), terminals: [{ id: "a" }, { id: "b", exited: 0 }] });
  assert.ok(app.option(words.update.restart), "Restart to update");
  assert.match(app.option(words.update.restart).textContent, /closes 1 open terminal$/);
  assert.equal(app.option(words.update.check), undefined);
  app.page.act(() => app.option(words.update.restart).props.onClick());
  await app.page.settle();
  assert.equal(app.state().palette, false);
  assert.equal(app.asked("update/restart").length, 1);
}

export async function eachCommandAsksTheDesktopAndSaysHowItWent() {
  let after = status("idle");
  const app = await palette({
    update: status("idle"),
    answers: {
      "update/check": () => after,
      "update/install": () => {
        throw new Error("Laci is busy with a change. Update when it's done.");
      },
      "update/restart": {},
      "open/url": {},
    },
  });
  const { runUpdateCommand } = app;
  await runUpdateCommand("update:check", status("idle"));
  assert.equal(app.state().toast.title, words.update.upToDate);
  assert.equal(app.state().toast.message, words.update.current("3.0.0"));
  after = found("available");
  await runUpdateCommand("update:check", status("idle"));
  assert.equal(app.state().toast.title, words.update.found("3.0.1"));
  assert.equal(app.state().toast.message, words.update.foundClick);
  after = status("error", { error: "Laci couldn't reach the update server." });
  await runUpdateCommand("update:check", found("available"));
  assert.deepEqual(
    [app.state().toast.title, app.state().toast.message, app.state().toast.error],
    [words.update.checkFailed, "Laci couldn't reach the update server.", true],
  );
  // A refusal is said as the desktop says it.
  await runUpdateCommand("update:install", found("available"));
  assert.deepEqual(
    [app.state().toast.title, app.state().toast.error],
    [words.update.installFailed, true],
  );
  assert.match(app.state().toast.message, /busy with a change/);
  await runUpdateCommand("update:restart", found("ready"));
  assert.equal(app.asked("update/restart").length, 1);
  await runUpdateCommand("update:page", found("available", { install: "notice" }));
  await app.page.settle();
  assert.deepEqual(app.asked("open/url"), [{ url: found("available").url }]);
}

export async function aCheckLeavesAnUndoInPlace() {
  const app = await palette({ update: status("idle"), answers: { "update/check": status("idle") } });
  app.store.useApp.setState({ toast: { title: "Moved acme-store", message: "", undo: "j1" } });
  await app.runUpdateCommand("update:check", status("idle"));
  assert.equal(app.state().toast.undo, "j1");
}

export async function theBadgeShowsOnlyANewVersionLaciFoundByItself() {
  // The desktop hasn't answered: no badge.
  const app = sidebar();
  await app.page.settle();
  assert.equal(app.asked("update/status").length, 1, "the sidebar asked");
  const badge = (update) => {
    app.page.act(() => app.update.setState({ status: update }));
    return app.page.find((n) => n.props["data-ui"] === "update-badge");
  };
  assert.equal(badge(null), undefined);
  // Updates off, or nothing new: no badge.
  assert.equal(badge(status("idle")), undefined);
  assert.equal(badge(found("available", { enabled: false })), undefined);
  assert.equal(badge(status("error", { error: "Offline" })), undefined);
  const available = badge(found("available"));
  assert.match(available.textContent, /^Update available3\.0\.1$/);
  assert.equal(available.props.title, words.update.badgeNote.available("3.0.1"));
  assert.ok(available.props["aria-label"].startsWith(words.update.badge.available));
  assert.match(badge(found("downloading", { progress: 40 })).textContent, /^Downloading update40%$/);
  assert.match(badge(found("downloading")).textContent, /^Downloading update3\.0\.1$/);
  assert.match(badge(found("ready")).textContent, /^Update ready3\.0\.1$/);
  // A look that runs again while one is available keeps the badge, as does a download that failed.
  assert.ok(badge(found("checking")));
  assert.ok(badge(found("error", { error: "The download stopped." })));
}

export async function theBadgeFollowsTheDesktopsNews() {
  const app = sidebar({ update: status("idle") });
  await app.page.settle();
  const find = () => app.page.find((n) => n.props["data-ui"] === "update-badge");
  assert.equal(find(), undefined);
  app.page.act(() => app.update.setState({ status: found("available") }));
  assert.ok(find(), "the badge comes when Laci finds a new version");
  app.page.act(() => app.update.setState({ status: status("idle", { current: "3.0.1" }) }));
  assert.equal(find(), undefined);
}

export async function theBadgeOpensSettingsAtItsUpdates() {
  const app = sidebar({ update: found("ready") });
  await app.page.settle();
  const badge = app.page.find((n) => n.props["data-ui"] === "update-badge");
  app.page.act(() => badge.props.onClick(event({})));
  assert.equal(app.state().view, "settings");
  // Settings reads the settings first: the badge waits for the section to be drawn.
  assert.ok(app.runTimers(5) > 0, "it is still waiting");
  const shown = [];
  app.elements.set("settings-updates", {
    scrollIntoView: (options) => shown.push(["scroll", options]),
    focus: (options) => shown.push(["focus", options]),
  });
  assert.equal(app.runTimers(), 0);
  assert.deepEqual(shown, [
    ["scroll", { block: "start" }],
    ["focus", { preventScroll: true }],
  ]);
  // Without the section, it gives up.
  app.elements.clear();
  app.page.act(() => app.page.find((n) => n.props["data-ui"] === "update-badge").props.onClick(event({})));
  assert.equal(app.runTimers(), 0);
}

// ── The fix buttons look for secret files ──────────────────────────────────────────────────────────

const ENV = { path: ".env", tracked: false };
const KEY = { path: "android/key.properties", tracked: false };
const CREDENTIALS = { path: "server/firebase-credentials.json", tracked: true };
const looks = (...files) => ({ files, more: 0 });

/**
 * kopi-landing's fix button for `code`, on a desktop whose secrets checks answer `checks` in turn:
 * a reply, or an Error the check fails with.
 */
function fixButton(code, checks = [], answers = {}) {
  const app = world({
    answers: {
      "secrets/check": () => {
        const next = checks.shift();
        if (next instanceof Error) throw next;
        return next ?? looks();
      },
      "secrets/keep-out": { revision: 9, journal: { id: "j9", canUndo: true } },
      ...answers,
    },
  });
  app.store.useApp.getState().load(scan());
  const { FixButton } = app.load("common.tsx");
  const node = app.state().snapshot.nodes[KOPI];
  app.page.mount(h(FixButton, { node, code }));
  return {
    ...app,
    /** Clicks the button that says `text`, and lets what it starts settle. */
    async press(text) {
      const button = app.page.button(text);
      assert.ok(button, `a button that says ${text}`);
      const click = event({});
      app.page.act(() => button.props.onClick(click));
      await app.page.settle();
      return click;
    },
    dialog: () => app.page.find((n) => n.props.role === "dialog"),
  };
}

export async function aFixThatSavesVersionsLooksForSecretFilesFirst() {
  const app = fixButton("no-commits", [looks()]);
  const click = await app.press("First commit");
  assert.equal(click.stopped, true, "the row behind it isn't chosen");
  assert.deepEqual(app.asked("secrets/check"), [{ id: KOPI }]);
  // Nothing found: the terminal gets the fix at once.
  assert.deepEqual(app.opened, [[KOPI, "fix", "no-commits"]]);
  assert.equal(app.dialog(), undefined);
}

export async function aFixThatSavesNothingGoesStraightToTheTerminal() {
  for (const [code, label] of [
    ["stash", "Show stash"],
    ["behind", "Pull"],
  ]) {
    const app = fixButton(code);
    await app.press(label);
    assert.deepEqual(app.asked("secrets/check"), []);
    assert.deepEqual(app.opened, [[KOPI, "fix", code]]);
  }
}

export async function filesThatLookLikeSecretsAreListedBeforeTheFix() {
  const app = fixButton("unpushed", [looks(ENV, CREDENTIALS)]);
  await app.press("Push");
  assert.deepEqual(app.opened, [], "the terminal waits");
  const text = app.dialog().textContent;
  assert.ok(text.includes(words.secrets.title("kopi-landing")));
  assert.ok(text.includes(words.secrets.intro("Push")));
  assert.ok(text.includes(words.secrets.loose) && text.includes(".env"));
  assert.ok(text.includes(words.secrets.keepNote));
  assert.ok(text.includes(words.secrets.tracked) && text.includes(CREDENTIALS.path));
  assert.ok(text.includes(words.secrets.trackedNote));
  // It holds the window's keys while it is open, as a sheet does.
  assert.equal(app.state().sheets, 1);
  // Cancel closes it and starts nothing.
  await app.press(words.secrets.cancel);
  assert.equal(app.dialog(), undefined);
  assert.equal(app.state().sheets, 0);
  assert.deepEqual(app.opened, []);
}

export async function continueAlwaysGoesOn() {
  // Already in a saved version: Detailed still lets the fix go on, and offers nothing to keep out.
  const app = fixButton("unpushed", [looks(CREDENTIALS)]);
  await app.press("Push");
  assert.equal(app.page.button(words.secrets.keepOut), undefined);
  assert.ok(!app.dialog().textContent.includes(words.secrets.keepNote));
  await app.press(words.secrets.goOn);
  assert.deepEqual(app.opened, [[KOPI, "fix", "unpushed"]]);
  assert.equal(app.dialog(), undefined);
  assert.equal(app.state().sheets, 0);
}

export async function escapeClosesItAsCancelDoes() {
  const app = fixButton("dirty", [looks(ENV)]);
  await app.press("Review changes");
  app.page.act(() => app.frame().onDismiss());
  assert.equal(app.dialog(), undefined);
  assert.deepEqual(app.opened, []);
}

export async function keepTheseOutAddsThemToGitignoreWithUndoThenGoesOn() {
  const app = fixButton("no-commits", [looks(ENV, KEY, CREDENTIALS), looks()]);
  await app.press("First commit");
  await app.press(words.secrets.keepOut);
  // Only the files Git doesn't track yet: .gitignore can't take a tracked one out.
  assert.deepEqual(app.asked("secrets/keep-out"), [
    { id: KOPI, files: [".env", "android/key.properties"] },
  ]);
  assert.equal(app.state().toast.title, words.secrets.keptOut);
  assert.equal(app.state().toast.message, ".env, android/key.properties");
  assert.equal(app.state().toast.undo, "j9");
  // It looked again, found nothing, and went on.
  assert.equal(app.asked("secrets/check").length, 2);
  assert.deepEqual(app.opened, [[KOPI, "fix", "no-commits"]]);
  assert.equal(app.dialog(), undefined);
}

export async function whatIsStillFoundAfterKeepingOutStaysOnScreen() {
  const app = fixButton("no-commits", [looks(ENV, CREDENTIALS), looks(CREDENTIALS)]);
  await app.press("First commit");
  await app.press(words.secrets.keepOut);
  assert.deepEqual(app.opened, []);
  const text = app.dialog().textContent;
  assert.ok(!text.includes(".env"), "the file kept out is gone");
  assert.ok(text.includes(CREDENTIALS.path));
  assert.equal(app.page.button(words.secrets.keepOut), undefined);
}

export async function aRefusedKeepOutSaysWhyAndKeepsTheFiles() {
  const app = fixButton("no-commits", [looks(ENV)], {
    "secrets/keep-out": () => {
      throw new Error(".gitignore isn't a plain file");
    },
  });
  await app.press("First commit");
  await app.press(words.secrets.keepOut);
  assert.ok(app.dialog().textContent.includes(".gitignore isn't a plain file"));
  assert.ok(app.dialog().textContent.includes(".env"));
  assert.deepEqual(app.opened, []);
  await app.press(words.secrets.goOn);
  assert.deepEqual(app.opened, [[KOPI, "fix", "no-commits"]]);
}

export async function aCheckThatFailedLetsTheFixGoOnOrLookAgain() {
  const app = fixButton("no-remote", [new Error("git: not found"), looks(ENV)]);
  await app.press("Create remote");
  const text = app.dialog().textContent;
  assert.ok(text.includes(words.secrets.failed) && text.includes("git: not found"));
  assert.ok(text.includes(words.secrets.goOnFailed));
  await app.press(words.secrets.checkAgain);
  assert.ok(app.dialog().textContent.includes(".env"));
  await app.press(words.secrets.goOn);
  assert.deepEqual(app.opened, [[KOPI, "fix", "no-remote"]]);
}

export async function aSecondClickWhileItLooksAsksNothingMore() {
  let answer;
  const app = fixButton("no-commits", [], {
    "secrets/check": () => new Promise((resolve) => (answer = resolve)),
  });
  const button = app.page.button("First commit");
  app.page.act(() => button.props.onClick(event({})));
  app.page.act(() => app.page.button("First commit").props.onClick(event({})));
  await app.page.settle();
  assert.equal(app.asked("secrets/check").length, 1);
  assert.equal(app.page.button("First commit").props["aria-busy"], true);
  answer(looks());
  await app.page.settle();
  assert.deepEqual(app.opened, [[KOPI, "fix", "no-commits"]]);
  assert.equal(app.page.button("First commit").props["aria-busy"], undefined);
}
