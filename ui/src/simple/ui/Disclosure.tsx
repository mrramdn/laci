import { useId, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../../common";
import { blocks } from "../../words";

/**
 * "Show details": the second of Simple's two levels. What is inside is drawn only once it is open,
 * so it asks for nothing until then. `opened` opens it when something inside needs the user (a
 * place to choose), and it stays open after that until the user closes it.
 */
export function Disclosure({
  label = blocks.showDetails,
  openLabel = blocks.hideDetails,
  children,
  className = "",
  opened = false,
}: {
  label?: string;
  openLabel?: string;
  children: ReactNode;
  className?: string;
  opened?: boolean;
}) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  // Opened for the user, it stays open while they work inside, until they close it.
  if (opened && chosen === null) setChosen(true);
  const open = chosen ?? opened;
  const region = useId();
  return (
    <div className={`s-disclosure ${className}`.trim()}>
      <button
        type="button"
        className="s-btn s-btn-text s-disclosure-toggle"
        aria-expanded={open}
        aria-controls={region}
        onClick={() => setChosen(!open)}
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
