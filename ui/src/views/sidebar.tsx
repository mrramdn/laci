import { useEffect, useMemo, useRef, useState } from "react";
import { LaciMark } from "../brand";
import { Icon } from "../common";
import { useApp, readListing, setTheme, rescan } from "../store";
import { useNow } from "../clock";
import { withMod } from "../platform";
import {
  base,
  cap,
  deadlinesOf,
  LOCALE,
  plural,
  risksOf,
  todayBadge,
  tilde,
  within,
} from "../helpers";
import type { Listing, View } from "../types";
export function Sidebar() {
  const s = useApp();
  useNow();
  const snapshot = s.snapshot!;
  const [railOpen, setRailOpen] = useState(false);
  const [placesOpen, setPlacesOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const placesBtn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const hot = todayBadge(snapshot);
  // Same projects todayBadge counts: due today or overdue, or a high risk. One that is both counts once.
  const due = new Set(
    deadlinesOf(snapshot)
      .filter(({ info }) => info.days <= 0)
      .map(({ n }) => n.id),
  );
  const atRisk = risksOf(snapshot).filter(
    ({ n, issues }) =>
      !due.has(n.id) && issues.some((i) => i.severity === "high"),
  ).length;
  const suggestions = snapshot.proposals.filter((p) => p.action).length;
  const detached =
    snapshot.orphans.claude.length + snapshot.orphans.items.length;
  const reportsReady = Boolean(
    snapshot.reportsDir && !snapshot.reportsDir.error,
  );
  const newReports = useMemo(
    () =>
      (snapshot.reports ?? []).filter(
        (r) => Date.parse(r.modified) > s.reportsSeen,
      ).length,
    [snapshot.reports, s.reportsSeen],
  );
  const freshReports = reportsReady && s.view !== "reports" ? newReports : 0;
  const nav: [View, string, string, number, string][] = [
    [
      "today",
      "Today",
      "inbox",
      hot,
      `${hot} need${hot === 1 ? "s" : ""} you today: ${plural(due.size, "deadline")} due or overdue, ${plural(atRisk, "other project")} at high risk`,
    ],
    [
      "tidy",
      "Tidy up",
      "sparkles",
      suggestions,
      `${plural(suggestions, "suggestion")} to review`,
    ],
    [
      "agents",
      "Agents",
      "history",
      detached,
      `${detached} detached agent ${detached === 1 ? "history" : "histories"}: the project folder is missing or unavailable`,
    ],
    ...(snapshot.reportsDir
      ? ([
          [
            "reports",
            "Reports",
            "report",
            freshReports,
            `${plural(freshReports, "new report")} since you last opened Reports`,
          ],
        ] as [View, string, string, number, string][])
      : []),
    ["log", "Log", "scroll", 0, ""],
  ];
  useEffect(() => {
    if (!railOpen && !placesOpen) return;
    const away = (event: PointerEvent) => {
      if (navRef.current?.contains(event.target as Node)) return;
      setRailOpen(false);
      setPlacesOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [railOpen, placesOpen]);
  useEffect(() => {
    if (placesOpen)
      panel.current
        ?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
        ?.focus();
  }, [placesOpen]);
  const closePlaces = () => {
    setPlacesOpen(false);
    placesBtn.current?.focus();
  };
  return (
    <nav
      id="side"
      ref={navRef}
      className={`side ${railOpen ? "rail-open" : ""}`}
      aria-label="Sidebar"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (placesOpen) {
          event.preventDefault();
          closePlaces();
        } else if (railOpen) {
          event.preventDefault();
          setRailOpen(false);
          navRef.current
            ?.querySelector<HTMLElement>(".sb-rail-toggle")
            ?.focus();
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next)) {
          setRailOpen(false);
          setPlacesOpen(false);
        }
      }}
    >
      <div className="sb-top">
        <button
          className="icon-btn sb-rail-toggle"
          title={railOpen ? "Close sidebar" : "Open sidebar"}
          aria-label={railOpen ? "Close sidebar" : "Open sidebar"}
          aria-expanded={railOpen}
          onClick={() => {
            setPlacesOpen(false);
            setRailOpen(!railOpen);
          }}
        >
          <Icon name="layers" />
        </button>
        <span className="logo">
          <LaciMark size={24} />
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
          aria-label={`Search projects and actions (${withMod("K")})`}
          title={`Search projects and actions (${withMod("K")})`}
          onClick={() => useApp.setState({ palette: true })}
        >
          <Icon name="search" className="sm" />
          <span>Search projects…</span>
          <kbd>{withMod("K")}</kbd>
        </button>
      </div>
      <div className="sb-scroll">
        {nav.map(([view, label, icon, count, what]) => (
          <button
            className="sb-item"
            key={view}
            title={count ? `${label}: ${what}` : label}
            aria-label={count ? `${label}, ${what}` : undefined}
            aria-current={s.view === view ? "page" : undefined}
            onClick={() => {
              setRailOpen(false);
              s.navigate(view);
            }}
          >
            <Icon name={icon} />
            <span>{label}</span>
            {count ? (
              <span
                className={`n ${view === "today" ? "hot" : view === "reports" ? "new" : ""}`}
                title={what}
              >
                {count}
              </span>
            ) : null}
          </button>
        ))}
        <button
          className="sb-item sb-places"
          ref={placesBtn}
          title="Places"
          aria-label="Places"
          aria-expanded={placesOpen}
          aria-controls="places-panel"
          onClick={() => setPlacesOpen(!placesOpen)}
        >
          <Icon name="folder" />
          <span>Places</span>
        </button>
        <div className="sb-sec">Places</div>
        <Tree onChoose={() => setRailOpen(false)} />
      </div>
      {placesOpen ? (
        <div className="places-panel" id="places-panel" ref={panel}>
          <Tree onChoose={closePlaces} />
        </div>
      ) : null}
      <div className="sb-foot">
        <button
          className="sb-item"
          onClick={rescan}
          title={
            s.error ||
            `laci watches your folders and updates by itself. Last full scan ${new Date(snapshot.scannedAt).toLocaleTimeString(LOCALE)}. Click to scan everything again.`
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
            title="Settings"
            aria-current={s.view === "settings" ? "page" : undefined}
            onClick={() => {
              setRailOpen(false);
              s.navigate("settings");
            }}
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
function childDirs(listing: Listing | undefined, ancestors: string[]) {
  return (listing?.entries ?? [])
    .filter(
      (e) =>
        e.dir &&
        !e.name.startsWith(".") &&
        !e.link &&
        !ancestors.includes(e.path),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
type TreeItem = {
  path: string;
  depth: number;
  ancestors: string[];
  expandable: boolean;
};
function Tree({ onChoose }: { onChoose: () => void }) {
  const s = useApp();
  const snapshot = s.snapshot!;
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const items: TreeItem[] = [];
  const walk = (path: string, depth: number, ancestors: string[]) => {
    const listing = s.listings[path];
    const children = childDirs(listing, ancestors);
    items.push({
      path,
      depth,
      ancestors,
      expandable: !(listing && !listing.error && !children.length),
    });
    if (s.tree.has(path))
      for (const child of children)
        walk(child.path, depth + 1, [...ancestors, path]);
  };
  for (const path of [
    ...snapshot.roots,
    ...(snapshot.roots.includes(snapshot.home) ? [] : [snapshot.home]),
  ])
    walk(path, 0, []);
  const has = (path: string | null) => items.some((i) => i.path === path);
  const active = has(focusPath)
    ? focusPath
    : s.view === "folder" && has(s.cwd)
      ? s.cwd
      : (items[0]?.path ?? null);
  const focusItem = (path: string) => {
    setFocusPath(path);
    ref.current
      ?.querySelectorAll<HTMLElement>('[role="treeitem"]')
      .forEach((el) => {
        if (el.dataset.path === path) el.focus();
      });
  };
  const setOpen = (path: string, open: boolean) =>
    useApp.setState((st) => {
      const tree = new Set(st.tree);
      if (open) tree.add(path);
      else tree.delete(path);
      return { tree };
    });
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    const at = items.findIndex((i) => i.path === row?.dataset.path);
    if (!row || at < 0) return;
    const item = items[at];
    const open = s.tree.has(item.path);
    let go: string | undefined;
    switch (event.key) {
      case "ArrowDown":
        go = items[at + 1]?.path ?? item.path;
        break;
      case "ArrowUp":
        go = items[at - 1]?.path ?? item.path;
        break;
      case "Home":
        go = items[0].path;
        break;
      case "End":
        go = items[items.length - 1].path;
        break;
      case "ArrowRight":
        if (!item.expandable) break;
        if (!open) setOpen(item.path, true);
        else if (items[at + 1]?.depth === item.depth + 1)
          go = items[at + 1].path;
        break;
      case "ArrowLeft":
        if (item.expandable && open) setOpen(item.path, false);
        else go = item.ancestors[item.ancestors.length - 1];
        break;
      case "Enter":
      case " ":
        if (event.target !== row) return;
        event.preventDefault();
        onChoose();
        s.cd(item.path);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (go) focusItem(go);
  };
  return (
    <div
      className="tree"
      role="tree"
      aria-label="Places"
      ref={ref}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const path = (event.target as HTMLElement).closest<HTMLElement>(
          '[role="treeitem"]',
        )?.dataset.path;
        if (path) setFocusPath(path);
      }}
    >
      {items.map((item) => (
        <TreeRow
          key={item.path}
          path={item.path}
          depth={item.depth}
          expandable={item.expandable}
          active={item.path === active}
          onChoose={onChoose}
        />
      ))}
    </div>
  );
}
function TreeRow({
  path,
  depth,
  expandable,
  active,
  onChoose,
}: {
  path: string;
  depth: number;
  expandable: boolean;
  active: boolean;
  onChoose: () => void;
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
  const count = Object.values(snapshot.nodes).filter(
    (n) => n.kind === "project" && within(n.path, path),
  ).length;
  const label = depth
    ? base(path)
    : path === snapshot.home
      ? "Home"
      : tilde(path, snapshot.home);
  const current = s.view === "folder" && s.cwd === path;
  return (
    <div
      className="tree-row"
      role="treeitem"
      data-path={path}
      tabIndex={active ? 0 : -1}
      aria-level={depth + 1}
      aria-label={label}
      aria-expanded={expandable ? open : undefined}
      aria-selected={current}
      style={{ paddingLeft: depth * 14 }}
      aria-current={current ? "true" : undefined}
    >
      {expandable ? (
        <button
          className="tw"
          tabIndex={-1}
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
      ) : (
        <span className="tw" />
      )}
      <button
        className="tl"
        tabIndex={-1}
        onClick={() => {
          onChoose();
          s.cd(path);
        }}
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
  );
}
