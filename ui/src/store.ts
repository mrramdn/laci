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
  | { kind: "shortcuts" | "connector" | "help" }
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
    const next = new Set(tree);
    const place = [...(snapshot?.roots ?? []), snapshot?.home ?? "/"]
      .filter((r) => path === r || path.startsWith(r + "/"))
      .sort((a, b) => b.length - a.length)[0];
    let p = path.slice(0, path.lastIndexOf("/")) || "/";
    while (place && (p === place || p.startsWith(place + "/"))) {
      next.add(p);
      if (p === place) break;
      p = p.slice(0, p.lastIndexOf("/")) || "/";
    }
    set({
      pendingSelection: null,
      view: "folder",
      cwd: path,
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
 * nothing and returns false, so neither loses its place.
 */
export function setDesign(design: Design): boolean {
  const s = useApp.getState();
  if (s.modal || s.working) return false;
  const switched = design !== s.design;
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
  if (switched && !useApp.getState().toast?.undo)
    toast(
      design === "simple" ? "Now in Simple view" : "Now in Detailed view",
      "Switch back at the bottom of the sidebar.",
    );
  return true;
}
const isDesign = (value: unknown): value is Design =>
  value === "simple" || value === "detailed";
/** The design a new install opens in: NEW_INSTALL_DESIGN in src-tauri/src/app/mod.rs, changed together. */
export const NEW_INSTALL_DESIGN: Design = "detailed";
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
interface BackupResult {
  copied: number;
  size: string;
  dest: string;
  sessions: number;
  total: number;
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
      if (result.skipped || !result.copied) return;
      if (result.snapshot) acknowledge({ snapshot: result.snapshot });
      toast(`Backed up ${count(result.copied, "file")} automatically`);
      void refreshLog();
    })
    .catch(() => {});
}
useApp.subscribe((state, previous) => {
  if (state.snapshot !== previous.snapshot) autoBackup(state.snapshot);
});
