// Where the focus is, for a page that moves it on after a change: Clean up and Activity give it to
// what comes next when the button that had it goes away, and back to the button when a change fails.

/** The element that has the focus, if any. */
export const focused = () =>
  document.activeElement instanceof HTMLElement ? document.activeElement : null;

/**
 * Nothing on the page has the focus: it fell to the page when what had it went away (or the window
 * waited for a change), or a dialog closing gave it back to the page as a whole.
 */
export function focusLost() {
  const at = document.activeElement;
  return !at || at === document.body || at.id === "main";
}
