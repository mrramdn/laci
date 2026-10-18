// The changes both designs make the same way. Each sends the request the views send today, through
// run() and changed() with the same guards, so a change reads the same in the Log whichever design
// made it. Each returns a promise that settles once the change is shown, or once a toast says why
// it couldn't be made.
import { api } from "./api";
import { taskIdentity } from "./helpers";
import { changed, run, toast, useApp } from "./store";
import type { Change, Node, Proposal, Task } from "./types";

/** Ticks or unticks a to-do in its file. */
export function toggleTodo(node: Node, task: Task, done: boolean) {
  return run(async () =>
    useApp.getState().patch(
      await api<Node>("todo", {
        id: node.id,
        op: "toggle",
        file: task.file,
        line: task.line,
        text: task.text,
        ...taskIdentity(node, task),
        done,
      }),
    ),
  );
}

/** Adds a next step to the project's .laci.md. True once it is added; blank text adds nothing. */
export async function addTodo(node: Node, text: string) {
  const value = text.trim();
  if (!value) return false;
  const added = await run(async () => {
    useApp
      .getState()
      .patch(await api<Node>("todo", { id: node.id, op: "add", text: value }));
    return true;
  });
  return added === true;
}

/** Deletes a next step from the project's .laci.md. */
export function deleteTodo(node: Node, task: Task) {
  return run(async () =>
    useApp.getState().patch(
      await api<Node>("todo", {
        id: node.id,
        op: "delete",
        file: task.file,
        line: task.line,
        text: task.text,
        ...taskIdentity(node, task),
      }),
    ),
  );
}

/**
 * Closes one of a report's open items as done or dropped, or opens a closed one again. `text` is the
 * item's whole text, which names that item alone even after the list has changed; the toast shows it.
 * The report stays as written.
 */
export function closeReportItem(
  report: string,
  text: string,
  state: "done" | "dropped" | "open",
) {
  return run(async () => {
    await api("report/close", { report, text, state });
    toast(state === "open" ? "Opened again" : "Closed in the report", text);
  });
}

/** Sets a field of the project's .laci.md. An empty value clears it; an empty status is Automatic. */
export function setMeta(
  node: Node,
  key: "status" | "priority" | "deadline" | "quiet",
  value: string,
) {
  return run(async () => {
    useApp
      .getState()
      .patch(await api<Node>("meta", { id: node.id, key, value }));
  });
}

/** Stops or starts warning about one check on the project. */
export function muteCheck(node: Node, code: string, on: boolean) {
  // Keep codes that are muted but not raised right now, so muting one check never drops another.
  const quiet = (node.meta.quiet ?? "").split(",").filter(Boolean);
  return run(async () => {
    const rest = quiet.filter((c) => c !== code);
    const value = (on ? [...rest, code] : rest).join(",");
    useApp
      .getState()
      .patch(await api<Node>("meta", { id: node.id, key: "quiet", value }));
  });
}

/** Undoes a journaled change: the Undo in its toast. */
export function undoJournal(id: string) {
  return run(
    async () =>
      changed(await api<Change>("undo", { id }), "Journaled changes undone"),
    "Undoing…",
    { history: true },
  );
}

/** Undoes the change a Log entry records. */
export function undoLogEntry(id: string) {
  return run(
    async () => {
      changed(await api<Change>("log/undo", { id }), "Undone");
    },
    "Undoing…",
    { history: true },
  );
}

/**
 * Applies one of Tidy's suggestions. Leftover history and archiving open their dialogs, which show
 * what will happen first; the rest apply at once, with Undo. A suggestion with nothing to apply does
 * nothing.
 */
export async function applyProposal(p: Proposal) {
  if (!p.action) return;
  if (p.category === "orphan") {
    useApp.setState({ modal: { kind: "orphan", id: p.id } });
    return;
  }
  if (p.action.type === "archive") {
    useApp.setState({ modal: { kind: "archive", id: p.action.nodeId } });
    return;
  }
  await run(
    async () =>
      changed(await api<Change>("apply", { id: p.id }), "Changes applied"),
    "Applying changes…",
    { history: true },
  );
}

/** Hides a suggestion, or with `undo` offers a hidden one again. */
export function dismissProposal(id: string, undo = false) {
  return run(async () => {
    await api("proposal/dismiss", { id, ...(undo ? { undo } : {}) });
    toast(undo ? "Suggestion is back" : "Suggestion dismissed");
  });
}
