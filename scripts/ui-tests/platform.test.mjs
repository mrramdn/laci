// ui/src/platform.ts: the system the page names, its shortcut key and its own words.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

/** platform.ts on a page whose `<html>` has `data-os` set to `os`, or none when it is undefined. */
const on = (os) =>
  load("platform.ts", {}, {
    document: { documentElement: { dataset: os === undefined ? {} : { os } } },
  });
const pick = (platform) => ({
  OS: platform.OS,
  isMac: platform.isMac,
  MOD: platform.MOD,
  shortcut: platform.withMod("K"),
  TRASH: platform.TRASH,
  FILE_MANAGER: platform.FILE_MANAGER,
});
const ctrl = { ctrlKey: true, metaKey: false };
const cmd = { ctrlKey: false, metaKey: true };

export async function eachSystemHasItsOwnKeyAndWords() {
  assert.deepEqual(pick(on("macos")), {
    OS: "macos",
    isMac: true,
    MOD: "⌘",
    shortcut: "⌘K",
    TRASH: "Trash",
    FILE_MANAGER: "Finder",
  });
  assert.deepEqual(pick(on("windows")), {
    OS: "windows",
    isMac: false,
    MOD: "Ctrl",
    shortcut: "Ctrl K",
    TRASH: "Recycle Bin",
    FILE_MANAGER: "File Explorer",
  });
  assert.deepEqual(pick(on("linux")), {
    OS: "linux",
    isMac: false,
    MOD: "Ctrl",
    shortcut: "Ctrl K",
    TRASH: "Trash",
    FILE_MANAGER: "Files",
  });
}

export async function theShortcutKeyIsCommandOnMacAndCtrlElsewhere() {
  const mac = on("macos");
  assert.equal(mac.isMod(cmd), true);
  assert.equal(mac.isMod(ctrl), false);
  for (const os of ["linux", "windows"]) {
    const other = on(os);
    assert.equal(other.isMod(ctrl), true);
    assert.equal(other.isMod(cmd), false, `${os}: the Windows or Super key is the system's`);
  }
}

export async function aPageThatDoesNotSayIsLinux() {
  for (const os of [undefined, "", "plan9", "MacOS", "darwin"])
    assert.equal(on(os).OS, "linux", String(os));
  // Without a page at all, as in a test of a module that uses it.
  assert.deepEqual(pick(load("platform.ts")), pick(on("linux")));
}
