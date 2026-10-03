import type { ReactNode } from "react";
import { ago, when, FIX_LABEL } from "./helpers";
import { useApp, toggleExpanded } from "./store";
import type { Node, Op, Severity } from "./types";
import { openTerminal } from "./terminal-api";
export function restoreFocus(previous: HTMLElement | null) {
  const target = [previous, document.getElementById("main")].find(
    (element) =>
      element?.isConnected &&
      element.offsetParent !== null &&
      !element.closest("[inert]") &&
      !element.matches(":disabled"),
  );
  target?.focus({ preventScroll: true });
}
export function Icon({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  return (
    <svg className={`i ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <use href={`/icons.svg#${name}`} />
    </svg>
  );
}
export function KindIcon({ node }: { node: Node }) {
  return (
    <Icon
      name={
        node.kind === "folder"
          ? "folder"
          : node.type === "docs"
            ? "notes"
            : "code"
      }
    />
  );
}
const colors: Record<string, string> = {
  active: "var(--green)",
  idle: "var(--amber)",
  dormant: "var(--faint)",
  archived: "var(--faint)",
  paused: "var(--amber)",
  done: "var(--accent)",
  idea: "var(--purple)",
};
export function StatusGlyph({
  status,
  size = 14,
}: {
  status: string;
  size?: number;
}) {
  const c = colors[status] ?? "var(--faint)";
  return (
    <svg
      className="glyph"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-label={status}
    >
      {status === "done" || status === "archived" ? (
        <>
          <circle cx="7" cy="7" r="6.5" fill={c} />
          <path
            d={status === "done" ? "m4.5 7.2 1.7 1.7 3.3-3.4" : "M4.6 7h4.8"}
            fill="none"
            stroke="var(--bg)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.75"
            fill="none"
            stroke={c}
            strokeWidth="1.5"
            strokeDasharray={
              status === "dormant"
                ? "1.8 2.2"
                : status === "idea"
                  ? "0.6 2.4"
                  : undefined
            }
          />
          {status === "active" ? (
            <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill={c} />
          ) : status === "idle" ? (
            <path d="M7 3.5a3.5 3.5 0 0 1 3.5 3.5H7z" fill={c} />
          ) : status === "paused" ? (
            <path
              d="M5.6 5v4M8.4 5v4"
              stroke={c}
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          ) : null}
        </>
      )}
    </svg>
  );
}
export function PriorityGlyph({ priority }: { priority?: string }) {
  const n =
    ({ low: 1, medium: 2, high: 3 } as Record<string, number>)[
      priority ?? ""
    ] ?? 0;
  return (
    <svg
      className="glyph"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      {n ? (
        [
          [1.5, 8.5, 4],
          [5.75, 5.5, 7],
          [10, 2.5, 10],
        ].map(([x, y, h], i) => (
          <rect
            key={i}
            x={x}
            y={y}
            width="2.5"
            height={h}
            rx="1"
            fill={i < n ? "var(--text)" : "var(--border-strong)"}
          />
        ))
      ) : (
        <g fill="var(--faint)">
          {[3, 7, 11].map((x) => (
            <circle key={x} cx={x} cy="7" r="1.1" />
          ))}
        </g>
      )}
    </svg>
  );
}
export function SeverityGlyph({ severity }: { severity: Severity }) {
  const c =
    severity === "high"
      ? "var(--red)"
      : severity === "med"
        ? "var(--amber)"
        : "var(--faint)";
  return (
    <svg
      className="glyph"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-label={severity}
    >
      {severity === "high" ? (
        <rect x=".5" y=".5" width="13" height="13" rx="3.5" fill={c} />
      ) : (
        <circle
          cx="7"
          cy="7"
          r="5.75"
          fill="none"
          stroke={c}
          strokeWidth="1.5"
        />
      )}
      {severity === "low" ? (
        <circle cx="7" cy="7" r="1.2" fill={c} />
      ) : (
        <>
          <path
            d={severity === "high" ? "M7 3.6v4.1" : "M7 4.3v3.2"}
            stroke={severity === "high" ? "#fff" : c}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle
            cx="7"
            cy={severity === "high" ? "10.1" : "9.6"}
            r=".9"
            fill={severity === "high" ? "#fff" : c}
          />
        </>
      )}
    </svg>
  );
}
export function Time({ at, long = false }: { at?: string; long?: boolean }) {
  return at ? (
    <time dateTime={at} title={new Date(at).toLocaleString("en-GB")}>
      {long ? when(at) : ago(at)}
    </time>
  ) : (
    <>—</>
  );
}
export function FixButton({
  node,
  code,
  className = "",
}: {
  node: Node;
  code: string;
  className?: string;
}) {
  return FIX_LABEL[code] ? (
    <button
      className={`btn sm ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        void openTerminal(node.id, "fix", code);
      }}
    >
      {FIX_LABEL[code]}
    </button>
  ) : null;
}
export function Group({
  title,
  icon,
  count,
  hint,
  order,
  id,
  children,
  right,
}: {
  title: string;
  icon?: string;
  count?: number;
  hint?: string;
  order?: string;
  id?: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="group" id={id}>
      <div className="group-h">
        {icon ? <Icon name={icon} className="sm" /> : null}
        {title}
        {count !== undefined ? <span className="c">{count}</span> : null}
        {hint ? <span className="hint">{hint}</span> : null}
        {order ? <span className="ord">{order}</span> : null}
        {right ? <span className="right">{right}</span> : null}
      </div>
      {children}
    </section>
  );
}
export function Expand({ name, count }: { name: string; count: number }) {
  const expanded = useApp((s) => !!s.expanded[name]);
  return (
    <button className="more" onClick={() => toggleExpanded(name)}>
      {expanded ? "Show fewer" : `Show all ${count}`}
    </button>
  );
}
export function Ops({
  ops,
  optional,
  onHeavy,
}: {
  ops: Op[];
  optional?: boolean;
  onHeavy?: (checked: boolean) => void;
}) {
  return (
    <ul className="ops">
      {ops.map((op, i) => (
        <li key={i} className={`k-${op.kind}`}>
          <Icon name={op.kind} />
          <div className="lab">
            {optional && op.kind === "delete" ? (
              <label>
                <input
                  type="checkbox"
                  className="cb"
                  onChange={(e) => onHeavy?.(e.target.checked)}
                />
                {op.label}
              </label>
            ) : (
              op.label
            )}
          </div>
          {op.from || op.to ? (
            <div className="ft">
              {op.from}
              {op.from && op.to ? <span className="arr">→</span> : null}
              {op.to}
            </div>
          ) : null}
          {op.detail ? <div className="det">{op.detail}</div> : null}
        </li>
      ))}
    </ul>
  );
}
