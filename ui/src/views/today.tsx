import {
  Icon,
  StatusGlyph,
  SeverityGlyph,
  Time,
  FixButton,
  Group,
  Expand,
} from "../common";
import { useApp, backup, run } from "../store";
import { plural, recency, risksOf, sessionsOf, taskIdentity } from "../helpers";
import { api } from "../api";
import { requestResume } from "../session-ui";
import type { Node } from "../types";
export function Today() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const all = Object.values(snapshot.nodes);
  const risks = risksOf(snapshot);
  const recent = all
    .filter((n) => n.kind === "project" && !n.archived)
    .sort(recency)
    .slice(0, 5);
  const activeCount = all.filter(
    (n) => n.kind === "project" && !n.archived && n.status.value === "active",
  ).length;
  const checks = all
    .filter((n) => !n.archived)
    .sort(recency)
    .flatMap((n) =>
      n.tasks
        .filter((t) => t.kind === "check" && !t.done)
        .map((t) => ({ n, t })),
    );
  const handoffs = all
    .flatMap((n) =>
      n.taskFiles
        .map((f) => ({
          n,
          f,
          open: n.tasks.filter(
            (t) => t.file === f.file && t.kind === "list" && !t.done,
          ).length,
        }))
        .filter((h) => h.open && !n.archived),
    )
    .sort((a, b) => b.f.at.localeCompare(a.f.at));
  if (!snapshot.roots.length)
    return (
      <>
        <div className="head">
          <h1>Today</h1>
        </div>
        <div className="body">
          <div className="empty-box">
            <Icon name="folder" />
            <b>No folders selected yet</b>
            <p>
              Choose the folders that hold your projects and Laci will list them
              here.
            </p>
            <button
              className="btn primary"
              onClick={() => s.navigate("settings")}
            >
              Choose folders
            </button>
          </div>
        </div>
      </>
    );
  return (
    <>
      <div className="head">
        <h1>Today</h1>
        <span className="count">
          {new Date().toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </span>
        <span className="grow" />
        <div className="quick-stats" role="group" aria-label="Quick jump">
          {[
            [risks.length, "at risk", "alert", "sec-risks", "bad"],
            [activeCount, "active", "play", "sec-recent", ""],
            [checks.length, "to-dos", "check", "sec-todos", ""],
          ].map(([count, label, icon, id, className]) =>
            count || id === "sec-recent" ? (
              <button
                className={`chip-stat ${className}`}
                key={String(id)}
                title={`Jump to ${label}`}
                onClick={() =>
                  document
                    .getElementById(String(id))
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                <Icon name={String(icon)} className="sm" />
                <b>{count}</b> {label}
              </button>
            ) : null,
          )}
        </div>
      </div>
      <div className="body">
        {snapshot.warnings.map((warning, i) => (
          <div className="callout" key={i}>
            <Icon name="alert" />
            <div className="txt">
              <b>{warning.title}</b>
              <p>{warning.detail}</p>
            </div>
            <button className="btn sm" onClick={backup}>
              Back up logs now
            </button>
          </div>
        ))}
        <Group
          title="Could lose work"
          icon="alert"
          count={risks.length}
          hint="Only on this disk, or never committed"
          order="Worst first, then most recent"
          id="sec-risks"
        >
          {risks.slice(0, s.expanded.risks ? undefined : 8).map(({ n, i }) => (
            <div
              className="item"
              key={`${n.id}:${i.code}`}
              tabIndex={0}
              data-id={n.id}
              aria-selected={s.selected === n.id}
              onClick={() => s.select(n.id)}
            >
              <SeverityGlyph severity={i.severity} />
              <span className="name">{n.label}</span>
              <span
                className={`badge ${i.severity === "high" ? "danger" : "warn"}`}
              >
                {i.title}
              </span>
              <span className="d" style={{ marginLeft: 6 }}>
                {i.detail}
              </span>
              <span className="meta">
                <FixButton node={n} code={i.code} className="act always" />
                {n.archived ? <span className="pill">Archived</span> : null}
                <span className="mono">
                  <Time at={n.lastActivity?.at} />
                </span>
              </span>
            </div>
          ))}
          {!risks.length ? (
            <div className="empty">
              No Git issues found in the scanned projects.
            </div>
          ) : null}
          {risks.length > 8 ? (
            <div className="item">
              <Expand name="risks" count={risks.length} />
            </div>
          ) : null}
        </Group>
        <Group
          title="Pick up where you left off"
          icon="play"
          count={recent.length}
          order="Most recent first"
          id="sec-recent"
        >
          {recent.map((n) => {
            const session = sessionsOf(n, snapshot).find(
              (session) => !session.parentId,
            );
            return (
              <div
                className="item two"
                key={n.id}
                tabIndex={0}
                data-id={n.id}
                aria-selected={s.selected === n.id}
                onClick={() => s.select(n.id)}
              >
                <StatusGlyph status={n.status.value} />
                <div className="lines">
                  <div className="l1">
                    <span className="name">{n.label}</span>
                    {n.git?.branch ? (
                      <span className={`pill ${n.git.dirty ? "warn" : ""}`}>
                        <Icon name="branch" className="sm" />
                        {n.git.branch}
                        {n.git.dirty ? ` · ${n.git.dirty} changed` : ""}
                      </span>
                    ) : null}
                  </div>
                  {n.git?.lastSubject ? (
                    <div className="l2">
                      <Icon name="commit" />
                      <span>{n.git.lastSubject}</span>
                    </div>
                  ) : !session ? (
                    <div className="l2">
                      <span>
                        {n.summary?.text ?? (
                          <>
                            Files changed <Time at={n.lastActivity?.at} long />
                          </>
                        )}
                      </span>
                    </div>
                  ) : null}
                  {session ? (
                    <div className="l2">
                      <Icon name="bot" />
                      <span>{session.title ?? "Untitled session"}</span>
                      <span className="faint">
                        · <Time at={session.updatedAt} />
                      </span>
                    </div>
                  ) : null}
                </div>
                <span className="meta">
                  {session?.resumeCapability === "supported" ? (
                    <button
                      className="btn sm act"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestResume(session, n.id);
                      }}
                    >
                      <Icon name="terminal" className="sm" />
                      Resume
                    </button>
                  ) : null}
                  <span className="mono">
                    <Time at={n.lastActivity?.at} />
                  </span>
                </span>
              </div>
            );
          })}
          {!recent.length ? (
            <div className="empty">No projects found in your folders yet.</div>
          ) : null}
        </Group>
        <Group
          title="Open to-dos"
          icon="check"
          count={checks.length}
          hint="Checkboxes in your notes, plus next steps you add"
          order="By project, most recent first"
          id="sec-todos"
        >
          {checks.map(({ n, t }) => (
            <label className="item" key={`${n.id}:${t.file}:${t.line}`}>
              <input
                type="checkbox"
                className="cb"
                checked={t.done}
                onChange={(e) =>
                  void run(async () =>
                    s.patch(
                      await api<Node>("todo", {
                        id: n.id,
                        op: "toggle",
                        file: t.file,
                        line: t.line,
                        text: t.text,
                        ...taskIdentity(n, t),
                        done: e.target.checked,
                      }),
                    ),
                  )
                }
              />
              <span
                className="t"
                style={{ maxWidth: "none", flex: 1, whiteSpace: "normal" }}
              >
                {t.text}
              </span>
              <span className="meta">
                <span className="pill">{n.label}</span>
                <span className="mono">
                  {t.file}:{t.line}
                </span>
              </span>
            </label>
          ))}
          {!checks.length ? (
            <div className="empty">
              No open checkboxes. Add the next step from a project’s To-do tab.
            </div>
          ) : null}
        </Group>
        {handoffs.length ? (
          <Group
            title="Handoffs with open items"
            icon="file"
            count={handoffs.length}
            order="Most recently edited first"
          >
            {handoffs.map(({ n, f, open }) => (
              <div
                className="item"
                key={`${n.id}:${f.file}`}
                tabIndex={0}
                data-id={n.id}
                onClick={() => s.select(n.id, "todo")}
              >
                <Icon name="file" />
                <span className="name mono" style={{ fontWeight: 400 }}>
                  {f.file}
                </span>
                <span className="d">
                  {n.label} · {plural(open, "item")} under a TODO heading
                </span>
                <span className="meta">
                  <span className="mono">
                    <Time at={f.at} />
                  </span>
                </span>
              </div>
            ))}
          </Group>
        ) : null}
      </div>
    </>
  );
}
