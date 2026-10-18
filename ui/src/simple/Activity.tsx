// Activity: every change by you or your AI, one sentence each in Simple's words, with Undo
// (design-research §3.3). Undo follows Detailed's Log: a change can be undone while the engine says
// it can, and one that was changed again later waits until the newer change is undone. The filled
// button undoes the newest change that can be undone.
import "./cleanup-activity.css";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useNow } from "../clock";
import { Icon } from "../common";
import { localDay, logKind } from "../helpers";
import { changed, refreshLog, run, useApp } from "../store";
import type { ActivityLog, Change, LogEntry } from "../types";
import { activity as said, ago, project } from "../words";
import { ACTIVITY_FILTERS, activityView, actorOf, newerChange } from "./model";
import type { ActivityFilter } from "./model";
import { focused, focusLost } from "./page-focus";
import { Steps } from "./steps";
import {
  Button,
  Callout,
  Disclosure,
  EmptyState,
  Info,
  MoreMenu,
  StatusChip,
} from "./ui";

/** The icon of each kind of change (helpers.ts logKind). */
const KIND_ICON: Record<string, string> = {
  undo: "undo-2",
  move: "route",
  meta: "rename",
  todo: "check",
  notes: "notes",
  setup: "gear",
  new: "plus",
  other: "history",
};

const say = said.changes;

/** "20 October" for a "YYYY-MM-DD" day, with the year when it is another year. */
function longDay(ymd: string) {
  const day = localDay(ymd);
  return day?.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    ...(day.getFullYear() === new Date().getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}

/**
 * Whether leftover AI chats were set aside in Kept for Undo, not sent to the system's bin. An older
 * entry comes without its journal's steps; then the detail tells, which the engine writes only for
 * what went to the bin.
 */
const keptForUndo = (entry: LogEntry) =>
  entry.steps
    ? entry.steps.some((step) => step.kind === "move")
    : !entry.detail;

/**
 * What a form of the engine's title says, from the parts it found. When it says nothing, the change
 * keeps the engine's words.
 */
type Saying = (parts: string[], entry: LogEntry) => string | undefined;

/**
 * The forms of the engine's titles (laci-core's service.rs and what it calls), by kind of change:
 * the first part of its key, else "journal" for a change Undo takes back step by step, else
 * "other". Each says what it found in Simple's words.
 */
const FORMS: Record<string, [RegExp, Saying][]> = {
  settings: [[/^Changed settings$/, () => say.settings]],
  meta: [
    [
      /^Status of (.+) set to (.+)$/,
      ([name, value]) => {
        const status = project.status[value];
        return status && say.status(name, status);
      },
    ],
    [/^Status of (.+) cleared$/, ([name]) => say.statusByLaci(name)],
    [
      /^Priority of (.+) set to (.+)$/,
      ([name, value]) => {
        const priority = say.priorities[value];
        return priority && say.priority(name, priority);
      },
    ],
    [/^Priority of (.+) cleared$/, ([name]) => say.noPriority(name)],
    [
      /^Deadline of (.+) set to (.+)$/,
      ([name, ymd]) => {
        const day = longDay(ymd);
        return day && say.due(name, day);
      },
    ],
    [/^Deadline of (.+) cleared$/, ([name]) => say.noDue(name)],
    [/^Muted “.*?” on (.+)$/, ([name]) => say.hidWarning(name)],
    [/^Unmuted “.*?” on (.+)$/, ([name]) => say.warnAgain(name)],
    [/^Changed muted checks of (.+)$/, ([name]) => say.hiddenWarnings(name)],
  ],
  todo: [
    [/^Added a next step to (.+)$/, ([name]) => say.addedStep(name)],
    [/^Ticked a to-do in (.+)$/, ([name]) => say.ticked(name)],
    [/^Unticked a to-do in (.+)$/, ([name]) => say.unticked(name)],
    [/^Edited a to-do in (.+)$/, ([name]) => say.editedTodo(name)],
    [/^Deleted a next step from (.+)$/, ([name]) => say.deletedStep(name)],
  ],
  notes: [[/^Edited the notes of (.+)$/, ([name]) => say.notes(name)]],
  connector: [
    [/^Added (.+) history$/, ([ai]) => say.showsChats(ai)],
    [/^Removed (.+) history$/, ([ai]) => say.hidesChats(ai)],
    [/^Added (.+)$/, ([ai]) => say.addedTool(ai)],
    [/^Removed (.+)$/, ([ai]) => say.removedTool(ai)],
  ],
  report: [
    [/^Closed an item of the report “(.+)”$/, ([title]) => say.closedItem(title)],
    [/^Reopened an item of the report “(.+)”$/, ([title]) => say.openedItem(title)],
  ],
  gitignore: [
    [
      /^Added (\d+) files to \.gitignore in (.+)$/,
      ([files, name]) => say.keptOut(Number(files), name),
    ],
    [/^Added .+ to \.gitignore in (.+)$/, ([name]) => say.keptOut(1, name)],
  ],
  journal: [
    [/^Archive (.+)$/, ([name]) => say.archived(name)],
    [/^Move (.+?) → /, ([name]) => say.moved(name)],
    [/^Reconnect .+? to (.+)$/, ([name]) => say.reconnected(name)],
    [/^Finish (\d+) half-done moves?$/, ([moves]) => say.finishedMoves(Number(moves))],
    [
      /^Free (.+) from (\d+) inactive projects?$/,
      ([size, projects]) => say.freed(size, Number(projects)),
    ],
    [
      /^\d+ .+ for deleted (.+)$/,
      ([name], entry) =>
        keptForUndo(entry) ? say.setAside(name) : say.trashedChats(name),
    ],
    [
      / for a folder that is gone$/,
      (_parts, entry) =>
        keptForUndo(entry) ? say.setAsideAny : say.trashedChatsAny,
    ],
    [/^Deleted the build output of (.+)$/, ([name]) => say.freedIn(name)],
    [/^Deleted the session “(.+)”$/, ([title]) => say.deletedChat(title)],
    [/^Deleted (\d+) sessions$/, ([chats]) => say.deletedChats(Number(chats))],
  ],
  other: [
    [/^Moved (.+) to (?:system Trash|the Recycle Bin)$/, ([name]) => say.trashed(name)],
    [/^Dismissed: /, () => say.hidSuggestion],
    [/^Suggested again: /, () => say.suggestedAgain],
    [/^Backed up (\d+) agent history files?$/, ([files]) => say.copied(Number(files))],
    [/^Agent history backup is up to date$/, () => say.copyUpToDate],
    [/^Automatic history backup turned on$/, () => say.copyOn],
    [/^Automatic history backup turned off$/, () => say.copyOff],
    [
      /^Restored a (.+) session from the backup$/,
      ([ai]) => (ai === "agent" ? say.putBackAny : say.putBack(ai)),
    ],
    [/^Emptied the quarantine of deleted sessions and history$/, () => say.emptiedKept],
    [/^Removed undo copies of moves older than a week$/, () => say.removedOldUndo],
    [/^Removed files left by Laci 1$/, () => say.removedLaci1],
    [/^Added Laci's MCP server to (.+)$/, ([ai]) => say.letUse(ai)],
    [/^Removed Laci's MCP server from (.+)$/, ([ai]) => say.stoppedUse(ai)],
    [/^Created (.+)$/, ([name]) => say.created(name)],
  ],
};

/**
 * A change in Simple's words (design-research §3.4). Its kind is what the engine records with it:
 * what it undid, its key, or whether Undo takes it back step by step. Only the title names the
 * rest, so the title's known forms give the names and numbers; a form this page doesn't know yet
 * keeps the engine's words.
 */
function sentenceOf(entry: LogEntry, entries: LogEntry[]): string {
  if (entry.undoes) {
    // An Undo can't be undone, so the change it undid is never one.
    const undone = entries.find((e) => e.id === entry.undoes && !e.undoes);
    return undone ? say.undid(sentenceOf(undone, entries)) : say.undidAny;
  }
  const area = entry.key?.split(":")[0] ?? "";
  const forms = Object.hasOwn(FORMS, area)
    ? FORMS[area]
    : FORMS[entry.journal ? "journal" : "other"];
  for (const [form, saying] of forms) {
    const found = form.exec(entry.title);
    if (found) return saying(found.slice(1), entry) ?? entry.title;
  }
  return entry.title;
}

/**
 * A change as Activity tells it: `title` is its sentence, which its row, the buttons, the toast and
 * the search read, and `engine` the engine's own title, which waits behind What changed.
 */
interface Told extends LogEntry {
  engine: string;
  /** By its kind as the engine records it (helpers.ts logKind). */
  icon: string;
}

/** The log as Activity tells it. */
function tell(log: ActivityLog | null): ActivityLog | null {
  if (!log) return null;
  const entries = log.entries.map(
    (entry): Told => ({
      ...entry,
      title: sentenceOf(entry, log.entries),
      engine: entry.title,
      icon: KIND_ICON[logKind(entry)] ?? "history",
    }),
  );
  return { ...log, entries };
}

/** Undoes the change an entry records, with the request Detailed's Log sends. True once it is undone. */
async function undo(entry: LogEntry) {
  const made = await run(
    async () => {
      changed(
        await api<Change>("log/undo", { id: entry.id }),
        said.undone,
        entry.title,
      );
      return true;
    },
    said.undoing,
    { history: true },
  );
  return made === true;
}

export function Activity() {
  const reply = useApp((s) => s.activity);
  const log = useMemo(() => tell(reply), [reply]);
  const pending = useApp((s) => s.historyPending);
  // While the window waits for a change or is covered, nothing in it can take the focus.
  const covered = useApp((s) =>
    Boolean(s.working || s.modal || s.palette || s.sheets),
  );
  // Times in words ("3 minutes ago") and the days' names move on with the clock.
  useNow();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [query, setQuery] = useState("");
  const [, redraw] = useState(0);
  useEffect(() => {
    void refreshLog();
  }, []);
  const view = activityView(log, filter, query);

  // The focus, for the keyboard: after an Undo, on the change it undid, or back on the button when it
  // failed. The filled button stays and names the next change, so a second Enter on it would undo
  // that one too. "Show the newer change" takes the focus to that change.
  const rows = useRef(new Map<string, HTMLLIElement>());
  const title = useRef<HTMLHeadingElement>(null);
  const focusTo = useRef<{
    row?: string;
    element?: HTMLElement | null;
    force?: boolean;
  } | null>(null);
  useEffect(() => {
    const to = focusTo.current;
    if (!to || covered) return;
    focusTo.current = null;
    if (!to.force && !focusLost()) return;
    const target =
      (to.element?.isConnected ? to.element : null) ??
      (to.row ? rows.current.get(to.row) : null) ??
      title.current;
    target?.focus();
  });
  const undoEntry = (entry: LogEntry) => {
    const from = focused();
    void undo(entry).then((made) => {
      focusTo.current = made
        ? { row: entry.id, force: true }
        : { element: from };
      redraw((n) => n + 1);
    });
  };
  const showNewer = (newer: LogEntry) => {
    setFilter("all");
    setQuery("");
    focusTo.current = { row: newer.id, force: true };
    redraw((n) => n + 1);
  };

  const needle = query.trim();
  const newest = view.newest;
  return (
    <div className="s-page s-activity">
      <header className="s-head s-head-row">
        <div>
          <h1 ref={title} tabIndex={-1}>
            {said.title}
          </h1>
          <p className="s-lead">{said.lead}</p>
        </div>
        <div className="s-actions">
          {newest ? (
            <Button
              kind="filled"
              icon="undo-2"
              className="s-activity-undo"
              disabled={pending}
              onClick={() => undoEntry(newest)}
            >
              {said.undo(newest.title)}
            </Button>
          ) : null}
          <MoreMenu
            label={said.more}
            items={[
              {
                label: said.diagnostics,
                icon: "file",
                onSelect: () => void run(() => api("log/open")),
              },
            ]}
          />
        </div>
      </header>
      {!log ? (
        <p className="s-working" role="status">
          <span className="s-spinner" aria-hidden="true" />
          {said.reading}
        </p>
      ) : log.error && !log.entries.length ? (
        <EmptyState
          art="went-wrong"
          title={said.failed}
          action={
            <Button
              kind="outline"
              icon="refresh-cw"
              onClick={() => void refreshLog()}
            >
              {said.tryAgain}
            </Button>
          }
        >
          {log.error}
        </EmptyState>
      ) : !log.entries.length ? (
        <EmptyState art="no-summaries" title={said.emptyTitle}>
          {said.emptyBody}
        </EmptyState>
      ) : (
        <>
          {log.error ? <Callout tone="soon">{said.failed}</Callout> : null}
          <div className="s-toolbar">
            <label className="s-search-field">
              <Icon name="search" />
              <input
                type="search"
                className="s-input"
                aria-label={said.search}
                placeholder={said.search}
                value={query}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="s-chips" role="group" aria-label={said.show}>
              {ACTIVITY_FILTERS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="s-filter"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {said.filters[key]}
                  <span className="s-count">{view.counts[key]}</span>
                </button>
              ))}
            </div>
          </div>
          {view.days.length ? (
            <div className="s-days">
              {view.days.map((day) => (
                <Day
                  key={day.label}
                  entries={day.entries as Told[]}
                  log={log}
                  pending={pending}
                  rows={rows.current}
                  onUndo={undoEntry}
                  onShow={showNewer}
                />
              ))}
            </div>
          ) : needle ? (
            <EmptyState
              art="no-summaries"
              title={said.noneTitle}
              action={
                <Button kind="outline" onClick={() => setQuery("")}>
                  {said.clearSearch}
                </Button>
              }
            >
              {said.noMatch(needle)}
            </EmptyState>
          ) : (
            <EmptyState
              art="no-summaries"
              title={said.noneTitle}
              action={
                <Button kind="outline" onClick={() => setFilter("all")}>
                  {said.showAll}
                </Button>
              }
            >
              {said.none[filter]}
            </EmptyState>
          )}
        </>
      )}
    </div>
  );
}

/** One day's changes, under the day's name in words. */
function Day({
  entries,
  log,
  pending,
  rows,
  onUndo,
  onShow,
}: {
  entries: Told[];
  log: ActivityLog;
  pending: boolean;
  /** Each change's row, by its id, for the focus to go to. */
  rows: Map<string, HTMLLIElement>;
  onUndo: (entry: LogEntry) => void;
  onShow: (newer: LogEntry) => void;
}) {
  const heading = useId();
  return (
    <section className="s-section s-day" aria-labelledby={heading}>
      <h2 id={heading}>{said.day(entries[0].at)}</h2>
      <ul className="s-entries">
        {entries.map((entry) => (
          <Entry
            key={entry.id}
            entry={entry}
            newer={newerChange(log, entry)}
            pending={pending}
            rowRef={(element) => {
              if (element) rows.set(entry.id, element);
              else rows.delete(entry.id);
            }}
            onUndo={onUndo}
            onShow={onShow}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * One change as a sentence: what happened, who did it and when, and whether it can be undone. Its
 * title and steps, as the engine names them, wait behind "What changed".
 */
function Entry({
  entry,
  newer,
  pending,
  rowRef,
  onUndo,
  onShow,
}: {
  entry: Told;
  /** The change made after it that keeps it from being undone, when there is one. */
  newer?: LogEntry;
  pending: boolean;
  rowRef: (element: HTMLLIElement | null) => void;
  onUndo: (entry: LogEntry) => void;
  onShow: (newer: LogEntry) => void;
}) {
  const undone = entry.state === "undone";
  const unfinished = entry.state === "failed" || entry.state === "running";
  const engine = entry.engine !== entry.title ? entry.engine : "";
  const more = Boolean(
    engine || entry.steps?.length || entry.error || entry.detail,
  );
  return (
    <li
      ref={rowRef}
      className="s-entry"
      data-ui="entry"
      data-id={entry.id}
      tabIndex={-1}
    >
      <Icon name={entry.icon} />
      <div className="s-entry-text">
        <span>{entry.title}</span>
        <span className="s-quiet">
          {said.by(said.who[actorOf(entry)], ago(entry.at))}
        </span>
      </div>
      <div className="s-entry-end">
        {undone ? (
          <span className="s-tag">{said.undone}</span>
        ) : unfinished ? (
          <StatusChip tone="soon">{said.didNotFinish}</StatusChip>
        ) : null}
        {entry.canUndo ? (
          <Button
            kind="outline"
            small
            icon="undo-2"
            disabled={pending}
            aria-label={said.undo(entry.title)}
            onClick={() => onUndo(entry)}
          >
            {said.undoButton}
          </Button>
        ) : entry.superseded && !undone ? (
          <span className="s-entry-later">
            <span>{said.changedLater}</span>
            <Info term="changed-later" />
            {newer ? (
              <button type="button" className="s-link" onClick={() => onShow(newer)}>
                {said.showNewer}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {more ? (
        <Disclosure
          className="s-entry-more"
          label={said.whatChanged}
          openLabel={said.whatChanged}
        >
          {engine ? <p className="s-mono">{engine}</p> : null}
          {entry.error ? <Callout tone="soon">{entry.error}</Callout> : null}
          {entry.detail ? <p className="s-mono">{entry.detail}</p> : null}
          {entry.steps?.length ? <Steps ops={entry.steps} /> : null}
        </Disclosure>
      ) : null}
    </li>
  );
}
