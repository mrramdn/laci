// The browser preview's answers to the requests Simple's fixes use (ui/src/preview/ipc.ts): the
// secrets check by name, keeping files out with Undo, the AI's fix prompt and what a delete loses.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const KOPI = "/home/demo/project/clients/kopi-landing";
const CAMPUS = "/home/demo/project/thesis/campus-lms";
const DOTFILES = "/home/demo/project/side/dotfiles";

/** Runs `body` with the preview's engine started fresh; `request` is the interface's `api`. */
async function onPreview(body) {
  globalThis.window = { crypto: globalThis.crypto };
  try {
    load("preview/ipc.ts").installIpc({ design: "simple", theme: "light" });
    const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
    await body((name, args = {}) => invoke("request", { name, body: args }));
  } finally {
    // The events a change sends are on their way. They need the window too.
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete globalThis.window;
  }
}

export async function theSecretsCheckNamesFilesAndNeverTheirContents() {
  await onPreview(async (request) => {
    assert.deepEqual(await request("secrets/check", { id: KOPI }), {
      files: [{ path: ".env", tracked: false }],
      more: 0,
    });
    const campus = await request("secrets/check", { id: CAMPUS });
    assert.deepEqual(campus.files, [{ path: "server/firebase-credentials.json", tracked: true }]);
    assert.deepEqual(await request("secrets/check", { id: DOTFILES }), { files: [], more: 0 });
    await assert.rejects(request("secrets/check", { id: "/nowhere" }), /not in the last scan/);
  });
}

export async function keepingFilesOutIsAChangeWithUndo() {
  await onPreview(async (request) => {
    const change = await request("secrets/keep-out", { id: KOPI, files: [".env"] });
    assert.ok(change.revision > 0);
    assert.equal(change.journal.canUndo, true);
    assert.deepEqual((await request("secrets/check", { id: KOPI })).files, []);
    const [entry] = (await request("log")).entries;
    assert.equal(entry.title, "Added .env to .gitignore in kopi-landing");
    assert.equal(entry.path, KOPI);
    assert.equal(entry.canUndo, true);
    await request("undo", { id: change.journal.id });
    assert.deepEqual((await request("secrets/check", { id: KOPI })).files, [
      { path: ".env", tracked: false },
    ]);
    await assert.rejects(request("secrets/keep-out", { id: KOPI, files: [] }), /Choose the files/);
  });
}

export async function theFixPromptSaysWhatNeverToDo() {
  await onPreview(async (request) => {
    const { prompt, projectPath } = await request("assistant/prompt", {
      kind: "fix",
      id: KOPI,
      code: "no-remote",
    });
    assert.equal(projectPath, KOPI);
    assert.match(prompt, /--private/);
    assert.match(prompt, /Never force-push, rewrite history, or delete files or branches/);
    assert.match(prompt, /Show each command before running it/);
    // Only for a check the project has.
    await assert.rejects(
      request("assistant/prompt", { kind: "fix", id: DOTFILES, code: "no-remote" }),
      /Nothing to fix/,
    );
    await assert.rejects(
      request("assistant/prompt", { kind: "fix", id: KOPI, code: "no-readme" }),
      /no fix/,
    );
  });
}

export async function aDeletePlanListsWhatTheOnlineCopyCantGiveBack() {
  await onPreview(async (request) => {
    const plan = await request("delete/plan", { id: CAMPUS });
    assert.deepEqual(plan.unbacked, {
      files: ["server/firebase-credentials.json", "data/grades-2026.sqlite"],
      more: 0,
    });
    assert.ok(Array.isArray(plan.ops));
    assert.deepEqual((await request("delete/plan", { id: DOTFILES })).unbacked, {
      files: [],
      more: 0,
    });
  });
}
