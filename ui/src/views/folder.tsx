import { useEffect, useMemo } from "react";
import {
  Icon,
  KindIcon,
  StatusGlyph,
  SeverityGlyph,
  PriorityGlyph,
  Time,
} from "../common";
import { useApp, readListing, savePref, external } from "../store";
import {
  agentCount,
  base,
  breadcrumbs,
  bytes,
  cap,
  deadlineInfo,
  liveIssues,
  descendants,
  parentOf,
  priorityRank,
  plural,
  segments,
  tilde,
  within,
} from "../helpers";
import { DeadlinePill } from "../deadline";
import { HIDDEN_FILES_HINT } from "../hotkeys";
import { Select } from "../select";
import { TerminalButton } from "../terminal-controls";
import type { Entry, Node, Snapshot } from "../types";
import type { SortKey } from "../store";
const SORTS: Record<SortKey, { label: string; dirs: string[]; first: number }> =
  {
    name: { label: "Name", dirs: ["A to Z", "Z to A"], first: 1 },
    last: {
      label: "Modified",
      dirs: ["Oldest first", "Newest first"],
      first: -1,
    },
    size: {
      label: "Size",
      dirs: ["Smallest first", "Largest first"],
      first: -1,
    },
    ai: {
      label: "Agent sessions",
      dirs: ["Fewest first", "Most first"],
      first: -1,
    },
    priority: {
      label: "Priority",
      dirs: ["High first", "Low first"],
      first: 1,
    },
    deadline: {
      label: "Deadline",
      dirs: ["Soonest first", "Latest first"],
      first: 1,
    },
  };
const FILTERS = [
  ["all", "All files", "Everything in this folder"],
  [
    "projects",
    "Projects",
    "Every project in this folder and the folders below it",
  ],
  [
    "laci",
    "Uses laci",
    "Projects with a .laci.md: a status, deadline, to-do or notes set in laci",
  ],
  ["agents", "Agent sessions", "Projects an AI agent has worked in"],
  [
    "attention",
    "Needs attention",
    "Uncommitted, unpushed, no remote, or other problems",
  ],
  ["deadline", "Has deadline", "Projects with a deadline set in laci"],
  ["priority", "High priority", "Projects marked as high priority"],
];
const EXT: Record<string, string> = {
  md: "Markdown",
  txt: "Text",
  pdf: "PDF",
  png: "Image",
  jpg: "Image",
  jpeg: "Image",
  webp: "Image",
  gif: "Image",
  svg: "SVG",
  zip: "Archive",
  gz: "Archive",
  tar: "Archive",
  json: "JSON",
  csv: "CSV",
  docx: "Word",
  xlsx: "Excel",
  pptx: "Slides",
  mp4: "Video",
  mp3: "Audio",
  sh: "Script",
  js: "JavaScript",
  ts: "TypeScript",
  py: "Python",
  html: "HTML",
  css: "CSS",
  deb: "Package",
  appimage: "App",
};
function setSort(key: SortKey, dir: number) {
  const sort = { key, dir };
  savePref("sort", sort);
  useApp.setState({ sort });
}
function filterNode(n: Node, key: string, snapshot: Snapshot) {
  return key === "laci"
    ? n.sidecar
    : key === "agents"
      ? agentCount(n, snapshot) > 0
      : key === "attention"
        ? liveIssues(n).some((i) => i.severity !== "low")
        : key === "deadline"
          ? !!deadlineInfo(n.meta.deadline)
          : key === "priority"
            ? n.meta.priority === "high"
            : true;
}
interface FolderRow extends Entry {
  n?: Node;
  pre?: string;
}
export function Folder() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const listing = s.listings[s.cwd];
  useEffect(() => {
    void readListing(s.cwd, true);
  }, [s.cwd, listing]);
  const scope = Object.values(snapshot.nodes).filter(
    (n) =>
      n.kind === "project" &&
      within(n.path, s.cwd) &&
      (s.showArchived || !n.archived),
  );
  const scopeText = `${s.filter === "all" ? "" : `In ${tilde(s.cwd, snapshot.home)} and every folder below it · `}sorted by ${SORTS[s.sort.key].label}, ${SORTS[s.sort.key].dirs[s.sort.dir > 0 ? 0 : 1].toLowerCase()}`;
  const rows = useMemo(() => {
    const rows: FolderRow[] =
      s.filter === "all"
        ? (listing?.entries ?? [])
            .filter((e) => s.hidden || !e.name.startsWith("."))
            .map((e) => ({ ...e, n: snapshot.nodes[e.path] }))
            .filter((e) => !e.n || s.showArchived || !e.n.archived)
        : Object.values(snapshot.nodes)
            .filter(
              (n) =>
                n.kind === "project" &&
                within(n.path, s.cwd) &&
                (s.showArchived || !n.archived) &&
                filterNode(n, s.filter, snapshot),
            )
            .map((n) => ({
              name: n.name,
              path: n.path,
              dir: true,
              n,
              pre: segments(n.path).slice(segments(s.cwd).length, -1).join("/"),
            }));
    const value = (row: FolderRow): string | number | undefined =>
      s.sort.key === "name"
        ? row.name.toLowerCase()
        : s.sort.key === "last"
          ? (row.n?.lastActivity?.at ?? row.newest ?? row.at)
          : s.sort.key === "size"
            ? row.n
              ? (row.n.size?.total ??
                descendants(row.n, snapshot).reduce(
                  (sum, n) => sum + (n.size?.total ?? 0),
                  0,
                ))
              : row.dir
                ? undefined
                : row.size
            : s.sort.key === "priority"
              ? row.n?.meta.priority
                ? priorityRank(row.n.meta.priority)
                : undefined
              : s.sort.key === "deadline"
                ? deadlineInfo(row.n?.meta.deadline)
                  ? row.n?.meta.deadline
                  : undefined
                : row.n
                  ? [row.n, ...descendants(row.n, snapshot)].reduce(
                      (sum, n) => sum + agentCount(n, snapshot),
                      0,
                    )
                  : undefined;
    return rows.sort((a, b) => {
      if (s.foldersFirst && a.dir !== b.dir) return a.dir ? -1 : 1;
      const va = value(a),
        vb = value(b);
      if (va === undefined || vb === undefined)
        return va === vb
          ? a.name.localeCompare(b.name)
          : va === undefined
            ? 1
            : -1;
      return (
        (va > vb ? 1 : va < vb ? -1 : 0) * s.sort.dir ||
        a.name.localeCompare(b.name)
      );
    });
  }, [
    s.filter,
    s.cwd,
    s.hidden,
    s.showArchived,
    s.foldersFirst,
    s.sort,
    snapshot,
    listing,
  ]);
  const trail = breadcrumbs(s.cwd, snapshot.home, snapshot.roots);
  const crumbLabel = (path: string, index: number) =>
    path === snapshot.home
      ? "~"
      : index === 0
        ? tilde(path, snapshot.home)
        : base(path);
  const hiddenCount =
    listing?.entries.filter((e) => e.name.startsWith(".")).length ?? 0;
  return (
    <>
      <div className="head">
        {trail.map((path, i) => (
          <span className="crumb" key={path}>
            {i === trail.length - 1 ? (
              <h1 title={path}>{crumbLabel(path, i)}</h1>
            ) : (
              <>
                <button
                  className="btn ghost sm"
                  style={{ padding: "0 4px" }}
                  onClick={() => s.cd(path)}
                >
                  {crumbLabel(path, i)}
                </button>
                <span className="faint"> / </span>
              </>
            )}
          </span>
        ))}
        <span className="count">
          {scope.length ? plural(scope.length, "project") : ""}
        </span>
        <span className="grow" />
        <div className="menu-wrap">
          <button
            className="btn sm ghost"
            aria-expanded={s.display}
            title="Sort and what to show"
            onClick={() => useApp.setState({ display: !s.display })}
          >
            <Icon name="filter" className="sm" />
            Display
          </button>
          {s.display ? (
            <div className="menu" role="dialog" aria-label="Display">
              <div className="mrow">
                <span>Sort by</span>
                <Select
                  label="Sort by"
                  value={s.sort.key}
                  onValueChange={(value) => {
                    const key = value as SortKey;
                    setSort(key, SORTS[key].first);
                  }}
                  options={Object.entries(SORTS).map(([value, item]) => ({
                    value,
                    label: item.label,
                  }))}
                />
              </div>
              <div className="mrow">
                <span>Order</span>
                <Select
                  label="Sort order"
                  value={String(s.sort.dir)}
                  onValueChange={(value) => setSort(s.sort.key, Number(value))}
                  options={SORTS[s.sort.key].dirs.map((label, i) => ({
                    value: String(i ? -1 : 1),
                    label,
                  }))}
                />
              </div>
              {s.sort.key === "last" ? (
                <div className="mrow faint">
                  When anything inside last changed: a file, a commit or an
                  agent session.
                </div>
              ) : null}
              <hr />
              {(
                [
                  ["foldersFirst", "Folders first"],
                  [
                    "hidden",
                    `Hidden files ${hiddenCount ? hiddenCount + " here · " : ""}${HIDDEN_FILES_HINT}`,
                  ],
                  ["showArchived", "Archived projects"],
                ] as const
              ).map(([key, label]) => (
                <label className="switch" key={key}>
                  {label}
                  <input
                    type="checkbox"
                    checked={s[key]}
                    onChange={(e) => {
                      savePref(
                        key === "showArchived" ? "archived" : key,
                        e.target.checked,
                      );
                      useApp.setState({ [key]: e.target.checked });
                    }}
                  />
                </label>
              ))}
            </div>
          ) : null}
        </div>
        <button
          className="icon-btn"
          title="Open in the file manager"
          aria-label="Open in file manager"
          onClick={() => external(s.cwd, "files")}
        >
          <Icon name="open" />
        </button>
        <TerminalButton
          path={s.fileSelected ? parentOf(s.fileSelected) : s.cwd}
        />
      </div>
      <div className="filterbar">
        <div className="showbar" role="group" aria-label="Show">
          {FILTERS.map(([key, label, hint]) => (
            <button
              className="chipf"
              key={key}
              aria-pressed={s.filter === key}
              title={hint}
              onClick={() => useApp.setState({ filter: key })}
            >
              {label}
              {key !== "all" ? (
                <span className="n">
                  {scope.filter((n) => filterNode(n, key, snapshot)).length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="scope" title={scopeText}>
          {cap(scopeText)}
        </span>
      </div>
      <div className="body" role="grid" aria-label="Folder contents">
        <div className="cols" role="row">
          {(
            [
              ["name", "Name", "c-name"],
              [null, "Summary", "c-sum"],
              [null, "Stack", "c-stack"],
              ["ai", "Agents", "c-ai"],
              ["last", "Modified", "c-when"],
              ["size", "Size", "c-size"],
            ] as const
          ).map(([key, label, className]) => (
            <span
              className={className}
              key={label}
              role="columnheader"
              aria-sort={
                s.sort.key === key
                  ? s.sort.dir > 0
                    ? "ascending"
                    : "descending"
                  : undefined
              }
            >
              {key ? (
                <button
                  className="sortable"
                  data-sorted={s.sort.key === key || undefined}
                  title={`Click to sort ${label.toLowerCase()}`}
                  onClick={() =>
                    setSort(
                      key,
                      s.sort.key === key ? -s.sort.dir : SORTS[key].first,
                    )
                  }
                >
                  {label}
                  <span className="ar">
                    {(s.sort.key === key ? s.sort.dir : SORTS[key].first) > 0
                      ? "↑"
                      : "↓"}
                  </span>
                </button>
              ) : (
                label
              )}
            </span>
          ))}
          <span className="c-health" role="columnheader" aria-label="Health" />
        </div>
        {s.filter === "all" && !listing ? (
          <div className="empty">Reading the folder…</div>
        ) : listing?.error && s.filter === "all" ? (
          <div className="empty">
            {listing.error}{" "}
            <button className="linkbtn" onClick={() => s.cd(parentOf(s.cwd))}>
              Go up
            </button>
          </div>
        ) : rows.length ? (
          rows.map((row) => <FolderItem key={row.path} row={row} />)
        ) : (
          <div className="empty">
            {s.filter === "all"
              ? `This folder is empty${!s.hidden && listing?.entries.length ? " (except hidden files)" : ""}.`
              : `No project here matches “${FILTERS.find((f) => f[0] === s.filter)?.[1]}”.`}
          </div>
        )}
      </div>
    </>
  );
}
function FolderItem({ row }: { row: FolderRow }) {
  const s = useApp();
  const snapshot = s.snapshot!;
  const n = row.n;
  const kids = n ? descendants(n, snapshot) : [];
  const issues = n
    ? n.kind === "project"
      ? liveIssues(n)
      : kids.filter((n) => n.kind === "project").flatMap(liveIssues)
    : [];
  const sev = issues.some((i) => i.severity === "high")
    ? "high"
    : issues.some((i) => i.severity === "med")
      ? "med"
      : null;
  const ai = n
    ? [n, ...kids].reduce((sum, n) => sum + agentCount(n, snapshot), 0)
    : 0;
  const size = n
    ? (n.size?.total ?? kids.reduce((sum, n) => sum + (n.size?.total ?? 0), 0))
    : row.dir
      ? undefined
      : row.size;
  const ext = row.name.includes(".")
    ? row.name.slice(row.name.lastIndexOf(".") + 1)
    : "";
  const pick = () => {
    if (n) {
      s.select(n.id);
      if (n.kind === "folder") s.cd(n.path);
    } else if (row.dir) s.cd(row.path);
    else useApp.setState({ fileSelected: row.path });
  };
  return (
    <div
      className={`item frow ${n?.archived ? "archived" : ""} ${!row.dir ? "file" : ""}`}
      tabIndex={0}
      role="row"
      data-id={row.path}
      data-kind={!row.dir ? "file" : n ? "node" : "dir"}
      aria-selected={n ? s.selected === n.id : s.fileSelected === row.path}
      onClick={pick}
      onDoubleClick={() => (row.dir ? s.cd(row.path) : external(row.path))}
      title={!row.dir ? "Double-click to open" : undefined}
    >
      <span role="gridcell" className="c-name">
        {n?.kind === "project" ? (
          <StatusGlyph status={n.status.value} />
        ) : (
          <span className="gl" />
        )}
        {n ? (
          <KindIcon node={n} />
        ) : (
          <Icon name={row.dir ? (row.git ? "branch" : "folder") : "file"} />
        )}
        <span className="nm">
          {row.pre ? <span className="pre">{row.pre}/</span> : null}
          {row.name}
        </span>
        {n?.kind === "project" && n.meta.priority ? (
          <PriorityGlyph priority={n.meta.priority} />
        ) : null}
        {n?.kind === "project" ? (
          <DeadlinePill deadline={n.meta.deadline} />
        ) : null}
        {n?.sidecar ? (
          <span className="dot" title="Uses laci: has a .laci.md" />
        ) : null}
      </span>
      <span role="gridcell" className="c-sum">
        {n
          ? n.kind === "folder"
            ? (n.summary?.text ??
              `${plural(kids.filter((d) => d.kind === "project").length, "project")} inside`)
            : n.summary?.text
          : row.dir
            ? row.git
              ? "Git repo outside the folders laci scans"
              : ""
            : (EXT[ext.toLowerCase()] ??
              (ext && !row.name.startsWith(".")
                ? `${ext.toUpperCase()} file`
                : ""))}
      </span>
      <span role="gridcell" className="c-stack">
        {n?.stack?.labels.slice(0, 2).map((label) => (
          <span className="tag" key={label}>
            {label}
          </span>
        ))}
      </span>
      <span role="gridcell" className="c-ai">
        {ai ? (
          <>
            <Icon name="bot" className="sm" />
            {ai}
          </>
        ) : null}
      </span>
      <span role="gridcell" className="c-when">
        <Time at={n?.lastActivity?.at ?? row.newest ?? row.at} />
      </span>
      <span role="gridcell" className="c-size">
        {bytes(size)}
      </span>
      <span
        className="c-health"
        title={issues
          .filter((i) => i.severity !== "low")
          .map((i) => i.title)
          .join("\n")}
      >
        {sev ? <SeverityGlyph severity={sev} /> : null}
      </span>
    </div>
  );
}
