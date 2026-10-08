import { useEffect } from "react";
import { Icon } from "../common";
import { useApp, readListing, setTheme, rescan } from "../store";
import { base, cap, risksOf, tilde, within } from "../helpers";
import type { View } from "../types";
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
