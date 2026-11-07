import { useEffect, useState } from "react";
import { Icon, Group } from "../common";
import { useApp, external } from "../store";
import { api } from "../api";
import { bytes, LOCALE, plural, tilde } from "../helpers";
import type { Node, SetupInfo } from "../types";
/** The day a project was archived, from its `.laci.md`, as the other lists write a date. */
function archivedOn(day?: string) {
  const [y, m, d] = (day ?? "").split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
/** Newest archive first; projects without a day after them, then by name. */
function newestFirst(a: Node, b: Node) {
  const [x, y] = [a.meta.archivedAt ?? "", b.meta.archivedAt ?? ""];
  return x !== y ? (x < y ? 1 : -1) : a.label.localeCompare(b.label);
}
/**
 * Detailed's Archive: the archive folder, the projects in it with where they came from, and the
 * projects only marked archived, which are still in their own place.
 */
export function ArchiveView() {
  const snapshot = useApp((s) => s.snapshot!);
  const selected = useApp((s) => s.selected);
  const historyPending = useApp((s) => s.historyPending);
  const [archiveDir, setArchiveDir] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api<SetupInfo>("setup/info").then(
      (info) => live && setArchiveDir(info.archiveDir ?? ""),
      () => live && setArchiveDir(""),
    );
    return () => {
      live = false;
    };
  }, []);
  const home = snapshot.home;
  const projects = Object.values(snapshot.nodes).filter(
    (n) => n.kind === "project" && n.archived,
  );
  const stored = projects.filter((n) => n.inArchive).sort(newestFirst);
  const marked = projects
    .filter((n) => !n.inArchive)
    .sort((a, b) => a.label.localeCompare(b.label));
  const select = (id: string) => useApp.getState().select(id);
  const open = (id: string) =>
    useApp.setState({ modal: { kind: "restore", id } });
  return (
    <>
      <div className="head">
        <h1>Archive</h1>
        <span className="count">{plural(projects.length, "project")}</span>
      </div>
      <div className="body">
        <div className="item">
          <Icon name="archive" className="sm" />
          {archiveDir ? (
            <>
              <span className="name">Archive folder</span>
              <span className="d mono">{tilde(archiveDir, home)}</span>
              <span className="meta">
                <button
                  className="btn sm"
                  onClick={() => external(archiveDir, "files")}
                >
                  <Icon name="open" className="sm" />
                  Open folder
                </button>
              </span>
            </>
          ) : archiveDir === "" ? (
            <span className="d">
              Laci archives a project into an _archive folder next to it.
              Settings can choose one archive folder for all of them.
            </span>
          ) : (
            <span className="d">Reading the archive folder…</span>
          )}
        </div>
        {stored.length ? (
          <Group
            title="In the archive"
            icon="archive"
            count={stored.length}
            hint="Put back where it came from, with its AI history"
            order="Newest first"
          >
            {stored.map((n) => {
              const from =
                n.restorePlan && !n.restorePlan.error
                  ? `From ${tilde(n.restorePlan.dest, home)}`
                  : "Origin unknown";
              const day = archivedOn(n.meta.archivedAt);
              return (
                <div
                  className="item"
                  key={n.id}
                  tabIndex={0}
                  data-id={n.id}
                  aria-selected={selected === n.id}
                  onClick={() => select(n.id)}
                >
                  <span className="name">{n.label}</span>
                  <span className="d mono" title={from}>
                    {from}
                  </span>
                  <span className="meta">
                    {day ? <span>{day}</span> : null}
                    <span className="mono">{bytes(n.size?.total)}</span>
                    <button
                      className="btn sm"
                      disabled={historyPending}
                      onClick={(event) => {
                        event.stopPropagation();
                        open(n.id);
                      }}
                    >
                      <Icon name="undo-2" className="sm" />
                      Restore
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        external(n.id, "files");
                      }}
                    >
                      <Icon name="open" className="sm" />
                      Open folder
                    </button>
                  </span>
                </div>
              );
            })}
          </Group>
        ) : null}
        {marked.length ? (
          <Group
            title="Marked archived, still in place"
            icon="keep"
            count={marked.length}
            hint="Their status says archived, but the folder hasn’t moved"
            order="By name"
          >
            {marked.map((n) => (
              <div
                className="item"
                key={n.id}
                tabIndex={0}
                data-id={n.id}
                aria-selected={selected === n.id}
                onClick={() => select(n.id)}
              >
                <span className="name">{n.label}</span>
                <span className="d mono">{tilde(n.path, home)}</span>
                <span className="meta">
                  <button
                    className="btn sm"
                    disabled={historyPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      useApp.setState({ modal: { kind: "archive", id: n.id } });
                    }}
                  >
                    <Icon name="archive" className="sm" />
                    Move to archive
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={historyPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      open(n.id);
                    }}
                  >
                    <Icon name="undo-2" className="sm" />
                    Unarchive
                  </button>
                </span>
              </div>
            ))}
          </Group>
        ) : null}
        {!projects.length ? (
          <div className="empty">
            {historyPending
              ? "Updating…"
              : "No archived projects. Archive one from its details, or from Tidy up."}
          </div>
        ) : null}
      </div>
    </>
  );
}
