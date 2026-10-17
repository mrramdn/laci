// ui/src/shortcuts.ts: one table of keys for each system and design, which Help lists.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const { SHORTCUTS, chordText, shortcutsFor } = load("shortcuts.ts");
const keysOf = (os, design, id) =>
  shortcutsFor(os, design)
    .find((s) => s.id === id)
    ?.chords.map((chord) => chordText(os, chord));

export async function theTableIsWellFormed() {
  const ids = SHORTCUTS.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const row of SHORTCUTS) {
    assert.ok(row.does.trim(), row.id);
    assert.ok(row.designs.length, `${row.id}: in some design`);
    for (const design of row.designs) assert.ok(["simple", "detailed"].includes(design));
    assert.ok(row.mac.length || row.other.length, `${row.id}: some system has a key for it`);
    for (const chord of [...row.mac, ...row.other]) assert.ok(chord.length, `${row.id}: an empty chord`);
  }
}

export async function macOsUsesCommandAndTheOthersUseCtrl() {
  for (const row of SHORTCUTS) {
    assert.ok(!row.mac.flat().includes("Ctrl"), `${row.id}: macOS writes ⌘ or ⌃, not Ctrl`);
    assert.ok(!row.other.flat().includes("⌘"), `${row.id}: only macOS has ⌘`);
  }
  assert.deepEqual(keysOf("macos", "simple", "palette"), ["⌘K"]);
  assert.deepEqual(keysOf("linux", "simple", "palette"), ["Ctrl K"]);
  assert.deepEqual(keysOf("windows", "detailed", "palette"), ["Ctrl K"]);
  // ⌘` belongs to macOS itself, so the terminal keeps Control there.
  assert.deepEqual(keysOf("macos", "detailed", "terminal"), ["F4", "⌃`"]);
  assert.deepEqual(keysOf("linux", "detailed", "terminal"), ["F4", "Ctrl `"]);
}

export async function macOsKeepsItsOwnHabits() {
  // ⌘H hides the app on macOS, ⌘↑ is the folder above in Finder, and ⌘, opens the settings.
  assert.deepEqual(keysOf("macos", "detailed", "hidden"), ["⌘⇧."]);
  assert.deepEqual(keysOf("linux", "detailed", "hidden"), ["Ctrl H"]);
  assert.deepEqual(keysOf("macos", "detailed", "parent"), ["⌘↑"]);
  assert.deepEqual(keysOf("windows", "detailed", "parent"), ["Backspace"]);
  assert.deepEqual(keysOf("macos", "simple", "settings"), ["⌘,"]);
  // A system without a key for it doesn't list it.
  assert.equal(keysOf("linux", "simple", "settings"), undefined);
  assert.equal(keysOf("windows", "detailed", "settings"), undefined);
}

export async function eachDesignListsItsOwnKeys() {
  const simple = shortcutsFor("linux", "simple").map((s) => s.id);
  const detailed = shortcutsFor("linux", "detailed").map((s) => s.id);
  // Simple has no lists to walk with the arrow keys and no hidden files to show.
  for (const id of ["rows", "open", "parent", "hidden", "shortcuts"]) {
    assert.ok(!simple.includes(id), `Simple lists ${id}`);
    assert.ok(detailed.includes(id), `Detailed lacks ${id}`);
  }
  for (const id of ["palette", "close", "terminal", "panes"]) {
    assert.ok(simple.includes(id), `Simple lacks ${id}`);
    assert.ok(detailed.includes(id), `Detailed lacks ${id}`);
  }
  assert.ok(simple.includes("help"));
  // In the table's order.
  const order = SHORTCUTS.map((row) => row.id);
  assert.deepEqual(detailed, order.filter((id) => detailed.includes(id)));
}

export async function aChordReadsAsTheSystemWritesIt() {
  assert.equal(chordText("macos", ["⌘", "K"]), "⌘K");
  assert.equal(chordText("macos", ["⇧", "F6"]), "⇧F6");
  assert.equal(chordText("macos", ["Return"]), "Return");
  assert.equal(chordText("linux", ["Ctrl", "K"]), "Ctrl K");
  assert.equal(chordText("windows", ["Shift", "F6"]), "Shift F6");
}
