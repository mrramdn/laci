// What a folder chosen in the palette does to Simple's Projects (ui/src/simple/state.ts), on the app's own
// store: `cd` is the palette's choice, and "See all" is Home's.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const HOME = "/home/demo";
const ROOT = `${HOME}/project`;
const CLIENTS = `${ROOT}/clients`;
const SIDE = `${ROOT}/side`;
const KOPI = `${CLIENTS}/kopi-landing`;
const folder = (path) => ({ id: path, kind: "folder", path, label: path.split("/").pop() });
const project = (path) => ({ id: path, kind: "project", path, label: path.split("/").pop() });
const SNAPSHOT = {
  revision: 1,
  configured: true,
  home: HOME,
  roots: [ROOT],
  nodes: Object.fromEntries(
    [folder(ROOT), folder(CLIENTS), folder(SIDE), project(KOPI)].map((n) => [n.id, n]),
  ),
  proposals: [],
};

/** The app's store with Simple's state on top of it, and the window in `design`. */
function simple(design = "simple") {
  const store = load(
    "store.ts",
    { "./api": { api: async () => ({}), errorText: String } },
    {
      document: { documentElement: { dataset: {} } },
      localStorage: { getItem: () => null, setItem: () => {} },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  );
  const state = load("simple/state.ts", { "../store": store });
  store.useApp.getState().load(structuredClone(SNAPSHOT));
  store.useApp.setState({ design });
  return {
    cd: (path) => store.useApp.getState().cd(path),
    app: store.useApp,
    simple: state.useSimple,
    showProjects: state.showProjects,
    shown: () => {
      const { folder, filter } = state.useSimple.getState();
      return { folder, filter };
    },
  };
}

export async function aFolderChosenInThePaletteFiltersProjects() {
  const s = simple();
  s.cd(CLIENTS);
  assert.deepEqual(s.shown(), { folder: CLIENTS, filter: "all" });
  assert.equal(s.app.getState().view, "folder");
  s.cd(SIDE);
  assert.deepEqual(s.shown(), { folder: SIDE, filter: "all" });
  // The one root holds every project: choosing it filters nothing.
  s.cd(ROOT);
  assert.deepEqual(s.shown(), { folder: null, filter: "all" });
}

export async function theSameFolderChosenAgainFiltersProjectsAgain() {
  const s = simple();
  s.cd(CLIENTS);
  // Home's "See all" shows every folder again, and leaves its own filter on.
  s.showProjects("needs");
  assert.deepEqual(s.shown(), { folder: null, filter: "needs" });
  assert.equal(s.app.getState().cwd, CLIENTS, "the store still has the folder it went to");
  // Choosing the folder again is a choice like the first one.
  s.cd(CLIENTS);
  assert.deepEqual(s.shown(), { folder: CLIENTS, filter: "all" });
  // So it is when the filter was changed by hand in Projects, and when Home was shown in between.
  s.simple.setState({ folder: null, filter: "active", query: "kopi" });
  s.app.getState().navigate("today");
  s.cd(CLIENTS);
  assert.deepEqual(s.shown(), { folder: CLIENTS, filter: "all" });
  assert.equal(s.app.getState().view, "folder");
}

export async function otherWaysToProjectsLeaveTheFilterAlone() {
  const s = simple();
  s.cd(CLIENTS);
  s.simple.setState({ filter: "needs" });
  // The sidebar's Projects, and the store changing for other reasons, do not choose a folder.
  s.app.getState().navigate("folder");
  s.app.setState({ toast: { title: "Scan finished", message: "" } });
  s.app.getState().load(structuredClone({ ...SNAPSHOT, revision: 2 }));
  assert.deepEqual(s.shown(), { folder: CLIENTS, filter: "needs" });
  // A project goes to its own page, which has no folder to filter by.
  s.cd(KOPI);
  assert.equal(s.app.getState().view, "project");
  assert.deepEqual(s.shown(), { folder: CLIENTS, filter: "needs" });
}

export async function detailedKeepsFoldersToItself() {
  const s = simple("detailed");
  s.simple.setState({ folder: SIDE, filter: "needs" });
  s.cd(CLIENTS);
  s.cd(CLIENTS);
  assert.equal(s.app.getState().cwd, CLIENTS);
  assert.deepEqual(s.shown(), { folder: SIDE, filter: "needs" });
}
