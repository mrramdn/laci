import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../common";
import { blocks, termOf } from "../../words";
import { usePlacement } from "./place";

/**
 * ⓘ beside a word: what it means, and the Git word your AI may use for it. It opens on a click or
 * when the keyboard reaches it, and stays until it is dismissed: Escape, a click elsewhere, or the
 * focus moving on (WCAG 1.4.13). Nothing opens on hover alone.
 */
export function Info({ term }: { term: string }) {
  const entry = termOf(term);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const id = useId();
  usePlacement(open, button, pop, "start");
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !pop.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  if (!entry) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="s-info"
        data-ui="info"
        aria-label={blocks.info(entry.term)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <Icon name="info" />
      </button>
      {/* Read out from here, a region that is always there; the box drawn beside the ⓘ is for the eye. */}
      <span id={id} role="status" className="sr-only">
        {open ? `${entry.term}: ${entry.info}` : ""}
      </span>
      {open
        ? createPortal(
            <span ref={pop} className="s-info-pop" aria-hidden="true">
              <b>{entry.term}</b>
              {entry.info}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
