import { useEffect, useId, useRef, useState } from "react";
import { api, errorText } from "./api";
import { Icon } from "./common";
import { bytes, copyChangeSaid, plural, tilde, when } from "./helpers";
import { ChooseFolder } from "./pick";
import { acknowledge, backup, moveCopy, openCopy, run, useApp } from "./store";
import type { Backup, Snapshot } from "./types";
import { detailedSettings as said } from "./words";

function turnOn(thenBackup: boolean) {
  void run(async () => {
    const result = await api<{ on: boolean; snapshot?: Snapshot }>(
      "backup/auto",
      { on: true },
    );
    if (result.snapshot) acknowledge({ snapshot: result.snapshot });
    if (thenBackup) backup();
  });
}

/**
 * About how much a move of the copy would carry, once the last backup packed every file; nothing when it holds
 * nothing yet, or still holds plain files from before Laci 3.1, which are packed before they move.
 */
export const copySize = (state: Backup) =>
  state.bytes && state.packed ? bytes(state.bytes) : undefined;

export function BackupNotice() {
  const snapshot = useApp((s) => s.snapshot);
  const state = snapshot?.backup;
  // One per agent that deletes its own history; the first is enough to act on.
  const warning = snapshot?.warnings.find((w) => w.code.endsWith("-cleanup"));
  const dest = state?.dest;
  const folder =
    dest && !state?.error ? (
      <button className="btn sm" onClick={() => openCopy(dest)}>
        Open backup folder
      </button>
    ) : null;
  const unusable = state?.error ? (
    <p className="err" role="alert">
      {state.error}
    </p>
  ) : null;
  if (warning) {
    return (
      <div className="callout backup">
        <Icon name="alert" />
        <div className="txt">
          <b>{warning.title}</b>
          <p>{warning.detail}</p>
          {state?.at ? (
            <p className="last">
              Last backup {when(state.at)}
              {dest ? ` · in ${dest}` : ""}
            </p>
          ) : null}
          {unusable}
        </div>
        <div className="acts">
          <button className="btn sm" onClick={backup}>
            {state?.at ? "Back up now" : "Back up logs now"}
          </button>
          {state?.at ? folder : null}
          {state && !state.auto ? (
            <button className="btn sm ghost" onClick={() => turnOn(!state.at)}>
              Back up automatically
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (state?.at)
    return (
      <div className="backup-ok">
        <Icon name={state.error ? "alert" : "check"} />
        <span className="txt">
          {state.error ??
            `Agent history backed up ${when(state.at)}${
              state.sessions !== undefined
                ? ` · ${plural(state.sessions, "session")} kept (${bytes(state.bytes)})`
                : ""
            }`}
        </span>
        {folder}
        {state.auto ? (
          <span className="faint">Automatic backup is on</span>
        ) : (
          <button className="btn sm ghost" onClick={() => turnOn(false)}>
            Back up automatically
          </button>
        )}
      </div>
    );
  return null;
}

/**
 * Settings: where the agent history backup is, with Change… and, for a chosen folder, Use the default. A move asks
 * first, naming the folder and how much moves. A backup Laci can't reach now isn't moved: a new one can start in the
 * folder chosen instead, and the question says the old one stays where it is.
 */
export function BackupFolder({ state, home }: { state: Backup; home: string }) {
  const working = useApp((s) => s.working);
  const historyPending = useApp((s) => s.historyPending);
  // The folder the user picked, waiting for the question to be answered; "" is Laci's data folder.
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const label = useId();
  const told = useId();
  const change = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLDivElement>(null);
  const open = asking !== null;
  const fresh = Boolean(state.error);
  const moving = working === said.backupMoving;
  const busy = moving || historyPending;
  const wasOpen = useRef(false);
  const giveBack = useRef(false);
  // The question takes the focus when it opens, and gives it back to Change… when it closes, as soon as Change… can
  // take it: after a move it is disabled until history is read again. Not if the focus went somewhere meanwhile.
  useEffect(() => {
    if (open) question.current?.focus();
    giveBack.current = open ? false : giveBack.current || wasOpen.current;
    wasOpen.current = open;
    if (!giveBack.current || busy) return;
    giveBack.current = false;
    const at = document.activeElement;
    if (!at || at === document.body) change.current?.focus();
  }, [open, busy]);
  const where = (dir: string) => (dir ? tilde(dir, home) : said.backupFolderDefault);
  const note = fresh ? said.backupFreshNote : said.backupMoveNote;
  const ask = (dir: string) => {
    setError("");
    setAsking(dir);
  };
  const asked = (dir: string) =>
    fresh
      ? said.backupFreshAsk(where(dir))
      : state.bytes && !state.packed
        ? said.backupMovePlainAsk(where(dir))
        : said.backupMoveAsk(where(dir), copySize(state));
  const move = (dir: string) =>
    void moveCopy(
      dir,
      fresh,
      {
        moving: said.backupMoving,
        note,
        said: (answer) =>
          copyChangeSaid(dir, answer, {
            moved: said.backupMoved,
            kept: said.backupKept,
            own: said.backupFolderDefault,
          }),
      },
      (failure) => setError(errorText(failure)),
    ).then((done) => {
      if (done) setAsking(null);
    });
  const act = fresh ? said.backupFresh : said.backupMove;
  return (
    <div className="fld" data-ui="backup-folder">
      <span id={label}>{said.backupFolder}</span>
      <div className="addrow">
        <output className="inp mono" aria-labelledby={label}>
          {state.chosen ? state.dest : `${state.dest ?? ""} (${said.backupFolderDefault})`}
        </output>
        <ChooseFolder
          ref={change}
          label={said.backupFolderChange}
          name={said.backupFolderChangeName}
          title={said.backupFolderTitle}
          defaultPath={state.chosen && state.dest ? state.dest : "~"}
          disabled={busy}
          onPick={ask}
        />
        {state.chosen ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => ask("")}
          >
            {said.backupFolderDefaultButton}
          </button>
        ) : null}
      </div>
      {state.error ? (
        <p className="err" role="alert">
          {state.error}
        </p>
      ) : null}
      {asking !== null ? (
        <div
          ref={question}
          className="row-acts"
          role="group"
          aria-label={act}
          aria-describedby={told}
          tabIndex={-1}
        >
          <span className="muted" id={told}>
            {asked(asking)} {note}
          </span>
          <span className="grow" />
          <button
            type="button"
            className="btn sm"
            disabled={moving}
            onClick={() => setAsking(null)}
          >
            {said.cancel}
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={moving || historyPending}
            aria-busy={moving || undefined}
            onClick={() => move(asking)}
          >
            {moving ? said.backupMoving : act}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <small>{said.backupFolderNote}</small>
    </div>
  );
}
