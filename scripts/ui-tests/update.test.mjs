// The window's side of updates (ui/src/update.ts): what it asks the desktop, the events it follows, and the
// preview's stand-in for both. The desktop alone talks to the update server.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const status = (state, more = {}) => ({
  enabled: true,
  state,
  current: "3.0.0",
  install: "click",
  ...more,
});

/** Lets every promise that can settle, settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The store on a desktop of its own. Each request waits until the test answers it with `reply` or
 * `refuse`; `asked` lists them in order, and `emit` sends the window a `laci` event.
 */
function start() {
  const asked = [];
  const waiting = [];
  const listeners = [];
  const { useUpdate } = load("update.ts", {
    "./api": {
      api: (name, body) => {
        asked.push({ name, body });
        return new Promise((resolve, reject) =>
          waiting.push({ name, resolve, reject }),
        );
      },
      errorText: (error) =>
        error instanceof Error ? error.message : String(error),
    },
    "@tauri-apps/api/event": {
      listen: (name, handler) => {
        listeners.push({ name, handler });
        return Promise.resolve(() => {});
      },
    },
  });
  const answer = async (name, how, value) => {
    await settle();
    const at = waiting.findIndex((w) => w.name === name);
    assert.ok(at >= 0, `nothing asked for ${name}; asked: ${JSON.stringify(asked)}`);
    const [request] = waiting.splice(at, 1);
    request[how](value);
    await settle();
  };
  return {
    useUpdate,
    asked,
    listeners,
    reply: (name, value) => answer(name, "resolve", value),
    refuse: (name, error) => answer(name, "reject", error),
    emit: (payload) => {
      for (const { name, handler } of listeners)
        if (name === "laci") handler({ payload });
    },
  };
}

export async function theStatusComesFromRequestsAndUpdateEventsOnly() {
  const desktop = start();
  const { useUpdate } = desktop;
  assert.equal(useUpdate.getState().status, null);
  const refreshed = useUpdate.getState().refresh();
  await desktop.reply("update/status", status("idle"));
  await refreshed;
  assert.equal(desktop.listeners.length, 1, "it listens before it asks");
  assert.equal(useUpdate.getState().status.state, "idle");
  // Other news of the desktop isn't about updates.
  desktop.emit({ type: "snapshot" });
  desktop.emit({ type: "status", busy: true, revision: 3 });
  assert.equal(useUpdate.getState().status.state, "idle");
  desktop.emit({ type: "update", ...status("available", { version: "3.0.1" }) });
  assert.deepEqual(
    useUpdate.getState().status,
    status("available", { version: "3.0.1" }),
  );
  // Listening once is enough for any number of requests.
  const again = useUpdate.getState().refresh();
  await desktop.reply("update/status", status("available", { version: "3.0.1" }));
  await again;
  assert.equal(desktop.listeners.length, 1);
}

export async function aReplyOlderThanAnEventDoesNotTakeItBack() {
  const desktop = start();
  const { useUpdate } = desktop;
  const refreshed = useUpdate.getState().refresh();
  await settle();
  // The download moved on while the status request was on its way.
  desktop.emit({ type: "update", ...status("downloading", { progress: 40 }) });
  await desktop.reply("update/status", status("downloading", { progress: 10 }));
  await refreshed;
  assert.equal(useUpdate.getState().status.progress, 40);
  // A check answers with what it found, and the events before it are older.
  desktop.emit({ type: "update", ...status("ready") });
  const checked = useUpdate.getState().check();
  await desktop.reply("update/check", status("ready"));
  await checked;
  assert.equal(useUpdate.getState().status.state, "ready");
}

export async function aRefusalIsKeptForTheWindowUntilTheNextRequest() {
  const desktop = start();
  const { useUpdate } = desktop;
  const install = useUpdate.getState().install();
  await desktop.refuse(
    "update/install",
    "Laci is busy with a change. Update when it's done.",
  );
  await install;
  assert.equal(
    useUpdate.getState().refusal,
    "Laci is busy with a change. Update when it's done.",
  );
  assert.equal(useUpdate.getState().status, null, "a refusal is no status");
  const restart = useUpdate.getState().restart();
  await settle();
  assert.equal(useUpdate.getState().refusal, null);
  await desktop.reply("update/restart", {});
  await restart;
  assert.deepEqual(
    desktop.asked.map((a) => a.name),
    ["update/install", "update/restart"],
  );
}

export async function theDailyChoiceIsSavedAndShown() {
  const desktop = start();
  const { useUpdate } = desktop;
  const chosen = useUpdate.getState().choose("daily");
  await desktop.reply("updates", { updates: "daily", design: null });
  await desktop.reply("update/status", status("idle", { enabled: true }));
  assert.equal(await chosen, true);
  assert.deepEqual(desktop.asked[0], {
    name: "updates",
    body: { updates: "daily" },
  });
  assert.equal(useUpdate.getState().status.enabled, true);
  const refused = useUpdate.getState().choose("off");
  await desktop.refuse("updates", "A project is being created.");
  assert.equal(await refused, false);
  assert.equal(useUpdate.getState().refusal, "A project is being created.");
}

/** The preview's make-believe update, from the first look to the restart. */
export async function thePreviewOffersAnUpdateDownloadsItAndRestarts() {
  globalThis.window = { crypto: globalThis.crypto };
  try {
    load("preview/ipc.ts").installIpc({
      os: "linux",
      design: "simple",
      theme: "light",
    });
    const events = [];
    const request = (name, body = {}) =>
      window.__TAURI_INTERNALS__.invoke("request", { name, body });
    await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "laci",
      target: { kind: "Any" },
      handler: window.__TAURI_INTERNALS__.transformCallback((event) => {
        if (event.payload.type === "update") events.push(event.payload);
      }),
    });
    const first = await request("update/status");
    assert.deepEqual(first, {
      enabled: false,
      state: "idle",
      current: "3.0.0",
      install: "click",
    });
    assert.equal((await request("prefs")).updates, null);
    await assert.rejects(request("update/install"), /Check for updates first/);
    await assert.rejects(request("update/restart"), /Install the update first/);

    const prefs = await request("updates", { updates: "daily" });
    assert.equal(prefs.updates, "daily");
    assert.equal((await request("update/status")).enabled, true);
    await assert.rejects(request("updates", { updates: "weekly" }), /Unknown update choice/);

    const found = await request("update/check");
    assert.equal(found.state, "available");
    assert.equal(found.version, "3.0.1");
    assert.match(found.url, /\/tag\/v3\.0\.1$/);
    // Times as the desktop writes them: whole seconds, in UTC.
    for (const time of [found.date, found.checkedAt])
      assert.match(time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(await request("update/install"), { started: true });
    const deadline = Date.now() + 5_000;
    while ((await request("update/status")).state !== "ready") {
      assert.ok(Date.now() < deadline, "the download never ended");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await request("update/restart"), {});
    const after = await request("update/status");
    assert.equal(after.state, "idle");
    assert.equal(after.current, "3.0.1");
    assert.equal(after.version, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const progress = events
      .filter((e) => e.state === "downloading")
      .map((e) => e.progress);
    assert.deepEqual(progress, [0, 25, 50, 75, 100]);
    const steps = events
      .map((e) => e.state)
      .filter((state, i, all) => state !== all[i - 1]);
    assert.deepEqual(steps, [
      "idle",
      "available",
      "downloading",
      "ready",
      "idle",
    ]);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete globalThis.window;
  }
}
