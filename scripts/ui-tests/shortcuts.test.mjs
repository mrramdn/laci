// ui/src/shortcuts.ts: one table of keys for each design, which Help and Detailed's Keyboard shortcuts
// dialog list.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const { SHORTCUTS, chordText, detailedList, shortcutsFor } = load("shortcuts.ts");
const keysOf = (design, id) =>
  shortcutsFor(design)
    .find((s) => s.id === id)
    ?.chords.map((chord) => chordText(chord));

export async function theTableIsWellFormed() {
  const ids = SHORTCUTS.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const row of SHORTCUTS) {
    assert.ok(row.does.trim(), row.id);
    assert.ok(row.designs.length, `${row.id}: in some design`);
    for (const design of row.designs) assert.ok(["simple", "detailed"].includes(design));
    assert.ok(row.keys.length, `${row.id}: a key for it`);
    for (const chord of row.keys) assert.ok(chord.length, `${row.id}: an empty chord`);
  }
}

export async function theKeysUseCtrl() {
  assert.deepEqual(keysOf("simple", "palette"), ["Ctrl K"]);
  assert.deepEqual(keysOf("detailed", "palette"), ["Ctrl K"]);
  assert.deepEqual(keysOf("detailed", "terminal"), ["F4", "Ctrl `"]);
  assert.deepEqual(keysOf("detailed", "hidden"), ["Ctrl H"]);
  assert.deepEqual(keysOf("detailed", "parent"), ["Backspace"]);
  // No key opens Settings, so neither list names one.
  assert.equal(keysOf("simple", "settings"), undefined);
  assert.equal(keysOf("detailed", "settings"), undefined);
}

export async function eachDesignListsItsOwnKeys() {
  const simple = shortcutsFor("simple").map((s) => s.id);
  const detailed = shortcutsFor("detailed").map((s) => s.id);
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

export async function aChordReadsWithASpaceBetweenItsKeys() {
  assert.equal(chordText(["Ctrl", "K"]), "Ctrl K");
  assert.equal(chordText(["Shift", "F6"]), "Shift F6");
  assert.equal(chordText(["Backspace"]), "Backspace");
}

/** The list Detailed's Keyboard shortcuts dialog shows. */
const LISTED = [
  [
    "Navigation",
    [
      ["Command palette", ["Ctrl", "K"]],
      ["Next / Prev row", ["↓", "↑"]],
      ["Open / Select", ["↵"]],
      ["Parent folder", ["⌫"]],
      ["Next / Prev pane", ["F6", "Shift F6"]],
      ["Close / Dismiss", ["Esc"]],
    ],
  ],
  [
    "Workspace",
    [
      ["Toggle terminal", ["F4", "Ctrl `"]],
      ["Toggle hidden files", ["Ctrl", "H"]],
      // It also names Ctrl+/, which has opened the list all along.
      ["Shortcuts help", ["?", "Ctrl /"]],
    ],
  ],
];
const plain = (value) => JSON.parse(JSON.stringify(value));

export async function detailedsListIsAsItWas() {
  assert.deepEqual(plain(detailedList()), LISTED);
}

export async function detailedsListHasEveryDetailedKey() {
  assert.equal(
    detailedList().flatMap(([, rows]) => rows).length,
    shortcutsFor("detailed").length,
  );
}
