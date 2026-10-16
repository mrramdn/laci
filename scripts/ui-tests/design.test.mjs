// Simple and Detailed in ui/src/store.ts: what a switch changes and where it lands, how each design
// opens a project, and how the choices saved in config.json win over what the page started with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, requireUi } from "../ui-module.mjs";

const HOME = "/home/demo";
const ROOT = `${HOME}/project`;
const APP = `${ROOT}/app`;
const CLIENTS = `${ROOT}/clients`;

/**
 * A store of its own, on a page whose `<html>` has `dataset`. `reply` answers its requests.
 * `requests` lists what it asked for, and `storage` what it kept for the next start.
 */
function store(dataset = {}, reply = async () => ({})) {
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

export async function aNewSetupStartsInSimple() {
  const { useApp, applyPrefs, dataset } = store();
  applyPrefs(prefs({ design: null, configured: false }));
  assert.deepEqual(
    pick(useApp.getState(), "design", "designSet", "designOffer"),
    { design: "simple", designSet: false, designOffer: false },
  );
  assert.deepEqual(dataset, { design: "simple" });
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
  assert.equal(effectiveDesign({ design: null, configured: false }), "simple");
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
