import { create } from "zustand";
import { api, errorText } from "./api";
import type {
  ActivityLog,
  Apps,
  Change,
  Listing,
  Node,
  Snapshot,
  Tab,
  View,
} from "./types";
export type Theme = "system" | "light" | "dark";
export type SortKey = "name" | "last" | "size" | "ai";
export type Modal =
  | { kind: "shortcuts" | "connector" | "new" }
  | { kind: "archive"; id: string }
  | { kind: "terminal-close"; id: string }
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
  busy: boolean;
  working: string;
  view: View;
  cwd: string;
  selected: string | null;
  tab: Tab;
  fileSelected: string | null;
  theme: Theme;
  apps: Apps;
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
  select: (id: string, tab?: Tab) => void;
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
  busy: false,
  working: "",
  view: "today",
  cwd: "",
  selected: null,
  tab: "health",
  fileSelected: null,
  theme: (document.documentElement.dataset.theme as Theme) || "system",
  apps: { editor: "code", files: "dolphin", terminal: "kitty" },
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
    set((s) => ({
      snapshot,
      error: null,
      cwd: s.cwd || snapshot.roots[0] || snapshot.home,
      selected: s.selected && snapshot.nodes[s.selected] ? s.selected : null,
      tree: s.tree.size ? s.tree : new Set(snapshot.roots.slice(0, 1)),
      listings: live ? s.listings : {},
    })),
  patch: (node) =>
    set((s) =>
      s.snapshot
        ? {
            snapshot: {
              ...s.snapshot,
              nodes: { ...s.snapshot.nodes, [node.id]: node },
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
      view: "folder",
      cwd: path,
      fileSelected: null,
      tree: next,
      selected:
        snapshot?.nodes[path]?.kind === "project" ? path : get().selected,
    });
  },
  select: (id, tab) =>
    set({ selected: id, fileSelected: null, ...(tab ? { tab } : {}) }),
  navigate: (view) => set({ view, display: false }),
}));
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(
  title: string,
  message = "",
  options: { undo?: string; error?: boolean } = {},
) {
  clearTimeout(toastTimer);
  useApp.setState({ toast: { title, message, ...options } });
  toastTimer = setTimeout(
    () => useApp.setState({ toast: null }),
    options.undo ? 14000 : 7000,
  );
}
export async function run<T>(
  task: () => Promise<T>,
  working = "",
): Promise<T | undefined> {
  if (working) useApp.setState({ working });
  try {
    return await task();
  } catch (error) {
    toast("Couldn’t finish", errorText(error), { error: true });
    return undefined;
  } finally {
    if (working && useApp.getState().working === working)
      useApp.setState({ working: "" });
  }
}
export async function refreshLog() {
  try {
    useApp.setState({ activity: await api<ActivityLog>("log") });
  } catch (error) {
    useApp.setState({ activity: { entries: [], error: errorText(error) } });
  }
}
export function changed(change: Change, title: string) {
  if (change.snapshot) useApp.getState().load(change.snapshot);
  if (change.node) useApp.getState().patch(change.node);
  void refreshLog();
  toast(title, "", { undo: change.journal?.id });
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
  void run(async () => {
    const snapshot = await api<Snapshot>("rescan");
    useApp.getState().load(snapshot);
    toast(
      "Scan finished",
      `${Object.values(snapshot.nodes).filter((n) => n.kind === "project").length} projects`,
    );
  }, "Scanning your projects…");
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
