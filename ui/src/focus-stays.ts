// Where the focus goes when the control that had it goes away, in both designs.
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { focusAfter } from "./simple/model";
import { useApp } from "./store";

const CONTROLS =
  'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
/** Taken off the page, or no longer drawn. */
const gone = (control: HTMLElement) =>
  !control.isConnected || control.offsetParent === null || Boolean(control.closest("[hidden]"));
export const usable = (control: HTMLElement) => !gone(control) && !control.matches(":disabled");

/**
 * Keeps the keyboard on the page when the control that has the focus goes away: a folder's Remove,
 * a summary's Done, Save changes once nothing waits, a session's Restore. The focus moves to the
 * control `instead` names for the one that went, out of the page's controls as they were when it
 * took the focus (`around`), when that can take it; else to the control that was after it, else the
 * one before (focusAfter). A control that is only switched off for a moment keeps it. Watching the
 * page, as a Sheet does, works in every web view, whether or not it says that the focus left. While
 * a change runs the window takes no focus, so the move waits for the change to end.
 */
export function useFocusStays(
  page: RefObject<HTMLElement | null>,
  instead?: (gone: HTMLElement, around: HTMLElement[]) => HTMLElement | null | undefined,
) {
  const prefer = useRef(instead);
  prefer.current = instead;
  useEffect(() => {
    const root = page.current;
    if (!root) return;
    let last: { control: HTMLElement; around: HTMLElement[] } | null = null;
    const focused = (event: FocusEvent) => {
      const control = event.target as HTMLElement;
      last = { control, around: Array.from(root.querySelectorAll<HTMLElement>(CONTROLS)) };
    };
    // The focus went on elsewhere, such as to a sheet or the sidebar, or a click put it nowhere.
    const left = (event: FocusEvent) => {
      const to = event.relatedTarget as Element | null;
      if (to && !root.contains(to)) last = null;
    };
    const clicked = (event: PointerEvent) => {
      if (!(event.target as Element).closest(CONTROLS)) last = null;
    };
    const moveOn = () => {
      const at = document.activeElement;
      if (!last || (at && at !== document.body && at !== last.control)) return;
      if (!gone(last.control)) return;
      const preferred = prefer.current?.(last.control, last.around);
      const next =
        preferred && root.contains(preferred) && usable(preferred)
          ? preferred
          : focusAfter(last.around, last.control, usable);
      if (next && !next.closest("[inert]")) next.focus();
    };
    const watch = new MutationObserver(moveOn);
    watch.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "class", "data-show"],
    });
    const done = useApp.subscribe((state, before) => {
      if (before.working && !state.working) requestAnimationFrame(moveOn);
    });
    root.addEventListener("focusin", focused);
    root.addEventListener("focusout", left);
    root.addEventListener("pointerdown", clicked);
    return () => {
      watch.disconnect();
      done();
      root.removeEventListener("focusin", focused);
      root.removeEventListener("focusout", left);
      root.removeEventListener("pointerdown", clicked);
    };
  }, [page]);
}
