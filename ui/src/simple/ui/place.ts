import { useLayoutEffect } from "react";
import type { RefObject } from "react";

const MARGIN = 8;
const GAP = 4;

/**
 * Keeps a floating box (a menu, an ⓘ text) next to what opened it while it is open: below it, or
 * above when there is no room below, and inside the window. The box is drawn in document.body with
 * `position: fixed`, so no scrolling or clipping parent can cut it off.
 */
export function usePlacement(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  floating: RefObject<HTMLElement | null>,
  align: "start" | "end" = "start",
) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      const element = floating.current;
      if (!box || !element) return;
      const { width, height } = element.getBoundingClientRect();
      const wanted = align === "end" ? box.right - width : box.left;
      const left = Math.max(
        MARGIN,
        Math.min(wanted, window.innerWidth - width - MARGIN),
      );
      const below = box.bottom + GAP;
      const above = box.top - GAP - height;
      const top =
        below + height > window.innerHeight - MARGIN && above >= MARGIN
          ? above
          : below;
      element.style.left = `${Math.round(left)}px`;
      element.style.top = `${Math.round(Math.max(MARGIN, top))}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, anchor, floating]);
}
