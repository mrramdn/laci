import { useState } from "react";
import { api, errorText } from "./api";
import {
  agentDraft,
  agentProviders,
  AgentFields,
  launchAgent,
} from "./agent-launch";
import { DialogFrame } from "./dialogs";
import { Icon, Time } from "./common";
import { useNow } from "./clock";
import {
  allSessions,
  bytes,
  conversationIds,
  conversationKey,
  conversations,
  deletable,
  duration,
  plural,
  providerName,
  reportsOfSessions,
  sessionKey,
  sessionsOf,
  tilde,
} from "./helpers";
import type { Conversation, SessionGroup } from "./helpers";
import { changed, goToProject, run, toast, urlOpen, useApp } from "./store";
import type { Modal } from "./store";
import type { Change, Node, Session } from "./types";

export function requestResume(session: Session, projectPath?: string) {
  if (session.resumeCapability !== "supported" || !(projectPath ?? session.cwd))
    return;
  useApp.setState({
    modal: {
      kind: "agent",
      provider: session.provider,
      sessionId: session.sessionId,
      projectPath: projectPath ?? session.cwd!,
    },
  });
}

export function restoreSession(session: Session) {
  void run(
    async () => {
      changed(
        await api<Change>("backup/restore", { id: session.id }),
        "Session restored",
        session.title,
      );
    },
    "Restoring session…",
    { history: true },
  );
}

export interface Selection {
  has: (c: Conversation) => boolean;
  toggle: (c: Conversation) => void;
}
/** Sessions of one place, as conversations: newest first, short chats folded into one row. */
export function SessionList({
  sessions,
  projectPath,
  limit,
  projectOf,
}: {
  sessions: Session[];
  projectPath?: string;
  limit?: number;
  /** Lists that mix projects: shows each session's project. */
  projectOf?: (session: Session) => Node | undefined;
}) {
  return (
    <ConversationRows
      items={conversations(sessions)}
      projectPath={projectPath}
      limit={limit}
      projectOf={projectOf}
      fold
    />
  );
}
export function ConversationRows({
  items,
  projectPath,
  limit,
  projectOf,
  selection,
  fold,
}: {
  items: Conversation[];
  projectPath?: string;
  limit?: number;
  projectOf?: (session: Session) => Node | undefined;
  selection?: Selection;
  /** Fold short chats into one row at the end. */
  fold?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const main = fold ? items.filter((c) => !c.short) : items;
  const short = fold ? items.filter((c) => c.short) : [];
  const row = (c: Conversation) => (
    <ConversationRow
      key={conversationKey(c)}
      c={c}
      projectPath={projectPath}
      projectOf={projectOf}
      selection={selection}
    />
  );
  return (
    <div className="sessions">
      {main.slice(0, limit).map(row)}
      {short.length && (limit === undefined || main.length < limit) ? (
        <>
          <button
            className="sess short-fold"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Icon name="chev" className={`sm ${open ? "open" : ""}`} />
            <span className="session-title">
              <span>{plural(short.length, "short chat")}</span>
              <small>
                A couple of prompts each, no file changed ·{" "}
                {bytes(short.reduce((n, c) => n + c.bytes, 0))}
              </small>
            </span>
          </button>
          {open ? <div className="short-chats">{short.map(row)}</div> : null}
        </>
      ) : null}
    </div>
  );
}
/** "24 prompts · 11 files changed · 3 h · 47 MB": what a conversation was, in one line. */
function summary(c: Conversation) {
  return [
    c.prompts === undefined ? "" : plural(c.prompts, "prompt"),
    c.filesChanged
      ? `${c.filesChanged} ${c.filesChanged === 1 ? "file" : "files"} changed`
      : "",
    duration(c.activeSeconds),
    c.bytes ? bytes(c.bytes) : "",
    ...(c.session.prs ?? []).slice(0, 2).map((pr) => `PR #${pr.number}`),
  ].filter(Boolean);
}
function ConversationRow({
  c,
  projectPath,
  projectOf,
  selection,
}: {
  c: Conversation;
  projectPath?: string;
  projectOf?: (session: Session) => Node | undefined;
  selection?: Selection;
}) {
  const snapshot = useApp((state) => state.snapshot!);
  const home = snapshot.home;
  const historyPending = useApp((state) => state.historyPending);
  const [expanded, setExpanded] = useState(false);
  const { session, children } = c;
  const node = projectOf?.(session);
  const place = node
    ? node.label
    : session.cwd
      ? session.cwd === home
        ? "Home"
        : tilde(session.cwd, home)
      : "No folder recorded";
  const can = deletable(c);
  const reports = snapshot.reportsDir
    ? reportsOfSessions(snapshot, conversationIds(c))
    : [];
  const reportLabel =
    reports.length === 1
      ? `Read its report: ${reports[0].title}`
      : `Read its ${reports.length} reports`;
  return (
    <div className="session-group">
      <div className={`sess${c.short ? " is-short" : ""}`}>
        {selection ? (
          <input
            type="checkbox"
            className="cb sess-pick"
            aria-label={`Select ${c.title}`}
            title={
              can
                ? undefined
                : session.kept
                  ? "Kept: cleanup leaves it alone"
                  : "Laci can't delete this one"
            }
            disabled={!can}
            checked={selection.has(c)}
            onChange={() => selection.toggle(c)}
          />
        ) : null}
        <Icon name="bot" className="sm" />
        <button
          className="session-title"
          title={c.title}
          onClick={() =>
            useApp.setState({
              modal: {
                kind: "session",
                provider: session.provider,
                sessionId: session.sessionId,
                file: session.file,
                projectPath,
              },
            })
          }
        >
          <span>{c.title}</span>
          <small>
            {[
              ...(projectOf ? [place] : []),
              ...summary(c),
              ...(session.backup
                ? ["In backup only"]
                : session.resumeCapability !== "supported"
                  ? ["History only"]
                  : []),
            ].join(" · ")}
          </small>
        </button>
        {reports.length ? (
          <button
            className="icon-btn sess-rep"
            title={reportLabel}
            aria-label={reportLabel}
            onClick={() =>
              useApp.getState().openReport({
                id: reports[0].id,
                sessions: conversationIds(c),
              })
            }
          >
            <Icon name="report" className="sm" />
            {reports.length > 1 ? <small>{reports.length}</small> : null}
          </button>
        ) : null}
        <span
          className="kept"
          title={session.kept ? "Kept: cleanup leaves it alone" : undefined}
        >
          {session.kept ? <Icon name="keep" className="sm" /> : null}
        </span>
        <span className="pill">{providerName(snapshot, session.provider)}</span>
        <span className="m">
          <Time at={c.updatedAt} />
        </span>
        <span className="sess-act">
          {session.backup ? (
            <button
              className="btn sm act always"
              title="Put this session back where its tool keeps it"
              disabled={historyPending}
              onClick={() => restoreSession(session)}
            >
              Restore
            </button>
          ) : session.resumeCapability === "supported" &&
            (projectPath ?? session.cwd) ? (
            <button
              className="btn sm act"
              onClick={() => requestResume(session, projectPath)}
            >
              Resume
            </button>
          ) : null}
        </span>
      </div>
      {children.length ? (
        <>
          <button
            className="linkbtn session-children-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide" : "Show"}{" "}
            {plural(children.length, "subagent log")}
          </button>
          {expanded ? (
            <div className="session-children">
              {children.map((child) => (
                <ChildRow key={sessionKey(child.session)} group={child} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
/** A subagent's log: read-only history inside its conversation. */
function ChildRow({ group }: { group: SessionGroup }) {
  const { session } = group;
  return (
    <>
      <div className="sess child">
        <Icon name="bot" className="sm" />
        <span className="session-title static">
          <span>{session.title}</span>
          <small>
            {[
              session.prompts === undefined
                ? ""
                : plural(session.prompts, "prompt"),
              session.bytes ? bytes(session.bytes) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </span>
        <span className="m">
          <Time at={session.updatedAt} />
        </span>
      </div>
      {group.children.map((child) => (
        <ChildRow key={sessionKey(child.session)} group={child} />
      ))}
    </>
  );
}
export function keepSessions(list: Conversation[], keep: boolean) {
  const sessions = list.flatMap((c) =>
    [c.session, ...c.parts].map((s) => ({
      provider: s.provider,
      sessionId: s.sessionId,
    })),
  );
  void run(
    async () => {
      await api("session/keep", { sessions, keep });
      toast(
        keep
          ? `Keeping ${list.length === 1 ? "this session" : plural(list.length, "session")}`
          : `No longer keeping ${list.length === 1 ? "this session" : plural(list.length, "session")}`,
        keep ? "Cleanup leaves it alone." : "",
      );
    },
    keep ? "Keeping…" : "Updating…",
    { history: true },
  );
}

/** An agent request without a project yet: pick one, then the start dialog opens. */
function ProjectPicker({ provider }: { provider?: string }) {
  const snapshot = useApp((s) => s.snapshot!);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const projects = Object.values(snapshot.nodes)
    .filter((node) => node.kind === "project" && !node.archived)
    .filter(
      (node) =>
        !needle ||
        node.label.toLowerCase().includes(needle) ||
        node.path.toLowerCase().includes(needle),
    )
    .sort((a, b) =>
      (b.lastActivity?.at ?? "").localeCompare(a.lastActivity?.at ?? ""),
    );
  return (
    <DialogFrame
      title="Choose a project"
      description={`${providerName(snapshot, provider) || "The agent"} starts in the project you pick.`}
      footer={
        <>
          <span className="grow" />
          <button
            className="btn"
            onClick={() => useApp.setState({ modal: null })}
          >
            Cancel
          </button>
        </>
      }
    >
      <input
        className="inp"
        type="search"
        name="projectFilter"
        aria-label="Filter projects"
        placeholder="Filter projects"
        autoComplete="off"
        autoFocus
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="project-pick">
        {projects.slice(0, 100).map((node) => (
          <button
            className="pick"
            key={node.id}
            onClick={() =>
              useApp.setState({
                modal: { kind: "agent", provider, projectPath: node.id },
              })
            }
          >
            <Icon name="code" />
            <div className="txt">
              <b>{node.label}</b>
              <p className="mono">{tilde(node.path, snapshot.home)}</p>
            </div>
            <span className="faint">
              {node.lastActivity ? <Time at={node.lastActivity.at} /> : "—"}
            </span>
          </button>
        ))}
        {!projects.length ? <p className="muted">No project matches</p> : null}
      </div>
    </DialogFrame>
  );
}

export function AgentDialog({
  request,
}: {
  request: Extract<NonNullable<Modal>, { kind: "agent" }>;
}) {
  return request.projectPath ? (
    <StartDialog request={request} />
  ) : (
    <ProjectPicker provider={request.provider} />
  );
}
function StartDialog({
  request,
}: {
  request: Extract<NonNullable<Modal>, { kind: "agent" }>;
}) {
  const snapshot = useApp((s) => s.snapshot);
  const providers = agentProviders(snapshot?.connectors ?? []);
  const [draft, setDraft] = useState(() => ({
    ...agentDraft(
      request.provider ?? providers[0]?.value,
      useApp.getState().terminalTarget,
    ),
    prompt: request.prompt ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const session = request.sessionId
    ? allSessions(snapshot!).find(
        (session) =>
          session.provider === request.provider &&
          session.sessionId === request.sessionId,
      )
    : undefined;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.sessionId && !session) {
      setError(
        "This session is no longer available. Close and refresh history.",
      );
      return;
    }
    await run(
      async () => {
        setSaving(true);
        setError("");
        try {
          await launchAgent(draft, request.projectPath, request.sessionId);
          useApp.setState({ modal: null });
          toast(
            request.sessionId ? "Session resumed" : "Agent started",
            providerName(snapshot, draft.provider),
          );
        } finally {
          setSaving(false);
        }
      },
      "Starting agent…",
      { onError: (error) => setError(errorText(error)) },
    );
  }
  return (
    <DialogFrame
      title={
        request.sessionId
          ? `Resume ${providerName(snapshot, request.provider)}`
          : "Start an agent"
      }
      description={
        session
          ? session.title
          : "Choose a connected agent and its terminal target."
      }
      form
      dismissible={!saving}
      onSubmit={(event) => void submit(event)}
      footer={
        <>
          <p
            className={error ? "err" : "mono"}
            role={error ? "alert" : undefined}
          >
            {error || tilde(request.projectPath, snapshot!.home)}
          </p>
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => useApp.setState({ modal: null })}
          >
            Discard draft
          </button>
          <button
            className="btn primary"
            disabled={
              saving ||
              !providers.some(
                (provider) => provider.value === draft.provider,
              ) ||
              Boolean(request.sessionId && !session)
            }
          >
            {saving
              ? "Starting…"
              : request.sessionId
                ? "Resume session"
                : "Start agent"}
          </button>
        </>
      }
    >
      {providers.length ? (
        <AgentFields
          draft={draft}
          onChange={setDraft}
          fixedProvider={Boolean(request.sessionId)}
          disabled={saving}
          allowContinue={!request.sessionId}
        />
      ) : (
        <p>
          No connected agent can start a session. Connect one on the Agents
          page.
        </p>
      )}
    </DialogFrame>
  );
}

function Said({ label, text }: { label: string; text?: string }) {
  return text ? (
    <div className="said">
      <div className="said-k">{label}</div>
      <blockquote>{text}</blockquote>
    </div>
  ) : null;
}
export function SessionDialog({
  request,
}: {
  request: Extract<NonNullable<Modal>, { kind: "session" }>;
}) {
  const snapshot = useApp((s) => s.snapshot!);
  const historyPending = useApp((s) => s.historyPending);
  useNow();
  const all = allSessions(snapshot);
  const session = all.find(
    (item) =>
      item.provider === request.provider &&
      item.sessionId === request.sessionId &&
      item.file === request.file,
  );
  // The conversation this session is part of: its own row, or the one it continued in.
  const c = session
    ? conversations(all).find(
        (c) =>
          c.session === session ||
          c.parts.includes(session) ||
          c.children.some((g) => g.session === session),
      )
    : undefined;
  const node = session
    ? Object.values(snapshot.nodes).find((n) =>
        sessionsOf(n, snapshot).includes(session),
      )
    : undefined;
  const main = c?.session === session ? c : undefined;
  const ids = c ? conversationIds(c) : session ? [session.sessionId] : [];
  const reports = snapshot.reportsDir ? reportsOfSessions(snapshot, ids) : [];
  return (
    <DialogFrame
      title={main?.title ?? session?.title ?? "Session unavailable"}
      description={
        session
          ? [
              providerName(snapshot, session.provider),
              session.model,
              node?.label ??
                (session.cwd ? tilde(session.cwd, snapshot.home) : ""),
            ]
              .filter(Boolean)
              .join(" · ")
          : "This history entry is no longer in the current scan."
      }
      footer={
        <>
          {main && !session!.backup ? (
            <button
              className="btn ghost"
              disabled={historyPending}
              onClick={() => keepSessions([main], !session!.kept)}
            >
              <Icon name="keep" className="sm" />
              {session!.kept ? "Don't keep" : "Keep"}
            </button>
          ) : null}
          {main && deletable(main) ? (
            <button
              className="btn ghost"
              disabled={historyPending}
              onClick={() =>
                useApp.setState({
                  modal: { kind: "session-delete", files: [session!.file] },
                })
              }
            >
              <Icon name="delete" className="sm" />
              Delete…
            </button>
          ) : null}
          <span className="grow" />
          {reports.length ? (
            <button
              className="btn"
              onClick={() =>
                useApp
                  .getState()
                  .openReport({ id: reports[0].id, sessions: ids })
              }
            >
              <Icon name="report" className="sm" />
              {reports.length === 1 ? "Report" : `${reports.length} reports`}
            </button>
          ) : null}
          {node && request.projectPath !== node.id ? (
            <button
              className="btn"
              onClick={() => {
                useApp.setState({ modal: null });
                goToProject(node.id, "agents");
              }}
            >
              Open {node.label}
            </button>
          ) : null}
          <button
            className="btn"
            onClick={() => useApp.setState({ modal: null })}
          >
            Close
          </button>
          {session?.backup ? (
            <button
              className="btn primary"
              disabled={historyPending}
              onClick={() => {
                useApp.setState({ modal: null });
                restoreSession(session);
              }}
            >
              Restore
            </button>
          ) : null}
          {session?.resumeCapability === "supported" &&
          (request.projectPath ?? session.cwd) ? (
            <button
              className="btn primary"
              onClick={() => requestResume(session, request.projectPath)}
            >
              Resume…
            </button>
          ) : null}
        </>
      }
    >
      {session ? (
        <>
          <dl className="kv session-details">
            {main ? (
              <>
                <dt>In it</dt>
                <dd>
                  {[
                    main.prompts === undefined
                      ? "Not recorded"
                      : plural(main.prompts, "prompt"),
                    `${main.filesChanged} ${main.filesChanged === 1 ? "file" : "files"} changed`,
                  ].join(" · ")}
                </dd>
                <dt>When</dt>
                <dd>
                  {main.startedAt ? (
                    <>
                      <Time at={main.startedAt} long /> to{" "}
                    </>
                  ) : null}
                  <Time at={main.updatedAt} long />
                  {duration(main.activeSeconds)
                    ? ` · ${duration(main.activeSeconds)} in it`
                    : ""}
                </dd>
                <dt>Size</dt>
                <dd>
                  {bytes(main.bytes)}
                  {main.children.length
                    ? ` with ${plural(main.children.length, "subagent log")}`
                    : ""}
                  {main.parts.length
                    ? ` · continues ${plural(main.parts.length, "earlier session")}`
                    : ""}
                </dd>
              </>
            ) : (
              <>
                <dt>Part of</dt>
                <dd>{c?.title ?? "Not found"}</dd>
              </>
            )}
            {session.prs?.length ? (
              <>
                <dt>Pull requests</dt>
                <dd className="prs">
                  {session.prs.map((pr) => (
                    <button
                      key={pr.url}
                      className="linkbtn"
                      onClick={() => urlOpen(pr.url)}
                    >
                      #{pr.number}
                    </button>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
          <Said
            label="First prompt"
            text={main?.parts.at(-1)?.firstPrompt ?? session.firstPrompt}
          />
          {session.lastPrompt !== session.firstPrompt ? (
            <Said label="Last prompt" text={session.lastPrompt} />
          ) : null}
          <Said label="Last reply" text={session.lastReply} />
          <details className="session-more">
            <summary>Files and ID</summary>
            <dl className="kv session-details">
              <dt>Folder</dt>
              <dd className="mono">
                {session.cwd
                  ? tilde(session.cwd, snapshot.home)
                  : "Not recorded"}
              </dd>
              <dt>Session ID</dt>
              <dd className="mono">{session.sessionId || "Not recorded"}</dd>
              <dt>{session.backup ? "Backup copy" : "History file"}</dt>
              <dd className="mono">{tilde(session.file, snapshot.home)}</dd>
              <dt>Title</dt>
              <dd>
                {session.titleSource === "index"
                  ? "From the agent's title index"
                  : session.titleSource === "first-message"
                    ? "Your first prompt"
                    : session.titleSource === "provider"
                      ? "Named by the agent"
                      : "No title recorded"}
              </dd>
              <dt>Resume</dt>
              <dd>
                {session.backup
                  ? "Restore it first; a copy cannot be resumed"
                  : session.resumeCapability === "supported"
                    ? session.cwd || request.projectPath
                      ? "Yes, in its folder"
                      : "Its folder is not recorded"
                    : "History only; this entry cannot be resumed"}
              </dd>
            </dl>
          </details>
        </>
      ) : null}
    </DialogFrame>
  );
}
/** Confirms deleting conversations: each with its earlier parts and subagent logs. */
export function DeleteSessions({ files }: { files: string[] }) {
  const snapshot = useApp((s) => s.snapshot!);
  useNow();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const chosen = conversations(allSessions(snapshot)).filter((c) =>
    files.includes(c.session.file),
  );
  const ready = chosen.filter((c) => deletable(c));
  const left = chosen.length - ready.length;
  const size = ready.reduce((n, c) => n + c.bytes, 0);
  const extra = ready.reduce((n, c) => n + c.parts.length, 0);
  const subagents = ready.reduce((n, c) => n + c.children.length, 0);
  async function remove() {
    await run(
      async () => {
        setSaving(true);
        setError("");
        try {
          const change = await api<Change>("session/delete", {
            files: ready.flatMap((c) => [
              c.session.file,
              ...c.parts.map((p) => p.file),
            ]),
          });
          useApp.setState({ modal: null });
          changed(
            change,
            ready.length === 1
              ? "Session deleted"
              : `${plural(ready.length, "session")} deleted`,
            `${bytes(size)} moved to Laci's quarantine`,
          );
        } finally {
          setSaving(false);
        }
      },
      "Deleting sessions…",
      { history: true, onError: (e) => setError(errorText(e)) },
    );
  }
  return (
    <DialogFrame
      title={
        ready.length === 1
          ? "Delete this session?"
          : `Delete ${plural(ready.length, "session")}?`
      }
      description={
        <>
          {bytes(size)}
          {extra ? `, with ${plural(extra, "earlier session")}` : ""}
          {subagents ? ` and ${plural(subagents, "subagent log")}` : ""}.{" "}
          {ready.length === 1 ? "It moves" : "They move"} to Laci's quarantine;
          Undo in the Log puts {ready.length === 1 ? "it" : "them"} back until
          you free that space under Storage.
        </>
      }
      dismissible={!saving}
      footer={
        <>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : left ? (
            <p>
              {plural(left, "session")} stay: kept, in use, or not Laci's to
              delete.
            </p>
          ) : (
            <span className="grow" />
          )}
          <button
            className="btn"
            disabled={saving}
            onClick={() => useApp.setState({ modal: null })}
          >
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={saving || !ready.length}
            onClick={() => void remove()}
          >
            {saving ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      <ul className="delete-list">
        {ready.slice(0, 6).map((c) => (
          <li key={conversationKey(c)}>
            <b>{c.title}</b>
            <small>{summary(c).join(" · ")}</small>
          </li>
        ))}
        {ready.length > 6 ? (
          <li className="faint">And {ready.length - 6} more</li>
        ) : null}
      </ul>
    </DialogFrame>
  );
}
