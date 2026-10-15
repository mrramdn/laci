import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { ChangeEvent } from "react";
import { api, errorText } from "./api";
import { useApp, external, run, toast, urlOpen } from "./store";
import { proseClick, renderReadme } from "./readme";
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
  hasSessionFile,
  liveIssues,
  conversations,
  reportsOfProject,
  shortDay,
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
import { Select } from "./select";
import { TerminalButton, launchShell } from "./terminal-controls";
import { agentProviders, askAgent } from "./agent-launch";
import { SessionList, requestResume } from "./session-ui";
import { openTerminal } from "./terminal-api";
import type { Commit, Health, Node, Snapshot, Task } from "./types";
export function Inspector({ node: n }: { node: Node }) {
  const s = useApp();
  const snapshot = s.snapshot!;
  const sessions = sessionsOf(n, snapshot);
  const resumable = sessions.find(
    (session) => session.resumeCapability === "supported" && !session.parentId,
  );
  const parent = n.parent ? snapshot.nodes[n.parent] : null;
  const git = n.git;
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
        <TerminalButton path={n.path} />
        <button
          className="icon-btn"
          title="Close (Esc)"
          aria-label="Close details"
          onClick={() =>
            useApp.setState({ selected: null, pendingSelection: null })
          }
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
                onClick={() =>
                  useApp.setState({
                    modal: {
                      kind: "agent",
                      projectPath: n.id,
                      prompt:
                        "Read this project's README, package files and recent commits. Save a two-sentence project summary under ## Summary in .laci.md. Change nothing else.",
                    },
                  })
                }
              >
                Ask a connected agent
              </button>
            </p>
          ) : null}
          {n.readme?.title &&
          !n.readme.weakTitle &&
          n.readme.title.toLowerCase() !== n.name.toLowerCase() ? (
            <p className="aka">README title: {n.readme.title}</p>
          ) : null}
          <div className="iacts">
            {resumable ? (
              <button
                className="btn primary sm"
                onClick={() => requestResume(resumable, n.id)}
              >
                <Icon name="terminal" className="sm" />
                Resume last session
              </button>
            ) : null}
            <button className="btn sm" onClick={() => external(n.id, "editor")}>
              <Icon name="editor" className="sm" />
              {APP_NAMES[s.apps.editor] ?? cap(s.apps.editor)}
            </button>
            <button className="btn sm" onClick={() => external(n.id, "files")}>
              <Icon name="open" className="sm" />
              {APP_NAMES[s.apps.files] ?? cap(s.apps.files)}
            </button>
            {isProject && !n.archived ? (
              <button
                className="btn ghost sm"
                title="Archive project"
                disabled={s.historyPending}
                onClick={() =>
                  useApp.setState({ modal: { kind: "archive", id: n.id } })
                }
              >
                <Icon name="archive" className="sm" />
                Archive
              </button>
            ) : null}
            {isProject ? (
              <button
                className="btn ghost sm"
                disabled={s.historyPending}
                onClick={() =>
                  useApp.setState({ modal: { kind: "delete", id: n.id } })
                }
              >
                <Icon name="delete" className="sm" />
                Move to Trash
              </button>
            ) : null}
          </div>
        </div>
        <dl className="props">
          <dt>Status</dt>
          <dd>
            <Select
              label="Status"
              className="pbtn"
              value={n.status.auto ? "" : n.status.value}
              onValueChange={(value) => meta("status", value)}
              options={[
                { value: "", label: "Automatic" },
                ...[
                  "active",
                  "idle",
                  "dormant",
                  "idea",
                  "paused",
                  "done",
                  "archived",
                ].map((value) => ({ value, label: cap(value) })),
              ]}
            >
              <StatusGlyph status={n.status.value} />
              <span>{cap(n.status.value)}</span>
              {n.status.auto ? <span className="sub">auto</span> : null}
            </Select>
          </dd>
          <dt>Priority</dt>
          <dd>
            <Select
              label="Priority"
              className={`pbtn ${!n.meta.priority ? "placeholder" : ""}`}
              value={n.meta.priority ?? ""}
              onValueChange={(value) => meta("priority", value)}
              options={["", "high", "medium", "low"].map((value) => ({
                value,
                label: value ? cap(value) : "No priority",
              }))}
            >
              <PriorityGlyph priority={n.meta.priority} />
              <span>
                {n.meta.priority ? cap(n.meta.priority) : "No priority"}
              </span>
            </Select>
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
              <dt>{git.remotes.length > 1 ? "Remotes" : "Remote"}</dt>
              <dd className="remotes">
                {git.remotes.length ? (
                  git.remotes.map((remote) => (
                    <span className="pval" key={remote.name}>
                      <Icon name="link" className="sm" />
                      {git.remotes.length > 1 ? (
                        <span className="faint remote-name">{remote.name}</span>
                      ) : null}
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
                    </span>
                  ))
                ) : (
                  <span className="pval">
                    <span style={{ color: "var(--red)" }}>
                      None · only on this disk
                    </span>
                  </span>
                )}
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
                        , of which {bytes(n.size.reclaimable)} is build output (
                        {n.size.parts
                          .slice(0, 2)
                          .map((p) => p.path)
                          .join(", ")}
                        {n.size.parts.length > 2
                          ? ` and ${n.size.parts.length - 2} more`
                          : ""}
                        )
                      </span>
                    ) : null}
                  </span>
                </span>
                {isProject && n.size.reclaimable > 50e6 ? (
                  <button
                    className="btn sm"
                    style={{ marginTop: 6 }}
                    disabled={s.historyPending}
                    onClick={() =>
                      useApp.setState({ modal: { kind: "clean", id: n.id } })
                    }
                  >
                    Delete build output…
                  </button>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
        <div className="tabs" role="tablist" aria-label="Project details">
          {tabs.map(([tab, label, count]) => (
            <button
              key={tab}
              role="tab"
              id={`tab-${tab}`}
              aria-controls="inspector-panel"
              aria-selected={active === tab}
              tabIndex={active === tab ? 0 : -1}
              onKeyDown={(event) => {
                const index = tabs.findIndex(([key]) => key === tab);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : event.key === "ArrowRight"
                        ? (index + 1) % tabs.length
                        : event.key === "ArrowLeft"
                          ? (index + tabs.length - 1) % tabs.length
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                useApp.setState({ tab: tabs[next][0] as typeof s.tab });
                document.getElementById(`tab-${tabs[next][0]}`)?.focus();
              }}
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
const CHANGE_TAGS: Record<string, string> = {
  M: "edited",
  A: "added",
  D: "deleted",
  R: "renamed",
  "??": "new",
};
const SHOWN = 5;
const WEEK = 7 * 864e5;
function HealthList<T>({
  items,
  render,
  tail,
}: {
  items: T[];
  render: (item: T) => ReactNode;
  tail?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const rest = items.length - SHOWN;
  return (
    <ul className="hlist">
      {(all ? items : items.slice(0, SHOWN)).map((item, i) => (
        <li key={i}>{render(item)}</li>
      ))}
      {rest > 0 ? (
        <li className="more-row">
          <button className="more" onClick={() => setAll(!all)}>
            {all ? "Show less" : `Show ${rest} more`}
          </button>
        </li>
      ) : null}
      {tail}
    </ul>
  );
}
function CommitRow({ commit, author }: { commit: Commit; author?: boolean }) {
  return (
    <>
      <span className="mono h">{commit.hash.slice(0, 7)}</span>
      <span className="nm" title={commit.subject}>
        {commit.subject}
        {author && commit.author ? (
          <span className="faint"> · {commit.author}</span>
        ) : null}
      </span>
      <span className="faint w">
        <Time at={commit.at} />
      </span>
    </>
  );
}
function useHealth(n: Node) {
  const [state, setState] = useState<{
    id: string;
    health?: Health;
    failed?: boolean;
  } | null>(null);
  const request = useRef(0);
  const git = n.git;
  const project = n.kind === "project";
  useEffect(() => {
    if (!project) return;
    const mine = ++request.current;
    api<Health>("health", { id: n.id })
      .then((health) => {
        if (mine === request.current) setState({ id: n.id, health });
      })
      .catch(() => {
        if (mine === request.current)
          setState((old) =>
            old?.id === n.id && old.health ? old : { id: n.id, failed: true },
          );
      });
  }, [
    project,
    n.id,
    n.revision,
    git?.dirty,
    git?.ahead,
    git?.commits,
    git?.stashes,
  ]);
  return project && state?.id === n.id ? state : null;
}
function HealthTab({ node: n, snapshot }: { node: Node; snapshot: Snapshot }) {
  const loaded = useHealth(n);
  const health = loaded?.health;
  const all =
    n.kind === "project"
      ? n.issues
      : descendants(n, snapshot)
          .filter((d) => d.kind === "project")
          .flatMap((d) =>
            liveIssues(d)
              .filter((i) => i.severity === "high")
              .map((i) => ({ ...i, title: `${d.label}: ${i.title}` })),
          );
  const issues = all.filter((i) => !i.muted);
  const muted = all.filter((i) => i.muted);
  // Keep codes that are muted but not raised right now, so muting one check never drops another.
  const quiet = (n.meta.quiet ?? "").split(",").filter(Boolean);
  const mute = (code: string, on: boolean) =>
    void run(async () => {
      const rest = quiet.filter((c) => c !== code);
      const value = (on ? [...rest, code] : rest).join(",");
      useApp
        .getState()
        .patch(await api<Node>("meta", { id: n.id, key: "quiet", value }));
    });
  const git = n.git;
  const stack = n.stack;
  const weeks = git?.firstCommitAt
    ? Math.min(
        26,
        Math.max(
          8,
          Math.floor((Date.now() - Date.parse(git.firstCommitAt)) / WEEK) + 1,
        ),
      )
    : 8;
  const weekly = (git?.weekly ?? []).slice(-weeks);
  const max = Math.max(...weekly, 1);
  const weekStart = (i: number) =>
    new Date(Date.now() - (weekly.length - i) * WEEK).toISOString();
  const release = health?.release;
  const releaseLines: string[] = [];
  if (release?.version)
    releaseLines.push(
      `Version ${release.version}${release.source ? ` in ${release.source}` : ""}`,
    );
  if (release?.tag)
    releaseLines.push(
      release.since === 0
        ? `Nothing new since ${release.tag}`
        : `Last tag ${release.tag}${release.tagAt ? ` on ${date(release.tagAt)}` : ""}${release.since ? ` · ${plural(release.since, "commit")} since` : ""}`,
    );
  else if (git && release?.version) releaseLines.push("No release tag yet");
  const details = (code: string) => {
    if (!health) return null;
    if (code === "dirty" && health.changes.length)
      return (
        <HealthList
          items={health.changes}
          render={(c) => (
            <>
              <span className="tag">{CHANGE_TAGS[c.code] ?? c.code}</span>
              <span className="mono nm" title={c.path}>
                {c.path}
              </span>
            </>
          )}
          tail={
            health.changesMore ? (
              <li className="faint">
                and {plural(health.changesMore, "more file")}
              </li>
            ) : null
          }
        />
      );
    if (code === "unpushed" && health.unpushed.length)
      return (
        <HealthList
          items={health.unpushed}
          render={(c) => <CommitRow commit={c} />}
        />
      );
    if (code === "diverged" && health.unpushed.length)
      return (
        <>
          <HealthList
            items={health.unpushed}
            render={(c) => <CommitRow commit={c} />}
          />
          <p className="faint hnote">
            {plural(git?.behind ?? 0, "commit")} on the remote{" "}
            {git?.behind === 1 ? "isn't" : "aren't"} here yet.
          </p>
        </>
      );
    if (code === "stash" && health.stashes.length)
      return (
        <HealthList
          items={health.stashes}
          render={(st) => (
            <>
              <span className="mono h">{st.ref}</span>
              <span className="nm" title={st.subject}>
                {st.subject}
              </span>
              <span className="faint w">
                <Time at={st.at} />
              </span>
            </>
          )}
        />
      );
    return null;
  };
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
              {n.kind === "project" ? (
                <Fragment key={`${n.id}:${issue.code}`}>
                  {details(issue.code)}
                </Fragment>
              ) : null}
              {issue.code === "diverged" ? (
                <button
                  className="btn sm"
                  style={{ marginTop: 6 }}
                  onClick={() =>
                    launchShell(n.path, useApp.getState().terminalTarget)
                  }
                >
                  <Icon name="terminal" className="sm" />
                  Open terminal here
                </button>
              ) : null}
            </div>
            {n.kind === "project" ? (
              <>
                <FixButton node={n} code={issue.code} />
                {/* A deadline is changed or cleared, not muted. */}
                {issue.code === "overdue" ||
                issue.code === "due-soon" ? null : (
                  <button
                    className="btn ghost sm"
                    title="Stop counting this check for this project"
                    onClick={() => mute(issue.code, true)}
                  >
                    Mute
                  </button>
                )}
              </>
            ) : null}
          </div>
        ))
      ) : (
        <div className="issue">
          <StatusGlyph status="done" />
          <div className="txt">
            <p>No issues found</p>
            <p className="d">
              {git
                ? !git.commits
                  ? "This repository has no commits yet."
                  : git.dirty
                    ? "There are local changes in this repository."
                    : !git.remotes.length
                      ? "Working tree is clean. No remote is configured."
                      : git.ahead || git.behind
                        ? "Working tree is clean. Local and remote commits differ."
                        : git.upstream
                          ? "Working tree is clean and matches its last fetched upstream."
                          : "Working tree is clean. No upstream branch is configured."
                : n.kind === "folder"
                  ? "No high-priority issues found in the projects inside."
                  : "No Git repository detected. Available project checks passed."}
            </p>
          </div>
        </div>
      )}
      {muted.length ? (
        <>
          <div className="sec-t">Muted</div>
          {muted.map((issue) => (
            <div className="issue" key={issue.code} style={{ opacity: 0.6 }}>
              <SeverityGlyph severity={issue.severity} />
              <div className="txt">
                <p>{issue.title}</p>
                {issue.detail ? <p className="d">{issue.detail}</p> : null}
              </div>
              <button
                className="btn ghost sm"
                onClick={() => mute(issue.code, false)}
              >
                Unmute
              </button>
            </div>
          ))}
        </>
      ) : null}
      {loaded?.failed ? (
        <p className="faint hnote">Details unavailable</p>
      ) : null}
      {releaseLines.length ? (
        <>
          <div className="sec-t">Release</div>
          {releaseLines.map((line) => (
            <p className="hrel" key={line}>
              {line}
            </p>
          ))}
        </>
      ) : null}
      {health?.recent.length ? (
        <>
          <div className="sec-t">Recent commits</div>
          <HealthList
            key={n.id}
            items={health.recent}
            render={(c) => (
              <CommitRow commit={c} author={(git?.authors ?? 0) > 1} />
            )}
          />
        </>
      ) : null}
      {git ? (
        <>
          <div className="sec-t">
            Commits <span className="grow" />
            <span className="faint" style={{ fontWeight: 400 }}>
              {git.commits} total
              {git.authors > 1 ? ` · ${git.authors} authors` : ""}
            </span>
          </div>
          <div
            className="spark"
            aria-label={`Commits per week, last ${weekly.length} weeks`}
          >
            {weekly.map((count, i) => (
              <i
                key={i}
                className={count ? "" : "z"}
                style={{
                  height: `${count ? Math.max(10, (count / max) * 100) : 6}%`,
                }}
                title={`Week of ${date(weekStart(i))}: ${plural(count, "commit")}`}
              />
            ))}
          </div>
          <div className="spark-cap">
            <span>{date(weekStart(0))}</span>
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
      {!task.done ? (
        <button
          className="icon-btn"
          title="Work on it with an agent, in this project's folder"
          aria-label={`Work on it: ${task.text}`}
          onClick={(e) => {
            e.preventDefault();
            void run(() =>
              askAgent({
                kind: "task",
                id: node.id,
                file: task.file,
                text: task.text,
              }),
            );
          }}
        >
          <Icon name="play" className="sm" />
        </button>
      ) : null}
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
        <label htmlFor="project-notes">Notes</label> <span className="grow" />
        <span className="faint" style={{ fontWeight: 400 }}>
          {status}
        </span>
      </div>
      <textarea
        id="project-notes"
        name="notes"
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
  const sessionGroups = conversations(sessions).filter((c) => !c.short);
  const memory = n.agents.claude.flatMap(
    (id) => snapshot.claude[id]?.memory ?? [],
  );
  const groups = new Map<string, (typeof snapshot.items)[string][]>();
  for (const item of n.agents.items
    .flatMap((id) =>
      snapshot.items[id] && !hasSessionFile(snapshot.items[id].file, snapshot)
        ? [snapshot.items[id]]
        : [],
    )
    .sort((a, b) => b.at.localeCompare(a.at)))
    groups.set(item.connector, [...(groups.get(item.connector) ?? []), item]);
  const canStart =
    n.kind === "project" &&
    !n.archived &&
    agentProviders(snapshot.connectors).length > 0;
  return (
    <>
      {canStart ? (
        <button
          className="btn sm start-agent"
          onClick={() =>
            useApp.setState({
              modal: { kind: "agent", projectPath: n.id },
            })
          }
        >
          <Icon name="play" className="sm" />
          Start agent
        </button>
      ) : null}
      {!sessions.length && !n.agents.items.length ? (
        <p className="muted" style={{ marginTop: 14 }}>
          No agent has worked in this folder, as far as the logs show.
        </p>
      ) : null}
      {sessions.length ? (
        <>
          <div className="sec-t">
            Sessions <span className="grow" />
            <span className="faint" style={{ fontWeight: 400 }}>
              {plural(conversations(sessions).length, "session")}
            </span>
          </div>
          <SessionList
            sessions={sessions}
            limit={expanded["sess:" + n.id] ? undefined : 8}
            projectPath={n.id}
          />
          {sessionGroups.length > 8 ? (
            <Expand name={"sess:" + n.id} count={sessionGroups.length} />
          ) : null}
        </>
      ) : null}
      {snapshot.reportsDir ? <ReportsSection node={n} /> : null}
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
      </dl>
    </>
  );
}
/** The project's newest reports; each opens in Reports. */
function ReportsSection({ node: n }: { node: Node }) {
  const snapshot = useApp((s) => s.snapshot!);
  const reports = reportsOfProject(snapshot, n.path);
  if (!reports.length) return null;
  const open = useApp.getState().openReport;
  return (
    <>
      <div className="sec-t">
        Reports <span className="grow" />
        <span className="faint" style={{ fontWeight: 400 }}>
          {plural(reports.length, "report")}
        </span>
      </div>
      {reports.slice(0, 3).map((r) => (
        <div className="sess" key={r.id}>
          <Icon name="report" className="sm" />
          <button
            className="session-title"
            title={r.title}
            onClick={() => open({ id: r.id, project: n.path })}
          >
            <span>{r.title}</span>
            <small>
              {[
                shortDay(r.date),
                r.openCount ? `${r.openCount} open` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </button>
          <span className="m">
            <Time at={r.modified} />
          </span>
        </div>
      ))}
      {reports.length > 3 ? (
        <button
          className="more"
          onClick={() => open({ project: n.path })}
        >
          All {reports.length} in Reports
        </button>
      ) : null}
    </>
  );
}
function ReadmeTab({ node }: { node: Node }) {
  const [remoteFor, setRemoteFor] = useState<string>();
  const loadRemote = remoteFor === node.path;
  const { html, remote } = useMemo(
    () => renderReadme(node.readme?.raw ?? "", node.path, loadRemote),
    [node.path, node.readme?.raw, loadRemote],
  );
  return (
    <>
      <div className="sec-t">
        <span className="mono">{node.readme?.file}</span>
        {node.readme?.template ? (
          <span className="faint">· still the scaffold template</span>
        ) : null}
      </div>
      {remote && !loadRemote ? (
        <div className="readme-note">
          <span>
            {plural(remote, "image")} from the web {remote === 1 ? "is" : "are"}{" "}
            not loaded.
          </span>
          <button className="btn sm" onClick={() => setRemoteFor(node.path)}>
            Load images
          </button>
        </div>
      ) : null}
      <div
        className="readme"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) =>
          proseClick(e, {
            remote: () => setRemoteFor(node.path),
            blocked: "A README can open web, mail and project links only",
            relative: (href) =>
              void run(async () => {
                const result = await api<{ shown: boolean }>("open", {
                  id: node.id,
                  what: "link",
                  arg: href,
                });
                toast(
                  result.shown ? "Shown in the file manager" : "Opened",
                  href,
                );
              }),
          })
        }
      />
    </>
  );
}
