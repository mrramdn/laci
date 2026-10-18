// Simple and Detailed in ui/src/store.ts: what a switch changes and where it lands, where the focus
// goes after it, how first run saves the design it picks, how each design opens a project, and how
// the choices saved in config.json win over what the page started with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";

const HOME = "/home/demo";
const ROOT = `${HOME}/project`;
const APP = `${ROOT}/app`;
const CLIENTS = `${ROOT}/clients`;

/**
 * A store of its own, on a page whose `<html>` has `dataset`. `reply` answers its requests.
 * `requests` lists what it asked for, and `storage` what it kept for the next start. `page` gives
 * the store a fuller page: its `document`, `MutationObserver` and `setTimeout`.
 */
function store(dataset = {}, reply = async () => ({}), page = {}) {
  const requests = [];
  const storage = new Map();
  let timerId = 0;
  const exports = load(
    "store.ts",
    {
      "./api": {
        api: (name, body) => {
          requests.push([name, body]);
          return reply(name, body);
        },
        errorText: (error) =>
          error instanceof Error ? error.message : String(error),
      },
    },
    {
      document: { documentElement: { dataset } },
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
      },
      setTimeout: () => ++timerId,
      clearTimeout: () => {},
      ...page,
    },
  );
  return { ...exports, dataset, requests, storage };
}

/** A scan with one project and one plain folder in it. */
const snapshot = () => ({
  revision: 1,
  configured: true,
  home: HOME,
  roots: [ROOT],
  nodes: {
    [APP]: { id: APP, path: APP, kind: "project" },
    [CLIENTS]: { id: CLIENTS, path: CLIENTS, kind: "folder" },
  },
  proposals: [],
});
/** A store that has the scan, showing `view` with `selected`. */
function showing(design, view, selected = null) {
  const app = store({ design });
  app.useApp.getState().load(snapshot());
  app.useApp.setState({ view, selected });
  return app;
}
const prefs = (choices) => ({
  theme: null,
  design: null,
  updates: null,
  configured: true,
  configPath: "~/.config/laci/config.json",
  os: "linux",
  ...choices,
});
const pick = (state, ...keys) =>
  Object.fromEntries(keys.map((key) => [key, state[key]]));

export async function withNothingOnThePageTheWindowIsDetailed() {
  const { useApp } = store();
  assert.deepEqual(
    pick(useApp.getState(), "design", "designSet", "designOffer", "prefsReady"),
    {
      design: "detailed",
      designSet: false,
      designOffer: false,
      prefsReady: false,
    },
  );
}

export async function thePageSaysWhichDesignToStartInAndWhetherToOfferSimple() {
  assert.equal(store({ design: "simple" }).useApp.getState().design, "simple");
  assert.equal(
    store({ design: "classic" }).useApp.getState().design,
    "detailed",
  );
  const upgraded = store({ design: "detailed", designOffer: "1" });
  assert.equal(upgraded.useApp.getState().designOffer, true);
}

export async function aSwitchWaitsWhileADialogIsOpenOrAChangeRuns() {
  for (const busy of [
    { modal: { kind: "archive", id: APP } },
    { modal: { kind: "help" } },
    { working: "Archiving…" },
  ]) {
    const { useApp, setDesign, dataset, requests, storage } = showing(
      "detailed",
      "today",
      APP,
    );
    useApp.setState(busy);
    assert.equal(setDesign("simple"), false);
    assert.deepEqual(
      pick(useApp.getState(), "design", "view", "designSet", "toast"),
      { design: "detailed", view: "today", designSet: false, toast: null },
    );
    assert.deepEqual(dataset, { design: "detailed" });
    assert.equal(storage.size, 0);
    assert.deepEqual(requests, []);
  }
}

export async function aSwitchShowsSavesAndRemembersTheDesign() {
  const { useApp, setDesign, dataset, requests, storage } = store({
    design: "detailed",
    designOffer: "1",
  });
  assert.equal(setDesign("simple"), true);
  assert.deepEqual(dataset, { design: "simple" });
  assert.equal(storage.get("laci:design"), "simple");
  assert.deepEqual(requests, [["design", { design: "simple" }]]);
  assert.deepEqual(
    pick(useApp.getState(), "design", "designSet", "designOffer", "toast"),
    {
      design: "simple",
      designSet: true,
      designOffer: false,
      toast: {
        title: "Now in Simple view",
        message: "Switch back at the bottom of the sidebar.",
      },
    },
  );

  assert.equal(setDesign("detailed"), true);
  assert.equal(dataset.design, "detailed");
  assert.equal(storage.get("laci:design"), "detailed");
  assert.deepEqual(requests.at(-1), ["design", { design: "detailed" }]);
  assert.deepEqual(useApp.getState().toast, {
    title: "Now in Detailed view",
    message: "Switch back at the bottom of the sidebar.",
  });
}

export async function aSwitchThatCouldNotBeSavedSaysSo() {
  const refusal =
    "A project is being created. Wait before changing files or settings.";
  const { useApp, setDesign } = store({}, async () => {
    throw refusal;
  });
  setDesign("simple");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useApp.getState().design, "simple");
  assert.deepEqual(useApp.getState().toast, {
    title: "Couldn’t save view",
    message: refusal,
    error: true,
  });
}

export async function choosingTheDesignAlreadyShownOnlySavesIt() {
  const { useApp, setDesign, requests, dataset } = store({
    design: "detailed",
    designOffer: "1",
  });
  useApp.getState().load(snapshot());
  useApp.setState({ view: "folder", selected: APP });
  assert.equal(setDesign("detailed"), true);
  assert.deepEqual(
    pick(
      useApp.getState(),
      "view",
      "selected",
      "designSet",
      "designOffer",
      "toast",
    ),
    {
      view: "folder",
      selected: APP,
      designSet: true,
      designOffer: false,
      toast: null,
    },
  );
  assert.deepEqual(dataset, { design: "detailed" });
  assert.deepEqual(requests, [["design", { design: "detailed" }]]);
}

export async function aSwitchLeavesTheUndoOfAChangeInReach() {
  const { useApp, setDesign, changed } = store();
  useApp.getState().load(snapshot());
  changed({ journal: { id: "undo-archive" } }, "Archived app");
  setDesign("simple");
  assert.equal(useApp.getState().design, "simple");
  assert.equal(useApp.getState().toast.title, "Archived app");
  assert.equal(useApp.getState().toast.undo, "undo-archive");
}

export async function theDetailsOfAProjectBecomeItsPageAndBack() {
  const { useApp, setDesign } = store();
  useApp.getState().load(snapshot());
  useApp.getState().cd(APP);
  assert.equal(useApp.getState().view, "folder");
  setDesign("simple");
  assert.deepEqual(pick(useApp.getState(), "view", "selected"), {
    view: "project",
    selected: APP,
  });
  // Detailed has no project page: the project shows beside Today.
  setDesign("detailed");
  assert.deepEqual(pick(useApp.getState(), "view", "selected"), {
    view: "today",
    selected: APP,
  });
}

export async function everyOtherViewKeepsItsPlaceAcrossASwitch() {
  for (const view of [
    "today",
    "folder",
    "tidy",
    "agents",
    "reports",
    "log",
    "settings",
  ]) {
    const { useApp, setDesign } = showing("detailed", view);
    setDesign("simple");
    assert.equal(useApp.getState().view, view, `${view} in Simple`);
    setDesign("detailed");
    assert.equal(useApp.getState().view, view, `${view} back in Detailed`);
  }
  // A project not shown beside a full-width view, and a folder's details, keep the view.
  for (const [view, selected] of [
    ["log", APP],
    ["reports", APP],
    ["folder", CLIENTS],
    ["today", "/somewhere/else"],
  ]) {
    const { useApp, setDesign } = showing("detailed", view, selected);
    setDesign("simple");
    assert.equal(useApp.getState().view, view, `${view} with ${selected}`);
  }
  // Detailed opens Help as a dialog, so Simple's Help page lands on Today.
  const { useApp, setDesign } = showing("simple", "help");
  setDesign("detailed");
  assert.equal(useApp.getState().view, "today");
}

export async function goToProjectOpensAProjectWhereEachDesignShowsIt() {
  // Detailed, as before: the details beside the view, leaving one without room for them.
  for (const [from, to] of [
    ["reports", "today"],
    ["settings", "today"],
    ["log", "today"],
    ["folder", "folder"],
    ["tidy", "tidy"],
  ]) {
    const { useApp, goToProject } = showing("detailed", from);
    goToProject(APP, "agents");
    assert.deepEqual(
      pick(useApp.getState(), "view", "selected", "tab"),
      { view: to, selected: APP, tab: "agents" },
      `from ${from}`,
    );
  }
  // Simple: the project's own page, from anywhere.
  for (const from of [
    "today",
    "folder",
    "reports",
    "log",
    "settings",
    "help",
  ]) {
    const { useApp, goToProject } = showing("simple", from, CLIENTS);
    goToProject(APP, "todo");
    assert.deepEqual(
      pick(useApp.getState(), "view", "selected", "tab"),
      { view: "project", selected: APP, tab: "todo" },
      `from ${from}`,
    );
  }
}

export async function cdOpensAProjectOnItsPageInSimpleAndAFolderAsAFolder() {
  const detailed = showing("detailed", "today");
  detailed.useApp.getState().cd(APP);
  let state = detailed.useApp.getState();
  assert.deepEqual(pick(state, "view", "cwd", "selected"), {
    view: "folder",
    cwd: APP,
    selected: APP,
  });
  assert.ok(state.tree.has(ROOT));

  const simple = showing("simple", "today");
  simple.useApp.getState().cd(APP);
  state = simple.useApp.getState();
  assert.deepEqual(pick(state, "view", "cwd", "selected"), {
    view: "project",
    cwd: ROOT,
    selected: APP,
  });
  // A folder that isn't a project still opens as a folder, and leaves the selection alone.
  simple.useApp.getState().cd(CLIENTS);
  state = simple.useApp.getState();
  assert.deepEqual(pick(state, "view", "cwd", "selected"), {
    view: "folder",
    cwd: CLIENTS,
    selected: APP,
  });
  simple.useApp.getState().cd("/home/demo/notes");
  assert.equal(simple.useApp.getState().view, "folder");
}

export async function theSavedChoicesWinOverWhatThePageStartedWith() {
  // The desktop's start-up script is from before a switch to Simple and light, and a reload.
  const { useApp, applyPrefs, dataset, storage } = store({
    design: "detailed",
    designOffer: "1",
    theme: "dark",
  });
  assert.equal(useApp.getState().theme, "dark");
  applyPrefs(prefs({ design: "simple", theme: "light" }));
  assert.deepEqual(
    pick(
      useApp.getState(),
      "design",
      "theme",
      "designSet",
      "designOffer",
      "prefsReady",
    ),
    {
      design: "simple",
      theme: "light",
      designSet: true,
      designOffer: false,
      prefsReady: true,
    },
  );
  assert.deepEqual(dataset, { design: "simple", theme: "light" });
  assert.equal(storage.get("laci:design"), "simple");
  assert.equal(storage.get("laci:theme"), "light");

  // No saved theme is the system's.
  applyPrefs(prefs({ design: "simple", theme: null }));
  assert.equal(useApp.getState().theme, "system");
  assert.deepEqual(dataset, { design: "simple" });
  assert.equal(storage.get("laci:theme"), "system");
}

export async function aSetupFromBeforeTwoDesignsStaysDetailedAndIsOfferedSimple() {
  const { useApp, applyPrefs, dataset } = store({ design: "simple" });
  applyPrefs(prefs({ design: null, configured: true }));
  assert.deepEqual(
    pick(useApp.getState(), "design", "designSet", "designOffer"),
    { design: "detailed", designSet: false, designOffer: true },
  );
  assert.deepEqual(dataset, { design: "detailed", designOffer: "1" });
}

export async function aNewSetupStartsInTheNewInstallDesign() {
  const { useApp, applyPrefs, dataset, NEW_INSTALL_DESIGN } = store();
  applyPrefs(prefs({ design: null, configured: false }));
  assert.deepEqual(
    pick(useApp.getState(), "design", "designSet", "designOffer"),
    { design: NEW_INSTALL_DESIGN, designSet: false, designOffer: false },
  );
  assert.deepEqual(dataset, { design: NEW_INSTALL_DESIGN });
}

export async function savedValuesTheWindowDoesNotKnowCountAsNotChosen() {
  const { useApp, applyPrefs, dataset } = store({ theme: "dark" });
  // The browser preview answers "" for the system's theme.
  for (const theme of ["blue", ""]) {
    applyPrefs(prefs({ design: "classic", theme }));
    assert.deepEqual(
      pick(useApp.getState(), "design", "theme", "designSet", "designOffer"),
      {
        design: "detailed",
        theme: "system",
        designSet: false,
        designOffer: true,
      },
    );
    assert.equal(dataset.theme, undefined);
  }
}

export async function savedChoicesThatChangeTheDesignMoveTheViewToo() {
  const toDetailed = showing("simple", "project", APP);
  toDetailed.applyPrefs(prefs({ design: "detailed" }));
  assert.deepEqual(pick(toDetailed.useApp.getState(), "view", "selected"), {
    view: "today",
    selected: APP,
  });
  const toSimple = showing("detailed", "folder", APP);
  toSimple.applyPrefs(prefs({ design: "simple" }));
  assert.equal(toSimple.useApp.getState().view, "project");
  // The same design stays where it is, and nothing is saved or announced.
  const same = showing("detailed", "folder", APP);
  same.applyPrefs(prefs({ design: "detailed" }));
  assert.deepEqual(pick(same.useApp.getState(), "view", "toast"), {
    view: "folder",
    toast: null,
  });
  assert.deepEqual(same.requests, []);
}

export async function theDesignForSavedChoicesIsTheOneTheDesktopOpensIn() {
  const { effectiveDesign } = store();
  assert.equal(
    effectiveDesign({ design: "simple", configured: true }),
    "simple",
  );
  assert.equal(
    effectiveDesign({ design: "detailed", configured: false }),
    "detailed",
  );
  assert.equal(effectiveDesign({ design: null, configured: true }), "detailed");
  // The desktop and the store must agree on a new install's design; change both constants together.
  const desktop = readFileSync(
    new URL("../../src-tauri/src/app/mod.rs", import.meta.url),
    "utf8",
  ).match(/const NEW_INSTALL_DESIGN: &str = "(\w+)";/)?.[1];
  assert.ok(desktop, "NEW_INSTALL_DESIGN is in src-tauri/src/app/mod.rs");
  assert.equal(effectiveDesign({ design: null, configured: false }), desktop);
}

// The state smoke test runs the store with only `./api` replaced, so it may import nothing else of
// the interface at runtime.
export async function theStoreNeedsOnlyTheApiFromTheInterface() {
  const ts = requireUi("typescript");
  const source = readFileSync(
    new URL("../../ui/src/store.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const local = [...outputText.matchAll(/require\("(\.[^"]*)"\)/g)].map(
    ([, name]) => name,
  );
  assert.deepEqual(local, ["./api"]);
}

// ── ui:P3: a new install, first run's choice, and the focus after a switch ──────────────────────────

export async function aNewInstallOpensInSimple() {
  const { useApp, applyPrefs, dataset, NEW_INSTALL_DESIGN } = store({
    design: "detailed",
  });
  // First run now asks, with Simple picked, and Simple ships: a new install opens in it.
  assert.equal(NEW_INSTALL_DESIGN, "simple");
  applyPrefs(prefs({ design: null, configured: false }));
  assert.equal(useApp.getState().design, "simple");
  assert.deepEqual(dataset, { design: "simple" });
}

export async function firstRunSavesThePickedDesignWithoutAToast() {
  const { useApp, chooseDesign, dataset, requests, storage } = store({
    design: "simple",
  });
  useApp.getState().load(snapshot());
  assert.equal(chooseDesign("detailed"), true);
  assert.deepEqual(
    pick(useApp.getState(), "design", "designSet", "designOffer", "toast"),
    { design: "detailed", designSet: true, designOffer: false, toast: null },
  );
  assert.deepEqual(dataset, { design: "detailed" });
  assert.equal(storage.get("laci:design"), "detailed");
  assert.deepEqual(requests, [["design", { design: "detailed" }]]);
  // Keeping the design shown saves it too, so the first save in Settings can't change it later.
  assert.equal(chooseDesign("detailed"), true);
  assert.deepEqual(requests.at(-1), ["design", { design: "detailed" }]);
}

export async function firstRunWaitsLikeASwitch() {
  for (const busy of [{ modal: { kind: "new" } }, { working: "Scanning…" }]) {
    const { useApp, chooseDesign, dataset, requests } = store({
      design: "simple",
    });
    useApp.setState(busy);
    assert.equal(chooseDesign("detailed"), false);
    assert.equal(useApp.getState().design, "simple");
    assert.deepEqual(dataset, { design: "simple" });
    assert.deepEqual(requests, []);
  }
}

const TOGGLE = '[data-ui="design-toggle"]';
/**
 * A page for the focus after a switch: the window of `design`, with its toggle (the button of the
 * design shown pressed, and the other one) and its main, a MutationObserver the page tells when the
 * window changes, and the timers set. `redraw(next, meanwhile, hidden)` draws the window of `next`
 * in its place, runs `meanwhile`, then tells the observers. The parts named in `hidden` aren't
 * drawn, as Detailed's narrow rail leaves out the button of the design shown: they don't take the
 * focus.
 */
function windowPage(design) {
  const focused = [];
  const observers = [];
  const timers = [];
  const document = {
    documentElement: { dataset: { design } },
    body: { name: "body" },
    activeElement: null,
  };
  const windowOf = (shown, hidden = []) => {
    const toggle = { name: `${shown} toggle` };
    const element = (part, name, inToggle = false) => ({
      name,
      isConnected: true,
      closest: (selector) => (inToggle && selector === TOGGLE ? toggle : null),
      focus(options) {
        if (hidden.includes(part)) return;
        focused.push([name, options]);
        document.activeElement = this;
      },
    });
    const pressed = element(
      "pressed",
      `${shown}: the pressed button of the toggle`,
      true,
    );
    const other = element(
      "other",
      `${shown}: the other button of the toggle`,
      true,
    );
    toggle.querySelector = (selector) =>
      selector === '[aria-pressed="true"]' ? pressed : null;
    // Simple's button comes first in both toggles.
    toggle.querySelectorAll = (selector) =>
      selector === "button"
        ? shown === "simple"
          ? [pressed, other]
          : [other, pressed]
        : [];
    return {
      toggle,
      pressed,
      other,
      main: element("main", `${shown}: main`),
      card: element("card", `${shown}: a button on the page`),
    };
  };
  let shown = windowOf(design);
  document.querySelector = (selector) =>
    selector === TOGGLE ? shown.toggle : null;
  document.getElementById = (id) => (id === "main" ? shown.main : null);
  class Observer {
    constructor(changed) {
      this.changed = changed;
      this.on = false;
      observers.push(this);
    }
    observe(target, options) {
      this.on =
        target === document.body && options.subtree && options.childList;
    }
    disconnect() {
      this.on = false;
    }
  }
  const page = {
    document,
    focused,
    observers,
    timers,
    get shown() {
      return shown;
    },
    changed: () =>
      observers.filter((o) => o.on).forEach((o) => o.changed([])),
    redraw(next, meanwhile = () => {}, hidden = []) {
      for (const element of Object.values(shown)) element.isConnected = false;
      shown = windowOf(next, hidden);
      document.activeElement = document.body;
      meanwhile();
      page.changed();
    },
    store: () =>
      store(document.documentElement.dataset, async () => ({}), {
        document,
        MutationObserver: Observer,
        setTimeout: (run, ms) => timers.push({ run, ms }),
      }),
  };
  return page;
}

export async function aSwitchFromAToggleLeavesTheFocusOnTheOtherDesignsToggle() {
  const page = windowPage("detailed");
  const { setDesign } = page.store();
  page.document.activeElement = page.shown.other;
  assert.equal(setDesign("simple"), true);
  // The old window is still there: nothing moves until the other one is drawn.
  page.changed();
  assert.deepEqual(page.focused, []);
  page.redraw("simple");
  assert.deepEqual(page.focused, [
    ["simple: the pressed button of the toggle", { preventScroll: true }],
  ]);
  assert.ok(
    page.observers.every((o) => !o.on),
    "it stops looking",
  );
  // And back, the same way.
  page.document.activeElement = page.shown.other;
  setDesign("detailed");
  page.redraw("detailed");
  assert.deepEqual(page.focused.at(-1), [
    "detailed: the pressed button of the toggle",
    { preventScroll: true },
  ]);
}

export async function inDetailedsNarrowRailTheFocusTakesTheToggleButtonThatIsDrawn() {
  // Below 1240 px Detailed's rail shows only the way to Simple: the button of Detailed isn't drawn.
  const page = windowPage("simple");
  const { setDesign } = page.store();
  page.document.activeElement = page.shown.other;
  setDesign("detailed");
  page.redraw("detailed", undefined, ["pressed"]);
  assert.deepEqual(page.focused, [
    ["detailed: the other button of the toggle", { preventScroll: true }],
  ]);
  // A toggle with nothing drawn leaves the focus on the page.
  page.document.activeElement = page.shown.other;
  page.focused.length = 0;
  setDesign("simple");
  page.redraw("simple", undefined, ["pressed", "other"]);
  assert.deepEqual(page.focused, [["simple: main", { preventScroll: true }]]);
}

export async function aSwitchFromElsewhereLeavesTheFocusOnThePage() {
  // The palette, the card that offers Simple, Settings › Appearance.
  const page = windowPage("detailed");
  const { setDesign } = page.store();
  page.document.activeElement = page.shown.card;
  setDesign("simple");
  page.redraw("simple");
  assert.deepEqual(page.focused, [["simple: main", { preventScroll: true }]]);
}

export async function theFocusStaysWhereSomethingElsePutIt() {
  const page = windowPage("detailed");
  const { setDesign } = page.store();
  page.document.activeElement = page.shown.other;
  setDesign("simple");
  // Something in the new window, such as the palette as it closes, gave the focus away first.
  page.redraw("simple", () => page.shown.card.focus());
  assert.deepEqual(page.focused, [["simple: a button on the page", undefined]]);
  assert.ok(page.observers.every((o) => !o.on));
}

export async function aSecondSwitchBeforeTheFirstIsDrawnMovesTheFocusOnce() {
  const page = windowPage("detailed");
  const { setDesign } = page.store();
  page.document.activeElement = page.shown.other;
  setDesign("simple");
  setDesign("detailed");
  page.redraw("detailed");
  assert.deepEqual(page.focused, [
    ["detailed: the pressed button of the toggle", { preventScroll: true }],
  ]);
  assert.ok(page.observers.every((o) => !o.on));
}

export async function theWaitForTheOtherWindowEnds() {
  const page = windowPage("detailed");
  const { setDesign } = page.store();
  setDesign("simple");
  const wait = page.timers.find((timer) => timer.ms === 10_000);
  assert.ok(wait, "it gives up after ten seconds");
  wait.run();
  assert.ok(page.observers.every((o) => !o.on));
  page.redraw("simple");
  assert.deepEqual(page.focused, []);
}

export async function firstRunAndSavingTheDesignShownMoveNoFocus() {
  const page = windowPage("simple");
  const { chooseDesign, setDesign } = page.store();
  page.document.activeElement = page.shown.other;
  chooseDesign("detailed");
  setDesign("detailed");
  assert.deepEqual(page.observers, []);
}
