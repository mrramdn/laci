import { create } from "zustand";
import { api, errorText } from "./api";
import type { CreationJob } from "./new-project";
import type {
  ActivityLog,
  Apps,
  Change,
  Design,
  Listing,
  Node,
  Prefs,
  RefreshStatus,
  Snapshot,
  Tab,
  TerminalTarget,
  View,
} from "./types";
export type Theme = "system" | "light" | "dark";
/** The reports a view is narrowed to: one conversation's, or one project's. */
export type ReportFilter = { sessions: string[] } | { project: string } | null;
export type SortKey = "name" | "last" | "size" | "ai" | "priority" | "deadline";
export type Modal =
  | { kind: "shortcuts" | "connector" | "help" | "copy-choice" }
  | { kind: "new"; job?: CreationJob }
  | { kind: "archive" | "delete" | "orphan" | "clean"; id: string }
  | { kind: "terminal-close"; id: string }
  | { kind: "mcp"; provider: string }
  | {
      kind: "agent";
      projectPath: string;
      provider?: string;
      sessionId?: string;
      prompt?: string;
    }
  | {
      kind: "session";
      provider: string;
      sessionId: string;
      file: string;
      projectPath?: string;
    }
  /** Delete the conversations whose newest session is one of `files`. */
  | { kind: "session-delete"; files: string[] }
  | null;
interface Toast {
  title: string;
  message: string;
  undo?: string;
  error?: boolean;
}
interface State {
  snapshot: Snapshot | null;
  error: string | null;
  errorRevision: number | null;
  busy: boolean;
  revision: number;
  statusRevision: number;
  historyPending: boolean;
  pendingSelection: string | null;
  setupPending: boolean;
  working: string;
  view: View;
  cwd: string;
  /** How many times `cd` has gone to a folder: a folder chosen again leaves `cwd` as it was. */
  folderVisits: number;
  selected: string | null;
  /** Which row was clicked, for lists that can show one project more than once. */
  selectedRow: string | null;
  tab: Tab;
  fileSelected: string | null;
  theme: Theme;
  design: Design;
  /** config.json holds a design: the user chose one. Known once `prefsReady`. */
  designSet: boolean;
  /** Set up before there were two designs, and none chosen since: Detailed can offer Simple. */
  designOffer: boolean;
  /** The saved choices arrived. Until then design and theme are what the page started with. */
  prefsReady: boolean;
  apps: Apps;
  terminalTarget: TerminalTarget;
  skipSetup: boolean;
  modal: Modal;
  palette: boolean;
  /** Simple's sheets open over its window. The window behind and the toast wait while one is. */
  sheets: number;
  /** The Settings shown have changes that aren't saved yet. A switch of design waits for them. */
  settingsDirty: boolean;
  tree: Set<string>;
  listings: Record<string, Listing>;
  expanded: Record<string, boolean>;
  sort: { key: SortKey; dir: number };
  foldersFirst: boolean;
  hidden: boolean;
  showArchived: boolean;
  filter: string;
  tidyFilter: string;
  logFilter: string;
  /** The report open in Reports. */
  report: string | null;
  reportFilter: ReportFilter;
  /** When Reports was last opened: reports changed since then count as new. 0 until a folder is set. */
  reportsSeen: number;
  display: boolean;
  activity: ActivityLog | null;
  toast: Toast | null;
  load: (snapshot: Snapshot, live?: boolean) => void;
  patch: (node: Node) => void;
  cd: (path: string) => void;
  select: (id: string, tab?: Tab, row?: string) => void;
  navigate: (view: View) => void;
  /** Show Reports with this report open, narrowed to these sessions or this project. */
  openReport: (to: { id?: string; sessions?: string[]; project?: string }) => void;
}
export function pref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`laci:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`laci:${key}`, JSON.stringify(value));
  } catch {
    /* Storage can be unavailable. */
  }
}
// The state smoke test loads this file with ./api alone, so `cd` keeps its own copy of parentOf and
// within from helpers.ts. A test checks that the two agree.
function parentOf(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
function within(path: string, root: string) {
  return (
    path === root || path.startsWith(root.endsWith("/") ? root : root + "/")
  );
}
export const useApp = create<State>((set, get) => ({
  snapshot: null,
  error: null,
  errorRevision: null,
  busy: false,
  revision: 0,
  statusRevision: 0,
  historyPending: false,
  pendingSelection: null,
  setupPending: false,
  working: "",
  view: "today",
  cwd: "",
  folderVisits: 0,
  selected: null,
  selectedRow: null,
  tab: "health",
  fileSelected: null,
  theme: (document.documentElement.dataset.theme as Theme) || "system",
  // The desktop sets these before the page paints; the `prefs` reply has the last word.
  design:
    document.documentElement.dataset.design === "simple"
      ? "simple"
      : "detailed",
  designSet: false,
  designOffer: document.documentElement.dataset.designOffer === "1",
  prefsReady: false,
  apps: { editor: "code", files: "dolphin", terminal: "kitty" },
  terminalTarget: "internal",
  skipSetup: false,
  modal: null,
  palette: false,
  sheets: 0,
  settingsDirty: false,
  tree: new Set(),
  listings: {},
  expanded: {},
  sort: pref("sort", { key: "last", dir: -1 }),
  foldersFirst: pref("foldersFirst", false),
  hidden: pref("hidden", false),
  showArchived: pref("archived", true),
  filter: "all",
  tidyFilter: "all",
  logFilter: "all",
  report: null,
  reportFilter: null,
  reportsSeen: pref("reportsSeen", 0),
  display: false,
  activity: null,
  toast: null,
  load: (snapshot, live = false) =>
    set((s) => {
      const revision = snapshot.revision ?? 0;
      if (revision < s.revision) return {};
      const historyPending = snapshot.historyPending ?? false;
      const keepError = s.errorRevision === revision;
      const ready =
        !historyPending &&
        s.pendingSelection &&
        snapshot.nodes[s.pendingSelection];
      return {
        snapshot: historyPending ? { ...snapshot, proposals: [] } : snapshot,
        terminalTarget: snapshot.terminalTarget ?? "internal",
        revision,
        historyPending,
        setupPending:
          s.setupPending && (historyPending || !snapshot.configured),
        error: keepError ? s.error : null,
        errorRevision: keepError ? s.errorRevision : null,
        cwd: s.cwd || snapshot.roots[0] || snapshot.home,
        selected: ready
          ? s.pendingSelection
          : s.selected && snapshot.nodes[s.selected]
            ? s.selected
            : null,
        pendingSelection: ready ? null : s.pendingSelection,
        tree: s.tree.size ? s.tree : new Set(snapshot.roots.slice(0, 1)),
        listings: live ? s.listings : {},
      };
    }),
  patch: (node) =>
    set((s) =>
      s.snapshot && (node.revision ?? s.revision) >= s.revision
        ? {
            revision: node.revision ?? s.revision,
            historyPending: s.historyPending || Boolean(node.historyPending),
            snapshot: {
              ...s.snapshot,
              nodes: { ...s.snapshot.nodes, [node.id]: node },
              ...(node.historyPending ? { proposals: [] } : {}),
            },
          }
        : {},
    ),
  cd: (path) => {
    const { snapshot, tree, design } = get();
    // Simple shows a project on its own page, not as a folder.
    if (design === "simple" && snapshot?.nodes[path]?.kind === "project") {
      goToProject(path);
      return;
    }
    // The tree opens every folder from the one holding `path` up to the root or Home that contains it.
    const next = new Set(tree);
    const place = [...(snapshot?.roots ?? []), snapshot?.home ?? "/"]
      .filter((r) => within(path, r))
      .sort((a, b) => b.length - a.length)[0];
    let p = parentOf(path);
    while (place && within(p, place)) {
      const top = p === place;
      next.add(p);
      const above = parentOf(p);
      // Home or the root ends it, and so does "/", which is its own parent.
      if (top || above === p) break;
      p = above;
    }
    set({
      pendingSelection: null,
      view: "folder",
      cwd: path,
      folderVisits: get().folderVisits + 1,
      fileSelected: null,
      tree: next,
      selected:
        snapshot?.nodes[path]?.kind === "project" ? path : get().selected,
    });
  },
  select: (id, tab, row) =>
    set({
      selected: id,
      selectedRow: row ?? null,
      pendingSelection: null,
      fileSelected: null,
      ...(tab ? { tab } : {}),
    }),
  navigate: (view) =>
    set({
      view,
      display: false,
      pendingSelection: null,
      // Going to Reports shows them all; the report that was open stays open.
      ...(view === "reports" ? { reportFilter: null } : {}),
    }),
  openReport: ({ id, sessions, project }) =>
    set({
      view: "reports",
      display: false,
      pendingSelection: null,
      modal: null,
      palette: false,
      report: id ?? null,
      reportFilter: sessions?.length
        ? { sessions }
        : project
          ? { project }
          : null,
    }),
}));
/** Views that use the whole width: they have no project details beside them. */
export const FULL_WIDTH: readonly View[] = ["settings", "log", "reports"];
/**
 * Show a project's details: on the project's page in Simple, and in Detailed beside the view,
 * leaving a view that has no room for them.
 */
export function goToProject(id: string, tab?: Tab) {
  const state = useApp.getState();
  if (state.design === "simple") state.navigate("project");
  else if (FULL_WIDTH.includes(state.view)) state.navigate("today");
  useApp.getState().select(id, tab);
}
export function markReportsSeen() {
  const now = Date.now();
  savePref("reportsSeen", now);
  useApp.setState({ reportsSeen: now });
}
// Reports that were in the folder before it was chosen are not news.
useApp.subscribe((state) => {
  if (state.snapshot?.reportsDir && !state.reportsSeen) markReportsSeen();
});
export function copyText(text: string, title: string, message = "") {
  void run(async () => {
    await navigator.clipboard.writeText(text);
    toast(title, message);
  });
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function dismissToastLater() {
  clearTimeout(toastTimer);
  const state = useApp.getState();
  if (state.toast?.undo && state.historyPending) return;
  toastTimer = setTimeout(
    () => useApp.setState({ toast: null }),
    state.toast?.undo ? 14000 : 7000,
  );
}
useApp.subscribe((state, previous) => {
  if (previous.historyPending && !state.historyPending && state.toast?.undo)
    dismissToastLater();
});
export function toast(
  title: string,
  message = "",
  options: { undo?: string; error?: boolean } = {},
) {
  useApp.setState({ toast: { title, message, ...options } });
  dismissToastLater();
}
export async function run<T>(
  task: () => Promise<T>,
  working = "",
  options: { history?: boolean; onError?: (error: unknown) => void } = {},
): Promise<T | undefined> {
  // Acquire before awaiting or rendering, so repeated clicks cannot queue mutations.
  if (
    working &&
    (operation || (options.history && useApp.getState().historyPending))
  )
    return undefined;
  const owner = working ? Symbol() : undefined;
  if (owner) {
    operation = owner;
    useApp.setState({ working });
  }
  try {
    return await task();
  } catch (error) {
    if (options.onError) options.onError(error);
    else toast("Couldn’t finish", errorText(error), { error: true });
    return undefined;
  } finally {
    if (owner && operation === owner) {
      operation = undefined;
      useApp.setState({ working: "" });
    }
  }
}
let operation: symbol | undefined;
let logPending: Promise<void> | undefined;
let logAgain = false;
export function refreshLog() {
  if (logPending) {
    logAgain = true;
    return logPending;
  }
  logPending = (async () => {
    do {
      logAgain = false;
      try {
        useApp.setState({ activity: await api<ActivityLog>("log") });
      } catch (error) {
        useApp.setState((s) => ({
          activity: {
            ...s.activity,
            entries: s.activity?.entries ?? [],
            error: errorText(error),
          },
        }));
      }
    } while (logAgain);
  })().finally(() => {
    logPending = undefined;
  });
  return logPending;
}
export function acknowledge(change: Change) {
  const current = useApp.getState();
  if ((change.revision ?? current.revision) < current.revision) return;
  useApp.setState((s) => {
    const revision = change.revision ?? s.revision;
    if (revision < s.revision) return {};
    const alreadyLoaded =
      s.snapshot?.revision !== undefined &&
      s.snapshot.revision >= revision &&
      !s.snapshot.historyPending;
    const historyPending =
      s.historyPending || Boolean(change.historyPending && !alreadyLoaded);
    return {
      revision,
      historyPending,
      snapshot:
        historyPending && s.snapshot
          ? { ...s.snapshot, proposals: [] }
          : s.snapshot,
    };
  });
  if (change.snapshot) useApp.getState().load(change.snapshot);
  if (change.node)
    useApp.getState().patch({
      ...change.node,
      revision: change.node.revision ?? change.revision,
    });
}
export function refreshStatus(status: RefreshStatus) {
  useApp.setState((s) => {
    const revision = status.revision ?? s.revision;
    if (revision < Math.max(s.revision, s.statusRevision)) return {};
    const historyPending = s.historyPending || Boolean(status.historyPending);
    return {
      // A scan notice can overtake useful data; only mutation fences invalidate it.
      revision: status.historyPending ? revision : s.revision,
      statusRevision: revision,
      busy: status.busy,
      historyPending,
      snapshot:
        historyPending && s.snapshot
          ? { ...s.snapshot, proposals: [] }
          : s.snapshot,
    };
  });
}
export function refreshError(error: unknown, revision?: number) {
  const state = useApp.getState();
  const failedRevision = revision ?? state.revision;
  if (failedRevision < state.revision) return;
  const message = errorText(error);
  useApp.setState({
    error: message,
    errorRevision: failedRevision,
    revision: failedRevision,
    busy: false,
  });
  if (state.snapshot) {
    const previous = state.toast;
    toast(previous?.undo ? previous.title : "Couldn’t refresh", message, {
      undo: previous?.undo,
      error: true,
    });
  }
}
export function selectWhenReady(path: string) {
  const state = useApp.getState();
  if (!state.historyPending && state.snapshot?.nodes[path]) state.select(path);
  else useApp.setState({ pendingSelection: path });
}
export function changed(change: Change, title: string, message = "") {
  acknowledge(change);
  const state = useApp.getState();
  const refreshWarning =
    state.errorRevision === (change.revision ?? state.revision)
      ? state.error
      : null;
  const warnings = [
    ...(change.warnings ?? []),
    ...(refreshWarning ? [refreshWarning] : []),
  ];
  toast(
    title,
    [warnings.join(". ") || message, change.journal?.recovery]
      .filter(Boolean)
      .join(" "),
    {
      undo: change.journal?.canUndo === false ? undefined : change.journal?.id,
      error: Boolean(warnings.length),
    },
  );
}
const listingPending = new Set<string>();
const listingAgain = new Set<string>();
export async function readListing(path: string, deep = false, force = false) {
  if (listingPending.has(path)) {
    if (force) listingAgain.add(path);
    return;
  }
  const old = useApp.getState().listings[path];
  if (!force && old && (old.error || !deep || old.deep)) return;
  listingPending.add(path);
  try {
    const listing = old && !force ? old : await api<Listing>("ls", { path });
    useApp.setState((s) => ({ listings: { ...s.listings, [path]: listing } }));
    if (deep) {
      const newest = await api<Record<string, string>>("ls/newest", { path });
      useApp.setState((s) => ({
        listings: {
          ...s.listings,
          [path]: {
            ...listing,
            deep: true,
            entries: listing.entries.map((e) => ({
              ...e,
              newest: newest[e.name] ?? e.newest,
            })),
          },
        },
      }));
    }
  } catch (error) {
    useApp.setState((s) => ({
      listings: {
        ...s.listings,
        [path]: { path, entries: [], error: errorText(error) },
      },
    }));
  } finally {
    listingPending.delete(path);
    if (listingAgain.delete(path)) void readListing(path, deep, true);
  }
}
/** Puts `theme` on the page and keeps it for the next first paint. Saving it is up to the caller. */
function showTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem("laci:theme", theme);
  } catch {
    /* Ignore storage failure. */
  }
}
export function setTheme(theme: Theme) {
  showTheme(theme);
  useApp.setState({ theme });
  void api("theme", { theme: theme === "system" ? "" : theme }).catch((error) =>
    toast("Couldn’t save theme", errorText(error), { error: true }),
  );
}
/**
 * Puts `design` on the page, with whether Detailed offers Simple, and keeps the design for the next
 * first paint. Saving it is up to the caller.
 */
function showDesign(design: Design, offer: boolean) {
  const root = document.documentElement;
  root.dataset.design = design;
  if (offer) root.dataset.designOffer = "1";
  else delete root.dataset.designOffer;
  try {
    localStorage.setItem("laci:design", design);
  } catch {
    /* Ignore storage failure. */
  }
}
/**
 * Where a switch to `design` lands. Each view has its counterpart in the other design, except a
 * project: Detailed's details panel becomes Simple's project page, and back in Detailed the project
 * shows beside Today.
 */
function viewIn(design: Design, s: State): View {
  if (design === "detailed")
    return s.view === "project" || s.view === "help" ? "today" : s.view;
  const shown = s.selected ? s.snapshot?.nodes[s.selected] : undefined;
  return shown?.kind === "project" && !FULL_WIDTH.includes(s.view)
    ? "project"
    : s.view;
}
/**
 * Switches the window to `design` and saves it. While a dialog is open or a change runs it does
 * nothing and returns false, so neither loses its place; while Settings has changes that aren't
 * saved it says so instead, as the other design's Settings would start without them.
 */
export function setDesign(design: Design): boolean {
  return keepDesign(design, true);
}
/**
 * Saves the design picked on the first-run screen and shows it, like a switch but without its toast
 * and its focus move: the choice is on the screen as it is made. It waits in the same way while a
 * dialog is open or a change runs, so call it before the setup is saved.
 */
export function chooseDesign(design: Design): boolean {
  return keepDesign(design, false);
}
/** Shows and saves `design`; `announce` says so in a toast and takes the focus along. */
function keepDesign(design: Design, announce: boolean) {
  const s = useApp.getState();
  if (s.modal || s.working) return false;
  const switched = design !== s.design;
  if (switched && s.settingsDirty) {
    // Only Simple's Settings has a Discard: Detailed's changes go when you leave Settings.
    if (announce)
      toast(
        s.design === "simple"
          ? "Save or discard your changes first"
          : "Save your settings first",
        s.design === "simple" ? "" : "Or leave Settings to drop the changes.",
      );
    return false;
  }
  if (switched && announce) focusAfterSwitch(design);
  showDesign(design, false);
  useApp.setState({
    design,
    designSet: true,
    designOffer: false,
    ...(switched ? { view: viewIn(design, s), display: false } : {}),
  });
  void api("design", { design }).catch((error) =>
    toast("Couldn’t save view", errorText(error), { error: true }),
  );
  // Choosing the design already shown only saves it, and a change's Undo stays in reach.
  if (announce && switched && !useApp.getState().toast?.undo)
    toast(
      design === "simple" ? "Now in Simple view" : "Now in Detailed view",
      "Switch back at the bottom of the sidebar.",
    );
  return true;
}
/** The Simple | Detailed toggle at the foot of each design's sidebar. */
const TOGGLE = '[data-ui="design-toggle"]';
/**
 * A switch draws the other design's window in place of this one, and the control that made it goes
 * with it. Once the other window is drawn (its code may still be loading), the focus goes to the
 * same place there: its toggle, on the design now shown, when a toggle made the switch, else the
 * page. Detailed's narrow rail hides the button of the design shown, so the focus takes the
 * toggle's other button there, and the page if the toggle has none it can take. It stays where it
 * is if something took it meanwhile, or if the design changed again.
 */
function focusAfterSwitch(design: Design) {
  if (typeof MutationObserver === "undefined" || !document.body) return;
  const fromToggle = Boolean(document.activeElement?.closest(TOGGLE));
  const before = document.querySelector(TOGGLE);
  const land = () => {
    if (document.documentElement.dataset.design !== design) return true;
    const toggle = document.querySelector(TOGGLE);
    if (!toggle || toggle === before) return false;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected)
      return true;
    const targets = [
      ...(fromToggle
        ? [
            toggle.querySelector<HTMLElement>('[aria-pressed="true"]'),
            ...toggle.querySelectorAll<HTMLElement>("button"),
          ]
        : []),
      document.getElementById("main"),
    ];
    // A button that isn't drawn doesn't take the focus: try the next.
    for (const target of targets) {
      target?.focus({ preventScroll: true });
      if (target && document.activeElement === target) break;
    }
    return true;
  };
  const observer = new MutationObserver(() => {
    if (land()) stop();
  });
  const timer = setTimeout(stop, 10_000);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
}
const isDesign = (value: unknown): value is Design =>
  value === "simple" || value === "detailed";
/**
 * The design a new install opens in, and the one its first-run screen preselects:
 * NEW_INSTALL_DESIGN in src-tauri/src/app/mod.rs, changed together.
 */
export const NEW_INSTALL_DESIGN: Design = "simple";
/**
 * The design for the saved choices: the one saved, else Detailed for a setup from before there were
 * two designs and NEW_INSTALL_DESIGN for a new one. The desktop's start-up script decides the same way.
 */
export function effectiveDesign(
  prefs: Pick<Prefs, "design" | "configured">,
): Design {
  if (isDesign(prefs.design)) return prefs.design;
  return prefs.configured ? "detailed" : NEW_INSTALL_DESIGN;
}
/**
 * Shows the choices saved in config.json, from a `prefs` reply. They win over what the page started
 * with: the desktop fixes its start-up script when the window opens, so a reload after a switch
 * brings back the old design and theme. Use a reply asked for before the window could be used, or
 * it may undo a later switch.
 */
export function applyPrefs(prefs: Prefs) {
  const design = effectiveDesign(prefs);
  const designSet = isDesign(prefs.design);
  const designOffer = prefs.configured && !designSet;
  const theme: Theme =
    prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : "system";
  showTheme(theme);
  showDesign(design, designOffer);
  useApp.setState((s) => ({
    theme,
    design,
    designSet,
    designOffer,
    prefsReady: true,
    ...(design === s.design
      ? {}
      : { view: viewIn(design, s), display: false }),
  }));
}
export function toggleExpanded(key: string) {
  useApp.setState((s) => ({
    expanded: { ...s.expanded, [key]: !s.expanded[key] },
  }));
}
export function external(id: string, what = "default", arg?: string) {
  void run(async () => {
    await api("open", { id, what, arg });
    toast("Opened", id);
  });
}
export function urlOpen(url: string) {
  void run(() => api("open/url", { url }));
}
export function rescan() {
  const revision = useApp.getState().revision;
  return run(
    async () => {
      const snapshot = await api<Snapshot>("rescan");
      useApp.getState().load(snapshot);
      if (!useApp.getState().toast?.undo)
        toast(
          "Scan finished",
          `${Object.values(snapshot.nodes).filter((n) => n.kind === "project").length} projects`,
        );
    },
    "Scanning your projects…",
    {
      onError: (error) => refreshError(error, revision),
    },
  );
}
// The store is loaded on its own by the state smoke test, so it keeps its one wording helper local.
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export function backup() {
  void run(async () => {
    const result = await api<BackupResult>("backup", {});
    if (result.snapshot) acknowledge({ snapshot: result.snapshot });
    toast(
      result.copied
        ? `Backed up ${count(result.copied, "file")}`
        : "Already backed up",
      `${count(result.sessions, "session")} kept in ${result.dest}`,
    );
    void refreshLog();
  }, "Copying agent logs…");
}
/** Opens the folder of the copy of AI chats, which can be outside home and the scan locations. */
export function openCopy(dest: string) {
  external(dest, "copy");
}
/** The engine's answer to `backup/move`: where the copy is now, and whether anything moved there. */
export interface CopyMoved {
  dest: string;
  moved: boolean;
}
/**
 * Moves the copy of AI chats to `dir`, or back to Laci's own folder for "" (`backup/move`): one change, which
 * Undo in the Log takes back. With `fresh`, a copy Laci can't reach now stays where it is and a new one starts in
 * `dir`. `words` say it in the design's own words: `said` the toast for the engine's answer (helpers.ts
 * `copyChangeSaid`). True once the folder changed.
 */
export async function moveCopy(
  dir: string,
  fresh: boolean,
  words: { moving: string; note: string; said: (answer: CopyMoved) => string },
  onError: (error: unknown) => void,
) {
  const done = await run(
    async () => {
      const change = await api<Change & CopyMoved>(
        "backup/move",
        fresh ? { dir, fresh } : { dir },
      );
      changed(change, words.said(change), words.note);
      return true;
    },
    words.moving,
    { history: true, onError },
  );
  return done === true;
}
/**
 * Chooses the projects the copy of AI chats takes, or every project for `null` (`backup/only`). One Log entry per
 * call, which Undo in the Log takes back. `say` is the toast, in the design's own words, and `note` what stays true
 * of the copy. True once the choice is saved; a refusal goes to `onError`, or a toast without it.
 */
export async function chooseCopy(
  only: { paths: string[]; outside: boolean } | null,
  say: string,
  note: string,
  onError?: (error: unknown) => void,
) {
  const done = await run(
    async () => {
      const result = await api<{ snapshot?: Snapshot }>("backup/only", { only });
      if (result.snapshot) acknowledge({ snapshot: result.snapshot });
      toast(say, note);
      void refreshLog();
      return true;
    },
    "",
    { onError },
  );
  return done === true;
}
interface BackupResult {
  copied: number;
  size: string;
  dest: string;
  sessions: number;
  total: number;
  /** The plain files of a copy from before Laci 3.1 that the run packed first, and their bytes before and after. */
  packing?: { files: number; before: number; after: number };
  snapshot?: Snapshot;
}
const AUTO_BACKUP_EVERY = 10 * 60 * 1000;
let autoBackupAt = 0;
export function autoBackup(snapshot: Snapshot | null) {
  const state = snapshot?.backup;
  // `pending` is unknown until the first backup has run, and that first run is wanted too.
  if (!state?.auto || state.pending === 0) return;
  if (Date.now() - autoBackupAt < AUTO_BACKUP_EVERY) return;
  autoBackupAt = Date.now();
  void api<Partial<BackupResult> & { skipped?: boolean }>("backup", {
    auto: true,
  })
    .then((result) => {
      // The first run after the upgrade can pack the copy and copy nothing: the Log tells that.
      if (result.skipped || !(result.copied || result.packing?.files)) return;
      if (result.snapshot) acknowledge({ snapshot: result.snapshot });
      if (result.copied)
        toast(`Backed up ${count(result.copied, "file")} automatically`);
      void refreshLog();
    })
    .catch(() => {});
}
useApp.subscribe((state, previous) => {
  if (state.snapshot !== previous.snapshot) autoBackup(state.snapshot);
});
