import { Icon, KindIcon, Time, Group } from "../common";
import { useApp, backup, run, changed } from "../store";
import {
  agentCount,
  base,
  bytes,
  date,
  plural,
  sessionsOf,
  globalSessions,
  hasSessionFile,
  tilde,
  counted,
} from "../helpers";
import { api } from "../api";
import { SessionList } from "../session-ui";
import type { Change } from "../types";
export function AgentsView() {
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
      return dir
        ? [
            {
              name: key,
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
  const outsideSessions = globalSessions(snapshot);
  const globalDirs = snapshot.global.claude.flatMap((id) =>
    snapshot.claude[id]?.memory.length ? [snapshot.claude[id]] : [],
  );
  const globalItems = snapshot.global.items.flatMap((id) =>
    snapshot.items[id] && !hasSessionFile(snapshot.items[id].file, snapshot)
      ? [snapshot.items[id]]
      : [],
  );
  return (
    <>
      <div className="head">
        <h1>Agent history</h1>
        <span className="count">
          {snapshot.connectors.length
            ? plural(snapshot.connectors.length, "connector")
            : "No connectors yet"}
        </span>
        <span className="grow" />
        {snapshot.connectors.length ? (
          <button className="btn sm" onClick={backup}>
            Back up logs now
          </button>
        ) : null}
      </div>
      <div className="body">
        {snapshot.suggestions
          .filter((x) => x.found)
          .map((x) => (
            <div className="callout" key={x.id}>
              <Icon name="sparkles" />
              <div className="txt">
                <b>{x.name} history found on this PC</b>
                <p>
                  {x.about}
                  {x.detail ? ` · ${x.detail}` : ""}. Add it so it shows on
                  projects and moves with them.
                </p>
              </div>
              <button
                className="btn sm"
                disabled={s.historyPending}
                onClick={() => addPreset(x.id)}
              >
                Add {x.name}
              </button>
            </div>
          ))}
        {snapshot.connectors.length ? (
          <div className="stats">
            {snapshot.connectors.map((c) => (
              <div className="stat" key={c.id}>
                <div className="top">
                  <span className="k">{c.name}</span>
                  {!c.builtin ? <span className="tag">Custom</span> : null}
                </div>
                <div className={`v ${!c.present ? "none" : ""}`}>
                  {c.present ? bytes(c.bytes) : "Nothing here yet"}
                </div>
                <p>
                  {c.about}
                  {c.present && c.id !== "claude"
                    ? ` · ${plural(c.count, c.link.kind === "cwd" ? "log" : c.link.kind === "named" ? "folder" : "file")}`
                    : ""}
                </p>
                <div className="p">{c.where}</div>
                <div className="mv">
                  On move: {c.moves.charAt(0).toLowerCase() + c.moves.slice(1)}
                </div>
                <div className="foot">
                  <span className="grow" />
                  <button
                    className="btn sm ghost"
                    disabled={s.historyPending}
                    onClick={() =>
                      void run(
                        async () => {
                          changed(
                            await api<Change>("connector/remove", { id: c.id }),
                            `Removed ${c.name}`,
                            "Its files stay where they are, but laci no longer shows them or moves them with projects.",
                          );
                        },
                        "Removing connector…",
                        { history: true },
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              className="stat add"
              disabled={s.historyPending}
              onClick={() => useApp.setState({ modal: { kind: "connector" } })}
            >
              <Icon name="plus" />
              <span>Add a connector</span>
              <small className="faint">Another AI tool you use</small>
            </button>
          </div>
        ) : (
          <div className="empty-hero">
            <h2>Connect the AI tools you use</h2>
            <p>
              laci reads where each tool keeps its sessions, shows them on the
              right project, and carries them along when you move or archive
              one.
            </p>
            <button
              className="btn primary"
              disabled={s.historyPending}
              onClick={() => useApp.setState({ modal: { kind: "connector" } })}
            >
              <Icon name="plus" className="sm" />
              Add a connector
            </button>
          </div>
        )}
        {snapshot.connectors.length ? (
          <>
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
                  No detached history found. Unavailable locations stay
                  protected from cleanup.
                </div>
              ) : null}
            </Group>
            <Group title="By project" count={linked.length}>
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
                      <i
                        style={{
                          width: `${Math.max(2, (b / maximum) * 100)}%`,
                        }}
                      />
                    </span>
                    <span
                      className="mono"
                      style={{ width: 56, textAlign: "right" }}
                    >
                      {bytes(b)}
                    </span>
                  </span>
                </div>
              ))}
              {!linked.length ? (
                <div className="empty">No project has agent history yet.</div>
              ) : null}
            </Group>
          </>
        ) : null}
        {outsideSessions.length ? (
          <Group
            title="Sessions outside project folders"
            count={outsideSessions.length}
            hint="Includes Home sessions and folders outside the scan"
          >
            <SessionList sessions={outsideSessions} />
          </Group>
        ) : null}
        {globalDirs.length || globalItems.length ? (
          <Group
            title="Outside project folders"
            count={globalDirs.length + globalItems.length}
          >
            {globalDirs.map((c) => (
              <div className="item" key={c.name}>
                <Icon name="folder" />
                <span className="name mono" style={{ fontWeight: 400 }}>
                  {tilde(c.path, snapshot.home)}
                </span>
                <span className="d">
                  {plural(c.memory.length, "memory file")}
                </span>
                <span className="meta">
                  <span className="mono">{bytes(c.bytes)}</span>
                </span>
              </div>
            ))}
            {globalItems.map((item) => (
              <div className="item" key={item.id}>
                <Icon name="bot" />
                <span className="name mono">
                  {tilde(item.cwd ?? item.file, snapshot.home)}
                </span>
                <span className="d">
                  {
                    snapshot.connectors.find((c) => c.id === item.connector)
                      ?.name
                  }
                </span>
                <span className="meta">
                  <span className="mono">{bytes(item.bytes)}</span>
                  <Time at={item.at} />
                </span>
              </div>
            ))}
          </Group>
        ) : null}
        {snapshot.unmatched.length ? (
          <Group
            title="Not matched"
            count={snapshot.unmatched.length}
            hint="Named by a hash of a folder laci didn't scan"
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
                          snapshot.connectors.find(
                            (c) => c.id === item.connector,
                          )?.name
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
    </>
  );
}
