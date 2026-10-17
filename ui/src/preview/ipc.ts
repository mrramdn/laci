import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { AgentCapabilities } from "../agent-launch";
import type { CreationJob } from "../new-project";
import type {
  ActivityLog,
  Apps,
  ArchivePlan,
  Change,
  DeletePlan,
  Health,
  Listing,
  LogEntry,
  McpStatus,
  NewInfo,
  Node,
  Proposal,
  ReportHit,
  ReportText,
  SetupInfo,
  Snapshot,
  Storage,
  TerminalInfo,
} from "../types";
import raw from "./fixtures.json";

type Body = Record<string, unknown>;
type Handler = (body: Body) => unknown;
export type Os = "linux" | "macos" | "windows";
export type Design = "detailed" | "simple";
export type Theme = "light" | "dark" | "system";

/**
 * What `scripts/ui-fixtures.mjs` recorded from the engine on the demo home. A request with one
 * answer is a plain field. One that depends on a project or a folder is a map from its id or path
 * to the answer.
 */
interface Fixtures {
  meta: { now: string; home: string };
  snapshot: Snapshot;
  apps: Apps;
  log: ActivityLog;
  storage: Storage;
  "setup/info": SetupInfo;
  "setup/discover": { candidates: SetupInfo["candidates"]; limited: boolean };
  "new/info": NewInfo & {
    recipes: {
      id: string;
      program: string;
      args: string[];
      runtime?: string;
      download: boolean;
    }[];
  };
  "agent/mcp": { agents: McpStatus[] };
  "agent/models": Record<string, AgentCapabilities>;
  "assistant/prompt": {
    review: unknown;
    tasks: { id: string; file: string; text: string; reply: unknown }[];
  };
  health: Record<string, Health>;
  "archive/plan": Record<string, ArchivePlan>;
  "delete/plan": Record<string, DeletePlan>;
  ls: Record<string, Listing>;
  "ls/newest": Record<string, Record<string, string>>;
  "reports/read": Record<string, ReportText>;
}
const fixtures = raw as Fixtures;
/** The time the demo home was made for. The preview's clock starts here. */
export const fixtureNow = fixtures.meta.now;

const clone = <T>(value: T): T => structuredClone(value);
/** Errors reach the window as text, as they do from the desktop. */
function fail(message: string): never {
  throw message;
}
const text = (body: Body, key: string) =>
  typeof body[key] === "string" ? (body[key] as string) : "";
const lookup = <T>(table: Record<string, T>, key: string, what: string): T =>
  table[key] ??
  fail(
    `The preview has no ${what} for ${key}. Run scripts/ui-fixtures.mjs again, or add it.`,
  );

/**
 * The preview's own copy of what the engine holds. Mutations change it, and a reload starts again
 * from the fixtures: nothing is saved anywhere.
 */
let snapshot: Snapshot;
let log: LogEntry[];
let storage: Storage;
let mcp: McpStatus[];
let settings: { theme: Theme; design: Design; os: Os };
let revision = 1;
let serial = 0;
/** Undoes one Log entry. An entry without one cannot be undone. */
const undoers = new Map<string, () => void>();
/** Suggestions the user dismissed, whole, so that "Suggest again" can bring them back. */
const dismissed = new Map<string, Proposal>();
let job: { state: CreationJob; started: number; acknowledged: boolean } | null =
  null;

const node = (id: string): Node =>
  snapshot.nodes[id] ??
  fail("That folder is not in the last scan. Rescan and try again.");
const stamped = (): Snapshot => ({
  ...snapshot,
  revision,
  historyPending: false,
});

/** Adds a Log entry. `undo` undoes it. Leave it out for a change without Undo, such as Trash. */
function record(
  title: string,
  undo?: () => void,
  extra: Partial<LogEntry> = {},
): LogEntry {
  const entry: LogEntry = {
    id: `preview-${++serial}`,
    at: new Date().toISOString(),
    by: "app",
    title,
    state: "applied",
    canUndo: Boolean(undo),
    ...extra,
  };
  log.unshift(entry);
  if (undo) undoers.set(entry.id, undo);
  return entry;
}
/** The answer to a journaled change: its toast can undo it, as well as the Log. */
function changed(title: string, undo: () => void = () => {}): Change {
  const entry = record(title, undo);
  entry.journal = entry.id;
  return {
    revision: ++revision,
    journal: { id: entry.id, title, canUndo: true },
  };
}
/** The answer to a change without a journal, like saved settings: the Log can undo it, its toast cannot. */
function logged(title: string, undo?: () => void): Change {
  record(title, undo);
  return { revision: ++revision };
}
function undo(id: string): Change {
  const entry =
    log.find((e) => e.id === id || e.journal === id) ??
    fail("That change is no longer in the Log.");
  if (entry.state === "undone") fail("That change was already undone.");
  undoers.get(entry.id)?.();
  entry.state = "undone";
  entry.canUndo = false;
  record(`Undid: ${entry.title}`, undefined, { undoes: entry.id });
  return {
    revision: ++revision,
    journal: { id: entry.id, title: entry.title, canUndo: false },
  };
}

/** `todo`, `meta` and `notes` answer with the changed project, which the window swaps in. */
function edit(
  id: string,
  change: (n: Node) => { title: string; undo: () => void },
): Node {
  const n = node(id);
  const done = change(n);
  record(done.title.replace("{name}", n.name), done.undo, { path: n.path });
  revision++;
  return { ...n, revision };
}
function todo(body: Body): Node {
  const file = text(body, "file");
  const label = text(body, "text");
  const op = text(body, "op");
  return edit(text(body, "id"), (n) => {
    if (op === "add") {
      const added = label.trim() || fail("Write something first");
      const line = Math.max(0, ...n.tasks.map((t) => t.line)) + 1;
      n.tasks.push({
        text: added,
        done: false,
        kind: "check",
        file: ".laci.md",
        line,
        section: "Next",
      });
      n.sidecar = true;
      const gone = () => {
        const at = n.tasks.findIndex((t) => t.text === added && t.line === line);
        // Already deleted: refuse as the engine does, instead of removing another to-do.
        if (at < 0)
          fail("It was changed again after this. Undo the newer change first.");
        n.tasks.splice(at, 1);
      };
      return { title: "Added a next step to {name}", undo: gone };
    }
    const at = n.tasks.findIndex(
      (t) =>
        t.file === file &&
        t.text === label &&
        (!body.line || t.line === body.line),
    );
    if (at < 0) fail("Couldn't identify that checkbox. Rescan and try again.");
    const task = n.tasks[at];
    if (op === "toggle") {
      const was = task.done;
      task.done = body.done === true;
      const verb = task.done ? "Ticked" : "Unticked";
      return {
        title: `${verb} a to-do in {name}`,
        undo: () => void (task.done = was),
      };
    }
    if (op === "edit") {
      task.text = text(body, "to").trim() || fail("Write something first");
      return {
        title: "Edited a to-do in {name}",
        undo: () => void (task.text = label),
      };
    }
    if (op === "delete") {
      n.tasks.splice(at, 1);
      return {
        title: "Deleted a next step from {name}",
        undo: () => void n.tasks.splice(at, 0, task),
      };
    }
    return fail("Unknown to-do operation");
  });
}
function meta(body: Body): Node {
  const key = text(body, "key") as keyof Node["meta"];
  const value = text(body, "value");
  return edit(text(body, "id"), (n) => {
    const was = {
      meta: { ...n.meta },
      status: { ...n.status },
      issues: clone(n.issues),
    };
    if (value) (n.meta as Record<string, string>)[key] = value;
    else delete n.meta[key];
    if (key === "status")
      n.status = { value: value || was.status.value, auto: !value };
    if (key === "quiet")
      for (const issue of n.issues)
        issue.muted = value.split(",").includes(issue.code);
    const label = `${key.charAt(0).toUpperCase()}${key.slice(1)} of {name}`;
    return {
      title: `${label} ${value ? `set to ${value}` : "cleared"}`,
      undo: () => void Object.assign(n, was),
    };
  });
}
function notes(body: Body): Node {
  return edit(text(body, "id"), (n) => {
    const was = n.notes;
    n.notes = text(body, "text");
    return {
      title: "Edited the notes of {name}",
      undo: () => void (n.notes = was),
    };
  });
}

function archive(body: Body): Change {
  const n = node(text(body, "id"));
  const was = {
    archived: n.archived,
    status: { ...n.status },
    meta: { ...n.meta },
  };
  const now = {
    archived: true,
    status: { value: "archived", auto: false },
    meta: { ...n.meta, status: "archived" },
  };
  Object.assign(n, now);
  return changed(`Archived ${n.name}`, () => void Object.assign(n, was));
}
function apply(body: Body): Change {
  const at = snapshot.proposals.findIndex((p) => p.id === text(body, "id"));
  if (at < 0) fail("That suggestion is gone");
  const [proposal] = snapshot.proposals.splice(at, 1);
  return changed(
    `Applied: ${proposal.title}`,
    () => void snapshot.proposals.splice(at, 0, proposal),
  );
}
function dismiss(body: Body) {
  const id = text(body, "id");
  if (body.undo === true) {
    const proposal = dismissed.get(id) ?? fail("That suggestion is gone");
    dismissed.delete(id);
    snapshot.dismissed = (snapshot.dismissed ?? []).filter((d) => d.id !== id);
    snapshot.proposals.push(proposal);
    record(`Suggested again: ${proposal.title}`);
  } else {
    const at = snapshot.proposals.findIndex((p) => p.id === id);
    if (at < 0) fail("That suggestion is gone");
    const [proposal] = snapshot.proposals.splice(at, 1);
    dismissed.set(id, proposal);
    (snapshot.dismissed ??= []).push({
      id,
      title: proposal.title,
      at: new Date().toISOString(),
    });
    record(`Dismissed: ${proposal.title}`);
  }
  revision++;
  return { ok: true };
}
function clean(body: Body): Change {
  const n = node(text(body, "id"));
  const size = n.size ?? fail("Nothing to clean in this project");
  n.size = { total: size.total - size.reclaimable, reclaimable: 0, parts: [] };
  return changed(
    `Deleted the build output of ${n.name}`,
    () => void (n.size = size),
  );
}
function deleteSessions(body: Body): Change {
  const files = new Set(
    Array.isArray(body.files) ? (body.files as string[]) : [],
  );
  const was = snapshot.sessions ?? [];
  snapshot.sessions = was.filter((s) => !files.has(s.file));
  return changed(
    `Deleted ${files.size} session file${files.size === 1 ? "" : "s"}`,
    () => void (snapshot.sessions = was),
  );
}
/** Closes or reopens an open item of a report. Laci's record changes, never the report's file. */
function closeItem(body: Body) {
  const report =
    snapshot.reports?.find((r) => r.id === text(body, "report")) ??
    fail("That report is not in the last scan.");
  const state = text(body, "state") || "done";
  const closed = (report.closed ??= []);
  // An item is its 1-based place in the list, or its text.
  const wanted = typeof body.item === "string" ? body.item : undefined;
  const place = (list: string[]) =>
    wanted === undefined ? Number(body.item) - 1 : list.indexOf(wanted);
  if (state === "open") {
    const item = closed[place(closed)] ?? fail("That item is not closed.");
    closed.splice(closed.indexOf(item), 1);
    report.open.push(item);
    report.openCount += 1;
  } else {
    const item =
      report.open[place(report.open)] ?? fail("That item is not open.");
    report.open.splice(report.open.indexOf(item), 1);
    closed.push(item);
    report.openCount = Math.max(0, report.openCount - 1);
  }
  report.closedCount = closed.length;
  record(
    state === "open"
      ? "Opened a report item again"
      : `Closed a report item as ${state}`,
    undefined,
    {
      detail: report.title,
    },
  );
  revision++;
  return { ok: true };
}
function backup(body: Body) {
  if (body.auto === true) return { skipped: true };
  const state = snapshot.backup ?? { auto: false };
  const dest = "~/.local/share/laci/history";
  const copied = state.pending === 0 ? 0 : 3;
  snapshot.backup = {
    ...state,
    at: new Date().toISOString(),
    pending: 0,
    sessions: 6,
    files: 9,
    bytes: 40960,
    dest,
  };
  record(
    copied
      ? `Backed up ${copied} agent history files`
      : "Agent history backup is up to date",
    undefined,
    {
      detail: `6 sessions kept · 40.0 KB in ${dest}`,
    },
  );
  revision++;
  return {
    copied,
    size: copied ? "12.0 KB" : "0 B",
    dest,
    sessions: 6,
    total: 40960,
  };
}
function backupAuto(body: Body) {
  const on = body.on === true;
  if (snapshot.backup) snapshot.backup.auto = on;
  record(`Automatic history backup turned ${on ? "on" : "off"}`);
  revision++;
  return { on };
}
function free(body: Body) {
  const part =
    storage.parts.find((p) => p.id === text(body, "part")) ??
    fail("That part cannot be freed");
  const freed = part.free || fail("That part cannot be freed");
  storage.total -= freed;
  Object.assign(part, { bytes: part.bytes - freed, free: 0 });
  record(`Freed ${part.label.toLowerCase()}`, undefined, {
    detail: `${freed} bytes freed`,
  });
  revision++;
  return { freed, title: `Freed ${part.label.toLowerCase()}` };
}
function applyMcp(body: Body) {
  const status =
    mcp.find((s) => s.provider === text(body, "provider")) ??
    fail("Unknown agent");
  const remove = body.remove === true;
  status.state = remove ? "missing" : "registered";
  if (remove) delete status.current;
  else status.current = `${status.laci} mcp`;
  record(
    `${remove ? "Removed" : "Added"} Laci ${remove ? "from" : "to"} ${status.name}`,
  );
  return { status };
}
function search(query: string): ReportHit[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  if (!words.length || query.trim().length > 200)
    fail("Search for 1 to 200 characters");
  const hits: ReportHit[] = [];
  for (const report of snapshot.reports ?? []) {
    const body = fixtures["reports/read"][report.id]?.raw ?? "";
    const lower = body.toLowerCase();
    if (!words.every((word) => lower.includes(word))) continue;
    // The text around the words together where they are, else around the longest one.
    const phrase = words.join(" ");
    const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
    const found = lower.includes(phrase) ? phrase : longest;
    const at = lower.indexOf(found);
    const start = Math.max(0, at - 60);
    const end = Math.min(body.length, at + found.length + 60);
    const around = body
      .slice(start, end)
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    hits.push({
      id: report.id,
      snippet: `${start > 0 ? "…" : ""}${around}${end < body.length ? "…" : ""}`,
    });
  }
  return hits;
}

/** New project: a job that runs for a moment, then has made the folder. */
function startJob(body: Body) {
  const request = {
    ...body,
    agent: body.agent ?? null,
  } as unknown as CreationJob["request"];
  const state: CreationJob = {
    id: `preview-job-${++serial}`,
    status: "running",
    output: "",
    request,
    continuation: request.agent ? { status: "pending", attempt: 0 } : null,
  };
  job = { state, started: Date.now(), acknowledged: false };
  return state;
}
function jobState(id: string): CreationJob {
  if (job?.state.id !== id) fail("That creation job is no longer available");
  const current = job as NonNullable<typeof job>;
  if (
    current.state.status === "running" &&
    Date.now() - current.started > 600
  ) {
    const { name, parent } = current.state.request;
    const path = `${parent.replace(/\/$/, "")}/${name}`;
    record(`Created ${name}`, undefined, { path });
    current.state.status = "completed";
    current.state.output = `Created ${path}\n`;
    current.state.result = { revision: ++revision, path, warnings: [] };
  }
  return current.state;
}
function continueJob(id: string): CreationJob {
  const state = jobState(id);
  if (state.continuation?.status === "pending") {
    const terminal: TerminalInfo = {
      id: `preview-term-${++serial}`,
      cwd: state.result?.path ?? "",
      title: "Agent",
    };
    state.continuation = {
      status: "completed",
      attempt: 1,
      result: { terminal },
    };
  }
  return state;
}

/** Answers that only the desktop knows, not the engine. */
const desktop: Record<string, Handler> = {
  status: () => ({
    type: "status",
    busy: false,
    revision,
    historyPending: false,
  }),
  "new/current": () => (job && !job.acknowledged ? job.state : null),
  "new/status": (body) => jobState(text(body, "id")),
  "new/continue": (body) => continueJob(text(body, "id")),
  "new/ack": () => {
    if (job) job.acknowledged = true;
    return null;
  },
  "new/cancel": () => {
    if (job?.state.status === "running") job.state.status = "cancelled";
    return null;
  },
  "agent/models": (body) => {
    const caps = lookup(
      fixtures["agent/models"],
      text(body, "provider"),
      "model list",
    );
    return body.refresh === true ? { ...caps, listed: true } : caps;
  },
  "agent/launch": (body) => {
    if (body.target === "external") return { target: "external" };
    const name =
      fixtures["agent/models"][text(body, "provider")]?.name ?? "Agent";
    const terminal: TerminalInfo = {
      id: `preview-term-${++serial}`,
      cwd: text(body, "projectPath"),
      title: name,
    };
    return { target: "internal", terminal };
  },
  // The window's settings request and the ones that save them.
  prefs: () => ({
    theme: settings.theme === "system" ? "" : settings.theme,
    design: settings.design,
    configured: true,
    configPath: "~/.config/laci/config.json",
    os: settings.os,
  }),
  design: (body) => {
    settings.design = text(body, "design") as Design;
    return { design: settings.design };
  },
  theme: (body) => {
    settings.theme = (text(body, "theme") || "system") as Theme;
    return { theme: text(body, "theme") };
  },
  "pick/folder": () => ({ path: `${fixtures.meta.home}/project` }),
};

const reads: Record<string, Handler> = {
  snapshot: stamped,
  rescan: stamped,
  apps: () => fixtures.apps,
  "setup/info": () => fixtures["setup/info"],
  "setup/discover": () => fixtures["setup/discover"],
  "new/info": () => fixtures["new/info"],
  storage: () => storage,
  log: () => ({ entries: log, file: fixtures.log.file }),
  "agent/mcp": () => ({ agents: mcp }),
  health: (body) => lookup(fixtures.health, text(body, "id"), "health data"),
  "archive/plan": (body) =>
    lookup(fixtures["archive/plan"], text(body, "id"), "archive plan"),
  "delete/plan": (body) =>
    lookup(fixtures["delete/plan"], text(body, "id"), "Trash plan"),
  ls: (body) => {
    const path = text(body, "path");
    if (fixtures.ls[path]) return fixtures.ls[path];
    // A folder nobody recorded, such as one of Git's own: it exists, but nobody looks inside.
    if (path.startsWith(`${fixtures.meta.home}/`)) return { path, entries: [] };
    return fail("Path must be inside your home folder");
  },
  "ls/newest": (body) => fixtures["ls/newest"][text(body, "path")] ?? {},
  "assistant/prompt": (body) => {
    if (text(body, "kind") === "review")
      return fixtures["assistant/prompt"].review;
    const found = fixtures["assistant/prompt"].tasks.find(
      (t) =>
        t.id === text(body, "id") &&
        t.file === text(body, "file") &&
        t.text === text(body, "text"),
    );
    return (
      found?.reply ??
      fail("That to-do is no longer open. Refresh and try again.")
    );
  },
  "reports/read": (body) =>
    lookup(fixtures["reports/read"], text(body, "id"), "report"),
  "reports/search": (body) => search(text(body, "query")),
  "new/preview": (body) => {
    const recipe =
      fixtures["new/info"].recipes.find((r) => r.id === text(body, "recipe")) ??
      fail("Choose a recipe");
    const fill = (arg: string) =>
      arg
        .replace("{name}", text(body, "name") || "my-app")
        .replace("{template}", text(body, "generatorTemplate"));
    return {
      command: [recipe.program, ...recipe.args.map(fill)].join(" "),
      runtime: recipe.runtime ?? "",
      runtimeVersion: "v24.0.0",
      download: recipe.download,
      missing: [],
    };
  },
};

/** Changes. Each one says what it did in the Log and moves the revision on, as the engine does. */
const writes: Record<string, Handler> = {
  meta,
  todo,
  notes,
  archive,
  apply,
  clean,
  undo: (body) => undo(text(body, "id")),
  "log/undo": (body) => {
    undo(text(body, "id"));
    return { revision };
  },
  "proposal/dismiss": dismiss,
  "report/close": closeItem,
  "session/delete": deleteSessions,
  backup,
  "backup/auto": backupAuto,
  "storage/free": free,
  "agent/mcp/apply": applyMcp,
  "setup/save": () => logged("Changed settings", () => {}),
  delete: (body) => {
    const n = node(text(body, "id"));
    record(`Moved ${n.name} to system Trash`, undefined, {
      path: n.path,
      detail: "Restore through your file manager.",
    });
    return { revision: ++revision };
  },
  "connector/add": () => logged("Added a connector", () => {}),
  "connector/remove": () => logged("Removed a connector", () => {}),
  "backup/restore": () => logged("Restored a session from the backup"),
  "session/keep": () => ({ changed: 0 }),
  "new/start": startJob,
  "new/template": (body) => ({
    templates: [text(body, "path")],
    path: text(body, "path"),
  }),
  "new/recipe": (body) => ({
    recipes: [...fixtures["new/info"].recipes, body.recipe],
  }),
  open: () => ({ ok: true, shown: false }),
  "open/url": () => ({ ok: true }),
  "log/open": () => ({ ok: true }),
  "reports/open": () => ({ ok: true }),
};
// These change nothing the window shows, so the window needs no word about them.
const quiet = new Set([
  "open",
  "open/url",
  "log/open",
  "reports/open",
  "new/template",
  "new/recipe",
]);

async function answer(name: string, body: Body): Promise<unknown> {
  const handler = desktop[name] ?? reads[name];
  if (handler) return clone(await handler(body));
  const write = writes[name];
  if (!write)
    return fail(
      `The preview has no answer for "${name}". Add one to ui/src/preview/ipc.ts.`,
    );
  const reply = clone(await write(body));
  // The desktop tells the window what changed, and the window asks again.
  if (!quiet.has(name))
    setTimeout(() => {
      void emit("laci", { type: "snapshot" });
      void emit("laci", { type: "log" });
      void emit("laci", {
        type: "status",
        busy: false,
        revision,
        historyPending: false,
      });
    }, 0);
  return reply;
}

/** A terminal that shows a prompt and repeats what is typed. The real shell is the desktop's. */
const channels = new Map<string, { onmessage: (message: unknown) => void }>();
const prompt = () => "\x1b[32mdemo\x1b[0m:\x1b[34m~\x1b[0m$ ";
const terminals: Record<string, (args: Body) => unknown> = {
  term_list: () => [],
  term_open: (args) => {
    const cwd =
      typeof args.id === "string" && args.id ? args.id : fixtures.meta.home;
    const info: TerminalInfo = {
      id: `preview-term-${++serial}`,
      cwd,
      title: cwd.split("/").pop() || "~",
    };
    return info;
  },
  term_attach: (args) => {
    const output = args.output as { onmessage: (message: unknown) => void };
    channels.set(String(args.id), output);
    output.onmessage({
      type: "data",
      data: `This terminal belongs to the preview. Nothing runs here.\r\n${prompt()}`,
    });
  },
  term_input: (args) => {
    const data = String(args.data).replace(/\r/g, `\r\n${prompt()}`);
    channels.get(String(args.id))?.onmessage({ type: "data", data });
  },
  term_resize: () => null,
  term_close: (args) => void channels.delete(String(args.id)),
};

/** Stands in for the desktop. Call before the window's own code is loaded. */
export function installIpc(options: { os: Os; design: Design; theme: Theme }) {
  snapshot = clone(fixtures.snapshot);
  log = clone(fixtures.log.entries);
  storage = clone(fixtures.storage);
  mcp = clone(fixtures["agent/mcp"].agents);
  settings = { ...options };
  mockConvertFileSrc(options.os === "windows" ? "windows" : "linux");
  mockIPC(
    (command, payload) => {
      if (command === "request") {
        const { name, body } = payload as { name: string; body?: Body };
        return answer(name, body ?? {});
      }
      const terminal = terminals[command];
      if (terminal) return clone(terminal((payload ?? {}) as Body));
      return Promise.reject(
        `The preview has no answer for the command "${command}".`,
      );
    },
    { shouldMockEvents: true },
  );
  // The event mock takes a listener off by `id`, but `unlisten` names it `eventId`. So a listener
  // that was removed (React's second mount removes one) stays and warns on every event.
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals })
    .__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  internals.invoke = (command, args, options) =>
    invoke(
      command,
      command === "plugin:event|unlisten"
        ? { ...args, id: args?.eventId }
        : args,
      options,
    );
}
interface Internals {
  invoke: (command: string, args?: Body, options?: unknown) => Promise<unknown>;
}

/** Fires an event at the window, as the desktop does. */
export function emitEvent(name: string, payload?: unknown) {
  return emit(name, payload);
}
