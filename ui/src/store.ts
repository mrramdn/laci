import { create } from "zustand";
import { api, errorText } from "./api";
import type { CreationJob } from "./new-project";
import type {
  ActivityLog,
  Apps,
  Change,
  Listing,
  Node,
  RefreshStatus,
  Snapshot,
  Tab,
  TerminalTarget,
  View,
} from "./types";
export type Theme = "system" | "light" | "dark";
export type SortKey = "name" | "last" | "size" | "ai" | "priority" | "deadline";
export type Modal =
  | { kind: "shortcuts" | "connector" }
  | { kind: "new"; job?: CreationJob }
  | { kind: "archive" | "delete" | "orphan"; id: string }
  | { kind: "terminal-close"; id: string }
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
  display: boolean;
  activity: ActivityLog | null;
  toast: Toast | null;
  load: (snapshot: Snapshot, live?: boolean) => void;
  patch: (node: Node) => void;
  cd: (path: string) => void;
  select: (id: string, tab?: Tab, row?: string) => void;
  navigate: (view: View) => void;
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
    const { snapshot, tree } = get();
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
  navigate: (view) => set({ view, display: false, pendingSelection: null }),
}));
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
export function setTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem("laci:theme", theme);
  } catch {
    /* Ignore storage failure. */
  }
  useApp.setState({ theme });
  void api("theme", { theme: theme === "system" ? "" : theme }).catch((error) =>
    toast("Couldn’t save theme", errorText(error), { error: true }),
  );
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
export function backup() {
  void run(async () => {
    const result = await api<{ copied: number; size: string; dest: string }>(
      "backup",
    );
    toast(
      result.copied
        ? `Backed up ${result.copied} logs (${result.size})`
        : "Already backed up",
      `Copies live in ${result.dest}`,
    );
  }, "Copying agent logs…");
}
