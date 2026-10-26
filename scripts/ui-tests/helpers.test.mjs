// The small formatters of ui/src/helpers.ts. A test file exports its tests as functions, and
// ui-state-smoke.mjs runs each one under the function's name.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const { bytes, plural, tilde } = load("helpers.ts");

export async function sizesReadInTheirOwnUnit() {
  assert.equal(bytes(undefined), "—");
  assert.equal(bytes(0), "—");
  assert.equal(bytes(512), "512 B");
  assert.equal(bytes(1_400), "1 KB");
  assert.equal(bytes(1_600), "2 KB");
  assert.equal(bytes(420e6), "420 MB");
  assert.equal(bytes(1.26e9), "1.3 GB");
}

export async function countsTakeAnSOnlyWhenNotOne() {
  assert.equal(plural(1, "project"), "1 project");
  assert.equal(plural(0, "project"), "0 projects");
  assert.equal(plural(7, "project"), "7 projects");
}

export async function homeBecomesATildeOnlyAtAFolderBoundary() {
  assert.equal(tilde("/home/demo", "/home/demo"), "~");
  assert.equal(tilde("/home/demo/project/app", "/home/demo"), "~/project/app");
  assert.equal(
    tilde("/home/demonic/project", "/home/demo"),
    "/home/demonic/project",
  );
  assert.equal(tilde("/media/backup", "/home/demo"), "/media/backup");
  assert.equal(tilde(undefined, "/home/demo"), "");
}
