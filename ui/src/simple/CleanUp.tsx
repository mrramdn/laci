// Clean up: what Laci suggests tidying, one suggestion at a time, and the space Laci uses itself
// (design-research §3.3). Each suggestion is made with the request Detailed's Tidy sends, and
// leftover AI chats are set aside, so Undo can bring them back. What deletes for good waits for the
// Countdown, and cancelling it sends nothing.
import "./cleanup-activity.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import { useNow } from "../clock";
import { Icon } from "../common";
import { base, bytes } from "../helpers";
import { changed, goToProject, run, toast, useApp } from "../store";
import type { Change, Storage, StoragePart } from "../types";
import { ago, blocks, cleanup as said, engineSays, listed, project } from "../words";
import { cleanupView, laciSpace } from "./model";
import type { CleanupItem, CleanupTile } from "./model";
import { focused, focusLost } from "./page-focus";
import { Steps } from "./steps";
import {
  Button,
  Callout,
  Countdown,
  Disclosure,
  EmptyState,
  Info,
  MoreMenu,
  StatusChip,
} from "./ui";
import type { MenuEntry, MenuItem } from "./ui";

const TILE_ICON: Record<CleanupTile, string> = {
  history: "link",
  space: "hard-drive",
  archive: "archive",
  leftover: "unlink",
  twice: "layers",
};

/** A change waiting for its Countdown: where it shows, what it says, and what it does at the end. */
interface Waiting {
  /** The suggestion's id, or "laci:" and the id of a part of the space Laci uses. */
  key: string;
  what: string;
  go: () => void;
}

/** A suggestion in Simple's words: its title, why it is offered, the ⓘ, and its button. */
interface Said {
  title: string;
  why: string;
  term?: string;
  /** The main button, when Laci can make the change. */
  button?: string;
  /** What the Countdown says before a change that deletes for good. */
  counting?: string;
  doing: string;
  done: string;
}

/** What a suggestion says. A kind this page doesn't know yet keeps the engine's words. */
function sayOf({ p, nodes, gone, bytes: size }: CleanupItem): Said {
  const name = nodes[0]?.label;
  switch (p.category) {
    case "reconnect":
      return {
        title: name ? said.reconnect.title(name) : said.reconnect.titleAny,
        why: !name
          ? said.reconnect.whyAny
          : p.confidence === "high"
            ? said.reconnect.why(name)
            : said.reconnect.unsure(name),
        term: "reconnect",
        button: said.reconnect.button,
        doing: said.reconnect.doing,
        done: said.reconnect.done,
      };
    case "migration": {
      const moves = Math.max(1, p.ops.length);
      return {
        title: said.migration.title(moves),
        why: said.migration.why,
        term: "reconnect",
        button: said.migration.button(moves),
        doing: said.migration.doing,
        done: said.migration.done,
      };
    }
    case "space": {
      const amount = size ? bytes(size) : "";
      const where =
        nodes.length > 3
          ? said.space.projects(nodes.length)
          : listed(nodes.map((n) => n.label));
      return {
        title:
          amount && where ? said.space.title(amount, where) : said.space.titleAny,
        why: said.space.why,
        term: "packages",
        button: amount ? said.space.button(amount) : said.space.buttonAny,
        counting: amount ? said.space.counting(amount) : said.space.countingAny,
        doing: amount ? said.space.doing(amount) : said.space.doingAny,
        done: amount ? said.space.done(amount) : said.space.doneAny,
      };
    }
    case "status": {
      const n = nodes[0];
      const when = !n
        ? ""
        : n.lastActivity
          ? said.archive.why(n.label, ago(n.lastActivity.at))
          : said.archive.never(n.label);
      return {
        title: n ? said.archive.title(n.label) : said.archive.titleAny,
        why: when ? `${when} ${said.archive.what}` : said.archive.what,
        term: "archive",
        button: n ? said.archive.button(n.label) : said.archive.buttonAny,
        doing: "",
        done: "",
      };
    }
    case "orphan": {
      if (p.blocked)
        return {
          title: said.leftover.blockedTitle,
          why: said.leftover.blocked,
          term: "leftover",
          doing: "",
          done: "",
        };
      const names = listed(gone);
      return {
        title: names ? said.leftover.title(names) : said.leftover.titleAny,
        why: `${names ? said.leftover.why(names, gone.length) : said.leftover.whyAny} ${said.leftover.aside}`,
        term: "leftover",
        button: said.leftover.button,
        doing: said.leftover.doing,
        done: said.leftover.done,
      };
    }
    case "duplicate": {
      const twin = nodes[0]?.name ?? (p.ops[0] ? base(p.ops[0].label) : "");
      return {
        title: twin ? said.twice.title(twin, p.ops.length) : said.twice.titleAny,
        why: said.twice.why,
        term: "same-twice",
        doing: "",
        done: "",
      };
    }
    default:
      return { title: p.title, why: p.why, doing: "", done: "" };
  }
}

/**
 * Makes the change a suggestion offers, with the request Detailed's Tidy sends. Leftover AI chats go
 * to Kept for Undo, or with `trash` to the Trash. Archiving opens the archive dialog instead, which
 * shows what will happen first. True once the change is made.
 */
async function apply(item: CleanupItem, words: Said, trash = false) {
  const { p } = item;
  if (p.action?.type === "archive") {
    useApp.setState({ modal: { kind: "archive", id: p.action.nodeId } });
    return false;
  }
  const made = await run(
    async () => {
      const change = await api<Change>("apply", {
        id: p.id,
        ...(p.category === "orphan"
          ? { recovery: trash ? "trash" : "quarantine" }
          : {}),
      });
      // The toast names the projects; for what Undo can't take back, the engine says instead how
      // to get it back.
      changed(
        change,
        trash ? said.leftover.trashDone : words.done,
        item.undoable && !trash ? item.nodes.map((n) => n.label).join(", ") : "",
      );
      return true;
    },
    trash ? said.leftover.trashDoing : words.doing,
    { history: true },
  );
  return made === true;
}

/** Hides a suggestion for 90 days, or with `again` offers a hidden one again: Detailed's Dismiss. */
function hide(id: string, again = false) {
  return run(async () => {
    await api("proposal/dismiss", { id, ...(again ? { undo: true } : {}) });
    if (again) toast(said.suggestedAgain);
    else toast(said.hidden, said.hiddenNote);
  });
}

/**
 * The space Laci uses (the `storage` request), asked for when the page opens and again once a change
 * is in: setting AI chats aside, emptying Kept for Undo and an Undo each end when the history has
 * been read again. A scan alone changes none of it, so it asks nothing then.
 */
function useLaciSpace() {
  const settled = useApp((s) => !s.historyPending);
  const [state, setState] = useState<{ storage?: Storage; error?: string }>({});
  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    try {
      const storage = await api<Storage>("storage");
      if (mine === asked.current) setState({ storage });
    } catch (error) {
      if (mine === asked.current)
        setState((old) => ({ storage: old.storage, error: errorText(error) }));
    }
  }, []);
  useEffect(() => {
    if (settled) void load();
  }, [load, settled]);
  return { ...state, load };
}

export function CleanUp() {
  const snapshot = useApp((s) => s.snapshot!);
  const pending = useApp((s) => s.historyPending);
  // While the window waits for a change or is covered, nothing in it can take the focus.
  const covered = useApp((s) =>
    Boolean(s.working || s.modal || s.palette || s.sheets),
  );
  useNow();
  const view = useMemo(() => cleanupView(snapshot), [snapshot]);
  const space = useLaciSpace();
  const parts = useMemo(
    () => (space.storage ? laciSpace(space.storage) : null),
    [space.storage],
  );
  /** The card the user opened. Until they choose, the first opens; null closes them all. */
  const [choice, setChoice] = useState<string | null>();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [, redraw] = useState(0);
  const has = (id: string) => view.items.some((item) => item.p.id === id);
  const open =
    choice === null ? null : choice && has(choice) ? choice : (view.first ?? null);
  // A Countdown runs only while what it is for is on screen (its card open, its part still there)
  // with nothing over the window or running, so it never runs out unseen; and while Laci isn't
  // reading the history again, which the engine waits for before any change. Otherwise it stops,
  // sending nothing, and says so.
  const live =
    waiting &&
    !covered &&
    !pending &&
    (waiting.key.startsWith("laci:")
      ? parts?.parts.some(
          (part) => `laci:${part.id}` === waiting.key && part.free > 0,
        )
      : waiting.key === open)
      ? waiting
      : null;
  useEffect(() => {
    if (!waiting || live) return;
    setWaiting(null);
    toast(blocks.cancelled);
  }, [waiting, live]);

  // The focus, for the keyboard: back to the button a cancelled Countdown or a failed change came
  // from, and once a change took its card away, on to the card that opens next.
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const listHeading = useRef<HTMLHeadingElement>(null);
  const spaceHeading = useRef<HTMLHeadingElement>(null);
  const startedFrom = useRef<HTMLElement | null>(null);
  const focusBack = useRef<HTMLElement | null>(null);
  const after = useRef<string | null>(null);
  useEffect(() => {
    if (covered || pending) return;
    const back = focusBack.current;
    focusBack.current = null;
    const card = after.current;
    const gone = card !== null && !has(card);
    if (gone) after.current = null;
    if (!focusLost()) return;
    const next = gone
      ? (open ? toggles.current.get(open) : null) ?? listHeading.current
      : null;
    (back?.isConnected ? back : next)?.focus();
  });
  const focusAfter = (element: HTMLElement | null) => {
    focusBack.current = element;
    redraw((n) => n + 1);
  };

  /** Starts the Countdown for `key`. Cancelled, the focus goes back to where it was. */
  const count = (key: string, what: string, go: () => void) => {
    startedFrom.current = focused();
    setWaiting({ key, what, go });
  };
  const done = () => {
    const go = live?.go;
    setWaiting(null);
    go?.();
  };
  const cancel = () => {
    focusBack.current = startedFrom.current;
    setWaiting(null);
    toast(blocks.cancelled);
  };
  const make = (
    item: CleanupItem,
    trash = false,
    from: HTMLElement | null = focused(),
  ) => {
    // The archive dialog gives the focus back itself, or to the page once the card has gone.
    if (item.p.action?.type === "archive") after.current = item.p.id;
    void apply(item, sayOf(item), trash).then((made) => {
      if (made) {
        after.current = item.p.id;
        redraw((n) => n + 1);
      } else if (item.p.action?.type !== "archive") focusAfter(from);
    });
  };
  // The engine refuses to empty a part while it reads the history again, as it does any change to it.
  const free = (part: StoragePart, label: string) => {
    const from = startedFrom.current;
    void run(
      async () => {
        const result = await api<{ freed?: number }>("storage/free", {
          part: part.id,
        });
        toast(said.laci.freed(bytes(result.freed ?? part.free)), label);
        await space.load();
        return true;
      },
      `${said.laci.parts[part.id]?.counting ?? said.space.countingAny}…`,
      { history: true },
    ).then((made) => focusAfter(made ? spaceHeading.current : from));
  };

  const could = view.bytes + (parts?.free ?? 0);
  return (
    <div className="s-page s-cleanup">
      <header className="s-head s-head-row">
        <div>
          <h1>{said.title}</h1>
          <p className="s-lead">{said.lead}</p>
        </div>
        {could ? (
          <p className="s-cleanup-free">
            <Icon name="hard-drive" />
            {said.couldFree(bytes(could))}
          </p>
        ) : null}
      </header>
      <ul className="s-tiles" aria-label={said.tilesLabel}>
        {view.tiles.map((tile) => (
          <li key={tile.tile}>
            <button
              type="button"
              className="s-tile"
              data-ui="tile"
              onClick={() => {
                setChoice(tile.first);
                toggles.current.get(tile.first)?.focus();
              }}
            >
              <Icon name={TILE_ICON[tile.tile]} />
              <b>{said.tiles[tile.tile]}</b>
              <span>
                {tile.bytes ? bytes(tile.bytes) : said.tileCount(tile.count)}
              </span>
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="s-tile"
            data-ui="tile"
            onClick={() => spaceHeading.current?.focus()}
          >
            <Icon name="inbox" />
            <b>{said.tiles.laci}</b>
            <span>
              {!space.storage
                ? said.tileReading
                : space.storage.total
                  ? bytes(space.storage.total)
                  : said.laci.none}
            </span>
          </button>
        </li>
      </ul>
      <section className="s-section" aria-labelledby="cleanup-list">
        <div className="s-section-head">
          <h2 id="cleanup-list" ref={listHeading} tabIndex={-1}>
            {said.suggestions}
          </h2>
        </div>
        {pending ? (
          <p className="s-working" role="status">
            <span className="s-spinner" aria-hidden="true" />
            {said.checking}
          </p>
        ) : view.items.length ? (
          <ul className="s-sugs">
            {view.items.map((item) => (
              <Suggestion
                key={item.p.id}
                item={item}
                open={item.p.id === open}
                waiting={live?.key === item.p.id ? live : null}
                counting={Boolean(live)}
                toggleRef={(element) => {
                  if (element) toggles.current.set(item.p.id, element);
                  else toggles.current.delete(item.p.id);
                }}
                onToggle={() => setChoice(item.p.id === open ? null : item.p.id)}
                onMake={() => make(item)}
                onCount={(what, trash) =>
                  count(item.p.id, what, () =>
                    make(item, trash, startedFrom.current),
                  )
                }
                onDone={done}
                onCancel={cancel}
                onHide={() => {
                  after.current = item.p.id;
                  void hide(item.p.id);
                }}
              />
            ))}
          </ul>
        ) : (
          <EmptyState art="nothing-to-clean" title={said.emptyTitle} level={3}>
            {said.emptyBody}
          </EmptyState>
        )}
        {snapshot.dismissed?.length ? (
          <Disclosure
            label={said.hiddenList(snapshot.dismissed.length)}
            openLabel={said.hiddenList(snapshot.dismissed.length)}
          >
            <ul className="s-files">
              {snapshot.dismissed.map((d) => (
                <li key={d.id} className="s-hidden-warning">
                  <span>{d.title}</span>
                  <Button
                    kind="text"
                    small
                    aria-label={said.suggestAgainFor(d.title)}
                    onClick={() => void hide(d.id, true)}
                  >
                    {said.suggestAgain}
                  </Button>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </section>
      <section className="s-section s-space" aria-labelledby="cleanup-space">
        <div className="s-section-head">
          <h2 id="cleanup-space" ref={spaceHeading} tabIndex={-1}>
            {said.laci.title}
          </h2>
          {space.storage ? (
            <span className="s-quiet">
              {(space.storage.parts.some((part) => part.elsewhere)
                ? said.laci.totalOwn
                : said.laci.total)(
                space.storage.total ? bytes(space.storage.total) : said.laci.none,
              )}
            </span>
          ) : null}
        </div>
        <div className="s-card">
          {!space.storage || !parts ? (
            space.error ? (
              <div className="s-space-failed">
                <Callout tone="soon">{said.laci.failed}</Callout>
                <p className="s-quiet">{space.error}</p>
                <Button
                  kind="outline"
                  small
                  icon="refresh-cw"
                  onClick={() => void space.load()}
                >
                  {said.laci.tryAgain}
                </Button>
              </div>
            ) : (
              <p className="s-working" role="status">
                <span className="s-spinner" aria-hidden="true" />
                {said.laci.reading}
              </p>
            )
          ) : (
            <>
              <ul className="s-space-list">
                {parts.parts.map((part) => {
                  const key = `laci:${part.id}`;
                  const words = said.laci.parts[part.id];
                  return (
                    <SpacePart
                      key={part.id}
                      part={part}
                      waiting={live?.key === key ? live : null}
                      counting={Boolean(live)}
                      pending={pending}
                      onCount={() =>
                        count(
                          key,
                          `${words?.counting ?? said.space.countingAny} (${bytes(part.free)})`,
                          () => free(part, words?.label ?? part.label),
                        )
                      }
                      onDone={done}
                      onCancel={cancel}
                    />
                  );
                })}
              </ul>
              <Disclosure>
                <dl className="s-facts">
                  <dt>{said.laci.where}</dt>
                  <dd className="s-mono">{space.storage.dir}</dd>
                </dl>
              </Disclosure>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * One suggestion. Closed, it is a row to review that says whether Undo can take it back; open, it says
 * why, how sure Laci is and what will change, with its button. Only the open card's button can be the
 * screen's filled one, and only for a change Undo can take back. A blocked one says why and offers
 * nothing; one with nothing to apply (the same project twice) offers to open each copy.
 */
function Suggestion({
  item,
  open,
  waiting,
  counting,
  toggleRef,
  onToggle,
  onMake,
  onCount,
  onDone,
  onCancel,
  onHide,
}: {
  item: CleanupItem;
  open: boolean;
  /** This card's Countdown, while it runs. */
  waiting: Waiting | null;
  /** A Countdown runs somewhere: nothing else that deletes for good can start. */
  counting: boolean;
  toggleRef: (element: HTMLButtonElement | null) => void;
  onToggle: () => void;
  onMake: () => void;
  /** Starts the Countdown before a change that can't be undone; `trash` sends leftovers to the Trash. */
  onCount: (what: string, trash: boolean) => void;
  onDone: () => void;
  onCancel: () => void;
  onHide: () => void;
}) {
  const body = useId();
  const words = sayOf(item);
  const { p, ready, undoable } = item;
  const badge = !ready ? (
    <StatusChip tone="fyi">{said.leftAlone}</StatusChip>
  ) : undoable ? (
    <StatusChip tone="safe">{said.canUndo}</StatusChip>
  ) : (
    <StatusChip tone="soon">{said.forGood}</StatusChip>
  );
  const sure = p.blocked ? undefined : said.sure[p.confidence];
  // With nothing to apply, opening each copy is all there is to do, so those buttons show.
  const opens = !p.action && !p.blocked;
  const archives = p.action?.type === "archive" ? item.nodes[0] : undefined;
  const groups: MenuItem[][] = [
    opens
      ? []
      : item.nodes.map((n) => ({
          label: said.open(n.label),
          icon: "folder-open",
          onSelect: () => goToProject(n.id),
        })),
    ready && p.category === "orphan"
      ? [
          {
            label: said.leftover.trash,
            icon: "trash-2",
            danger: true,
            disabled: counting,
            onSelect: () => onCount(said.leftover.trashCounting, true),
          },
        ]
      : [],
    // As Tidy offers the Trash beside Archive: the dialog still leads with archiving.
    archives
      ? [
          {
            label: project.delete,
            icon: "trash-2",
            danger: true,
            onSelect: () =>
              useApp.setState({ modal: { kind: "delete", id: archives.id } }),
          },
        ]
      : [],
  ];
  const menu = groups
    .filter((group) => group.length)
    .flatMap((group, i): MenuEntry[] => (i ? ["-", ...group] : group));
  return (
    <li
      className="s-sug"
      data-ui="suggestion"
      data-open={open ? "" : undefined}
    >
      <h3 className="s-sug-head">
        <button
          ref={toggleRef}
          type="button"
          className="s-sug-toggle"
          aria-expanded={open}
          aria-controls={open ? body : undefined}
          onClick={onToggle}
        >
          <Icon name={TILE_ICON[item.tile]} />
          <span className="s-sug-title">{words.title}</span>
          {open ? null : (
            <>
              {badge}
              <span className="s-sug-review">{said.review}</span>
            </>
          )}
        </button>
      </h3>
      {open ? (
        <>
          <div className="s-sug-chips">
            {badge}
            {sure ? (
              <span className="s-tag-with-info">
                <span className="s-tag">{sure}</span>
                <Info term="sure" />
              </span>
            ) : null}
          </div>
          <div id={body} className="s-sug-body">
            <p>
              {words.why} {words.term ? <Info term={words.term} /> : null}
            </p>
            {p.blocked ? (
              p.reason ? (
                <Disclosure>
                  <p className="s-mono">{p.reason}</p>
                </Disclosure>
              ) : null
            ) : p.ops.length ? (
              <Disclosure
                label={ready ? said.whatChanges : blocks.showDetails}
                openLabel={ready ? said.whatChanges : blocks.hideDetails}
              >
                <Steps ops={p.ops} />
              </Disclosure>
            ) : null}
            {waiting ? (
              <Countdown what={waiting.what} onDone={onDone} onCancel={onCancel} />
            ) : null}
            {p.blocked ? null : (
              <div className="s-actions s-sug-actions" hidden={Boolean(waiting)}>
                {ready && words.button ? (
                  <Button
                    // Filled only for a change Undo can take back: what deletes for good never is.
                    kind={undoable ? "filled" : "outline"}
                    icon={undoable ? undefined : "trash-2"}
                    disabled={!undoable && counting}
                    onClick={() =>
                      undoable
                        ? onMake()
                        : onCount(words.counting ?? words.title, false)
                    }
                  >
                    {words.button}
                  </Button>
                ) : null}
                {opens
                  ? item.nodes.map((n) => (
                      <Button
                        key={n.id}
                        kind="outline"
                        icon="folder-open"
                        onClick={() => goToProject(n.id)}
                      >
                        {said.open(n.label)}
                      </Button>
                    ))
                  : null}
                {menu.length ? (
                  <MoreMenu label={said.moreFor(words.title)} items={menu} />
                ) : null}
                <Button kind="text" className="s-sug-hide" onClick={onHide}>
                  {said.hide}
                </Button>
              </div>
            )}
          </div>
        </>
      ) : null}
    </li>
  );
}

/** A part of the space Laci uses: what it is, its size, and for a part Laci can empty, the button. */
function SpacePart({
  part,
  waiting,
  counting,
  pending,
  onCount,
  onDone,
  onCancel,
}: {
  part: StoragePart;
  waiting: Waiting | null;
  /** A Countdown runs somewhere: nothing else that deletes for good can start. */
  counting: boolean;
  /** Laci reads the history again after a change, and refuses to empty anything meanwhile. */
  pending: boolean;
  onCount: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const words = said.laci.parts[part.id];
  return (
    <li className="s-space-row" data-ui="space-part" data-id={part.id}>
      <div className="s-space-text">
        <span className="s-space-name">
          <b>{words?.label ?? part.label}</b>
          {words?.term ? <Info term={words.term} /> : null}
        </span>
        <span className="s-quiet">{words?.about ?? part.about}</span>
        {part.dir ? <span className="s-quiet s-mono">{said.laci.keptIn(part.dir)}</span> : null}
        {part.error ? <Callout tone="soon">{engineSays(part.error, "simple")}</Callout> : null}
      </div>
      <span className="s-space-size">
        {part.bytes ? bytes(part.bytes) : said.laci.none}
      </span>
      {part.free > 0 ? (
        <div className="s-space-free">
          {waiting ? (
            <Countdown what={waiting.what} onDone={onDone} onCancel={onCancel} />
          ) : null}
          <div className="s-actions" hidden={Boolean(waiting)}>
            <Button
              kind="outline"
              small
              icon="trash-2"
              disabled={counting || pending}
              onClick={onCount}
            >
              {words?.button ?? said.space.button(bytes(part.free))}
            </Button>
            <span className="s-quiet">{said.laci.freeable(bytes(part.free))}</span>
          </div>
        </div>
      ) : null}
    </li>
  );
}
