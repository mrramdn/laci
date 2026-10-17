// The system the window runs on, with its own key and words. The desktop names it on the page before
// it paints (`data-os`); the browser preview takes it from ?os=. It is read once, when this module
// is first imported.
export type Os = "linux" | "macos" | "windows";
const named =
  typeof document === "undefined"
    ? undefined
    : document.documentElement?.dataset.os;
/** linux, macos or windows: Linux when the page doesn't say. */
export const OS: Os =
  named === "macos" || named === "windows" ? named : "linux";
export const isMac = OS === "macos";
/** The key shortcuts are held with: ⌘ on macOS, Ctrl elsewhere. */
export const MOD = isMac ? "⌘" : "Ctrl";
/** A shortcut with that key, as the system writes it: ⌘K on macOS, Ctrl K elsewhere. */
export const withMod = (key: string) => (isMac ? `⌘${key}` : `Ctrl ${key}`);
/** Whether the event has that key held: ⌘ on macOS, Ctrl elsewhere. */
export const isMod = (event: { ctrlKey: boolean; metaKey: boolean }) =>
  isMac ? event.metaKey : event.ctrlKey;
/** Where the system puts deleted files. */
export const TRASH = OS === "windows" ? "Recycle Bin" : "Trash";
/** The system's own file manager. */
export const FILE_MANAGER = isMac
  ? "Finder"
  : OS === "windows"
    ? "File Explorer"
    : "Files";
