// Activity: every change by you or your AI, one sentence each, with Undo (design-research §3.3).
// Undo follows Detailed's Log: a change can be undone while the engine says it can, and one that was
// changed again later waits until the newer change is undone. The filled button undoes the newest
// change that can be undone.
import "./cleanup-activity.css";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { useNow } from "../clock";
import { Icon } from "../common";
import { logKind } from "../helpers";
import { changed, refreshLog, run, useApp } from "../store";
import type { ActivityLog, Change, LogEntry } from "../types";
import { activity as said, ago } from "../words";
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
  const log = useApp((s) => s.activity);
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
                  entries={day.entries}
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
  entries: LogEntry[];
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
 * steps, as the engine names them, wait behind "What changed".
 */
function Entry({
  entry,
  newer,
  pending,
  rowRef,
  onUndo,
  onShow,
}: {
  entry: LogEntry;
  /** The change made after it that keeps it from being undone, when there is one. */
  newer?: LogEntry;
  pending: boolean;
  rowRef: (element: HTMLLIElement | null) => void;
  onUndo: (entry: LogEntry) => void;
  onShow: (newer: LogEntry) => void;
}) {
  const undone = entry.state === "undone";
  const unfinished = entry.state === "failed" || entry.state === "running";
  const more = Boolean(entry.steps?.length || entry.error || entry.detail);
  return (
    <li
      ref={rowRef}
      className="s-entry"
      data-ui="entry"
      data-id={entry.id}
      tabIndex={-1}
    >
      <Icon name={KIND_ICON[logKind(entry)] ?? "history"} />
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
          {entry.error ? <Callout tone="soon">{entry.error}</Callout> : null}
          {entry.detail ? <p className="s-mono">{entry.detail}</p> : null}
          {entry.steps?.length ? <Steps ops={entry.steps} /> : null}
        </Disclosure>
      ) : null}
    </li>
  );
}
