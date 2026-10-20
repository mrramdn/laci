import { useEffect } from "react";
import { api } from "./api";
import { useApp, run, savePref } from "./store";
import { parentOf } from "./helpers";
import { selectIsOpen } from "./select";
import { chordsOf, chordText } from "./shortcuts";
import { toggleTerminal } from "./terminal-api";
/** The parts of a key press that the shortcuts look at. */
type Press = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;
/**
 * F4 on its own, or Ctrl+`. F4 with Alt, Ctrl or Super is the system's: Alt+F4 closes the window
 * and Ctrl+F4 a tab. AltGr can arrive as Ctrl+Alt, and on some keyboards it types a `, so Ctrl+Alt
 * does not count.
 */
export const isTerminalKey = (event: Press) =>
  (event.key === "F4" && !event.altKey && !event.ctrlKey && !event.metaKey) ||
  (event.ctrlKey && !event.altKey && event.key === "`");
/** Ctrl+K, or Super+K. */
export const isPaletteKey = (event: Press) =>
  (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
/** `?`, or Ctrl+/ (not with AltGr, as above). */
export const isShortcutsKey = (event: Press) =>
  event.key === "?" || (event.ctrlKey && !event.altKey && event.key === "/");
/** Ctrl+H. */
export const isHiddenFilesKey = (event: Press) =>
  event.ctrlKey && event.key.toLowerCase() === "h";
/** Backspace. */
export const isParentFolderKey = (event: Press) => event.key === "Backspace";
/** What the Display menu says beside "Hidden files": Ctrl H. */
export const HIDDEN_FILES_HINT = chordText(chordsOf("hidden")[0]);
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
 * that are shown, Ctrl+K for the palette, F4 or Ctrl+` for the terminal, Escape for whatever is on
 * top, and ? or Ctrl+/ for the shortcuts. A dialog, or one of Simple's sheets, has the keys to itself.
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
          state.sheets ||
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
      if (!terminal && !palette) return;
      event.preventDefault();
      event.stopPropagation();
      const state = useApp.getState();
      if (state.modal || state.working || state.sheets || selectIsOpen())
        return;
      if (palette) useApp.setState({ palette: !state.palette });
      else if (state.palette) return;
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
        else if (state.modal || state.sheets) return;
        else if (state.display) useApp.setState({ display: false });
        else if (target.closest(".xterm")) return;
        else useApp.setState({ selected: null, pendingSelection: null });
        event.preventDefault();
        return;
      }
      if (target.closest(".xterm") || state.palette || state.modal) return;
      // Simple opens its Help page with these keys itself.
      if (isShortcutsKey(event) && !typing(target) && state.design !== "simple") {
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
 * hidden files. They come after the window's keys, which handle F6, Escape, ? and Ctrl+/ first.
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
