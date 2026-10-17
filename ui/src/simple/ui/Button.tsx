import type { ButtonHTMLAttributes, Ref } from "react";
import { Icon } from "../../common";

/** Filled is the screen's one main button; outline and text are everything else. */
export type ButtonKind = "filled" | "outline" | "text";

/**
 * Simple's button. The filled one carries `data-ui="primary"`, so checks can tell that a screen
 * has only one. A destructive button is never filled: `danger` only colours an outline or text one.
 */
export function Button({
  kind = "outline",
  icon,
  small = false,
  danger = false,
  className = "",
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: ButtonKind;
  icon?: string;
  small?: boolean;
  danger?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const classes = [
    "s-btn",
    `s-btn-${kind}`,
    small ? "s-btn-small" : "",
    danger && kind !== "filled" ? "s-btn-danger" : "",
    className,
  ].filter(Boolean);
  return (
    <button
      type="button"
      ref={ref}
      className={classes.join(" ")}
      data-ui={kind === "filled" ? "primary" : undefined}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}
