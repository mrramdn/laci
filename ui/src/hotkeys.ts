import { useEffect } from "react";
import { api } from "./api";
import { useApp, run, savePref } from "./store";
import { parentOf } from "./helpers";
import { isMac, MOD } from "./platform";
import { selectIsOpen } from "./select";
import { toggleTerminal } from "./terminal-api";
/** The parts of a key press that the shortcuts look at. */
type Press = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;
/** Ctrl, and on macOS ⌘ as well: where the window asks for Ctrl, a Mac may press either. */
const ctrlOrCmd = (event: Press) => event.ctrlKey || (isMac && event.metaKey);
/**
 * F4 on its own, or Ctrl+` (⌘+` too on macOS). F4 with Alt, Ctrl or ⌘ is the system's: Alt+F4 closes the
 * window and Ctrl+F4 a tab. Windows reports AltGr as Ctrl+Alt, and on some keyboards it types a `, so
 * Ctrl+Alt does not count.
 */
export const isTerminalKey = (event: Press) =>
  (event.key === "F4" && !event.altKey && !event.ctrlKey && !event.metaKey) ||
  (ctrlOrCmd(event) &&
    !event.altKey &&
    (event.key === "`" ||
      (isMac && !event.shiftKey && event.code === "Backquote")));
/** Ctrl+K or ⌘+K, on every system. */
export const isPaletteKey = (event: Press) =>
  (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
/** `?`, or Ctrl+/ (⌘+/ too on macOS, and not with AltGr, as above). */
export const isShortcutsKey = (event: Press) =>
  event.key === "?" || (ctrlOrCmd(event) && !event.altKey && event.key === "/");
/** ⌘+, on macOS, where every app opens its settings with it. */
export const isSettingsKey = (event: Press) =>
  isMac &&
  event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.shiftKey &&
  event.key === ",";
/**
 * Ctrl+H, or ⌘⇧. as in Finder on macOS, where Ctrl+H deletes a character and ⌘H hides the app. The
 * period is also found by its place on the keyboard, since Shift changes the character it types.
 */
export const isHiddenFilesKey = (event: Press) =>
  isMac
    ? event.metaKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      (event.code === "Period" || event.key === "." || event.key === ">")
    : event.ctrlKey && event.key.toLowerCase() === "h";
/** Backspace, or ⌘↑ as in Finder on macOS. */
export const isParentFolderKey = (event: Press) =>
  event.key === "Backspace" ||
  (isMac &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key === "ArrowUp");
const HIDDEN_FILES_KEYS = isMac ? ["⌘", "⇧", "."] : ["Ctrl", "H"];
/** What the Display menu says beside "Hidden files": Ctrl H, or ⌘⇧. on macOS. */
export const HIDDEN_FILES_HINT = HIDDEN_FILES_KEYS.join(isMac ? "" : " ");
type Shortcut = readonly [label: string, keys: readonly string[]];
/**
 * The window's shortcuts as this system writes them, for the list of shortcuts. The list comes from
 * here so that what it says and what the keys do stay together.
 */
export const SHORTCUTS: readonly (readonly [
  section: string,
  rows: readonly Shortcut[],
])[] = [
  [
    "Navigation",
    [
      ["Command palette", [MOD, "K"]],
      ["Next / Prev row", ["↓", "↑"]],
      ["Open / Select", ["↵"]],
      ["Parent folder", isMac ? ["⌫", "⌘ ↑"] : ["⌫"]],
      ["Next / Prev pane", ["F6", "Shift F6"]],
      ["Close / Dismiss", ["Esc"]],
    ],
  ],
  [
    "Workspace",
    [
      // ⌘` moves between a Mac app's windows, so its list names Ctrl.
      ["Toggle terminal", ["F4", isMac ? "⌃ `" : "Ctrl `"]],
      ["Toggle hidden files", HIDDEN_FILES_KEYS],
      ["Shortcuts help", ["?"]],
      ...(isMac ? [["Settings", ["⌘", ","]] as Shortcut] : []),
    ],
  ],
];
/** Detailed's panes, in the order F6 visits them. */
const PANES: [string, string][] = [
  ["sidebar", "#side"],
  ["main", "#main"],
  ["details", "#insp"],
  ["terminal", ".term"],
];
/** Marks each pane that is in the page with its name, as `data-pane`. */
export function namePanes() {
  for (const [name, selector] of PANES)
    document
      .querySelector<HTMLElement>(selector)
      ?.setAttribute("data-pane", name);
}
const shown = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  element.getClientRects().length > 0 &&
  !element.closest("[hidden]");
function paneTarget(name: string, pane: HTMLElement): HTMLElement | null {
  const find = (...selectors: string[]) => {
    for (const selector of selectors)
      for (const element of pane.querySelectorAll<HTMLElement>(selector))
        if (shown(element)) return element;
    return null;
  };
  if (name === "sidebar")
    return find(
      '.sb-item[aria-current="page"]',
      '.tree-row[tabindex="0"]',
      ".sb-item",
    );
  if (name === "main")
    return find(
      '.item[aria-selected="true"][tabindex]',
      ".item[tabindex]",
      'button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
    );
  if (name === "details")
    return find(
      '[role="tab"][aria-selected="true"]',
      'button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
    );
  return find(
    ".term-host:not([hidden]) .xterm-helper-textarea",
    '.ttab-select[aria-selected="true"]',
    "button",
  );
}
function nextPane(step: 1 | -1) {
  const open = PANES.map(([name, selector]) => {
    const pane = document.querySelector<HTMLElement>(selector);
    return pane && shown(pane) ? { name, pane } : null;
  }).filter((entry) => entry !== null);
  if (!open.length) return;
  const here = open.findIndex(({ pane }) =>
    pane.contains(document.activeElement),
  );
  const at = here < 0 ? (step > 0 ? 0 : open.length - 1) : here + step;
  const { name, pane } = open[(at + open.length) % open.length];
  (paneTarget(name, pane) ?? pane).focus();
}
const typing = (target: HTMLElement) =>
  target.matches('input,textarea,select,[role="combobox"]') ||
  target.isContentEditable;
/**
 * Keys for the whole window, in either design and on the first-run screen: F6 between the panes
 * that are shown, Ctrl or ⌘+K for the palette, F4 or Ctrl+` for the terminal, Escape for whatever is
 * on top, and ? or Ctrl+/ for the shortcuts. On macOS ⌘ does what Ctrl does here, and ⌘+, opens
 * Settings.
 */
export function useGlobalHotkeys() {
  useEffect(() => {
    const hotkey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "F6" && !event.ctrlKey && !event.altKey) {
        const state = useApp.getState();
        const target = event.target as HTMLElement;
        if (
          state.modal ||
          state.palette ||
          state.working ||
          selectIsOpen() ||
          target.closest?.(".xterm")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        nextPane(event.shiftKey ? -1 : 1);
        return;
      }
      const terminal = isTerminalKey(event);
      const palette = isPaletteKey(event);
      const settings = isSettingsKey(event);
      if (!terminal && !palette && !settings) return;
      event.preventDefault();
      event.stopPropagation();
      const state = useApp.getState();
      if (state.modal || state.working || selectIsOpen()) return;
      if (palette) useApp.setState({ palette: !state.palette });
      else if (state.palette) return;
      else if (settings) state.navigate("settings");
      else toggleTerminal();
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || selectIsOpen()) return;
      const target = event.target as HTMLElement;
      if (!(target instanceof HTMLElement)) return;
      const state = useApp.getState();
      if (state.working) return;
      if (event.key === "Escape") {
        if (state.palette) useApp.setState({ palette: false });
        else if (state.modal) return;
        else if (state.display) useApp.setState({ display: false });
        else if (target.closest(".xterm")) return;
        else useApp.setState({ selected: null, pendingSelection: null });
        event.preventDefault();
        return;
      }
      if (target.closest(".xterm") || state.palette || state.modal) return;
      if (isShortcutsKey(event) && !typing(target)) {
        event.preventDefault();
        useApp.setState({ modal: { kind: "shortcuts" } });
      }
    };
    window.addEventListener("keydown", hotkey, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", hotkey, true);
      window.removeEventListener("keydown", key);
    };
  }, []);
}
/**
 * Detailed's own keys: ↑ ↓ and Enter on list rows, Backspace for the parent folder and Ctrl+H for
 * hidden files (⌘↑ and ⌘⇧. on macOS). They come after the window's keys, which handle F6, Escape, ?
 * and Ctrl+/ first.
 */
export function useDetailedHotkeys() {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || selectIsOpen()) return;
      const target = event.target as HTMLElement;
      if (!(target instanceof HTMLElement)) return;
      const state = useApp.getState();
      if (state.working || event.key === "Escape") return;
      if (target.closest(".xterm") || state.palette || state.modal) return;
      if (isHiddenFilesKey(event) && state.view === "folder") {
        event.preventDefault();
        savePref("hidden", !state.hidden);
        useApp.setState({ hidden: !state.hidden });
        return;
      }
      if (typing(target)) return;
      // Before the rows' own keys, which would take ⌘↑ on a row for a move to the row above.
      if (
        isParentFolderKey(event) &&
        state.view === "folder" &&
        state.snapshot &&
        parentOf(state.cwd) !== state.cwd
      ) {
        event.preventDefault();
        state.cd(parentOf(state.cwd));
        return;
      }
      const row = target.closest<HTMLElement>(".main .item[tabindex]");
      if (
        row === target &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        event.preventDefault();
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>(".main .item[tabindex]"),
        );
        rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      }
      if (row === target && event.key === "Enter") {
        event.preventDefault();
        if (row.dataset.kind === "file" && row.dataset.id)
          void run(() => api("open", { id: row.dataset.id, what: "default" }));
        else if (row.dataset.kind === "dir" && row.dataset.id)
          state.cd(row.dataset.id);
        else row.click();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
}
