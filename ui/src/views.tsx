import { useEffect, useMemo } from "react";
import {
  Icon,
  KindIcon,
  StatusGlyph,
  SeverityGlyph,
  Time,
  FixButton,
  Group,
  Expand,
  Ops,
} from "./common";
import {
  useApp,
  readListing,
  savePref,
  setTheme,
  external,
  rescan,
  backup,
  run,
  changed,
  toggleExpanded,
  refreshLog,
} from "./store";
import {
  agentCount,
  base,
  bytes,
  cap,
  date,
  daysBack,
  descendants,
  logKind,
  parentOf,
  plural,
  recency,
  risksOf,
  sessionsOf,
  globalSessions,
  hasSessionFile,
  taskIdentity,
  tilde,
  within,
  counted,
} from "./helpers";
import { api } from "./api";
import { Select } from "./select";
import { TerminalButton } from "./terminal-controls";
import { SessionList, requestResume } from "./session-ui";
import type { Change, Entry, Node, Snapshot, View } from "./types";
import type { SortKey } from "./store";
export function Sidebar() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const hot = risksOf(snapshot).filter((r) => r.i.severity === "high").length;
  const nav: [View, string, string, number][] = [
    ["today", "Today", "inbox", hot],
    [
      "tidy",
      "Tidy up",
      "sparkles",
      snapshot.proposals.filter((p) => p.action).length,
    ],
    [
      "agents",
      "Agent history",
      "history",
      snapshot.orphans.claude.length + snapshot.orphans.items.length,
    ],
    ["log", "Log", "scroll", 0],
  ];
  return (
    <nav id="side" className="side" aria-label="Sidebar">
      <div className="sb-top">
        <span className="logo">
          <Icon name="archive" />
        </span>
        <b>laci</b>
        <span className="grow" />
        <button
          className="icon-btn"
          title="New project"
          aria-label="New project"
          onClick={() => useApp.setState({ modal: { kind: "new" } })}
        >
          <Icon name="plus" />
        </button>
        <button
          className="icon-btn"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          onClick={() => useApp.setState({ modal: { kind: "shortcuts" } })}
        >
          <Icon name="keyboard" />
        </button>
      </div>
      <div className="sb-search-wrap">
        <button
          className="sb-search-bar"
          aria-label="Search projects and actions (Ctrl K)"
          onClick={() => useApp.setState({ palette: true })}
        >
          <Icon name="search" className="sm" />
          <span>Search projects…</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>
      <div className="sb-scroll">
        {nav.map(([view, label, icon, count]) => (
          <button
            className="sb-item"
            key={view}
            aria-current={s.view === view ? "page" : undefined}
            onClick={() => s.navigate(view)}
          >
            <Icon name={icon} />
            <span>{label}</span>
            {count ? (
              <span className={`n ${view === "today" ? "hot" : ""}`}>
                {count}
              </span>
            ) : null}
          </button>
        ))}
        <div className="sb-sec">Places</div>
        <div className="tree">
          {[
            ...snapshot.roots,
            ...(snapshot.roots.includes(snapshot.home) ? [] : [snapshot.home]),
          ].map((path) => (
            <TreeRow key={path} path={path} depth={0} />
          ))}
        </div>
      </div>
      <div className="sb-foot">
        <button
          className="sb-item"
          onClick={rescan}
          title={
            s.error ||
            `laci watches your folders and updates by itself. Last full scan ${new Date(snapshot.scannedAt).toLocaleTimeString("en-GB")}. Click to scan everything again.`
          }
        >
          {!s.error && (s.busy || s.historyPending) ? (
            <span className="spin sm" />
          ) : (
            <span className="live-dot" />
          )}
          <span>
            {s.error
              ? "Scan failed"
              : s.busy || s.historyPending
                ? "Updating…"
                : "Up to date"}
          </span>
        </button>
        <div className="sb-row">
          <button
            className="sb-item"
            aria-current={s.view === "settings" ? "page" : undefined}
            onClick={() => s.navigate("settings")}
          >
            <Icon name="gear" className="sm" />
            <span>Settings</span>
          </button>
          <div className="seg" role="group" aria-label="Theme">
            {(["system", "light", "dark"] as const).map((theme, i) => (
              <button
                key={theme}
                title={theme === "system" ? "Follow the system" : cap(theme)}
                aria-label={`${theme} theme`}
                aria-pressed={s.theme === theme}
                onClick={() => setTheme(theme)}
              >
                <Icon name={["monitor", "sun", "moon"][i]} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}
function TreeRow({
  path,
  depth,
  ancestors = [],
}: {
  path: string;
  depth: number;
  ancestors?: string[];
}) {
  const s = useApp();
  const snapshot = s.snapshot!;
  const open = s.tree.has(path);
  const unavailable = snapshot.rootStatus?.find(
    (root) => root.path === path && !root.available,
  );
  const listing = s.listings[path];
  useEffect(() => {
    if (open) void readListing(path);
  }, [open, path, listing]);
  const children = (listing?.entries ?? [])
    .filter(
      (e) =>
        e.dir &&
        !e.name.startsWith(".") &&
        !e.link &&
        !ancestors.includes(e.path),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const count = Object.values(snapshot.nodes).filter(
    (n) => n.kind === "project" && within(n.path, path),
  ).length;
  const label = depth
    ? base(path)
    : path === snapshot.home
      ? "Home"
      : tilde(path, snapshot.home);
  return (
    <>
      <div
        className="tree-row"
        style={{ paddingLeft: depth * 14 }}
        aria-current={
          s.view === "folder" && s.cwd === path ? "true" : undefined
        }
      >
        {listing && !listing.error && !children.length ? (
          <span className="tw" />
        ) : (
          <button
            className="tw"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
            onClick={() =>
              useApp.setState((st) => {
                const tree = new Set(st.tree);
                if (open) tree.delete(path);
                else tree.add(path);
                return { tree };
              })
            }
          >
            <Icon name="chev" />
          </button>
        )}
        <button
          className="tl"
          onClick={() => s.cd(path)}
          title={unavailable?.reason}
        >
          <Icon
            name={depth ? "folder" : path === snapshot.home ? "home" : "drive"}
          />
          <span className={!depth && path !== snapshot.home ? "mono" : ""}>
            {label}
          </span>
          {unavailable ? (
            <span className="faint root-offline">Unavailable</span>
          ) : count ? (
            <span className="n">{count}</span>
          ) : null}
        </button>
      </div>
      {open
        ? children.map((child) => (
            <TreeRow
              key={child.path}
              path={child.path}
              depth={depth + 1}
              ancestors={[...ancestors, path]}
            />
          ))
        : null}
    </>
  );
}
export function Today() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const all = Object.values(snapshot.nodes);
  const risks = risksOf(snapshot);
  const recent = all
    .filter((n) => n.kind === "project" && !n.archived)
    .sort(recency)
    .slice(0, 5);
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
            [recent.length, "active", "play", "sec-recent", ""],
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
                <FixButton node={n} code={i.code} className="act" />
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
        ? n.issues.some((i) => i.severity !== "low")
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
              pre: n.path
                .slice(s.cwd.length + 1)
                .split("/")
                .slice(0, -1)
                .join("/"),
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
  const anchor = within(s.cwd, snapshot.home)
    ? snapshot.home
    : ([...snapshot.roots]
        .filter((root) => within(s.cwd, root))
        .sort((a, b) => b.length - a.length)[0] ?? "/");
  const rel = s.cwd
    .slice(anchor === "/" ? 1 : anchor.length)
    .split("/")
    .filter(Boolean);
  const trail = [
    anchor,
    ...rel.map(
      (_, i) =>
        `${anchor === "/" ? "" : anchor}/${rel.slice(0, i + 1).join("/")}`,
    ),
  ];
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
                    `Hidden files ${hiddenCount ? hiddenCount + " here · " : ""}Ctrl H`,
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
      ? n.issues
      : kids.filter((n) => n.kind === "project").flatMap((n) => n.issues)
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
const CATS: Record<string, [string, string, string]> = {
  reconnect: [
    "Reconnect",
    "link",
    "History that lost its folder, and where it probably went",
  ],
  migration: [
    "Half-done moves",
    "route",
    "Folders moved before, with history still pointing at the old place",
  ],
  space: [
    "Free space",
    "drive",
    "Dependencies and build output in projects you don’t use",
  ],
  duplicate: ["Duplicates", "layers", "The same repo cloned more than once"],
  orphan: ["Orphaned", "unlink", "History for folders that no longer exist"],
  status: ["Archive", "archive", "Projects with no activity for a long time"],
};
export function Tidy() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const counts: Record<string, number> = {};
  for (const p of snapshot.proposals)
    counts[p.category] = (counts[p.category] ?? 0) + 1;
  return (
    <>
      <div className="head">
        <h1>Tidy up</h1>
        <span className="count">
          {plural(snapshot.proposals.length, "suggestion")}
        </span>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>
          Review changes before applying. Undo journaled changes in Log; restore
          deleted projects from Trash.
        </span>
      </div>
      <div className="filterbar">
        <div className="showbar" role="group" aria-label="Show">
          <button
            className="chipf"
            aria-pressed={s.tidyFilter === "all"}
            onClick={() => useApp.setState({ tidyFilter: "all" })}
          >
            All <span className="n">{snapshot.proposals.length}</span>
          </button>
          {Object.entries(CATS)
            .filter(([key]) => counts[key])
            .map(([key, [label, icon, hint]]) => (
              <button
                className="chipf"
                key={key}
                aria-pressed={s.tidyFilter === key}
                title={hint}
                onClick={() => useApp.setState({ tidyFilter: key })}
              >
                <Icon name={icon} className="sm" />
                {label}
                <span className="n">{counts[key]}</span>
              </button>
            ))}
        </div>
      </div>
      <div className="body">
        {Object.entries(CATS)
          .filter(
            ([key]) =>
              counts[key] && (s.tidyFilter === "all" || s.tidyFilter === key),
          )
          .map(([key, [title, icon, hint]]) => (
            <Group
              key={key}
              title={title}
              icon={icon}
              count={counts[key]}
              hint={hint}
              order="Surest first"
            >
              {snapshot.proposals
                .filter((p) => p.category === key)
                .sort(
                  (a, b) =>
                    ({ high: 0, med: 1, low: 2 })[a.confidence] -
                    { high: 0, med: 1, low: 2 }[b.confidence],
                )
                .map((p) => (
                  <div
                    className="prop-row"
                    data-id={p.id}
                    key={p.id}
                    data-open={!!s.expanded[p.id]}
                  >
                    <div
                      className="item"
                      tabIndex={0}
                      aria-expanded={!!s.expanded[p.id]}
                      onClick={() => toggleExpanded(p.id)}
                    >
                      <Icon name="chev" className="sm chev" />
                      <span
                        className="name"
                        style={{
                          maxWidth: "none",
                          flex: 1,
                          whiteSpace: "normal",
                        }}
                      >
                        {p.title}
                      </span>
                      <span className="meta">
                        <span className={`conf ${p.confidence}`}>
                          {cap(p.confidence)} confidence
                        </span>
                        <span>{plural(p.ops.length, "change")}</span>
                      </span>
                    </div>
                    {s.expanded[p.id] ? (
                      <div className="prop-body">
                        <p>{p.why}</p>
                        <Ops ops={p.ops} />
                        <div className="row-acts">
                          {p.action ? (
                            <button
                              className="btn sm primary"
                              disabled={s.historyPending}
                              onClick={() => {
                                if (p.category === "orphan") {
                                  useApp.setState({
                                    modal: { kind: "orphan", id: p.id },
                                  });
                                  return;
                                }
                                if (p.action?.type === "archive") {
                                  useApp.setState({
                                    modal: {
                                      kind: "archive",
                                      id: p.action.nodeId,
                                    },
                                  });
                                  return;
                                }
                                void run(
                                  async () =>
                                    changed(
                                      await api<Change>("apply", { id: p.id }),
                                      "Changes applied",
                                    ),
                                  "Applying changes…",
                                  { history: true },
                                );
                              }}
                            >
                              {p.category === "orphan"
                                ? "Review history…"
                                : p.action.type === "archive"
                                  ? "Archive…"
                                  : `Apply ${plural(p.ops.length, "change")}`}
                            </button>
                          ) : (
                            <span className="muted" style={{ fontSize: 12 }}>
                              Nothing to apply automatically. Open both and
                              decide which one to keep.
                            </span>
                          )}
                          {p.action?.type === "archive" && p.nodeId ? (
                            <button
                              className="btn sm"
                              disabled={s.historyPending}
                              onClick={() =>
                                useApp.setState({
                                  modal: { kind: "delete", id: p.nodeId! },
                                })
                              }
                            >
                              Move to Trash…
                            </button>
                          ) : null}
                          {p.nodeId && snapshot.nodes[p.nodeId] ? (
                            <>
                              <span className="grow" />
                              <button
                                className="btn sm ghost"
                                onClick={() => s.select(p.nodeId!)}
                              >
                                Open {snapshot.nodes[p.nodeId].label}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
            </Group>
          ))}
        {!Object.keys(CATS).some(
          (key) =>
            counts[key] && (s.tidyFilter === "all" || s.tidyFilter === key),
        ) ? (
          <div className="empty">
            {s.historyPending ? "Updating…" : "Nothing to tidy here."}
          </div>
        ) : null}
      </div>
    </>
  );
}
export function AgentsView() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const linked = Object.values(snapshot.nodes)
    .filter(
      (n) =>
        sessionsOf(n, snapshot).length ||
        n.agents.claude.length ||
        n.agents.items.some((id) => counted(id, snapshot)),
    )
    .map((n) => ({
      n,
      sessions: agentCount(n, snapshot),
      memory: n.agents.claude.reduce(
        (sum, key) => sum + (snapshot.claude[key]?.memory.length ?? 0),
        0,
      ),
      bytes:
        n.agents.claude.reduce(
          (sum, key) => sum + (snapshot.claude[key]?.bytes ?? 0),
          0,
        ) +
        n.agents.items
          .filter((id) => counted(id, snapshot))
          .reduce((sum, id) => sum + (snapshot.items[id]?.bytes ?? 0), 0),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  const maximum = Math.max(...linked.map((l) => l.bytes), 1);
  const orphanGroups = new Map<string, (typeof snapshot.items)[string][]>();
  for (const id of snapshot.orphans.items) {
    const item = snapshot.items[id];
    if (!item) continue;
    const key = `${item.connector}:${item.cwd ?? item.file}`;
    orphanGroups.set(key, [...(orphanGroups.get(key) ?? []), item]);
  }
  const orphans = [
    ...snapshot.orphans.claude.flatMap((key) => {
      const dir = snapshot.claude[key];
      return dir
        ? [
            {
              name: key,
              what: `${plural(dir.sessions.length, "session")} · ${plural(dir.memory.length, "memory file")}`,
              at: dir.sessions[0]?.at,
              tool: "Claude Code",
              unavailable: dir.availability === "unavailable",
            },
          ]
        : [];
    }),
    ...[...orphanGroups.values()].map((list) => ({
      name: tilde(list[0].cwd ?? list[0].file, snapshot.home),
      what: plural(
        list.length,
        snapshot.connectors.find((c) => c.id === list[0].connector)?.link
          .kind === "cwd"
          ? "session"
          : "folder",
      ),
      at: list[0].at,
      unavailable: list.some((item) => item.availability === "unavailable"),
      tool:
        snapshot.connectors.find((c) => c.id === list[0].connector)?.name ??
        list[0].connector,
    })),
  ];
  const addPreset = (id: string) =>
    void run(
      async () => {
        const change = await api<Change>("connector/add", { preset: id });
        const name =
          snapshot.suggestions.find((c) => c.id === id)?.name ?? "connector";
        changed(change, `Added ${name}`);
      },
      "Adding connector…",
      { history: true },
    );
  const outsideSessions = globalSessions(snapshot);
  const globalDirs = snapshot.global.claude.flatMap((id) =>
    snapshot.claude[id]?.memory.length ? [snapshot.claude[id]] : [],
  );
  const globalItems = snapshot.global.items.flatMap((id) =>
    snapshot.items[id] && !hasSessionFile(snapshot.items[id].file, snapshot)
      ? [snapshot.items[id]]
      : [],
  );
  return (
    <>
      <div className="head">
        <h1>Agent history</h1>
        <span className="count">
          {snapshot.connectors.length
            ? plural(snapshot.connectors.length, "connector")
            : "No connectors yet"}
        </span>
        <span className="grow" />
        {snapshot.connectors.length ? (
          <button className="btn sm" onClick={backup}>
            Back up logs now
          </button>
        ) : null}
      </div>
      <div className="body">
        {snapshot.suggestions
          .filter((x) => x.found)
          .map((x) => (
            <div className="callout" key={x.id}>
              <Icon name="sparkles" />
              <div className="txt">
                <b>{x.name} history found on this PC</b>
                <p>
                  {x.about}
                  {x.detail ? ` · ${x.detail}` : ""}. Add it so it shows on
                  projects and moves with them.
                </p>
              </div>
              <button
                className="btn sm"
                disabled={s.historyPending}
                onClick={() => addPreset(x.id)}
              >
                Add {x.name}
              </button>
            </div>
          ))}
        {snapshot.connectors.length ? (
          <div className="stats">
            {snapshot.connectors.map((c) => (
              <div className="stat" key={c.id}>
                <div className="top">
                  <span className="k">{c.name}</span>
                  {!c.builtin ? <span className="tag">Custom</span> : null}
                </div>
                <div className={`v ${!c.present ? "none" : ""}`}>
                  {c.present ? bytes(c.bytes) : "Nothing here yet"}
                </div>
                <p>
                  {c.about}
                  {c.present && c.id !== "claude"
                    ? ` · ${plural(c.count, c.link.kind === "cwd" ? "log" : c.link.kind === "named" ? "folder" : "file")}`
                    : ""}
                </p>
                <div className="p">{c.where}</div>
                <div className="mv">
                  On move: {c.moves.charAt(0).toLowerCase() + c.moves.slice(1)}
                </div>
                <div className="foot">
                  <span className="grow" />
                  <button
                    className="btn sm ghost"
                    disabled={s.historyPending}
                    onClick={() =>
                      void run(
                        async () => {
                          changed(
                            await api<Change>("connector/remove", { id: c.id }),
                            `Removed ${c.name}`,
                            "Its files stay where they are, but laci no longer shows them or moves them with projects.",
                          );
                        },
                        "Removing connector…",
                        { history: true },
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              className="stat add"
              disabled={s.historyPending}
              onClick={() => useApp.setState({ modal: { kind: "connector" } })}
            >
              <Icon name="plus" />
              <span>Add a connector</span>
              <small className="faint">Another AI tool you use</small>
            </button>
          </div>
        ) : (
          <div className="empty-hero">
            <h2>Connect the AI tools you use</h2>
            <p>
              laci reads where each tool keeps its sessions, shows them on the
              right project, and carries them along when you move or archive
              one.
            </p>
            <button
              className="btn primary"
              disabled={s.historyPending}
              onClick={() => useApp.setState({ modal: { kind: "connector" } })}
            >
              <Icon name="plus" className="sm" />
              Add a connector
            </button>
          </div>
        )}
        {snapshot.connectors.length ? (
          <>
            <Group
              title="Detached"
              count={orphans.length}
              hint="Missing or unavailable project locations"
              right={
                <button className="btn sm" onClick={() => s.navigate("tidy")}>
                  Fix in Tidy up
                </button>
              }
            >
              {orphans.map((o, i) => (
                <div className="item" key={i}>
                  <Icon name="unlink" />
                  <span
                    className="name mono"
                    style={{ fontWeight: 400, maxWidth: "48%" }}
                  >
                    {o.name}
                  </span>
                  <span className="d">
                    {o.unavailable
                      ? "Location unavailable · "
                      : "Confirmed missing · "}
                    {o.what}
                  </span>
                  <span className="meta">
                    <span className="pill">{o.tool}</span>
                    <span className="mono">{date(o.at)}</span>
                  </span>
                </div>
              ))}
              {!orphans.length ? (
                <div className="empty">
                  No detached history found. Unavailable locations stay
                  protected from cleanup.
                </div>
              ) : null}
            </Group>
            <Group title="By project" count={linked.length}>
              {linked.map(({ n, sessions, memory, bytes: b }) => (
                <div
                  className="item"
                  key={n.id}
                  tabIndex={0}
                  data-id={n.id}
                  aria-selected={s.selected === n.id}
                  onClick={() => s.select(n.id, "agents")}
                >
                  <KindIcon node={n} />
                  <span className="name">{n.label}</span>
                  <span className="d">
                    {plural(sessions, "session")}
                    {memory ? ` · ${plural(memory, "memory file")}` : ""}
                  </span>
                  <span className="meta">
                    <span className="meter">
                      <i
                        style={{
                          width: `${Math.max(2, (b / maximum) * 100)}%`,
                        }}
                      />
                    </span>
                    <span
                      className="mono"
                      style={{ width: 56, textAlign: "right" }}
                    >
                      {bytes(b)}
                    </span>
                  </span>
                </div>
              ))}
              {!linked.length ? (
                <div className="empty">No project has agent history yet.</div>
              ) : null}
            </Group>
          </>
        ) : null}
        {outsideSessions.length ? (
          <Group
            title="Sessions outside project folders"
            count={outsideSessions.length}
            hint="Includes Home sessions and folders outside the scan"
          >
            <SessionList sessions={outsideSessions} />
          </Group>
        ) : null}
        {globalDirs.length || globalItems.length ? (
          <Group
            title="Outside project folders"
            count={globalDirs.length + globalItems.length}
          >
            {globalDirs.map((c) => (
              <div className="item" key={c.name}>
                <Icon name="folder" />
                <span className="name mono" style={{ fontWeight: 400 }}>
                  {tilde(c.path, snapshot.home)}
                </span>
                <span className="d">
                  {plural(c.memory.length, "memory file")}
                </span>
                <span className="meta">
                  <span className="mono">{bytes(c.bytes)}</span>
                </span>
              </div>
            ))}
            {globalItems.map((item) => (
              <div className="item" key={item.id}>
                <Icon name="bot" />
                <span className="name mono">
                  {tilde(item.cwd ?? item.file, snapshot.home)}
                </span>
                <span className="d">
                  {
                    snapshot.connectors.find((c) => c.id === item.connector)
                      ?.name
                  }
                </span>
                <span className="meta">
                  <span className="mono">{bytes(item.bytes)}</span>
                  <Time at={item.at} />
                </span>
              </div>
            ))}
          </Group>
        ) : null}
        {snapshot.unmatched.length ? (
          <Group
            title="Not matched"
            count={snapshot.unmatched.length}
            hint="Named by a hash of a folder laci didn't scan"
          >
            {snapshot.unmatched.flatMap((id) => {
              const item = snapshot.items[id];
              return item
                ? [
                    <div className="item" key={id}>
                      <Icon name="history" />
                      <span className="name mono" style={{ fontWeight: 400 }}>
                        {base(item.file).slice(0, 12)}…
                      </span>
                      <span className="d">
                        {
                          snapshot.connectors.find(
                            (c) => c.id === item.connector,
                          )?.name
                        }
                      </span>
                      <span className="meta">
                        <span className="mono">{bytes(item.bytes)}</span>
                        <span className="mono">{date(item.at)}</span>
                      </span>
                    </div>,
                  ]
                : [];
            })}
          </Group>
        ) : null}
      </div>
    </>
  );
}
const LOG_FILTERS = [
  ["all", "All"],
  ["moves", "Moves and archives"],
  ["projects", "Project edits"],
  ["setup", "Settings"],
  ["agent", "By agents"],
];
export function LogView() {
  const s = useApp();
  const log = s.activity;
  useEffect(() => {
    void refreshLog();
  }, []);
  const filter = (
    entry: NonNullable<typeof log>["entries"][number],
    key: string,
  ) =>
    key === "moves"
      ? logKind(entry) === "move"
      : key === "projects"
        ? ["meta", "todo", "notes", "new"].includes(logKind(entry))
        : key === "setup"
          ? logKind(entry) === "setup"
          : key === "agent"
            ? entry.by === "agent"
            : true;
  const groups = new Map<string, NonNullable<typeof log>["entries"]>();
  for (const entry of log?.entries.filter((e) => filter(e, s.logFilter)) ??
    []) {
    const day = new Date(entry.at);
    const back = daysBack(day);
    const label =
      back === 0
        ? "Today"
        : back === 1
          ? "Yesterday"
          : day.toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "short",
              ...(day.getFullYear() !== new Date().getFullYear()
                ? { year: "numeric" }
                : {}),
            });
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }
  const icons: Record<string, string> = {
    undo: "undo",
    move: "route",
    meta: "rename",
    todo: "keep",
    notes: "file",
    setup: "gear",
    new: "plus",
    other: "history",
  };
  return (
    <>
      <div className="head">
        <h1>Log</h1>
        <span className="count">
          {log ? plural(log.entries.length, "change") : ""}
        </span>
        <span className="grow" />
        <button
          className="btn sm ghost"
          title={log?.file}
          onClick={() => void run(() => api("log/open"))}
        >
          <Icon name="file" className="sm" />
          Debug log
        </button>
      </div>
      <div className="filterbar">
        <div className="showbar" role="group" aria-label="Show">
          {LOG_FILTERS.map(([key, label]) => (
            <button
              className="chipf"
              key={key}
              aria-pressed={s.logFilter === key}
              onClick={() => useApp.setState({ logFilter: key })}
            >
              {label}
              {key !== "all" ? (
                <span className="n">
                  {log?.entries.filter((e) => filter(e, key)).length ?? 0}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="scope">
          Everything laci changed, from the app or an agent · newest first
        </span>
      </div>
      <div className="body">
        {!log ? (
          <div className="empty">Reading the log…</div>
        ) : log.error ? (
          <div className="empty">{log.error}</div>
        ) : (
          [...groups.entries()].map(([label, entries]) => (
            <Group title={label} count={entries.length} key={label}>
              {entries.map((entry) => {
                const key = "log:" + entry.id;
                const open = !!s.expanded[key];
                const more = !!entry.steps?.length || !!entry.error;
                const n = entry.path
                  ? s.snapshot?.nodes[entry.path]
                  : undefined;
                return (
                  <div className="prop-row" data-open={open} key={entry.id}>
                    <div
                      className="item two"
                      tabIndex={more ? 0 : undefined}
                      aria-expanded={more ? open : undefined}
                      onClick={() => more && toggleExpanded(key)}
                    >
                      {more ? <Icon name="chev" className="sm chev" /> : null}
                      <Icon name={icons[logKind(entry)]} />
                      <div className="lines">
                        <div className="l1">
                          <span
                            className="t"
                            style={{ maxWidth: "none", whiteSpace: "normal" }}
                          >
                            {entry.title}
                          </span>
                          {n && !entry.title.includes(n.name) ? (
                            <span className="pill">{n.label}</span>
                          ) : null}
                        </div>
                        {entry.detail ? (
                          <div className="l2">
                            <span>{entry.detail}</span>
                          </div>
                        ) : null}
                      </div>
                      <span className="meta">
                        {entry.by === "agent" ? (
                          <span className="pill">
                            <Icon name="bot" className="sm" />
                            Agent
                          </span>
                        ) : null}
                        {entry.state === "undone" ? (
                          <span className="pill">Undone</span>
                        ) : entry.state === "failed" ||
                          entry.state === "running" ? (
                          <span className="pill bad">
                            {entry.state === "failed"
                              ? "Failed"
                              : "Didn’t finish"}
                          </span>
                        ) : null}
                        {entry.canUndo ? (
                          <button
                            className="btn sm act"
                            disabled={s.historyPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              void run(
                                async () => {
                                  changed(
                                    await api<Change>("log/undo", {
                                      id: entry.id,
                                    }),
                                    "Undone",
                                  );
                                },
                                "Undoing…",
                                { history: true },
                              );
                            }}
                          >
                            <Icon name="undo" className="sm" />
                            Undo
                          </button>
                        ) : entry.superseded ? (
                          <span
                            className="faint"
                            style={{ fontSize: 12 }}
                            title="Changed again later. Undo the newer change first."
                          >
                            Changed since
                          </span>
                        ) : null}
                        <span className="mono">
                          <Time at={entry.at} long />
                        </span>
                      </span>
                    </div>
                    {open ? (
                      <div className="prop-body">
                        {entry.error ? (
                          <p style={{ color: "var(--red)" }}>{entry.error}</p>
                        ) : null}
                        {entry.steps?.length ? <Ops ops={entry.steps} /> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </Group>
          ))
        )}
        {log && !log.error && !groups.size ? (
          <div className="empty">
            Nothing yet. Moves, archives, status changes, to-dos and notes show
            up here, with a way to undo them.
          </div>
        ) : null}
      </div>
    </>
  );
}
