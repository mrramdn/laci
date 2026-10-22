import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Icon, KindIcon, Group, Expand } from "../common";
import { useApp, backup, run, changed, toggleExpanded } from "../store";
import { useNow } from "../clock";
import {
  agentCount,
  ago,
  allSessions,
  base,
  bytes,
  conversationKey,
  conversations,
  date,
  deletable,
  plural,
  providerName,
  sessionKey,
  sessionsOf,
  tilde,
  counted,
} from "../helpers";
import type { Conversation } from "../helpers";
import { api } from "../api";
import { usable, useFocusStays } from "../focus-stays";
import { agentProviders } from "../agent-launch";
import type { AgentCapabilities } from "../agent-launch";
import { ConversationRows, keepSessions } from "../session-ui";
import type { Selection } from "../session-ui";
import { McpRow, loadMcp } from "../mcp-setup";
import { LaciStorage } from "../storage";
import { focusAfter } from "../simple/model";
import type {
  Change,
  ClaudeDir,
  ConnectorState,
  Node,
  Session,
  Suggestion,
} from "../types";

const SESSION_LIMIT = 50;

/**
 * Where the focus goes once a session's Restore went, as its row leaves In backup only (useFocusStays): to the next
 * row's Restore, else the one before; once none is left, to the Show filter that is on, All once the list shows
 * every session again. Another control that went is left to useFocusStays.
 */
export function afterRestore(
  page: HTMLElement | null,
  gone: HTMLElement,
  around: HTMLElement[],
) {
  if (!gone.hasAttribute("data-restore")) return undefined;
  return (
    focusAfter(around, gone, (c) => c.hasAttribute("data-restore") && usable(c)) ??
    page?.querySelector<HTMLElement>(
      '[role="group"][aria-label="Show"] [aria-pressed="true"]',
    )
  );
}
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
  const s = useApp(
    useShallow((state) => ({
      snapshot: state.snapshot!,
      historyPending: state.historyPending,
    })),
  );
  useNow();
  // A control that goes away, as a session's Restore, leaves the focus on the page.
  const page = useRef<HTMLDivElement>(null);
  useFocusStays(page, (gone, around) => afterRestore(page.current, gone, around));
  const snapshot = s.snapshot;
  const sessions = allSessions(snapshot);
  const launchable = agentProviders(snapshot.connectors);
  const providerOf = (c: ConnectorState) => c.provider ?? c.id;
  // The agents Laci ships with come first, then the user's own, then what is not connected yet.
  const cards = [
    ...[...snapshot.connectors]
      .sort((a, b) => Number(b.builtin) - Number(a.builtin))
      .map((c) => ({
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
  const connectedIds = snapshot.connectors.map((c) => c.id).join(",");
  useEffect(() => {
    void loadMcp();
  }, [connectedIds]);
  const usage = useMemo(() => {
    const map = new Map<string, { count: number; last: string }>();
    for (const c of conversations(sessions)) {
      const entry = map.get(c.session.provider);
      if (entry) entry.count++;
      else map.set(c.session.provider, { count: 1, last: c.updatedAt });
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
      <small className="faint">One Laci doesn't know yet</small>
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
      <div className="body agents-page" ref={page}>
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
                {info || (c && !c.builtin) ? (
                  <div className="agent-state">
                    {info ? (
                      <span
                        className={`pill ${info.installed ? "ok" : "warn"}`}
                      >
                        {info.installed ? "Installed" : "Not on PATH"}
                      </span>
                    ) : null}
                    {c && !c.builtin ? (
                      <span className="pill">Custom</span>
                    ) : null}
                  </div>
                ) : null}
                {c && c.link.kind !== "none" ? (
                  <div className="agent-use">
                    {use
                      ? `${plural(use.count, "session")} · last used ${since(use.last)}`
                      : c.present && c.count
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
                {c?.capabilities?.mcp ? (
                  <McpRow provider={card.provider} />
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
                    {c.link.kind === "none" ? null : (
                      <>
                        <div className="v">
                          {c.present ? bytes(c.bytes) : "Nothing here yet"}
                        </div>
                        <div className="p">{c.where}</div>
                        <div className="mv">
                          On move:{" "}
                          {c.moves.charAt(0).toLowerCase() + c.moves.slice(1)}
                        </div>
                      </>
                    )}
                    {c.command ? (
                      <div className="mv">
                        Started with: <span className="mono">{c.command}</span>
                      </div>
                    ) : null}
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

const DAY = 86_400_000;
type Show = "all" | "short" | "old" | "outside" | "kept" | "backup";
function SessionsSection() {
  const s = useApp(
    useShallow((state) => ({
      snapshot: state.snapshot!,
      historyPending: state.historyPending,
      showAll: !!state.expanded[MORE],
    })),
  );
  const now = useNow();
  const snapshot = s.snapshot;
  const all = allSessions(snapshot);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [show, setShow] = useState<Show>("all");
  const [flat, setFlat] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const owners = useMemo(() => {
    const map = new Map<string, (typeof snapshot.nodes)[string]>();
    for (const node of Object.values(snapshot.nodes))
      for (const session of sessionsOf(node, snapshot))
        map.set(sessionKey(session), node);
    return map;
  }, [snapshot]);
  const list = useMemo(() => conversations(all, now), [all, now]);
  const providers = [...new Set(list.map((c) => c.session.provider))];
  const anyInBackup = list.some((c) => c.session.backup);
  // A filter whose last entry went away falls back to everything, so the list never strands empty.
  const current: Show = show === "backup" && !anyInBackup ? "all" : show;
  const needle = query.trim().toLowerCase();
  const shown = list.filter((c) => {
    const node = owners.get(sessionKey(c.session));
    if (agent !== "all" && c.session.provider !== agent) return false;
    if (current === "short" && !c.short) return false;
    if (current === "old" && now - Date.parse(c.updatedAt) < 30 * DAY)
      return false;
    if (current === "outside" && node) return false;
    if (current === "kept" && !c.session.kept) return false;
    if (current === "backup" && !c.session.backup) return false;
    if (!needle) return true;
    return [
      c.title,
      c.session.firstPrompt,
      c.session.lastPrompt,
      node?.label,
      node?.path,
      c.session.cwd,
    ].some((text) => text?.toLowerCase().includes(needle));
  });
  const projectOf = (session: Session) => owners.get(sessionKey(session));
  const groups = useMemo(() => {
    const map = new Map<string, { node?: Node; items: Conversation[] }>();
    for (const c of shown) {
      const node = owners.get(sessionKey(c.session));
      const key = node?.id ?? "";
      const group = map.get(key) ?? { node, items: [] };
      group.items.push(c);
      map.set(key, group);
    }
    // Projects by their newest conversation; chats outside projects last.
    return [...map.values()].sort((a, b) =>
      !a.node !== !b.node
        ? Number(!a.node) - Number(!b.node)
        : b.items[0].updatedAt.localeCompare(a.items[0].updatedAt),
    );
  }, [shown, owners]);
  const chosen = list.filter((c) => picked.has(conversationKey(c)));
  const selection: Selection = {
    has: (c) => picked.has(conversationKey(c)),
    toggle: (c) =>
      setPicked((current) => {
        const next = new Set(current);
        const key = conversationKey(c);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
  };
  const selectable = shown.filter((c) => deletable(c));
  const allPicked =
    selectable.length > 0 &&
    selectable.every((c) => picked.has(conversationKey(c)));
  const chip = (label: string, on: boolean, click: () => void) => (
    <button className="chipf" key={label} aria-pressed={on} onClick={click}>
      {label}
    </button>
  );
  const shortCount = list.filter((c) => c.short).length;
  return (
    <Group
      title="Sessions"
      count={list.length}
      hint={
        shortCount
          ? `${plural(shortCount, "short chat")} folded away`
          : undefined
      }
    >
      <div className="agent-filters">
        <input
          className="inp"
          type="search"
          name="sessionSearch"
          aria-label="Search sessions"
          placeholder="Search titles, prompts and projects"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="showbar" role="group" aria-label="Arrange">
          {chip("By project", !flat, () => setFlat(false))}
          {chip("Newest first", flat, () => setFlat(true))}
        </div>
        {providers.length > 1 ? (
          <div className="showbar" role="group" aria-label="Agent">
            {chip("All agents", agent === "all", () => setAgent("all"))}
            {providers.map((provider) =>
              chip(providerName(snapshot, provider), agent === provider, () =>
                setAgent(provider),
              ),
            )}
          </div>
        ) : null}
        <div className="showbar" role="group" aria-label="Show">
          {chip("All", current === "all", () => setShow("all"))}
          {chip("Short chats", current === "short", () => setShow("short"))}
          {chip("Older than 30 days", current === "old", () => setShow("old"))}
          {chip("Outside projects", current === "outside", () =>
            setShow("outside"),
          )}
          {list.some((c) => c.session.kept)
            ? chip("Kept", current === "kept", () => setShow("kept"))
            : null}
          {anyInBackup
            ? chip("In backup only", current === "backup", () =>
                setShow("backup"),
              )
            : null}
        </div>
      </div>
      <div className={`session-bulk${chosen.length ? " on" : ""}`}>
        <label className="pick-all">
          <input
            type="checkbox"
            className="cb"
            checked={allPicked}
            disabled={!selectable.length}
            onChange={() =>
              setPicked(
                allPicked
                  ? new Set()
                  : new Set(selectable.map((c) => conversationKey(c))),
              )
            }
          />
          {chosen.length
            ? `${plural(chosen.length, "session")} selected · ${bytes(chosen.reduce((n, c) => n + c.bytes, 0))}`
            : `Select all ${selectable.length} shown`}
        </label>
        {chosen.length ? (
          <>
            <button
              className="btn sm ghost"
              disabled={s.historyPending}
              onClick={() => {
                keepSessions(chosen, true);
                setPicked(new Set());
              }}
            >
              <Icon name="keep" className="sm" />
              Keep
            </button>
            <button
              className="btn sm danger"
              disabled={s.historyPending}
              onClick={() => {
                useApp.setState({
                  modal: {
                    kind: "session-delete",
                    files: chosen.map((c) => c.session.file),
                  },
                });
                setPicked(new Set());
              }}
            >
              <Icon name="delete" className="sm" />
              Delete…
            </button>
            <button
              className="btn sm ghost"
              onClick={() => setPicked(new Set())}
            >
              Clear
            </button>
          </>
        ) : null}
      </div>
      {!shown.length ? (
        <div className="empty">No sessions match</div>
      ) : flat ? (
        <>
          <ConversationRows
            items={shown}
            projectOf={projectOf}
            selection={selection}
            limit={s.showAll ? undefined : SESSION_LIMIT}
            fold={current !== "short"}
          />
          {shown.length > SESSION_LIMIT ? (
            <Expand name={MORE} count={shown.length} />
          ) : null}
        </>
      ) : (
        groups.map(({ node, items }) => (
          <SessionGroupBlock
            key={node?.id ?? "outside"}
            node={node}
            items={items}
            selection={selection}
            fold={current !== "short"}
          />
        ))
      )}
    </Group>
  );
}

const GROUP_LIMIT = 5;
function SessionGroupBlock({
  node,
  items,
  selection,
  fold,
}: {
  node?: Node;
  items: Conversation[];
  selection: Selection;
  fold: boolean;
}) {
  const key = `agents:group:${node?.id ?? "outside"}`;
  const { toggled, all, select } = useApp(
    useShallow((state) => ({
      toggled: !!state.expanded[key],
      all: !!state.expanded[`${key}:all`],
      select: state.select,
    })),
  );
  // Chats outside projects are mostly quick questions: closed until asked for.
  const open = node ? !toggled : toggled;
  const shownRows = fold ? items.filter((c) => !c.short).length : items.length;
  return (
    <section className="session-block">
      <div className="session-block-h">
        <button
          className="linkbtn toggle"
          aria-expanded={open}
          onClick={() => toggleExpanded(key)}
        >
          <Icon name="chev" className={`sm ${open ? "open" : ""}`} />
          {node ? (
            <KindIcon node={node} />
          ) : (
            <Icon name="home" className="sm" />
          )}
          <b>{node ? node.label : "Outside projects"}</b>
        </button>
        <span className="faint">
          {plural(items.length, "session")} ·{" "}
          {bytes(items.reduce((n, c) => n + c.bytes, 0))}
        </span>
        <span className="grow" />
        {node ? (
          <button
            className="btn sm ghost"
            onClick={() => select(node.id, "agents")}
          >
            Open project
          </button>
        ) : null}
      </div>
      {open ? (
        <>
          <ConversationRows
            items={items}
            projectPath={node?.id}
            projectOf={node ? undefined : () => undefined}
            selection={selection}
            fold={fold}
            limit={all ? undefined : GROUP_LIMIT}
          />
          {shownRows > GROUP_LIMIT ? (
            <button
              className="more"
              onClick={() => toggleExpanded(`${key}:all`)}
            >
              {all ? "Show fewer" : `Show all ${shownRows}`}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function StorageSection() {
  const open = useApp((state) => !!state.expanded[STORAGE]);
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
  const s = useApp(
    useShallow((state) => ({
      snapshot: state.snapshot!,
      selected: state.selected,
      select: state.select,
      navigate: state.navigate,
    })),
  );
  const snapshot = s.snapshot;
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
      <LaciStorage />
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
