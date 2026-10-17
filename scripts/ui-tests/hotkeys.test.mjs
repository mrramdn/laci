// The keys of ui/src/hotkeys.ts on each system: the page names it in `data-os`, and ⌘ takes Ctrl's
// place on macOS. The hooks run against a stand-in for the window, with the store they talk to.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const noop = () => {};
const SYSTEMS = ["linux", "windows", "macos"];

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

/** The page being tried. The stubs of a module answer for it, so that a module loads once for each system. */
let current;
const modules = new Map();
/** hotkeys.ts as the page of `os` loads it. */
function hotkeysOf(os) {
  if (!modules.has(os))
    modules.set(
      os,
      load(
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
            documentElement: { dataset: { os } },
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
      ),
    );
  return modules.get(os);
}

/** A window of `os` with both hooks running on the store `patch` changes, and a way to press keys in it. */
function page(os, patch = {}) {
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
  const hotkeys = hotkeysOf(os);
  current = mine;
  hotkeys.useGlobalHotkeys();
  hotkeys.useDetailedHotkeys();
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
  return { ...hotkeys, state: mine.state, calls, press, body, rows };
}

const ctrl = { ctrlKey: true };
const cmd = { metaKey: true };
const alt = { altKey: true };

export async function f4TogglesTheTerminalButAltCtrlAndCommandF4BelongToTheSystem() {
  for (const os of SYSTEMS) {
    const w = page(os);
    const plain = w.press("F4");
    assert.equal(w.calls.terminal, 1, os);
    assert.ok(plain.defaultPrevented, os);
    w.press("F4", { shiftKey: true });
    assert.equal(w.calls.terminal, 2, `${os}: Shift+F4 is still F4`);
    for (const mods of [
      alt,
      ctrl,
      cmd,
      { ...alt, shiftKey: true },
      { ...ctrl, ...alt },
    ]) {
      const event = w.press("F4", mods);
      assert.equal(w.calls.terminal, 2, `${os} ${JSON.stringify(mods)}`);
      assert.equal(event.defaultPrevented, false, `${os}: the system gets it`);
      assert.equal(event.stopped, false);
    }
  }
}

export async function theTerminalOpensWithCtrlBacktickAndOnMacWithCommandToo() {
  for (const os of SYSTEMS) {
    const mac = os === "macos";
    const w = page(os);
    const count = () => w.calls.terminal;
    w.press("`", ctrl);
    assert.equal(count(), 1, `${os}: Ctrl+\``);
    w.press("`", cmd);
    assert.equal(count(), mac ? 2 : 1, `${os}: ⌘+\``);
    // Ctrl+Alt is AltGr on Windows: it types a ` and must not open anything.
    w.press("`", { ...ctrl, ...alt });
    w.press("`", alt);
    w.press("`");
    w.press("~", { ...ctrl, shiftKey: true });
    w.press("~", { ...cmd, shiftKey: true, code: "Backquote" });
    assert.equal(count(), mac ? 2 : 1, `${os}: nothing else opens it`);
    // A dead ` still has its place on the keyboard.
    w.press("Dead", { ...ctrl, code: "Backquote" });
    assert.equal(count(), mac ? 3 : 1, `${os}: Ctrl+dead key`);
  }
}

export async function thePaletteOpensWithCtrlKOrCommandKOnEverySystem() {
  for (const os of SYSTEMS) {
    const w = page(os);
    for (const mods of [ctrl, cmd]) {
      for (const key of ["k", "K"]) {
        w.press(key, mods);
        assert.equal(w.state.palette, true, `${os} ${key}`);
        w.press(key, mods);
        assert.equal(w.state.palette, false, `${os} ${key}`);
      }
    }
    w.press("k");
    assert.equal(w.state.palette, false);
  }
}

export async function theShortcutsListOpensWithAQuestionMarkOrCtrlSlashAndOnMacCommandSlash() {
  for (const os of SYSTEMS) {
    const mac = os === "macos";
    const opens = (key, mods = {}, target) => {
      const w = page(os);
      w.press(key, mods, target);
      return w.state.modal?.kind === "shortcuts";
    };
    assert.equal(opens("?"), true, `${os}: ?`);
    assert.equal(opens("/", ctrl), true, `${os}: Ctrl+/`);
    assert.equal(opens("/", cmd), mac, `${os}: ⌘+/`);
    assert.equal(opens("/", { ...ctrl, ...alt }), false, `${os}: AltGr+/`);
    assert.equal(opens("/"), false, `${os}: a slash is a slash`);
    // In a field a ? is typed, and not taken for the list.
    assert.equal(opens("?", {}, new FakeElement({ typing: true })), false, os);
  }
}

export async function commandCommaOpensSettingsOnMacOnly() {
  for (const os of SYSTEMS) {
    const w = page(os);
    const event = w.press(",", cmd);
    assert.deepEqual(w.calls.navigate, os === "macos" ? ["settings"] : [], os);
    assert.equal(event.defaultPrevented, os === "macos", os);
    w.press(",", ctrl);
    w.press(",", { ...cmd, shiftKey: true });
    w.press(",", { ...cmd, ...alt });
    w.press(",");
    assert.equal(w.calls.navigate.length, os === "macos" ? 1 : 0, os);
  }
}

export async function theSettingsKeyWaitsForADialogAndForThePalette() {
  const w = page("macos", { modal: { kind: "archive", id: "x" } });
  w.press(",", cmd);
  assert.deepEqual(w.calls.navigate, []);
  const palette = page("macos", { palette: true });
  palette.press(",", cmd);
  assert.deepEqual(palette.calls.navigate, []);
  assert.equal(palette.state.palette, true);
}

export async function hiddenFilesHaveCtrlHOutsideMacAndCommandShiftPeriodOnMac() {
  const toggles = (os, key, mods, patch, target) => {
    const w = page(os, patch);
    w.press(key, mods, target);
    return w.state.hidden;
  };
  for (const os of ["linux", "windows"]) {
    assert.equal(toggles(os, "h", ctrl), true, `${os}: Ctrl+H`);
    assert.equal(toggles(os, "H", ctrl), true, `${os}: Ctrl+Shift+H`);
    for (const mods of [cmd, { ...cmd, shiftKey: true }, {}])
      assert.equal(
        toggles(os, "h", mods),
        false,
        `${os} ${JSON.stringify(mods)}`,
      );
    assert.equal(
      toggles(os, ">", { ...cmd, shiftKey: true, code: "Period" }),
      false,
      os,
    );
  }
  const mac = "macos";
  const finder = { ...cmd, shiftKey: true };
  assert.equal(
    toggles(mac, ">", { ...finder, code: "Period" }),
    true,
    "US keyboard",
  );
  assert.equal(toggles(mac, ".", finder), true, "a period typed with Shift");
  assert.equal(
    toggles(mac, ":", { ...finder, code: "Period" }),
    true,
    "German keyboard",
  );
  assert.equal(
    toggles(mac, ".", { ...cmd, code: "Period" }),
    false,
    "⌘. alone is Stop",
  );
  assert.equal(toggles(mac, "h", ctrl), false, "Ctrl+H deletes a character");
  assert.equal(toggles(mac, "h", cmd), false, "⌘H hides the app");
  assert.equal(
    toggles(mac, ">", { ...finder, ...ctrl, code: "Period" }),
    false,
  );
  // Only in the folder view, and still while a field has the focus.
  for (const os of SYSTEMS) {
    const keys =
      os === "macos" ? [">", { ...finder, code: "Period" }] : ["h", ctrl];
    assert.equal(
      toggles(os, ...keys, { view: "today" }),
      false,
      `${os}: not in Today`,
    );
    assert.equal(
      toggles(os, ...keys, {}, new FakeElement({ typing: true })),
      true,
      os,
    );
    const w = page(os, { hidden: true });
    w.press(...keys);
    assert.equal(w.state.hidden, false, `${os}: and back again`);
    assert.deepEqual(w.calls.saved, [["hidden", false]], os);
  }
}

export async function theParentFolderHasBackspaceAndOnMacCommandUp() {
  for (const os of SYSTEMS) {
    const mac = os === "macos";
    const parent = (key, mods, patch, target) => {
      const w = page(os, patch);
      const event = w.press(key, mods, target);
      return { cd: w.calls.cd, event };
    };
    assert.deepEqual(parent("Backspace").cd, ["/home/me"], `${os}: Backspace`);
    assert.ok(parent("Backspace").event.defaultPrevented);
    assert.deepEqual(
      parent("ArrowUp", cmd).cd,
      mac ? ["/home/me"] : [],
      `${os}: ⌘↑`,
    );
    assert.deepEqual(parent("ArrowUp", ctrl).cd, [], `${os}: Ctrl+↑`);
    assert.deepEqual(parent("ArrowUp", { ...cmd, shiftKey: true }).cd, [], os);
    assert.deepEqual(
      parent("ArrowUp").cd,
      [],
      `${os}: ↑ alone moves between rows`,
    );
    // Not in another view, not at the top, and not while typing.
    assert.deepEqual(parent("Backspace", {}, { view: "today" }).cd, [], os);
    assert.deepEqual(parent("Backspace", {}, { cwd: "/" }).cd, [], os);
    assert.deepEqual(parent("Backspace", {}, { snapshot: null }).cd, [], os);
    assert.deepEqual(
      parent("Backspace", {}, {}, new FakeElement({ typing: true })).cd,
      [],
      os,
    );
    assert.deepEqual(
      parent("Backspace", {}, { modal: { kind: "help" } }).cd,
      [],
      os,
    );
    // A drive or a share goes up to its own root, and stops there.
    const at = (cwd) => parent("Backspace", {}, { cwd }).cd;
    assert.deepEqual(at("C:\\Users\\me\\project"), ["C:\\Users\\me"], os);
    assert.deepEqual(at("C:\\Users"), ["C:\\"], os);
    assert.deepEqual(at("C:\\"), [], os);
    assert.deepEqual(at("\\\\nas\\files\\a"), ["\\\\nas\\files\\"], os);
    assert.deepEqual(at("\\\\nas\\files\\"), [], os);
  }
}

export async function aRowStillMovesWithTheArrowsAndOpensWithEnter() {
  for (const os of SYSTEMS) {
    const w = page(os);
    const [first, second] = w.rows;
    assert.ok(w.press("ArrowDown", {}, first).defaultPrevented);
    assert.ok(w.press("ArrowUp", {}, second).defaultPrevented);
    assert.deepEqual(w.calls.focused, [1, 0], os);
    w.press("Enter", {}, first);
    assert.deepEqual(w.calls.cd, ["/home/me/project/app"], os);
    // A Mac's ⌘↑ on a row goes to the parent folder, not to the row above.
    w.calls.focused.length = 0;
    w.press("ArrowUp", cmd, second);
    assert.deepEqual(w.calls.focused, os === "macos" ? [] : [0], os);
  }
}

export async function aDialogKeepsTheKeysItSwallows() {
  for (const os of SYSTEMS) {
    const w = page(os, { modal: { kind: "archive", id: "x" } });
    const event = w.press("F4");
    assert.equal(w.calls.terminal, 0, os);
    assert.ok(event.defaultPrevented, os);
    w.press("k", ctrl);
    assert.equal(w.state.palette, false, os);
    const busy = page(os, { working: "Archiving…" });
    busy.press("F4");
    assert.equal(busy.calls.terminal, 0, os);
  }
}

export async function aSimpleSheetKeepsTheKeysOfTheWindowBehindIt() {
  for (const os of SYSTEMS) {
    const w = page(os, { sheets: 1, selected: "/home/me/project/app" });
    // Ctrl+K, F4 and ⌘, are taken, as with a dialog, and do nothing behind the sheet.
    const palette = w.press("k", ctrl);
    assert.equal(w.state.palette, false, os);
    assert.ok(palette.defaultPrevented, os);
    const terminal = w.press("F4");
    assert.equal(w.calls.terminal, 0, os);
    assert.ok(terminal.defaultPrevented, os);
    w.press(",", cmd);
    assert.deepEqual(w.calls.navigate, [], os);
    // F6 is left alone: no pane behind the sheet gets the focus.
    const panes = w.press("F6");
    assert.equal(panes.defaultPrevented, false, os);
    assert.equal(panes.stopped, false, os);
    // Escape does not close the details behind it.
    w.press("Escape");
    assert.equal(w.state.selected, "/home/me/project/app", os);
    // Without the sheet the same keys work.
    w.state.sheets = 0;
    w.press("k", ctrl);
    assert.equal(w.state.palette, true, os);
    w.state.palette = false;
    w.press("F4");
    assert.equal(w.calls.terminal, 1, os);
    w.press("Escape");
    assert.equal(w.state.selected, null, os);
  }
}

export async function escapeKeepsItsLayersInDetailed() {
  for (const os of SYSTEMS) {
    const at = (patch) => {
      const w = page(os, { selected: "/home/me/project/app", ...patch });
      const escape = w.press("Escape");
      return { state: w.state, escape };
    };
    // The details beside the view close first, as the key has always done.
    const bare = at({});
    assert.equal(bare.state.selected, null, os);
    assert.ok(bare.escape.defaultPrevented, os);
    // The palette, the display menu and a dialog each take it before the details do.
    const palette = at({ palette: true });
    assert.equal(palette.state.palette, false, os);
    assert.equal(palette.state.selected, "/home/me/project/app", os);
    const display = at({ display: true });
    assert.equal(display.state.display, false, os);
    assert.equal(display.state.selected, "/home/me/project/app", os);
    const dialog = at({ modal: { kind: "archive", id: "x" } });
    assert.equal(dialog.state.selected, "/home/me/project/app", os);
    // And a change that runs leaves everything as it is.
    const busy = at({ working: "Archiving…" });
    assert.equal(busy.state.selected, "/home/me/project/app", os);
  }
}

// ── The list of shortcuts ──────────────────────────────────────────────────────────────────────────

const { SHORTCUTS, shortcutsFor } = load("shortcuts.ts");

/** A chord from ui/src/shortcuts.ts as the key press it stands for. */
function pressOf(chord) {
  const named = { "↑": "ArrowUp", "↓": "ArrowDown", Esc: "Escape", Return: "Enter" };
  const codes = { ".": "Period", "`": "Backquote", "/": "Slash", ",": "Comma" };
  const press = { key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  for (const key of chord) {
    if (key === "Ctrl" || key === "⌃") press.ctrlKey = true;
    else if (key === "⌘") press.metaKey = true;
    else if (key === "Shift" || key === "⇧") press.shiftKey = true;
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
  settings: (keys, press) => keys.isSettingsKey(press),
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
  for (const os of SYSTEMS) {
    const keys = hotkeysOf(os);
    for (const design of ["simple", "detailed"])
      for (const { id, chords } of shortcutsFor(os, design))
        for (const chord of chords)
          assert.ok(DOES[id](keys, pressOf(chord)), `${os} ${design}: ${chord.join(" ")} for ${id}`);
  }
}

export async function theShortcutsKeyOpensTheListOnlyInDetailed() {
  for (const os of SYSTEMS) {
    const detailed = page(os);
    detailed.press("?");
    assert.deepEqual(detailed.state.modal, { kind: "shortcuts" }, os);
    // Simple opens its Help page with the key itself (SimpleShell.tsx).
    const simple = page(os, { design: "simple" });
    simple.press("?");
    assert.equal(simple.state.modal, null, os);
  }
}

export async function theDisplayMenuNamesTheKeyForHiddenFiles() {
  for (const os of ["linux", "windows"]) assert.equal(page(os).HIDDEN_FILES_HINT, "Ctrl H", os);
  assert.equal(page("macos").HIDDEN_FILES_HINT, "⌘⇧.");
}
