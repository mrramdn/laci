import { useEffect, useId, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, restoreFocus } from "../../common";
import { useApp } from "../../store";
import { blocks } from "../../words";
import { useSimple } from "../state";

const CONTROLS =
  'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href],[tabindex="0"]';
function controls(host: HTMLElement | null) {
  return Array.from(host?.querySelectorAll<HTMLElement>(CONTROLS) ?? []).filter(
    (element) =>
      element.offsetParent !== null &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}

/**
 * A modal sheet over Simple's window, the way Laci's dialogs work: the window behind it is inert,
 * the focus starts on its first control and stays inside, Escape or a click beside it closes it
 * (unless a change is running), and the focus goes back where it was. Full height on a narrow
 * window, a dialog of at most 560 px on a wider one.
 */
export function Sheet({
  title,
  description,
  children,
  footer,
  onClose,
  dismissible = true,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const previous = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useLayoutEffect(() => {
    const items = controls(ref.current);
    const first =
      items.find((element) => !element.matches(".s-sheet-close")) ?? items[0];
    (first ?? ref.current)?.focus();
  }, []);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    useSimple.setState((s) => ({ sheets: s.sheets + 1 }));
    const before = previous.current;
    return () => {
      mounted.current = false;
      useSimple.setState((s) => ({ sheets: s.sheets - 1 }));
      // The window is inert until it draws again without this sheet. A sheet mounted again at once
      // (React's development check does that) keeps the focus.
      setTimeout(() => {
        if (!mounted.current) restoreFocus(before);
      });
    };
  }, []);
  const dismiss = () => {
    if (dismissible && !useApp.getState().working) onClose();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const items = controls(ref.current);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(
    <div
      className="s-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={ref}
        className="s-sheet"
        data-ui="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKey}
      >
        <header className="s-sheet-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          {dismissible ? (
            <button
              type="button"
              className="s-iconbtn s-sheet-close"
              aria-label={blocks.close}
              title={blocks.close}
              onClick={dismiss}
            >
              <Icon name="x" />
            </button>
          ) : null}
        </header>
        <div className="s-sheet-body">{children}</div>
        {footer ? <footer className="s-sheet-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
