import { useId, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../../common";
import { blocks } from "../../words";

/**
 * "Show details": the second of Simple's two levels. What is inside is drawn only once it is open,
 * so it asks for nothing until then.
 */
export function Disclosure({
  label = blocks.showDetails,
  openLabel = blocks.hideDetails,
  children,
  className = "",
}: {
  label?: string;
  openLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const region = useId();
  return (
    <div className={`s-disclosure ${className}`.trim()}>
      <button
        type="button"
        className="s-btn s-btn-text s-disclosure-toggle"
        aria-expanded={open}
        aria-controls={region}
        onClick={() => setOpen(!open)}
      >
        {open ? openLabel : label}
        <Icon name="chevron-down" className={open ? "s-turned" : ""} />
      </button>
      <div id={region} className="s-disclosure-body" hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}
