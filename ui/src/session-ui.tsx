import { useState } from "react";
import { errorText } from "./api";
import {
  agentDraft,
  agentProviders,
  AgentFields,
  launchAgent,
} from "./agent-launch";
import { DialogFrame } from "./dialogs";
import { Icon, Time } from "./common";
import {
  allSessions,
  groupSessions,
  plural,
  PROVIDER_NAMES,
  sessionKey,
  tilde,
} from "./helpers";
import type { SessionGroup } from "./helpers";
import { run, toast, useApp } from "./store";
import type { Modal } from "./store";
import type { Session } from "./types";

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

export function SessionList({
  sessions,
  projectPath,
  limit,
}: {
  sessions: Session[];
  projectPath?: string;
  limit?: number;
}) {
  return (
    <div className="sessions">
      {groupSessions(sessions)
        .slice(0, limit)
        .map((group) => (
          <SessionRow
            key={sessionKey(group.session)}
            group={group}
            projectPath={projectPath}
          />
        ))}
    </div>
  );
}
function SessionRow({
  group,
  projectPath,
}: {
  group: SessionGroup;
  projectPath?: string;
}) {
  const home = useApp((state) => state.snapshot!.home);
  const [expanded, setExpanded] = useState(false);
  const { session, children } = group;
  const provider = PROVIDER_NAMES[session.provider] ?? session.provider;
  return (
    <div className="session-group">
      <div className="sess">
        <Icon name="bot" className="sm" />
        <button
          className="session-title"
          title={session.title}
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
          <span>{session.title}</span>
          <small>
            {provider}
            {session.sourceKind === "subagent" ? " · Child session" : ""}
            {session.resumeCapability !== "supported" ? " · History only" : ""}
          </small>
          {!projectPath && session.cwd ? (
            <small className="mono">{tilde(session.cwd, home)}</small>
          ) : null}
        </button>
        <span className="m">
          <Time at={session.updatedAt} />
        </span>
        {session.resumeCapability === "supported" &&
        (projectPath ?? session.cwd) ? (
          <button
            className="btn sm act"
            onClick={() => requestResume(session, projectPath)}
          >
            Resume
          </button>
        ) : null}
      </div>
      {children.length ? (
        <>
          <button
            className="linkbtn session-children-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide" : "Show"}{" "}
            {plural(children.length, "child session")}
          </button>
          {expanded ? (
            <div className="session-children">
              {children.map((child) => (
                <SessionRow
                  key={sessionKey(child.session)}
                  group={child}
                  projectPath={projectPath}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function AgentDialog({
  request,
}: {
  request: Extract<NonNullable<Modal>, { kind: "agent" }>;
}) {
  const s = useApp();
  const providers = agentProviders(s.snapshot?.connectors ?? []);
  const [draft, setDraft] = useState(() => ({
    ...agentDraft(request.provider ?? providers[0]?.value, s.terminalTarget),
    prompt: request.prompt ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const session = request.sessionId
    ? allSessions(s.snapshot!).find(
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
            PROVIDER_NAMES[draft.provider] ?? draft.provider,
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
          ? `Resume ${PROVIDER_NAMES[request.provider ?? ""] ?? request.provider}`
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
            {error || tilde(request.projectPath, s.snapshot!.home)}
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
        />
      ) : (
        <p>
          No connected agent can launch a session. Add Claude Code, Codex or
          Antigravity in Settings.
        </p>
      )}
    </DialogFrame>
  );
}

export function SessionDialog({
  request,
}: {
  request: Extract<NonNullable<Modal>, { kind: "session" }>;
}) {
  const snapshot = useApp((s) => s.snapshot!);
  const session = allSessions(snapshot).find(
    (item) =>
      item.provider === request.provider &&
      item.sessionId === request.sessionId &&
      item.file === request.file,
  );
  return (
    <DialogFrame
      title={session?.title ?? "Session unavailable"}
      description={
        session
          ? (PROVIDER_NAMES[session.provider] ?? session.provider)
          : "This history entry is no longer in the current scan."
      }
      footer={
        <>
          <span className="grow" />
          <button
            className="btn"
            onClick={() => useApp.setState({ modal: null })}
          >
            Close
          </button>
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
        <dl className="kv session-details">
          <dt>Folder</dt>
          <dd className="mono">
            {session.cwd ? tilde(session.cwd, snapshot.home) : "Not recorded"}
          </dd>
          <dt>Session ID</dt>
          <dd className="mono">{session.sessionId || "Not recorded"}</dd>
          <dt>Updated</dt>
          <dd>
            <Time at={session.updatedAt} long />
          </dd>
          <dt>Title source</dt>
          <dd>
            {session.titleSource === "index"
              ? "Provider title index"
              : session.titleSource === "first-message"
                ? "First user message"
                : session.titleSource === "provider"
                  ? "Provider metadata"
                  : "Untitled fallback"}
          </dd>
          <dt>History file</dt>
          <dd className="mono">{tilde(session.file, snapshot.home)}</dd>
          {session.parentId ? (
            <>
              <dt>Parent session</dt>
              <dd className="mono">{session.parentId}</dd>
            </>
          ) : null}
          <dt>Resume</dt>
          <dd>
            {session.resumeCapability === "supported"
              ? session.cwd || request.projectPath
                ? "Available after the folder is checked"
                : "Folder not recorded"
              : "History only; this entry cannot be resumed"}
          </dd>
        </dl>
      ) : null}
    </DialogFrame>
  );
}
