// The keyboard shortcuts in one table, for each system and design: Help lists them, and so does
// Detailed's Keyboard shortcuts dialog in its own short names. hotkeys.ts does what they say, and its
// tests press every key listed here. macOS gets its own keys where the system has a habit (⌘ instead
// of Ctrl, ⌘↑ for the folder above, ⌘⇧. for hidden files, ⌘, for Settings); Linux and Windows share
// theirs. Pure data: it imports only types, so the tests read it as it is.
import type { Os } from "./platform";
import type { Design } from "./types";

/** Ways to press it: each is one chord, its keys in the order they are held. */
type Chords = readonly (readonly string[])[];

interface Row {
  id: string;
  /** What it does, in words both designs can show. */
  does: string;
  /** "everywhere", or "lists" for keys that move through Detailed's lists and folders. */
  group: "everywhere" | "lists";
  designs: readonly Design[];
  /** The keys on macOS, and on Linux and Windows. None: the system has no key for it. */
  mac: Chords;
  other: Chords;
}

const BOTH = ["simple", "detailed"] as const;
const DETAILED = ["detailed"] as const;

export const SHORTCUTS: readonly Row[] = [
  {
    id: "palette",
    does: "Search and actions",
    group: "everywhere",
    designs: BOTH,
    mac: [["⌘", "K"]],
    other: [["Ctrl", "K"]],
  },
  {
    id: "help",
    does: "Help",
    group: "everywhere",
    designs: ["simple"],
    mac: [["?"], ["⌘", "/"]],
    other: [["?"], ["Ctrl", "/"]],
  },
  {
    id: "shortcuts",
    does: "Keyboard shortcuts",
    group: "everywhere",
    designs: DETAILED,
    mac: [["?"], ["⌘", "/"]],
    other: [["?"], ["Ctrl", "/"]],
  },
  {
    id: "close",
    does: "Close a menu, sheet or dialog",
    group: "everywhere",
    designs: BOTH,
    mac: [["Esc"]],
    other: [["Esc"]],
  },
  {
    id: "terminal",
    does: "Show or hide the terminal",
    group: "everywhere",
    designs: BOTH,
    // ⌘` belongs to macOS: it moves between a program's windows.
    mac: [["F4"], ["⌃", "`"]],
    other: [["F4"], ["Ctrl", "`"]],
  },
  {
    id: "settings",
    does: "Settings",
    group: "everywhere",
    designs: BOTH,
    mac: [["⌘", ","]],
    other: [],
  },
  {
    id: "panes",
    does: "Next or previous part of the window",
    group: "everywhere",
    designs: BOTH,
    mac: [["F6"], ["⇧", "F6"]],
    other: [["F6"], ["Shift", "F6"]],
  },
  {
    id: "rows",
    does: "Next or previous row",
    group: "lists",
    designs: DETAILED,
    mac: [["↓"], ["↑"]],
    other: [["↓"], ["↑"]],
  },
  {
    id: "open",
    does: "Open or select",
    group: "lists",
    designs: DETAILED,
    mac: [["Return"]],
    other: [["Enter"]],
  },
  {
    id: "parent",
    does: "Folder above",
    group: "lists",
    designs: DETAILED,
    mac: [["⌘", "↑"]],
    other: [["Backspace"]],
  },
  {
    id: "hidden",
    does: "Show or hide hidden files",
    group: "lists",
    designs: DETAILED,
    mac: [["⌘", "⇧", "."]],
    other: [["Ctrl", "H"]],
  },
];

export interface Shortcut {
  id: string;
  does: string;
  group: Row["group"];
  chords: Chords;
}

/** The shortcuts `design` has on `os`, in the table's order. Ones with no key there are left out. */
export function shortcutsFor(os: Os, design: Design): Shortcut[] {
  return SHORTCUTS.filter((row) => row.designs.includes(design)).flatMap(
    ({ id, does, group, mac, other }) => {
      const chords = os === "macos" ? mac : other;
      return chords.length ? [{ id, does, group, chords }] : [];
    },
  );
}

/** The keys of row `id` on `os`: none when the system has no key for it. */
export function chordsOf(os: Os, id: string): Chords {
  const row = SHORTCUTS.find((r) => r.id === id);
  return !row ? [] : os === "macos" ? row.mac : row.other;
}

/** Detailed's Keyboard shortcuts dialog: its two sections, and the rows of each in its short names. */
const DETAILED_LIST = [
  [
    "Navigation",
    [
      ["palette", "Command palette"],
      ["rows", "Next / Prev row"],
      ["open", "Open / Select"],
      ["parent", "Parent folder"],
      ["panes", "Next / Prev pane"],
      ["close", "Close / Dismiss"],
    ],
  ],
  [
    "Workspace",
    [
      ["terminal", "Toggle terminal"],
      ["hidden", "Toggle hidden files"],
      ["shortcuts", "Shortcuts help"],
      ["settings", "Settings"],
    ],
  ],
] as const;

/** Detailed draws these keys as symbols, where Help writes their names. */
const SYMBOLS: Record<string, string> = { Enter: "↵", Return: "↵", Backspace: "⌫" };

/**
 * Detailed's list on `os`: each section with its rows, each row its name and its key caps. One chord
 * puts each key on a cap of its own (Ctrl, K); several put each chord on one cap (F6, Shift F6). Rows
 * with no key on `os` are left out.
 */
export function detailedList(os: Os) {
  const listed = new Map(shortcutsFor(os, "detailed").map((s) => [s.id, s.chords]));
  return DETAILED_LIST.map(([section, rows]) => {
    const shown = rows.flatMap(([id, label]) => {
      const chords = (listed.get(id) ?? []).map((chord) =>
        chord.map((key) => SYMBOLS[key] ?? key),
      );
      if (!chords.length) return [];
      const caps = chords.length === 1 ? chords[0] : chords.map((chord) => chord.join(" "));
      return [[label, caps] as const];
    });
    return [section, shown] as const;
  });
}

/** A chord as text: "⌘K" on macOS, where the symbols sit together, and "Ctrl K" elsewhere. */
export function chordText(os: Os, chord: readonly string[]) {
  return os === "macos" && chord.every((key) => key.length <= 2 || /^F\d+$/.test(key))
    ? chord.join("")
    : chord.join(" ");
}
