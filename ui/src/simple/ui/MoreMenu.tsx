import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../common";
import { usePlacement } from "./place";
import type { ButtonKind } from "./Button";

export interface MenuItem {
  label: string;
  icon?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** One choice among several: whether it is the one chosen now. */
  checked?: boolean;
  danger?: boolean;
}
/** An item, or "-" for a line between groups. */
export type MenuEntry = MenuItem | "-";

/**
 * A button that opens a menu: "⋯ More", and the menus of "Continue with AI ▾", Sort, In: and the
 * theme. The arrow keys, Home, End and a first letter move through it; Escape and Tab close it and
 * give the focus back to the button; a click elsewhere, or the focus going elsewhere (F6 does that),
 * closes it and leaves the focus where it went.
 */
export function MoreMenu({
  label,
  items,
  kind = "icon",
  icon,
  children,
  align = "end",
  className = "",
}: {
  /** The menu's name, and the button's when it shows only ⋯. */
  label: string;
  items: MenuEntry[];
  /** "icon" is the ⋯ button; "plain" takes its look from `className`; the others are Simple's buttons. */
  kind?: ButtonKind | "icon" | "plain";
  icon?: string;
  children?: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<"first" | "last">("first");
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  usePlacement(open, trigger, menu, align);
  const enabled = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );
  const focusAt = (index: number) => {
    const list = enabled();
    if (list.length) list[(index + list.length) % list.length].focus();
  };
  useLayoutEffect(() => {
    if (open) focusAt(from === "first" ? 0 : -1);
    // Only when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("focusin", away);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("focusin", away);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    close();
    item.onSelect();
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = enabled();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      focusAt(at + (key === "ArrowDown" ? 1 : -1));
    } else if (key === "Home" || key === "End") {
      event.preventDefault();
      focusAt(key === "Home" ? 0 : -1);
    } else if (key === "Escape" || key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (key.length === 1 && /\S/.test(key) && !event.ctrlKey && !event.metaKey) {
      const letter = key.toLowerCase();
      const next = [...list.slice(at + 1), ...list.slice(0, at + 1)].find(
        (item) => item.textContent?.trim().toLowerCase().startsWith(letter),
      );
      next?.focus();
    }
  };
  const triggerClass =
    kind === "icon" ? "s-iconbtn" : kind === "plain" ? "" : `s-btn s-btn-${kind}`;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${triggerClass} ${className}`.trim()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={kind === "icon" ? label : undefined}
        title={kind === "icon" ? label : undefined}
        data-ui={kind === "filled" ? "primary" : undefined}
        onClick={() => {
          setFrom("first");
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setFrom(event.key === "ArrowUp" ? "last" : "first");
          setOpen(true);
        }}
      >
        {kind === "icon" ? (
          <Icon name={icon ?? "ellipsis"} />
        ) : (
          <>
            {icon ? <Icon name={icon} /> : null}
            {children}
            {kind === "plain" ? null : (
              <Icon name="chevron-down" className={open ? "s-turned" : ""} />
            )}
          </>
        )}
      </button>
      {open
        ? createPortal(
            <div
              ref={menu}
              id={id}
              role="menu"
              aria-label={label}
              className="s-menu"
              onKeyDown={onMenuKey}
            >
              {items.map((item, i) =>
                item === "-" ? (
                  <div key={i} role="separator" className="s-menu-line" />
                ) : (
                  <button
                    key={i}
                    type="button"
                    tabIndex={-1}
                    role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                    aria-checked={item.checked}
                    aria-disabled={item.disabled || undefined}
                    className={`s-menu-item${item.danger ? " s-danger" : ""}`}
                    onClick={() => choose(item)}
                  >
                    {item.checked !== undefined ? (
                      <Icon name="check" className={item.checked ? "" : "s-hide"} />
                    ) : item.icon ? (
                      <Icon name={item.icon} />
                    ) : null}
                    <span>{item.label}</span>
                  </button>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
