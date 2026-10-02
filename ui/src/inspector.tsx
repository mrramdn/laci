import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, errorText } from "./api";
import { useApp, external, run, toast, urlOpen } from "./store";
import {
  agentCount,
  APP_NAMES,
  base,
  bytes,
  cap,
  date,
  descendants,
  plural,
  sessionsOf,
  taskIdentity,
  tilde,
} from "./helpers";
import {
  Expand,
  FixButton,
  Icon,
  KindIcon,
  PriorityGlyph,
  SeverityGlyph,
  StatusGlyph,
  Time,
} from "./common";
import { openTerminal } from "./terminal-api";
import type { Node, Snapshot, Task } from "./types";
export function Inspector({ node: n }: { node: Node }) {
  const s = useApp();
  const snapshot = s.snapshot!;
  const sessions = sessionsOf(n, snapshot);
  const parent = n.parent ? snapshot.nodes[n.parent] : null;
  const git = n.git;
  const remote = git?.remotes[0];
  const isProject = n.kind === "project";
  const tabs: [string, string, number][] = [
    ["health", "Health", 0],
    ["todo", "To-do", n.tasks.filter((t) => !t.done).length],
    ["agents", "Agents", agentCount(n, snapshot)],
    ...(n.readme ? [["readme", "README", 0] as [string, string, number]] : []),
  ];
  const active = tabs.some((t) => t[0] === s.tab) ? s.tab : "health";
  const meta = (key: string, value: string) =>
    void run(async () => {
      s.patch(await api<Node>("meta", { id: n.id, key, value }));
    });
  return (
    <aside id="insp" className="insp" aria-label="Details">
      <div className="head">
        <div className="ih-crumb">
          {parent ? (
            <>
              <span>{parent.name}</span>
              <Icon name="chev" className="sm" />
            </>
          ) : null}
          <b>{n.name}</b>
        </div>
        <span className="grow" />
        <button
          className="icon-btn"
          title="Copy path"
          aria-label="Copy path"
          onClick={() =>
            void run(async () => {
              await navigator.clipboard.writeText(n.path);
              toast("Path copied", tilde(n.path, snapshot.home));
            })
          }
        >
          <Icon name="copy" />
        </button>
        <button
          className="icon-btn"
          title="Close (Esc)"
          aria-label="Close details"
          onClick={() => useApp.setState({ selected: null })}
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="ibody">
        <div className="ititle">
          <h2>
            <KindIcon node={n} />
            {n.name}
          </h2>
          <div className="path mono">{tilde(n.path, snapshot.home)}</div>
          {n.summary ? (
            <p className="sum">
              {n.summary.text} <span className="src">— {n.summary.source}</span>
            </p>
          ) : isProject ? (
            <p className="sum muted">
              No summary yet.{" "}
              <button
                className="linkbtn"
                onClick={() => void openTerminal(n.id, "summary")}
              >
                Ask Claude to write one
              </button>
            </p>
          ) : null}
          {n.readme?.title &&
          !n.readme.weakTitle &&
          n.readme.title.toLowerCase() !== n.name.toLowerCase() ? (
            <p className="aka">README title: {n.readme.title}</p>
          ) : null}
          <div className="iacts">
            <button
              className="btn primary sm"
              onClick={() =>
                void openTerminal(
                  n.id,
                  sessions[0] ? "resume" : "shell",
                  sessions[0]?.id,
                )
              }
            >
              <Icon name="terminal" className="sm" />
              {sessions[0] ? "Resume last session" : "Terminal"}
            </button>
            <button className="btn sm" onClick={() => external(n.id, "editor")}>
              <Icon name="editor" className="sm" />
              {APP_NAMES[s.apps.editor] ?? cap(s.apps.editor)}
            </button>
            <button className="btn sm" onClick={() => external(n.id, "files")}>
              <Icon name="open" className="sm" />
              {APP_NAMES[s.apps.files] ?? cap(s.apps.files)}
            </button>
            {isProject && !n.archived && n.archivePlan ? (
              <button
                className="btn ghost sm"
                title="Archive project"
                onClick={() =>
                  useApp.setState({ modal: { kind: "archive", id: n.id } })
                }
              >
                <Icon name="archive" className="sm" />
                Archive
              </button>
            ) : null}
          </div>
        </div>
        <dl className="props">
          <dt>Status</dt>
          <dd>
            <label className="pbtn">
              <StatusGlyph status={n.status.value} />
              <span>{cap(n.status.value)}</span>
              {n.status.auto ? <span className="sub">auto</span> : null}
              <select
                value={n.status.auto ? "" : n.status.value}
                onChange={(e) => meta("status", e.target.value)}
                aria-label="Status"
              >
                <option value="">Automatic</option>
                {[
                  "active",
                  "idle",
                  "dormant",
                  "idea",
                  "paused",
                  "done",
                  "archived",
                ].map((status) => (
                  <option key={status} value={status}>
                    {cap(status)}
                  </option>
                ))}
              </select>
            </label>
          </dd>
          <dt>Priority</dt>
          <dd>
            <label className={`pbtn ${!n.meta.priority ? "placeholder" : ""}`}>
              <PriorityGlyph priority={n.meta.priority} />
              <span>
                {n.meta.priority ? cap(n.meta.priority) : "No priority"}
              </span>
              <select
                value={n.meta.priority ?? ""}
                onChange={(e) => meta("priority", e.target.value)}
                aria-label="Priority"
              >
                {["", "high", "medium", "low"].map((p) => (
                  <option key={p} value={p}>
                    {p ? cap(p) : "No priority"}
                  </option>
                ))}
              </select>
            </label>
          </dd>
          <dt>Deadline</dt>
          <dd>
            <label className={`pbtn ${!n.meta.deadline ? "placeholder" : ""}`}>
              <Icon name="calendar" className="sm" />
              <span>
                {n.meta.deadline ? date(n.meta.deadline) : "Set deadline"}
              </span>
              <input
                type="date"
                value={n.meta.deadline ?? ""}
                onChange={(e) => meta("deadline", e.target.value)}
                onClick={(e) => {
                  try {
                    e.currentTarget.showPicker();
                  } catch {
                    /* Browser manages unsupported date pickers. */
                  }
                }}
                aria-label="Deadline"
              />
            </label>
            {n.meta.deadline ? (
              <button
                className="icon-btn"
                style={{ width: 22, height: 22 }}
                aria-label="Clear deadline"
                onClick={() => meta("deadline", "")}
              >
                <Icon name="x" className="sm" />
              </button>
            ) : null}
          </dd>
          {git ? (
            <>
              <dt>Remote</dt>
              <dd>
                <span className="pval">
                  {remote ? (
                    <>
                      <Icon name="link" className="sm" />
                      {remote.web ? (
                        <a
                          href={remote.web}
                          onClick={(e) => {
                            e.preventDefault();
                            urlOpen(remote.web!);
                          }}
                        >
                          {remote.web.replace(/^https:\/\//, "")}
                        </a>
                      ) : (
                        <span className="mono">{remote.url}</span>
                      )}
                    </>
                  ) : (
                    <span style={{ color: "var(--red)" }}>
                      None · only on this disk
                    </span>
                  )}
                </span>
              </dd>
              <dt>Branch</dt>
              <dd>
                <span className="pval">
                  <Icon name="branch" className="sm" />
                  <span className="mono">{git.branch ?? "—"}</span>
                  {git.dirty ? (
                    <span className="faint">· {git.dirty} changed</span>
                  ) : null}
                </span>
              </dd>
            </>
          ) : null}
          {n.stack?.labels.length ? (
            <>
              <dt>Stack</dt>
              <dd style={{ padding: "4px 0 4px 8px", gap: 4 }}>
                {n.stack.labels.slice(0, 6).map((label) => (
                  <span className="tag" key={label}>
                    {label}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          {n.kind === "folder" ? (
            <>
              <dt>Inside</dt>
              <dd>
                <span className="pval">
                  {plural(
                    descendants(n, snapshot).filter((n) => n.kind === "project")
                      .length,
                    "project",
                  )}{" "}
                  · {descendants(n, snapshot).filter((n) => n.archived).length}{" "}
                  archived
                </span>
              </dd>
            </>
          ) : null}
          <dt>Activity</dt>
          <dd>
            <span className="pval">
              <span>
                <Time at={n.lastActivity?.at} long />
                {n.lastActivity?.source ? (
                  <span className="faint"> · {n.lastActivity.source}</span>
                ) : null}
              </span>
            </span>
          </dd>
          {n.size ? (
            <>
              <dt>Size</dt>
              <dd>
                <span className="pval">
                  <span>
                    {bytes(n.size.total)}
                    {n.size.reclaimable ? (
                      <span className="faint">
                        {" "}
                        · {bytes(n.size.reclaimable)} reclaimable
                      </span>
                    ) : null}
                  </span>
                </span>
              </dd>
            </>
          ) : null}
        </dl>
        <div className="tabs" role="tablist">
          {tabs.map(([tab, label, count]) => (
            <button
              key={tab}
              role="tab"
              id={`tab-${tab}`}
              aria-controls="inspector-panel"
              aria-selected={active === tab}
              onClick={() => useApp.setState({ tab: tab as typeof s.tab })}
            >
              {label}
              {count ? <span className="n">{count}</span> : null}
            </button>
          ))}
        </div>
        <div
          className="tabbody"
          id="inspector-panel"
          role="tabpanel"
          aria-labelledby={`tab-${active}`}
        >
          {active === "todo" ? (
            <TodoTab key={n.id} node={n} />
          ) : active === "agents" ? (
            <AgentsTab node={n} snapshot={snapshot} />
          ) : active === "readme" ? (
            <ReadmeTab node={n} />
          ) : (
            <HealthTab node={n} snapshot={snapshot} />
          )}
        </div>
      </div>
    </aside>
  );
}
function HealthTab({ node: n, snapshot }: { node: Node; snapshot: Snapshot }) {
  const issues =
    n.kind === "project"
      ? n.issues
      : descendants(n, snapshot)
          .filter((d) => d.kind === "project")
          .flatMap((d) =>
            d.issues
              .filter((i) => i.severity === "high")
              .map((i) => ({ ...i, title: `${d.label}: ${i.title}` })),
          );
  const git = n.git;
  const stack = n.stack;
  const max = Math.max(...(git?.weekly ?? []), 1);
  return (
    <>
      <div className="sec-t">Checks</div>
      {issues.length ? (
        issues.map((issue, i) => (
          <div className="issue" key={i}>
            <SeverityGlyph severity={issue.severity} />
            <div className="txt">
              <p>{issue.title}</p>
              {issue.detail ? <p className="d">{issue.detail}</p> : null}
            </div>
            {n.kind === "project" ? (
              <FixButton node={n} code={issue.code} />
            ) : null}
          </div>
        ))
      ) : (
        <div className="issue">
          <StatusGlyph status="done" />
          <div className="txt">
            <p>All clear</p>
            <p className="d">Committed, pushed, nothing forgotten.</p>
          </div>
        </div>
      )}
      {git ? (
        <>
          <div className="sec-t">
            Commits <span className="grow" />
            <span className="faint" style={{ fontWeight: 400 }}>
              {git.commits} total
              {git.authors > 1 ? ` · ${git.authors} authors` : ""}
            </span>
          </div>
          <div className="spark" aria-label="Commits per week, last 26 weeks">
            {git.weekly.map((count, i) => (
              <i
                key={i}
                className={count ? "" : "z"}
                style={{
                  height: `${count ? Math.max(10, (count / max) * 100) : 6}%`,
                }}
                title={`${count} commits`}
              />
            ))}
          </div>
          <div className="spark-cap">
            <span>
              {date(new Date(Date.now() - 182 * 864e5).toISOString())}
            </span>
            <span>this week</span>
          </div>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>First commit</dt>
            <dd>{date(git.firstCommitAt)}</dd>
            <dt>Last commit</dt>
            <dd>
              {git.lastSubject ? (
                <>
                  {git.lastSubject}{" "}
                  <span className="faint">
                    · <Time at={git.lastCommitAt} long />
                  </span>
                </>
              ) : (
                "None yet"
              )}
            </dd>
            {git.upstream ? (
              <>
                <dt>Tracking</dt>
                <dd className="mono">
                  {git.upstream}
                  {git.ahead || git.behind ? (
                    <span className="faint">
                      {" "}
                      · {git.ahead} ahead, {git.behind} behind
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
            {git.stashes ? (
              <>
                <dt>Stashes</dt>
                <dd>{git.stashes}</dd>
              </>
            ) : null}
          </dl>
        </>
      ) : n.kind === "project" ? (
        <>
          <div className="sec-t">History</div>
          <dl className="kv">
            <dt>Folder made</dt>
            <dd>{date(n.createdAt?.at)}</dd>
            <dt>Last change</dt>
            <dd>
              <Time at={n.lastActivity?.at} long />
            </dd>
            <dt>Git</dt>
            <dd>Not tracked</dd>
          </dl>
        </>
      ) : null}
      {stack?.scripts.length ? (
        <>
          <div className="sec-t">Run in a terminal</div>
          <div className="cmds">
            {stack.scripts.map((script) => (
              <button
                className="btn sm"
                key={script.name}
                title={script.cmd}
                onClick={() => void openTerminal(n.id, "script", script.name)}
              >
                <Icon name="play" className="sm" />
                {stack.packageManager && stack.packageManager !== "npm"
                  ? `${stack.packageManager} ${script.name}`
                  : `npm run ${script.name}`}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {stack &&
      (stack.services.length ||
        stack.env.length ||
        stack.deploy.length ||
        stack.ci.length ||
        stack.languages.length) ? (
        <>
          <div className="sec-t">Setup</div>
          <dl className="kv">
            {stack.languages.length ? (
              <>
                <dt>Languages</dt>
                <dd>
                  {stack.languages.slice(0, 3).map((language, i) => (
                    <span key={language.name}>
                      {i ? ", " : ""}
                      {language.name}{" "}
                      <span className="faint">{language.files}</span>
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
            {stack.services.length ? (
              <>
                <dt>Services</dt>
                <dd>{stack.services.join(", ")}</dd>
              </>
            ) : null}
            {stack.env.length ? (
              <>
                <dt>Env vars</dt>
                <dd>{stack.env.length} in .env.example</dd>
              </>
            ) : null}
            {stack.deploy.length ? (
              <>
                <dt>Deploy</dt>
                <dd>{stack.deploy.join(", ")}</dd>
              </>
            ) : null}
            {stack.ci.length ? (
              <>
                <dt>CI</dt>
                <dd>{stack.ci.join(", ")}</dd>
              </>
            ) : null}
          </dl>
        </>
      ) : null}
      {n.readme?.links.length ? (
        <>
          <div className="sec-t">Links</div>
          {n.readme.links.map((link, i) => (
            <div className="sess" key={i}>
              <Icon name="link" className="sm" />
              <a
                className="t"
                href={link.url}
                onClick={(e) => {
                  e.preventDefault();
                  urlOpen(link.url);
                }}
              >
                {link.label}
              </a>
              <span className="m">
                {link.url.replace(/^https?:\/\//, "").split("/")[0]}
              </span>
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}
function TaskCheckbox({ node, task }: { node: Node; task: Task }) {
  return (
    <label className={`todo ${task.done ? "done" : ""}`}>
      <input
        className="cb"
        type="checkbox"
        checked={task.done}
        onChange={(e) =>
          void run(async () =>
            useApp.getState().patch(
              await api<Node>("todo", {
                id: node.id,
                op: "toggle",
                file: task.file,
                line: task.line,
                text: task.text,
                ...taskIdentity(node, task),
                done: e.target.checked,
              }),
            ),
          )
        }
      />
      <div className="txt">
        {task.text}
        {task.section && task.file !== ".laci.md" ? (
          <div className="src">{task.section}</div>
        ) : null}
      </div>
      {task.file === ".laci.md" ? (
        <button
          className="icon-btn"
          aria-label="Delete"
          onClick={(e) => {
            e.preventDefault();
            void run(async () =>
              useApp.getState().patch(
                await api<Node>("todo", {
                  id: node.id,
                  op: "delete",
                  file: task.file,
                  line: task.line,
                  text: task.text,
                  ...taskIdentity(node, task),
                }),
              ),
            );
          }}
        >
          <Icon name="x" className="sm" />
        </button>
      ) : null}
    </label>
  );
}
function TodoTab({ node: n }: { node: Node }) {
  const expanded = useApp((s) => s.expanded);
  const [text, setText] = useState("");
  const mine = n.tasks.filter(
    (t) => t.file === ".laci.md" && t.kind === "check",
  );
  const checks = n.tasks.filter(
    (t) => t.file !== ".laci.md" && t.kind === "check",
  );
  const lists = n.tasks.filter((t) => t.kind === "list");
  const group = (tasks: Task[]) => {
    const groups = new Map<string, Task[]>();
    for (const t of tasks)
      groups.set(t.file, [...(groups.get(t.file) ?? []), t]);
    return [...groups];
  };
  return (
    <>
      <div className="sec-t">
        Next steps <span className="grow" />
        <span className="faint mono" style={{ fontWeight: 400 }}>
          .laci.md
        </span>
      </div>
      {mine.map((t) => (
        <TaskCheckbox key={`${t.file}:${t.line}`} node={n} task={t} />
      ))}
      <form
        className="add"
        onSubmit={(e) => {
          e.preventDefault();
          const value = text.trim();
          if (value)
            void run(async () => {
              useApp
                .getState()
                .patch(
                  await api<Node>("todo", { id: n.id, op: "add", text: value }),
                );
              setText("");
            });
        }}
      >
        <Icon name="plus" className="sm" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add the next step…"
          autoComplete="off"
          aria-label="New to-do"
        />
      </form>
      {group(checks).map(([file, tasks]) => (
        <div key={file}>
          <div className="sec-t">
            Checkboxes <span className="grow" />
            <span className="faint mono" style={{ fontWeight: 400 }}>
              {file}
            </span>
          </div>
          {tasks.map((task) => (
            <TaskCheckbox key={task.line} node={n} task={task} />
          ))}
        </div>
      ))}
      {group(lists).map(([file, tasks]) => (
        <div key={file}>
          <div className="sec-t">
            Listed under TODO <span className="grow" />
            <span className="faint mono" style={{ fontWeight: 400 }}>
              {file} ·{" "}
              <Time at={n.taskFiles.find((f) => f.file === file)?.at} />
            </span>
          </div>
          {tasks
            .slice(0, expanded["list:" + n.id] ? undefined : 8)
            .map((task) => (
              <div
                className={`todo ${task.done ? "done" : ""}`}
                key={task.line}
              >
                <span className="bullet">–</span>
                <div className="txt">
                  {task.text}
                  {task.section ? (
                    <div className="src">{task.section}</div>
                  ) : null}
                </div>
              </div>
            ))}
          {tasks.length > 8 ? (
            <Expand name={"list:" + n.id} count={tasks.length} />
          ) : null}
        </div>
      ))}
      <Notes key={n.id} node={n} />
    </>
  );
}
function Notes({ node }: { node: Node }) {
  const [text, setText] = useState(node.notes ?? "");
  const [status, setStatus] = useState("");
  const draft = useRef(node.notes ?? "");
  const saved = useRef(node.notes ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sequence = useRef(Promise.resolve());
  const mounted = useRef(true);
  const save = useCallback(
    (value: string) => {
      sequence.current = sequence.current.then(async () => {
        if (saved.current === value) return;
        if (mounted.current) setStatus("Saving…");
        try {
          const patched = await api<Node>("notes", {
            id: node.id,
            text: value,
          });
          saved.current = value;
          useApp.getState().patch(patched);
          if (mounted.current)
            setStatus(draft.current === value ? "Saved" : "Saving…");
        } catch (error) {
          if (mounted.current) setStatus("Couldn’t save");
          toast("Couldn’t save notes", errorText(error), { error: true });
        }
      });
    },
    [node.id],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      if (draft.current !== saved.current) save(draft.current);
    };
  }, [save]);
  useEffect(() => {
    if (draft.current === saved.current && node.notes !== saved.current) {
      draft.current = node.notes ?? "";
      saved.current = draft.current;
      setText(draft.current);
    }
  }, [node.notes]);
  function change(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    draft.current = value;
    setText(value);
    setStatus("Editing…");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(value), 600);
  }
  return (
    <>
      <div className="sec-t">
        Notes <span className="grow" />
        <span className="faint" style={{ fontWeight: 400 }}>
          {status}
        </span>
      </div>
      <textarea
        className="notes"
        value={text}
        onChange={change}
        onBlur={() => {
          clearTimeout(timer.current);
          save(draft.current);
        }}
        maxLength={20000}
        placeholder="Context for future you, or for the next agent session…"
      />
    </>
  );
}
function AgentsTab({ node: n, snapshot }: { node: Node; snapshot: Snapshot }) {
  const expanded = useApp((s) => s.expanded);
  const sessions = sessionsOf(n, snapshot);
  const memory = n.agents.claude.flatMap(
    (id) => snapshot.claude[id]?.memory ?? [],
  );
  const groups = new Map<string, (typeof snapshot.items)[string][]>();
  for (const item of n.agents.items
    .flatMap((id) => (snapshot.items[id] ? [snapshot.items[id]] : []))
    .sort((a, b) => b.at.localeCompare(a.at)))
    groups.set(item.connector, [...(groups.get(item.connector) ?? []), item]);
  return (
    <>
      {!sessions.length && !n.agents.items.length ? (
        <p className="muted" style={{ marginTop: 14 }}>
          No agent has worked in this folder, as far as the logs show.
        </p>
      ) : null}
      {sessions.length ? (
        <>
          <div className="sec-t">
            Claude Code <span className="grow" />
            <span className="faint" style={{ fontWeight: 400 }}>
              {plural(sessions.length, "session")}
            </span>
          </div>
          {sessions
            .slice(0, expanded["sess:" + n.id] ? undefined : 8)
            .map((session) => (
              <div className="sess" key={session.id}>
                <Icon name="bot" className="sm" />
                <span className="t">{session.title ?? "Untitled session"}</span>
                <span className="m">
                  <Time at={session.at} long />
                </span>
                <button
                  className="btn sm act"
                  onClick={() => void openTerminal(n.id, "resume", session.id)}
                >
                  Resume
                </button>
              </div>
            ))}
          {sessions.length > 8 ? (
            <Expand name={"sess:" + n.id} count={sessions.length} />
          ) : null}
        </>
      ) : null}
      {memory.length ? (
        <>
          <div className="sec-t">
            Memory <span className="grow" />
            <span className="faint" style={{ fontWeight: 400 }}>
              {plural(memory.length, "file")}
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {memory.map((file, i) => (
              <span className="tag mono" key={i}>
                {file}
              </span>
            ))}
          </div>
        </>
      ) : null}
      {[...groups].map(([id, list]) => {
        const connector = snapshot.connectors.find((c) => c.id === id);
        const kind = connector?.link.kind;
        const key = `it:${id}:${n.id}`;
        return (
          <div key={id}>
            <div className="sec-t">
              {kind === "mentions"
                ? `${connector?.name} that mention this folder`
                : (connector?.name ?? id)}
              <span className="grow" />
              <span className="faint" style={{ fontWeight: 400 }}>
                {kind === "inside"
                  ? "in the folder"
                  : plural(
                      list.length,
                      kind === "cwd"
                        ? "session"
                        : kind === "named"
                          ? "folder"
                          : "file",
                    )}
              </span>
            </div>
            {list.slice(0, expanded[key] ? undefined : 6).map((item) => (
              <div className="sess" key={item.id}>
                <Icon
                  name={
                    kind === "mentions" || kind === "inside" ? "file" : "bot"
                  }
                  className="sm"
                />
                <span className={`t ${item.title ? "" : "mono"}`}>
                  {kind === "inside"
                    ? base(item.file) + (item.title ? ` · ${item.title}` : "")
                    : (item.title ??
                      base(item.file)
                        .replace(/^rollout-/, "")
                        .replace(/\.[a-z]+$/i, ""))}
                </span>
                <span className="m">
                  <Time at={item.at} long /> · {bytes(item.bytes)}
                </span>
              </div>
            ))}
            {list.length > 6 ? <Expand name={key} count={list.length} /> : null}
          </div>
        );
      })}
      <div className="sec-t">Stored at</div>
      <dl className="kv">
        {n.agents.claude.map((id) => {
          const dir = snapshot.claude[id];
          return dir ? (
            <div className="kv-fragment" key={id}>
              <dt>Claude Code</dt>
              <dd className="mono" style={{ fontSize: 11 }}>
                ~/.claude/projects/{dir.name}
                <br />
                <span className="faint">
                  {bytes(dir.bytes)}
                  {dir.subagentLogs
                    ? ` · ${dir.subagentLogs} subagent logs`
                    : ""}
                </span>
              </dd>
            </div>
          ) : null;
        })}
        {[...groups.keys()].map((id) => {
          const c = snapshot.connectors.find((c) => c.id === id);
          return c && c.link.kind !== "inside" ? (
            <div className="kv-fragment" key={id}>
              <dt>{c.name}</dt>
              <dd className="mono" style={{ fontSize: 11 }}>
                {c.where}
              </dd>
            </div>
          ) : null;
        })}
        {n.agents.aiFiles.length ? (
          <>
            <dt>In folder</dt>
            <dd className="mono" style={{ fontSize: 11 }}>
              {n.agents.aiFiles.join(", ")}
            </dd>
          </>
        ) : null}
        {n.git ? (
          <>
            <dt>Git trailers</dt>
            <dd>
              {n.git.aiTrailers
                ? `${plural(n.git.aiTrailers, "commit")} credit an AI tool`
                : "No commit credits an AI tool"}
            </dd>
          </>
        ) : null}
      </dl>
    </>
  );
}
function ReadmeTab({ node }: { node: Node }) {
  const html = useMemo(() => {
    const raw = marked.parse(node.readme?.raw ?? "", { async: false });
    const clean = DOMPurify.sanitize(raw);
    const doc = new DOMParser().parseFromString(clean, "text/html");
    for (const image of doc.querySelectorAll("img")) {
      const src = image.getAttribute("src") ?? "";
      if (
        src &&
        !/^https?:|^data:|^asset:/.test(src) &&
        !src.startsWith("//")
      ) {
        const url = new URL(src, `https://local.invalid${node.path}/`);
        const file = decodeURIComponent(url.pathname);
        if (file.startsWith(node.path + "/")) image.src = convertFileSrc(file);
      }
    }
    return doc.body.innerHTML;
  }, [node.path, node.readme?.raw]);
  return (
    <>
      <div className="sec-t">
        <span className="mono">{node.readme?.file}</span>
        {node.readme?.template ? (
          <span className="faint">· still the scaffold template</span>
        ) : null}
      </div>
      <div
        className="readme"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const link = (e.target as HTMLElement).closest("a");
          if (link) {
            e.preventDefault();
            const href = link.getAttribute("href") ?? "";
            if (/^https?:\/\//.test(href)) urlOpen(href);
            else if (href.startsWith("#"))
              document.getElementById(href.slice(1))?.scrollIntoView();
            else external(`${node.path}/${href}`);
          }
        }}
      />
    </>
  );
}
