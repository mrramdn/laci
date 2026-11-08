// Projects: a card for each project, under the folder that holds it, with search, a filter, a folder
// and an order. "+ New project" is the filled button.
import { useId, useMemo } from "react";
import { useNow } from "../clock";
import { Icon } from "../common";
import {
  canArchiveGroup,
  deadlineInfo,
  isArchivedGroup,
  isMarkedFolder,
  linkedAlone,
  linkedGroup,
  tilde,
} from "../helpers";
import { external, goToProject, useApp } from "../store";
import type { Node, Snapshot } from "../types";
import { ago, blocks, projects as said } from "../words";
import { continueWithAi, fileManagerName } from "./act";
import {
  dueTone,
  PROJECT_FILTERS,
  PROJECT_SORTS,
  projectFolders,
  projectChats,
  projectsModel,
  sectionKey,
} from "./model";
import type { ProjectSection } from "./model";
import { setGrouped, setSort, toggleCollapsed, useSimple } from "./state";
import { Button, EmptyState, MoreMenu, SafetyBadge, StatusChip } from "./ui";

export function Projects() {
  const snapshot = useApp((s) => s.snapshot!);
  const now = new Date(useNow());
  const filter = useSimple((s) => s.filter);
  const sort = useSimple((s) => s.sort);
  const query = useSimple((s) => s.query);
  const folder = useSimple((s) => s.folder);
  const grouped = useSimple((s) => s.grouped);
  const collapsed = useSimple((s) => s.collapsed);
  const day = now.toDateString();
  const model = useMemo(
    () => projectsModel(snapshot, { filter, query, sort, folder }, new Date(day)),
    [snapshot, filter, query, sort, folder, day],
  );
  const folders = useMemo(() => projectFolders(snapshot), [snapshot]);
  const where = folder ? snapshot.nodes[folder] : undefined;
  return (
    <div className="s-page s-projects">
      <header className="s-head s-head-row">
        <div>
          <h1>{said.title}</h1>
          <p className="s-lead">{said.shown(model.shown.length)}</p>
        </div>
        <Button
          kind="filled"
          icon="plus"
          onClick={() => useApp.setState({ modal: { kind: "new" } })}
        >
          {said.newProject}
        </Button>
      </header>
      <div className="s-toolbar">
        <label className="s-search-field">
          <Icon name="search" />
          <input
            type="search"
            className="s-input"
            aria-label={said.search}
            placeholder={said.search}
            value={query}
            autoComplete="off"
            onChange={(event) => useSimple.setState({ query: event.target.value })}
          />
        </label>
        <div className="s-chips" role="group" aria-label={said.show}>
          {PROJECT_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className="s-filter"
              aria-pressed={filter === key}
              onClick={() => useSimple.setState({ filter: key })}
            >
              {said.filters[key]}
              <span className="s-count">{model.counts[key]}</span>
            </button>
          ))}
        </div>
        <div className="s-toolbar-end">
          <button
            type="button"
            role="switch"
            className="s-switch"
            aria-checked={grouped}
            onClick={() => setGrouped(!grouped)}
          >
            <span className="s-switch-track" aria-hidden="true" />
            {said.groupBy}
          </button>
          {folders.length > 1 || folder ? (
            <MoreMenu
              label={said.inLabel(where?.label ?? said.inAll)}
              kind="text"
              icon="folder"
              align="end"
              items={[
                {
                  label: said.inAll,
                  checked: !folder,
                  onSelect: () => useSimple.setState({ folder: null }),
                },
                "-",
                ...folders.map((n) => ({
                  label: n.label,
                  checked: folder === n.id,
                  onSelect: () => useSimple.setState({ folder: n.id }),
                })),
              ]}
            >
              {said.inLabel(where?.label ?? said.inAll)}
            </MoreMenu>
          ) : null}
          <MoreMenu
            label={said.sortBy(said.sorts[sort])}
            kind="text"
            icon="arrow-up-down"
            align="end"
            items={PROJECT_SORTS.map((key) => ({
              label: said.sorts[key],
              checked: sort === key,
              onSelect: () => setSort(key),
            }))}
          >
            {said.sortBy(said.sorts[sort])}
          </MoreMenu>
        </div>
      </div>
      {model.shown.length &&
      grouped &&
      (model.sections.length > 1 || model.sections.some(restorable)) ? (
        // One section alone needs no header, its cards are the whole list, unless it is an archived
        // folder: its heading has the folder's Restore.
        <div className="s-groups">
          {model.sections.map((section) => (
            <Section
              key={sectionKey(section)}
              section={section}
              open={!collapsed.includes(sectionKey(section))}
              archiving={filter !== "archived"}
              snapshot={snapshot}
              now={now}
            />
          ))}
        </div>
      ) : model.shown.length ? (
        <Cards
          label={said.title}
          projects={model.shown}
          snapshot={snapshot}
          now={now}
        />
      ) : query.trim() ? (
        <EmptyState
          art="no-projects"
          title={said.noneTitle}
          action={
            <Button kind="outline" onClick={() => useSimple.setState({ query: "" })}>
              {said.clearSearch}
            </Button>
          }
        >
          {said.noMatch(query.trim())}
        </EmptyState>
      ) : (
        <EmptyState art={filter === "needs" ? "all-safe" : "no-projects"} title={said.noneTitle}>
          {said.none[filter]}
        </EmptyState>
      )}
    </div>
  );
}

/**
 * Whether a section's folder goes back whole from its heading: an archived group, or a folder only
 * marked archived.
 */
function restorable(section: ProjectSection) {
  const group = section.group ?? undefined;
  return isArchivedGroup(group) || isMarkedFolder(group);
}

/** The cards in a grid. Under a group's heading they are one level lower than in the flat list. */
function Cards({
  label,
  projects,
  snapshot,
  now,
  heading,
}: {
  label: string;
  projects: Node[];
  snapshot: Snapshot;
  now: Date;
  heading?: "h3";
}) {
  return (
    <ul className="s-grid" aria-label={label}>
      {projects.map((n) => (
        <li key={n.id}>
          <ProjectCard n={n} snapshot={snapshot} now={now} heading={heading} />
        </li>
      ))}
    </ul>
  );
}

/** A folder's heading, which folds its cards away, and the cards. */
function Section({
  section,
  open,
  archiving,
  snapshot,
  now,
}: {
  section: ProjectSection;
  open: boolean;
  /** Whether a folder the engine can archive whole offers it: not among what is archived already. */
  archiving: boolean;
  snapshot: Snapshot;
  now: Date;
}) {
  const region = useId();
  // An archived group goes back whole, and a folder only marked archived loses the mark: its
  // heading offers Restore. A folder the engine can archive whole offers Archive group.
  const group = section.group;
  const archived = group && restorable(section) ? group : null;
  const archivable = archiving && group && canArchiveGroup(group) ? group : null;
  return (
    <section className="s-group">
      <div className="s-group-bar">
        <h2 className="s-group-head">
          <button
            type="button"
            className="s-group-toggle"
            aria-expanded={open}
            aria-controls={region}
            onClick={() => toggleCollapsed(sectionKey(section))}
          >
            <Icon name="chevron-down" />
            <span className="s-group-name">{section.label}</span>
            <span className="s-group-count">
              {said.groupCount(section.projects.length)}
            </span>
          </button>
        </h2>
        {archived ? (
          <Button
            kind="text"
            icon="undo-2"
            aria-label={
              archived.inArchive
                ? said.restoreGroupFor(archived.label)
                : said.unmarkGroupFor(archived.label)
            }
            onClick={() =>
              useApp.setState({ modal: { kind: "restore", id: archived.id } })
            }
          >
            {said.restore}
          </Button>
        ) : archivable ? (
          <Button
            kind="text"
            icon="archive"
            aria-label={said.archiveGroupFor(archivable.label)}
            onClick={() =>
              useApp.setState({ modal: { kind: "archive", id: archivable.id } })
            }
          >
            {said.archiveGroup}
          </Button>
        ) : null}
      </div>
      <div id={region} hidden={!open}>
        {open ? (
          <Cards
            label={section.label}
            projects={section.projects}
            snapshot={snapshot}
            now={now}
            heading="h3"
          />
        ) : null}
      </div>
    </section>
  );
}

function ProjectCard({
  n,
  snapshot,
  now,
  heading: Heading = "h2",
}: {
  n: Node;
  snapshot: Snapshot;
  now: Date;
  heading?: "h2" | "h3";
}) {
  const apps = useApp((s) => s.apps);
  const due = deadlineInfo(n.meta.deadline, now);
  const chats = projectChats(snapshot, n, now.getTime()).total;
  const priority = said.priority[n.meta.priority ?? ""];
  const title = useId();
  // A project that goes back only with its archived group: Restore puts the group back.
  const group = linkedGroup(snapshot.nodes, n);
  // Where an archived project came from, when Laci knows: also when something stops it going back.
  const from =
    n.inArchive && n.restorePlan?.dest ? tilde(n.restorePlan.dest, snapshot.home) : "";
  return (
    <article
      className="s-pcard"
      data-ui="project-card"
      data-id={n.id}
      aria-labelledby={title}
    >
      <div className="s-pcard-top">
        <Heading className="s-pcard-name" id={title}>
          <button type="button" className="s-pcard-open" onClick={() => goToProject(n.id)}>
            {n.label}
          </button>
        </Heading>
        <MoreMenu
          label={blocks.moreFor(n.label)}
          items={[
            {
              label: said.continueAi,
              icon: "sparkles",
              onSelect: () => continueWithAi(n, snapshot),
            },
            {
              label: said.showIn(fileManagerName(apps)),
              icon: "folder-open",
              onSelect: () => external(n.id, "files"),
            },
            "-" as const,
            n.archived
              ? {
                  label: group ? said.restoreGroup : said.restore,
                  icon: "undo-2",
                  onSelect: () =>
                    useApp.setState({
                      modal: { kind: "restore", id: group?.id ?? n.id },
                    }),
                }
              : {
                  label: said.archive,
                  icon: "archive",
                  onSelect: () =>
                    useApp.setState({ modal: { kind: "archive", id: n.id } }),
                },
            // Alone, it needs a place of its own: its sheet opens on it.
            ...(n.archived && group
              ? [
                  {
                    label: said.restoreAlone,
                    icon: "move",
                    onSelect: () =>
                      useApp.setState({ modal: { kind: "restore", id: n.id } }),
                  },
                ]
              : []),
          ]}
        />
      </div>
      <p className="s-pcard-desc">
        {n.summary?.text ?? <span className="s-quiet">{said.noDescription}</span>}
      </p>
      {group ? (
        <p className="s-pcard-from">{said.inGroup(group.label)}</p>
      ) : linkedAlone(snapshot.nodes, n) ? (
        <p className="s-pcard-from">{said.linkedAlone}</p>
      ) : from ? (
        <p className="s-pcard-from">{said.from(from)}</p>
      ) : null}
      <div className="s-pcard-chips">
        <SafetyBadge node={n} />
        {due && due.days <= 14 ? (
          <StatusChip tone={dueTone(due.days)}>{due.label}</StatusChip>
        ) : null}
        {priority ? <span className="s-tag">{priority}</span> : null}
      </div>
      <p className="s-pcard-meta">
        <span>
          {n.lastActivity ? said.lastChange(ago(n.lastActivity.at)) : said.noChange}
        </span>
        {chats ? <span>{said.chats(chats)}</span> : null}
      </p>
    </article>
  );
}
