import { useMemo, useRef, useState } from "react";
import { errorText } from "./api";
import { DialogFrame } from "./dialogs";
import { tilde } from "./helpers";
import { copyAllTicked, copyNoneTicked, copyTick, copyTree, toggleCopy } from "./selectors";
import type { CopyPick } from "./selectors";
import { chooseCopy, useApp } from "./store";
import { detailedSettings as said } from "./words";

function close() {
  useApp.setState({ modal: null });
}

/**
 * Settings: the projects the history backup takes. A box for each project and folder that holds projects; a
 * folder's box ticks and unticks everything in it, and shows a dash when only some of it is ticked. It starts from
 * the choice made, or with everything ticked when the backup took every project, so nothing stops by surprise.
 * Nothing is sent before Save, which is one change in the Log.
 */
export function CopyChoice() {
  const snapshot = useApp((s) => s.snapshot);
  const only = snapshot?.backup?.only;
  // The chosen folders that are gone are listed as they were when this opened, so one unticked can be ticked again.
  const chosen = useRef(only?.paths ?? []);
  const tree = useMemo(
    () => (snapshot ? copyTree(snapshot, chosen.current) : { rows: [], outside: 0, gone: [] }),
    [snapshot],
  );
  const [pick, setPick] = useState<CopyPick>(() =>
    only ? { paths: only.paths, outside: only.outside } : copyAllTicked(tree),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    setSaving(true);
    const done = await chooseCopy(
      pick,
      said.backupChosenDone(pick.paths.length, pick.outside),
      said.backupChosenNote,
      (failure) => setError(errorText(failure)),
    );
    setSaving(false);
    if (done) close();
  };
  const row = (path: string, name: string, quiet: string, depth: number, gone = false) => {
    const tick = copyTick(tree, pick, path);
    return (
      <li key={path}>
        <label className="opt" style={{ paddingInlineStart: 8 + depth * 22 }}>
          <input
            type="checkbox"
            className="cb"
            checked={tick === "on"}
            ref={(box) => {
              if (box) box.indeterminate = tick === "mixed";
            }}
            disabled={saving}
            onChange={() => setPick(toggleCopy(tree, pick, path))}
          />
          <span className={gone ? "mono" : undefined}>{name}</span>
          <span className="r">{quiet}</span>
        </label>
      </li>
    );
  };
  return (
    <DialogFrame
      title={said.backupChooseTitle}
      description={said.backupChooseAbout}
      dismissible={!saving}
      footer={
        <>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : null}
          <p>{said.backupChooseKeeps}</p>
          <button type="button" className="btn" disabled={saving} onClick={close}>
            {said.cancel}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={saving}
            aria-busy={saving || undefined}
            onClick={() => void save()}
          >
            {saving ? said.backupSaving : said.backupSave}
          </button>
        </>
      }
    >
      <div className="row-acts">
        <button type="button" className="btn sm" disabled={saving} onClick={() => setPick(copyAllTicked(tree))}>
          {said.backupTickAll}
        </button>
        <button type="button" className="btn sm" disabled={saving} onClick={() => setPick(copyNoneTicked())}>
          {said.backupUntickAll}
        </button>
      </div>
      <ul className="copy-tree" aria-label={said.backupChooseList}>
        {tree.rows.map(({ node, depth, chats }) =>
          row(node.path, node.name, said.backupChats(chats), depth),
        )}
        <li>
          <label className="opt">
            <input
              type="checkbox"
              className="cb"
              checked={pick.outside}
              disabled={saving}
              onChange={() => setPick({ ...pick, outside: !pick.outside })}
            />
            <span>{said.backupOutside}</span>
            <span className="r">{said.backupChats(tree.outside)}</span>
          </label>
        </li>
        {tree.gone.map((path) =>
          row(path, tilde(path, snapshot?.home ?? ""), said.backupGone, 0, true),
        )}
      </ul>
    </DialogFrame>
  );
}
