// What a chooser of the projects the copy of AI chats takes holds while it is open, for both designs (copy-choice.tsx
// in Detailed, simple/CopyChoice.tsx in Simple): the list to tick, what is ticked, the groups whose own chats have a
// row, and whether the choice changed elsewhere meanwhile.
import { useMemo, useState } from "react";
import { copyAllTicked, copyOwnRows, copyTree } from "./selectors";
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
 * nothing stops by surprise.
 */
function start(snapshot: Snapshot | null | undefined, changed: boolean): Held {
  const only = snapshot?.backup?.only;
  const chosen = only?.paths ?? [];
  const tree = snapshot ? copyTree(snapshot, chosen) : EMPTY;
  const pick = only ? { paths: only.paths, outside: only.outside } : copyAllTicked(tree);
  return { key: choiceKey(only), chosen, pick, own: copyOwnRows(tree, pick), changed };
}

/**
 * The chooser's pick. While it is open, a choice saved elsewhere (another window, an AI through Laci, an Undo, or a
 * move that keeps a project ticked where it went) is what Save would overwrite: the list starts again from it, and
 * `changed` says so. Not while `saving`: that change is the chooser's own.
 */
export function useCopyPick(snapshot: Snapshot | null | undefined, saving: boolean) {
  const [held, setHeld] = useState(() => start(snapshot, false));
  if (!saving && choiceKey(snapshot?.backup?.only) !== held.key) setHeld(start(snapshot, true));
  const tree = useMemo(
    () => (snapshot ? copyTree(snapshot, held.chosen) : EMPTY),
    [snapshot, held.chosen],
  );
  // A group that gains chats of its own in a new scan gets its row too.
  const own = new Set([...held.own, ...copyOwnRows(tree, held.pick)]);
  const choose = (pick: CopyPick) =>
    setHeld((was) => ({ ...was, pick, own: [...new Set([...was.own, ...copyOwnRows(tree, pick)])] }));
  return { tree, pick: held.pick, choose, own, changed: held.changed };
}
