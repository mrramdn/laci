import { useEffect, useMemo, useState } from "react";
import { Icon, KindIcon, Group, Expand } from "../common";
import { useApp, backup, run, changed, toggleExpanded } from "../store";
import {
  agentCount,
  ago,
  allSessions,
  base,
  bytes,
  date,
  groupSessions,
  plural,
  providerName,
  sessionKey,
  sessionsOf,
  tilde,
  counted,
} from "../helpers";
import { api } from "../api";
import { agentProviders } from "../agent-launch";
import type { AgentCapabilities } from "../agent-launch";
import { SessionList } from "../session-ui";
import { McpRow, loadMcp } from "../mcp-setup";
import type { Change, ClaudeDir, ConnectorState, Suggestion } from "../types";

const SESSION_LIMIT = 50;
const STORAGE = "agents:storage";
const MORE = "agents:sessions";

function since(at: string) {
  const text = ago(at);
  return text === "just now" || text === "yesterday" ? text : `${text} ago`;
}
/** The folder a Claude Code history dir used to belong to, for dirs whose folder is gone. */
function goneFolder(dir: ClaudeDir) {
  if (dir.gone[0]) return dir.gone[0];
  return Object.entries(dir.cwds).sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function AgentsView() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const sessions = allSessions(snapshot);
  const launchable = agentProviders(snapshot.connectors);
  const providerOf = (c: ConnectorState) => c.provider ?? c.id;
  const cards = [
    ...snapshot.connectors.map((c) => ({
      id: c.id,
      provider: providerOf(c),
      connector: c as ConnectorState | undefined,
      suggestion: undefined as Suggestion | undefined,
    })),
    ...snapshot.suggestions.map((x) => ({
      id: x.id,
      provider: x.id,
      connector: undefined as ConnectorState | undefined,
      suggestion: x as Suggestion | undefined,
    })),
  ];
  // Whether its program is installed is worth showing before an agent is connected, too.
  const wanted = [
    ...launchable.map((item) => item.value),
    ...snapshot.suggestions.filter((x) => x.launch).map((x) => x.id),
  ].join(",");
  const [caps, setCaps] = useState<Record<string, AgentCapabilities>>({});
  useEffect(() => {
    let live = true;
    for (const provider of wanted.split(",").filter(Boolean))
      api<AgentCapabilities>("agent/models", { provider, passive: true })
        .then((result) => {
          if (live) setCaps((current) => ({ ...current, [provider]: result }));
        })
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wanted]);
  const usage = useMemo(() => {
    const map = new Map<string, { count: number; last: string }>();
    for (const session of sessions) {
  const connectedIds = snapshot.connectors.map((c) => c.id).join(",");
  useEffect(() => {
    void loadMcp();
  }, [connectedIds]);
      const entry = map.get(session.provider);
      if (entry) entry.count++;
      else map.set(session.provider, { count: 1, last: session.updatedAt });
    }
    return map;
  }, [sessions]);
  const addPreset = (id: string) =>
    void run(
      async () => {
        const change = await api<Change>("connector/add", { preset: id });
        const name =
          snapshot.suggestions.find((c) => c.id === id)?.name ?? "connector";
        changed(change, `Added ${name}`);
      },
      "Adding connector…",
      { history: true },
    );
  const removeConnector = (c: ConnectorState) =>
    void run(
      async () => {
        changed(
          await api<Change>("connector/remove", { id: c.id }),
          `Removed ${c.name}`,
          "Its files stay where they are, but Laci no longer shows them or moves them with projects.",
        );
      },
      "Removing connector…",
      { history: true },
    );
  const addCard = (
    <button
      className="stat add"
      disabled={s.historyPending}
      onClick={() => useApp.setState({ modal: { kind: "connector" } })}
    >
      <Icon name="plus" />
      <span>Add another AI tool</span>
      <small className="faint">Another AI tool you use</small>
    </button>
  );
  return (
    <>
      <div className="head">
        <h1>Agents</h1>
        <span className="count">
          {snapshot.connectors.length
            ? `${snapshot.connectors.length} connected`
            : "Nothing connected yet"}
        </span>
      </div>
      <div className="body agents-page">
        <div className="stats agent-cards">
          {cards.map((card) => {
            const { connector: c, suggestion: x } = card;
            const name = (c ?? x)!.name;
            const info = caps[card.provider];
            const canLaunch =
              !!c && launchable.some((item) => item.value === card.provider);
            const use = usage.get(card.provider);
            const remembered = info?.remembered;
            const model = remembered?.model
              ? (info?.models.find((m) => m.id === remembered.model)?.label ??
                remembered.model)
              : "Default model";
            return (
              <div
                className="stat agent-card"
                key={`${c ? "c" : "s"}:${card.id}`}
              >
                <div className="top">
                  <span className="k">{name}</span>
                  {c && !c.builtin ? <span className="tag">Custom</span> : null}
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label={`${name} connected`}
                      checked={!!c}
                      disabled={s.historyPending}
                      onChange={() =>
                        c ? removeConnector(c) : addPreset(card.id)
                      }
                    />
                    {c ? "Connected" : "Connect"}
                  </label>
                </div>
                {/* Once a tool is in use its numbers say more than its description. */}
                {c && use ? null : (
                  <p className="agent-about">
                    {(c ?? x)!.about}
                    {x?.found ? (
                      <>
                        {" · "}
                        <span className="found">found on this PC</span>
                      </>
                    ) : null}
                  </p>
                )}
                {info ? (
                  <div className="agent-state">
                    <span className={`pill ${info.installed ? "ok" : "warn"}`}>
                      {info.installed ? "Installed" : "Not on PATH"}
                    </span>
                  </div>
                ) : null}
                {c ? (
                  <div className="agent-use">
                    {use
                      ? `${plural(use.count, "session")} · last used ${since(use.last)}`
                      : c.present && c.id !== "claude"
                        ? plural(
                            c.count,
                            c.link.kind === "cwd"
                              ? "log"
                              : c.link.kind === "named"
                                ? "folder"
                                : "file",
                          )
                        : "No sessions yet"}
                  </div>
                ) : null}
                {canLaunch && info ? (
                  <div className="agent-starts muted">
                    Starts with: {model} ·{" "}
                    {remembered?.effort ?? "Default effort"}
                  </div>
                ) : null}
                {canLaunch && info?.installed ? (
                  <div className="foot">
                    <button
                      className="btn sm"
                      onClick={() =>
                        useApp.setState({
                          modal: {
                            kind: "agent",
                            provider: card.provider,
                {c?.capabilities?.mcp ? (
                  <McpRow provider={card.provider} />
                ) : null}
                            projectPath: "",
                          },
                        })
                      }
                    >
                      <Icon name="play" className="sm" />
                      Start…
                    </button>
                  </div>
                ) : null}
                {c ? (
                  <details className="agent-details">
                    <summary>Details</summary>
                    <div className="v">
                      {c.present ? bytes(c.bytes) : "Nothing here yet"}
                    </div>
                    <div className="p">{c.where}</div>
                    <div className="mv">
                      On move:{" "}
                      {c.moves.charAt(0).toLowerCase() + c.moves.slice(1)}
                    </div>
                    {!c.builtin ? (
                      <div className="foot">
                        <button
                          className="btn sm ghost"
                          disabled={s.historyPending}
                          onClick={() => removeConnector(c)}
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
                  </details>
                ) : (
                  <details className="agent-details">
                    <summary>Details</summary>
                    <div className="p">{x!.where}</div>
                  </details>
                )}
              </div>
            );
          })}
          {addCard}
        </div>
        <SessionsSection />
        {snapshot.connectors.length ? <StorageSection /> : null}
      </div>
    </>
  );
}

function SessionsSection() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const all = allSessions(snapshot);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [resumable, setResumable] = useState(false);
  const [scope, setScope] = useState<"all" | "in" | "out">("all");
  const owners = useMemo(() => {
    const map = new Map<string, (typeof snapshot.nodes)[string]>();
    for (const node of Object.values(snapshot.nodes))
      for (const session of sessionsOf(node, snapshot))
        map.set(sessionKey(session), node);
    return map;
  }, [snapshot]);
  const providers = [...new Set(all.map((session) => session.provider))];
  const needle = query.trim().toLowerCase();
  const shown = all.filter((session) => {
    const node = owners.get(sessionKey(session));
    if (agent !== "all" && session.provider !== agent) return false;
    if (resumable && session.resumeCapability !== "supported") return false;
    if (scope === "in" && !node) return false;
    if (scope === "out" && node) return false;
    if (!needle) return true;
    return [session.title, node?.label, node?.path, session.cwd].some((text) =>
  const [backupOnly, setBackupOnly] = useState(false);
  // Once the last of them is restored the chip goes, and so must its filter.
  const anyInBackup = all.some((session) => session.backup);
  const inBackup = backupOnly && anyInBackup;
      text?.toLowerCase().includes(needle),
    );
  });
  const rows = groupSessions(shown).length;
  const chip = (label: string, on: boolean, click: () => void) => (
    <button className="chipf" key={label} aria-pressed={on} onClick={click}>
      {label}
    </button>
  );
  return (
    <Group title="Sessions" count={all.length}>
      <div className="agent-filters">
        <input
          className="inp"
    if (inBackup && !session.backup) return false;
          type="search"
          name="sessionSearch"
          aria-label="Search sessions"
          placeholder="Search by title or project"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="showbar" role="group" aria-label="Agent">
          {chip("All agents", agent === "all", () => setAgent("all"))}
          {providers.map((provider) =>
            chip(providerName(snapshot, provider), agent === provider, () =>
              setAgent(provider),
            ),
          )}
        </div>
        <div className="showbar" role="group" aria-label="Scope">
          {chip("All", scope === "all", () => setScope("all"))}
          {chip("In projects", scope === "in", () => setScope("in"))}
          {chip("Outside projects", scope === "out", () => setScope("out"))}
        </div>
        {chip("Resumable", resumable, () => setResumable(!resumable))}
      </div>
      {shown.length ? (
        <>
          <SessionList
            sessions={shown}
            limit={s.expanded[MORE] ? undefined : SESSION_LIMIT}
            projectOf={(session) => owners.get(sessionKey(session))}
          />
          {rows > SESSION_LIMIT ? <Expand name={MORE} count={rows} /> : null}
        </>
      ) : (
        <div className="empty">No sessions match</div>
      )}
    </Group>
  );
}

function StorageSection() {
        {anyInBackup
          ? chip("In backup only", inBackup, () => setBackupOnly(!inBackup))
          : null}
  const s = useApp();
  const open = !!s.expanded[STORAGE];
  return (
    <section className="group agent-storage">
      <button
        className="group-h storage-toggle"
        aria-expanded={open}
        onClick={() => toggleExpanded(STORAGE)}
      >
        <Icon name="chev" className={`sm ${open ? "open" : ""}`} />
        Storage and cleanup
        <span className="hint">
          What the history takes up and what no longer belongs to a project
        </span>
      </button>
      {open ? <StorageBody /> : null}
    </section>
  );
}

function StorageBody() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const linked = Object.values(snapshot.nodes)
    .filter(
      (n) =>
        sessionsOf(n, snapshot).length ||
        n.agents.claude.length ||
        n.agents.items.some((id) => counted(id, snapshot)),
    )
    .map((n) => ({
      n,
      sessions: agentCount(n, snapshot),
      memory: n.agents.claude.reduce(
        (sum, key) => sum + (snapshot.claude[key]?.memory.length ?? 0),
        0,
      ),
      bytes:
        n.agents.claude.reduce(
          (sum, key) => sum + (snapshot.claude[key]?.bytes ?? 0),
          0,
        ) +
        n.agents.items
          .filter((id) => counted(id, snapshot))
          .reduce((sum, id) => sum + (snapshot.items[id]?.bytes ?? 0), 0),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  const maximum = Math.max(...linked.map((l) => l.bytes), 1);
  const orphanGroups = new Map<string, (typeof snapshot.items)[string][]>();
  for (const id of snapshot.orphans.items) {
    const item = snapshot.items[id];
    if (!item) continue;
    const key = `${item.connector}:${item.cwd ?? item.file}`;
    orphanGroups.set(key, [...(orphanGroups.get(key) ?? []), item]);
  }
  const orphans = [
    ...snapshot.orphans.claude.flatMap((key) => {
      const dir = snapshot.claude[key];
      const folder = dir ? goneFolder(dir) : undefined;
      return dir
        ? [
            {
              name: folder ? tilde(folder, snapshot.home) : key,
              title: key,
              what: `${plural(dir.sessions.length, "session")} · ${plural(dir.memory.length, "memory file")}`,
              at: dir.sessions[0]?.at,
              tool: "Claude Code",
              unavailable: dir.availability === "unavailable",
            },
          ]
        : [];
    }),
    ...[...orphanGroups.values()].map((list) => ({
      name: tilde(list[0].cwd ?? list[0].file, snapshot.home),
      title: list[0].file,
      what: plural(
        list.length,
        snapshot.connectors.find((c) => c.id === list[0].connector)?.link
          .kind === "cwd"
          ? "session"
          : "folder",
      ),
      at: list[0].at,
      unavailable: list.some((item) => item.availability === "unavailable"),
      tool:
        snapshot.connectors.find((c) => c.id === list[0].connector)?.name ??
        list[0].connector,
    })),
  ];
  return (
    <div className="agent-storage-body">
      <div className="agent-storage-actions">
        <button className="btn sm" onClick={backup}>
          Back up logs now
        </button>
      </div>
      <Group title="Size by project" count={linked.length}>
        {linked.map(({ n, sessions, memory, bytes: b }) => (
          <div
            className="item"
            key={n.id}
            tabIndex={0}
            data-id={n.id}
            aria-selected={s.selected === n.id}
            onClick={() => s.select(n.id, "agents")}
          >
            <KindIcon node={n} />
            <span className="name">{n.label}</span>
            <span className="d">
              {plural(sessions, "session")}
              {memory ? ` · ${plural(memory, "memory file")}` : ""}
            </span>
            <span className="meta">
              <span className="meter">
                <i style={{ width: `${Math.max(2, (b / maximum) * 100)}%` }} />
              </span>
              <span className="mono" style={{ width: 56, textAlign: "right" }}>
                {bytes(b)}
              </span>
            </span>
          </div>
        ))}
        {!linked.length ? (
          <div className="empty">No project has agent history yet.</div>
        ) : null}
      </Group>
      <Group
        title="Detached"
        count={orphans.length}
        hint="Missing or unavailable project locations"
        right={
          <button className="btn sm" onClick={() => s.navigate("tidy")}>
            Fix in Tidy up
          </button>
        }
      >
        {orphans.map((o, i) => (
          <div className="item" key={i}>
            <Icon name="unlink" />
            <span
              className="name mono"
              title={o.title}
              style={{ fontWeight: 400, maxWidth: "48%" }}
            >
              {o.name}
            </span>
            <span className="d">
              {o.unavailable
                ? "Location unavailable · "
                : "Confirmed missing · "}
              {o.what}
            </span>
            <span className="meta">
              <span className="pill">{o.tool}</span>
              <span className="mono">{date(o.at)}</span>
            </span>
          </div>
        ))}
        {!orphans.length ? (
          <div className="empty">
            No detached history found. Unavailable locations stay protected from
            cleanup.
          </div>
        ) : null}
      </Group>
      {snapshot.unmatched.length ? (
        <Group
          title="Not matched"
          count={snapshot.unmatched.length}
          hint="Named by a hash of a folder Laci didn't scan"
        >
          {snapshot.unmatched.flatMap((id) => {
            const item = snapshot.items[id];
            return item
              ? [
                  <div className="item" key={id}>
                    <Icon name="history" />
                    <span className="name mono" style={{ fontWeight: 400 }}>
                      {base(item.file).slice(0, 12)}…
                    </span>
                    <span className="d">
                      {
                        snapshot.connectors.find((c) => c.id === item.connector)
                          ?.name
                      }
                    </span>
                    <span className="meta">
                      <span className="mono">{bytes(item.bytes)}</span>
                      <span className="mono">{date(item.at)}</span>
                    </span>
                  </div>,
                ]
              : [];
          })}
        </Group>
      ) : null}
    </div>
  );
}
