import { lazy, Suspense, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText } from "./api";
import {
  useApp,
  changed,
  readListing,
  refreshLog,
  run,
  savePref,
} from "./store";
import { parentOf, within } from "./helpers";
import { AgentsView, Folder, LogView, Sidebar, Tidy, Today } from "./views";
import { Settings } from "./settings";
import { Inspector } from "./inspector";
import { Dialogs } from "./dialogs";
import { Palette } from "./palette";
import { restoreTerminals, toggleTerminal, useTerms } from "./terminal-api";
import type { Apps, Change, Snapshot } from "./types";
const TerminalPanel = lazy(() => import("./TerminalPanel"));
type LaciEvent =
  | { type: "snapshot" }
  | { type: "status"; busy: boolean }
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
      try {
        do {
          pending = false;
          const snapshot = await api<Snapshot>("snapshot");
          if (live) useApp.getState().load(snapshot, true);
        } while (pending && live);
      } catch (error) {
        if (live) useApp.setState({ error: errorText(error) });
      } finally {
        fetching = false;
      }
    }
    void listen<LaciEvent>("laci", (event) => {
      if (!live) return;
      const payload = event.payload;
      if (payload.type === "snapshot") {
        receivedSnapshot = true;
        void update();
      } else if (payload.type === "status") {
        receivedStatus = true;
        useApp.setState({ busy: payload.busy });
      } else if (
        payload.type === "ls" &&
        useApp.getState().listings[payload.path]
      )
        void readListing(payload.path, true, true);
      else if (payload.type === "log") void refreshLog();
    }).then((stop) => {
      if (live) unlisten = stop;
      else stop();
    });
    void Promise.all([
      api<Snapshot>("snapshot"),
      api<{ busy: boolean }>("status"),
      api<Apps>("apps"),
    ]).then(
      ([snapshot, status, apps]) => {
        if (live) {
          if (!receivedSnapshot || !useApp.getState().snapshot)
            useApp.getState().load(snapshot);
          useApp.setState((state) => ({
            busy: receivedStatus ? state.busy : status.busy,
            apps,
          }));
        }
      },
      (error) => live && useApp.setState({ error: errorText(error) }),
    );
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
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const input = target.matches("input,textarea,select");
      const state = useApp.getState();
      if (event.key === "F4" || (event.ctrlKey && event.key === "`")) {
        event.preventDefault();
        toggleTerminal();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        useApp.setState({ palette: !state.palette });
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (state.palette || state.modal || state.display)
          useApp.setState({ palette: false, modal: null, display: false });
        else useApp.setState({ selected: null });
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
      if (row && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>(".main .item[tabindex]"),
        );
        rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      }
      if (row && event.key === "Enter") {
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
        state.cwd !== state.snapshot.home &&
        within(state.cwd, state.snapshot.home)
      ) {
        event.preventDefault();
        state.cd(parentOf(state.cwd));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
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
      {!s.snapshot.configured && !s.skipSetup ? (
        <Settings first />
      ) : (
        <div className="app" id="app">
          <Sidebar />
          <main id="main" className="main">
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
        <div className={`toast ${s.toast.error ? "error" : ""}`} role="status">
          <div className="txt">
            <b>{s.toast.title}</b>
            {s.toast.message ? <p>{s.toast.message}</p> : null}
          </div>
          {s.toast.undo ? (
            <button
              className="btn sm"
              onClick={() =>
                void run(
                  async () =>
                    changed(
                      await api<Change>("undo", { id: s.toast!.undo }),
                      "Undone. Everything is back where it was.",
                    ),
                  "Undoing…",
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
