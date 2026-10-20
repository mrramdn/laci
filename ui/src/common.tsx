import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, errorText } from "./api";
import { ago, when, FIX_LABEL, LOCALE, SECRET_FIXES } from "./helpers";
import { useApp, changed, run, toggleExpanded } from "./store";
import { useNow } from "./clock";
import type { Change, Node, Op, Severity } from "./types";
import { openTerminal } from "./terminal-api";
import { DialogFrame } from "./dialogs";
import { detailedData } from "./words";
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
  useNow();
  return at ? (
    <time dateTime={at} title={new Date(at).toLocaleString(LOCALE)}>
      {long ? when(at) : ago(at)}
    </time>
  ) : (
    <>—</>
  );
}
/** What `secrets/check` answers: the files in a project that look like secrets, by name only. */
interface SecretCheck {
  files: { path: string; tracked: boolean }[];
  more: number;
}
/** What a look for secret files found, or why it found nothing. */
type Looked = { found: SecretCheck } | { error: string };
const lookForSecrets = (id: string): Promise<Looked> =>
  api<SecretCheck>("secrets/check", { id }).then(
    (found) => ({ found }),
    (error) => ({ error: errorText(error) }),
  );
/** Nothing looks like a secret: the fix goes ahead. */
const nothingFound = (looked: Looked) =>
  "found" in looked && !looked.found.files.length;
/**
 * The button that fixes a check in the terminal. Before a fix that saves or uploads versions it
 * looks for files that look like passwords or keys, as Simple's fix sheet does, and asks first when
 * some turn up. The terminal only types the command; Enter there runs it.
 */
export function FixButton({
  node,
  code,
  className = "",
}: {
  node: Node;
  code: string;
  className?: string;
}) {
  const [looking, setLooking] = useState(false);
  /** The fix that waits for an answer, and what the look found. */
  const [asking, setAsking] = useState<{ code: string; looked: Looked }>();
  // Another click while the look runs adds nothing.
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!FIX_LABEL[code]) return null;
  const fix = (what: string) => void openTerminal(node.id, "fix", what);
  const click = async () => {
    if (busy.current) return;
    if (!SECRET_FIXES.has(code)) return fix(code);
    busy.current = true;
    setLooking(true);
    const looked = await lookForSecrets(node.id);
    busy.current = false;
    if (!mounted.current) return;
    setLooking(false);
    if (nothingFound(looked)) fix(code);
    else setAsking({ code, looked });
  };
  return (
    <>
      <button
        className={`btn sm ${className}`}
        aria-busy={looking || undefined}
        title={looking ? detailedData.secrets.checking : undefined}
        onClick={(e) => {
          e.stopPropagation();
          void click();
        }}
      >
        {looking ? <span className="spin sm" /> : null}
        {FIX_LABEL[code]}
      </button>
      {asking
        ? createPortal(
            <SecretsFound
              node={node}
              code={asking.code}
              looked={asking.looked}
              onClose={() => setAsking(undefined)}
              onFix={() => {
                setAsking(undefined);
                fix(asking.code);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}
/** The files a group lists by name before it says how many more there are. */
const SHOWN = 6;
/**
 * Asks before a fix when files look like passwords or keys: "Keep these out" adds the ones Git
 * doesn't track yet to .gitignore, with Undo, and goes on; Continue always goes on as it is.
 */
function SecretsFound({
  node,
  code,
  looked: first,
  onClose,
  onFix,
}: {
  node: Node;
  code: string;
  looked: Looked;
  onClose: () => void;
  onFix: () => void;
}) {
  const said = detailedData.secrets;
  const historyPending = useApp((s) => s.historyPending);
  const [looked, setLooked] = useState<Looked>(first);
  /** Laci looks again after a look that failed. */
  const [looking, setLooking] = useState(false);
  // Another click on Check again while it looks adds nothing.
  const busy = useRef(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const previous = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(() => {
    mounted.current = true;
    // Drawn over the window rather than as the store's dialog, as Simple's sheets are: the window is
    // inert, and its keys and the toast wait, while it is open.
    useApp.setState((s) => ({ sheets: s.sheets + 1 }));
    const before = previous.current;
    return () => {
      mounted.current = false;
      useApp.setState((s) => ({ sheets: s.sheets - 1 }));
      // The window stays inert until it draws again without this dialog, so the frame can't give
      // the focus back as it closes. It goes back once the window has drawn.
      setTimeout(() => {
        if (!mounted.current) restoreFocus(before);
      });
    };
  }, []);
  // A button that goes with the answer it was for takes the focus with it to the page: Check again
  // once files turn up, or Keep these out when files stay that it can't keep out. The focus comes
  // back to the dialog's first control, where the dialog put it when it opened.
  useLayoutEffect(() => {
    const host = box.current;
    if (!host || host.contains(document.activeElement)) return;
    host.querySelectorAll<HTMLElement>("button:not(:disabled)")[0]?.focus();
  }, [looked]);
  const found = "found" in looked ? looked.found : undefined;
  const loose = found?.files.filter((file) => !file.tracked) ?? [];
  const tracked = found?.files.filter((file) => file.tracked) ?? [];
  const lookAgain = async () => {
    if (busy.current) return;
    busy.current = true;
    setLooking(true);
    const again = await lookForSecrets(node.id);
    busy.current = false;
    if (!mounted.current) return;
    setLooking(false);
    // Nothing to ask about now: the fix goes on, as it does when the first look finds nothing.
    if (nothingFound(again)) onFix();
    else setLooked(again);
  };
  const keepOut = async () => {
    setError("");
    const files = loose.map((file) => file.path);
    const again = await run(
      async () => {
        const change = await api<Change>("secrets/keep-out", {
          id: node.id,
          files,
        });
        changed(change, said.keptOut, files.join(", "));
        return lookForSecrets(node.id);
      },
      said.keeping,
      { history: true, onError: (error) => setError(errorText(error)) },
    );
    if (!again || !mounted.current) return;
    if (nothingFound(again)) onFix();
    else setLooked(again);
  };
  const group = (
    severity: Severity,
    title: string,
    files: { path: string }[],
    more: number,
    note = "",
  ) => (
    <div className="issue">
      <SeverityGlyph severity={severity} />
      <div className="txt">
        <p>{title}</p>
        {files.slice(0, SHOWN).map((file) => (
          <p className="d mono" key={file.path}>
            {file.path}
          </p>
        ))}
        {files.length > SHOWN || more ? (
          <p className="d">
            {said.more(Math.max(0, files.length - SHOWN) + more)}
          </p>
        ) : null}
        {note ? <p className="d">{note}</p> : null}
      </div>
    </div>
  );
  return (
    // Its clicks and keys stay out of the row behind it, and out of Detailed's keys for lists and
    // folders. Escape and Tab go on to the dialog's frame.
    <div
      ref={box}
      style={{ display: "contents" }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Escape" && event.key !== "Tab")
          event.stopPropagation();
      }}
    >
      <DialogFrame
        title={
          found ? said.title(node.label) : said.checkTitle(node.label)
        }
        description={said.intro(FIX_LABEL[code])}
        onDismiss={onClose}
        footer={
          <>
            {error ? (
              <p className="err" role="alert">
                {error}
              </p>
            ) : (
              <span className="grow" />
            )}
            <button className="btn" onClick={onClose}>
              {said.cancel}
            </button>
            <button className="btn" onClick={onFix}>
              {said.goOn}
            </button>
            {loose.length ? (
              <button
                className="btn primary"
                disabled={historyPending}
                onClick={() => void keepOut()}
              >
                {said.keepOut}
              </button>
            ) : null}
          </>
        }
      >
        {!found ? (
          <>
            {looking ? (
              <p role="status">{said.checking}</p>
            ) : (
              <div className="warnbox">
                <div className="issue">
                  <SeverityGlyph severity="med" />
                  <div className="txt">
                    <p>{said.failed}</p>
                    {"error" in looked ? (
                      <p className="d">{looked.error}</p>
                    ) : null}
                    <p className="d">{said.goOnFailed}</p>
                  </div>
                </div>
              </div>
            )}
            {/* It stays while Laci looks, so the focus stays on it. */}
            <button
              className="btn sm"
              aria-busy={looking || undefined}
              onClick={() => void lookAgain()}
            >
              {said.checkAgain}
            </button>
          </>
        ) : (
          <div className="warnbox">
            {loose.length
              ? group("med", said.loose, loose, found.more, said.keepNote)
              : null}
            {tracked.length
              ? group(
                  "high",
                  said.tracked,
                  tracked,
                  loose.length ? 0 : found.more,
                  said.trackedNote,
                )
              : null}
          </div>
        )}
      </DialogFrame>
    </div>
  );
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
/** `text` with the words of `query` marked. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return <>{text}</>;
  const regex = new RegExp(`(${terms.join("|")})`, "gi");
  return (
    <>
      {text.split(regex).map((part, i) =>
        i % 2 ? (
          <span className="hl" key={i}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
