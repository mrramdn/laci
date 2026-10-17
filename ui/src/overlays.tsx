import { api } from "./api";
import { useApp, changed, run } from "./store";
import type { Change } from "./types";
/** What floats over the window in either design: the toast, with Undo for a change, and the busy overlay. */
export function Overlays() {
  const toast = useApp((s) => s.toast);
  const working = useApp((s) => s.working);
  const historyPending = useApp((s) => s.historyPending);
  const covered = useApp((s) => Boolean(s.modal || s.palette || s.working));
  return (
    <>
      {toast ? (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role="status"
          inert={covered}
        >
          <div className="txt">
            <b>{toast.title}</b>
            {toast.message ? <p>{toast.message}</p> : null}
          </div>
          {toast.undo ? (
            <button
              className="btn sm"
              disabled={historyPending}
              onClick={() =>
                void run(
                  async () =>
                    changed(
                      await api<Change>("undo", { id: toast.undo }),
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
      {working ? (
        <div className="busy" role="status">
          <div>
            <span className="spin sm" />
            {working}
          </div>
        </div>
      ) : null}
    </>
  );
}
