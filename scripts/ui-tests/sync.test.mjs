// The window's link to the desktop in ui/src/sync.ts: what it asks for when it starts, the saved
// choices before the window shows, one snapshot at a time, and nothing more once the window is gone.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const HOME = "/home/demo";
const ROOT = `${HOME}/project`;
/** A scan at `revision` with no projects in it. `from` tells two scans of one revision apart. */
const scan = (revision, from = "") => ({
  revision,
  configured: true,
  home: HOME,
  roots: [ROOT],
  nodes: {},
  proposals: [],
  from,
});
const prefs = (choices = {}) => ({
  theme: null,
  design: null,
  updates: null,
  configured: true,
  configPath: "~/.config/laci/config.json",
  os: "linux",
  ...choices,
});
const status = (revision, busy = false) => ({
  busy,
  revision,
  historyPending: false,
});
const APPS = { editor: "code", files: "nautilus", terminal: "kitty" };

/** Lets every promise that can settle, settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Starts useLaciSync on a store of its own, as React does when the window mounts. Each request
 * waits until the test answers it with `reply` or `refuse`. `asked` lists the requests, and the
 * event listener as "listen", in order. `emit` sends the window an event, and `close` runs the
 * effect's cleanup, as when the window goes.
 */
function start() {
  const asked = [];
  const waiting = [];
  const api = {
    api: (name, body) => {
      asked.push(name);
      return new Promise((resolve, reject) =>
        waiting.push({ name, body, resolve, reject }),
      );
    },
    errorText: (error) =>
      error instanceof Error ? error.message : String(error),
  };
  const dataset = {};
  const storage = new Map();
  const store = load(
    "store.ts",
    { "./api": api },
    {
      document: { documentElement: { dataset } },
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  );
  let handler;
  let listening = false;
  let restored = 0;
  let cleanup;
  const { useLaciSync } = load("sync.ts", {
    react: {
      useEffect: (effect) => {
        cleanup = effect();
      },
    },
    "@tauri-apps/api/event": {
      listen: async (name, callback) => {
        assert.equal(name, "laci");
        asked.push("listen");
        handler = callback;
        listening = true;
        return () => {
          listening = false;
        };
      },
    },
    "./api": api,
    "./store": store,
    "./terminal-api": {
      restoreTerminals: async () => {
        restored++;
      },
    },
  }, { setInterval: () => 1, clearInterval: () => {} });
  useLaciSync();
  /** The oldest request of that name still waiting, or the newest. */
  const take = (name, which) => {
    const matching = waiting.filter((request) => request.name === name);
    assert.ok(matching.length, `nothing is waiting for ${name}`);
    const request = which === "newest" ? matching.at(-1) : matching[0];
    waiting.splice(waiting.indexOf(request), 1);
    return request;
  };
  return {
    ...store,
    dataset,
    asked,
    get listening() {
      return listening;
    },
    get restored() {
      return restored;
    },
    waiting: () => waiting.map((request) => request.name),
    async reply(name, value, which = "oldest") {
      take(name, which).resolve(value);
      await settle();
    },
    async refuse(name, error) {
      take(name).reject(error);
      await settle();
    },
    async emit(payload) {
      handler({ payload });
      await settle();
    },
    close: () => cleanup?.(),
  };
}
/** Answers the requests a start makes, with a scan at `revision`. */
async function started(revision = 1) {
  const app = start();
  await settle();
  await app.reply("prefs", prefs());
  await app.reply("snapshot", scan(revision));
  await app.reply("status", status(revision));
  await app.reply("apps", APPS);
  await app.reply("new/current", null);
  app.asked.length = 0;
  return app;
}

export async function itAsksForTheSavedChoicesThenListensThenAsksForTheRest() {
  const app = start();
  await settle();
  assert.equal(app.restored, 1, "terminals that are still open come back");
  assert.deepEqual(app.asked, [
    "prefs",
    "listen",
    "snapshot",
    "status",
    "apps",
    "new/current",
  ]);
}

export async function theSavedChoicesAreInBeforeTheWindowCountsAsReady() {
  const app = start();
  await settle();
  await app.reply("snapshot", scan(1));
  await app.reply("status", status(1));
  await app.reply("apps", APPS);
  await app.reply("new/current", null);
  let state = app.useApp.getState();
  assert.equal(state.snapshot.revision, 1);
  assert.equal(state.apps.files, "nautilus");
  assert.equal(state.prefsReady, false, "the boot screen stays up");
  await app.reply("prefs", prefs({ theme: "dark" }));
  state = app.useApp.getState();
  assert.equal(state.prefsReady, true);
  assert.equal(state.theme, "dark");
  assert.equal(app.dataset.theme, "dark");
}

export async function refusedSavedChoicesStillLetTheWindowShow() {
  const app = start();
  await settle();
  await app.refuse("prefs", new Error("config.json can’t be read"));
  const state = app.useApp.getState();
  assert.equal(state.prefsReady, true);
  assert.equal(state.designSet, false, "nothing was read, so nothing was chosen");
  assert.equal(state.design, "detailed");
  assert.equal(state.error, null, "it is not a failed scan");
  assert.equal(state.toast, null);
}

export async function aFailedFirstScanIsTheBootScreensError() {
  const app = start();
  await settle();
  await app.reply("prefs", prefs());
  await app.refuse("snapshot", new Error("The disk went away"));
  const state = app.useApp.getState();
  assert.equal(state.snapshot, null);
  assert.equal(state.error, "The disk went away");
}

export async function aProjectStillBeingCreatedOpensItsDialog() {
  const app = start();
  await settle();
  app.useApp.setState({ palette: true });
  const job = { id: "job-1", state: "running" };
  await app.reply("snapshot", scan(1));
  await app.reply("status", status(1));
  await app.reply("apps", APPS);
  await app.reply("new/current", job);
  const state = app.useApp.getState();
  assert.deepEqual(state.modal, { kind: "new", job });
  assert.equal(state.palette, false);
}

export async function oneSnapshotAtATimeAndOneMoreForNewsThatCameMeanwhile() {
  const app = await started(1);
  await app.emit({ type: "snapshot" });
  await app.emit({ type: "snapshot" });
  await app.emit({ type: "snapshot" });
  assert.deepEqual(app.asked, ["snapshot"]);
  await app.reply("snapshot", scan(2));
  assert.deepEqual(app.asked, ["snapshot", "snapshot"]);
  await app.reply("snapshot", scan(3));
  assert.deepEqual(app.waiting(), []);
  assert.equal(app.useApp.getState().snapshot.revision, 3);
}

export async function aScanAnnouncedDuringStartIsNotReplacedByTheFirstReply() {
  const app = start();
  await settle();
  await app.reply("prefs", prefs());
  await app.emit({ type: "snapshot" });
  await app.emit({ type: "status", ...status(5, true) });
  await app.reply("snapshot", scan(5, "event"), "newest");
  assert.equal(app.useApp.getState().snapshot.from, "event");
  // The replies to the first requests were on their way before those events.
  await app.reply("snapshot", scan(5, "start"));
  await app.reply("status", status(5, false));
  await app.reply("apps", APPS);
  await app.reply("new/current", null);
  const state = app.useApp.getState();
  assert.equal(state.snapshot.from, "event");
  assert.equal(state.busy, true);
}

export async function eventsReachTheStore() {
  const app = await started(1);
  await app.emit({ type: "status", ...status(1, true) });
  assert.equal(app.useApp.getState().busy, true);
  await app.emit({ type: "refresh-error", error: "The disk went away", revision: 1 });
  assert.equal(app.useApp.getState().error, "The disk went away");
  await app.emit({ type: "log" });
  assert.deepEqual(app.asked, ["log"]);
  // A folder nobody has opened is not read again.
  await app.emit({ type: "ls", path: ROOT });
  assert.deepEqual(app.asked, ["log"]);
  app.useApp.setState({ listings: { [ROOT]: { path: ROOT, entries: [] } } });
  await app.emit({ type: "ls", path: ROOT });
  assert.deepEqual(app.asked, ["log", "ls"]);
}

export async function nothingHappensOnceTheWindowHasGone() {
  // Gone before the listener was on: it comes off at once, and nothing else is asked for.
  const early = start();
  early.close();
  await settle();
  assert.equal(early.listening, false);
  assert.deepEqual(early.asked, ["prefs", "listen"]);
  await early.reply("prefs", prefs({ theme: "dark" }));
  assert.equal(early.useApp.getState().prefsReady, false);
  assert.equal(early.dataset.theme, undefined);

  // Gone while the first replies were on their way: they change nothing.
  const late = start();
  await settle();
  late.close();
  assert.equal(late.listening, false);
  await late.reply("prefs", prefs());
  await late.reply("snapshot", scan(1));
  await late.reply("status", status(1));
  await late.reply("apps", APPS);
  await late.reply("new/current", null);
  const state = late.useApp.getState();
  assert.equal(state.snapshot, null);
  assert.equal(state.prefsReady, false);
}
