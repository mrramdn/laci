import { Icon, Group, Ops } from "../common";
import { useApp, run, changed, toggleExpanded } from "../store";
import { cap, plural } from "../helpers";
import { api } from "../api";
import type { Change } from "../types";
const CATS: Record<string, [string, string, string]> = {
  reconnect: [
    "Reconnect",
    "link",
    "History that lost its folder, and where it probably went",
  ],
  migration: [
    "Half-done moves",
    "route",
    "Folders moved before, with history still pointing at the old place",
  ],
  space: [
    "Free space",
    "drive",
    "Dependencies and build output in projects you don’t use",
  ],
  duplicate: ["Duplicates", "layers", "The same repo cloned more than once"],
  orphan: ["Orphaned", "unlink", "History for folders that no longer exist"],
  status: ["Archive", "archive", "Projects with no activity for a long time"],
};
export function Tidy() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const counts: Record<string, number> = {};
  for (const p of snapshot.proposals)
    counts[p.category] = (counts[p.category] ?? 0) + 1;
  return (
    <>
      <div className="head">
        <h1>Tidy up</h1>
        <span className="count">
          {plural(snapshot.proposals.length, "suggestion")}
        </span>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>
          Review changes before applying. Undo journaled changes in Log; restore
          deleted projects from Trash.
        </span>
      </div>
      <div className="filterbar">
        <div className="showbar" role="group" aria-label="Show">
          <button
            className="chipf"
            aria-pressed={s.tidyFilter === "all"}
            onClick={() => useApp.setState({ tidyFilter: "all" })}
          >
            All <span className="n">{snapshot.proposals.length}</span>
          </button>
          {Object.entries(CATS)
            .filter(([key]) => counts[key])
            .map(([key, [label, icon, hint]]) => (
              <button
                className="chipf"
                key={key}
                aria-pressed={s.tidyFilter === key}
                title={hint}
                onClick={() => useApp.setState({ tidyFilter: key })}
              >
                <Icon name={icon} className="sm" />
                {label}
                <span className="n">{counts[key]}</span>
              </button>
            ))}
        </div>
      </div>
      <div className="body">
        {Object.entries(CATS)
          .filter(
            ([key]) =>
              counts[key] && (s.tidyFilter === "all" || s.tidyFilter === key),
          )
          .map(([key, [title, icon, hint]]) => (
            <Group
              key={key}
              title={title}
              icon={icon}
              count={counts[key]}
              hint={hint}
              order="Surest first"
            >
              {snapshot.proposals
                .filter((p) => p.category === key)
                .sort(
                  (a, b) =>
                    ({ high: 0, med: 1, low: 2 })[a.confidence] -
                    { high: 0, med: 1, low: 2 }[b.confidence],
                )
                .map((p) => (
                  <div
                    className="prop-row"
                    data-id={p.id}
                    key={p.id}
                    data-open={!!s.expanded[p.id]}
                  >
                    <div
                      className="item"
                      tabIndex={0}
                      aria-expanded={!!s.expanded[p.id]}
                      onClick={() => toggleExpanded(p.id)}
                    >
                      <Icon name="chev" className="sm chev" />
                      <span
                        className="name"
                        style={{
                          maxWidth: "none",
                          flex: 1,
                          whiteSpace: "normal",
                        }}
                      >
                        {p.title}
                      </span>
                      <span className="meta">
                        <span className={`conf ${p.confidence}`}>
                          {cap(p.confidence)} confidence
                        </span>
                        <span>{plural(p.ops.length, "change")}</span>
                      </span>
                    </div>
                    {s.expanded[p.id] ? (
                      <div className="prop-body">
                        <p>{p.why}</p>
                        <Ops ops={p.ops} />
                        <div className="row-acts">
                          {p.action ? (
                            <button
                              className="btn sm primary"
                              disabled={s.historyPending}
                              onClick={() => {
                                if (p.category === "orphan") {
                                  useApp.setState({
                                    modal: { kind: "orphan", id: p.id },
                                  });
                                  return;
                                }
                                if (p.action?.type === "archive") {
                                  useApp.setState({
                                    modal: {
                                      kind: "archive",
                                      id: p.action.nodeId,
                                    },
                                  });
                                  return;
                                }
                                void run(
                                  async () =>
                                    changed(
                                      await api<Change>("apply", { id: p.id }),
                                      "Changes applied",
                                    ),
                                  "Applying changes…",
                                  { history: true },
                                );
                              }}
                            >
                              {p.category === "orphan"
                                ? "Review history…"
                                : p.action.type === "archive"
                                  ? "Archive…"
                                  : `Apply ${plural(p.ops.length, "change")}`}
                            </button>
                          ) : (
                            <span className="muted" style={{ fontSize: 12 }}>
                              Nothing to apply automatically. Open both and
                              decide which one to keep.
                            </span>
                          )}
                          {p.action?.type === "archive" && p.nodeId ? (
                            <button
                              className="btn sm"
                              disabled={s.historyPending}
                              onClick={() =>
                                useApp.setState({
                                  modal: { kind: "delete", id: p.nodeId! },
                                })
                              }
                            >
                              Move to Trash…
                            </button>
                          ) : null}
                          {p.nodeId && snapshot.nodes[p.nodeId] ? (
                            <>
                              <span className="grow" />
                              <button
                                className="btn sm ghost"
                                onClick={() => s.select(p.nodeId!)}
                              >
                                Open {snapshot.nodes[p.nodeId].label}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
            </Group>
          ))}
        {!Object.keys(CATS).some(
          (key) =>
            counts[key] && (s.tidyFilter === "all" || s.tidyFilter === key),
        ) ? (
          <div className="empty">
            {s.historyPending ? "Updating…" : "Nothing to tidy here."}
          </div>
        ) : null}
      </div>
    </>
  );
}
