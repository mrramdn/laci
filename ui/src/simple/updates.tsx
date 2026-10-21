// Simple's update parts: the panel in Settings › Updates and the card on Home. Both read what the
// update store (ui/src/update.ts) holds, say where the update stands in plain words and offer the one
// action that fits there: Check now, Install, Restart, or a link to the release page for a copy that a
// package manager owns. Nothing is installed before a click. Home also asks, once, someone who set
// Laci up before 3.0 whether it may look for new versions at all.
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Icon, restoreFocus } from "../common";
import { pref, savePref, toast, urlOpen } from "../store";
import { useUpdate } from "../update";
import type { UpdateStatus } from "../update";
import { useUpdatesUnset } from "../updates-unset";
import { ago, firstRun, polish, settings } from "../words";
import { Button, Callout, Disclosure, StatusChip } from "./ui";

const say = polish.updates;

/** Where the update stands, in the steps Simple tells apart. */
export type UpdateStep =
  | "loading"
  | "unread"
  | "unchecked"
  | "current"
  | "checking"
  | "found"
  | "link"
  | "downloading"
  | "restart"
  | "failed";

/**
 * The step `status` is at. Until the desktop has answered there is no status: "unread" when its
 * answer was refused, else "loading". A copy that has never looked can't say it is up to date.
 */
export function stepOf(status: UpdateStatus | null, refused: boolean): UpdateStep {
  if (!status) return refused ? "unread" : "loading";
  switch (status.state) {
    case "checking":
      return "checking";
    case "available":
      return status.install === "notice" ? "link" : "found";
    case "downloading":
      return "downloading";
    case "ready":
      return "restart";
    case "error":
      return "failed";
    default:
      return status.checkedAt ? "current" : "unchecked";
  }
}

/** What a click does. */
export type UpdateAction =
  | { kind: "refresh" | "check" | "install" | "restart"; label: string }
  | { kind: "open"; label: string; url: string };

/** Laci's releases, for a copy that can only link and was given no page of a version's own. */
const RELEASES = "https://github.com/mrramdn/laci/releases";

/** The one thing to do at a step; nothing while Laci works. */
export function actionOf(
  step: UpdateStep,
  status: UpdateStatus | null,
): UpdateAction | undefined {
  switch (step) {
    case "unread":
      return { kind: "refresh", label: say.tryAgain };
    case "unchecked":
    case "current":
      return { kind: "check", label: say.checkNow };
    case "failed":
      return { kind: "check", label: say.checkAgain };
    case "found":
      return { kind: "install", label: say.install(status?.version ?? "") };
    case "link":
      return { kind: "open", label: say.openRelease, url: status?.url ?? RELEASES };
    case "restart":
      return { kind: "restart", label: say.restart };
    default:
      return undefined;
  }
}

const ICONS: Record<UpdateAction["kind"], string> = {
  refresh: "refresh-cw",
  check: "refresh-cw",
  install: "cloud-download",
  restart: "refresh-cw",
  open: "external-link",
};

/** Does what a click on `action` says. The store's requests keep a refusal for the page to show. */
function perform(action: UpdateAction) {
  const update = useUpdate.getState();
  switch (action.kind) {
    case "refresh":
      return update.refresh();
    case "check":
      return update.check();
    case "install":
      return update.install();
    case "restart":
      return update.restart();
    case "open":
      return urlOpen(action.url);
  }
}

/**
 * Asks the desktop where the update stands, which also starts the store listening to the desktop's
 * news. Only a window has a desktop to ask: a page drawn without one, as the page tests do in Node,
 * leaves the store as it is.
 */
export function refreshUpdate() {
  if (typeof document !== "undefined") void useUpdate.getState().refresh();
}

/**
 * What the update store holds, drawn again when it changes. The first look asks where the update
 * stands, unless `ask` is false: a part beside another one that asks.
 */
function useUpdateStatus(ask = true) {
  const [held, setHeld] = useState(() => useUpdate.getState());
  useEffect(() => {
    const stop = useUpdate.subscribe((state) => setHeld(state));
    // Whatever came between the first draw and now.
    setHeld(useUpdate.getState());
    if (ask) refreshUpdate();
    return stop;
  }, [ask]);
  return held;
}

/**
 * Whether the panel offers Check now, for the words beside the choice not to look, which point to it
 * only while it is there: a version found has Install or Restart in its place. The panel asks.
 */
export function useCheckNowShown() {
  const { status, refusal } = useUpdateStatus(false);
  return actionOf(stepOf(status, refusal !== null), status)?.label === say.checkNow;
}

/** Where Settings › Updates says where the update stands, for the sidebar's foot to lead to. */
const PANEL_ID = "simple-update-status";
/** Brings Settings › Updates into view once Settings has drawn it. */
function showPanel() {
  let tries = 0;
  const look = () => {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.scrollIntoView({ block: "center" });
      panel.focus({ preventScroll: true });
    } else if (++tries < 40) setTimeout(look, 50);
  };
  setTimeout(look, 0);
}

/**
 * At the foot of the sidebar, above Settings, while a new version is known, whether the daily look
 * or Check now found it: available, on its way, or installed and waiting for a restart, as Detailed's
 * badge says it. It leads to Settings › Updates, which shows what to do about it.
 */
export function UpdatePlace({ onOpen }: { onOpen: () => void }) {
  const { status } = useUpdateStatus();
  if (!status?.version || status.state === "idle") return null;
  const state =
    status.state === "ready" || status.state === "downloading" ? status.state : "available";
  const note = say.footNote[state](status.version);
  return (
    <button
      type="button"
      className="s-place"
      data-ui="update-place"
      data-state={state}
      title={note}
      aria-label={`${say.foot[state]}. ${note}`}
      onClick={() => {
        onOpen();
        showPanel();
      }}
    >
      <Icon name={state === "ready" ? "refresh-cw" : "cloud-download"} />
      <span>{say.foot[state]}</span>
    </button>
  );
}

/**
 * Runs a click on the panel's or the card's button. The button goes when the step moves on, so the
 * focus goes to the words that tell what happens next; a link leaves the button where it is.
 */
function useAct(anchor: { current: HTMLElement | null }) {
  const [sending, setSending] = useState(false);
  const act = async (action: UpdateAction) => {
    if (action.kind !== "open") anchor.current?.focus();
    setSending(true);
    await perform(action);
    // A restart that was taken ends the window: its button stays off until then.
    if (action.kind !== "restart" || useUpdate.getState().refusal) setSending(false);
  };
  return { sending, act };
}

/** Laci is at work: a spinner, and what it does. */
function Working({ children }: { children: ReactNode }) {
  return (
    <p className="s-working">
      <span className="s-spinner" aria-hidden="true" />
      {children}
    </p>
  );
}

/** Teal, as everything that is fine in Simple, in the same size as the page's other lines. */
const BAR: CSSProperties = { width: "100%", accentColor: "var(--brand-fill)" };

/**
 * How far the download is, when the desktop knows. The bar has its own name; the words under it are
 * for the eye, as a screen reader would read out every percent.
 */
function Progress({ percent }: { percent: number | undefined }) {
  if (percent === undefined) return null;
  return (
    <>
      <progress max={100} value={percent} aria-label={say.progressLabel} style={BAR} />
      <p className="s-quiet" aria-hidden="true">
        {say.percent(percent)}
      </p>
    </>
  );
}

type Readme = typeof import("../readme");

/**
 * Release notes, drawn as text only: they come from the web, so they are not trusted. They are
 * drawn as a README is, with marked and its cleaner loading the first time. A picture from the web
 * waits to be asked for, and a relative one finds no file: the notes belong to no folder. Their
 * links are underlined as every link in Simple is (simple.css).
 */
function Notes({ notes }: { notes: string }) {
  const [remote, setRemote] = useState(false);
  const [shown, setShown] = useState<{ html: string; remote: number } | null>(null);
  const module = useRef<Readme | null>(null);
  useEffect(() => {
    let live = true;
    void import("../readme").then((readme) => {
      if (!live) return;
      module.current = readme;
      const drawn = readme.renderReadme(notes, "release-notes", remote);
      setShown({ html: drawn.html, remote: drawn.remote });
    });
    return () => {
      live = false;
    };
  }, [notes, remote]);
  const click = (event: MouseEvent<HTMLElement>) =>
    module.current?.proseClick(event, {
      remote: () => setRemote(true),
      blocked: say.linkBlocked,
      relative: () => toast(say.linkNotOpened, say.linkBlocked),
    });
  if (!shown) return null;
  return (
    <>
      {shown.remote && !remote ? (
        <p className="s-note">
          {say.picturesHidden(shown.remote)}{" "}
          <Button kind="text" small onClick={() => setRemote(true)}>
            {say.showPictures}
          </Button>
        </p>
      ) : null}
      <div
        className="s-prose"
        onClick={click}
        dangerouslySetInnerHTML={{ __html: shown.html }}
      />
    </>
  );
}

/** The step's status, as its icon and words. */
function Line({ step, status }: { step: UpdateStep; status: UpdateStatus | null }) {
  const version = status?.version ?? "";
  switch (step) {
    case "loading":
      return <Working>{say.loading}</Working>;
    case "checking":
      return <Working>{say.checking}</Working>;
    case "downloading":
      return <Working>{say.downloading(version)}</Working>;
    case "unread":
      return <Callout tone="soon">{say.unread}</Callout>;
    case "unchecked":
      return <Callout tone="fyi">{say.neverChecked}</Callout>;
    case "current":
      return (
        <p>
          <StatusChip tone="safe">{say.upToDate}</StatusChip>
        </p>
      );
    case "found":
      return <Callout tone="fyi">{say.readyToInstall(version)}</Callout>;
    case "link":
      return <Callout tone="fyi">{say.isAvailable(version)}</Callout>;
    case "restart":
      return <Callout tone="safe">{say.readyToRestart(version)}</Callout>;
    case "failed":
      return <Callout tone="soon">{say.failed}</Callout>;
  }
}

/** The sentence under the status line, when there is one. */
function detailOf(step: UpdateStep, status: UpdateStatus | null, refusal: string | null) {
  const released = ago(status?.date);
  const checked = ago(status?.checkedAt);
  switch (step) {
    case "unread":
      return refusal ?? "";
    case "unchecked":
      return say.versionNow(status?.current ?? "");
    case "current":
      return [say.versionNow(status?.current ?? ""), checked ? say.lastChecked(checked) : ""]
        .filter(Boolean)
        .join(" ");
    case "found":
      return released ? say.released(released) : "";
    case "link":
      return [released ? say.released(released) : "", say.linkOnly].filter(Boolean).join(" ");
    case "restart":
      return say.restartNote;
    case "failed":
      return status?.error ?? "";
    default:
      return "";
  }
}

/**
 * Settings › Updates, above the choice of how often Laci looks: where the update stands, what is new
 * in the version found, and the one button that moves it on.
 */
export function UpdatePanel() {
  const { status, refusal } = useUpdateStatus();
  const anchor = useRef<HTMLDivElement>(null);
  const { sending, act } = useAct(anchor);
  const step = stepOf(status, refusal !== null);
  const action = actionOf(step, status);
  const detail = detailOf(step, status, refusal);
  const notes = status?.notes?.trim();
  return (
    // Settings gives the group a gap from the choice below it, and its own spacing to what is inside.
    <div className="s-set-group">
      <div data-ui="update-panel" data-step={step}>
        {/* One region the words come and go in, so each step is read out once it is there. */}
        <div ref={anchor} id={PANEL_ID} tabIndex={-1} role="status">
          <Line step={step} status={status} />
          {detail ? <p className="s-quiet">{detail}</p> : null}
          {refusal && step !== "unread" && refusal !== detail ? (
            <Callout tone="soon">{refusal}</Callout>
          ) : null}
        </div>
        {step === "downloading" ? <Progress percent={status?.progress} /> : null}
        {(step === "found" || step === "link") && notes ? (
          <Disclosure
            label={say.whatsNew(status?.version ?? "")}
            openLabel={say.whatsNew(status?.version ?? "")}
          >
            <Notes notes={notes} />
          </Disclosure>
        ) : null}
        {action ? (
          <div className="s-actions">
            <Button
              kind="outline"
              icon={ICONS[action.kind]}
              disabled={sending}
              onClick={() => void act(action)}
            >
              {action.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The steps Home mentions: a new version is waiting for a click or a restart, or on its way, or what a
 * click there did has failed. A failure comes only from something the user asked for: Laci's own
 * daily look never shows one.
 */
const CARD_STEPS: readonly UpdateStep[] = ["found", "link", "downloading", "restart", "failed"];
/** What hides the card for one version: Home asks again for the next one. */
const hiddenKey = (version: string) => `update-hidden:${version}`;

/**
 * Home's quiet card: a new version is ready, with its one button. It is there only while Laci looks
 * for new versions by itself (Settings has everything else) and until the user says Not now, which
 * holds for that version alone. pref and savePref keep every read and write of the browser's storage
 * in a try and catch; without storage the card goes when the user says Not now, and comes back
 * when Home is drawn again.
 */
export function UpdateCard() {
  const { status, refusal } = useUpdateStatus();
  const [gone, setGone] = useState("");
  const anchor = useRef<HTMLDivElement>(null);
  const { sending, act } = useAct(anchor);
  const heading = useId();
  const step = stepOf(status, false);
  const version = status?.version ?? "";
  if (
    !status?.enabled ||
    !version ||
    !CARD_STEPS.includes(step) ||
    gone === version ||
    pref(hiddenKey(version), false)
  )
    return null;
  const action = actionOf(step, status);
  const notNow = () => {
    savePref(hiddenKey(version), true);
    setGone(version);
    toast(polish.card.hidden(version), polish.card.hiddenNote);
    // The button that had the focus goes with the card: the page takes it.
    restoreFocus(null);
  };
  return (
    <section
      className="s-card"
      aria-labelledby={heading}
      data-ui="update-card"
      data-step={step}
    >
      <header className="s-card-head">
        <Icon name="cloud-download" />
        <h2 id={heading}>{polish.card.title}</h2>
      </header>
      <div ref={anchor} tabIndex={-1} role="status">
        {step === "found" ? <p>{polish.card.canInstall(version)}</p> : null}
        {step === "link" ? (
          <p>{[say.isAvailable(version), say.linkOnly].join(" ")}</p>
        ) : null}
        {step === "downloading" ? <Working>{say.downloading(version)}</Working> : null}
        {step === "restart" ? <p>{say.restartNote}</p> : null}
        {step === "failed" ? (
          <>
            <Callout tone="soon">{say.failed}</Callout>
            {status.error ? <p className="s-quiet">{status.error}</p> : null}
          </>
        ) : null}
        {refusal && refusal !== status.error ? <Callout tone="soon">{refusal}</Callout> : null}
      </div>
      {step === "downloading" ? <Progress percent={status.progress} /> : null}
      {action ? (
        <div className="s-actions">
          <Button
            kind="outline"
            small
            icon={ICONS[action.kind]}
            disabled={sending}
            onClick={() => void act(action)}
          >
            {action.label}
          </Button>
          <Button kind="text" small onClick={notNow}>
            {polish.card.notNow}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Home's card that asks someone who set Laci up before 3.0 whether Laci may look for new versions, as
 * first run asks a new install. Either button saves the choice through the update store, as
 * Detailed's Settings › About & updates does, and the card is gone for good; until then Laci doesn't
 * look. Both are outlined, as the screen's one filled button is Home's own, and they weigh the same:
 * it is the user's consent to give.
 */
export function UpdatesOffer() {
  // Home may have nothing else that listens to the desktop's news of the update: this starts it.
  useUpdateStatus();
  const unset = useUpdatesUnset();
  const [chosen, setChosen] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState("");
  const heading = useId();
  if (!unset || chosen) return null;
  const choose = async (updates: "daily" | "off") => {
    if (sending) return;
    setSending(true);
    setRefusal("");
    let saved = false;
    try {
      saved = await useUpdate.getState().choose(updates);
    } catch {
      // The store keeps what the desktop refused; without that, first run's words say it.
    } finally {
      setSending(false);
    }
    if (!saved) {
      setRefusal(useUpdate.getState().refusal ?? firstRun.updatesFailed);
      return;
    }
    setChosen(true);
    toast(settings.updatesSaved[updates], firstRun.updatesLater);
    // The button that had the focus goes with the card: the page takes it.
    restoreFocus(null);
  };
  // Busy, not disabled, while the choice is sent: a refusal leaves the focus where it was.
  return (
    <section
      className="s-card"
      aria-labelledby={heading}
      aria-busy={sending || undefined}
      data-ui="updates-offer"
    >
      <header className="s-card-head">
        <Icon name="refresh-cw" />
        <h2 id={heading}>{firstRun.updatesTitle}</h2>
      </header>
      <p>{firstRun.updatesSends}</p>
      <p>{firstRun.updatesNoInstall}</p>
      {refusal ? (
        <div role="alert">
          <Callout tone="soon">{refusal}</Callout>
        </div>
      ) : null}
      <div className="s-actions">
        {(["daily", "off"] as const).map((value) => (
          <Button key={value} kind="outline" small onClick={() => void choose(value)}>
            {firstRun.updatesAsk[value]}
          </Button>
        ))}
      </div>
    </section>
  );
}
