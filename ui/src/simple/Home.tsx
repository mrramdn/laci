// Home: one sentence on what needs you most and one filled button for it, then what else needs you,
// where you left off, what is next and what is due (design-research §3.3), and a quiet card when a new
// version of Laci is ready.
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { closeReportItem, toggleTodo } from "../actions";
import { askAgent } from "../agent-launch";
import { useNow } from "../clock";
import { Icon } from "../common";
import { chooseFolder } from "../pick";
import { homeModel } from "../selectors";
import type { Need } from "../selectors";
import { goToProject, run, toast, useApp } from "../store";
import type { Node, Snapshot } from "../types";
import { ago, home, projects, safety, shell } from "../words";
import { addProjectFolder, aiName, askFix, continueWithAi } from "./act";
import { Art } from "./art";
import type { ArtName } from "./art";
import { fixIcon, startFix } from "./fix";
import {
  AI_FIXES,
  dayOf,
  dueTone,
  fixable,
  homeCards,
  issueCount,
  needKey,
  toneOf,
} from "./model";
import type { HomeMain, Tone } from "./model";
import {
  clearNotNow,
  hideUntilTomorrow,
  readNotNow,
  showProjects,
  useSimple,
} from "./state";
import { Button, EmptyState, Info, StatusChip } from "./ui";
import { UpdateCard } from "./updates";

export function Home() {
  const snapshot = useApp((s) => s.snapshot!);
  const now = new Date(useNow());
  const day = dayOf(now);
  const model = homeModel(snapshot, now);
  // Read on each draw: "Not now" changes `notNow`, and the minute's clock turns the day.
  useSimple((s) => s.notNow);
  const hidden = readNotNow(day);
  const cards = homeCards(model, hidden);
  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const notNow = (need: Need) => {
    hideUntilTomorrow(needKey(need), day);
    toast(home.notNowDone, home.notNowNote);
  };
  return (
    <div className="s-page s-home">
      <header className="s-head">
        <h1>{home.greeting(now.getHours())}</h1>
        <p className="s-lead">{date}</p>
      </header>
      {model.noFolders ? (
        <EmptyState
          art="welcome"
          title={home.noFoldersTitle}
          action={
            <Button
              kind="filled"
              icon="folder-open"
              onClick={() =>
                void chooseFolder({ title: home.chooseTitle, defaultPath: "~" }, (path) =>
                  void addProjectFolder(path),
                )
              }
            >
              {home.chooseFolder}
            </Button>
          }
        >
          {home.noFoldersBody}
        </EmptyState>
      ) : !model.projects ? (
        <EmptyState
          art="no-projects"
          title={home.noProjectsTitle}
          action={
            <Button
              kind="filled"
              icon="plus"
              onClick={() => useApp.setState({ modal: { kind: "new" } })}
            >
              {projects.newProject}
            </Button>
          }
        >
          {home.noProjectsBody}
        </EmptyState>
      ) : (
        <div className="s-home-grid">
          <MainCard
            main={cards.main}
            snapshot={snapshot}
            projects={model.projects}
            noHistory={model.noHistory}
            onNotNow={notNow}
            onShowHidden={clearNotNow}
          />
          {cards.needsYou.length ? (
            <section className="s-section s-home-needs" aria-labelledby="home-needs">
              <div className="s-section-head">
                <h2 id="home-needs">{home.needsYou}</h2>
                <button
                  type="button"
                  className="s-link"
                  onClick={() => showProjects("needs")}
                >
                  {home.seeAll(cards.shown)}
                </button>
              </div>
              <ul className="s-rows">
                {cards.needsYou.map((need) => (
                  <NeedRow key={needKey(need)} need={need} />
                ))}
              </ul>
            </section>
          ) : null}
          <div className="s-home-side">
            {/* First in the side column, where it is seen on a wide window and moves none of the main one. */}
            <UpdateCard />
            {model.comingUp.length ? (
              <section className="s-section" aria-labelledby="home-coming">
                <div className="s-section-head">
                  <h2 id="home-coming">{home.comingUp}</h2>
                </div>
                <ul className="s-rows s-rows-tight">
                  {model.comingUp.map(({ n, info }) => (
                    <li key={n.id} className="s-row">
                      <button
                        type="button"
                        className="s-row-main"
                        onClick={() => goToProject(n.id)}
                      >
                        <b>{n.label}</b>
                      </button>
                      <StatusChip tone={dueTone(info.days)}>{info.label}</StatusChip>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <PickUp model={model.pickUp} snapshot={snapshot} />
          </div>
          <NextUp todos={model.nextUp} />
        </div>
      )}
      <HomeFoot snapshot={snapshot} />
    </div>
  );
}

/** The fix for a need, as a button: the sheet for most, the project for a due date. */
function needAction(need: Need) {
  if (need.kind === "due") return () => goToProject(need.n.id);
  return fixable(need.issue.code)
    ? () => startFix(need.n, need.issue.code)
    : () => goToProject(need.n.id);
}

function MainCard({
  main,
  snapshot,
  projects,
  noHistory,
  onNotNow,
  onShowHidden,
}: {
  main: HomeMain;
  snapshot: Snapshot;
  projects: number;
  noHistory: number;
  onNotNow: (need: Need) => void;
  onShowHidden: () => void;
}) {
  const ai = aiName(snapshot);
  if (main.kind === "quiet")
    return (
      <Hero
        tone="safe"
        title={home.quietTitle}
        art="all-safe"
        actions={
          <Button kind="outline" onClick={onShowHidden}>
            {home.showHidden}
          </Button>
        }
      >
        {home.quietBody(main.hidden)}
      </Hero>
    );
  if (main.kind === "safe") {
    const n = main.n;
    return (
      <Hero
        tone="safe"
        chip={<StatusChip tone="safe">{safety.tones.safe}</StatusChip>}
        title={home.safeTitle}
        art="all-safe"
        actions={
          n ? (
            <Button
              kind="filled"
              icon="sparkles"
              onClick={() => continueWithAi(n, snapshot)}
            >
              {home.continue(n.label)}
            </Button>
          ) : null
        }
      >
        {home.safeBody(projects, noHistory)}
      </Hero>
    );
  }
  const { n } = main;
  if (main.kind === "due") {
    const next = n.tasks.find((t) => t.kind === "check" && !t.done);
    return (
      <Hero
        tone="act"
        chip={<StatusChip tone="act">{main.due.label}</StatusChip>}
        title={home.due(n.label, main.due.days)}
        actions={
          <>
            <Button kind="filled" onClick={() => goToProject(n.id)}>
              {home.open(n.label)}
            </Button>
            <Button kind="text" onClick={() => onNotNow(main)}>
              {home.notNow}
            </Button>
          </>
        }
      >
        {next ? home.nextStep(next.text) : home.noNextStep}
      </Hero>
    );
  }
  const { issue } = main;
  const tone = toneOf(issue.severity);
  const words = safety.issues[issue.code];
  const fixLabel =
    issue.code === "no-remote"
      ? home.backUp(n.label)
      : (safety.fixes[issue.code] ?? home.open(n.label));
  return (
    <Hero
      tone={tone}
      chip={<StatusChip tone={tone}>{safety.tones[tone]}</StatusChip>}
      title={home.problems[issue.code]?.(n.label) ?? home.problem(n.label)}
      art="back-up"
      actions={
        <>
          <Button
            kind="filled"
            icon={fixIcon(issue.code)}
            onClick={needAction(main)}
          >
            {fixLabel}
          </Button>
          {AI_FIXES.has(issue.code) && issue.code !== "diverged" && ai ? (
            <Button
              kind="text"
              icon="sparkles"
              onClick={() => void askFix(n.id, issue.code)}
            >
              {home.askAi(ai)}
            </Button>
          ) : null}
          <Button kind="text" onClick={() => onNotNow(main)}>
            {home.notNow}
          </Button>
        </>
      }
    >
      {words ? words.body(issueCount(n, issue)) : issue.title}
      {words ? <Info term={words.term} /> : null}
    </Hero>
  );
}

/** The main card's frame: what it is about, a picture beside it, and its buttons below. */
function Hero({
  tone,
  chip,
  title,
  children,
  art,
  actions,
}: {
  tone: Tone;
  chip?: ReactNode;
  title: string;
  children: ReactNode;
  art?: ArtName;
  actions?: ReactNode;
}) {
  return (
    <section className={`s-hero s-tone-${tone}`} aria-labelledby="home-main">
      <div className="s-hero-text">
        {chip}
        <h2 id="home-main">{title}</h2>
        <p>{children}</p>
      </div>
      {art ? <Art name={art} /> : null}
      {actions ? <div className="s-actions s-hero-actions">{actions}</div> : null}
    </section>
  );
}

function NeedRow({ need }: { need: Need }) {
  const { n } = need;
  const tone = need.kind === "due" ? "act" : toneOf(need.issue.severity);
  const words =
    need.kind === "due"
      ? need.due.label
      : (safety.issues[need.issue.code]?.title ?? need.issue.title);
  const label =
    need.kind === "due"
      ? home.open(n.label)
      : fixable(need.issue.code)
        ? (safety.fixes[need.issue.code] ?? home.open(n.label))
        : home.open(n.label);
  return (
    <li className="s-row">
      <button type="button" className="s-row-main" onClick={() => goToProject(n.id)}>
        <b>{n.label}</b>
      </button>
      <StatusChip tone={tone}>{words}</StatusChip>
      <Button
        kind="outline"
        small
        icon={need.kind === "risk" ? fixIcon(need.issue.code) : undefined}
        onClick={needAction(need)}
      >
        {label}
      </Button>
    </li>
  );
}

function PickUp({
  model,
  snapshot,
}: {
  model: ReturnType<typeof homeModel>["pickUp"];
  snapshot: Snapshot;
}) {
  const [all, setAll] = useState(false);
  if (!model.length) return null;
  return (
    <section className="s-section" aria-labelledby="home-pickup">
      <div className="s-section-head">
        <h2 id="home-pickup">{home.pickUp}</h2>
      </div>
      <div className="s-pickups" data-all={all || undefined}>
        {model.map(({ n, session, report }) => (
          <PickUpCard key={n.id} n={n} session={session?.title} report={report} snapshot={snapshot} />
        ))}
      </div>
      {model.length > 1 && !all ? (
        <button type="button" className="s-link s-pickups-more" onClick={() => setAll(true)}>
          {home.morePickUp(model.length - 1)}
        </button>
      ) : null}
    </section>
  );
}

function PickUpCard({
  n,
  session,
  report,
  snapshot,
}: {
  n: Node;
  session?: string;
  report?: { id: string; open: string[] };
  snapshot: Snapshot;
}) {
  const item = report?.open[0];
  const title = useId();
  return (
    <article className="s-pickup" aria-labelledby={title}>
      <h3 id={title}>
        <button type="button" className="s-link-strong" onClick={() => goToProject(n.id)}>
          {n.label}
        </button>
      </h3>
      <p className="s-quiet">{home.lastChange(ago(n.lastActivity?.at))}</p>
      {session ? (
        <p className="s-pickup-chat">
          <Icon name="message-square" />
          <span>{home.lastChat(session)}</span>
        </p>
      ) : null}
      {report && item ? (
        <div className="s-pickup-todo">
          <button
            type="button"
            className="s-check"
            aria-label={home.markDone(item)}
            title={home.markDone(item)}
            onClick={() => void closeReportItem(report.id, item, "done")}
          >
            <Icon name="check" />
          </button>
          <span>{home.stillToDo(item)}</span>
        </div>
      ) : null}
      <div className="s-actions">
        <Button kind="outline" small icon="sparkles" onClick={() => continueWithAi(n, snapshot)}>
          {home.continueChat}
        </Button>
      </div>
    </article>
  );
}

function NextUp({ todos }: { todos: ReturnType<typeof homeModel>["nextUp"] }) {
  return (
    <section className="s-section s-home-next" aria-labelledby="home-next">
      <div className="s-section-head">
        <h2 id="home-next">{home.nextUp}</h2>
        <button
          type="button"
          className="s-link"
          onClick={() => void run(() => askAgent({ kind: "review" }))}
        >
          {home.planWeek}
        </button>
      </div>
      {todos.length ? (
        <ul className="s-todos">
          {todos.map(({ n, t }) => (
            <li key={`${n.id}:${t.file}:${t.line}`} className="s-todo">
              <label className="s-todo-text">
                <input
                  type="checkbox"
                  className="s-cb"
                  checked={t.done}
                  onChange={(event) => void toggleTodo(n, t, event.target.checked)}
                />
                <span>{t.text}</span>
              </label>
              <span className="s-tag" title={home.inProject(n.label)}>
                {n.label}
              </span>
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
            </li>
          ))}
        </ul>
      ) : (
        <p className="s-quiet">{home.noTodos}</p>
      )}
    </section>
  );
}

/** "AI chats copied 11 minutes ago · Up to date". */
function HomeFoot({ snapshot }: { snapshot: Snapshot }) {
  const busy = useApp((s) => s.busy || s.historyPending);
  const failed = useApp((s) => Boolean(s.error));
  const backup = snapshot.backup;
  const parts = [
    backup ? (backup.at ? home.copied(ago(backup.at)) : home.notCopied) : "",
    failed ? shell.checkFailed : busy ? shell.checking : shell.upToDate,
  ].filter(Boolean);
  return <p className="s-home-foot">{parts.join(" · ")}</p>;
}
