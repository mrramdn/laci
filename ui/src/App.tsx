import { lazy, Suspense, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import {
  useApp,
  changed,
  readListing,
  refreshLog,
  refreshStatus,
  refreshError,
  run,
  savePref,
} from "./store";
import { parentOf } from "./helpers";
import { selectIsOpen } from "./select";
import { AgentsView, Folder, LogView, Sidebar, Tidy, Today } from "./views";
import { Settings } from "./settings";
import { Inspector } from "./inspector";
import { Dialogs } from "./dialogs";
import { Palette } from "./palette";
import { restoreTerminals, toggleTerminal, useTerms } from "./terminal-api";
import type { Apps, Change, RefreshStatus, Snapshot } from "./types";
import type { CreationJob } from "./new-project";
const TerminalPanel = lazy(() => import("./TerminalPanel"));
const PANES: [string, string][] = [
  ["sidebar", "#side"],
  ["main", "#main"],
  ["details", "#insp"],
  ["terminal", ".term"],
];
const shown = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  element.getClientRects().length > 0 &&
  !element.closest("[hidden]");
function paneTarget(name: string, pane: HTMLElement): HTMLElement | null {
  const find = (...selectors: string[]) => {
    for (const selector of selectors)
      for (const element of pane.querySelectorAll<HTMLElement>(selector))
        if (shown(element)) return element;
    return null;
  };
  if (name === "sidebar")
    return find(
      '.sb-item[aria-current="page"]',
      '.tree-row[tabindex="0"]',
      ".sb-item",
    );
  if (name === "main")
    return find(
      '.item[aria-selected="true"][tabindex]',
      ".item[tabindex]",
      'button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
    );
  if (name === "details")
    return find(
      '[role="tab"][aria-selected="true"]',
      'button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
    );
  return find(
    ".term-host:not([hidden]) .xterm-helper-textarea",
    '.ttab-select[aria-selected="true"]',
    "button",
  );
}
function nextPane(step: 1 | -1) {
  const open = PANES.map(([name, selector]) => {
    const pane = document.querySelector<HTMLElement>(selector);
    return pane && shown(pane) ? { name, pane } : null;
  }).filter((entry) => entry !== null);
  if (!open.length) return;
  const here = open.findIndex(({ pane }) =>
    pane.contains(document.activeElement),
  );
  const at = here < 0 ? (step > 0 ? 0 : open.length - 1) : here + step;
  const { name, pane } = open[(at + open.length) % open.length];
  (paneTarget(name, pane) ?? pane).focus();
}
type LaciEvent =
  | { type: "snapshot" }
  | ({ type: "status" } & RefreshStatus)
  | { type: "refresh-error"; error: string; revision?: number }
  | { type: "ls"; path: string }
  | { type: "log" };
export default function App() {
  const s = useApp();
  const hasTerminals = useTerms((s) => s.tabs.length > 0);
  useEffect(() => {
    void restoreTerminals();
    let live = true;
    let unlisten: (() => void) | undefined;
    let fetching = false;
    let pending = false;
    let receivedStatus = false;
    let receivedSnapshot = false;
    async function update() {
      if (fetching) {
        pending = true;
        return;
      }
      fetching = true;
      let requestedRevision = useApp.getState().revision;
      try {
        do {
          pending = false;
          requestedRevision = useApp.getState().revision;
          const snapshot = await api<Snapshot>("snapshot");
          if (live) useApp.getState().load(snapshot, true);
        } while (pending && live);
      } catch (error) {
        if (live) refreshError(error, requestedRevision);
      } finally {
        fetching = false;
      }
    }
    async function start() {
      try {
        const stop = await listen<LaciEvent>("laci", (event) => {
          if (!live) return;
          const payload = event.payload;
          if (payload.type === "snapshot") {
            receivedSnapshot = true;
            void update();
          } else if (payload.type === "status") {
            receivedStatus = true;
            refreshStatus(payload);
          } else if (payload.type === "refresh-error")
            refreshError(payload.error, payload.revision);
          else if (
            payload.type === "ls" &&
            useApp.getState().listings[payload.path]
          )
            void readListing(payload.path, true, true);
          else if (payload.type === "log") void refreshLog();
        });
        if (!live) {
          stop();
          return;
        }
        unlisten = stop;
        const [snapshot, status, apps, creation] = await Promise.all([
          api<Snapshot>("snapshot"),
          api<RefreshStatus>("status"),
          api<Apps>("apps"),
          api<CreationJob | null>("new/current"),
        ]);
        if (!live) return;
        if (!receivedSnapshot || !useApp.getState().snapshot)
          useApp.getState().load(snapshot);
        if (!receivedStatus) refreshStatus(status);
        useApp.setState({
          apps,
          ...(creation
            ? { modal: { kind: "new", job: creation } as const, palette: false }
            : {}),
        });
      } catch (error) {
        if (live) refreshError(error);
      }
    }
    void start();
    const interval = setInterval(() => {
      if (live)
        useApp.setState((st) => ({
          snapshot: st.snapshot ? { ...st.snapshot } : null,
        }));
    }, 30000);
    return () => {
      live = false;
      unlisten?.();
      clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    const hotkey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "F6" && !event.ctrlKey && !event.altKey) {
        const state = useApp.getState();
        const target = event.target as HTMLElement;
        if (
          state.modal ||
          state.palette ||
          state.working ||
          selectIsOpen() ||
          target.closest?.(".xterm")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        nextPane(event.shiftKey ? -1 : 1);
        return;
      }
      const terminal =
        event.key === "F4" || (event.ctrlKey && event.key === "`");
      const palette =
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (!terminal && !palette) return;
      event.preventDefault();
      event.stopPropagation();
      const state = useApp.getState();
      if (state.modal || state.working || selectIsOpen()) return;
      if (palette) useApp.setState({ palette: !state.palette });
      else if (!state.palette) toggleTerminal();
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || selectIsOpen()) return;
      const target = event.target as HTMLElement;
      if (!(target instanceof HTMLElement)) return;
      const input =
        target.matches('input,textarea,select,[role="combobox"]') ||
        target.isContentEditable;
      const state = useApp.getState();
      if (state.working) return;
      if (event.key === "Escape") {
        if (state.palette) useApp.setState({ palette: false });
        else if (state.modal) return;
        else if (state.display) useApp.setState({ display: false });
        else if (target.closest(".xterm")) return;
        else useApp.setState({ selected: null, pendingSelection: null });
        event.preventDefault();
        return;
      }
      if (target.closest(".xterm") || state.palette || state.modal) return;
      if (
        (event.key === "?" || (event.ctrlKey && event.key === "/")) &&
        !input
      ) {
        event.preventDefault();
        useApp.setState({ modal: { kind: "shortcuts" } });
        return;
      }
      if (
        event.ctrlKey &&
        event.key.toLowerCase() === "h" &&
        state.view === "folder"
      ) {
        event.preventDefault();
        savePref("hidden", !state.hidden);
        useApp.setState({ hidden: !state.hidden });
        return;
      }
      if (input) return;
      const row = target.closest<HTMLElement>(".main .item[tabindex]");
      if (
        row === target &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        event.preventDefault();
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>(".main .item[tabindex]"),
        );
        rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      }
      if (row === target && event.key === "Enter") {
        event.preventDefault();
        if (row.dataset.kind === "file" && row.dataset.id)
          void run(() => api("open", { id: row.dataset.id, what: "default" }));
        else if (row.dataset.kind === "dir" && row.dataset.id)
          state.cd(row.dataset.id);
        else row.click();
      }
      if (
        event.key === "Backspace" &&
        state.view === "folder" &&
        state.snapshot &&
        state.cwd !== "/"
      ) {
        event.preventDefault();
        state.cd(parentOf(state.cwd));
      }
    };
    window.addEventListener("keydown", hotkey, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", hotkey, true);
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    for (const [name, selector] of PANES)
      document
        .querySelector<HTMLElement>(selector)
        ?.setAttribute("data-pane", name);
  });
  useEffect(() => {
    document.querySelector(".main .body")?.scrollTo(0, 0);
  }, [s.view, s.cwd, s.filter, s.tidyFilter, s.logFilter]);
  useEffect(() => {
    document.querySelector(".ibody")?.scrollTo(0, 0);
  }, [s.selected]);
  if (!s.snapshot)
    return (
      <div className="boot">
        <div>
          <b>{s.error ? "Scan failed" : "Looking for your projects…"}</b>
          {s.error ? (
            <>
              <p>{s.error}</p>
              <button className="btn" onClick={() => window.location.reload()}>
                Try again
              </button>
            </>
          ) : null}
        </div>
      </div>
    );
  const n = s.selected ? s.snapshot.nodes[s.selected] : null;
  return (
    <>
      {(!s.snapshot.configured || s.setupPending) && !s.skipSetup ? (
        <Settings first />
      ) : (
        <div
          className="app"
          id="app"
          inert={Boolean(s.modal || s.palette || s.working)}
        >
          <Sidebar />
          <main id="main" className="main" tabIndex={-1}>
            {s.view === "folder" ? (
              <Folder />
            ) : s.view === "tidy" ? (
              <Tidy />
            ) : s.view === "agents" ? (
              <AgentsView />
            ) : s.view === "log" ? (
              <LogView />
            ) : s.view === "settings" ? (
              <Settings key={s.view} />
            ) : (
              <Today />
            )}
          </main>
          {n && !["settings", "log"].includes(s.view) ? (
            <Inspector node={n} />
          ) : null}
          {hasTerminals ? (
            <Suspense fallback={null}>
              <TerminalPanel />
            </Suspense>
          ) : null}
        </div>
      )}
      <Dialogs />
      {s.palette ? <Palette /> : null}
      {s.toast ? (
        <div
          className={`toast ${s.toast.error ? "error" : ""}`}
          role="status"
          inert={Boolean(s.modal || s.palette || s.working)}
        >
          <div className="txt">
            <b>{s.toast.title}</b>
            {s.toast.message ? <p>{s.toast.message}</p> : null}
          </div>
          {s.toast.undo ? (
            <button
              className="btn sm"
              disabled={s.historyPending}
              onClick={() =>
                void run(
                  async () =>
                    changed(
                      await api<Change>("undo", { id: s.toast!.undo }),
                      "Journaled changes undone",
                    ),
                  "Undoing…",
                  { history: true },
                )
              }
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
      {s.working ? (
        <div className="busy" role="status">
          <div>
            <span className="spin sm" />
            {s.working}
          </div>
        </div>
      ) : null}
    </>
  );
}
