import { useEffect, useRef, useState } from "react";
import { LaciMark } from "../brand";
import { Icon } from "../common";
import { useApp, readListing, setDesign, setTheme, rescan } from "../store";
import { useNow } from "../clock";
import { useUpdateStatus } from "../palette";
import { navBadges, placesCounts } from "../selectors";
import { detailedData, views } from "../words";
import { base, cap, LOCALE, plural, tilde } from "../helpers";
import type { Listing, View } from "../types";
export function Sidebar() {
  // Only what it shows: choosing a project or a toast doesn't draw the sidebar again.
  const snapshot = useApp((s) => s.snapshot!);
  const currentView = useApp((s) => s.view);
  const reportsSeen = useApp((s) => s.reportsSeen);
  const helpShown = useApp((s) => s.modal?.kind === "help");
  const error = useApp((s) => s.error);
  const updating = useApp((s) => s.busy || s.historyPending);
  const currentTheme = useApp((s) => s.theme);
  const now = useNow();
  const [railOpen, setRailOpen] = useState(false);
  const [placesOpen, setPlacesOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const placesBtn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const helpBtn = useRef<HTMLButtonElement>(null);
  const helpOpened = useRef(false);
  useEffect(() => {
    // Help's dialog loads its code the first time it opens, after the window has gone inert and let
    // go of the focus, so it can't give the focus back to its opener: Help takes it back here.
    if (helpShown || !helpOpened.current) return;
    helpOpened.current = false;
    helpBtn.current?.focus();
  }, [helpShown]);
  // Due today or overdue, or a high risk: a project that is both counts once.
  const badges = navBadges(snapshot, reportsSeen, new Date(now));
  const { today: hot, due, atRisk, suggestions, detached } = badges;
  const freshReports = currentView !== "reports" ? badges.reports : 0;
  const go = (view: View) => {
    setRailOpen(false);
    useApp.getState().navigate(view);
  };
  const nav: [View, string, string, number, string][] = [
    [
      "today",
      "Today",
      "inbox",
      hot,
      `${hot} need${hot === 1 ? "s" : ""} you today: ${plural(due, "deadline")} due or overdue, ${plural(atRisk, "other project")} at high risk`,
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
          aria-label="Search projects and actions (Ctrl K)"
          title="Search projects and actions (Ctrl K)"
          onClick={() => useApp.setState({ palette: true })}
        >
          <Icon name="search" className="sm" />
          <span>Search projects…</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>
      <div className="sb-scroll">
        {nav.map(([view, label, icon, count, what]) => (
          <button
            className="sb-item"
            key={view}
            title={count ? `${label}: ${what}` : label}
            aria-label={count ? `${label}, ${what}` : undefined}
            aria-current={currentView === view ? "page" : undefined}
            onClick={() => go(view)}
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
        <UpdateBadge
          onOpen={() => {
            go("settings");
            showUpdates();
          }}
        />
        <button
          className="sb-item"
          onClick={rescan}
          title={
            error ||
            `laci watches your folders and updates by itself. Last full scan ${new Date(snapshot.scannedAt).toLocaleTimeString(LOCALE)}. Click to scan everything again.`
          }
        >
          {!error && updating ? (
            <span className="spin sm" />
          ) : (
            <span className="live-dot" />
          )}
          <span>
            {error
              ? detailedData.scan.failed
              : updating
                ? detailedData.scan.checking
                : detailedData.scan.checked}
          </span>
        </button>
        <div className="sb-row">
          <button
            className="sb-item"
            title="Settings"
            aria-current={currentView === "settings" ? "page" : undefined}
            onClick={() => go("settings")}
          >
            <Icon name="gear" className="sm" />
            <span>Settings</span>
          </button>
          <button
            className="sb-item sb-help"
            ref={helpBtn}
            title="Help"
            onClick={() => {
              setRailOpen(false);
              helpOpened.current = true;
              useApp.setState({ modal: { kind: "help" } });
            }}
          >
            <Icon name="circle-help" className="sm" />
            <span>Help</span>
          </button>
        </div>
        <div className="sb-row">
          <DesignToggle />
          <div className="seg" role="group" aria-label="Theme">
            {(["system", "light", "dark"] as const).map((theme, i) => (
              <button
                key={theme}
                title={theme === "system" ? "Follow the system" : cap(theme)}
                aria-label={`${theme} theme`}
                aria-pressed={currentTheme === theme}
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
/**
 * Simple | Detailed, at the foot of the sidebar where Simple has its own toggle, made the same way:
 * two buttons, the design shown pressed. After a switch the focus waits on the other design's
 * toggle (store.ts). In the narrow rail only the way to Simple is left, as an icon.
 */
export function DesignToggle() {
  return (
    <div
      className="view-seg"
      role="group"
      aria-label={views.view}
      data-ui="design-toggle"
    >
      <button
        type="button"
        aria-pressed="false"
        title={views.switchTo.simple}
        onClick={() => setDesign("simple")}
      >
        <Icon name="panels-top-left" />
        <span>{views.names.simple}</span>
      </button>
      <button type="button" aria-pressed="true">
        <span>{views.names.detailed}</span>
      </button>
    </div>
  );
}
/**
 * At the foot of the sidebar while there is a new version to get, whether the daily look or Check now
 * found it: available, on its way, or installed and waiting for a restart. In the narrow rail its
 * version becomes a dot. Settings shows what to do about it.
 */
function UpdateBadge({ onOpen }: { onOpen: () => void }) {
  const update = useUpdateStatus();
  if (!update?.version || update.state === "idle") return null;
  const said = detailedData.update;
  const state =
    update.state === "ready" || update.state === "downloading"
      ? update.state
      : "available";
  const note = said.badgeNote[state](update.version);
  return (
    <button
      className="sb-item"
      data-ui="update-badge"
      title={note}
      aria-label={`${said.badge[state]}, ${note}`}
      onClick={onOpen}
    >
      <Icon
        name={state === "ready" ? "refresh-cw" : "cloud-download"}
        className="sm"
      />
      <span>{said.badge[state]}</span>
      <span className="n new">
        {state === "downloading" && update.progress !== undefined
          ? `${update.progress}%`
          : update.version}
      </span>
    </button>
  );
}
/**
 * Brings Settings › About & updates into view once Settings has drawn it: Settings reads the
 * settings before it shows them. A Settings without that section is left at its top.
 */
function showUpdates() {
  let tries = 0;
  const look = () => {
    const section = document.getElementById("settings-updates");
    if (section) {
      section.scrollIntoView({ block: "start" });
      section.focus({ preventScroll: true });
    } else if (++tries < 40) setTimeout(look, 50);
  };
  setTimeout(look, 0);
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
  const roots = useApp((s) => s.snapshot!.roots);
  const home = useApp((s) => s.snapshot!.home);
  const listings = useApp((s) => s.listings);
  const tree = useApp((s) => s.tree);
  // The folder shown in the folder view, which the tree marks.
  const shown = useApp((s) => (s.view === "folder" ? s.cwd : null));
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const items: TreeItem[] = [];
  const walk = (path: string, depth: number, ancestors: string[]) => {
    const listing = listings[path];
    const children = childDirs(listing, ancestors);
    items.push({
      path,
      depth,
      ancestors,
      expandable: !(listing && !listing.error && !children.length),
    });
    if (tree.has(path))
      for (const child of children)
        walk(child.path, depth + 1, [...ancestors, path]);
  };
  for (const path of [...roots, ...(roots.includes(home) ? [] : [home])])
    walk(path, 0, []);
  const has = (path: string | null) => items.some((i) => i.path === path);
  const active = has(focusPath)
    ? focusPath
    : shown !== null && has(shown)
      ? shown
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
    const open = tree.has(item.path);
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
        useApp.getState().cd(item.path);
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
  const snapshot = useApp((s) => s.snapshot!);
  const open = useApp((s) => s.tree.has(path));
  const listing = useApp((s) => s.listings[path]);
  const current = useApp((s) => s.view === "folder" && s.cwd === path);
  const unavailable = snapshot.rootStatus?.find(
    (root) => root.path === path && !root.available,
  );
  useEffect(() => {
    if (open) void readListing(path);
  }, [open, path, listing]);
  const count = placesCounts(snapshot)(path);
  const label = depth
    ? base(path)
    : path === snapshot.home
      ? "Home"
      : tilde(path, snapshot.home);
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
          useApp.getState().cd(path);
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
