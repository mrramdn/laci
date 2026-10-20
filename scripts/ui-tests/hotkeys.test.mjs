// The keys of ui/src/hotkeys.ts. The hooks run against a stand-in for the window, with the store they
// talk to.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const noop = () => {};

class FakeElement {
  constructor({ typing = false, row = false } = {}) {
    this.typing = typing;
    this.row = row;
    this.isContentEditable = false;
    this.dataset = row ? { kind: "dir", id: "/home/me/project/app" } : {};
  }
  closest(selector) {
    return selector === ".main .item[tabindex]" && this.row ? this : null;
  }
  matches() {
    return this.typing;
  }
  focus() {
    this.onFocus?.(this);
  }
  click() {
    this.onClick?.(this);
  }
}

/** The page being tried. The stubs of the module answer for it, so that the module loads once. */
let current;
let module;
/** hotkeys.ts as the page loads it. */
function hotkeys() {
  module ??= load(
    "hotkeys.ts",
    {
      react: { useEffect: (effect) => void effect() },
      "./api": { api: async () => ({}) },
      "./store": {
        useApp: {
          getState: () => current.state,
          setState: (change) =>
            Object.assign(
              current.state,
              typeof change === "function" ? change(current.state) : change,
            ),
        },
        run: (work) => work(),
        savePref: (key, value) => current.calls.saved.push([key, value]),
      },
      "./select": { selectIsOpen: () => false },
      "./terminal-api": { toggleTerminal: () => current.calls.terminal++ },
    },
    {
      document: {
        documentElement: { dataset: {} },
        activeElement: null,
        querySelector: () => null,
        querySelectorAll: () => current.rows,
      },
      window: {
        addEventListener: (type, handler, useCapture) => {
          if (type === "keydown")
            (useCapture ? current.capture : current.bubble).push(handler);
        },
        removeEventListener: noop,
      },
      HTMLElement: FakeElement,
      Element: FakeElement,
    },
  );
  return module;
}

/** A window with both hooks running on the store `patch` changes, and a way to press keys in it. */
function page(patch = {}) {
  const calls = { terminal: 0, cd: [], navigate: [], saved: [], focused: [] };
  const rows = [new FakeElement({ row: true }), new FakeElement({ row: true })];
  for (const row of rows)
    row.onFocus = (element) => calls.focused.push(rows.indexOf(element));
  const mine = {
    capture: [],
    bubble: [],
    calls,
    rows,
    state: {
      modal: null,
      palette: false,
      working: "",
      display: false,
      view: "folder",
      hidden: false,
      snapshot: {},
      cwd: "/home/me/project",
      selected: null,
      cd: (path) => calls.cd.push(path),
      navigate: (view) => calls.navigate.push(view),
      ...patch,
    },
  };
  const keys = hotkeys();
  current = mine;
  keys.useGlobalHotkeys();
  keys.useDetailedHotkeys();
  const body = new FakeElement();
  /** Presses `key` as the browser would deliver it: the capture handlers, then the others. */
  function press(key, mods = {}, target = body) {
    current = mine;
    const event = {
      key,
      code: "",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      defaultPrevented: false,
      stopped: false,
      target,
      ...mods,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };
    for (const handlers of [mine.capture, mine.bubble]) {
      for (const handler of handlers) handler(event);
      if (event.stopped) break;
    }
    return event;
  }
  return { ...keys, state: mine.state, calls, press, body, rows };
}

const ctrl = { ctrlKey: true };
const meta = { metaKey: true };
const alt = { altKey: true };

export async function f4TogglesTheTerminalButAltCtrlAndSuperF4BelongToTheSystem() {
  const w = page();
  const plain = w.press("F4");
  assert.equal(w.calls.terminal, 1);
  assert.ok(plain.defaultPrevented);
  w.press("F4", { shiftKey: true });
  assert.equal(w.calls.terminal, 2, "Shift+F4 is still F4");
  for (const mods of [alt, ctrl, meta, { ...alt, shiftKey: true }, { ...ctrl, ...alt }]) {
    const event = w.press("F4", mods);
    assert.equal(w.calls.terminal, 2, JSON.stringify(mods));
    assert.equal(event.defaultPrevented, false, "the system gets it");
    assert.equal(event.stopped, false);
  }
}

export async function theTerminalOpensWithCtrlBacktick() {
  const w = page();
  const count = () => w.calls.terminal;
  w.press("`", ctrl);
  assert.equal(count(), 1, "Ctrl+`");
  w.press("`", meta);
  assert.equal(count(), 1, "Super+`");
  // Ctrl+Alt can be AltGr: it types a ` and must not open anything.
  w.press("`", { ...ctrl, ...alt });
  w.press("`", alt);
  w.press("`");
  w.press("~", { ...ctrl, shiftKey: true });
  w.press("~", { ...meta, shiftKey: true, code: "Backquote" });
  w.press("Dead", { ...ctrl, code: "Backquote" });
  assert.equal(count(), 1, "nothing else opens it");
}

export async function thePaletteOpensWithCtrlKOrSuperK() {
  const w = page();
  for (const mods of [ctrl, meta]) {
    for (const key of ["k", "K"]) {
      w.press(key, mods);
      assert.equal(w.state.palette, true, key);
      w.press(key, mods);
      assert.equal(w.state.palette, false, key);
    }
  }
  w.press("k");
  assert.equal(w.state.palette, false);
}

export async function theShortcutsListOpensWithAQuestionMarkOrCtrlSlash() {
  const opens = (key, mods = {}, target) => {
    const w = page();
    w.press(key, mods, target);
    return w.state.modal?.kind === "shortcuts";
  };
  assert.equal(opens("?"), true, "?");
  assert.equal(opens("/", ctrl), true, "Ctrl+/");
  assert.equal(opens("/", meta), false, "Super+/");
  assert.equal(opens("/", { ...ctrl, ...alt }), false, "AltGr+/");
  assert.equal(opens("/"), false, "a slash is a slash");
  // In a field a ? is typed, and not taken for the list.
  assert.equal(opens("?", {}, new FakeElement({ typing: true })), false);
}

export async function noKeyOpensSettings() {
  const w = page();
  for (const mods of [meta, ctrl, { ...meta, shiftKey: true }, { ...meta, ...alt }, {}]) {
    const event = w.press(",", mods);
    assert.equal(event.defaultPrevented, false, JSON.stringify(mods));
  }
  assert.deepEqual(w.calls.navigate, []);
}

export async function hiddenFilesHaveCtrlH() {
  const toggles = (key, mods, patch, target) => {
    const w = page(patch);
    w.press(key, mods, target);
    return w.state.hidden;
  };
  assert.equal(toggles("h", ctrl), true, "Ctrl+H");
  assert.equal(toggles("H", ctrl), true, "Ctrl+Shift+H");
  for (const mods of [meta, { ...meta, shiftKey: true }, {}])
    assert.equal(toggles("h", mods), false, JSON.stringify(mods));
  assert.equal(toggles(">", { ...meta, shiftKey: true, code: "Period" }), false);
  // Only in the folder view, and still while a field has the focus.
  assert.equal(toggles("h", ctrl, { view: "today" }), false, "not in Today");
  assert.equal(toggles("h", ctrl, {}, new FakeElement({ typing: true })), true);
  const w = page({ hidden: true });
  w.press("h", ctrl);
  assert.equal(w.state.hidden, false, "and back again");
  assert.deepEqual(w.calls.saved, [["hidden", false]]);
}

export async function theParentFolderHasBackspace() {
  const parent = (key, mods, patch, target) => {
    const w = page(patch);
    const event = w.press(key, mods, target);
    return { cd: w.calls.cd, event };
  };
  assert.deepEqual(parent("Backspace").cd, ["/home/me"], "Backspace");
  assert.ok(parent("Backspace").event.defaultPrevented);
  assert.deepEqual(parent("ArrowUp", meta).cd, [], "Super+↑");
  assert.deepEqual(parent("ArrowUp", ctrl).cd, [], "Ctrl+↑");
  assert.deepEqual(parent("ArrowUp", { ...meta, shiftKey: true }).cd, []);
  assert.deepEqual(parent("ArrowUp").cd, [], "↑ alone moves between rows");
  // Not in another view, not at the top, and not while typing.
  assert.deepEqual(parent("Backspace", {}, { view: "today" }).cd, []);
  assert.deepEqual(parent("Backspace", {}, { cwd: "/" }).cd, []);
  assert.deepEqual(parent("Backspace", {}, { snapshot: null }).cd, []);
  assert.deepEqual(parent("Backspace", {}, {}, new FakeElement({ typing: true })).cd, []);
  assert.deepEqual(parent("Backspace", {}, { modal: { kind: "help" } }).cd, []);
}

export async function aRowStillMovesWithTheArrowsAndOpensWithEnter() {
  const w = page();
  const [first, second] = w.rows;
  assert.ok(w.press("ArrowDown", {}, first).defaultPrevented);
  assert.ok(w.press("ArrowUp", {}, second).defaultPrevented);
  assert.deepEqual(w.calls.focused, [1, 0]);
  w.press("Enter", {}, first);
  assert.deepEqual(w.calls.cd, ["/home/me/project/app"]);
  // Super+↑ on a row moves to the row above too.
  w.calls.focused.length = 0;
  w.press("ArrowUp", meta, second);
  assert.deepEqual(w.calls.focused, [0]);
}

export async function aDialogKeepsTheKeysItSwallows() {
  const w = page({ modal: { kind: "archive", id: "x" } });
  const event = w.press("F4");
  assert.equal(w.calls.terminal, 0);
  assert.ok(event.defaultPrevented);
  w.press("k", ctrl);
  assert.equal(w.state.palette, false);
  const busy = page({ working: "Archiving…" });
  busy.press("F4");
  assert.equal(busy.calls.terminal, 0);
}

export async function aSimpleSheetKeepsTheKeysOfTheWindowBehindIt() {
  const w = page({ sheets: 1, selected: "/home/me/project/app" });
  // Ctrl+K and F4 are taken, as with a dialog, and do nothing behind the sheet.
  const palette = w.press("k", ctrl);
  assert.equal(w.state.palette, false);
  assert.ok(palette.defaultPrevented);
  const terminal = w.press("F4");
  assert.equal(w.calls.terminal, 0);
  assert.ok(terminal.defaultPrevented);
  w.press(",", meta);
  assert.deepEqual(w.calls.navigate, []);
  // F6 is left alone: no pane behind the sheet gets the focus.
  const panes = w.press("F6");
  assert.equal(panes.defaultPrevented, false);
  assert.equal(panes.stopped, false);
  // Escape does not close the details behind it.
  w.press("Escape");
  assert.equal(w.state.selected, "/home/me/project/app");
  // Without the sheet the same keys work.
  w.state.sheets = 0;
  w.press("k", ctrl);
  assert.equal(w.state.palette, true);
  w.state.palette = false;
  w.press("F4");
  assert.equal(w.calls.terminal, 1);
  w.press("Escape");
  assert.equal(w.state.selected, null);
}

export async function escapeKeepsItsLayersInDetailed() {
  const at = (patch) => {
    const w = page({ selected: "/home/me/project/app", ...patch });
    const escape = w.press("Escape");
    return { state: w.state, escape };
  };
  // The details beside the view close first, as the key has always done.
  const bare = at({});
  assert.equal(bare.state.selected, null);
  assert.ok(bare.escape.defaultPrevented);
  // The palette, the display menu and a dialog each take it before the details do.
  const palette = at({ palette: true });
  assert.equal(palette.state.palette, false);
  assert.equal(palette.state.selected, "/home/me/project/app");
  const display = at({ display: true });
  assert.equal(display.state.display, false);
  assert.equal(display.state.selected, "/home/me/project/app");
  const dialog = at({ modal: { kind: "archive", id: "x" } });
  assert.equal(dialog.state.selected, "/home/me/project/app");
  // And a change that runs leaves everything as it is.
  const busy = at({ working: "Archiving…" });
  assert.equal(busy.state.selected, "/home/me/project/app");
}

// ── The list of shortcuts ──────────────────────────────────────────────────────────────────────────

const { SHORTCUTS, shortcutsFor } = load("shortcuts.ts");

/** A chord from ui/src/shortcuts.ts as the key press it stands for. */
function pressOf(chord) {
  const named = { "↑": "ArrowUp", "↓": "ArrowDown", Esc: "Escape" };
  const codes = { ".": "Period", "`": "Backquote", "/": "Slash", ",": "Comma" };
  const press = { key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  for (const key of chord) {
    if (key === "Ctrl") press.ctrlKey = true;
    else if (key === "Shift") press.shiftKey = true;
    else {
      press.key = named[key] ?? (key.length === 1 ? key.toLowerCase() : key);
      press.code = codes[key] ?? "";
    }
  }
  return press;
}

/** For each row of the table, whether a press does what the row says. */
const DOES = {
  palette: (keys, press) => keys.isPaletteKey(press),
  help: (keys, press) => keys.isShortcutsKey(press),
  shortcuts: (keys, press) => keys.isShortcutsKey(press),
  close: (_, press) => press.key === "Escape",
  terminal: (keys, press) => keys.isTerminalKey(press),
  panes: (_, press) => press.key === "F6" && !press.ctrlKey && !press.altKey,
  rows: (_, press) => ["ArrowDown", "ArrowUp"].includes(press.key),
  open: (_, press) => press.key === "Enter",
  parent: (keys, press) => keys.isParentFolderKey(press),
  hidden: (keys, press) => keys.isHiddenFilesKey(press),
};

export async function everyKeyTheListsNameDoesWhatTheySay() {
  assert.deepEqual(
    SHORTCUTS.map((row) => row.id).filter((id) => !DOES[id]),
    [],
    "a row without a check here",
  );
  const keys = hotkeys();
  for (const design of ["simple", "detailed"])
    for (const { id, chords } of shortcutsFor(design))
      for (const chord of chords)
        assert.ok(DOES[id](keys, pressOf(chord)), `${design}: ${chord.join(" ")} for ${id}`);
}

export async function theShortcutsKeyOpensTheListOnlyInDetailed() {
  const detailed = page();
  detailed.press("?");
  assert.deepEqual(detailed.state.modal, { kind: "shortcuts" });
  // Simple opens its Help page with the key itself (SimpleShell.tsx).
  const simple = page({ design: "simple" });
  simple.press("?");
  assert.equal(simple.state.modal, null);
}

export async function theDisplayMenuNamesTheKeyForHiddenFiles() {
  assert.equal(page().HIDDEN_FILES_HINT, "Ctrl H");
}
