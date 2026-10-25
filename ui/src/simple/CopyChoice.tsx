// "Which projects should Laci copy?": the sheet where the copy of AI chats takes only the projects you tick
// (CopyCard in AiHelpers.tsx opens it). Nothing is sent until Save, so one choice is one entry in Activity.
import { useMemo, useRef, useState } from "react";
import { errorText } from "../api";
import { tilde } from "../helpers";
import { copyAllTicked, copyNoneTicked, copyTick, copyTree, toggleCopy } from "../selectors";
import type { CopyPick } from "../selectors";
import { chooseCopy } from "../store";
import type { Snapshot } from "../types";
import { aiHelpers as said, blocks } from "../words";
import { Button, Callout, Sheet } from "./ui";

/**
 * The sheet: a box for each project and folder that holds projects, a folder's box ticks and unticks everything
 * in it, and a mixed one when only some of it is. It starts from the choice made, or with everything ticked when
 * the copy took every project, so that nothing stops by surprise.
 */
export function CopyChoice({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const only = snapshot.backup?.only;
  // The folders chosen that are gone are listed as they were when the sheet opened, so that one unticked can be
  // ticked again.
  const chosen = useRef(only?.paths ?? []);
  const tree = useMemo(() => copyTree(snapshot, chosen.current), [snapshot]);
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
      said.copyChosenDone(pick.paths.length, pick.outside),
      said.copyChosenNote,
      (failure) => setError(errorText(failure)),
    );
    setSaving(false);
    if (done) onClose();
  };
  const row = (path: string, name: string, quiet: string, depth: number, gone = false) => {
    const tick = copyTick(tree, pick, path);
    return (
      <li key={path} className="s-copy-row" style={{ paddingInlineStart: depth * 24 }}>
        <label>
          <input
            type="checkbox"
            className="s-cb"
            checked={tick === "on"}
            ref={(box) => {
              if (box) box.indeterminate = tick === "mixed";
            }}
            disabled={saving}
            onChange={() => setPick(toggleCopy(tree, pick, path))}
          />
          <span className={gone ? "s-mono" : undefined}>{name}</span>
          <span className="s-quiet">{quiet}</span>
        </label>
      </li>
    );
  };
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
      <div className="s-actions">
        <Button kind="text" small disabled={saving} onClick={() => setPick(copyAllTicked(tree))}>
          {said.copyTickAll}
        </Button>
        <Button kind="text" small disabled={saving} onClick={() => setPick(copyNoneTicked())}>
          {said.copyUntickAll}
        </Button>
      </div>
      <ul className="s-copy-tree" aria-label={said.copyChooseList}>
        {tree.rows.map(({ node, depth, chats }) => row(node.path, node.name, said.copyChats(chats), depth))}
        <li className="s-copy-row">
          <label>
            <input
              type="checkbox"
              className="s-cb"
              checked={pick.outside}
              disabled={saving}
              onChange={() => setPick({ ...pick, outside: !pick.outside })}
            />
            <span>{said.copyOutside}</span>
            <span className="s-quiet">{said.copyChats(tree.outside)}</span>
          </label>
        </li>
        {tree.gone.map((path) => row(path, tilde(path, snapshot.home), said.copyGone, 0, true))}
      </ul>
      <p className="s-quiet">{said.copyChooseKeeps}</p>
      {error ? <Callout tone="act">{error}</Callout> : null}
    </Sheet>
  );
}
