// Simple's own Delete, Archive and Free up space sheets (design-research §3.7). Archive comes
// before the system's bin, a destructive button is never the filled one, and what can't be undone
// waits for a Countdown that asks nothing of the engine until it runs out. They send the requests
// Detailed's dialogs send, through run() and changed(), so the toast and its Undo are the same in
// both designs. Detailed keeps its own dialogs in ../dialogs.tsx, which leaves these three to
// Simple.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, Ref, SetStateAction } from "react";
import { api, errorText } from "../api";
import { restoreFocus } from "../common";
import { bytes, expandHome, isAbsolutePath, RISK, tilde } from "../helpers";
import { OS } from "../platform";
import { changed, run, selectWhenReady, useApp } from "../store";
import type { Modal } from "../store";
import type { ArchivePlan, Change, DeletePlan, Issue, Node, Op } from "../types";
import { blocks, dialogs as said, fix, project, safety } from "../words";
import { fixable, issueCount, safetyIssues, toneOf } from "./model";
import { openFix } from "./state";
import { Button, Callout, Countdown, Disclosure, Sheet, StatusChip } from "./ui";

type Kind = "delete" | "archive" | "clean";
const KINDS: readonly string[] = ["delete", "archive", "clean"];
/** Whether `modal` is one of the three sheets drawn here. */
const isOwn = (modal: Modal): modal is { kind: Kind; id: string } =>
  Boolean(modal && KINDS.includes(modal.kind));

function close() {
  useApp.setState({ modal: null });
}

/** Where a sheet is: its choices, a Countdown before what can't be undone, or the request sent. */
type Stage = "choose" | "count" | "send";

interface Body {
  node: Node;
  stage: Stage;
  setStage: Dispatch<SetStateAction<Stage>>;
  /** What had the focus when the sheet opened. */
  opener: HTMLElement | null;
}

const RANK: Record<Issue["severity"], number> = { high: 0, med: 1, low: 2 };
const worstFirst = (a: Issue, b: Issue) => RANK[a.severity] - RANK[b.severity];

/** How many of the files only this computer has Delete names; Show details names every one. */
const SHOWN = 8;

/**
 * The sheet for the modal that is open, when it is one of these three. It goes with its project
 * (moved, deleted, gone from the folders): the window behind waits while a modal is set.
 */
export function SimpleDialogs() {
  const modal = useApp((s) => s.modal);
  const own = isOwn(modal) ? modal : null;
  const node = useApp((s) => (own ? s.snapshot?.nodes[own.id] : undefined));
  const gone = Boolean(own && !node);
  useEffect(() => {
    if (gone) close();
  }, [gone]);
  if (!own || !node) return null;
  return <ProjectSheet key={node.id} kind={own.kind} node={node} />;
}

/**
 * One sheet for a project. Delete turns into Archive ("Archive instead") without closing, so the
 * focus still goes back to what opened it when it closes.
 */
function ProjectSheet({ kind, node }: { kind: Kind; node: Node }) {
  const [stage, setStage] = useState<Stage>("choose");
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const working = useApp((s) => Boolean(s.working));
  const cancel = useRef<HTMLButtonElement>(null);
  // Where the focus starts, once the sheet has put it on its first control. Before what can't be
  // undone it starts on Cancel: Free up space, and Delete when there is no Archive instead (the
  // project is archived already). Archive has no way on until its plan is in, so the sheet itself
  // holds the focus until then.
  useLayoutEffect(() => {
    if (kind === "clean" || (kind === "delete" && node.archived)) cancel.current?.focus();
    else if (kind === "archive")
      cancel.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
    // Only when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const body = { node, stage, setStage, opener };
  return (
    <Sheet
      title={said[kind].title(node.label)}
      // A project in the archive already has no Archive instead to recommend.
      description={kind === "delete" && node.archived ? said.delete.introArchived : said[kind].intro}
      onClose={close}
      // While a Countdown runs, its own Cancel is the one to use.
      footer={
        stage === "choose" ? (
          <Button kind="text" ref={cancel} disabled={working} onClick={close}>
            {blocks.cancel}
          </Button>
        ) : undefined
      }
    >
      {kind === "delete" ? (
        <DeleteBody {...body} />
      ) : kind === "archive" ? (
        <ArchiveBody {...body} />
      ) : (
        <CleanBody {...body} />
      )}
    </Sheet>
  );
}

// --- Delete --------------------------------------------------------------------------------------

/**
 * Delete: Archive instead is the filled button, and the system's bin waits for the engine's plan.
 * When files only this computer has would go with the folder, the user types the project's name
 * first; then the Countdown runs, and only its end sends the request.
 */
function DeleteBody({ node, stage, setStage }: Body) {
  const home = useApp((s) => s.snapshot!.home);
  const historyPending = useApp((s) => s.historyPending);
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [failure, setFailure] = useState<{
    during: "check" | "move";
    text: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const heading = useId();
  const noteId = useId();
  const aboutId = useId();
  const insteadId = useId();
  const trash = useRef<HTMLButtonElement>(null);
  const again = useRef<HTMLButtonElement>(null);
  /** Back from a Countdown or a request: the focus returns to the button that started it. */
  const back = useRef(false);
  // The plan asks the online copy, which can take a while: once, and again on Check again. The
  // engine checks again before it moves anything, so a plan that grew old can't let it through.
  useEffect(() => {
    let live = true;
    void api<DeletePlan>("delete/plan", { id: node.id }).then(
      (next) => {
        if (live) setPlan(next);
      },
      (error) => {
        if (live) setFailure({ during: "check", text: errorText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [node.id, attempt]);
  useLayoutEffect(() => {
    if (stage !== "choose" || !back.current) return;
    back.current = false;
    (trash.current && !trash.current.disabled ? trash.current : again.current)?.focus();
  }, [stage]);
  const files = plan?.unbacked.files ?? [];
  const more = plan?.unbacked.more ?? 0;
  const unbacked = files.length + more > 0;
  const unnamed = Math.max(0, files.length - SHOWN) + more;
  const allowed = Boolean(plan?.allowed) && !failure;
  const named = !unbacked || typed.trim() === node.name;
  const ready = allowed && named && !historyPending;
  const blocked = plan && !plan.allowed;
  const reason = blocked
    ? (plan.checks.find((check) => check.code === "delete-blocked") ?? plan.checks[0])?.detail
    : undefined;
  // What the bin's button says beside it: why it waits, or what it can't take back.
  const about =
    (plan || failure) && !allowed
      ? said.delete.notYet
      : [named ? "" : said.delete.typeFirst, said.delete.trashNote, said.restoreSteps(OS)]
          .filter(Boolean)
          .join(" ");
  const risks = safetyIssues(node).filter((issue) => RISK.has(issue.code));
  const failed = failure
    ? failure.during === "check"
      ? said.delete.checkFailed(node.label)
      : said.delete.moveFailed(node.label)
    : "";
  const checkAgain = () => {
    setPlan(null);
    setFailure(null);
    setNote("");
    setAttempt((n) => n + 1);
  };
  const count = () => {
    if (!ready) return;
    setNote("");
    setStage("count");
  };
  const cancelled = () => {
    back.current = true;
    setNote(blocks.cancelled);
    setStage("choose");
  };
  const remove = async () => {
    back.current = true;
    setStage("send");
    let ran = false;
    await run(
      async () => {
        ran = true;
        const modal = useApp.getState().modal;
        const change = await api<Change>("delete", { id: node.id, confirm: true });
        if (useApp.getState().modal === modal) close();
        changed(change, said.delete.moved(node.label), said.restoreSteps(OS));
        leave(node.id);
      },
      said.delete.moving(node.label),
      {
        history: true,
        onError: (error) => {
          setPlan(null);
          setFailure({ during: "move", text: errorText(error) });
          setStage("choose");
        },
      },
    );
    // Another change was still running when the Countdown ended: nothing was sent.
    if (!ran) {
      setNote(said.busy);
      setStage("choose");
    }
  };
  return (
    <>
      <section
        className="s-fix-secrets"
        aria-labelledby={heading}
        aria-busy={!plan && !failure}
      >
        <h3 id={heading}>{said.delete.lost}</h3>
        {failure ? (
          <>
            <Callout tone="soon">{failed}</Callout>
            <CheckAgain ref={again} disabled={historyPending} onClick={checkAgain} />
          </>
        ) : !plan ? (
          <Working text={said.delete.checking} status />
        ) : blocked ? (
          <>
            <Callout tone="soon">{said.delete.blocked(node.label)}</Callout>
            <p>{node.git ? said.delete.blockedWhy : said.delete.noHistory}</p>
            <Problems node={node} issues={risks} />
            <CheckAgain ref={again} disabled={historyPending} onClick={checkAgain} />
          </>
        ) : unbacked ? (
          <div className="s-fix-found">
            <Callout tone="soon">{said.delete.onlyHere}</Callout>
            <FileList files={files.slice(0, SHOWN)} more={unnamed} />
          </div>
        ) : (
          <Callout tone="safe">{said.delete.allSaved}</Callout>
        )}
      </section>
      <Announce text={failed} />
      {stage === "count" ? (
        <Countdown
          what={said.delete.counting(node.label)}
          onDone={() => void remove()}
          onCancel={cancelled}
        />
      ) : stage === "send" ? (
        <Working text={said.delete.moving(node.label)} />
      ) : (
        // Enter in the name starts the Countdown too, once the name is right.
        <form
          className="s-choices"
          onSubmit={(event) => {
            event.preventDefault();
            count();
          }}
        >
          {node.archived ? null : (
            <div className="s-choice">
              <Button
                kind="filled"
                icon="archive"
                aria-describedby={insteadId}
                onClick={() => useApp.setState({ modal: { kind: "archive", id: node.id } })}
              >
                {said.delete.archiveInstead}
              </Button>
              <p id={insteadId} className="s-quiet">
                <span className="s-tag s-tag-brand">{fix.recommended}</span>{" "}
                {said.delete.archiveNote(node.label)}
              </p>
            </div>
          )}
          {allowed && unbacked ? (
            <label className="s-field">
              <span>{said.delete.typeName(node.name)}</span>
              <input
                className="s-input"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
          ) : null}
          <div className="s-choice">
            <Button
              kind="outline"
              type="submit"
              danger
              icon="trash-2"
              ref={trash}
              disabled={!ready}
              aria-describedby={note ? `${noteId} ${aboutId}` : aboutId}
            >
              {said.delete.trash}
            </Button>
            {note ? <p id={noteId}>{note}</p> : null}
            <p id={aboutId} className="s-quiet">
              {about}
            </p>
          </div>
        </form>
      )}
      <Disclosure>
        <dl className="s-facts">
          <Found text={failure?.text ?? reason} />
          {files.length > SHOWN ? (
            <>
              <dt>{said.details.onlyHere}</dt>
              <dd>
                <FileList files={files} more={more} />
              </dd>
            </>
          ) : null}
          <dt>{said.details.location}</dt>
          <dd className="s-mono">{tilde(node.path, home)}</dd>
          <Steps ops={plan?.ops} home={home} />
        </dl>
      </Disclosure>
    </>
  );
}

/** After a project went to the system's bin: it isn't selected, and its page gives way to Projects. */
function leave(id: string) {
  const state = useApp.getState();
  if (state.selected !== id) return;
  useApp.setState({ selected: null, pendingSelection: null });
  if (state.view === "project") state.navigate("folder");
}

// --- Archive -------------------------------------------------------------------------------------

/**
 * Archive: what the engine's plan and the project's own checks say about its safety, then the way
 * on. A project that isn't safe gets "Back up first" (the fix sheet for its worst problem) as the
 * filled button, and "Archive anyway" beside it. Where it goes can be changed under Show details,
 * as in Detailed.
 */
function ArchiveBody({ node, stage, setStage, opener }: Body) {
  const home = useApp((s) => s.snapshot!.home);
  const historyPending = useApp((s) => s.historyPending);
  const [destination, setDestination] = useState(() =>
    node.archivePlan?.dest ? tilde(node.archivePlan.dest, home) : "",
  );
  const [review, setReview] = useState<{
    destination: string;
    plan?: ArchivePlan;
    error?: string;
  } | null>(null);
  /** The last plan that could be carried out: its checks stay while another place is looked at. */
  const [last, setLast] = useState<ArchivePlan | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState("");
  const [note, setNote] = useState("");
  const edited = useRef(false);
  const heading = useId();
  const noteId = useId();
  const backId = useId();
  const aboutId = useId();
  const field = useId();
  const backUp = useRef<HTMLButtonElement>(null);
  const go = useRef<HTMLButtonElement>(null);
  const again = useRef<HTMLButtonElement>(null);
  /** Back from a request: the focus returns to the button that started it. */
  const back = useRef(false);
  const sending = stage === "send";
  // The plan is asked for again when the project changes (a version saved or uploaded meanwhile)
  // and when an archive that failed comes back, and a place being typed is looked at once the
  // typing stops. Not while the archive itself runs.
  useEffect(() => {
    if (sending) return;
    let live = true;
    const timer = setTimeout(
      () => {
        const path = expandHome(destination.trim(), home);
        if (path && !isAbsolutePath(path)) {
          setReview({ destination, error: said.archive.fullPath });
          return;
        }
        void api<ArchivePlan>("archive/plan", {
          id: node.id,
          ...(path ? { destination: path } : {}),
        }).then(
          (plan) => {
            if (!live) return;
            setReview({ destination, plan, error: plan.error });
            if (!plan.error) setLast(plan);
          },
          (error) => {
            if (live) setReview({ destination, error: errorText(error) });
          },
        );
      },
      edited.current ? 200 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [node, destination, home, attempt, sending]);
  const current = review?.destination === destination ? review : null;
  const plan = current?.plan && !current.error ? current.plan : undefined;
  const checks = (plan ?? last)?.checks;
  // The plan's checks, and the problems of the project's own that the plan leaves out (out of
  // sync, no version history): what its "Is it safe?" card warns about is never called safe here.
  const issues = checks && [
    ...checks,
    ...node.issues.filter(
      (issue) => RISK.has(issue.code) && !checks.some((check) => check.code === issue.code),
    ),
  ];
  // A warning the user hid doesn't hold the archive up; Show details lists it.
  const warnings = (issues ?? []).filter((issue) => !issue.muted).sort(worstFirst);
  const hidden = (issues ?? []).filter((issue) => issue.muted);
  const first = warnings.find((issue) => fixable(issue.code));
  const problem = failure || current?.error || "";
  const remote = node.git?.remotes[0];
  // The focus goes on to the filled button once the plan has drawn one, if it is still where the
  // sheet put it: on the sheet itself, or on the page when Delete turned into Archive and its
  // button went.
  const shown = Boolean(checks);
  useLayoutEffect(() => {
    const at = document.activeElement;
    if (shown && (!at || at === document.body || at.getAttribute("role") === "dialog"))
      (backUp.current ?? go.current)?.focus();
  }, [shown]);
  useLayoutEffect(() => {
    if (stage !== "choose" || !back.current) return;
    back.current = false;
    (go.current && !go.current.disabled ? go.current : again.current)?.focus();
  }, [stage]);
  const checkAgain = () => {
    setReview(null);
    setFailure("");
    setNote("");
    setAttempt((n) => n + 1);
  };
  const backUpFirst = (code: string) => {
    close();
    // The fix sheet opens once this one is gone and the window is back, from what opened this one,
    // so that closing it brings the focus back there.
    setTimeout(() => {
      restoreFocus(opener);
      openFix(node.id, code);
    });
  };
  const archive = async () => {
    if (!plan) return;
    back.current = true;
    setFailure("");
    setNote("");
    setStage("send");
    let ran = false;
    await run(
      async () => {
        ran = true;
        const modal = useApp.getState().modal;
        const change = await api<Change>("archive", {
          id: node.id,
          destination: plan.dest,
          trashHeavy: false,
        });
        if (useApp.getState().modal === modal) close();
        changed(change, said.archive.archived(node.label), said.archive.archivedNote);
        selectWhenReady(plan.dest);
      },
      said.archive.archiving(node.label),
      {
        history: true,
        onError: (error) => {
          setFailure(errorText(error));
          setStage("choose");
        },
      },
    );
    if (!ran) {
      setNote(said.busy);
      setStage("choose");
    }
  };
  const worst = first ? safety.issues[first.code] : undefined;
  return (
    <>
      <section
        className="s-fix-secrets"
        aria-labelledby={heading}
        aria-busy={!checks && !problem}
      >
        <h3 id={heading}>{project.safe.title}</h3>
        {!checks ? (
          problem ? null : <Working text={said.archive.checking} status />
        ) : warnings.length ? (
          <>
            <Problems node={node} issues={warnings} />
            <p>{said.archive.unsafe}</p>
          </>
        ) : hidden.length ? (
          // Not called safe: the warnings the user hid may still hold.
          <Callout tone="fyi">{said.archive.onlyHidden(hidden.length)}</Callout>
        ) : node.git ? (
          <Callout tone="safe">
            {remote?.host ? safety.safeOnline(remote.host) : safety.safeHere}
          </Callout>
        ) : (
          <Callout tone="fyi">{safety.noHistoryBody}</Callout>
        )}
        {problem ? (
          <>
            <Callout tone="soon">
              {failure ? said.archive.failed(node.label) : said.archive.cant(node.label)}
            </Callout>
            {failure ? null : <p>{said.archive.elsewhere}</p>}
            <CheckAgain ref={again} disabled={historyPending} onClick={checkAgain} />
          </>
        ) : null}
      </section>
      <Announce text={failure ? said.archive.failed(node.label) : ""} />
      {stage === "send" ? (
        <Working text={said.archive.archiving(node.label)} />
      ) : checks ? (
        <div className="s-choices">
          {first ? (
            <div className="s-choice">
              <Button
                kind="filled"
                icon="shield-check"
                ref={backUp}
                aria-describedby={backId}
                onClick={() => backUpFirst(first.code)}
              >
                {said.archive.backUpFirst}
              </Button>
              <p id={backId} className="s-quiet">
                {said.archive.backUpNote(worst?.title ?? first.title)}
              </p>
            </div>
          ) : null}
          <div className="s-choice">
            <Button
              kind={warnings.length ? "outline" : "filled"}
              icon="archive"
              ref={go}
              disabled={!plan || historyPending}
              aria-describedby={note ? `${noteId} ${aboutId}` : aboutId}
              onClick={() => void archive()}
            >
              {warnings.length ? said.archive.anyway : said.archive.archive}
            </Button>
            {note ? <p id={noteId}>{note}</p> : null}
            <p id={aboutId} className="s-quiet">
              {warnings.length ? said.archive.anywayNote : said.archive.note}
            </p>
          </div>
        </div>
      ) : null}
      <Disclosure>
        <dl className="s-facts">
          <dt>
            <label htmlFor={field}>{said.details.goesTo}</label>
          </dt>
          <dd>
            <input
              id={field}
              className="s-input s-mono"
              value={destination}
              autoComplete="off"
              spellCheck={false}
              disabled={stage !== "choose"}
              onChange={(event) => {
                edited.current = true;
                setDestination(event.target.value);
                setFailure("");
                setNote("");
              }}
            />
            {!current && review ? <Working text={said.archive.checking} status /> : null}
          </dd>
          <Found text={problem} />
          {hidden.length ? (
            <>
              <dt>{said.details.hidden}</dt>
              <dd>
                <ul className="s-files">
                  {hidden.map((issue) => (
                    <li key={issue.code}>{safety.issues[issue.code]?.title ?? issue.title}</li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
          {/* Simple's archive keeps the downloaded packages: Free up space deletes them, on its own. */}
          <Steps ops={(plan ?? last)?.ops.filter((op) => op.kind !== "delete")} home={home} />
        </dl>
      </Disclosure>
    </>
  );
}

// --- Free up space -------------------------------------------------------------------------------

/**
 * Free up space: what goes and how much, "Deleted for good", and that an install or a build brings
 * it back. Its button is never the filled one, and the Countdown comes before the request.
 */
function CleanBody({ node, stage, setStage }: Body) {
  const home = useApp((s) => s.snapshot!.home);
  const historyPending = useApp((s) => s.historyPending);
  const [failure, setFailure] = useState("");
  const [note, setNote] = useState("");
  const heading = useId();
  const noteId = useId();
  const aboutId = useId();
  const free = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  useLayoutEffect(() => {
    if (stage !== "choose" || !back.current) return;
    back.current = false;
    free.current?.focus();
  }, [stage]);
  const parts = node.size?.parts ?? [];
  const reclaimable = node.size?.reclaimable ?? 0;
  const amount = bytes(reclaimable);
  const count = () => {
    setNote("");
    setFailure("");
    setStage("count");
  };
  const cancelled = () => {
    back.current = true;
    setNote(blocks.cancelled);
    setStage("choose");
  };
  const clean = async () => {
    back.current = true;
    setStage("send");
    let ran = false;
    await run(
      async () => {
        ran = true;
        const modal = useApp.getState().modal;
        const change = await api<Change>("clean", { id: node.id });
        if (useApp.getState().modal === modal) close();
        changed(change, said.clean.freed(amount, node.label));
      },
      said.clean.freeing(node.label),
      {
        history: true,
        onError: (error) => {
          setFailure(errorText(error));
          setStage("choose");
        },
      },
    );
    if (!ran) {
      setNote(said.busy);
      setStage("choose");
    }
  };
  return (
    <>
      <section className="s-fix-secrets" aria-labelledby={heading}>
        <h3 id={heading}>{said.clean.whatGoes}</h3>
        {reclaimable ? (
          <>
            <StatusChip tone="soon">{said.clean.forGood}</StatusChip>
            <ul className="s-files">
              {parts.map((part) => (
                <li key={part.path}>
                  <span className="s-mono">{part.path}</span>{" "}
                  <span className="s-quiet">{bytes(part.bytes)}</span>
                </li>
              ))}
            </ul>
            <p>{said.clean.frees(amount)}</p>
            <p className="s-quiet">{said.clean.comesBack}</p>
          </>
        ) : (
          <p>{said.clean.nothing(node.label)}</p>
        )}
        {failure ? <Callout tone="soon">{said.clean.failed(node.label)}</Callout> : null}
      </section>
      <Announce text={failure ? said.clean.failed(node.label) : ""} />
      {stage === "count" ? (
        <Countdown
          what={said.clean.counting(node.label)}
          onDone={() => void clean()}
          onCancel={cancelled}
        />
      ) : stage === "send" ? (
        <Working text={said.clean.freeing(node.label)} />
      ) : reclaimable ? (
        <div className="s-choices">
          <div className="s-choice">
            <Button
              kind="outline"
              danger
              icon="trash-2"
              ref={free}
              disabled={historyPending}
              aria-describedby={note ? `${noteId} ${aboutId}` : aboutId}
              onClick={count}
            >
              {said.clean.free(amount)}
            </Button>
            {note ? <p id={noteId}>{note}</p> : null}
            <p id={aboutId} className="s-quiet">
              {said.clean.freeNote}
            </p>
          </div>
        </div>
      ) : null}
      <Disclosure>
        <dl className="s-facts">
          <Found text={failure} />
          <dt>{said.details.location}</dt>
          <dd className="s-mono">{tilde(node.path, home)}</dd>
        </dl>
      </Disclosure>
    </>
  );
}

// --- What the three share ------------------------------------------------------------------------

/** A request on its way, in words. A change has the window's own overlay to read it out. */
function Working({ text, status = false }: { text: string; status?: boolean }) {
  return (
    <p className="s-working" role={status ? "status" : undefined}>
      <span className="s-spinner" aria-hidden="true" />
      {text}
    </p>
  );
}

/**
 * Reads out what went wrong once a request comes back refused, wherever the focus went. The region
 * is always there, empty until then, so that a screen reader hears it change.
 */
function Announce({ text }: { text: string }) {
  return (
    <p className="sr-only" role="alert">
      {text}
    </p>
  );
}

function CheckAgain({
  ref,
  disabled,
  onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button kind="outline" small icon="refresh-cw" ref={ref} disabled={disabled} onClick={onClick}>
      {said.checkAgain}
    </Button>
  );
}

/** File names in the mono font, and how many more there are. */
function FileList({ files, more }: { files: string[]; more: number }) {
  return (
    <ul className="s-files">
      {files.map((file) => (
        <li key={file} className="s-mono">
          {file}
        </li>
      ))}
      {more ? <li className="s-quiet">{said.delete.more(more)}</li> : null}
    </ul>
  );
}

/**
 * The project's problems, as its "Is it safe?" card says them. Without the card's ⓘ: inside a
 * sheet, Tab from an ⓘ lands on the sheet itself, as the ⓘ closing changes the sheet while the
 * focus moves.
 */
function Problems({ node, issues }: { node: Node; issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    // The box around it lays its parts out at their own width: the list takes the whole width, so
    // the lines between the problems do too.
    <ul className="s-issues" style={{ justifySelf: "stretch" }}>
      {issues.map((issue) => {
        const tone = toneOf(issue.severity);
        const words = safety.issues[issue.code];
        return (
          <li key={issue.code} className="s-issue">
            <div className="s-issue-title">
              <StatusChip tone={tone}>{safety.tones[tone]}</StatusChip>
              <b>{words?.title ?? issue.title}</b>
            </div>
            <p>{words ? words.body(issueCount(node, issue)) : (issue.detail ?? "")}</p>
          </li>
        );
      })}
    </ul>
  );
}

// Show details is a list of facts, as on the About card: a word, then what it is.

/** What the engine said when it refused, in its own words. */
function Found({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <>
      <dt>{said.details.found}</dt>
      <dd>{text}</dd>
    </>
  );
}

/** The steps of a plan as the engine writes them, in the mono font, with paths from home as ~. */
function Steps({ ops, home }: { ops?: Op[]; home: string }) {
  if (!ops?.length) return null;
  return (
    <>
      <dt>{said.details.steps}</dt>
      <dd>
        <ul className="s-files">
          {ops.map((op, i) => {
            const paths = [op.from, op.to].filter(Boolean).map((path) => tilde(path, home));
            return (
              <li key={i} className="s-mono">
                {op.label}
                {paths.length ? `: ${paths.join(" → ")}` : ""}
                {op.detail ? ` (${op.detail})` : ""}
              </li>
            );
          })}
        </ul>
      </dd>
    </>
  );
}
