import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp, goToProject, rescan, setTheme } from "./store";
import { useNow } from "./clock";
import {
  ago,
  allSessions,
  base,
  days,
  providerName,
  reportList,
  sessionKey,
  sessionsOf,
  shortDay,
  tilde,
} from "./helpers";
import {
  Highlight,
  Icon,
  KindIcon,
  PriorityGlyph,
  restoreFocus,
} from "./common";
import { DeadlinePill } from "./deadline";
import type { Node, View } from "./types";
export function Palette() {
  const s = useApp();
  useNow();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previous = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (hay: string) =>
    terms.every((t) => hay.toLowerCase().includes(t));
  const snapshot = s.snapshot!;
  const hits = Object.values(snapshot.nodes)
    .filter((n) =>
      matches(
        `${n.label} ${n.path} ${n.summary?.text ?? ""} ${n.stack?.labels.join(" ") ?? ""}`,
      ),
    )
    .sort((a, b) => days(a.lastActivity?.at) - days(b.lastActivity?.at))
    .slice(0, 9)
    .map((n) => ({
      id: "node:" + n.id,
      section: n.kind === "folder" ? "Folders" : "Projects",
      label: n.label,
      sub: tilde(n.path, snapshot.home),
      icon: "",
      project: "",
      node: n as Node | null,
      acc: ago(n.lastActivity?.at),
    }));
  const found = (
    id: string,
    section: string,
    label: string,
    sub: string,
    icon: string,
    acc: string,
    project = "",
  ) => ({
    id,
    section,
    label,
    sub,
    icon,
    acc,
    project,
    node: null as Node | null,
  });
  // Sessions and to-dos only turn up for a typed query.
  const sessionHits = terms.length
    ? (() => {
        const owner = new Map<string, Node>();
        for (const n of Object.values(snapshot.nodes))
          for (const session of sessionsOf(n, snapshot))
            owner.set(sessionKey(session), n);
        return allSessions(snapshot)
          .filter(
            (session) =>
              session.sourceKind !== "subagent" &&
              matches(`${session.title} ${session.firstPrompt ?? ""}`),
          )
          .slice(0, 5)
          .map((session) => {
            const n = owner.get(sessionKey(session));
            return found(
              "session:" + sessionKey(session),
              "Sessions",
              session.title,
              `${providerName(snapshot, session.provider)} · ${
                n ? n.label : tilde(session.cwd ?? "", snapshot.home)
              }`,
              "history",
              ago(session.updatedAt),
            );
          });
      })()
    : [];
  const todoHits = terms.length
    ? Object.values(snapshot.nodes)
        .filter((n) => n.kind === "project" && !n.archived)
        .flatMap((n) =>
          n.tasks
            .filter((t) => t.kind === "check" && !t.done)
            .map((t) => ({ n, t })),
        )
        .filter(({ n, t }) => matches(`${t.text} ${n.label}`))
        .slice(0, 5)
        .map(({ n, t }) =>
          found(
            `todo:${n.id}:${t.file}:${t.line}`,
            "To-dos",
            t.text,
            n.label,
            "check",
            "",
            n.id,
          ),
        )
    : [];
  const projectNames = (paths: string[]) =>
    paths.map((p) => snapshot.nodes[p]?.label ?? base(p)).join(", ");
  const reportHits = terms.length
    ? reportList(snapshot)
        .filter((r) =>
          matches(
            `${r.title} ${r.summary ?? ""} ${r.scope ?? ""} ${projectNames(r.projects)}`,
          ),
        )
        .slice(0, 5)
        .map((r) =>
          found(
            "report:" + r.id,
            "Reports",
            r.title,
            [shortDay(r.date), projectNames(r.projects)]
              .filter(Boolean)
              .join(" · "),
            "report",
            ago(r.modified),
          ),
        )
    : [];
  const actions = [
    ["view:today", "Open Today", "inbox"],
    ["view:tidy", "Open Tidy up", "sparkles"],
    ["view:agents", "Open Agents", "history"],
    ...(snapshot.reportsDir ? [["view:reports", "Open Reports", "report"]] : []),
    ["view:log", "Open Log", "scroll"],
    ["new", "New project", "plus"],
    ["shortcuts", "Keyboard shortcuts", "keyboard"],
    ["view:settings", "Open Settings", "gear"],
    ["rescan", "Scan again", "refresh"],
    ["theme", "Switch theme", "moon"],
  ]
    .filter(([, label]) => matches(label))
    .map(([id, label, icon]) => ({
      id,
      label,
      icon,
      sub: "",
      section: "Actions",
      project: "",
      node: null as Node | null,
      acc: "",
    }));
  const items = [
    ...hits.filter((i) => i.section === "Projects"),
    ...hits.filter((i) => i.section === "Folders"),
    ...sessionHits,
    ...reportHits,
    ...todoHits,
    ...actions,
  ];
  const index = Math.min(selected, Math.max(0, items.length - 1));
  function go(id: string) {
    useApp.setState({ palette: false });
    if (id.startsWith("node:")) {
      const n = snapshot.nodes[id.slice(5)];
      if (n.kind === "folder") s.cd(n.path);
      else goToProject(n.id);
    } else if (id.startsWith("session:")) {
      const session = allSessions(snapshot).find(
        (x) => "session:" + sessionKey(x) === id,
      );
      if (session)
        useApp.setState({
          modal: {
            kind: "session",
            provider: session.provider,
            sessionId: session.sessionId,
            file: session.file,
          },
        });
    } else if (id.startsWith("report:"))
      s.openReport({ id: id.slice("report:".length) });
    else if (id.startsWith("todo:")) {
      const nodeId = items.find((i) => i.id === id)?.project;
      if (nodeId) goToProject(nodeId, "todo");
    } else if (id.startsWith("view:")) s.navigate(id.slice(5) as View);
    else if (id === "new") useApp.setState({ modal: { kind: "new" } });
    else if (id === "shortcuts")
      useApp.setState({ modal: { kind: "shortcuts" } });
    else if (id === "rescan") rescan();
    else if (id === "theme") {
      const dark =
        getComputedStyle(document.documentElement).colorScheme === "dark";
      setTheme(dark ? "light" : "dark");
    }
  }
  useLayoutEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const before = previous.current;
    return () => restoreFocus(before);
  }, []);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);
  let last = "";
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) useApp.setState({ palette: false });
      }}
    >
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected(Math.min(index + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected(Math.max(index - 1, 0));
          } else if (e.key === "Enter" && items[index]) {
            e.preventDefault();
            go(items[index].id);
          } else if (e.key === "Tab") {
            e.preventDefault();
            input.current?.focus();
          }
        }}
      >
        <div className="pal-in">
          <Icon name="search" />
          <input
            ref={input}
            id="pal-in"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            placeholder={
              snapshot.reportsDir
                ? "Search projects, sessions, reports, to-dos, actions…"
                : "Search projects, sessions, to-dos, actions…"
            }
            autoComplete="off"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={
              items[index] ? `palette-item-${index}` : undefined
            }
          />
        </div>
        <div className="pal-list" id="palette-list" role="listbox" ref={list}>
          {items.map((item, i) => {
            const header = item.section !== last;
            last = item.section;
            return (
              <div key={item.id}>
                {header ? <div className="pal-sec">{item.section}</div> : null}
                <div
                  className="pal-item"
                  role="option"
                  id={`palette-item-${i}`}
                  aria-selected={i === index}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => go(item.id)}
                >
                  {item.node ? (
                    <KindIcon node={item.node} />
                  ) : (
                    <Icon name={item.icon} />
                  )}
                  <span>
                    <Highlight text={item.label} query={query} />
                  </span>
                  {item.node?.kind === "project" && item.node.meta.priority ? (
                    <PriorityGlyph priority={item.node.meta.priority} />
                  ) : null}
                  {item.node?.kind === "project" ? (
                    <DeadlinePill deadline={item.node.meta.deadline} />
                  ) : null}
                  <span className="sub mono">
                    <Highlight text={item.sub} query={query} />
                  </span>
                  <span className="acc">{item.acc}</span>
                </div>
              </div>
            );
          })}
          {!items.length ? <div className="empty">No results found</div> : null}
        </div>
        <div className="pal-foot">
          <span className="grow" />
          <span>
            Open <kbd>↵</kbd>
          </span>
          <span>
            Navigate <kbd>↑</kbd>
            <kbd>↓</kbd>
          </span>
          <span>
            Close <kbd>esc</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
