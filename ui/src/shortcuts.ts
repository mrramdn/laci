// The keyboard shortcuts in one table, for each design: Help lists them, and so does Detailed's
// Keyboard shortcuts dialog in its own short names. hotkeys.ts does what they say, and its tests press
// every key listed here. Pure data: it imports only types, so the tests read it as it is.
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
  keys: Chords;
}

const BOTH = ["simple", "detailed"] as const;
const DETAILED = ["detailed"] as const;

export const SHORTCUTS: readonly Row[] = [
  {
    id: "palette",
    does: "Search and actions",
    group: "everywhere",
    designs: BOTH,
    keys: [["Ctrl", "K"]],
  },
  {
    id: "help",
    does: "Help",
    group: "everywhere",
    designs: ["simple"],
    keys: [["?"], ["Ctrl", "/"]],
  },
  {
    id: "shortcuts",
    does: "Keyboard shortcuts",
    group: "everywhere",
    designs: DETAILED,
    keys: [["?"], ["Ctrl", "/"]],
  },
  {
    id: "close",
    does: "Close a menu, sheet or dialog",
    group: "everywhere",
    designs: BOTH,
    keys: [["Esc"]],
  },
  {
    id: "terminal",
    does: "Show or hide the terminal",
    group: "everywhere",
    designs: BOTH,
    keys: [["F4"], ["Ctrl", "`"]],
  },
  {
    id: "panes",
    does: "Next or previous part of the window",
    group: "everywhere",
    designs: BOTH,
    keys: [["F6"], ["Shift", "F6"]],
  },
  {
    id: "rows",
    does: "Next or previous row",
    group: "lists",
    designs: DETAILED,
    keys: [["↓"], ["↑"]],
  },
  {
    id: "open",
    does: "Open or select",
    group: "lists",
    designs: DETAILED,
    keys: [["Enter"]],
  },
  {
    id: "parent",
    does: "Folder above",
    group: "lists",
    designs: DETAILED,
    keys: [["Backspace"]],
  },
  {
    id: "hidden",
    does: "Show or hide hidden files",
    group: "lists",
    designs: DETAILED,
    keys: [["Ctrl", "H"]],
  },
];

export interface Shortcut {
  id: string;
  does: string;
  group: Row["group"];
  chords: Chords;
}

/** The shortcuts `design` has, in the table's order. */
export function shortcutsFor(design: Design): Shortcut[] {
  return SHORTCUTS.filter((row) => row.designs.includes(design)).map(
    ({ id, does, group, keys }) => ({ id, does, group, chords: keys }),
  );
}

/** The keys of row `id`: none when there is no such row. */
export function chordsOf(id: string): Chords {
  return SHORTCUTS.find((r) => r.id === id)?.keys ?? [];
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
    ],
  ],
] as const;

/** Detailed draws these keys as symbols, where Help writes their names. */
const SYMBOLS: Record<string, string> = { Enter: "↵", Backspace: "⌫" };

/**
 * Detailed's list: each section with its rows, each row its name and its key caps. One chord puts each
 * key on a cap of its own (Ctrl, K); several put each chord on one cap (F6, Shift F6).
 */
export function detailedList() {
  const listed = new Map(shortcutsFor("detailed").map((s) => [s.id, s.chords]));
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

/** A chord as text: "Ctrl K". */
export function chordText(chord: readonly string[]) {
  return chord.join(" ");
}
