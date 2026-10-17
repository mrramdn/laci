import { useId } from "react";
import type { ReactNode } from "react";
import { Icon } from "../../common";
import { Art } from "../art";
import type { ArtName } from "../art";

/** A card with a heading: how Simple groups a page. */
export function Card({
  title,
  icon,
  actions,
  footer,
  children,
  className = "",
  level = 2,
}: {
  title?: ReactNode;
  icon?: string;
  /** Beside the heading: a ⋯ menu or a small button, never the screen's filled button. */
  actions?: ReactNode;
  /** Below the content, such as "See all in Activity". */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  level?: 2 | 3;
}) {
  const heading = useId();
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section
      className={`s-card ${className}`.trim()}
      aria-labelledby={title ? heading : undefined}
    >
      {title ? (
        <header className="s-card-head">
          {icon ? <Icon name={icon} /> : null}
          <Heading id={heading}>{title}</Heading>
          {actions ? <div className="s-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
      {footer ? <div className="s-card-foot">{footer}</div> : null}
    </section>
  );
}

/** What a place shows when it has nothing yet: a picture, what goes here, and the way to start. */
export function EmptyState({
  art,
  title,
  children,
  action,
  level = 2,
  compact = false,
}: {
  art: ArtName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  level?: 2 | 3;
  compact?: boolean;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={`s-empty${compact ? " s-empty-compact" : ""}`}>
      <Art name={art} />
      <Heading className="s-empty-title">{title}</Heading>
      {children ? <p>{children}</p> : null}
      {action ? <div className="s-actions">{action}</div> : null}
    </div>
  );
}
