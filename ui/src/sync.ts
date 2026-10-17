import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import {
  useApp,
  applyPrefs,
  autoBackup,
  readListing,
  refreshLog,
  refreshStatus,
  refreshError,
} from "./store";
import { restoreTerminals } from "./terminal-api";
import type { Apps, Prefs, RefreshStatus, Snapshot } from "./types";
import type { CreationJob } from "./new-project";
type LaciEvent =
  | { type: "snapshot" }
  | ({ type: "status" } & RefreshStatus)
  | { type: "refresh-error"; error: string; revision?: number }
  | { type: "ls"; path: string }
  | { type: "log" };
/**
 * Keeps the store in step with the desktop, in either design. It loads the scan, its status, the
 * apps, a project still being created and the saved choices once, then follows the desktop's
 * events. One snapshot is fetched at a time; news that arrives meanwhile asks for one more.
 */
export function useLaciSync() {
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
    // Asked for while the boot screen still covers the window, so the reply can't undo a switch made
    // after it. Without a reply the window keeps the design and theme it started with.
    void api<Prefs>("prefs").then(
      (prefs) => {
        if (live) applyPrefs(prefs);
      },
      () => {
        if (live) useApp.setState({ prefsReady: true });
      },
    );
    void start();
    // A refused automatic backup (the desktop runs at most one an hour) is asked for again even when no
    // scan arrives in between; autoBackup itself asks at most every ten minutes.
    const backups = setInterval(() => {
      if (live) autoBackup(useApp.getState().snapshot);
    }, 60_000);
    return () => {
      live = false;
      unlisten?.();
      clearInterval(backups);
    };
  }, []);
}
