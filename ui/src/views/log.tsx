import { useEffect, useState } from "react";
import { Icon, Time, Group, Ops } from "../common";
import { useApp, run, changed, toggleExpanded, refreshLog } from "../store";
import { useNow } from "../clock";
import { dayLabel, logKind, plural } from "../helpers";
import { api } from "../api";
import type { Change } from "../types";
const LOG_FILTERS = [
  ["all", "All"],
  ["moves", "Moves and archives"],
  ["projects", "Project edits"],
  ["setup", "Settings"],
  ["agent", "By agents"],
];
export function LogView() {
  const s = useApp();
  useNow();
  const [query, setQuery] = useState("");
  const [undoable, setUndoable] = useState(false);
  const log = s.activity;
  useEffect(() => {
    void refreshLog();
  }, []);
  const filter = (
    entry: NonNullable<typeof log>["entries"][number],
    key: string,
  ) =>
    key === "moves"
      ? logKind(entry) === "move"
      : key === "projects"
        ? ["meta", "todo", "notes", "new"].includes(logKind(entry))
        : key === "setup"
          ? logKind(entry) === "setup"
          : key === "agent"
            ? entry.by === "agent"
            : true;
  const needle = query.trim().toLowerCase();
  const canUndo = log?.entries.filter((e) => e.canUndo).length ?? 0;
  const narrow = (e: NonNullable<typeof log>["entries"][number]) =>
    (!undoable || !!e.canUndo) &&
    (!needle ||
      [e.title, e.detail, e.path].some((text) =>
        text?.toLowerCase().includes(needle),
      ));
  const groups = new Map<string, NonNullable<typeof log>["entries"]>();
  for (const entry of log?.entries.filter(
    (e) => filter(e, s.logFilter) && narrow(e),
  ) ?? []) {
    const label = dayLabel(new Date(entry.at));
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }
  const icons: Record<string, string> = {
    undo: "undo",
    move: "route",
    meta: "rename",
    todo: "keep",
    notes: "file",
    setup: "gear",
    new: "plus",
    other: "history",
  };
  return (
    <>
      <div className="head">
        <h1>Log</h1>
        <span className="count">
          {log ? plural(log.entries.length, "change") : ""}
        </span>
        <span className="grow" />
        <button
          className="btn sm ghost"
          title={log?.file}
          onClick={() => void run(() => api("log/open"))}
        >
          <Icon name="file" className="sm" />
          Debug log
        </button>
      </div>
      <div className="filterbar">
        <div className="showbar" role="group" aria-label="Show">
          {LOG_FILTERS.map(([key, label]) => (
            <button
              className="chipf"
              key={key}
              aria-pressed={s.logFilter === key}
              onClick={() => useApp.setState({ logFilter: key })}
            >
              {label}
              {key !== "all" ? (
                <span className="n">
                  {log?.entries.filter((e) => filter(e, key)).length ?? 0}
                </span>
              ) : null}
            </button>
          ))}
          {canUndo ? (
            <button
              className="chipf"
              aria-pressed={undoable}
              onClick={() => setUndoable(!undoable)}
            >
              Can undo
              <span className="n">{canUndo}</span>
            </button>
          ) : null}
        </div>
        <span className="grow" />
        <input
          className="inp log-search"
          type="search"
          name="logSearch"
          aria-label="Search the log"
          placeholder="Search the log"
          title="Everything laci changed, from the app or an agent, newest first"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="body">
        {!log ? (
          <div className="empty">Reading the log…</div>
        ) : log.error ? (
          <div className="empty">{log.error}</div>
        ) : (
          [...groups.entries()].map(([label, entries]) => (
            <Group title={label} count={entries.length} key={label}>
              {entries.map((entry) => {
                const key = "log:" + entry.id;
                const open = !!s.expanded[key];
                const more = !!entry.steps?.length || !!entry.error;
                const n = entry.path
                  ? s.snapshot?.nodes[entry.path]
                  : undefined;
                return (
                  <div className="prop-row" data-open={open} key={entry.id}>
                    <div
                      className="item two"
                      tabIndex={more ? 0 : undefined}
                      aria-expanded={more ? open : undefined}
                      onClick={() => more && toggleExpanded(key)}
                    >
                      {more ? <Icon name="chev" className="sm chev" /> : null}
                      <Icon name={icons[logKind(entry)]} />
                      <div className="lines">
                        <div className="l1">
                          <span
                            className="t"
                            style={{ maxWidth: "none", whiteSpace: "normal" }}
                          >
                            {entry.title}
                          </span>
                          {n && !entry.title.includes(n.name) ? (
                            <span className="pill">{n.label}</span>
                          ) : null}
                        </div>
                        {entry.detail ? (
                          <div className="l2">
                            <span>{entry.detail}</span>
                          </div>
                        ) : null}
                      </div>
                      <span className="meta">
                        {entry.by === "agent" ? (
                          <span className="pill">
                            <Icon name="bot" className="sm" />
                            Agent
                          </span>
                        ) : null}
                        {entry.state === "undone" ? (
                          <span className="pill">Undone</span>
                        ) : entry.state === "failed" ||
                          entry.state === "running" ? (
                          <span className="pill bad">
                            {entry.state === "failed"
                              ? "Failed"
                              : "Didn’t finish"}
                          </span>
                        ) : null}
                        {entry.canUndo ? (
                          <button
                            className="btn sm act"
                            disabled={s.historyPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              void run(
                                async () => {
                                  changed(
                                    await api<Change>("log/undo", {
                                      id: entry.id,
                                    }),
                                    "Undone",
                                  );
                                },
                                "Undoing…",
                                { history: true },
                              );
                            }}
                          >
                            <Icon name="undo" className="sm" />
                            Undo
                          </button>
                        ) : entry.superseded ? (
                          <span
                            className="faint"
                            style={{ fontSize: 12 }}
                            title="Changed again later. Undo the newer change first."
                          >
                            Changed since
                          </span>
                        ) : null}
                        <span className="mono">
                          <Time at={entry.at} long />
                        </span>
                      </span>
                    </div>
                    {open ? (
                      <div className="prop-body">
                        {entry.error ? (
                          <p style={{ color: "var(--red)" }}>{entry.error}</p>
                        ) : null}
                        {entry.steps?.length ? <Ops ops={entry.steps} /> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </Group>
          ))
        )}
        {log && !log.error && !groups.size && log.entries.length ? (
          <div className="empty">No entries match</div>
        ) : log && !log.error && !groups.size ? (
          <div className="empty">
            Nothing yet. Moves, archives, status changes, to-dos and notes show
            up here, with a way to undo them.
          </div>
        ) : null}
      </div>
    </>
  );
}
