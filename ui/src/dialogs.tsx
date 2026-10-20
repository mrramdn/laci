import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { api, errorText } from "./api";
import { useApp, changed, run, selectWhenReady } from "./store";
import {
  base,
  bytes,
  expandHome,
  isAbsolutePath,
  joinPath,
  parentOf,
  plural,
  tilde,
} from "./helpers";
import { ChooseFolder } from "./pick";
import { detailedList } from "./shortcuts";
import { Icon, Ops, restoreFocus, SeverityGlyph } from "./common";
import { useConfigPath } from "./settings";
import { closeTerminal, useTerms } from "./terminal-api";
import { AgentDialog, DeleteSessions, SessionDialog } from "./session-ui";
import { McpDialog } from "./mcp-setup";
import { Select, SelectPortal, selectIsOpen } from "./select";
import type { ArchivePlan, Change, DeletePlan, Link } from "./types";
import { detailedSettings as said } from "./words";
const NewProject = lazy(() =>
  import("./new-project").then((module) => ({ default: module.NewProject })),
);
const HelpDialog = lazy(() =>
  import("./help").then((module) => ({ default: module.HelpDialog })),
);
function close() {
  useApp.setState({ modal: null });
}
/** The system's bin written for the sentences around it. */
const BIN = {
  name: "System Trash",
  bare: "system Trash",
  your: "your system Trash",
  the: "the system Trash",
  short: "Trash",
};
function dialogControls(host: HTMLElement | null) {
  return Array.from(
    host?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
    ) ?? [],
  ).filter(
    (element) =>
      element.offsetParent !== null &&
      !element.matches(
        '[type="hidden"], [tabindex="-1"], [aria-hidden="true"]',
      ) &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}
export function DialogFrame({
  title,
  description,
  children,
  footer,
  form,
  onSubmit,
  preserveDraft = form,
  dismissible = true,
  onDismiss = close,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  form?: boolean;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  preserveDraft?: boolean;
  dismissible?: boolean;
  onDismiss?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const [discard, setDiscard] = useState(false);
  const draftFocus = useRef<HTMLElement | null>(null);
  const previous = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useLayoutEffect(() => {
    const items = dialogControls(ref.current);
    const first =
      items.find(
        (element) => !element.matches("input[type=checkbox],input[type=radio]"),
      ) ?? items[0];
    (first ?? ref.current?.querySelector<HTMLElement>(".dialog"))?.focus();
  }, [title, form]);
  useLayoutEffect(() => {
    if (discard)
      ref.current?.querySelector<HTMLElement>("[data-keep-draft]")?.focus();
  }, [discard]);
  useEffect(() => {
    const before = previous.current;
    return () => restoreFocus(before);
  }, []);
  useEffect(() => {
    const host = ref.current;
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || selectIsOpen() || useApp.getState().palette)
        return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!useApp.getState().working && dismissible) {
          if (preserveDraft) {
            if (!discard && document.activeElement instanceof HTMLElement)
              draftFocus.current = document.activeElement;
            if (discard) restoreFocus(draftFocus.current);
            setDiscard(!discard);
          } else onDismiss();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const items = dialogControls(host);
      if (!items.length) {
        e.preventDefault();
        host?.querySelector<HTMLElement>(".dialog")?.focus();
        return;
      }
      const first = items[0],
        last = items.at(-1)!;
      if (!host?.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
    };
  }, [preserveDraft, discard, dismissible, onDismiss]);
  const body = (
    <>
      <div className="dh">
        <h2 id="dialog-title">{title}</h2>
        <p className="desc">{description}</p>
      </div>
      <SelectPortal.Provider value={portal}>
        <div className="db">{children}</div>
        <div className="df">
          {discard ? (
            <>
              <p role="status">Keep editing or discard this draft?</p>
              <button
                type="button"
                className="btn primary"
                data-keep-draft=""
                onClick={() => {
                  setDiscard(false);
                  restoreFocus(draftFocus.current);
                }}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="btn"
                disabled={!dismissible}
                onClick={onDismiss}
              >
                Discard draft
              </button>
            </>
          ) : (
            footer
          )}
        </div>
        <div ref={setPortal} className="select-portal" />
      </SelectPortal.Provider>
    </>
  );
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (
          e.target === e.currentTarget &&
          !useApp.getState().working &&
          dismissible &&
          !selectIsOpen()
        ) {
          if (preserveDraft) {
            if (document.activeElement instanceof HTMLElement)
              draftFocus.current = document.activeElement;
            setDiscard(true);
          } else onDismiss();
        }
      }}
      ref={ref}
    >
      {form ? (
        <form
          className="dialog cform"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
          tabIndex={-1}
          onSubmit={onSubmit}
        >
          {body}
        </form>
      ) : (
        <div
          className="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
          tabIndex={-1}
        >
          {body}
        </div>
      )}
    </div>
  );
}
export function Dialogs() {
  const modal = useApp((s) => s.modal);
  const design = useApp((s) => s.design);
  // Simple draws its own Archive, Delete and Free up space sheets (simple/dialogs.tsx).
  if (
    design === "simple" &&
    (modal?.kind === "archive" ||
      modal?.kind === "delete" ||
      modal?.kind === "clean")
  )
    return null;
  return modal?.kind === "shortcuts" ? (
    <Shortcuts />
  ) : modal?.kind === "help" ? (
    <Suspense fallback={null}>
      <HelpDialog />
    </Suspense>
  ) : modal?.kind === "archive" ? (
    <Archive key={modal.id} id={modal.id} />
  ) : modal?.kind === "delete" ? (
    <DeleteProject key={modal.id} id={modal.id} />
  ) : modal?.kind === "clean" ? (
    <CleanProject key={modal.id} id={modal.id} />
  ) : modal?.kind === "new" ? (
    <Suspense
      fallback={
        <DialogFrame
          title="New project"
          description="Loading the form…"
          dismissible={!modal.job}
          footer={
            <button className="btn" disabled={!!modal.job} onClick={close}>
              Cancel
            </button>
          }
        >
          <p role="status">Loading…</p>
        </DialogFrame>
      }
    >
      <NewProject key={modal.job?.id ?? "draft"} restored={modal.job} />
    </Suspense>
  ) : modal?.kind === "connector" ? (
    <ConnectorDialog />
  ) : modal?.kind === "terminal-close" ? (
    <TerminalClose id={modal.id} />
  ) : modal?.kind === "orphan" ? (
    <OrphanHistory key={modal.id} id={modal.id} />
  ) : modal?.kind === "agent" ? (
    <AgentDialog
      key={`${modal.provider}:${modal.sessionId}:${modal.projectPath}`}
      request={modal}
    />
  ) : modal?.kind === "session" ? (
    <SessionDialog
      key={`${modal.provider}:${modal.sessionId}`}
      request={modal}
    />
  ) : modal?.kind === "session-delete" ? (
    <DeleteSessions key={modal.files.join("\n")} files={modal.files} />
  ) : modal?.kind === "mcp" ? (
    <McpDialog key={modal.provider} provider={modal.provider} />
  ) : null;
}
function OrphanHistory({ id }: { id: string }) {
  const s = useApp();
  const [proposal] = useState(() =>
    s.snapshot?.proposals.find((item) => item.id === id),
  );
  const [recovery, setRecovery] = useState("quarantine");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!proposal) return null;
  const paths =
    proposal.action?.type === "quarantine"
      ? proposal.action.moves.map((move) => move.from)
      : [];
  async function apply() {
    await run(
      async () => {
        setSaving(true);
        setError("");
        try {
          const result = await api<Change>("apply", { id, recovery });
          changed(
            result,
            recovery === "trash"
              ? "Moved history to Trash"
              : "History quarantined",
          );
          close();
        } finally {
          setSaving(false);
        }
      },
      recovery === "trash"
        ? "Moving history to Trash…"
        : "Quarantining history…",
      {
        history: true,
        onError: (error) => setError(errorText(error)),
      },
    );
  }
  return (
    <DialogFrame
      title="Review orphan history"
      description="Only the listed agent history moves. Project contents stay where they are. Laci checks the source and project location again before continuing."
      footer={
        <>
          <p className={error ? "err" : ""} role={error ? "alert" : undefined}>
            {error ||
              (recovery === "trash"
                ? `Restore history through ${BIN.bare}. Laci Undo will not be available.`
                : "Laci Undo restores quarantined history to its original location.")}
          </p>
          <button className="btn" disabled={saving} onClick={close}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={saving || s.historyPending || !paths.length}
            onClick={() => void apply()}
          >
            {saving
              ? "Moving…"
              : recovery === "trash"
                ? "Move history to Trash"
                : "Quarantine history"}
          </button>
        </>
      }
    >
      <p>{proposal.why}</p>
      <ul className="history-paths">
        {paths.map((path) => (
          <li className="mono" key={path}>
            {path}
          </li>
        ))}
      </ul>
      <div className="choices" role="radiogroup" aria-label="History recovery">
        {[
          [
            "quarantine",
            "Quarantine",
            "Keep a Laci journal for exact restoration.",
          ],
          ["trash", BIN.name, `Restore manually through ${BIN.your}.`],
        ].map(([value, label, detail]) => (
          <label className="choice" key={value}>
            <input
              type="radio"
              name="recovery"
              value={value}
              checked={recovery === value}
              disabled={saving}
              onChange={() => setRecovery(value)}
            />
            <div>
              <b>{label}</b>
              <p>{detail}</p>
            </div>
          </label>
        ))}
      </div>
    </DialogFrame>
  );
}
function TerminalClose({ id }: { id: string }) {
  const terminal = useTerms((s) => s.tabs.find((tab) => tab.id === id));
  const present = Boolean(terminal);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const modal = useApp.getState().modal;
    if (!present && modal?.kind === "terminal-close" && modal.id === id)
      close();
  }, [present, id]);
  if (!terminal) return null;
  async function confirm() {
    setSaving(true);
    if (await closeTerminal(id)) {
      const modal = useApp.getState().modal;
      if (modal?.kind === "terminal-close" && modal.id === id) close();
    }
    setSaving(false);
  }
  return (
    <DialogFrame
      title={`Close terminal ${terminal.title}?`}
      description="Closing this terminal ends its shell and any programs running in it. Cancel, then use F4 to hide it and keep the session running."
      footer={
        <>
          <p>Terminal output will be discarded.</p>
          <button className="btn" disabled={saving} onClick={close}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={saving}
            onClick={() => void confirm()}
          >
            Close terminal
          </button>
        </>
      }
    >
      {null}
    </DialogFrame>
  );
}
function Shortcuts() {
  return (
    <DialogFrame
      title="Keyboard shortcuts"
      description="Quick navigation and handy power actions."
      footer={
        <>
          <span className="grow" />
          <button className="btn primary" onClick={close}>
            Got it
          </button>
        </>
      }
    >
      <ShortcutGrid />
    </DialogFrame>
  );
}
const SHORTCUTS = detailedList();
/** Detailed's keys in its two sections, for its Keyboard shortcuts dialog and its Help. */
export function ShortcutGrid() {
  return (
    <div className="short-grid">
      {SHORTCUTS.map(([title, rows]) => (
        <div className="short-sec" key={title}>
          <h3>{title}</h3>
          {rows.map(([label, keys]) => (
            <div className="short-row" key={label}>
              <span>{label}</span>
              <div className="short-keys">
                {keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
function Archive({ id }: { id: string }) {
  const s = useApp();
  const n = s.snapshot!.nodes[id];
  const home = s.snapshot!.home;
  const [destination, setDestination] = useState(n?.archivePlan?.dest ?? "");
  const [review, setReview] = useState<{
    destination: string;
    plan?: ArchivePlan;
    error?: string;
  } | null>(null);
  const [heavy, setHeavy] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const current = review?.destination === destination ? review : null;
  const plan = current?.plan && !current.plan.error ? current.plan : undefined;
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      const path = expandHome(destination.trim(), home);
      if (path && !isAbsolutePath(path)) {
        setReview({
          destination,
          error: "Use a full destination path like ~/archive/my-project",
        });
        return;
      }
      void api<ArchivePlan>("archive/plan", {
        id,
        ...(path ? { destination: path } : {}),
      }).then(
        (plan) => live && setReview({ destination, plan, error: plan.error }),
        (error) => live && setReview({ destination, error: errorText(error) }),
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [id, destination, home]);
  if (!n) return null;
  // The destination is the project's own new folder, which isn't there yet: the picker opens in the
  // folder above it.
  const typed = expandHome(destination.trim(), home);
  const pickFrom = isAbsolutePath(typed) ? parentOf(typed) : "~";
  async function archive() {
    if (!plan) return;
    await run(
      async () => {
        setSaving(true);
        setError("");
        const modal = useApp.getState().modal;
        try {
          const change = await api<Change>("archive", {
            id,
            destination: plan.dest,
            trashHeavy: heavy,
          });
          if (useApp.getState().modal === modal) close();
          changed(change, `Archived ${n.name}`);
          selectWhenReady(plan.dest);
        } finally {
          setSaving(false);
        }
      },
      `Archiving ${n.name}…`,
      {
        history: true,
        onError: (error) => setError(errorText(error)),
      },
    );
  }
  return (
    <DialogFrame
      title={`Archive ${n.name}?`}
      description={
        <>
          Moves the project and takes its agent history along, so sessions and
          memory still open from the new place.
        </>
      }
      footer={
        <>
          {error || current?.error ? (
            <p className="err" role="alert">
              {error || current?.error}
            </p>
          ) : (
            <p>
              {heavy
                ? "Written to an undo journal first. Undo puts the folder and its history back; deleted dependencies and build output come back with the next install or build."
                : "Written to an undo journal first. Undo puts the folder and its history back."}
            </p>
          )}
          <button className="btn" disabled={saving} onClick={close}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={saving || s.historyPending || !plan}
            onClick={() => void archive()}
          >
            {saving ? "Archiving…" : "Archive"}
          </button>
        </>
      }
    >
      <label className="fld">
        <span>Destination</span>
        <div className="addrow">
          <input
            className="inp mono"
            value={destination}
            disabled={saving}
            onChange={(e) => {
              setDestination(e.target.value);
              setHeavy(false);
              setError("");
            }}
            autoComplete="off"
            aria-label="Archive destination"
            placeholder={
              n.archivePlan?.error
                ? "Choose another destination…"
                : "Default archive destination"
            }
          />
          {/* The folder chosen takes the project inside, under its own name. */}
          <ChooseFolder
            label={said.choose}
            name={said.destinationTitle(n.name)}
            title={said.destinationTitle(n.name)}
            defaultPath={pickFrom}
            disabled={saving}
            onPick={(path) => {
              setDestination(joinPath(path, base(n.path)));
              setHeavy(false);
              setError("");
            }}
          />
        </div>
        <small>The full project folder path, including its name.</small>
      </label>
      {n.archivePlan?.error ? (
        <p className="err">Default destination: {n.archivePlan.error}</p>
      ) : null}
      {!current ? <p role="status">Checking destination…</p> : null}
      {plan?.checks.length ? (
        <div className="warnbox">
          {plan.checks.map((check, i) => (
            <div className="issue" key={i}>
              <SeverityGlyph severity={check.severity} />
              <div className="txt">
                <p>{check.title}</p>
                <p className="d">
                  {[
                    check.detail,
                    ["no-remote", "no-commits"].includes(check.code)
                      ? "Archiving keeps it on this disk only"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(". ")}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {plan ? (
        <>
          <div className="sec-t">{plural(plan.ops.length, "change")}</div>
          <Ops key={plan.dest} ops={plan.ops} optional onHeavy={setHeavy} />
        </>
      ) : null}
    </DialogFrame>
  );
}
function CleanProject({ id }: { id: string }) {
  const s = useApp();
  const n = s.snapshot!.nodes[id];
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  if (!n?.size) return null;
  const parts = n.size.parts;
  async function clean() {
    await run(
      async () => {
        setSaving(true);
        setError("");
        const modal = useApp.getState().modal;
        try {
          const change = await api<Change>("clean", { id });
          if (useApp.getState().modal === modal) close();
          changed(change, `Deleted the build output of ${n.name}`);
        } finally {
          setSaving(false);
        }
      },
      `Deleting build output of ${n.name}…`,
      { history: true, onError: (e) => setError(errorText(e)) },
    );
  }
  return (
    <DialogFrame
      title={`Delete the build output of ${n.name}?`}
      description={
        <>
          Deletes {parts.map((p) => p.path).join(", ")} for good, freeing{" "}
          {bytes(n.size!.reclaimable)}. The next install or build brings them
          back. They don't go to the {BIN.short}, which would keep the space taken.
        </>
      }
      footer={
        <>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn" disabled={saving} onClick={close}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={saving || s.historyPending}
            onClick={() => void clean()}
          >
            {saving ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      <ul className="hlist">
        {parts.map((p) => (
          <li key={p.path}>
            <span className="mono nm">{p.path}</span>
            <span className="faint w">{bytes(p.bytes)}</span>
          </li>
        ))}
      </ul>
    </DialogFrame>
  );
}
function DeleteProject({ id }: { id: string }) {
  const s = useApp();
  const n = s.snapshot!.nodes[id];
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void api<DeletePlan>("delete/plan", { id }).then(
      (plan) => live && setPlan(plan),
      (error) => live && setError(errorText(error)),
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);
  if (!n) return null;
  async function remove() {
    if (!plan?.allowed) return;
    await run(
      async () => {
        setSaving(true);
        setError("");
        const modal = useApp.getState().modal;
        try {
          const change = await api<Change>("delete", { id, confirm: true });
          if (useApp.getState().modal === modal) close();
          changed(change, `Moved ${n.name} to Trash`);
          if (useApp.getState().selected === id)
            useApp.setState({ selected: null, pendingSelection: null });
        } finally {
          setSaving(false);
        }
      },
      `Moving ${n.name} to Trash…`,
      {
        history: true,
        onError: (error) => {
          setPlan(null);
          setError(errorText(error));
        },
      },
    );
  }
  return (
    <DialogFrame
      title={`Move ${n.name} to Trash?`}
      description={
        <>
          Moves <span className="mono">{tilde(n.path, s.snapshot!.home)}</span>{" "}
          to {BIN.the} after checking its Git backup. Agent history stored
          outside this project stays where it is.
        </>
      }
      footer={
        <>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : (
            <p>Restore the folder from {BIN.your} if you need it back.</p>
          )}
          <button className="btn" disabled={saving} onClick={close}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={
              saving || s.historyPending || !plan?.allowed || Boolean(error)
            }
            onClick={() => void remove()}
          >
            {saving ? "Moving…" : "Move to Trash"}
          </button>
        </>
      }
    >
      {!plan && !error ? (
        <p role="status">Checking Git and remote backup…</p>
      ) : null}
      {plan?.checks.length ? (
        <div className="warnbox">
          {plan.checks.map((check, i) => (
            <div className="issue" key={i}>
              <SeverityGlyph severity={check.severity} />
              <div className="txt">
                <p>{check.title}</p>
                {check.detail ? <p className="d">{check.detail}</p> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {plan ? <Ops ops={plan.ops} /> : null}
      {error || (plan && !plan.allowed) ? (
        <button
          className="btn sm"
          disabled={saving || s.historyPending}
          onClick={() => {
            setPlan(null);
            setError("");
            setAttempt((value) => value + 1);
          }}
        >
          Check again
        </button>
      ) : null}
    </DialogFrame>
  );
}
const KINDS: [Link["kind"], string][] = [
  ["cwd", "Each log file records its project folder"],
  ["named", "One folder per project, named after the path"],
  ["inside", "It lives inside the project folder"],
  ["mentions", "Its files mention project paths"],
  ["none", "It keeps no history Laci can read"],
];
function ConnectorDialog() {
  const s = useApp();
  const configPath = useConfigPath();
  const [kind, setKind] = useState<Link["kind"]>("cwd");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  // Opening the form puts the caret in its first field, so typing can start at once.
  useEffect(() => {
    if (open) name.current?.focus();
  }, [open]);
  async function add(body: Record<string, unknown>) {
    await run(
      async () => {
        setSaving(true);
        setError("");
        const modal = useApp.getState().modal;
        const label =
          typeof body.name === "string"
            ? body.name
            : (s.snapshot?.suggestions.find((c) => c.id === body.preset)
                ?.name ?? "connector");
        try {
          const change = await api<Change>("connector/add", body);
          changed(change, `Added ${label}`);
          if (useApp.getState().modal === modal) close();
        } finally {
          setSaving(false);
        }
      },
      "Adding connector…",
      {
        history: true,
        onError: (error) => setError(errorText(error)),
      },
    );
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const text = (key: string) => String(fields[key] ?? "");
    const link: Link | undefined =
      kind === "none"
        ? undefined
        : kind === "cwd"
          ? { kind, dir: text("dir"), ext: text("ext"), field: text("field") }
          : kind === "named"
            ? {
                kind,
                dir: text("dir"),
                naming: text("naming") as "dashes" | "sha256",
              }
            : kind === "inside"
              ? { kind, path: text("path") }
              : { kind, dir: text("dir"), ext: text("ext") };
    const agent: Record<string, unknown> = {};
    for (const key of [
      "command",
      "prompt",
      "continue",
      "model",
      "models",
      "effort",
      "efforts",
    ]) {
      const value = text(key).trim();
      if (value) agent[key] = value;
    }
    const mcpFile = text("mcpFile").trim();
    if (mcpFile) agent.mcp = { file: mcpFile };
    void add({
      name: text("name").trim(),
      ...(link ? { link } : {}),
      ...(agent.command ? { agent } : {}),
    });
  }
  const suggestions = [...s.snapshot!.suggestions].sort(
    (a, b) => Number(b.found) - Number(a.found),
  );
  return (
    <DialogFrame
      title="Add another AI tool"
      description="Pick a tool Laci knows, or describe your own. Laci shows its history on each project, carries it along when you move or archive one, and can start it for you."
      form
      onSubmit={submit}
      footer={
        <>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : (
            <p>Saved in {configPath}</p>
          )}
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={close}
          >
            Cancel
          </button>
          {open ? (
            <button
              className="btn primary"
              disabled={saving || s.historyPending}
            >
              Add tool
            </button>
          ) : null}
        </>
      }
    >
      {suggestions.length ? (
        <div className="tool-rows">
          {suggestions.map((suggestion) => (
            <div className="tool-row" key={suggestion.id}>
              <Icon name="bot" />
              <div className="txt">
                <b>{suggestion.name}</b>
                <p>
                  {suggestion.about}
                  {suggestion.found ? (
                    <>
                      {" · "}
                      <span className="found">
                        found on this PC
                        {suggestion.detail ? ` · ${suggestion.detail}` : ""}
                      </span>
                    </>
                  ) : null}
                </p>
              </div>
              <button
                type="button"
                className="btn sm"
                aria-label={`Connect ${suggestion.name}`}
                disabled={saving || s.historyPending}
                onClick={() => void add({ preset: suggestion.id })}
              >
                Connect
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">Every tool Laci knows is already connected.</p>
      )}
      <details
        className="more-fields"
        open={open}
        onToggle={(event) => {
          setOpen(event.currentTarget.open);
        }}
      >
        <summary>Something else</summary>
        <label className="fld">
          <span>Name</span>
          <input
            ref={name}
            className="inp"
            name="name"
            placeholder="OpenCode, Cursor, my own tool…"
            autoComplete="off"
            required={open}
            maxLength={40}
          />
        </label>
        <div className="fld">
          <span>How Laci finds the project</span>
          <Select
            label="How Laci finds the project"
            value={kind}
            options={KINDS.map(([value, label]) => ({ value, label }))}
            onValueChange={(value) => setKind(value as Link["kind"])}
          />
        </div>
        <div key={kind}>
          {kind === "none" ? null : kind === "cwd" ? (
            <>
              <label className="fld">
                <span>Where it keeps its history</span>
                <input
                  className="inp mono"
                  name="dir"
                  placeholder="~/.tool/sessions"
                  required={open}
                />
                <small>Searched with every subfolder.</small>
              </label>
              <details className="advanced">
                <summary>Advanced</summary>
                <div className="row2">
                  <label className="fld">
                    <span>File type</span>
                    <input
                      className="inp mono"
                      name="ext"
                      defaultValue=".jsonl"
                      required={open}
                    />
                  </label>
                  <label className="fld">
                    <span>Field that holds the folder</span>
                    <input
                      className="inp mono"
                      name="field"
                      defaultValue="cwd"
                      required={open}
                    />
                  </label>
                </div>
              </details>
            </>
          ) : kind === "named" ? (
            <>
              <label className="fld">
                <span>Where it keeps its history</span>
                <input
                  className="inp mono"
                  name="dir"
                  placeholder="~/.tool/projects"
                  required={open}
                />
                <small>The folder that holds one folder per project.</small>
              </label>
              <label className="fld">
                <span>How the folders are named</span>
                <Select
                  label="How the folders are named"
                  name="naming"
                  defaultValue="dashes"
                  options={[
                    {
                      value: "dashes",
                      label: "Path with dashes: -home-me-project-app",
                    },
                    { value: "sha256", label: "SHA-256 hash of the path" },
                  ]}
                />
              </label>
            </>
          ) : kind === "inside" ? (
            <label className="fld">
              <span>Where it keeps its history</span>
              <input
                className="inp mono"
                name="path"
                placeholder=".tool/history"
                required={open}
              />
              <small>
                A file or a folder inside each project. It already moves with
                the project; Laci shows it on the project.
              </small>
            </label>
          ) : (
            <>
              <label className="fld">
                <span>Where it keeps its history</span>
                <input
                  className="inp mono"
                  name="dir"
                  placeholder="~/.tool/plans"
                  required={open}
                />
              </label>
              <details className="advanced">
                <summary>Advanced</summary>
                <label className="fld">
                  <span>File type</span>
                  <input
                    className="inp mono"
                    name="ext"
                    defaultValue=".md"
                    required={open}
                  />
                </label>
              </details>
            </>
          )}
        </div>
        <div className="sec-t">Start it from Laci</div>
        <label className="fld">
          <span>Command</span>
          <input
            className="inp mono"
            name="command"
            placeholder="aider"
            autoComplete="off"
            spellCheck={false}
            required={open && kind === "none"}
            maxLength={40}
          />
          <small>
            {kind === "none"
              ? "The program's name, as you would type it in a terminal."
              : "The program's name, as you would type it in a terminal. Leave empty if Laci should only show this tool's history."}
          </small>
        </label>
        <details className="advanced">
          <summary>Arguments</summary>
          <label className="fld">
            <span>First prompt</span>
            <input
              className="inp mono"
              name="prompt"
              placeholder="--message {prompt}"
              autoComplete="off"
              spellCheck={false}
            />
            <small>{"{prompt}"} stands for the text you type in Laci.</small>
          </label>
          <label className="fld">
            <span>Continue the last conversation</span>
            <input
              className="inp mono"
              name="continue"
              placeholder="--continue"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="row2">
            <label className="fld">
              <span>Model</span>
              <input
                className="inp mono"
                name="model"
                placeholder="--model {model}"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="fld">
              <span>Models</span>
              <input
                className="inp mono"
                name="models"
                placeholder="sonnet, opus"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="row2">
            <label className="fld">
              <span>Effort</span>
              <input
                className="inp mono"
                name="effort"
                placeholder="--effort {effort}"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="fld">
              <span>Effort levels</span>
              <input
                className="inp mono"
                name="efforts"
                placeholder="low, medium, high"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <label className="fld">
            <span>MCP settings file</span>
            <input
              className="inp mono"
              name="mcpFile"
              placeholder="~/.tool/mcp.json"
              autoComplete="off"
              spellCheck={false}
            />
            <small>
              A JSON file with an mcpServers table. Laci can then add its own
              MCP server there from the Agents page.
            </small>
          </label>
        </details>
      </details>
    </DialogFrame>
  );
}
