// "Which projects should Laci copy?": the sheet where the copy of AI chats takes only the projects you tick
// (CopyCard in AiHelpers.tsx opens it). Nothing is sent until Save, so one choice is one entry in Activity.
import { useState } from "react";
import { errorText } from "../api";
import { useCopyPick } from "../copy-pick";
import { tilde } from "../helpers";
import {
  copyAllTicked,
  copyChosen,
  copyNoneTicked,
  copyProjects,
  copyTick,
  toggleCopy,
  toggleCopyOne,
} from "../selectors";
import type { CopyOther, CopyTick } from "../selectors";
import { chooseCopy } from "../store";
import type { Snapshot } from "../types";
import { aiHelpers as said, blocks } from "../words";
import { Button, Callout, Sheet } from "./ui";

/**
 * The sheet: a box for each project and folder that holds projects, a folder's box ticks and unticks everything
 * in it, and a mixed one when only some of it is, with a row for the chats in the folder itself when it holds some.
 * It starts from the choice made, or with everything ticked when the copy took every project, so that nothing
 * stops by surprise.
 */
export function CopyChoice({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const { tree, pick, choose, own, changed } = useCopyPick(snapshot, saving);
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    setSaving(true);
    const done = await chooseCopy(
      pick,
      said.copyChosenDone(copyProjects(snapshot, pick), pick.paths.length, pick.outside),
      said.copyChosenNote,
      (failure) => setError(errorText(failure)),
    );
    // Saved, the sheet goes: the choice it just made is no change from elsewhere.
    if (done) onClose();
    else setSaving(false);
  };
  // A chosen folder that is no project or group now: gone, still in the folders Laci reads, or outside them.
  const where = (other: CopyOther) =>
    other.gone ? said.copyGone : other.inside ? said.copyNotListed : said.copyNotRead;
  const box = (
    key: string,
    name: string,
    quiet: string,
    depth: number,
    tick: CopyTick,
    toggle: () => void,
    mono = false,
  ) => (
    <li key={key} className="s-copy-row" style={{ paddingInlineStart: depth * 24 }}>
      <label>
        <input
          type="checkbox"
          className="s-cb"
          checked={tick === "on"}
          ref={(input) => {
            if (input) input.indeterminate = tick === "mixed";
          }}
          disabled={saving}
          onChange={toggle}
        />
        <span className={mono ? "s-mono" : undefined}>{name}</span>
        <span className="s-quiet">{quiet}</span>
      </label>
    </li>
  );
  return (
    <Sheet
      title={said.copyChooseTitle}
      description={said.copyChooseAbout}
      onClose={onClose}
      dismissible={!saving}
      footer={
        <>
          <Button kind="text" disabled={saving} onClick={onClose}>
            {blocks.cancel}
          </Button>
          <Button kind="filled" disabled={saving} onClick={() => void save()}>
            {saving ? said.copySaving : said.copySave}
          </Button>
        </>
      }
    >
      {/* There from the start and empty until the choice changes elsewhere, so what it then says is read out. */}
      <div role="status">{changed ? <Callout tone="fyi">{said.copyChanged}</Callout> : null}</div>
      <div className="s-actions">
        <Button kind="text" small disabled={saving} onClick={() => choose(copyAllTicked(tree))}>
          {said.copyTickAll}
        </Button>
        <Button kind="text" small disabled={saving} onClick={() => choose(copyNoneTicked())}>
          {said.copyUntickAll}
        </Button>
      </div>
      <ul className="s-copy-tree" aria-label={said.copyChooseList}>
        {tree.rows.flatMap(({ node, depth, chats, total, group }) => {
          const path = node.path;
          const row = box(path, node.name, said.copyChats(group ? total : chats), depth, copyTick(tree, pick, path), () =>
            choose(toggleCopy(tree, pick, path)),
          );
          // The folder's own chats, first under it. No click adds or takes away a row, so none moves.
          return group && own.has(path)
            ? [
                row,
                box(
                  `own:${path}`,
                  said.copyOwn(node.name),
                  said.copyChats(chats),
                  depth + 1,
                  copyChosen(pick).has(path) ? "on" : "off",
                  () => choose(toggleCopyOne(pick, path)),
                ),
              ]
            : [row];
        })}
        {box("outside", said.copyOutside, said.copyChats(tree.outside), 0, pick.outside ? "on" : "off", () =>
          choose({ ...pick, outside: !pick.outside }),
        )}
        {tree.others.map((other) =>
          box(
            other.path,
            tilde(other.path, snapshot.home),
            `${where(other)} · ${said.copyChats(other.chats)}`,
            0,
            copyTick(tree, pick, other.path),
            () => choose(toggleCopy(tree, pick, other.path)),
            true,
          ),
        )}
      </ul>
      <p className="s-quiet">{said.copyChooseKeeps}</p>
      {error ? <Callout tone="act">{error}</Callout> : null}
    </Sheet>
  );
}
