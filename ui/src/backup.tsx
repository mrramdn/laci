import { useState } from "react";
import { api, errorText } from "./api";
import { Icon } from "./common";
import { bytes, plural, tilde, when } from "./helpers";
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

/** How much a move of the copy would carry, or nothing when it holds nothing yet. */
export const copySize = (state: Backup) =>
  state.bytes ? bytes(state.bytes) : undefined;

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
 * first, naming the folder and how much moves.
 */
export function BackupFolder({ state, home }: { state: Backup; home: string }) {
  const working = useApp((s) => s.working);
  const historyPending = useApp((s) => s.historyPending);
  // The folder the user picked, waiting for the question to be answered; "" is Laci's data folder.
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const moving = working === said.backupMoving;
  const where = (dir: string) => (dir ? tilde(dir, home) : said.backupFolderDefault);
  const move = (dir: string) =>
    void moveCopy(
      dir,
      { moving: said.backupMoving, moved: said.backupMoved, note: said.backupMoveNote },
      (failure) => setError(errorText(failure)),
    ).then((done) => {
      if (done) setAsking(null);
    });
  return (
    <div className="fld" data-ui="backup-folder">
      <span>{said.backupFolder}</span>
      <div className="addrow">
        <span className="inp mono" aria-label={said.backupFolder}>
          {state.chosen ? state.dest : `${state.dest ?? ""} (${said.backupFolderDefault})`}
        </span>
        <ChooseFolder
          label={said.backupFolderChange}
          name={said.backupFolderChangeName}
          title={said.backupFolderTitle}
          defaultPath={state.chosen && state.dest ? state.dest : "~"}
          disabled={moving || historyPending}
          onPick={(path) => {
            setError("");
            setAsking(path);
          }}
        />
        {state.chosen ? (
          <button
            type="button"
            className="btn"
            disabled={moving || historyPending}
            onClick={() => {
              setError("");
              setAsking("");
            }}
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
        <div className="row-acts" role="group" aria-label={said.backupMove}>
          <span className="muted">
            {said.backupMoveAsk(where(asking), copySize(state))} {said.backupMoveNote}
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
            {moving ? said.backupMoving : said.backupMove}
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
