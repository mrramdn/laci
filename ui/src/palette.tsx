// The styles of the ways to switch design (the toggle, the pictures of each design, first run's
// choices) and of first run in Simple's look load with the first chunk, whichever design opens,
// since the palette is always in it. Not from looks.tsx: settings.tsx imports that, and the tests
// run settings.tsx in Node, without CSS.
import "./styles/looks.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useApp,
  goToProject,
  rescan,
  setDesign,
  setTheme,
  toast,
  urlOpen,
} from "./store";
import { useNow } from "./clock";
import { allSessions, sessionKey } from "./helpers";
import { hitTime, searchAll } from "./selectors";
import type { SearchAction, SearchHit, SearchSection } from "./selectors";
import {
  Highlight,
  Icon,
  KindIcon,
  PriorityGlyph,
  restoreFocus,
} from "./common";
import { DeadlinePill } from "./deadline";
import { useTerms } from "./terminal-api";
import { useUpdate, type UpdateStatus } from "./update";
import type { Design, View } from "./types";
import { ago as agoInWords, detailedData, search, views } from "./words";
/** Detailed's names for the groups of results. Simple's are its own, in words.ts. */
const DETAILED_GROUPS = {
  projects: "Projects",
  folders: "Folders",
  chats: "Sessions",
  summaries: "Reports",
  todos: "To-dos",
  actions: "Actions",
};
/** Where each kind of result goes: its group in DETAILED_GROUPS, and in Simple's `search.groups`. */
const GROUP_OF: Record<SearchSection, keyof typeof DETAILED_GROUPS> = {
  Projects: "projects",
  Folders: "folders",
  Sessions: "chats",
  Reports: "summaries",
  "To-dos": "todos",
  Actions: "actions",
};
/**
 * The palette's actions in `design`, as `[id, label, icon, note]`, in the order of its sidebar: each
 * design's places in its own words, then the rest, and last the switch to the other design.
 * `reports` is whether a reports folder is set: Detailed then has a Reports view of its own.
 * Detailed adds what can be done about a new version once `update` says where updates stand;
 * `terminals` is how many are open, which a restart closes.
 */
export function actionsFor(
  design: Design,
  reports: boolean,
  update: UpdateStatus | null = null,
  terminals = 0,
): SearchAction[] {
  if (design === "simple")
    return [
      ["view:today", search.actions.home, "house"],
      ["view:folder", search.actions.projects, "folder-kanban"],
      ["view:agents", search.actions.helpers, "sparkles"],
      ["view:tidy", search.actions.cleanup, "brush-cleaning"],
      ["view:log", search.actions.activity, "history"],
      ["new", search.actions.newProject, "plus"],
      ["help", search.actions.help, "circle-help"],
      ["view:settings", search.actions.settings, "gear"],
      ["rescan", search.actions.checkAgain, "refresh"],
      ["theme", search.actions.theme, "moon"],
      ["design", views.switchTo.detailed, "panels-top-left"],
    ];
  return [
    ["view:today", "Open Today", "inbox"],
    ["view:tidy", "Open Tidy up", "sparkles"],
    ["view:agents", "Open Agents", "history"],
    ...(reports
      ? [["view:reports", "Open Reports", "report"] as const]
      : []),
    ["view:log", "Open Log", "scroll"],
    ["new", "New project", "plus"],
    ["shortcuts", "Keyboard shortcuts", "keyboard"],
    ["view:settings", "Open Settings", "gear"],
    ["rescan", "Scan again", "refresh"],
    ["theme", "Switch theme", "moon"],
    ...updateActions(update, terminals),
    ["design", views.switchTo.simple, "panels-top-left"],
  ];
}
/**
 * Detailed's commands for a new version: look for one, then install it (or, for a copy a package
 * manager put in place, open its release page), then restart into it. Nothing until the desktop
 * has said where updates stand.
 */
function updateActions(
  update: UpdateStatus | null,
  terminals: number,
): SearchAction[] {
  if (!update) return [];
  const said = detailedData.update;
  const version = update.version ? said.version(update.version) : "";
  const actions: SearchAction[] = [];
  if (["idle", "available", "error"].includes(update.state))
    actions.push(["update:check", said.check, "refresh"]);
  // A download that failed can be tried again.
  if (version && (update.state === "available" || update.state === "error"))
    actions.push(
      update.install === "click"
        ? ["update:install", said.install, "cloud-download", version]
        : ["update:page", said.page, "external-link", version],
    );
  if (update.state === "ready")
    actions.push([
      "update:restart",
      said.restart,
      "refresh-cw",
      terminals ? `${version} · ${said.closes(terminals)}` : version,
    ]);
  return actions;
}
/**
 * Where an update stands, drawn again when it changes. The first to ask while nobody has asks the
 * desktop, so Detailed's badge and commands know before Settings opens. Read through a
 * subscription into the component's state, not zustand's own hook, so the tests' stand-in for React
 * can draw the sidebar and the palette.
 */
export function useUpdateStatus() {
  const [status, setStatus] = useState(() => useUpdate.getState().status);
  useEffect(() => {
    const stop = useUpdate.subscribe((update) => setStatus(update.status));
    setStatus(useUpdate.getState().status);
    if (!useUpdate.getState().status) void useUpdate.getState().refresh();
    return stop;
  }, []);
  return status;
}
/** A toast that leaves an Undo in place, as a finished scan does. One that says what failed always shows. */
function tell(title: string, message = "", error = false) {
  if (error || !useApp.getState().toast?.undo) toast(title, message, { error });
}
async function checkForUpdates() {
  const said = detailedData.update;
  tell(said.checking);
  await useUpdate.getState().check();
  const { status, refusal } = useUpdate.getState();
  if (refusal || status?.state === "error")
    tell(said.checkFailed, refusal ?? status?.error ?? "", true);
  else if (status?.version && status.state === "available")
    tell(
      said.found(status.version),
      status.install === "click" ? said.foundClick : said.foundNotice,
    );
  else if (status) tell(said.upToDate, said.current(status.current));
}
async function installUpdate() {
  const said = detailedData.update;
  await useUpdate.getState().install();
  const { status, refusal } = useUpdate.getState();
  if (refusal) tell(said.installFailed, refusal, true);
  else if (status?.version)
    tell(said.downloading(status.version), said.downloadingNote);
}
async function restartToUpdate() {
  await useUpdate.getState().restart();
  const { refusal } = useUpdate.getState();
  if (refusal) tell(detailedData.update.restartFailed, refusal, true);
}
/** Runs one of the commands `updateActions` lists; a toast says how it went. */
export async function runUpdateCommand(
  id: string,
  update: UpdateStatus | null,
) {
  if (id === "update:check") await checkForUpdates();
  else if (id === "update:install") await installUpdate();
  else if (id === "update:restart") await restartToUpdate();
  else if (id === "update:page" && update?.url) urlOpen(update.url);
}
/** Terminals whose program still runs. */
const openTerminals = () =>
  useTerms
    .getState()
    .tabs.filter((tab) => tab.exited === undefined || tab.exited === false)
    .length;
/** How long ago a result changed: Simple says it in words ("5 days ago"), Detailed in short ("5 d"). */
const timeIn = (simple: boolean, hit: SearchHit) =>
  !simple
    ? hitTime(hit)
    : hit.section === "To-dos" || hit.section === "Actions"
      ? ""
      : agoInWords(hit.at);
export function Palette() {
  const design = useApp((s) => s.design);
  const snapshot = useApp((s) => s.snapshot!);
  const update = useUpdateStatus();
  useNow();
  const simple = design === "simple";
  const groups = simple ? search.groups : DETAILED_GROUPS;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previous = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  // The search is worked out once for each scan, query and set of actions (selectors.ts); each
  // design names its groups and times in its own words.
  const items = searchAll(
    snapshot,
    query,
    actionsFor(
      design,
      Boolean(snapshot.reportsDir),
      update,
      update?.state === "ready" ? openTerminals() : 0,
    ),
  ).map((hit) => ({
    ...hit,
    section: groups[GROUP_OF[hit.section]],
    acc: timeIn(simple, hit),
  }));
  const index = Math.min(selected, Math.max(0, items.length - 1));
  function go(id: string) {
    useApp.setState({ palette: false });
    const s = useApp.getState();
    if (id.startsWith("node:")) {
      const n = snapshot.nodes[id.slice(5)];
      if (n.kind === "folder") s.cd(n.path);
      else goToProject(n.id);
    } else if (id.startsWith("session:")) {
      const session = allSessions(snapshot).find(
        (x) => "session:" + sessionKey(x) === id,
      );
      if (session)
        useApp.setState({
          modal: {
            kind: "session",
            provider: session.provider,
            sessionId: session.sessionId,
            file: session.file,
          },
        });
    } else if (id.startsWith("report:"))
      s.openReport({ id: id.slice("report:".length) });
    else if (id.startsWith("todo:")) {
      const nodeId = items.find((i) => i.id === id)?.project;
      if (nodeId) goToProject(nodeId, "todo");
    } else if (id.startsWith("view:")) s.navigate(id.slice(5) as View);
    else if (id === "new") useApp.setState({ modal: { kind: "new" } });
    else if (id === "shortcuts")
      useApp.setState({ modal: { kind: "shortcuts" } });
    else if (id === "help") s.navigate("help");
    else if (id === "design") setDesign(simple ? "detailed" : "simple");
    else if (id.startsWith("update:")) void runUpdateCommand(id, update);
    else if (id === "rescan") rescan();
    else if (id === "theme") {
      const dark =
        getComputedStyle(document.documentElement).colorScheme === "dark";
      setTheme(dark ? "light" : "dark");
    }
  }
  useLayoutEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const before = previous.current;
    return () => restoreFocus(before);
  }, []);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);
  let last = "";
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) useApp.setState({ palette: false });
      }}
    >
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label={simple ? search.label : "Jump to"}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected(Math.min(index + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected(Math.max(index - 1, 0));
          } else if (e.key === "Enter" && items[index]) {
            e.preventDefault();
            go(items[index].id);
          } else if (e.key === "Tab") {
            e.preventDefault();
            input.current?.focus();
          }
        }}
      >
        <div className="pal-in">
          <Icon name="search" />
          <input
            ref={input}
            id="pal-in"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            placeholder={
              simple
                ? search.placeholder(Boolean(snapshot.reportsDir))
                : snapshot.reportsDir
                  ? "Search projects, sessions, reports, to-dos, actions…"
                  : "Search projects, sessions, to-dos, actions…"
            }
            autoComplete="off"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={
              items[index] ? `palette-item-${index}` : undefined
            }
          />
        </div>
        <div className="pal-list" id="palette-list" role="listbox" ref={list}>
          {items.map((item, i) => {
            const header = item.section !== last;
            last = item.section;
            return (
              <div key={item.id}>
                {header ? <div className="pal-sec">{item.section}</div> : null}
                <div
                  className="pal-item"
                  role="option"
                  id={`palette-item-${i}`}
                  aria-selected={i === index}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => go(item.id)}
                >
                  {item.node ? (
                    <KindIcon node={item.node} />
                  ) : (
                    <Icon name={item.icon} />
                  )}
                  <span>
                    <Highlight text={item.label} query={query} />
                  </span>
                  {item.node?.kind === "project" && item.node.meta.priority ? (
                    <PriorityGlyph priority={item.node.meta.priority} />
                  ) : null}
                  {item.node?.kind === "project" ? (
                    <DeadlinePill deadline={item.node.meta.deadline} />
                  ) : null}
                  <span className="sub mono">
                    <Highlight text={item.sub} query={query} />
                  </span>
                  <span className="acc">{item.acc}</span>
                </div>
              </div>
            );
          })}
          {!items.length ? (
            <div className="empty">
              {simple ? search.none : "No results found"}
            </div>
          ) : null}
        </div>
        <div className="pal-foot">
          <span className="grow" />
          <span>
            {simple ? search.hints.open : "Open"} <kbd>↵</kbd>
          </span>
          <span>
            {simple ? search.hints.move : "Navigate"} <kbd>↑</kbd>
            <kbd>↓</kbd>
          </span>
          <span>
            {simple ? search.hints.close : "Close"} <kbd>esc</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
