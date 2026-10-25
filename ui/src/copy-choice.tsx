import { useId, useState } from "react";
import { errorText } from "./api";
import { useCopyPick } from "./copy-pick";
import { DialogFrame } from "./dialogs";
import { tilde } from "./helpers";
import {
  copyAllTicked,
  copyChosen,
  copyNoneTicked,
  copyProjects,
  copyTick,
  toggleCopy,
  toggleCopyOne,
} from "./selectors";
import type { CopyOther, CopyTick } from "./selectors";
import { chooseCopy, useApp } from "./store";
import { detailedSettings as said } from "./words";

function close() {
  useApp.setState({ modal: null });
}

/**
 * Settings: the projects the history backup takes. A box for each project and folder that holds projects; a
 * folder's box ticks and unticks everything in it, and shows a dash when only some of it is ticked, with a row for
 * the chats in the folder itself when it holds some. It starts from the choice made, or with everything ticked
 * when the backup took every project, so nothing stops by surprise. Nothing is sent before Save, which is one change
 * in the Log.
 */
export function CopyChoice() {
  const snapshot = useApp((s) => s.snapshot);
  const [saving, setSaving] = useState(false);
  const { tree, pick, choose, own, changed } = useCopyPick(snapshot, saving);
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    setSaving(true);
    const done = await chooseCopy(
      pick,
      said.backupChosenDone(snapshot ? copyProjects(snapshot, pick) : 0, pick.paths.length, pick.outside),
      said.backupChosenNote,
      (failure) => setError(errorText(failure)),
    );
    // Saved, it closes: the choice it just made is no change from elsewhere.
    if (done) close();
    else setSaving(false);
  };
  // A chosen folder that is no project or group now: gone, still in the folders Laci reads, or outside them.
  const where = (other: CopyOther) =>
    other.gone ? said.backupGone : other.inside ? said.backupNotListed : said.backupNotRead;
  // A row's box is named by where it is and what it ticks; its chats are told after the name.
  const quietId = useId();
  const box = (
    key: string,
    name: string,
    quiet: string,
    depth: number,
    tick: CopyTick,
    toggle: () => void,
    mono = false,
    named = name,
  ) => (
    <li key={key}>
      <label className="opt" style={{ paddingInlineStart: 8 + depth * 22 }}>
        <input
          type="checkbox"
          className="cb"
          checked={tick === "on"}
          ref={(input) => {
            if (input) input.indeterminate = tick === "mixed";
          }}
          aria-label={named}
          aria-describedby={`${quietId}${encodeURIComponent(key)}`}
          disabled={saving}
          onChange={toggle}
        />
        <span className={mono ? "mono" : undefined}>{name}</span>
        <span id={`${quietId}${encodeURIComponent(key)}`} className="r">
          {quiet}
        </span>
      </label>
    </li>
  );
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
      {/* There from the start and empty until the choice changes elsewhere, so what it then says is read out. */}
      <div role="status">{changed ? <p className="muted">{said.backupChanged}</p> : null}</div>
      <div className="row-acts">
        <button type="button" className="btn sm" disabled={saving} onClick={() => choose(copyAllTicked(tree))}>
          {said.backupTickAll}
        </button>
        <button type="button" className="btn sm" disabled={saving} onClick={() => choose(copyNoneTicked())}>
          {said.backupUntickAll}
        </button>
      </div>
      <ul className="copy-tree" aria-label={said.backupChooseList}>
        {tree.rows.flatMap(({ node, depth, chats, total, group }) => {
          const path = node.path;
          const above = node.parent ? snapshot?.nodes[node.parent]?.name : undefined;
          const row = box(
            path,
            node.name,
            said.backupChats(group ? total : chats),
            depth,
            copyTick(tree, pick, path),
            () => choose(toggleCopy(tree, pick, path)),
            false,
            said.backupBoxName(node.name, above, group),
          );
          // The folder's own chats, first under it. No click adds or takes away a row, so none moves.
          return group && own.has(path)
            ? [
                row,
                box(
                  `own:${path}`,
                  said.backupOwn(node.name),
                  said.backupChats(chats),
                  depth + 1,
                  copyChosen(pick).has(path) ? "on" : "off",
                  () => choose(toggleCopyOne(pick, path)),
                ),
              ]
            : [row];
        })}
        {box("outside", said.backupOutside, said.backupChats(tree.outside), 0, pick.outside ? "on" : "off", () =>
          choose({ ...pick, outside: !pick.outside }),
        )}
        {tree.others.map((other) =>
          box(
            other.path,
            tilde(other.path, snapshot?.home ?? ""),
            `${where(other)} · ${said.backupChats(other.chats)}`,
            0,
            copyTick(tree, pick, other.path),
            () => choose(toggleCopy(tree, pick, other.path)),
            true,
          ),
        )}
      </ul>
    </DialogFrame>
  );
}
