// The browser preview's stand-in for the desktop (ui/src/preview/ipc.ts), run without a browser.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../ui-module.mjs";

const source = fileURLToPath(new URL("../../ui/src/", import.meta.url));
const ACME = "/home/demo/project/clients/acme-store";

/**
 * Runs `body` with the preview's engine started fresh, and with what it reaches: `request` is the
 * interface's `api`, `invoke` its direct commands. The Tauri API finds the desktop through the
 * page's `window`, so there is a stand-in for it while `body` runs.
 */
async function onPreview(body) {
  globalThis.window = { crypto: globalThis.crypto };
  try {
    load("preview/ipc.ts").installIpc({
      design: "detailed",
      theme: "light",
    });
    const invoke = (command, args) =>
      window.__TAURI_INTERNALS__.invoke(command, args);
    await body({
      invoke,
      request: (name, body = {}) => invoke("request", { name, body }),
    });
  } finally {
    // The events a change sends are on their way. They need the window too.
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete globalThis.window;
  }
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === "preview"
        ? []
        : files(path.join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [path.join(dir, entry.name)]
        : [],
  );
}

/** What the interface asks for: the names it gives `api(...)`, and the commands it `invoke`s. */
function asked() {
  const requests = new Set();
  const commands = new Set();
  for (const file of files(source)) {
    const text = readFileSync(file, "utf8");
    for (const [, name] of text.matchAll(
      /\bapi(?:<[^()]*>)?\(\s*"([a-z][a-z/_-]*)"/g,
    ))
      requests.add(name);
    for (const [, name] of text.matchAll(/\binvoke(?:<[^()]*>)?\(\s*"(\w+)"/g))
      commands.add(name);
  }
  return { requests, commands };
}

export async function everyRequestTheInterfaceMakesHasAnAnswer() {
  const { requests, commands } = asked();
  assert.ok(requests.size > 50, `found only ${requests.size} requests`);
  assert.ok(commands.has("term_open"), "found no terminal commands");
  const refused = (error) => /has no answer/.test(String(error));
  const args = {
    id: "t",
    output: { onmessage() {} },
    data: "",
    cols: 1,
    rows: 1,
  };
  await onPreview(async ({ invoke, request }) => {
    for (const name of requests)
      await request(name).catch((error) =>
        assert.ok(!refused(error), `the preview cannot answer "${name}"`),
      );
    for (const command of commands)
      if (command !== "request")
        await invoke(command, args).catch((error) =>
          assert.ok(!refused(error), `the preview cannot answer ${command}`),
        );
  });
}

export async function aRequestNobodyAnsweredIsRefusedInPlainWords() {
  await onPreview(async ({ request }) => {
    await assert.rejects(request("no/such/request"), (error) => {
      assert.equal(typeof error, "string");
      assert.match(error, /no answer for "no\/such\/request"/);
      return true;
    });
  });
}

/**
 * The preview plays a setup whose choice about new versions is saved, so Today and Home show as
 * they do on any setup but one from before 3.0, whose card asks once (?updates=unset plays that).
 */
export async function thePreviewHasChosenToLookForNewVersions() {
  await onPreview(async ({ request }) => {
    assert.equal((await request("prefs")).updates, "daily");
    assert.equal((await request("update/status")).enabled, true);
  });
}

export async function theFixturesAreWhatTheEngineRecordedAtTheFixtureTime() {
  await onPreview(async ({ request }) => {
    const snapshot = await request("snapshot");
    assert.equal(snapshot.scannedAt, "2026-10-08T09:00:00.000Z");
    assert.equal(snapshot.home, "/home/demo");
    assert.ok(Object.hasOwn(snapshot.nodes, ACME));
    assert.deepEqual(await request("status"), {
      type: "status",
      busy: false,
      revision: snapshot.revision,
      historyPending: false,
    });
  });
}

export async function aTickedToDoShowsInTheProjectTheLogAndCanBeUndone() {
  await onPreview(async ({ request }) => {
    const before = await request("snapshot");
    const task = before.nodes[ACME].tasks.find((t) => !t.done);
    const done = (snapshot) =>
      snapshot.nodes[ACME].tasks.find((t) => t.text === task.text).done;
    const node = await request("todo", {
      id: ACME,
      op: "toggle",
      file: task.file,
      line: task.line,
      text: task.text,
      done: true,
    });
    assert.equal(node.tasks.find((t) => t.text === task.text).done, true);
    assert.ok(node.revision > before.revision);
    assert.equal(done(await request("snapshot")), true);
    const [entry] = (await request("log")).entries;
    assert.equal(entry.title, "Ticked a to-do in acme-store");
    assert.equal(entry.canUndo, true);

    await request("undo", { id: entry.id });
    assert.equal(done(await request("snapshot")), false);
    const log = (await request("log")).entries;
    assert.equal(log[0].title, "Undid: Ticked a to-do in acme-store");
    assert.equal(log[1].state, "undone");
  });
}

export async function theCopyOfChatsMovesToAChosenFolderAndUndoBringsItBack() {
  await onPreview(async ({ request }) => {
    const before = (await request("snapshot")).backup;
    assert.deepEqual([before.dest, before.chosen], ["~/.local/share/laci/history", false]);
    const moved = await request("backup/move", { dir: "/mnt/archive/ai-chats" });
    assert.equal(moved.dest, "/mnt/archive/ai-chats");
    assert.equal(moved.journal.canUndo, true);
    const after = (await request("snapshot")).backup;
    assert.deepEqual([after.dest, after.chosen], ["/mnt/archive/ai-chats", true]);
    const part = (await request("storage")).parts.find((p) => p.id === "history");
    assert.equal(part.dir, "/mnt/archive/ai-chats");
    const [entry] = (await request("log")).entries;
    assert.deepEqual(entry.say, { form: "movedCopy", dir: "/mnt/archive/ai-chats" });
    await assert.rejects(request("backup/move", { dir: "/mnt/archive/ai-chats" }), /already/);
    // A folder in home is said with ~, as the engine says it.
    await request("undo", { id: entry.id });
    assert.deepEqual((await request("snapshot")).backup.dest, "~/.local/share/laci/history");
    assert.equal((await request("backup/move", { dir: "/home/demo/chats" })).dest, "~/chats");
    assert.equal((await request("backup/move", { dir: "" })).dest, "~/.local/share/laci/history");
  });
}

export async function aReportIsFoundByTheWordsInIt() {
  await onPreview(async ({ request }) => {
    const hits = await request("reports/search", { query: "checkout safari" });
    assert.deepEqual(
      hits.map((hit) => hit.id),
      ["2026-10-07-checkout-total-on-mobile-safari.md"],
    );
    assert.match(hits[0].snippet, /checkout/i);
  });
}
