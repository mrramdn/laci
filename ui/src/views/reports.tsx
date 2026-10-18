import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { useNow } from "../clock";
import { Expand, Group, Highlight, Icon, KindIcon, Time } from "../common";
import { closeReportItem } from "../actions";
import { useMarkdown, useReportSearch, useReportText } from "../hooks";
import {
  agentInstruction,
  allSessions,
  base,
  bytes,
  dayLabel,
  isWindowsPath,
  localDay,
  LOCALE,
  parentOf,
  pathKey,
  plural,
  providerName,
  reportById,
  reportList,
  tilde,
  trimSep,
} from "../helpers";
import {
  copyText,
  goToProject,
  markReportsSeen,
  rescan,
  run,
  toast,
  useApp,
} from "../store";
import type { Report, ReportsDir, Session } from "../types";

/** Rows shown before "Show all"; a search shows every match. */
const LIST_LIMIT = 150;
/** Reports this large wait for a click before they are rendered. */
const LARGE = 1_000_000;

export function ReportsView() {
  const s = useApp(
    useShallow((state) => ({
      snapshot: state.snapshot!,
      reportFilter: state.reportFilter,
      report: state.report,
      showAll: !!state.expanded["reports:all"],
      navigate: state.navigate,
    })),
  );
  useNow();
  const snapshot = s.snapshot;
  const dir = snapshot.reportsDir;
  const enabled = Boolean(dir && !dir.error);
  const all = reportList(snapshot);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  // What counts as new is fixed for this visit, so a dot stays until its report is opened.
  const [since] = useState(() => useApp.getState().reportsSeen);
  const listRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (enabled) markReportsSeen();
  }, [enabled, snapshot.reports]);
  const filter = s.reportFilter;
  const { needle, fullText, found, shown } = useReportSearch(
    snapshot,
    query,
    filter,
  );
  const label = (path: string) => snapshot.nodes[path]?.label ?? base(path);
  const chosen = reportById(snapshot, s.report);
  const current = chosen ?? (s.report ? undefined : shown[0]);
  const gone = Boolean(s.report && !chosen);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [current?.id]);
  const open = (report: Report) => {
    useApp.setState({ report: report.id });
    setOpened((was) => new Set(was).add(report.id));
  };
  const instruction = () =>
    dir &&
    copyText(
      agentInstruction(tilde(dir.path, snapshot.home)),
      "Agent instruction copied",
      "Paste it into CLAUDE.md, AGENTS.md or GEMINI.md",
    );
  const showFolder = () => void run(() => api("reports/open", { what: "folder" }));
  const head = (count = "") => (
    <div className="head">
      <h1>Reports</h1>
      {count ? <span className="count">{count}</span> : null}
      <span className="grow" />
      {dir ? (
        <button
          className="btn sm ghost"
          title="Copy the rule that makes an agent write these reports"
          onClick={instruction}
        >
          <Icon name="copy" className="sm" />
          Agent instruction
        </button>
      ) : null}
      {enabled ? (
        <button
          className="icon-btn"
          title={`Open ${tilde(dir!.path, snapshot.home)}`}
          aria-label="Open the reports folder"
          onClick={showFolder}
        >
          <Icon name="open" />
        </button>
      ) : null}
    </div>
  );
  if (!dir || dir.error || !all.length)
    return (
      <>
        {head()}
        <div className="body">
          <div className="empty-box">
            <Icon name="report" />
            {!dir ? (
              <>
                <b>Session reports aren’t set up</b>
                <p>
                  Choose the folder your agents write their session reports to,
                  and Laci lists them here with their sessions and projects.
                </p>
                <button
                  className="btn primary"
                  onClick={() => s.navigate("settings")}
                >
                  Open Settings
                </button>
              </>
            ) : dir.error ? (
              <>
                <b>Laci can’t read the reports folder</b>
                <p>
                  <span className="mono">
                    {tilde(dir.path, snapshot.home)}
                  </span>
                  : {dir.error}
                </p>
                <span className="rp-row-actions">
                  <button className="btn" onClick={() => void rescan()}>
                    Scan again
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => s.navigate("settings")}
                  >
                    Open Settings
                  </button>
                </span>
              </>
            ) : (
              <>
                <b>No reports yet</b>
                <p>
                  An agent writes one when a session ends, once it has the
                  instruction. Paste it into CLAUDE.md, AGENTS.md or GEMINI.md.
                </p>
                <span className="rp-row-actions">
                  <button className="btn" onClick={showFolder}>
                    Open folder
                  </button>
                  <button className="btn primary" onClick={instruction}>
                    Copy agent instruction
                  </button>
                </span>
              </>
            )}
          </div>
        </div>
      </>
    );
  const narrowed = Boolean(filter) || Boolean(needle);
  const capped = needle || s.showAll ? shown : shown.slice(0, LIST_LIMIT);
  const groups = new Map<string, Report[]>();
  for (const report of capped) {
    const day = dayLabel(
      localDay(report.date) ?? new Date(report.modified),
    );
    groups.set(day, [...(groups.get(day) ?? []), report]);
  }
  const focusable = capped.some((r) => r.id === current?.id)
    ? current?.id
    : capped[0]?.id;
  const filterLabel = !filter
    ? ""
    : "sessions" in filter
      ? (() => {
          const session = allSessions(snapshot).find((x) =>
            filter.sessions.includes(x.sessionId),
          );
          return session ? `For “${session.title}”` : "For one session";
        })()
      : `For ${label(filter.project)}`;
  const total = dir.total ?? all.length;
  return (
    <>
      {head(
        [
          narrowed
            ? `${shown.length} of ${plural(all.length, "report")}`
            : plural(all.length, "report"),
          total > all.length ? `the newest of ${total}` : "",
        ]
          .filter(Boolean)
          .join(", "),
      )}
      <div className="filterbar">
        {filter ? (
          <div className="showbar" role="group" aria-label="Showing">
            <button
              className="chipf rp-filter"
              aria-pressed="true"
              title="Show all reports"
              onClick={() => useApp.setState({ reportFilter: null })}
            >
              <span>{filterLabel}</span>
              <Icon name="x" />
            </button>
          </div>
        ) : null}
        <span className="grow" />
        <input
          className="inp log-search"
          type="search"
          name="reportSearch"
          aria-label="Search reports"
          placeholder="Search reports"
          title="Titles, summaries and projects at once; the full text a moment later"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              listRef.current
                ?.querySelector<HTMLElement>(".item[tabindex]")
                ?.focus();
            }
          }}
        />
      </div>
      <div
        className="body rp-split"
        data-show={s.report ? "reader" : "list"}
      >
        <section className="rp-list" aria-label="Reports" ref={listRef}>
          {[...groups].map(([day, reports]) => (
            <Group title={day} count={reports.length} key={day}>
              {reports.map((report) => (
                <ReportRow
                  key={report.id}
                  report={report}
                  label={label}
                  query={needle}
                  snippet={found?.snippets.get(report.id)}
                  selected={report.id === current?.id}
                  focusable={report.id === focusable}
                  fresh={
                    Date.parse(report.modified) > since &&
                    !opened.has(report.id)
                  }
                  onOpen={() => open(report)}
                />
              ))}
            </Group>
          ))}
          {!needle && shown.length > LIST_LIMIT ? (
            <Expand name="reports:all" count={shown.length} />
          ) : null}
          {fullText && !found ? (
            <div className="empty">Searching inside the reports…</div>
          ) : null}
          {found?.failed ? (
            <div className="empty">
              Couldn’t search inside the reports; titles and summaries still
              match.
            </div>
          ) : null}
          {!shown.length && (!fullText || found) ? (
            <div className="empty">
              {needle ? (
                <>
                  No report matches “{needle}”.{" "}
                  <button className="linkbtn" onClick={() => setQuery("")}>
                    Clear the search
                  </button>
                </>
              ) : (
                <>
                  No report names this{" "}
                  {filter && "project" in filter ? "project" : "session"} yet.{" "}
                  <button
                    className="linkbtn"
                    onClick={() => useApp.setState({ reportFilter: null })}
                  >
                    Show all reports
                  </button>
                </>
              )}
            </div>
          ) : null}
        </section>
        {gone ? (
          <article className="rp-reader">
            <div className="empty-box">
              <Icon name="report" />
              <b>This report is gone</b>
              <p>It was renamed, moved or deleted since Laci listed it.</p>
              <button
                className="btn"
                onClick={() => useApp.setState({ report: null })}
              >
                Show the newest
              </button>
            </div>
          </article>
        ) : current ? (
          <ReportReader
            key={current.id}
            report={current}
            dir={dir}
            reports={all}
          />
        ) : (
          <article className="rp-reader" />
        )}
      </div>
    </>
  );
}

function ReportRow({
  report,
  label,
  query,
  snippet,
  selected,
  focusable,
  fresh,
  onOpen,
}: {
  report: Report;
  label: (path: string) => string;
  query: string;
  snippet?: string;
  selected: boolean;
  focusable: boolean;
  fresh: boolean;
  onOpen: () => void;
}) {
  const where = report.projects.length
    ? report.projects.map(label).join(", ")
    : (report.scope ?? "No project");
  const text = snippet ?? report.summary;
  return (
    <div
      className="item two rp-row"
      // One stop for Tab; the arrow keys move between rows.
      tabIndex={focusable ? 0 : -1}
      data-id={report.id}
      aria-selected={selected}
      onClick={onOpen}
    >
      <div className="lines">
        <div className="l1">
          <span className="rp-name">
            <Highlight text={report.title} query={query} />
          </span>
          {fresh ? (
            <span className="dot" title="New since you last opened Reports" />
          ) : null}
        </div>
        <div className="l2">
          <span>
            <Highlight text={where} query={query} />
          </span>
          {report.openCount ? (
            <span className="faint rp-open">{report.openCount} open</span>
          ) : null}
        </div>
        {text ? (
          <div className="rp-sum">
            <Highlight text={text} query={query} />
          </div>
        ) : null}
      </div>
      <span className="meta">
        <Time at={report.modified} />
      </span>
    </div>
  );
}

const HEADER_FIELD = /^[-*+]\s+\*\*\s*(date|sessions?|projects?)\s*:?\s*\*\*/i;
/** The title and header lines, which the reader shows above the text already. */
function stripHeader(raw: string) {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.startsWith("# ")) i++;
  for (;;) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length || !HEADER_FIELD.test(lines[i])) break;
    i++;
    while (i < lines.length && /^\s+\S/.test(lines[i])) i++;
  }
  return lines.slice(i).join("\n");
}

/**
 * The report a link in a report names: another file in the same folder, by its name or by its path.
 */
export function reportLink(href: string, reports: Report[], folder: string) {
  let name = href.split(/[?#]/)[0];
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not encoded: taken as written.
  }
  if (isWindowsPath(folder)) {
    // Next to a Windows folder, a link may write `\` between names too, and name the folder in full
    // with either separator and in any case.
    if (isWindowsPath(name) && pathKey(parentOf(name)) === pathKey(folder))
      name = base(name);
    name = name.replace(/\\/g, "/");
  } else if (name.startsWith(folder + "/")) {
    name = name.slice(folder.length + 1);
  }
  name = name.replace(/^\.\//, "");
  return name.includes("/") ? undefined : reports.find((r) => r.id === name);
}

/**
 * The report's open items, each of which can be closed as done or dropped; closed ones can be opened again.
 * Laci keeps this in its own data: the report file stays as the agent wrote it.
 */
function OpenItems({ report }: { report: Report }) {
  const closed = report.closed ?? [];
  if (!report.open.length && !closed.length) return null;
  const close = (
    item: number | string,
    state: "done" | "dropped" | "open",
    text: string,
  ) => void closeReportItem(report.id, item, state, text);
  return (
    <section className="rp-items" aria-label="Open items">
      <div className="sec-t">
        Open items <span className="faint">{report.openCount}</span>
        <span className="grow" />
        <span className="faint rp-items-note">
          Closing one changes nothing in the file
        </span>
      </div>
      {report.open.map((item, i) => (
        <div className="rp-item" key={item}>
          <Icon name="check" className="sm faint" />
          <span className="txt">{item}</span>
          <button
            className="btn sm ghost"
            title="It is finished"
            onClick={() => close(i + 1, "done", item)}
          >
            Done
          </button>
          <button
            className="btn sm ghost"
            title="It no longer needs doing"
            onClick={() => close(i + 1, "dropped", item)}
          >
            Drop
          </button>
        </div>
      ))}
      {report.openCount > report.open.length ? (
        <p className="faint rp-items-more">
          {plural(report.openCount - report.open.length, "more item")} below
          in the report
        </p>
      ) : null}
      {closed.length ? (
        <details className="rp-closed">
          <summary>Closed ({closed.length})</summary>
          {closed.map((item, i) => (
            <div className="rp-item done" key={item}>
              <span className="txt">{item}</span>
              <button
                className="btn sm ghost"
                onClick={() => close(i + 1, "open", item)}
              >
                Open again
              </button>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
function ReportReader({
  report,
  dir,
  reports,
}: {
  report: Report;
  dir: ReportsDir;
  reports: Report[];
}) {
  const snapshot = useApp((s) => s.snapshot!);
  const text = useReportText(report);
  const markdown = useMarkdown();
  const [large, setLarge] = useState(report.bytes > LARGE);
  const [loadRemote, setLoadRemote] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const folder = trimSep(dir.path);
  const rendered = useMemo(
    () =>
      text.raw === undefined || large
        ? undefined
        : markdown?.renderReadme(stripHeader(text.raw), folder, loadRemote),
    [markdown, text.raw, large, folder, loadRemote],
  );
  const sessions = useMemo(() => {
    const byId = new Map<string, Session>();
    for (const session of allSessions(snapshot))
      if (
        session.sourceKind !== "subagent" &&
        !byId.has(session.sessionId.toLowerCase())
      )
        byId.set(session.sessionId.toLowerCase(), session);
    return report.sessions.map((id) => ({ id, session: byId.get(id) }));
  }, [snapshot, report.sessions]);
  const day = localDay(report.date);
  const updated =
    new Date(report.modified).toDateString() !== day?.toDateString();
  const sections = rendered?.headings.filter((h) => h.level === 2) ?? [];
  const back = () => {
    useApp.setState({ report: null });
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`.rp-row[data-id="${CSS.escape(report.id)}"]`)
        ?.focus(),
    );
  };
  return (
    <article
      className="rp-reader"
      tabIndex={0}
      aria-labelledby="report-title"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          window.matchMedia("(max-width: 860px)").matches
        ) {
          event.preventDefault();
          back();
        }
      }}
    >
      <div className="rp-head">
        <button className="btn sm ghost rp-back" onClick={back}>
          <Icon name="chev" className="sm" />
          Reports
        </button>
        <h2 id="report-title">{report.title}</h2>
        <div className="rp-meta">
          <span>
            {day
              ? day.toLocaleDateString(LOCALE, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })
              : report.date}
          </span>
          {updated ? (
            <span>
              Updated <Time at={report.modified} long />
            </span>
          ) : null}
          <span>{bytes(report.bytes)}</span>
        </div>
        {report.projects.length || sessions.length ? (
          <div className="rp-chips">
            {report.projects.map((path) => {
              const node = snapshot.nodes[path];
              return node ? (
                <button
                  className="pill rp-chip"
                  key={path}
                  title={`Show ${tilde(path, snapshot.home)}`}
                  onClick={() => goToProject(path, "agents")}
                >
                  <KindIcon node={node} />
                  {node.label}
                </button>
              ) : (
                <span className="pill faint" key={path} title={path}>
                  {base(path)}
                </span>
              );
            })}
            {sessions.map(({ id, session }) =>
              session ? (
                <button
                  className="pill rp-chip"
                  key={id}
                  title={`Session ${id}`}
                  onClick={() =>
                    useApp.setState({
                      modal: {
                        kind: "session",
                        provider: session.provider,
                        sessionId: session.sessionId,
                        file: session.file,
                      },
                    })
                  }
                >
                  <Icon name="bot" className="sm" />
                  <span className="rp-chip-t">
                    {providerName(snapshot, session.provider)} ·{" "}
                    {session.title}
                  </span>
                </button>
              ) : (
                <span
                  className="pill faint mono"
                  key={id}
                  title={`Session ${id}: not in the agent history Laci reads`}
                >
                  {id.slice(0, 8)}
                </span>
              ),
            )}
          </div>
        ) : null}
        <div className="rp-actions">
          <button
            className="btn sm"
            onClick={() =>
              void run(() =>
                api("reports/open", { what: "editor", id: report.id }),
              )
            }
          >
            <Icon name="editor" className="sm" />
            Open in editor
          </button>
          <button
            className="btn sm"
            onClick={() =>
              void run(() => api("reports/open", { what: "folder" }))
            }
          >
            <Icon name="folder" className="sm" />
            Open folder
          </button>
          <button
            className="icon-btn"
            title="Copy the file's path"
            aria-label="Copy the file's path"
            onClick={() =>
              copyText(report.file, "Path copied", tilde(report.file, snapshot.home))
            }
          >
            <Icon name="copy" />
          </button>
        </div>
      </div>
      <OpenItems report={report} />
      {sections.length >= 5 ||
      (sections.length >= 3 && (text.raw?.length ?? 0) > 3000) ? (
        <nav className="rp-outline" aria-label="Sections">
          {sections.map((h) => (
            <button
              className="chipf"
              key={h.id}
              onClick={() =>
                body.current
                  ?.querySelector(`#${CSS.escape(h.id)}`)
                  ?.scrollIntoView({ block: "start" })
              }
            >
              {h.text}
              {/^open\b/i.test(h.text) && report.openCount ? (
                <span className="n">{report.openCount}</span>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}
      {text.raw === undefined ? (
        <div className="empty">
          {text.error ? (
            <>
              {text.error}{" "}
              <button className="linkbtn" onClick={text.retry}>
                Try again
              </button>
            </>
          ) : (
            "Reading the report…"
          )}
        </div>
      ) : large ? (
        <div className="readme-note rp-note">
          <span>
            This report is {bytes(report.bytes)}; showing it can take a
            moment.
          </span>
          <button className="btn sm" onClick={() => setLarge(false)}>
            Show it
          </button>
        </div>
      ) : rendered ? (
        <>
          {rendered.remote && !loadRemote ? (
            <div className="readme-note rp-note">
              <span>
                {plural(rendered.remote, "image")} from the web{" "}
                {rendered.remote === 1 ? "is" : "are"} not loaded.
              </span>
              <button className="btn sm" onClick={() => setLoadRemote(true)}>
                Load images
              </button>
            </div>
          ) : null}
          <div
            ref={body}
            className="readme rp-body"
            dangerouslySetInnerHTML={{ __html: rendered.html }}
            onClick={(event) =>
              markdown?.proseClick(event, {
                remote: () => setLoadRemote(true),
                blocked:
                  "A report can open web and mail links, and other reports in its folder",
                relative: (href) => {
                  const target = reportLink(href, reports, folder);
                  if (target) useApp.setState({ report: target.id });
                  else
                    toast(
                      "Link not opened",
                      "Only another report in the same folder opens here",
                    );
                },
              })
            }
          />
        </>
      ) : (
        // The text is in and what draws it is still loading: never the raw Markdown.
        <div className="empty">Reading the report…</div>
      )}
    </article>
  );
}
