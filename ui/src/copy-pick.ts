// What a chooser of the projects the copy of AI chats takes holds while it is open, for both designs (copy-choice.tsx
// in Detailed, simple/CopyChoice.tsx in Simple): the list to tick, what is ticked, the groups whose own chats have a
// row, and whether the choice changed elsewhere meanwhile.
import { useMemo, useState } from "react";
import { copyAllTicked, copyInStep, copyOwnRows, copyTree } from "./selectors";
import type { CopyPick, CopyTree } from "./selectors";
import type { CopyOnly, Snapshot } from "./types";

const EMPTY: CopyTree = { rows: [], outside: 0, others: [] };

/** The saved choice, to tell a change of it from a scan that only counted again. */
const choiceKey = (only: CopyOnly | undefined) =>
  only ? JSON.stringify([[...only.paths].sort(), only.outside]) : "";

interface Held {
  key: string;
  /** The paths chosen when the list started: one unticked stays listed, so it can be ticked again. */
  chosen: string[];
  pick: CopyPick;
  /** Groups whose own row was shown. It stays until the chooser closes, so rows don't move under the pointer. */
  own: string[];
  /** The choice changed elsewhere while the chooser was open, and the list started again from it. */
  changed: boolean;
}
/**
 * The list as it starts: from the choice made, or with everything ticked when the copy took every project, so that
 * nothing stops by surprise. A group without chats of its own is ticked as what is in it is. The own rows in `shown`
 * stay when it starts again.
 */
function start(snapshot: Snapshot | null | undefined, changed: boolean, shown: string[] = []): Held {
  const only = snapshot?.backup?.only;
  const chosen = only?.paths ?? [];
  const tree = snapshot ? copyTree(snapshot, chosen) : EMPTY;
  const own = [...new Set([...shown, ...copyOwnRows(tree)])];
  const pick = copyInStep(
    tree,
    only ? { paths: only.paths, outside: only.outside } : copyAllTicked(tree),
    new Set(own),
  );
  return { key: choiceKey(only), chosen, pick, own, changed };
}

/**
 * The chooser's pick. While it is open, a choice saved elsewhere (another window, an AI through Laci, an Undo, or a
 * move that keeps a project ticked where it went) is what Save would overwrite: the list starts again from it, and
 * `changed` says so. Not while `saving`: that change is the chooser's own.
 */
export function useCopyPick(snapshot: Snapshot | null | undefined, saving: boolean) {
  const [held, setHeld] = useState(() => start(snapshot, false));
  if (!saving && choiceKey(snapshot?.backup?.only) !== held.key) setHeld(start(snapshot, true, held.own));
  // Counted as the engine would copy once saved: a chosen folder that isn't scanned keeps its chats only while ticked.
  const tree = useMemo(
    () => (snapshot ? copyTree(snapshot, held.chosen, held.pick.paths) : EMPTY),
    [snapshot, held.chosen, held.pick],
  );
  // A group that gains chats of its own in a new scan gets its row too; a click adds or takes away none.
  const own = useMemo(() => new Set([...held.own, ...copyOwnRows(tree)]), [held.own, tree]);
  const choose = (pick: CopyPick) =>
    setHeld((was) => ({ ...was, pick: copyInStep(tree, pick, own), own: [...own] }));
  // In step on every draw as well, so a rescan that changes what is in a group leaves no dash a row doesn't explain.
  const pick = useMemo(() => copyInStep(tree, held.pick, own), [tree, held.pick, own]);
  return { tree, pick, choose, own, changed: held.changed };
}
