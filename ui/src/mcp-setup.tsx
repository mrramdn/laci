import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, errorText } from "./api";
import { DialogFrame } from "./dialogs";
import { run, toast, useApp } from "./store";
import type { McpStatus } from "./types";

export const useMcp = create<{ statuses: Record<string, McpStatus> }>(() => ({
  statuses: {},
}));

export async function loadMcp() {
  try {
    const { agents } = await api<{ agents: McpStatus[] }>("agent/mcp");
    useMcp.setState({
      statuses: Object.fromEntries(agents.map((item) => [item.provider, item])),
    });
  } catch {
    // Keep what is shown; the dialog reports real failures when it acts.
  }
}

export function McpRow({ provider }: { provider: string }) {
  const status = useMcp((s) => s.statuses[provider]);
  if (!status) return null;
  const open = () => useApp.setState({ modal: { kind: "mcp", provider } });
  return (
    <div className="agent-mcp">
      <span className="muted">MCP server</span>
      {status.state === "registered" ? (
        <>
          <span className="pill ok">Set up</span>
          <button className="btn sm ghost" onClick={open}>
            Manage…
          </button>
        </>
      ) : status.state === "missing" ? (
        <>
          <span className="muted">Not set up</span>
          <button className="btn sm" onClick={open}>
            Set up…
          </button>
        </>
      ) : (
        <>
          <span className="pill warn">
            {status.state === "other" ? "Points elsewhere" : "Switched off"}
          </span>
          <button className="btn sm" onClick={open}>
            Fix…
          </button>
        </>
      )}
    </div>
  );
}

export function McpDialog({ provider }: { provider: string }) {
  const status = useMcp((s) => s.statuses[provider]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!status) void loadMcp();
  }, [status]);
  if (!status)
    return (
      <DialogFrame
        title="Laci as an MCP server"
        description="Reading the agent's settings."
        footer={
          <>
            <span className="grow" />
            <button
              className="btn"
              onClick={() => useApp.setState({ modal: null })}
            >
              Close
            </button>
          </>
        }
      >
        <p role="status">Loading…</p>
      </DialogFrame>
    );
  const { name } = status;
  const blocked = status.how === "command" && !status.installed;
  const apply = (remove: boolean) =>
    void run(
      async () => {
        setSaving(true);
        setError("");
        try {
          const result = await api<{ status: McpStatus }>("agent/mcp/apply", {
            provider,
            ...(remove ? { remove: true } : {}),
          });
          useMcp.setState((s) => ({
            statuses: { ...s.statuses, [provider]: result.status },
          }));
          toast(
            remove ? `Laci removed from ${name}` : `Laci added to ${name}`,
            "",
          );
          useApp.setState({ modal: null });
        } finally {
          setSaving(false);
        }
      },
      remove ? "Removing…" : "Setting up…",
      { onError: (e) => setError(errorText(e)) },
    );
  const shown = status.how === "command" ? status.add : status.snippet;
  const copy = () =>
    void navigator.clipboard
      .writeText(shown ?? "")
      .then(() => toast("Copied", ""));
  return (
    <DialogFrame
      title={`Laci in ${name}`}
      description={`With it, ${name} can ask Laci which projects exist and move, archive or create them the safe way. What it changes shows up in the Log.`}
      dismissible={!saving}
      footer={
        <>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : (
            <span className="grow" />
          )}
          <button
            className="btn"
            disabled={saving}
            onClick={() => useApp.setState({ modal: null })}
          >
            Close
          </button>
          {status.state !== "missing" ? (
            <button
              className="btn"
              disabled={saving || blocked}
              onClick={() => apply(true)}
            >
              Remove
            </button>
          ) : null}
          {status.state !== "registered" ? (
            <button
              className="btn primary"
              disabled={saving || blocked}
              onClick={() => apply(false)}
            >
              {status.state === "missing" ? "Set up" : "Point it here"}
            </button>
          ) : null}
        </>
      }
    >
      <p>
        {status.state === "registered"
          ? `Set up: ${name} starts this Laci as its MCP server.`
          : status.state === "missing"
            ? `${name} does not know Laci yet.`
            : status.state === "other"
              ? "Another program is registered under Laci's name:"
              : `Laci is registered but switched off in ${name}.`}
      </p>
      {status.state === "other" && status.current ? (
        <p className="mono">{status.current}</p>
      ) : null}
      {status.state !== "registered" ? (
        <>
          <div className="sec-t">What Set up does</div>
          <p>
            {status.how === "command"
              ? `Laci runs ${name}'s own command:`
              : `Laci adds this to ${status.file}:`}
          </p>
          <pre className="mcp-code">{shown}</pre>
          <button className="btn sm" onClick={copy}>
            Copy
          </button>
        </>
      ) : null}
      <p className="muted">
        {status.state === "registered"
          ? `Remove takes Laci out of ${status.file}.`
          : `Changes ${status.file}.`}{" "}
        Laci keeps a copy of that file in its own data folder first.
      </p>
      {blocked ? (
        <p className="err">
          {status.command} is not on PATH. Install it, or run the command above
          yourself.
        </p>
      ) : null}
    </DialogFrame>
  );
}
