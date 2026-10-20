// What Simple's buttons do that the shared actions don't: AI chats started for a fix or to carry on
// with a project, and the names of the apps they open. Each goes through the same requests and
// dialogs as Detailed, so the result is the same in both designs.
import { api } from "../api";
import { agentProviders } from "../agent-launch";
import { APP_NAMES, base, cap, isWholeDisk, sessionsOf } from "../helpers";
import { requestResume } from "../session-ui";
import { changed, run, toast, useApp } from "../store";
import type { Apps, Change, Node, SetupInfo, Snapshot } from "../types";
import { home, settings } from "../words";

/** The AI tools Laci can start, as `{ value, label }`. */
export const aiTools = (snapshot: Snapshot) =>
  agentProviders(snapshot.connectors);

/** The AI the buttons name: the first one Laci can start, as in "Ask Claude Code to do it". */
export function aiName(snapshot: Snapshot): string | undefined {
  return aiTools(snapshot)[0]?.label;
}

/**
 * Opens "Start an agent" with the engine's prompt for fixing `code`: it says what to do and what
 * never to do (force an upload, rewrite the history, delete a line of work).
 */
export function askFix(id: string, code: string) {
  return run(async () => {
    const { prompt, projectPath } = await api<{
      prompt: string;
      projectPath: string;
    }>("assistant/prompt", { kind: "fix", id, code });
    useApp.setState({ modal: { kind: "agent", projectPath, prompt } });
  });
}

/** The project's last chat that its AI can pick up again, if any. */
export function lastChat(n: Node, snapshot: Snapshot) {
  return sessionsOf(n, snapshot).find(
    (session) => session.resumeCapability === "supported" && !session.parentId,
  );
}

/** Carries on with a project: its last chat when that can be picked up, else a new one. */
export function continueWithAi(n: Node, snapshot: Snapshot) {
  const session = lastChat(n, snapshot);
  if (session) requestResume(session, n.id);
  else newChat(n);
}

/** "Start an agent" for the project, with `provider` chosen, or any to choose from. */
export function newChat(n: Node, provider?: string, prompt?: string) {
  useApp.setState({
    modal: { kind: "agent", projectPath: n.id, provider, prompt },
  });
}

/** The editor's name, as "VS Code". */
export const editorName = (apps: Apps) =>
  APP_NAMES[apps.editor] ?? cap(apps.editor);

/** The file manager's name: the one chosen in Settings. */
export const fileManagerName = (apps: Apps) =>
  APP_NAMES[apps.files] ?? cap(apps.files);

/**
 * Adds a project folder, keeping every other setting as it is saved: what Settings does when a
 * folder is added there. A whole disk ("/") is no project folder: a toast says so, and nothing
 * changes.
 */
export async function addProjectFolder(path: string) {
  if (isWholeDisk(path)) {
    toast(settings.wholeDisk, settings.wholeDiskNote, { error: true });
    return;
  }
  return run(
    async () => {
      const info = await api<SetupInfo>("setup/info");
      const result = await api<Change>("setup/save", {
        roots: [...new Set([...info.roots, path])],
        archiveDir: info.archiveDir ?? "",
        reportsDir: info.reportsDir ?? "",
        presets: info.presets,
        apps: info.apps,
        terminalTarget: info.terminalTarget ?? "internal",
      });
      changed(result, home.addedFolder, base(path));
    },
    home.addingFolder,
    { history: true },
  );
}
