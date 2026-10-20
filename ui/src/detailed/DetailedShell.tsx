import { lazy, Suspense, useEffect } from "react";
import { useApp, FULL_WIDTH } from "../store";
import { namePanes, useDetailedHotkeys } from "../hotkeys";
import { useTerms } from "../terminal-api";
import { Sidebar } from "../views/sidebar";
import { Today } from "../views/today";
import { Folder } from "../views/folder";
import { Tidy } from "../views/tidy";
import { AgentsView } from "../views/agents";
import { LogView } from "../views/log";
import { ReportsView } from "../views/reports";
import { Settings } from "../settings";
import { Inspector } from "../inspector";
const TerminalPanel = lazy(() => import("../TerminalPanel"));
/** The terminal, whose pane gets its name as soon as its code is in. */
function Terminal() {
  useEffect(namePanes);
  return <TerminalPanel />;
}
/** Detailed's window: the sidebar, the view, the selected project's details and the terminal. */
export default function DetailedShell() {
  useDetailedHotkeys();
  const view = useApp((s) => s.view);
  const cwd = useApp((s) => s.cwd);
  const filter = useApp((s) => s.filter);
  const tidyFilter = useApp((s) => s.tidyFilter);
  const logFilter = useApp((s) => s.logFilter);
  const selected = useApp((s) => s.selected);
  const n = useApp((s) =>
    s.selected ? s.snapshot?.nodes[s.selected] : undefined,
  );
  // A dialog drawn over the window as Simple's sheets are, such as the look for secret files before a
  // fix, counts as well.
  const covered = useApp((s) =>
    Boolean(s.modal || s.palette || s.working || s.sheets),
  );
  const hasTerminals = useTerms((s) => s.tabs.length > 0);
  useEffect(namePanes);
  useEffect(() => {
    document.querySelector(".main .body")?.scrollTo(0, 0);
  }, [view, cwd, filter, tidyFilter, logFilter]);
  useEffect(() => {
    document.querySelector(".ibody")?.scrollTo(0, 0);
  }, [selected]);
  return (
    <div className="app" id="app" inert={covered}>
      <Sidebar />
      <main id="main" className="main" tabIndex={-1}>
        {view === "folder" ? (
          <Folder />
        ) : view === "tidy" ? (
          <Tidy />
        ) : view === "agents" ? (
          <AgentsView />
        ) : view === "reports" ? (
          <ReportsView />
        ) : view === "log" ? (
          <LogView />
        ) : view === "settings" ? (
          <Settings key={view} />
        ) : (
          <Today />
        )}
      </main>
      {n && !FULL_WIDTH.includes(view) ? <Inspector node={n} /> : null}
      {hasTerminals ? (
        <Suspense fallback={null}>
          <Terminal />
        </Suspense>
      ) : null}
    </div>
  );
}
