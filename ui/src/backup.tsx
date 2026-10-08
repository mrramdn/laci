import { api } from "./api";
import { Icon } from "./common";
import { bytes, plural, when } from "./helpers";
import { acknowledge, backup, external, run, useApp } from "./store";
import type { Snapshot } from "./types";

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

export function BackupNotice() {
  const snapshot = useApp((s) => s.snapshot);
  const state = snapshot?.backup;
  const warning = snapshot?.warnings.find((w) => w.code === "claude-cleanup");
  const dest = state?.dest;
  const folder = dest ? (
    <button className="btn sm" onClick={() => external(dest, "files")}>
      Open backup folder
    </button>
  ) : null;
  if (warning) {
    return (
      <div className="callout backup">
        <Icon name="alert" />
        <div className="txt">
          <b>{warning.title}</b>
          <p>{warning.detail}</p>
          {state?.at ? (
            <p className="last">Last backup {when(state.at)}</p>
          ) : null}
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
        <Icon name="check" />
        <span className="txt">
          Agent history backed up {when(state.at)}
          {state.sessions !== undefined
            ? ` · ${plural(state.sessions, "session")} kept (${bytes(state.bytes)})`
            : ""}
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
