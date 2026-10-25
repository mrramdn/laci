// AI helpers: the chats of every project, the summaries your AI writes, and the AI tools Laci knows
// (design-research §3.3). Chats and Tools are the view "agents" and Summaries is "reports", so a
// switch to Detailed lands on its Agents or Reports. "Start a chat ▾" is the filled button; deleting
// chats needs "Select" first, or a chat's own sheet. Each change goes through the requests Detailed
// sends.
import "./ai-helpers.css";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { create } from "zustand";
import { closeReportItem } from "../actions";
import type { AgentCapabilities } from "../agent-launch";
import { api, errorText } from "../api";
import { useNow } from "../clock";
import { Icon } from "../common";
import {
  agentInstruction,
  base,
  bytes,
  conversationIds,
  conversationKey,
  copyChangeSaid,
  deletable,
  LOCALE,
  localDay,
  providerName,
  reportById,
  reportList,
  reportsOfSessions,
  sessionKey,
  tilde,
  trimSep,
} from "../helpers";
import type { Conversation } from "../helpers";
import { useFocusStays } from "../focus-stays";
import { useReportSearch, useReportText } from "../hooks";
import { loadMcp, useMcp } from "../mcp-setup";
import { chooseFolder } from "../pick";
import { copyProjects, sessionOwners } from "../selectors";
import { requestResume } from "../session-ui";
import type { Selection } from "../session-ui";
import {
  acknowledge,
  changed,
  chooseCopy,
  copyText,
  goToProject,
  markReportsSeen,
  moveCopy,
  openCopy,
  refreshLog,
  rescan,
  run,
  setDesign,
  toast,
  useApp,
} from "../store";
import type {
  Backup,
  Change,
  McpStatus,
  Node,
  Report,
  ReportsDir,
  SetupInfo,
  Snapshot,
} from "../types";
import { ago, aiHelpers as said, blocks, engineSays, project, spent } from "../words";
import { aiTools, editorName } from "./act";
import { CopyChoice } from "./CopyChoice";
import {
  canUseOf,
  chatsAtRisk,
  draftOf,
  helperChats,
  installOf,
  startsWith,
  summaryBody,
  summaryLink,
  toolCards,
  toolUse,
} from "./model";
import type { ChatFilter, ChatGroup, HelperChats, ToolCard } from "./model";
import {
  Button,
  Callout,
  Card,
  Disclosure,
  EmptyState,
  Info,
  MoreMenu,
  Sheet,
  StatusChip,
} from "./ui";

type Tab = "chats" | "summaries" | "tools";
const TABS: readonly Tab[] = ["chats", "summaries", "tools"];
/** The chats a project lists before "Show more". */
const GROUP_LIMIT = 5;
/** The summaries listed before "Show all"; a search shows every match. */
const LIST_LIMIT = 100;
/** Summaries this large wait for a click before they are drawn. */
const LARGE = 1_000_000;

/**
 * What AI helpers keeps while you are elsewhere: how Chats is filtered and searched. `toTools` and
 * `technical` each ask once, for the next time the page shows: AI helpers to open on Tools, and
 * Settings on its technical part, as Tools asks it to.
 */
export const useHelpers = create<{
  filter: ChatFilter;
  query: string;
  toTools: boolean;
  technical: boolean;
}>(() => ({ filter: "all", query: "", toTools: false, technical: false }));

/** Opens AI helpers on Tools. */
export function showTools() {
  useHelpers.setState({ toTools: true });
  useApp.getState().navigate("agents");
}

/**
 * What `agent/models` says of each AI in `providers`, without starting any of them (`passive`): its
 * program is installed or not, its models, and the choice it starts with.
 */
export function useCapabilities(providers: string[]) {
  const [caps, setCaps] = useState<Record<string, AgentCapabilities>>({});
  const wanted = providers.join(",");
  useEffect(() => {
    let live = true;
    for (const provider of wanted.split(",").filter(Boolean))
      api<AgentCapabilities>("agent/models", { provider, passive: true }).then(
        (result) => {
          if (live) setCaps((current) => ({ ...current, [provider]: result }));
        },
        // An AI Laci can't ask about shows no install status.
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [wanted]);
  return caps;
}

// Keeps the keyboard on the page when the control that has the focus goes away; Detailed's Agents uses it too.
export { useFocusStays };

/** Turns the automatic copy of AI chats on or off (`backup/auto`, as Detailed's Settings sends it). */
export function setCopying(on: boolean) {
  return run(async () => {
    const result = await api<{ snapshot?: Snapshot }>("backup/auto", { on });
    if (result.snapshot) acknowledge({ snapshot: result.snapshot });
    toast(on ? said.copyOn : said.copyOff);
  });
}

/** Copies the AI chats now: Detailed's "Back up now" (`backup`), said in Simple's words. */
function copyNow() {
  void run(async () => {
    const result = await api<{
      copied: number;
      dest: string;
      sessions: number;
      snapshot?: Snapshot;
    }>("backup", {});
    if (result.snapshot) acknowledge({ snapshot: result.snapshot });
    toast(
      result.copied ? said.copied(result.copied) : said.copyUpToDate,
      said.copyWhere(result.sessions, result.dest),
    );
    void refreshLog();
  }, said.copying);
}

/** Keeps chats out of Clean up's suggestions, or lets them in again (`session/keep`). */
function keepChats(list: Conversation[], keep: boolean) {
  const sessions = list.flatMap((c) =>
    [c.session, ...c.parts].map((s) => ({ provider: s.provider, sessionId: s.sessionId })),
  );
  return run(
    async () => {
      await api("session/keep", { sessions, keep });
      toast(
        keep ? said.keptDone(list.length) : said.unkeptDone(list.length),
        keep ? said.keptDoneNote(list.length) : "",
      );
    },
    said.keeping,
    { history: true },
  );
}

/** Puts a chat that only Laci's copy has back where its AI keeps it (`backup/restore`). */
function restoreChat(c: Conversation) {
  void run(
    async () => {
      changed(
        await api<Change>("backup/restore", { id: c.session.id }),
        said.restored,
        c.title,
      );
    },
    said.restoring,
    { history: true },
  );
}

/**
 * Deletes chats, each with the earlier parts it continued (`session/delete`). They go to Kept for
 * Undo, so the toast and Activity can bring them back. True once they are deleted.
 */
async function deleteChats(list: Conversation[], onError: (error: unknown) => void) {
  const ready = list.filter((c) => deletable(c));
  if (!ready.length) return false;
  const done = await run(
    async () => {
      const change = await api<Change>("session/delete", {
        files: ready.flatMap((c) => [c.session.file, ...c.parts.map((p) => p.file)]),
      });
      changed(change, said.deleted(ready.length), said.deletedNote(ready.length));
      return true;
    },
    said.deleting,
    { history: true, onError },
  );
  return done === true;
}

/** Where a chat can be continued: its project, else the folder it ran in. */
const continueIn = (c: Conversation, node?: Node) =>
  c.session.resumeCapability === "supported" && !c.session.backup
    ? (node?.id ?? c.session.cwd ?? undefined)
    : undefined;

export function AiHelpers() {
  const view = useApp((s) => s.view);
  const snapshot = useApp((s) => s.snapshot!);
  // Tools stays open while you move between the tabs. Back from elsewhere, the page opens on Chats,
  // as the sidebar and a project's "See all" expect, unless showTools() asked for Tools.
  const toTools = useHelpers((s) => s.toTools);
  const [tools, setTools] = useState(toTools);
  useEffect(() => {
    if (!toTools) return;
    useHelpers.setState({ toTools: false });
    setTools(true);
  }, [toTools]);
  const filter = useHelpers((s) => s.filter);
  const query = useHelpers((s) => s.query);
  const now = useNow();
  const chats = useMemo(
    () => helperChats(snapshot, { filter, query }, now),
    [snapshot, filter, query, now],
  );
  /** The chat whose sheet is open, by its key. */
  const [chat, setChat] = useState<string | null>(null);
  const tab: Tab = view === "reports" ? "summaries" : tools ? "tools" : "chats";
  /** Opens a tab: Summaries is the view "reports"; Chats and Tools are "agents". */
  const choose = (next: Tab) => {
    if (next !== "summaries") setTools(next === "tools");
    const app = useApp.getState();
    const to = next === "summaries" ? "reports" : "agents";
    if (app.view !== to) app.navigate(to);
  };
  const readable = Boolean(snapshot.reportsDir && !snapshot.reportsDir.error);
  const counts: Record<Tab, number> = {
    chats: chats.all.length,
    summaries: readable ? reportList(snapshot).length : 0,
    tools: toolCards(snapshot).length,
  };
  const open = chat ? chats.all.find((c) => conversationKey(c) === chat) : undefined;
  const page = useRef<HTMLDivElement>(null);
  useFocusStays(page);
  return (
    <div ref={page} className="s-page s-helpers">
      <header className="s-head s-head-row">
        <div>
          <h1>{said.title}</h1>
          <p className="s-lead">{said.lead}</p>
        </div>
        <div className="s-actions">
          <StartChat snapshot={snapshot} />
          {/* Detailed's denser lists (newest first, by AI, helper chats) are one switch away. */}
          <MoreMenu
            label={blocks.moreFor(said.title)}
            items={[
              {
                label: project.detailed,
                icon: "panels-top-left",
                onSelect: () => setDesign("detailed"),
              },
            ]}
          />
        </div>
      </header>
      <Tabs tab={tab} counts={counts} onChoose={choose} />
      {TABS.map((key) => (
        <section
          key={key}
          role="tabpanel"
          id={`helpers-${key}`}
          aria-labelledby={`helpers-tab-${key}`}
          className="s-helpers-panel"
          hidden={tab !== key}
        >
          {tab !== key ? null : key === "chats" ? (
            <Chats
              model={chats}
              snapshot={snapshot}
              now={now}
              onChat={setChat}
              onTools={() => choose("tools")}
            />
          ) : key === "summaries" ? (
            <Summaries snapshot={snapshot} chats={chats.all} onChat={setChat} />
          ) : (
            <Tools snapshot={snapshot} chats={chats.all} />
          )}
        </section>
      ))}
      {open ? (
        <ChatSheet
          key={chat}
          c={open}
          snapshot={snapshot}
          now={now}
          onClose={() => setChat(null)}
        />
      ) : null}
    </div>
  );
}

/** "Start a chat ▾": one item for each AI Laci can start; the project is chosen next. */
function StartChat({ snapshot }: { snapshot: Snapshot }) {
  const tools = aiTools(snapshot);
  if (!tools.length) return null;
  return (
    <MoreMenu
      label={said.start}
      kind="filled"
      icon="sparkles"
      align="end"
      items={tools.map((tool) => ({
        label: said.startWith(tool.label),
        icon: "sparkles",
        onSelect: () =>
          useApp.setState({
            modal: { kind: "agent", provider: tool.value, projectPath: "" },
          }),
      }))}
    >
      {said.start}
    </MoreMenu>
  );
}

/** The three tabs. The arrow keys, Home and End move between them, and open the one they reach. */
function Tabs({
  tab,
  counts,
  onChoose,
}: {
  tab: Tab;
  counts: Record<Tab, number>;
  onChoose: (tab: Tab) => void;
}) {
  const buttons = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? TABS[(at + 1) % TABS.length]
        : event.key === "ArrowLeft"
          ? TABS[(at + TABS.length - 1) % TABS.length]
          : event.key === "Home"
            ? TABS[0]
            : event.key === "End"
              ? TABS[TABS.length - 1]
              : undefined;
    if (!next) return;
    event.preventDefault();
    onChoose(next);
    buttons.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={said.tabsLabel}
      className="s-helpers-tabs"
      onKeyDown={onKey}
    >
      {TABS.map((key) => (
        <button
          key={key}
          ref={(button) => {
            buttons.current[key] = button;
          }}
          type="button"
          role="tab"
          id={`helpers-tab-${key}`}
          className="s-helpers-tab"
          aria-selected={tab === key}
          aria-controls={`helpers-${key}`}
          tabIndex={tab === key ? 0 : -1}
          onClick={() => onChoose(key)}
        >
          {said.tabs[key]}
          <span className="s-count">{counts[key]}</span>
        </button>
      ))}
    </div>
  );
}

// --- Chats ---------------------------------------------------------------------------------------

function Chats({
  model,
  snapshot,
  now,
  onChat,
  onTools,
}: {
  model: HelperChats;
  snapshot: Snapshot;
  now: number;
  onChat: (key: string) => void;
  onTools: () => void;
}) {
  const query = useHelpers((s) => s.query);
  const historyPending = useApp((s) => s.historyPending);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  // What is chosen and still shown and deletable: a filter or a search can hide a chosen one.
  const chosen = model.selectable.filter((c) => picked.has(conversationKey(c)));
  const all = model.selectable.length > 0 && chosen.length === model.selectable.length;
  const selection: Selection | undefined = selecting
    ? {
        has: (c) => picked.has(conversationKey(c)),
        toggle: (c) =>
          setPicked((current) => {
            const next = new Set(current);
            const key = conversationKey(c);
            if (!next.delete(key)) next.add(key);
            return next;
          }),
      }
    : undefined;
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  // Select's bar takes the place of its button, and the focus goes with it: to what the bar says on
  // the way in, and back to Select on the way out.
  const selectButton = useRef<HTMLButtonElement>(null);
  const selectNote = useRef<HTMLParagraphElement>(null);
  const wasSelecting = useRef(false);
  useEffect(() => {
    if (selecting) selectNote.current?.focus();
    else if (wasSelecting.current) selectButton.current?.focus();
    wasSelecting.current = selecting;
  }, [selecting]);
  const showAll = () => useHelpers.setState({ filter: "all", query: "" });
  return (
    <div className="s-helpers-chats">
      {/* First, so a narrow window shows its warning that chats are being lost before the chats. */}
      <CopyCard snapshot={snapshot} />
      <div className="s-helpers-main">
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
              onChange={(event) => useHelpers.setState({ query: event.target.value })}
            />
          </label>
          <div className="s-chips" role="group" aria-label={said.show}>
            {model.filters.map((key) => (
              <button
                key={key}
                type="button"
                className="s-filter"
                aria-pressed={model.filter === key}
                onClick={() => useHelpers.setState({ filter: key })}
              >
                {said.filters[key]}
                <span className="s-count">{model.counts[key]}</span>
              </button>
            ))}
          </div>
          {!selecting && model.selectable.length ? (
            <div className="s-toolbar-end">
              <Button
                ref={selectButton}
                kind="outline"
                small
                icon="check"
                onClick={() => setSelecting(true)}
              >
                {said.select}
              </Button>
            </div>
          ) : null}
        </div>
        {selecting ? (
          <div className="s-helpers-select" role="group" aria-label={said.selectLabel}>
            <p role="status" ref={selectNote} tabIndex={-1}>
              {chosen.length
                ? said.selected(
                    chosen.length,
                    bytes(chosen.reduce((n, c) => n + c.bytes, 0)),
                  )
                : said.selectNone}
            </p>
            <div className="s-actions">
              <Button
                kind="text"
                small
                disabled={!model.selectable.length}
                onClick={() =>
                  setPicked(
                    all ? new Set() : new Set(model.selectable.map(conversationKey)),
                  )
                }
              >
                {all ? said.clear : said.selectAll(model.selectable.length)}
              </Button>
              <Button
                kind="outline"
                small
                icon="keep"
                disabled={!chosen.length || historyPending}
                onClick={() =>
                  void keepChats(chosen, true).then(() => setPicked(new Set()))
                }
              >
                {said.keep}
              </Button>
              <Button
                kind="outline"
                small
                danger
                icon="trash-2"
                disabled={!chosen.length || historyPending}
                onClick={() => setDeleting(true)}
              >
                {said.delete}
              </Button>
              <Button kind="text" small onClick={stopSelecting}>
                {said.done}
              </Button>
            </div>
          </div>
        ) : null}
        {model.groups.length ? (
          model.groups.map((group) => (
            <GroupCard
              key={group.node?.id ?? ""}
              group={group}
              snapshot={snapshot}
              now={now}
              selection={selection}
              onChat={onChat}
            />
          ))
        ) : !model.all.length ? (
          <EmptyState
            art="no-chats"
            title={said.emptyTitle}
            action={
              <Button kind="outline" onClick={onTools}>
                {said.seeTools}
              </Button>
            }
          >
            {said.emptyBody}
          </EmptyState>
        ) : (
          <EmptyState
            art="no-chats"
            title={said.noneTitle}
            action={
              <Button kind="outline" onClick={showAll}>
                {query.trim() ? said.clearSearch : said.showAll}
              </Button>
            }
          >
            {query.trim() ? said.noMatch(query.trim()) : said.none[model.filter]}
          </EmptyState>
        )}
      </div>
      {deleting ? (
        <DeleteSheet
          chats={chosen}
          onClose={() => setDeleting(false)}
          onDeleted={() => setPicked(new Set())}
        />
      ) : null}
    </div>
  );
}

/** One project's chats, the quick ones folded into a line. */
function GroupCard({
  group,
  snapshot,
  now,
  selection,
  onChat,
}: {
  group: ChatGroup;
  snapshot: Snapshot;
  now: number;
  selection?: Selection;
  onChat: (key: string) => void;
}) {
  const [more, setMore] = useState(false);
  const [quick, setQuick] = useState(false);
  const { node } = group;
  const shown = more ? group.chats : group.chats.slice(0, GROUP_LIMIT);
  const row = (c: Conversation) => (
    <ChatRow
      key={conversationKey(c)}
      c={c}
      node={node}
      snapshot={snapshot}
      now={now}
      selection={selection}
      onChat={onChat}
    />
  );
  // Chats can belong to a folder rather than a project, such as one whose project has gone: only a
  // project has a page to open.
  return (
    <Card
      className="s-helpers-group"
      icon={node?.kind === "project" ? "folder-kanban" : node ? "folder" : "message-square"}
      title={
        node?.kind === "project" ? (
          <button
            type="button"
            className="s-link-strong"
            onClick={() => goToProject(node.id)}
          >
            {node.label}
          </button>
        ) : (
          (node?.label ?? said.notInProject)
        )
      }
      actions={
        <span className="s-quiet">
          {said.chatCount(group.chats.length + group.quick.length)}
        </span>
      }
    >
      <ul className="s-chats">{shown.map(row)}</ul>
      {group.chats.length > GROUP_LIMIT ? (
        <button type="button" className="s-link" onClick={() => setMore(!more)}>
          {more ? said.showFewer : said.showMore(group.chats.length - GROUP_LIMIT)}
        </button>
      ) : null}
      {group.quick.length ? (
        <div className="s-helpers-quick">
          <button
            type="button"
            className="s-btn s-btn-text s-btn-small s-disclosure-toggle"
            aria-expanded={quick}
            onClick={() => setQuick(!quick)}
          >
            {said.quick(group.quick.length)}
            <Icon name="chevron-down" className={quick ? "s-turned" : ""} />
          </button>
          <span className="s-quiet">{said.quickNote}</span>
          {quick ? <ul className="s-chats">{group.quick.map(row)}</ul> : null}
        </div>
      ) : null}
    </Card>
  );
}

/** "7 messages · 3 files changed · 40 minutes": what a chat was, in one line. */
function facts(c: Conversation) {
  return [
    c.prompts ? said.messages(c.prompts) : "",
    c.filesChanged ? said.files(c.filesChanged) : "",
    spent(c.activeSeconds),
  ].filter(Boolean);
}

function ChatRow({
  c,
  node,
  snapshot,
  now,
  selection,
  onChat,
}: {
  c: Conversation;
  node?: Node;
  snapshot: Snapshot;
  now: number;
  selection?: Selection;
  onChat: (key: string) => void;
}) {
  const session = c.session;
  const ai = providerName(snapshot, session.provider);
  const where = continueIn(c, node);
  const lines = facts(c);
  const key = conversationKey(c);
  return (
    <li className="s-chat s-helpers-chat" data-chat={key}>
      {selection ? (
        deletable(c, now) ? (
          <input
            type="checkbox"
            className="s-cb"
            aria-label={said.pick(c.title)}
            checked={selection.has(c)}
            onChange={() => selection.toggle(c)}
          />
        ) : (
          <span className="s-helpers-nopick" aria-hidden="true" />
        )
      ) : null}
      <div className="s-chat-text">
        <button type="button" className="s-helpers-title" onClick={() => onChat(key)}>
          {c.title}
        </button>
        <span className="s-quiet">{said.by(ai, ago(c.updatedAt, now))}</span>
        {lines.length ? <span className="s-quiet">{lines.join(" · ")}</span> : null}
        {session.kept || session.backup ? (
          <span className="s-helpers-tags">
            {session.kept ? <span className="s-tag">{said.kept}</span> : null}
            {session.backup ? <span className="s-tag">{said.onlyCopy}</span> : null}
          </span>
        ) : null}
      </div>
      {session.backup ? (
        <Button
          kind="outline"
          small
          aria-label={said.restoreFor(c.title)}
          onClick={() => restoreChat(c)}
        >
          {said.restore}
        </Button>
      ) : where ? (
        <Button
          kind="outline"
          small
          aria-label={said.continueFor(c.title)}
          onClick={() => requestResume(session, node?.id)}
        >
          {said.continue}
        </Button>
      ) : null}
    </li>
  );
}

/** "Keep a copy of AI chats": on or off, the last copy, Copy now and the folder (design-research). */
function CopyCard({ snapshot }: { snapshot: Snapshot }) {
  const historyPending = useApp((s) => s.historyPending);
  const backup = snapshot.backup;
  if (!backup) return null;
  // The AIs that delete their own chats say so; the first is enough to act on.
  const risk = chatsAtRisk(snapshot);
  const dest = backup.dest;
  return (
    <Card
      title={said.copyTitle}
      icon="hard-drive"
      className="s-helpers-copy"
      actions={<Info term="copy-chats" />}
    >
      {risk && !backup.auto ? (
        <Callout tone="soon">
          {said.copyWarn(providerName(snapshot, risk.provider), risk.days)}
        </Callout>
      ) : null}
      <label className="s-helpers-check">
        <input
          type="checkbox"
          className="s-cb"
          checked={backup.auto}
          disabled={historyPending}
          onChange={(event) => void setCopying(event.target.checked)}
        />
        <span>
          <b>{said.copyAuto}</b>
          <span className="s-quiet">{said.copyAutoNote}</span>
        </span>
      </label>
      <p className="s-quiet">
        {backup.at
          ? said.copyLast(ago(backup.at), backup.sessions ?? 0, bytes(backup.bytes))
          : said.copyNone}
      </p>
      {backup.error ? <Callout tone="act">{engineSays(backup.error, "simple")}</Callout> : null}
      <div className="s-actions">
        <Button kind="outline" small icon="copy" onClick={copyNow}>
          {said.copyNow}
        </Button>
        {dest && backup.at && !backup.error ? (
          <Button kind="text" small icon="folder-open" onClick={() => openCopy(dest)}>
            {said.openFolder}
          </Button>
        ) : null}
      </div>
      <CopyWhich snapshot={snapshot} backup={backup} />
      <CopyPlace backup={backup} home={snapshot.home} />
    </Card>
  );
}

/**
 * "Which chats": every project's, or only the ones chosen, with a warning when folders holding chats aren't copied,
 * so a project that appeared later isn't forgotten. The sheet makes the choice; "Copy every project" goes back to
 * the copy that takes all.
 */
function CopyWhich({ snapshot, backup }: { snapshot: Snapshot; backup: Backup }) {
  const historyPending = useApp((s) => s.historyPending);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const only = backup.only;
  const everyProject = async () => {
    setSaving(true);
    await chooseCopy(null, said.copyEveryDone, said.copyEveryNote);
    setSaving(false);
  };
  return (
    <div className="s-helpers-place" data-ui="copy-which">
      <p>
        <b>{said.copyWhich}</b>
        <span className="s-quiet">
          {only ? said.copyOnly(copyProjects(snapshot, only), only.paths.length) : said.copyEvery}
          {only && only.notCopied > 0 ? ` · ${said.copyLeft(only.notCopied)}` : ""}
        </span>
      </p>
      <div className="s-actions">
        <Button
          kind="text"
          small
          icon="folder-kanban"
          aria-label={only ? said.copyChangeProjectsName : said.copyChooseName}
          disabled={historyPending || saving}
          onClick={() => setOpen(true)}
        >
          {only ? said.copyChangeProjects : said.copyChoose}
        </Button>
        {only ? (
          <Button kind="text" small disabled={historyPending || saving} onClick={() => void everyProject()}>
            {said.copyEveryButton}
          </Button>
        ) : null}
      </div>
      {open ? <CopyChoice snapshot={snapshot} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/**
 * "Where Laci keeps the copy": the folder, Change… and, for a chosen one, back to Laci's own folder. A copy Laci
 * can't reach now isn't moved: a new one can start in the folder chosen instead, and the question says the old one
 * stays where it is.
 */
function CopyPlace({ backup, home }: { backup: Backup; home: string }) {
  const historyPending = useApp((s) => s.historyPending);
  const working = useApp((s) => s.working);
  // The folder picked, waiting for the question to be answered; "" is Laci's own folder.
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const change = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const told = useId();
  const open = asking !== null;
  const fresh = Boolean(backup.error);
  const moving = working === said.copyMoving;
  const busy = moving || historyPending;
  const wasOpen = useRef(false);
  const giveBack = useRef(false);
  // The question takes the focus when it opens, and only then: while it stays open, as when a move starts or ends or
  // an automatic backup reads history again, the focus stays where it went, as on Cancel. It gives the focus back to
  // Change… when it closes, as soon as Change… can take it: after a move it is disabled until history is read again.
  // Not if the focus went somewhere else meanwhile.
  useEffect(() => {
    if (open && !wasOpen.current) question.current?.focus();
    giveBack.current = open ? false : giveBack.current || wasOpen.current;
    wasOpen.current = open;
    if (!giveBack.current || busy) return;
    giveBack.current = false;
    const at = document.activeElement;
    if (!at || at === document.body || row.current?.contains(at)) change.current?.focus();
  }, [open, busy]);
  const where = (dir: string) => (dir ? tilde(dir, home) : said.copyPlaceOwnName);
  const note = fresh ? said.copyFreshNote : said.copyMoveNote;
  const ask = (dir: string) => {
    setError("");
    setAsking(dir);
  };
  const asked = (dir: string) =>
    fresh
      ? said.copyFreshAsk(where(dir))
      : backup.bytes && !backup.packed
        ? said.copyMovePlainAsk(where(dir))
        : said.copyMoveAsk(where(dir), backup.bytes ? bytes(backup.bytes) : undefined);
  const move = (dir: string) =>
    void moveCopy(
      dir,
      fresh,
      {
        moving: said.copyMoving,
        note,
        said: (answer) =>
          copyChangeSaid(dir, answer, {
            moved: said.copyMoved,
            kept: said.copyKept,
            own: said.copyPlaceOwnName,
          }),
      },
      (failure) => setError(errorText(failure)),
    ).then((done) => {
      if (done) setAsking(null);
    });
  const act = fresh ? said.copyFresh : said.copyMove;
  return (
    <div className="s-helpers-place" ref={row} data-ui="copy-place">
      <p>
        <b>{said.copyPlace}</b>
        {/* Only a path is set as one: Laci's own folder is said by its name. */}
        <span className={backup.chosen ? "s-quiet s-mono" : "s-quiet"}>
          {backup.chosen ? backup.dest : said.copyPlaceOwn}
        </span>
        <span className="s-quiet">{said.copyPlaceNote}</span>
      </p>
      {asking !== null ? (
        <div ref={question} role="group" aria-label={act} aria-describedby={told} tabIndex={-1}>
          <p id={told}>
            {asked(asking)} {note}
          </p>
          <div className="s-actions">
            <Button kind="text" small disabled={moving} onClick={() => setAsking(null)}>
              {blocks.cancel}
            </Button>
            <Button kind="outline" small icon="move" disabled={busy} onClick={() => move(asking)}>
              {moving ? said.copyMoving : act}
            </Button>
          </div>
        </div>
      ) : (
        <div className="s-actions">
          <Button
            ref={change}
            kind="text"
            small
            icon="folder"
            aria-label={said.copyPlaceChangeName}
            disabled={busy}
            onClick={() =>
              void chooseFolder(
                {
                  title: said.copyPlaceTitle,
                  defaultPath: backup.chosen && backup.dest ? backup.dest : "~",
                },
                ask,
              )
            }
          >
            {said.copyPlaceChange}
          </Button>
          {backup.chosen ? (
            <Button kind="text" small disabled={busy} onClick={() => ask("")}>
              {said.copyPlaceBack}
            </Button>
          ) : null}
        </div>
      )}
      {error ? <Callout tone="act">{error}</Callout> : null}
    </div>
  );
}

/** A quote from a chat: what you asked first and last, and the AI's last reply. */
function Said({ label, text }: { label: string; text?: string }) {
  return text ? (
    <figure className="s-said">
      <figcaption>{label}</figcaption>
      <blockquote>{text}</blockquote>
    </figure>
  ) : null;
}

/** "8 October, 09:00": a moment of a chat, as this computer writes dates. */
const moment = (at: string) =>
  new Date(at).toLocaleString(LOCALE, {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * One chat: what it was, the first and last thing you said and the AI's last reply, with Continue,
 * Keep, Delete… and its summary. Delete… asks first, in the same sheet, so the focus comes back to the
 * chat's row when the sheet closes.
 */
function ChatSheet({
  c,
  snapshot,
  now,
  onClose,
}: {
  c: Conversation;
  snapshot: Snapshot;
  now: number;
  onClose: () => void;
}) {
  const historyPending = useApp((s) => s.historyPending);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  const session = c.session;
  const node = sessionOwners(snapshot).get(sessionKey(session));
  const ai = providerName(snapshot, session.provider);
  const ids = conversationIds(c);
  const reports = snapshot.reportsDir ? reportsOfSessions(snapshot, ids) : [];
  const where = continueIn(c, node);
  const place = node
    ? node.label
    : session.cwd
      ? tilde(session.cwd, snapshot.home)
      : said.noFolder;
  // Asking first takes the focus to the question; going back gives it to Delete… again.
  useEffect(() => {
    if (confirm) heading.current?.focus();
    else if (asked.current) deleteButton.current?.focus();
    asked.current = confirm;
  }, [confirm]);
  const remove = () =>
    void deleteChats([c], (failure) => setError(errorText(failure))).then((done) => {
      if (done) onClose();
    });
  const leave = (then: () => void) => {
    onClose();
    then();
  };
  const lines = facts(c);
  return (
    <Sheet
      title={c.title}
      description={said.chatAbout(ai, place, ago(c.updatedAt, now))}
      onClose={onClose}
      footer={
        confirm ? (
          <>
            <Button kind="text" onClick={() => setConfirm(false)}>
              {blocks.cancel}
            </Button>
            <Button
              kind="outline"
              danger
              icon="trash-2"
              disabled={historyPending}
              onClick={remove}
            >
              {said.deleteNow}
            </Button>
          </>
        ) : (
          <>
            {!session.backup ? (
              <Button
                kind="text"
                icon="keep"
                disabled={historyPending}
                onClick={() => void keepChats([c], !session.kept)}
              >
                {session.kept ? said.dontKeep : said.keep}
              </Button>
            ) : null}
            {deletable(c, now) ? (
              <Button
                ref={deleteButton}
                kind="outline"
                danger
                icon="trash-2"
                disabled={historyPending}
                onClick={() => setConfirm(true)}
              >
                {said.delete}
              </Button>
            ) : null}
            {reports.length ? (
              <Button
                kind="outline"
                icon="book-open"
                onClick={() =>
                  leave(() =>
                    useApp.getState().openReport({ id: reports[0].id, sessions: ids }),
                  )
                }
              >
                {said.readSummary}
              </Button>
            ) : null}
            {node?.kind === "project" ? (
              <Button kind="outline" onClick={() => leave(() => goToProject(node.id))}>
                {said.openProject(node.label)}
              </Button>
            ) : null}
            {session.backup ? (
              <Button
                kind="filled"
                disabled={historyPending}
                onClick={() => leave(() => restoreChat(c))}
              >
                {said.restore}
              </Button>
            ) : where ? (
              <Button
                kind="filled"
                icon="sparkles"
                onClick={() => leave(() => requestResume(session, node?.id))}
              >
                {said.continue}
              </Button>
            ) : null}
          </>
        )
      }
    >
      {confirm ? (
        <section className="s-helpers-confirm" aria-labelledby="chat-delete-title">
          <h3 id="chat-delete-title" ref={heading} tabIndex={-1}>
            {said.deleteOne}
          </h3>
          <p>{said.deleteNote(1, bytes(c.bytes))}</p>
          {error ? <Callout tone="act">{error}</Callout> : null}
        </section>
      ) : (
        <>
          <dl className="s-facts">
            <dt>{said.inIt}</dt>
            <dd>{lines.length ? lines.join(" · ") : said.notWritten}</dd>
            <dt>{said.when}</dt>
            <dd>
              {c.startedAt && c.startedAt !== c.updatedAt
                ? said.span(moment(c.startedAt), moment(c.updatedAt))
                : moment(c.updatedAt)}
            </dd>
            <dt>{said.size}</dt>
            <dd>{bytes(c.bytes)}</dd>
          </dl>
          {session.kept ? (
            <p className="s-helpers-note">
              <span className="s-tag">{said.kept}</span> {said.keptNote}
            </p>
          ) : null}
          {session.backup ? <Callout tone="fyi">{said.onlyCopyNote}</Callout> : null}
          <Said
            label={said.firstMessage}
            text={c.parts.at(-1)?.firstPrompt ?? session.firstPrompt}
          />
          {session.lastPrompt !== session.firstPrompt ? (
            <Said label={said.lastMessage} text={session.lastPrompt} />
          ) : null}
          <Said label={said.lastReply(ai)} text={session.lastReply} />
          <Disclosure>
            <dl className="s-facts">
              <dt>{said.folder}</dt>
              <dd className="s-mono">
                {session.cwd ? tilde(session.cwd, snapshot.home) : said.notWritten}
              </dd>
              <dt>{said.chatId}</dt>
              <dd className="s-mono">{session.sessionId || said.notWritten}</dd>
              <dt>{said.file}</dt>
              <dd className="s-mono">{tilde(session.file, snapshot.home)}</dd>
            </dl>
          </Disclosure>
        </>
      )}
    </Sheet>
  );
}

/** Asks before Select's chats are deleted: how many, how much, and that Undo brings them back. */
function DeleteSheet({
  chats,
  onClose,
  onDeleted,
}: {
  chats: Conversation[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const historyPending = useApp((s) => s.historyPending);
  const [error, setError] = useState("");
  const ready = chats.filter((c) => deletable(c));
  const left = chats.length - ready.length;
  const size = ready.reduce((n, c) => n + c.bytes, 0);
  const remove = () =>
    void deleteChats(ready, (failure) => setError(errorText(failure))).then((done) => {
      if (!done) return;
      onDeleted();
      onClose();
    });
  return (
    <Sheet
      title={ready.length === 1 ? said.deleteOne : said.deleteMany(ready.length)}
      description={said.deleteNote(ready.length, bytes(size))}
      onClose={onClose}
      footer={
        <>
          <Button kind="text" onClick={onClose}>
            {blocks.cancel}
          </Button>
          <Button
            kind="outline"
            danger
            icon="trash-2"
            disabled={!ready.length || historyPending}
            onClick={remove}
          >
            {said.deleteNow}
          </Button>
        </>
      }
    >
      <ul className="s-files">
        {ready.slice(0, 6).map((c) => (
          <li key={conversationKey(c)}>
            <b>{c.title}</b>{" "}
            <span className="s-quiet">{facts(c).join(" · ") || bytes(c.bytes)}</span>
          </li>
        ))}
        {ready.length > 6 ? (
          <li className="s-quiet">{said.deleteMore(ready.length - 6)}</li>
        ) : null}
      </ul>
      {left ? <p className="s-quiet">{said.deleteStay(left)}</p> : null}
      {error ? <Callout tone="act">{error}</Callout> : null}
    </Sheet>
  );
}

// --- Summaries -----------------------------------------------------------------------------------

/**
 * Saves the folder your AI writes summaries in, keeping every other setting as it is saved: what
 * Settings does when that folder is chosen there.
 */
function saveSummariesFolder(path: string) {
  return run(
    async () => {
      const info = await api<SetupInfo>("setup/info");
      const result = await api<Change>("setup/save", { ...draftOf(info), reportsDir: path });
      changed(result, said.folderSaved, base(path));
    },
    said.savingFolder,
    { history: true },
  );
}

const pickSummariesFolder = () =>
  void chooseFolder({ title: said.chooseFolderTitle, defaultPath: "~" }, (path) =>
    void saveSummariesFolder(path),
  );

/** The instruction that makes an AI write summaries Laci reads, with the folder filled in. */
const copyInstruction = (dir: ReportsDir, home: string) =>
  copyText(
    agentInstruction(tilde(dir.path, home)),
    said.instructionCopied,
    said.instructionHint,
  );

/** A summary's day, as "7 October": with the year when it is another year. */
function dayOf(report: Report, long = false) {
  const day = localDay(report.date) ?? new Date(report.modified);
  return day.toLocaleDateString(LOCALE, {
    ...(long ? { weekday: "long" as const } : {}),
    day: "numeric",
    month: "long",
    ...(day.getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}),
  });
}

function Summaries({
  snapshot,
  chats,
  onChat,
}: {
  snapshot: Snapshot;
  chats: Conversation[];
  onChat: (key: string) => void;
}) {
  const reportId = useApp((s) => s.report);
  const filter = useApp((s) => s.reportFilter);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const { needle, fullText, found, shown } = useReportSearch(snapshot, query, filter);
  // What counts as new is fixed for this visit, so a summary stays new until it is opened.
  const [since] = useState(() => useApp.getState().reportsSeen);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const list = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const dir = snapshot.reportsDir;
  const readable = Boolean(dir && !dir.error);
  const reports = reportList(snapshot);
  useEffect(() => {
    if (readable) markReportsSeen();
  }, [readable, snapshot.reports]);
  if (!dir)
    return (
      <EmptyState
        art="no-summaries"
        title={said.noFolderTitle}
        action={
          <Button kind="outline" icon="folder-open" onClick={pickSummariesFolder}>
            {said.chooseFolder}
          </Button>
        }
      >
        {said.noFolderBody}
      </EmptyState>
    );
  if (dir.error)
    return (
      <EmptyState
        art="went-wrong"
        title={said.unreadableTitle}
        action={
          <>
            <Button kind="outline" icon="refresh-cw" onClick={() => void rescan()}>
              {said.checkAgain}
            </Button>
            <Button kind="text" icon="folder-open" onClick={pickSummariesFolder}>
              {said.chooseAnother}
            </Button>
          </>
        }
      >
        <span className="s-mono">{tilde(dir.path, snapshot.home)}</span>: {dir.error}
      </EmptyState>
    );
  if (!reports.length)
    return (
      <EmptyState
        art="no-summaries"
        title={said.noSummariesTitle}
        action={
          <>
            <Button
              kind="outline"
              icon="copy"
              onClick={() => copyInstruction(dir, snapshot.home)}
            >
              {said.copyInstruction}
            </Button>
            <Button
              kind="text"
              icon="folder-open"
              onClick={() => void run(() => api("reports/open", { what: "folder" }))}
            >
              {said.openFolder}
            </Button>
          </>
        }
      >
        {said.noSummariesBody}
      </EmptyState>
    );
  const chosen = reportById(snapshot, reportId);
  const current = chosen ?? (reportId ? undefined : shown[0]);
  const gone = Boolean(reportId && !chosen);
  const capped = needle || all ? shown : shown.slice(0, LIST_LIMIT);
  // The list is one stop for Tab, on the summary that is open; the arrow keys move along it.
  const focusable = capped.some((r) => r.id === current?.id) ? current?.id : capped[0]?.id;
  const rows = () =>
    Array.from(list.current?.querySelectorAll<HTMLElement>(".s-summary-row") ?? []);
  const moveInList = (event: KeyboardEvent<HTMLElement>) => {
    const items = rows();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      event.key === "ArrowDown"
        ? at + 1
        : event.key === "ArrowUp"
          ? at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : undefined;
    if (to === undefined || at < 0) return;
    event.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, to))]?.focus();
  };
  const open = (report: Report) => {
    useApp.setState({ report: report.id });
    setOpened((was) => new Set(was).add(report.id));
    // On a narrow window the summary takes the list's place, and the focus goes to its title.
    requestAnimationFrame(() => {
      if (!list.current?.getClientRects().length) title.current?.focus();
    });
  };
  // Back to the list on a narrow window, with the focus on the summary that was open.
  const back = () => {
    const id = current?.id;
    useApp.setState({ report: null });
    requestAnimationFrame(() =>
      list.current
        ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id ?? "")}"]`)
        ?.focus(),
    );
  };
  const narrowed = filter
    ? "sessions" in filter
      ? (() => {
          const c = chats.find((chat) =>
            conversationIds(chat).some((id) => filter.sessions.includes(id)),
          );
          return c ? said.forChat(c.title) : said.forOneChat;
        })()
      : said.forProject(snapshot.nodes[filter.project]?.label ?? base(filter.project))
    : "";
  return (
    <div className="s-summaries" data-show={reportId ? "reader" : "list"}>
      <div className="s-summaries-list" ref={list}>
        <div className="s-toolbar">
          <label className="s-search-field">
            <Icon name="search" />
            <input
              type="search"
              className="s-input"
              aria-label={said.searchSummaries}
              placeholder={said.searchSummaries}
              value={query}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                rows()
                  .find((row) => row.dataset.id === focusable)
                  ?.focus();
              }}
            />
          </label>
          {filter ? (
            <button
              type="button"
              className="s-filter"
              aria-pressed="true"
              title={said.showAllSummaries}
              onClick={() => useApp.setState({ reportFilter: null })}
            >
              {narrowed}
              <Icon name="x" />
            </button>
          ) : null}
        </div>
        <ul className="s-summary-rows" aria-label={said.summaryList} onKeyDown={moveInList}>
          {capped.map((report) => (
            <li key={report.id}>
              <SummaryRow
                report={report}
                snapshot={snapshot}
                snippet={found?.snippets.get(report.id)}
                current={report.id === current?.id}
                focusable={report.id === focusable}
                fresh={Date.parse(report.modified) > since && !opened.has(report.id)}
                onOpen={() => open(report)}
              />
            </li>
          ))}
        </ul>
        {!needle && !all && shown.length > LIST_LIMIT ? (
          <button type="button" className="s-link" onClick={() => setAll(true)}>
            {said.showAllRows(shown.length)}
          </button>
        ) : null}
        {fullText && !found ? <p className="s-quiet">{said.searchingInside}</p> : null}
        {found?.failed ? <p className="s-quiet">{said.searchFailed}</p> : null}
        {!shown.length && (!fullText || found) ? (
          <div className="s-helpers-nomatch">
            <p>{needle ? said.noSummaryMatch(needle) : said.noneForThis}</p>
            <Button
              kind="outline"
              small
              onClick={() =>
                needle ? setQuery("") : useApp.setState({ reportFilter: null })
              }
            >
              {needle ? said.clearSearch : said.showAllSummaries}
            </Button>
          </div>
        ) : null}
      </div>
      {gone ? (
        <article className="s-reader s-reader-gone">
          <EmptyState
            art="went-wrong"
            title={said.goneTitle}
            level={2}
            compact
            action={
              <Button kind="outline" onClick={() => useApp.setState({ report: null })}>
                {said.showNewest}
              </Button>
            }
          >
            {said.goneBody}
          </EmptyState>
        </article>
      ) : current ? (
        <SummaryReader
          key={current.id}
          report={current}
          dir={dir}
          reports={reports}
          snapshot={snapshot}
          chats={chats}
          title={title}
          onBack={back}
          listHidden={() => !list.current?.getClientRects().length}
          onChat={onChat}
        />
      ) : null}
    </div>
  );
}

function SummaryRow({
  report,
  snapshot,
  snippet,
  current,
  focusable,
  fresh,
  onOpen,
}: {
  report: Report;
  snapshot: Snapshot;
  snippet?: string;
  current: boolean;
  /** The row Tab stops on: the arrow keys reach the others. */
  focusable: boolean;
  fresh: boolean;
  onOpen: () => void;
}) {
  const where = report.projects.length
    ? report.projects.map((path) => snapshot.nodes[path]?.label ?? base(path)).join(", ")
    : (report.scope ?? said.noProject);
  const text = snippet ?? report.summary;
  return (
    <button
      type="button"
      className="s-summary-row"
      data-id={report.id}
      aria-current={current || undefined}
      tabIndex={focusable ? 0 : -1}
      onClick={onOpen}
    >
      <span className="s-summary-title">
        <b>{report.title}</b>
        {fresh ? <span className="s-tag s-tag-brand">{said.newTag}</span> : null}
      </span>
      <span className="s-quiet">
        {where} · {dayOf(report)}
      </span>
      {text ? <span className="s-summary-text">{text}</span> : null}
      {report.openCount ? (
        <span className="s-summary-open">{said.stillToDoCount(report.openCount)}</span>
      ) : null}
    </button>
  );
}

type Readme = typeof import("../readme");

function SummaryReader({
  report,
  dir,
  reports,
  snapshot,
  chats,
  title,
  onBack,
  listHidden,
  onChat,
}: {
  report: Report;
  dir: ReportsDir;
  reports: Report[];
  snapshot: Snapshot;
  chats: Conversation[];
  /** The summary's title, which takes the focus when the summary takes the list's place. */
  title: RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  listHidden: () => boolean;
  onChat: (key: string) => void;
}) {
  const apps = useApp((s) => s.apps);
  const text = useReportText(report);
  const [large, setLarge] = useState(report.bytes > LARGE);
  const [remote, setRemote] = useState(false);
  const [shown, setShown] = useState<{ html: string; remote: number } | null>(null);
  const module = useRef<Readme | null>(null);
  const folder = trimSep(dir.path);
  const raw = text.raw;
  // Marked and its cleaner load the first time a summary is drawn.
  useEffect(() => {
    if (raw === undefined || large) return;
    let live = true;
    void import("../readme").then((readme) => {
      if (!live) return;
      module.current = readme;
      setShown(readme.renderReadme(summaryBody(raw), folder, remote));
    });
    return () => {
      live = false;
    };
  }, [raw, large, folder, remote]);
  const click = (event: MouseEvent<HTMLElement>) =>
    module.current?.proseClick(event, {
      remote: () => setRemote(true),
      blocked: said.linkBlocked,
      relative: (href) => {
        const target = summaryLink(href, reports, folder);
        if (target) useApp.setState({ report: target.id });
        else toast(said.linkNotOpened, said.linkNotOpenedNote);
      },
    });
  const day = localDay(report.date);
  const updated = new Date(report.modified).toDateString() !== day?.toDateString();
  const from = report.sessions.flatMap((id) => {
    const c = chats.find((chat) => conversationIds(chat).some((x) => x.toLowerCase() === id));
    return c ? [c] : [];
  });
  const chatsFrom = [...new Map(from.map((c) => [conversationKey(c), c])).values()];
  return (
    <article
      className="s-reader"
      aria-labelledby="summary-title"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !listHidden()) return;
        event.preventDefault();
        event.stopPropagation();
        onBack();
      }}
    >
      <button type="button" className="s-back s-reader-back" onClick={onBack}>
        <Icon name="arrow-left" />
        {said.back}
      </button>
      <h2 id="summary-title" ref={title} tabIndex={-1}>
        {report.title}
      </h2>
      <p className="s-quiet">
        {dayOf(report, true)}
        {updated ? ` · ${said.updated(ago(report.modified))}` : ""}
      </p>
      {report.projects.length || chatsFrom.length ? (
        <div className="s-chips s-reader-chips">
          {report.projects.map((path) => {
            const n = snapshot.nodes[path];
            return n?.kind === "project" ? (
              <Button
                key={path}
                kind="outline"
                small
                icon="folder-kanban"
                onClick={() => goToProject(n.id)}
              >
                {n.label}
              </Button>
            ) : (
              <span key={path} className="s-tag">
                {base(path)}
              </span>
            );
          })}
          {chatsFrom.map((c) => (
            <Button
              key={conversationKey(c)}
              kind="outline"
              small
              icon="message-square"
              onClick={() => onChat(conversationKey(c))}
            >
              {said.fromChat(c.title)}
            </Button>
          ))}
        </div>
      ) : null}
      <StillToDo report={report} />
      <div className="s-actions s-reader-actions">
        <Button
          kind="outline"
          small
          icon="editor"
          onClick={() =>
            void run(() => api("reports/open", { what: "editor", id: report.id }))
          }
        >
          {said.openIn(editorName(apps))}
        </Button>
        <Button
          kind="text"
          small
          icon="folder-open"
          onClick={() => void run(() => api("reports/open", { what: "folder" }))}
        >
          {said.openFolder}
        </Button>
      </div>
      <Disclosure>
        <dl className="s-facts">
          <dt>{said.location}</dt>
          <dd className="s-mono">{tilde(report.file, snapshot.home)}</dd>
          <dt>{said.size}</dt>
          <dd>{bytes(report.bytes)}</dd>
        </dl>
        <Button
          kind="text"
          small
          icon="copy"
          onClick={() => copyText(report.file, said.locationCopied, report.title)}
        >
          {said.copyLocation}
        </Button>
      </Disclosure>
      <div className="s-reader-body">
        {raw === undefined ? (
          text.error ? (
            <p className="s-quiet">
              {text.error}{" "}
              <Button kind="text" small onClick={text.retry}>
                {said.tryAgain}
              </Button>
            </p>
          ) : (
            <p className="s-quiet">{said.reading}</p>
          )
        ) : large ? (
          <p className="s-note">
            {said.large(bytes(report.bytes))}{" "}
            <Button kind="text" small onClick={() => setLarge(false)}>
              {said.showIt}
            </Button>
          </p>
        ) : !shown ? (
          <p className="s-quiet">{said.reading}</p>
        ) : (
          <>
            {shown.remote && !remote ? (
              <p className="s-note">
                {said.remoteImages(shown.remote)}{" "}
                <Button kind="text" small onClick={() => setRemote(true)}>
                  {said.loadImages}
                </Button>
              </p>
            ) : null}
            <div
              className="s-prose"
              onClick={click}
              dangerouslySetInnerHTML={{ __html: shown.html }}
            />
          </>
        )}
      </div>
    </article>
  );
}

/**
 * The summary's "Still to do": each item can be marked Done or Not needed, and a closed one opened
 * again. Laci keeps this in its own data; the summary file stays as the AI wrote it.
 */
function StillToDo({ report }: { report: Report }) {
  const closed = report.closed ?? [];
  if (!report.open.length && !closed.length) return null;
  return (
    <section className="s-summary-todo" aria-labelledby="summary-todo">
      <div className="s-subhead">
        <h3 id="summary-todo">{said.stillToDo}</h3>
        <Info term="summary" />
      </div>
      <p className="s-quiet">{said.stillToDoNote}</p>
      {report.open.length ? (
        <ul className="s-summary-items">
          {report.open.map((item) => (
            <li key={item} className="s-summary-item">
              <span>{item}</span>
              <div className="s-actions">
                <Button
                  kind="outline"
                  small
                  icon="check"
                  aria-label={said.itemDoneFor(item)}
                  onClick={() => void closeReportItem(report.id, item, "done")}
                >
                  {said.itemDone}
                </Button>
                <Button
                  kind="text"
                  small
                  aria-label={said.notNeededFor(item)}
                  onClick={() => void closeReportItem(report.id, item, "dropped")}
                >
                  {said.notNeeded}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>{said.nothingLeft}</p>
      )}
      {report.openCount > report.open.length ? (
        <p className="s-quiet">{said.moreInSummary(report.openCount - report.open.length)}</p>
      ) : null}
      {closed.length ? (
        <Disclosure
          label={said.closedItems(closed.length)}
          openLabel={said.closedItems(closed.length)}
        >
          <ul className="s-summary-items">
            {closed.map((item) => (
              <li key={item} className="s-summary-item s-done">
                <span>{item}</span>
                <Button
                  kind="text"
                  small
                  aria-label={said.openAgainFor(item)}
                  onClick={() => void closeReportItem(report.id, item, "open")}
                >
                  {said.openAgain}
                </Button>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </section>
  );
}

// --- Tools ---------------------------------------------------------------------------------------

/** Shows an AI's chats on your projects (`connector/add`), as Detailed's Agents switch does. */
function showChats(tool: ToolCard) {
  void run(
    async () => {
      changed(await api<Change>("connector/add", { preset: tool.id }), said.chatsShown(tool.name));
    },
    said.adding,
    { history: true },
  );
}

/**
 * Stops showing an AI's chats (`connector/remove`); its files stay, and Undo brings it back. Your own
 * AI tool is only there while Laci shows its chats, so this removes it.
 */
function hideChats(tool: ToolCard) {
  const own = !tool.connector?.builtin;
  void run(
    async () => {
      changed(
        await api<Change>("connector/remove", { id: tool.id }),
        own ? said.ownRemoved(tool.name) : said.chatsHidden(tool.name),
        own ? said.ownRemovedNote : said.chatsHiddenNote,
      );
    },
    said.removing,
    { history: true },
  );
}

/** Opens Settings on its technical part, where your own AI tool is added. */
function addInSettings() {
  useHelpers.setState({ technical: true });
  useApp.getState().navigate("settings");
}

function Tools({ snapshot, chats }: { snapshot: Snapshot; chats: Conversation[] }) {
  const cards = toolCards(snapshot);
  const caps = useCapabilities(cards.filter((t) => t.launch).map((t) => t.provider));
  const statuses = useMcp((s) => s.statuses);
  const [using, setUsing] = useState<string | null>(null);
  const added = snapshot.connectors.map((c) => c.id).join(",");
  useEffect(() => {
    void loadMcp();
  }, [added]);
  return (
    <>
      {cards.length ? (
        <ul className="s-grid s-tools">
          {cards.map((tool) => (
            <li key={`${tool.connector ? "c" : "s"}:${tool.id}`}>
              <ToolCardView
                tool={tool}
                caps={caps[tool.provider]}
                status={statuses[tool.provider]}
                use={toolUse(chats, tool.provider)}
                onUseLaci={() => setUsing(tool.provider)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <p className="s-helpers-missing">
        {said.missingTool}{" "}
        <button type="button" className="s-link" onClick={addInSettings}>
          {said.addInSettings}
        </button>
      </p>
      {using ? <UseLaciSheet provider={using} onClose={() => setUsing(null)} /> : null}
    </>
  );
}

const INSTALL_TONE = { installed: "safe", "cant-start": "soon", missing: "fyi" } as const;

function ToolCardView({
  tool,
  caps,
  status,
  use,
  onUseLaci,
}: {
  tool: ToolCard;
  caps?: AgentCapabilities;
  status?: McpStatus;
  use: { chats: number; last?: string };
  onUseLaci: () => void;
}) {
  const historyPending = useApp((s) => s.historyPending);
  const install = installOf(tool, caps?.installed);
  const added = tool.connector;
  const canUse = added && tool.mcp ? canUseOf(status) : undefined;
  const start = startsWith(caps);
  const reads = added?.link.kind !== "none";
  return (
    <Card
      title={tool.name}
      icon="sparkles"
      className="s-tool"
      actions={added && !added.builtin ? <span className="s-tag">{said.yourOwn}</span> : null}
    >
      {install ? (
        <div className="s-tool-line">
          <StatusChip tone={INSTALL_TONE[install]}>{said.install[install]}</StatusChip>
          {install === "cant-start" ? <Info term="cant-start" /> : null}
        </div>
      ) : null}
      <div className="s-tool-line">
        {added && !added.builtin ? (
          // Not a box to untick: your own tool goes when Laci stops showing its chats.
          <>
            {reads ? (
              <>
                <span>{said.showingChats}</span>
                <Info term="showing-chats" />
              </>
            ) : null}
            <Button
              kind="text"
              small
              danger
              icon="trash-2"
              disabled={historyPending}
              onClick={() => hideChats(tool)}
            >
              {said.removeOwn}
              <span className="sr-only">{said.forTool(tool.name)}</span>
            </Button>
          </>
        ) : (
          <>
            <label className="s-helpers-check">
              <input
                type="checkbox"
                className="s-cb"
                checked={Boolean(added)}
                disabled={historyPending}
                onChange={() => (added ? hideChats(tool) : showChats(tool))}
              />
              <span>
                {said.showChats}
                <span className="sr-only">{said.forTool(tool.name)}</span>
              </span>
            </label>
            <Info term="showing-chats" />
          </>
        )}
      </div>
      {canUse ? (
        <div className="s-tool-line">
          <span>
            {said.canUse} <b>{said.canUseWords[canUse]}</b>
          </span>
          <Info term="can-use-laci" />
          <Button kind="outline" small onClick={onUseLaci}>
            {said.canUseAction[canUse]}
            <span className="sr-only">{said.forTool(tool.name)}</span>
          </Button>
        </div>
      ) : null}
      {added && tool.launch && caps ? (
        <p>
          {said.startsWith(start.model ?? "", start.effort ?? "")} <Info term="thinking" />
        </p>
      ) : null}
      <p className="s-quiet">
        {!added
          ? said.notAdded
          : !reads
            ? said.startOnly
            : use.chats
              ? said.toolChats(use.chats, ago(use.last))
              : said.noChats}
      </p>
      {added?.where || added?.command || tool.suggestion?.where ? (
        <Disclosure>
          <dl className="s-facts">
            {reads && (added?.where || tool.suggestion?.where) ? (
              <>
                <dt>{said.keepsChatsIn}</dt>
                <dd className="s-mono">{added?.where ?? tool.suggestion?.where}</dd>
              </>
            ) : null}
            {added?.command ? (
              <>
                <dt>{said.program}</dt>
                <dd className="s-mono">{added.command}</dd>
              </>
            ) : null}
            {added?.present && reads ? (
              <>
                <dt>{said.size}</dt>
                <dd>{bytes(added.bytes)}</dd>
              </>
            ) : null}
          </dl>
          {added && tool.launch && caps ? (
            <p className="s-quiet">{said.startsNote}</p>
          ) : null}
        </Disclosure>
      ) : null}
    </Card>
  );
}

/**
 * Lets an AI use Laci, or stops it, through the AI's own settings (`agent/mcp/apply`, as Detailed's
 * dialog does). "What exactly changes" shows the command Laci runs or what it adds to the file.
 */
function UseLaciSheet({ provider, onClose }: { provider: string; onClose: () => void }) {
  const status = useMcp((s) => s.statuses[provider]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!status) void loadMcp();
  }, [status]);
  const state = canUseOf(status);
  if (!status || !state)
    return (
      <Sheet
        title={said.useTitle["not-yet"](providerName(useApp.getState().snapshot, provider))}
        onClose={onClose}
        footer={
          <Button kind="text" onClick={onClose}>
            {blocks.close}
          </Button>
        }
      >
        <p className="s-working" role="status">
          <span className="s-spinner" aria-hidden="true" />
          {said.readingSettings(providerName(useApp.getState().snapshot, provider))}
        </p>
      </Sheet>
    );
  const { name } = status;
  // Laci makes the change through the AI's own program, which has to be there.
  const blocked = status.how === "command" && !status.installed;
  const apply = (remove: boolean) =>
    void run(
      async () => {
        setSaving(true);
        setError("");
        try {
          const result = await api<{ status: McpStatus }>("agent/mcp/apply", {
            provider,
            ...(remove ? { remove: true } : {}),
          });
          useMcp.setState((s) => ({
            statuses: { ...s.statuses, [provider]: result.status },
          }));
          toast(remove ? said.stopDone(name) : said.letDone(name));
          onClose();
        } finally {
          setSaving(false);
        }
      },
      remove ? said.stopping : said.letting,
      { onError: (failure) => setError(errorText(failure)) },
    );
  // What the button there does: the AI's own command, or what Laci writes in the AI's settings file.
  const what =
    status.how === "command"
      ? { text: said.runsCommand(name), code: state === "yes" ? status.remove : status.add }
      : state === "yes"
        ? { text: said.takesOut(status.file) }
        : { text: said.editsFile(status.file), code: status.snippet };
  return (
    <Sheet
      title={said.useTitle[state](name)}
      description={said.useIntro(name)}
      onClose={onClose}
      dismissible={!saving}
      footer={
        <>
          <Button kind="text" disabled={saving} onClick={onClose}>
            {state === "yes" ? blocks.close : blocks.cancel}
          </Button>
          {state !== "not-yet" ? (
            <Button kind="outline" disabled={saving || blocked} onClick={() => apply(true)}>
              {said.stopUsing}
            </Button>
          ) : null}
          {state !== "yes" ? (
            <Button
              kind="filled"
              disabled={saving || blocked}
              onClick={() => apply(false)}
            >
              {said.useAction[state]}
            </Button>
          ) : null}
        </>
      }
    >
      <p>{said.useState[state](name)}</p>
      {state === "other" && status.current ? (
        <p className="s-mono">{status.current}</p>
      ) : null}
      {blocked ? <Callout tone="soon">{said.useBlocked(status.command)}</Callout> : null}
      {error ? <Callout tone="act">{error}</Callout> : null}
      <Disclosure label={said.whatChanges} openLabel={said.whatChanges}>
        <p>{what.text}</p>
        {what.code ? (
          <>
            <pre className="s-code">{what.code}</pre>
            {/* For running it yourself, as the callout above suggests when Laci can't. */}
            <Button
              kind="text"
              small
              icon="copy"
              onClick={() => copyText(what.code ?? "", said.changeCopied, name)}
            >
              {said.copyChange}
            </Button>
          </>
        ) : null}
        <p className="s-quiet">{said.keepsCopy(status.file)}</p>
      </Disclosure>
    </Sheet>
  );
}
