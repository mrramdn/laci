// The window before the first scan is done (ui/src/boot.ts, drawn by App.tsx in both designs): it says
// what the scan reads and how far it has come, from the progress `status` carries, so a first scan of a
// big history that takes minutes doesn't look stuck.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const { bootSay } = load("boot.ts");

export async function theFirstScanSaysWhatItReadsAndHowFarItHasCome() {
  const history = bootSay({ step: "history", done: 120, total: 2400, bytes: 900e6, totalBytes: 4.4e9 });
  assert.equal(history.title, "Reading your AI chat history…");
  assert.equal(history.detail, "120 of 2400 files · 900 MB of 4.4 GB");
  assert.match(history.note, /first time/);

  const started = bootSay({ step: "history", done: 0, total: 2400, bytes: 0, totalBytes: 4.4e9 });
  assert.equal(started.detail, "0 of 2400 files · 0 MB of 4.4 GB");

  assert.equal(bootSay({ step: "folders", done: 0, total: 0, bytes: 0, totalBytes: 0 }).title, "Looking through your folders…");

  const projects = bootSay({ step: "projects", done: 12, total: 58, bytes: 0, totalBytes: 0 });
  assert.equal(projects.title, "Reading your projects…");
  assert.equal(projects.detail, "12 of 58 folders");
}

export async function withoutProgressItSaysWhatItAlwaysSaid() {
  // An older engine, a preview, or the moment between two steps.
  for (const progress of [undefined, null]) {
    const say = bootSay(progress);
    assert.equal(say.title, "Looking for your projects…");
    assert.equal(say.detail, undefined);
  }
  // Nothing to count yet: no "0 of 0".
  assert.equal(bootSay({ step: "history", done: 0, total: 0, bytes: 0, totalBytes: 0 }).detail, undefined);
}
