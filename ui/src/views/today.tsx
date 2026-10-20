import { useEffect, useId, useState } from "react";
import { api } from "../api";
import {
  Icon,
  StatusGlyph,
  SeverityGlyph,
  PriorityGlyph,
  Time,
  FixButton,
  Group,
  Expand,
} from "../common";
import { useApp, run, setDesign, toast } from "../store";
import { useNow } from "../clock";
import { BackupNotice } from "../backup";
import { LookThumb } from "../looks";
import { useUpdate } from "../update";
import { detailedSettings, firstRun, views } from "../words";
import {
  latestReport,
  LOCALE,
  plural,
  sessionsOf,
  shortDay,
} from "../helpers";
import { todayModel } from "../selectors";
import { DeadlinePill } from "../deadline";
import { closeReportItem, toggleTodo } from "../actions";
import { requestResume } from "../session-ui";
import { askAgent } from "../agent-launch";
import type { Node, Prefs, Tab } from "../types";
export function Today() {
  // Only what Today shows: news of a scan in progress doesn't draw it again.
  const snapshot = useApp((s) => s.snapshot!);
  const selected = useApp((s) => s.selected);
  const selectedRow = useApp((s) => s.selectedRow);
  const allRisks = useApp((s) => Boolean(s.expanded.risks));
  const now = useNow();
  // Worked out once a day for each scan (selectors.ts).
  const { risks, deadlines, overdue, recent, activeCount, checks, handoffs } =
    todayModel(snapshot, new Date(now));
  const isSelected = (n: Node, key: string) =>
    selectedRow === key || (selectedRow === null && selected === n.id);
  const select = (id: string, tab: Tab, row: string) =>
    useApp.getState().select(id, tab, row);
  const shortDate = (deadline?: string) => {
    const [y, m, d] = (deadline ?? "").split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(LOCALE, {
      day: "numeric",
      month: "short",
    });
  };
  if (!snapshot.roots.length)
    return (
      <>
        <div className="head">
          <h1>Today</h1>
        </div>
        <div className="body">
          {/* Laci 2 let every folder stay unticked: that upgrade is offered Simple too. */}
          <TrySimple />
          <UpdatesOffer />
          <div className="empty-box">
            <Icon name="folder" />
            <b>No folders selected yet</b>
            <p>
              Choose the folders that hold your projects and Laci will list them
              here.
            </p>
            <button
              className="btn primary"
              onClick={() => useApp.getState().navigate("settings")}
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
          {new Date().toLocaleDateString(LOCALE, {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </span>
        <span className="grow" />
        <div className="quick-stats" role="group" aria-label="Quick jump">
          {[
            [
              deadlines.length,
              "due",
              "calendar",
              "sec-deadlines",
              overdue ? "bad" : "",
            ],
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
        <button
          className="btn sm"
          title="Start an agent that goes through every open to-do and report item with you, and agrees on what to do next"
          onClick={() => void run(() => askAgent({ kind: "review" }))}
        >
          <Icon name="sparkles" className="sm" />
          Review with an agent…
        </button>
      </div>
      <div className="body">
        <BackupNotice />
        {snapshot.warnings
          .filter((warning) => !warning.code.endsWith("-cleanup"))
          .map((warning, i) => (
            <div className="callout" key={i}>
              <Icon name="alert" />
              <div className="txt">
                <b>{warning.title}</b>
                <p>{warning.detail}</p>
              </div>
            </div>
          ))}
        <TrySimple />
        <UpdatesOffer />
        {deadlines.length ? (
          <Group
            title="Deadlines"
            icon="calendar"
            count={deadlines.length}
            hint="Overdue and the next 14 days"
            order="Soonest first"
            id="sec-deadlines"
          >
            {deadlines.map(({ n, info }) => (
              <div
                className="item"
                key={n.id}
                tabIndex={0}
                data-id={n.id}
                aria-selected={isSelected(n, "deadline:" + n.id)}
                onClick={() => select(n.id, "todo", "deadline:" + n.id)}
              >
                <SeverityGlyph
                  severity={
                    info.tone === "bad"
                      ? "high"
                      : info.tone === "warn"
                        ? "med"
                        : "low"
                  }
                />
                <span className="name">{n.label}</span>
                {n.meta.priority ? (
                  <PriorityGlyph priority={n.meta.priority} />
                ) : null}
                <DeadlinePill deadline={n.meta.deadline} />
                <span className="meta">
                  <span className="mono">{shortDate(n.meta.deadline)}</span>
                  <span className="mono">
                    <Time at={n.lastActivity?.at} />
                  </span>
                </span>
              </div>
            ))}
          </Group>
        ) : null}
        <Group
          title="Could lose work"
          icon="alert"
          count={risks.length}
          hint="Only on this disk, or never committed"
          order="Worst first, then most recent"
          id="sec-risks"
        >
          {risks
            .slice(0, allRisks ? undefined : 8)
            .map(({ n, issues }) => (
              <div
                className="item"
                key={n.id}
                tabIndex={0}
                data-id={n.id}
                aria-selected={isSelected(n, "risk:" + n.id)}
                onClick={() => select(n.id, "health", "risk:" + n.id)}
              >
                <SeverityGlyph severity={issues[0].severity} />
                <span className="name">{n.label}</span>
                {n.meta.priority ? (
                  <PriorityGlyph priority={n.meta.priority} />
                ) : null}
                {issues.map((i) => (
                  <span
                    className={`badge ${i.severity === "high" ? "danger" : "warn"}`}
                    key={i.code}
                  >
                    {i.title}
                  </span>
                ))}
                <span className="d" style={{ marginLeft: 6 }}>
                  {issues[0].detail}
                </span>
                <span className="meta">
                  <FixButton
                    node={n}
                    code={issues[0].code}
                    className="act always"
                  />
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
                aria-selected={isSelected(n, "recent:" + n.id)}
                onClick={() =>
                  select(
                    n.id,
                    sessionsOf(n, snapshot).length ? "agents" : "todo",
                    "recent:" + n.id,
                  )
                }
              >
                <StatusGlyph status={n.status.value} />
                <div className="lines">
                  <div className="l1">
                    <span className="name">{n.label}</span>
                    {n.meta.priority ? (
                      <PriorityGlyph priority={n.meta.priority} />
                    ) : null}
                    <DeadlinePill deadline={n.meta.deadline} />
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
                  <ReportOpen node={n} />
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
                onChange={(e) => void toggleTodo(n, t, e.target.checked)}
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
                <button
                  className="icon-btn work-on"
                  title="Work on it with an agent, in this project's folder"
                  aria-label={`Work on it: ${t.text}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void run(() =>
                      askAgent({
                        kind: "task",
                        id: n.id,
                        file: t.file,
                        text: t.text,
                      }),
                    );
                  }}
                >
                  <Icon name="play" className="sm" />
                </button>
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
                aria-selected={isSelected(n, "todo:" + n.id + ":" + f.file)}
                onClick={() =>
                  select(n.id, "todo", "todo:" + n.id + ":" + f.file)
                }
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
/**
 * The one card that offers Simple, to someone who set Laci up before it had two designs and hasn't
 * chosen one since. Either button saves a choice, so it never comes back: Try switches to Simple,
 * and No thanks keeps Detailed and leaves the focus on Today.
 */
export function TrySimple() {
  const offer = useApp((s) => s.designOffer);
  if (!offer) return null;
  return (
    <div className="callout look-offer" data-ui="design-offer">
      <LookThumb design="simple" />
      <div className="txt">
        <b>{views.offerTitle}</b>
        <p>
          {views.offerBody} {views.anyTime}
        </p>
      </div>
      <div className="acts">
        <button className="btn sm primary" onClick={() => setDesign("simple")}>
          {views.offerTry}
        </button>
        <button
          className="btn sm ghost"
          onClick={() => {
            if (setDesign("detailed"))
              document.getElementById("main")?.focus({ preventScroll: true });
          }}
        >
          {views.offerNo}
        </button>
      </div>
    </div>
  );
}
/**
 * Whether config.json holds no choice about new versions yet: a setup from before 3.0, or a first run
 * that was skipped. False until `prefs` says so, and when it can't: Settings asks the same question.
 * The desktop's news of the update follows every saved choice, so each piece of it reads `prefs`
 * again until a choice is known: one that first run saved as the window opened, or one made in
 * Settings. Nothing unsets a choice, so then it stops. Simple's Home asks the same way
 * (simple/updates.tsx).
 */
function useUpdatesUnset() {
  const [unset, setUnset] = useState<boolean>();
  const known = unset === false;
  useEffect(() => {
    if (known) return;
    let live = true;
    const read = () =>
      void api<Prefs>("prefs").then(
        (prefs) => {
          if (live) setUnset(prefs?.updates === null);
        },
        () => undefined,
      );
    read();
    const stop = useUpdate.subscribe((now, before) => {
      if (now.status !== before.status) read();
    });
    return () => {
      live = false;
      stop();
    };
  }, [known]);
  return unset === true;
}
/**
 * The card that asks someone who set Laci up before 3.0 whether Laci may look for new versions, as
 * first run asks a new install: beside the card that offers Simple and apart from it, as each goes by
 * its own choice. Either button saves the choice through the update store, as Settings › About &
 * updates does, and the card is gone for good; until then Laci doesn't look. The two weigh the same:
 * it is the user's consent to give.
 */
export function UpdatesOffer() {
  const unset = useUpdatesUnset();
  const [chosen, setChosen] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState("");
  const title = useId();
  if (!unset || chosen) return null;
  async function choose(updates: "daily" | "off") {
    if (sending) return;
    setSending(true);
    setRefusal("");
    let saved = false;
    try {
      saved = await useUpdate.getState().choose(updates);
    } catch {
      // The store keeps what the desktop refused; without that, first run's words say it.
    } finally {
      setSending(false);
    }
    if (!saved) {
      setRefusal(useUpdate.getState().refusal ?? firstRun.updatesFailed);
      return;
    }
    setChosen(true);
    toast(detailedSettings.updatesSaved[updates], firstRun.updatesLater);
    // The button that had the focus goes with the card: Today takes it.
    document.getElementById("main")?.focus({ preventScroll: true });
  }
  // Busy, not disabled, while the choice is sent: a refusal leaves the focus where it was.
  return (
    <div
      className="callout"
      role="group"
      aria-labelledby={title}
      aria-busy={sending || undefined}
      data-ui="updates-offer"
    >
      <Icon name="refresh-cw" />
      <div className="txt">
        <b id={title}>{firstRun.updatesTitle}</b>
        <p>{firstRun.updatesSends}</p>
        {/* The red for words: Settings' red for marks (rp-status bad) is too faint on this grey. */}
        {refusal ? (
          <p role="alert" style={{ color: "var(--red-text)" }}>
            {refusal}
          </p>
        ) : null}
      </div>
      <div className="acts">
        {(["daily", "off"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="btn sm"
            onClick={() => void choose(value)}
          >
            {firstRun.updatesAsk[value]}
          </button>
        ))}
      </div>
    </div>
  );
}
/** What the project's latest report left open; a click shows the report. */
function ReportOpen({ node }: { node: Node }) {
  const snapshot = useApp((s) => s.snapshot!);
  const report = latestReport(snapshot, node.path);
  if (!report?.open.length) return null;
  return (
    <div className="rep-line">
      <button
        className="l2 rep-open"
        title={[
          `Open in the report of ${shortDay(report.date)}: ${report.title}`,
          ...report.open.map((item) => `• ${item}`),
        ].join("\n")}
        onClick={(event) => {
          event.stopPropagation();
          useApp.getState().openReport({ id: report.id, project: node.path });
        }}
      >
        <Icon name="report" />
        <span>
          Open ({shortDay(report.date)} report): {report.open[0]}
        </span>
        {report.openCount > 1 ? (
          <span className="faint more-n">+{report.openCount - 1}</span>
        ) : null}
      </button>
      <button
        className="icon-btn rep-close"
        title="Close this item as done. The report stays as written; the Log can undo it."
        aria-label={`Close as done: ${report.open[0]}`}
        onClick={(event) => {
          event.stopPropagation();
          void closeReportItem(report.id, report.open[0], "done");
        }}
      >
        <Icon name="check" className="sm" />
      </button>
    </div>
  );
}
