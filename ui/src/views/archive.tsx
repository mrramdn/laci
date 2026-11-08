import { useEffect, useState } from "react";
import { Icon, Group } from "../common";
import { useApp, external } from "../store";
import { api } from "../api";
import {
  archivedGroupOf,
  bytes,
  groupProjectCount,
  groupSize,
  isArchivedGroup,
  isMarkedFolder,
  linkedGroup,
  LOCALE,
  plural,
  tilde,
} from "../helpers";
import type { Node, SetupInfo } from "../types";
import { detailedArchive as said } from "../words";
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
/**
 * Where a project in the archive came from, and why it can't go back there by itself: "From
 * <place>", "From <place> · something is there now", or "Origin unknown".
 */
export function restoreFrom(n: Node, home: string) {
  const plan = n.restorePlan;
  if (!plan?.dest || plan.reason === "unknown") return said.unknown;
  const from = said.from(tilde(plan.dest, home));
  if (!plan.error) return from;
  return `${from} · ${plan.reason ? said.why[plan.reason] : said.cant}`;
}
/** Newest archive first; projects without a day after them, then by name. */
function newestFirst(a: Node, b: Node) {
  const [x, y] = [a.meta.archivedAt ?? "", b.meta.archivedAt ?? ""];
  return x !== y ? (x < y ? 1 : -1) : a.label.localeCompare(b.label);
}
/** A row of "In the archive", and how far it is inside an archived group listed above it. */
interface Row {
  n: Node;
  depth: number;
}
/**
 * The archived groups and the projects in the archive, as rows: newest first, and after each group
 * what it holds, by its place in the group. What an archived group holds, an archived group inside it
 * and what that one holds too, is listed under the outermost one: that is the group the engine puts
 * back with it.
 */
export function archiveRows(nodes: Record<string, Node>): Row[] {
  const listed = Object.values(nodes).filter(
    (n) =>
      isArchivedGroup(n) || (n.kind === "project" && n.archived && n.inArchive),
  );
  const inGroup = new Map<string, Node[]>();
  const top: Node[] = [];
  for (const n of listed) {
    const group = archivedGroupOf(nodes, n);
    if (group) inGroup.set(group.id, [...(inGroup.get(group.id) ?? []), n]);
    else top.push(n);
  }
  const rows: Row[] = [];
  const add = (n: Node, depth: number) => {
    rows.push({ n, depth });
    // By path, so that a group inside comes just before what it holds.
    for (const inside of (inGroup.get(n.id) ?? []).sort((a, b) =>
      a.path.localeCompare(b.path),
    ))
      add(inside, depth + 1);
  };
  for (const n of top.sort(newestFirst)) add(n, 0);
  return rows;
}
/**
 * Detailed's Archive: the archive folder, the archived groups and the projects in it with where they
 * came from, and the projects only marked archived, which are still in their own place.
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
  const nodes = snapshot.nodes;
  const projects = Object.values(nodes).filter(
    (n) => n.kind === "project" && n.archived,
  );
  const stored = archiveRows(nodes);
  // Projects, and folders, whose .laci.md says archived but which never moved.
  const marked = Object.values(nodes)
    .filter(
      (n) =>
        (n.kind === "project" && n.archived && !n.inArchive) ||
        isMarkedFolder(n),
    )
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
              Laci archives a project into the _archive folder of its scan
              location. Settings can choose one archive folder for all of them.
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
            hint="Put back where it came from, with its agent history"
            order="Newest first"
          >
            {stored.map(({ n, depth }) => {
              const group = isArchivedGroup(n);
              // A project, or a group, that goes back only with its archived group (the engine's
              // reason "linked", or "inGroup" for one inside it) offers that group in place of its own
              // Restore, when the scan lists the group. Without one, the row says where it came from
              // and why it can't go back, as for any reason. Alone, it goes back to a place chosen in
              // the Restore dialog, from the details panel.
              const whole = linkedGroup(nodes, n);
              const inside = whole ? said.inside(whole.label) : "";
              const from = restoreFrom(n, home);
              const day = archivedOn(n.meta.archivedAt);
              return (
                <div
                  className={depth ? "item in-group" : "item"}
                  key={n.id}
                  tabIndex={0}
                  data-id={n.id}
                  data-kind={group ? "group" : "project"}
                  aria-selected={selected === n.id}
                  onClick={() => select(n.id)}
                >
                  {group ? <Icon name="folder" className="sm" /> : null}
                  <span className="name">{n.label}</span>
                  {inside ? (
                    <span className={group ? "d whole" : "d"} title={inside}>
                      {inside}
                    </span>
                  ) : (
                    <span className={group ? "d mono whole" : "d mono"} title={from}>
                      {from}
                    </span>
                  )}
                  {/* After where it came from, and cut off before it when the row is short. */}
                  {group ? (
                    <span className="note">
                      {said.group(groupProjectCount(nodes, n))}
                    </span>
                  ) : null}
                  <span className="meta">
                    {day ? <span>{day}</span> : null}
                    {group ? null : (
                      <span className="mono">{bytes(n.size?.total)}</span>
                    )}
                    {whole ? (
                      <button
                        className="btn sm"
                        title={said.restoreGroupFor(whole.label)}
                        disabled={historyPending}
                        onClick={(event) => {
                          event.stopPropagation();
                          select(whole.id);
                          open(whole.id);
                        }}
                      >
                        <Icon name="undo-2" className="sm" />
                        {said.restoreGroup}
                      </button>
                    ) : (
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
                    )}
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
            {marked.map((n) => {
              // A folder only marked archived: Unarchive clears its mark; it has no archive plan.
              const folder = n.kind === "folder";
              return (
                <div
                  className="item"
                  key={n.id}
                  tabIndex={0}
                  data-id={n.id}
                  data-kind={folder ? "group" : "project"}
                  aria-selected={selected === n.id}
                  onClick={() => select(n.id)}
                >
                  {folder ? <Icon name="folder" className="sm" /> : null}
                  <span className="name">{n.label}</span>
                  {/* A folder's "Group of N projects" follows its place, as an archived group's does. */}
                  <span className={folder ? "d mono whole" : "d mono"}>{tilde(n.path, home)}</span>
                  {folder ? (
                    <span className="note">{said.group(groupSize(nodes, n))}</span>
                  ) : null}
                  <span className="meta">
                    {folder ? null : (
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
                    )}
                    <button
                      className="btn sm ghost"
                      title={folder ? said.unarchiveFolder : undefined}
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
              );
            })}
          </Group>
        ) : null}
        {!projects.length && !stored.length && !marked.length ? (
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
