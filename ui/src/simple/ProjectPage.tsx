// A project's page: its header, "Is it safe?", To-do, AI chats, About and Recent changes. The
// filled button fixes an "Act now" problem when there is one, else it is "Continue with AI ▾".
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { addTodo, deleteTodo, muteCheck, toggleTodo, undoLogEntry } from "../actions";
import { askAgent } from "../agent-launch";
import { api } from "../api";
import { useNow } from "../clock";
import { Icon } from "../common";
import { bytes, cap, deadlineInfo, providerName, tilde, within } from "../helpers";
import { useHealth, useNotesDraft } from "../hooks";
import { activityModel } from "../selectors";
import { requestResume } from "../session-ui";
import {
  copyText,
  external,
  refreshLog,
  run,
  setDesign,
  toast,
  useApp,
} from "../store";
import { openTerminal } from "../terminal-api";
import type { Commit, Issue, LogEntry, Node, Snapshot } from "../types";
import type { Conversation } from "../helpers";
import {
  activity as activityWords,
  ago,
  home,
  project as said,
  projects,
  safety,
  spent,
} from "../words";
import { tell } from "./Activity";
import {
  aiName,
  aiTools,
  askFix,
  editorName,
  fileManagerName,
  lastChat,
  newChat,
} from "./act";
import { fixIcon, startFix } from "./fix";
import {
  actorOf,
  AI_FIXES,
  dueTone,
  fixable,
  hiddenIssues,
  issueCount,
  projectChats,
  safetyIssues,
  toneOf,
} from "./model";
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  Info,
  MoreMenu,
  SafetyBadge,
  Sheet,
  StatusChip,
} from "./ui";
import type { MenuEntry } from "./ui";

export function ProjectPage() {
  const node = useApp((s) =>
    s.selected ? s.snapshot?.nodes[s.selected] : undefined,
  );
  if (!node || node.kind !== "project") return <Gone />;
  return <Project key={node.id} n={node} />;
}

function Back() {
  return (
    <button
      type="button"
      className="s-back"
      onClick={() => useApp.getState().navigate("folder")}
    >
      <Icon name="arrow-left" />
      {said.back}
    </button>
  );
}

function Gone() {
  return (
    <div className="s-page">
      <Back />
      <EmptyState art="went-wrong" title={said.none} level={2}>
        {said.noneBody}
      </EmptyState>
    </div>
  );
}

function Project({ n }: { n: Node }) {
  const snapshot = useApp((s) => s.snapshot!);
  const apps = useApp((s) => s.apps);
  useNow();
  const issues = safetyIssues(n);
  const urgent = issues.find(
    (issue) => issue.severity === "high" && fixable(issue.code),
  );
  const last = lastChat(n, snapshot);
  const status = said.status[n.status.value] ?? cap(n.status.value);
  const priority = projects.priority[n.meta.priority ?? ""];
  const due = deadlineInfo(n.meta.deadline);
  const continueItems: MenuEntry[] = [
    ...(last
      ? [
          {
            label: said.continueLast,
            icon: "history",
            onSelect: () => requestResume(last, n.id),
          },
        ]
      : []),
    ...aiTools(snapshot).map((tool) => ({
      label: said.newChat(tool.label),
      icon: "sparkles",
      onSelect: () => newChat(n, tool.value),
    })),
    "-",
    { label: said.options, icon: "gear", onSelect: () => newChat(n) },
  ];
  const more: MenuEntry[] = [
    ...(n.archived
      ? []
      : [
          {
            label: said.archive,
            icon: "archive",
            onSelect: () =>
              useApp.setState({ modal: { kind: "archive", id: n.id } }),
          },
        ]),
    {
      label: said.delete,
      icon: "trash-2",
      danger: true,
      onSelect: () => useApp.setState({ modal: { kind: "delete", id: n.id } }),
    },
    ...(n.size?.reclaimable
      ? [
          {
            label: said.freeSpace,
            icon: "hard-drive",
            onSelect: () =>
              useApp.setState({ modal: { kind: "clean", id: n.id } }),
          },
        ]
      : []),
    "-",
    {
      label: said.terminal,
      icon: "terminal",
      onSelect: () => void openTerminal(n.id),
    },
    {
      label: said.copy,
      icon: "copy",
      onSelect: () => copyText(n.path, said.copied, n.label),
    },
    {
      label: said.showIn(fileManagerName(apps)),
      icon: "folder-open",
      onSelect: () => external(n.id, "files"),
    },
    "-",
    {
      label: said.detailed,
      icon: "panels-top-left",
      onSelect: () => setDesign("detailed"),
    },
  ];
  return (
    <div className="s-page s-project">
      <Back />
      <header className="s-project-head">
        <div className="s-project-title">
          <h1>{n.label}</h1>
          <p className="s-lead">{n.summary?.text ?? said.about.noReadme}</p>
          <div className="s-chips">
            <SafetyBadge node={n} />
            {due && due.days <= 14 ? (
              <StatusChip tone={dueTone(due.days)}>{due.label}</StatusChip>
            ) : null}
            {priority ? <span className="s-tag">{priority}</span> : null}
            <span className="s-tag-with-info">
              <span className="s-tag">
                {n.status.auto ? said.statusBy(status) : status}
              </span>
              <Info term="status" />
            </span>
          </div>
        </div>
        <div className="s-project-actions">
          {urgent ? (
            <Button
              kind="filled"
              icon={fixIcon(urgent.code)}
              onClick={() => startFix(n, urgent.code)}
            >
              {safety.fixes[urgent.code]}
            </Button>
          ) : null}
          <MoreMenu
            label={said.continueAi}
            kind={urgent ? "outline" : "filled"}
            icon="sparkles"
            align="end"
            items={continueItems}
          >
            {said.continueAi}
          </MoreMenu>
          <Button kind="text" icon="editor" onClick={() => external(n.id, "editor")}>
            {said.openIn(editorName(apps))}
          </Button>
          <MoreMenu label={said.moreActions} items={more} />
        </div>
      </header>
      <div className="s-project-grid">
        <div className="s-project-main">
          <SafeCard n={n} issues={issues} snapshot={snapshot} />
          <TodoCard n={n} />
          <ChatsCard n={n} snapshot={snapshot} />
        </div>
        <div className="s-project-side">
          <AboutCard n={n} snapshot={snapshot} />
          <RecentCard n={n} />
        </div>
      </div>
    </div>
  );
}

// --- Is it safe? ---------------------------------------------------------------------------------

function SafeCard({
  n,
  issues,
  snapshot,
}: {
  n: Node;
  issues: Issue[];
  snapshot: Snapshot;
}) {
  const ai = aiName(snapshot);
  const remote = n.git?.remotes[0];
  return (
    <Card title={said.safe.title} icon="shield-check" className="s-safe">
      {issues.length ? (
        <ul className="s-issues">
          {issues.map((issue) => (
            <IssueRow key={issue.code} n={n} issue={issue} ai={ai} />
          ))}
        </ul>
      ) : (
        <div className="s-safe-ok">
          <StatusChip tone={n.git ? "safe" : "fyi"}>
            {n.git ? safety.safe : safety.noHistory}
          </StatusChip>
          <p>
            {!n.git
              ? safety.noHistoryBody
              : remote?.host
                ? safety.safeOnline(remote.host)
                : safety.safeHere}
          </p>
        </div>
      )}
      <Disclosure>
        <SafeDetails n={n} />
      </Disclosure>
    </Card>
  );
}

function IssueRow({ n, issue, ai }: { n: Node; issue: Issue; ai?: string }) {
  const tone = toneOf(issue.severity);
  const words = safety.issues[issue.code];
  const title = words?.title ?? issue.title;
  return (
    <li className="s-issue">
      <div className="s-issue-text">
        <div className="s-issue-title">
          <StatusChip tone={tone}>{safety.tones[tone]}</StatusChip>
          <b>{title}</b>
          {words ? <Info term={words.term} /> : null}
        </div>
        <p>{words ? words.body(issueCount(n, issue)) : (issue.detail ?? "")}</p>
      </div>
      <div className="s-actions">
        {issue.code === "stale-cwd" ? (
          <Button
            kind="outline"
            small
            onClick={() => useApp.getState().navigate("tidy")}
          >
            {safety.reconnect}
          </Button>
        ) : fixable(issue.code) ? (
          <Button
            kind="outline"
            small
            icon={fixIcon(issue.code)}
            onClick={() => startFix(n, issue.code)}
          >
            {safety.fixes[issue.code]}
          </Button>
        ) : null}
        {AI_FIXES.has(issue.code) && issue.code !== "diverged" && ai ? (
          <Button
            kind="text"
            small
            icon="sparkles"
            onClick={() => void askFix(n.id, issue.code)}
          >
            {safety.askAi(ai)}
          </Button>
        ) : null}
        <MoreMenu
          label={said.safe.moreFor(title)}
          items={[
            {
              label: safety.hide,
              icon: "bell-off",
              onSelect: () =>
                void muteCheck(n, issue.code, true).then(() =>
                  toast(safety.hiddenDone, title),
                ),
            },
          ]}
        />
      </div>
    </li>
  );
}

function CommitList({ commits }: { commits: Commit[] }) {
  return (
    <ul className="s-files">
      {commits.slice(0, 5).map((commit) => (
        <li key={commit.hash}>
          <span className="s-mono">{commit.hash.slice(0, 7)}</span>{" "}
          {commit.subject} <span className="s-quiet">{ago(commit.at)}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Show details": the Git specifics, in the mono font, and the warnings the user hid. */
function SafeDetails({ n }: { n: Node }) {
  const loaded = useHealth(n);
  const health = loaded?.health;
  const git = n.git;
  const hidden = hiddenIssues(n);
  return (
    <div className="s-details">
      {git ? (
        <dl className="s-facts">
          <dt>
            {said.safe.line} <Info term="line-of-work" />
          </dt>
          <dd className="s-mono">{git.branch ?? "—"}</dd>
          <dt>
            {said.safe.online} <Info term="online-copy" />
          </dt>
          <dd>
            {git.remotes.length
              ? git.remotes.map((remote) => (
                  <span key={remote.name} className="s-mono s-block">
                    {remote.web?.replace(/^https?:\/\//, "") ?? remote.url}
                  </span>
                ))
              : said.safe.noOnline}
          </dd>
          <dt>{said.safe.lastVersion}</dt>
          <dd>
            {git.lastSubject
              ? `${git.lastSubject}, ${ago(git.lastCommitAt)}`
              : said.safe.noVersion}
          </dd>
        </dl>
      ) : null}
      {git && !loaded ? <p className="s-quiet">{said.safe.loading}</p> : null}
      {loaded?.failed && !health ? <p className="s-quiet">{said.safe.noDetails}</p> : null}
      {health?.changes.length ? (
        <>
          <h3>{said.safe.changed}</h3>
          <ul className="s-files">
            {health.changes.slice(0, 8).map((change) => (
              <li key={change.path}>
                <span className="s-tag">{said.safe.tags[change.code] ?? change.code}</span>{" "}
                <span className="s-mono">{change.path}</span>
              </li>
            ))}
            {health.changes.length > 8 || health.changesMore ? (
              <li className="s-quiet">
                {said.safe.changedMore(
                  Math.max(0, health.changes.length - 8) + (health.changesMore ?? 0),
                )}
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
      {health?.unpushed.length ? (
        <>
          <h3>{said.safe.notUploaded}</h3>
          <CommitList commits={health.unpushed} />
        </>
      ) : null}
      {health?.stashes.length ? (
        <>
          <h3>{said.safe.setAside}</h3>
          <ul className="s-files">
            {health.stashes.map((stash) => (
              <li key={stash.ref}>
                <span className="s-mono">{stash.ref}</span> {stash.subject}{" "}
                <span className="s-quiet">{ago(stash.at)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {health?.recent.length ? (
        <>
          <h3>{said.safe.recent}</h3>
          <CommitList commits={health.recent} />
        </>
      ) : null}
      {hidden.length ? (
        <>
          <div className="s-subhead">
            <h3>{safety.hidden}</h3>
            <Info term="hidden-warning" />
          </div>
          <p className="s-quiet">{safety.hiddenNote}</p>
          <ul className="s-files">
            {hidden.map((issue) => (
              <li key={issue.code} className="s-hidden-warning">
                <span>{safety.issues[issue.code]?.title ?? issue.title}</span>
                <Button
                  kind="text"
                  small
                  onClick={() =>
                    void muteCheck(n, issue.code, false).then(() =>
                      toast(safety.unhiddenDone),
                    )
                  }
                >
                  {safety.unhide}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

// --- To-do ---------------------------------------------------------------------------------------

function TodoCard({ n }: { n: Node }) {
  const [text, setText] = useState("");
  const notes = useNotesDraft(n);
  const field = useId();
  const notesField = useId();
  const open = n.tasks.filter((t) => t.kind === "check" && !t.done);
  const done = n.tasks.filter((t) => t.kind === "check" && t.done);
  const lists = n.tasks.filter((t) => t.kind === "list" && !t.done);
  const files = [...new Set(lists.map((t) => t.file))];
  return (
    <Card title={said.todo.title} icon="list-todo" className="s-todo-card">
      {open.length ? (
        <ul className="s-todos">
          {open.map((t) => (
            <TodoRow key={`${t.file}:${t.line}`} n={n} t={t} />
          ))}
        </ul>
      ) : (
        <p className="s-quiet">{said.todo.empty}</p>
      )}
      <form
        className="s-add"
        onSubmit={(event) => {
          event.preventDefault();
          void addTodo(n, text).then((added) => {
            if (added) setText("");
          });
        }}
      >
        <label className="sr-only" htmlFor={field}>
          {said.todo.add}
        </label>
        <input
          id={field}
          className="s-input"
          value={text}
          autoComplete="off"
          placeholder={said.todo.addPlaceholder}
          onChange={(event) => setText(event.target.value)}
        />
        <Button kind="outline" type="submit" icon="plus" disabled={!text.trim()}>
          {said.todo.addButton}
        </Button>
      </form>
      {done.length ? (
        <Disclosure label={said.todo.done(done.length)} openLabel={said.todo.done(done.length)}>
          <ul className="s-todos">
            {done.map((t) => (
              <TodoRow key={`${t.file}:${t.line}`} n={n} t={t} />
            ))}
          </ul>
        </Disclosure>
      ) : null}
      {files.length ? (
        <div className="s-handover">
          <div className="s-subhead">
            <h3>{said.todo.handover}</h3>
            <Info term="handover" />
          </div>
          {files.map((file) => {
            const items = lists.filter((t) => t.file === file);
            const at = n.taskFiles.find((f) => f.file === file)?.at;
            return (
              <div key={file}>
                <p className="s-quiet">{said.todo.handoverFrom(file, ago(at))}</p>
                <ul className="s-bullets">
                  {items.slice(0, 5).map((t) => (
                    <li key={t.line}>{t.text}</li>
                  ))}
                  {items.length > 5 ? (
                    <li className="s-quiet">{said.todo.more(items.length - 5)}</li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="s-notes">
        <div className="s-notes-head">
          <label htmlFor={notesField}>{said.todo.notes}</label>
          <span className="s-quiet">{notes.status}</span>
        </div>
        <textarea
          id={notesField}
          className="s-input s-textarea"
          value={notes.text}
          maxLength={20000}
          placeholder={said.todo.notesHint}
          onChange={(event) => notes.change(event.target.value)}
          onBlur={notes.flush}
        />
      </div>
    </Card>
  );
}

function TodoRow({ n, t }: { n: Node; t: Node["tasks"][number] }) {
  return (
    <li className={`s-todo${t.done ? " s-done" : ""}`}>
      <label className="s-todo-text">
        <input
          type="checkbox"
          className="s-cb"
          checked={t.done}
          onChange={(event) => void toggleTodo(n, t, event.target.checked)}
        />
        <span>{t.text}</span>
      </label>
      {!t.done ? (
        <Button
          kind="text"
          small
          icon="sparkles"
          aria-label={home.doWithAiFor(t.text)}
          onClick={() =>
            void run(() =>
              askAgent({ kind: "task", id: n.id, file: t.file, text: t.text }),
            )
          }
        >
          {home.doWithAi}
        </Button>
      ) : null}
      {t.file === ".laci.md" ? (
        <button
          type="button"
          className="s-iconbtn"
          aria-label={said.todo.delete(t.text)}
          title={said.todo.delete(t.text)}
          onClick={() => void deleteTodo(n, t)}
        >
          <Icon name="x" />
        </button>
      ) : null}
    </li>
  );
}

// --- AI chats ------------------------------------------------------------------------------------

function ChatsCard({ n, snapshot }: { n: Node; snapshot: Snapshot }) {
  const now = useNow();
  // Quick chats fold away behind the others; when there are only quick ones, they show. The line
  // under the list says how many it leaves out, so the page and the card's count agree.
  const { shown, more, quick, total } = projectChats(snapshot, n, now);
  return (
    <Card
      title={said.chats.title}
      icon="message-square"
      footer={
        total ? (
          <button
            type="button"
            className="s-link"
            onClick={() => useApp.getState().navigate("agents")}
          >
            {said.chats.seeAll}
          </button>
        ) : null
      }
    >
      {shown.length ? (
        <>
          <ul className="s-chats">
            {shown.map((c) => (
              <ChatRow key={c.session.file} c={c} n={n} snapshot={snapshot} />
            ))}
          </ul>
          {more || quick ? (
            <p className="s-quiet">{said.chats.rest(more, quick)}</p>
          ) : null}
        </>
      ) : (
        <EmptyState
          art="no-chats"
          title={said.chats.emptyTitle}
          level={3}
          compact
          action={
            <Button kind="outline" icon="sparkles" onClick={() => newChat(n)}>
              {said.chats.start}
            </Button>
          }
        >
          {said.chats.emptyBody}
        </EmptyState>
      )}
    </Card>
  );
}

function ChatRow({ c, n, snapshot }: { c: Conversation; n: Node; snapshot: Snapshot }) {
  const session = c.session;
  const resumable = session.resumeCapability === "supported" && !session.backup;
  const facts = [
    c.prompts ? said.chats.messages(c.prompts) : "",
    c.filesChanged ? said.chats.files(c.filesChanged) : "",
    spent(c.activeSeconds),
  ].filter(Boolean);
  return (
    <li className="s-chat">
      <div className="s-chat-text">
        <b>{c.title}</b>
        <span className="s-quiet">
          {said.chats.by(providerName(snapshot, session.provider), ago(c.updatedAt))}
        </span>
        {facts.length ? <span className="s-quiet">{facts.join(" · ")}</span> : null}
      </div>
      {resumable ? (
        <Button
          kind="outline"
          small
          aria-label={said.chats.continueFor(c.title)}
          onClick={() => requestResume(session, n.id)}
        >
          {said.chats.continue}
        </Button>
      ) : (
        <Button
          kind="text"
          small
          aria-label={said.chats.readFor(c.title)}
          onClick={() =>
            useApp.setState({
              modal: {
                kind: "session",
                provider: session.provider,
                sessionId: session.sessionId,
                file: session.file,
                projectPath: n.id,
              },
            })
          }
        >
          {said.chats.read}
        </Button>
      )}
    </li>
  );
}

// --- About ---------------------------------------------------------------------------------------

function AboutCard({ n, snapshot }: { n: Node; snapshot: Snapshot }) {
  const [reading, setReading] = useState(false);
  return (
    <Card title={said.about.title} icon="book-open" className="s-about">
      <dl className="s-facts">
        {n.stack?.labels.length ? (
          <>
            <dt>{said.about.builtWith}</dt>
            <dd>{n.stack.labels.slice(0, 6).join(", ")}</dd>
          </>
        ) : null}
        {n.size ? (
          <>
            <dt>{said.about.size}</dt>
            <dd>
              {n.size.reclaimable
                ? said.about.sizeFree(bytes(n.size.total), bytes(n.size.reclaimable))
                : bytes(n.size.total)}
            </dd>
          </>
        ) : null}
        <dt>{said.about.lastChange}</dt>
        <dd>{ago(n.lastActivity?.at) || "—"}</dd>
      </dl>
      <div className="s-actions">
        {n.readme ? (
          <Button kind="outline" small icon="book-open" onClick={() => setReading(true)}>
            {said.about.read}
          </Button>
        ) : null}
        {!n.summary ? (
          <Button
            kind="text"
            small
            icon="sparkles"
            onClick={() => newChat(n, undefined, said.about.summaryPrompt)}
          >
            {said.about.askSummary}
          </Button>
        ) : null}
      </div>
      <Disclosure>
        <dl className="s-facts">
          <dt>{said.about.location}</dt>
          <dd className="s-mono">{tilde(n.path, snapshot.home)}</dd>
        </dl>
      </Disclosure>
      {reading ? <ReadmeSheet n={n} onClose={() => setReading(false)} /> : null}
    </Card>
  );
}

type Readme = typeof import("../readme");

/** The project's README, drawn as text only: it comes with the project, so it is not trusted. */
function ReadmeSheet({ n, onClose }: { n: Node; onClose: () => void }) {
  const [remote, setRemote] = useState(false);
  const [shown, setShown] = useState<{ html: string; remote: number } | null>(null);
  const module = useRef<Readme | null>(null);
  const raw = n.readme?.raw ?? "";
  useEffect(() => {
    let live = true;
    void import("../readme").then((readme) => {
      if (!live) return;
      module.current = readme;
      setShown(readme.renderReadme(raw, n.path, remote));
    });
    return () => {
      live = false;
    };
  }, [raw, n.path, remote]);
  const click = (event: MouseEvent<HTMLElement>) =>
    module.current?.proseClick(event, {
      remote: () => setRemote(true),
      blocked: said.about.linkBlocked,
      relative: (href) =>
        void run(async () => {
          await api("open", { id: n.id, what: "link", arg: href });
          toast(said.about.opened, href);
        }),
    });
  return (
    <Sheet title={n.label} description={n.readme?.file} onClose={onClose}>
      {!shown ? (
        <p className="s-quiet">{said.about.loading}</p>
      ) : (
        <>
          {shown.remote && !remote ? (
            <p className="s-note">
              {said.about.remoteImages(shown.remote)}{" "}
              <Button kind="text" small onClick={() => setRemote(true)}>
                {said.about.loadImages}
              </Button>
            </p>
          ) : null}
          <div
            className="s-prose"
            onClick={click}
            dangerouslySetInnerHTML={{ __html: shown.html }}
          />
        </>
      )}
    </Sheet>
  );
}

// --- Recent changes ------------------------------------------------------------------------------

/**
 * What changed in this project, each change as one sentence in Simple's words, as Activity tells it:
 * the engine's own titles name Git and paths. The whole log is told first, as an Undo's sentence names
 * the change it undid, which may belong to another project.
 */
export function RecentCard({ n }: { n: Node }) {
  const activity = useApp((s) => s.activity);
  const historyPending = useApp((s) => s.historyPending);
  useEffect(() => {
    if (!useApp.getState().activity) void refreshLog();
  }, []);
  const told = useMemo(() => tell(activity), [activity]);
  const entries: LogEntry[] = activityModel(told)
    .days.flatMap((day) => day.entries)
    .filter((entry) => entry.path && within(entry.path, n.path))
    .slice(0, 5);
  return (
    <Card
      title={said.recent.title}
      icon="history"
      footer={
        <button
          type="button"
          className="s-link"
          onClick={() => useApp.getState().navigate("log")}
        >
          {said.recent.all}
        </button>
      }
    >
      {!activity ? (
        <p className="s-quiet">{said.recent.loading}</p>
      ) : activity.error && !activity.entries.length ? (
        <p className="s-quiet">{said.recent.failed}</p>
      ) : entries.length ? (
        <ul className="s-changes">
          {entries.map((entry) => (
            <li key={entry.id} className="s-change">
              <div className="s-change-text">
                <span>{entry.title}</span>
                <span className="s-quiet">
                  {activityWords.by(
                    activityWords.who[actorOf(entry)],
                    ago(entry.at),
                  )}
                </span>
              </div>
              {entry.state === "undone" ? (
                <span className="s-quiet">{said.recent.undone}</span>
              ) : entry.canUndo ? (
                <Button
                  kind="outline"
                  small
                  icon="undo-2"
                  disabled={historyPending}
                  aria-label={said.recent.undoThis(entry.title)}
                  onClick={() => void undoLogEntry(entry.id)}
                >
                  {said.recent.undo}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="s-quiet">{said.recent.empty}</p>
      )}
    </Card>
  );
}
