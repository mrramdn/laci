// What a view asks the desktop for while it shows, the same in both designs: a project's health,
// its notes as the user types them, and the reports' search and text.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "./api";
import {
  base,
  reportList,
  reportsOfProject,
  reportsOfSessions,
} from "./helpers";
import { toast, useApp } from "./store";
import type { ReportFilter } from "./store";
import type {
  Health,
  Node,
  Report,
  ReportHit,
  ReportText,
  Snapshot,
} from "./types";

/**
 * What stands behind a project's checks (the `health` request), asked for again when the project or
 * its Git counts change. Null for a folder, and until the first reply. A request that fails keeps
 * the health from before, else says `failed`.
 */
export function useHealth(n: Node) {
  const [state, setState] = useState<{
    id: string;
    health?: Health;
    failed?: boolean;
  } | null>(null);
  const request = useRef(0);
  const git = n.git;
  const project = n.kind === "project";
  useEffect(() => {
    if (!project) return;
    const mine = ++request.current;
    api<Health>("health", { id: n.id })
      .then((health) => {
        if (mine === request.current) setState({ id: n.id, health });
      })
      .catch(() => {
        if (mine === request.current)
          setState((old) =>
            old?.id === n.id && old.health ? old : { id: n.id, failed: true },
          );
      });
  }, [
    project,
    n.id,
    n.revision,
    git?.dirty,
    git?.ahead,
    git?.commits,
    git?.stashes,
  ]);
  return project && state?.id === n.id ? state : null;
}

/**
 * A project's notes as the user edits them. Each change is saved 600 ms after the last key, and at
 * once on `flush` (for a blur) and when the view goes; saves run one after another. Notes changed
 * elsewhere replace the text only while nothing is waiting to be saved. `status` says where the
 * saving is. Give the view `key={node.id}`, so another project starts its own draft.
 */
export function useNotesDraft(node: Node) {
  const [text, setText] = useState(node.notes ?? "");
  const [status, setStatus] = useState("");
  const draft = useRef(node.notes ?? "");
  const saved = useRef(node.notes ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sequence = useRef(Promise.resolve());
  const mounted = useRef(true);
  const save = useCallback(
    (value: string) => {
      sequence.current = sequence.current.then(async () => {
        if (saved.current === value) return;
        if (mounted.current) setStatus("Saving…");
        try {
          const patched = await api<Node>("notes", {
            id: node.id,
            text: value,
          });
          saved.current = value;
          useApp.getState().patch(patched);
          if (mounted.current)
            setStatus(draft.current === value ? "Saved" : "Saving…");
        } catch (error) {
          if (mounted.current) setStatus("Couldn’t save");
          toast("Couldn’t save notes", errorText(error), { error: true });
        }
      });
    },
    [node.id],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      if (draft.current !== saved.current) save(draft.current);
    };
  }, [save]);
  useEffect(() => {
    if (draft.current === saved.current && node.notes !== saved.current) {
      draft.current = node.notes ?? "";
      saved.current = draft.current;
      setText(draft.current);
    }
  }, [node.notes]);
  /** The text as typed. */
  function change(value: string) {
    draft.current = value;
    setText(value);
    setStatus("Editing…");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(value), 600);
  }
  /** Saves what is typed now. */
  function flush() {
    clearTimeout(timer.current);
    save(draft.current);
  }
  return { text, status, change, flush };
}

/**
 * The reports a list shows: those `filter` narrows to, then those whose title, summary, projects or
 * open items have every word of `query`. From two characters on, the text inside the reports is
 * searched too, 250 ms after the last key: `found` holds those hits once they are in (`failed` if the
 * search failed), and `fullText` says one is due.
 */
export function useReportSearch(
  snapshot: Snapshot,
  query: string,
  filter: ReportFilter,
) {
  const dir = snapshot.reportsDir;
  const enabled = Boolean(dir && !dir.error);
  const all = reportList(snapshot);
  const [hits, setHits] = useState<{
    query: string;
    snippets: Map<string, string>;
    failed?: boolean;
  }>({ query: "", snippets: new Map() });
  const searchSeq = useRef(0);
  const needle = query.trim();
  const fullText = needle.length >= 2 && enabled;
  useEffect(() => {
    if (!fullText) return;
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      api<ReportHit[]>("reports/search", { query: needle }).then(
        (found) => {
          if (searchSeq.current === seq)
            setHits({
              query: needle,
              snippets: new Map(found.map((hit) => [hit.id, hit.snippet])),
            });
        },
        () => {
          if (searchSeq.current === seq)
            setHits({ query: needle, snippets: new Map(), failed: true });
        },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [needle, fullText, snapshot.reports]);
  const found = fullText && hits.query === needle ? hits : undefined;
  const shown = useMemo(() => {
    const scoped =
      filter && "sessions" in filter
        ? reportsOfSessions(snapshot, filter.sessions)
        : filter && "project" in filter
          ? reportsOfProject(snapshot, filter.project)
          : all;
    const terms = needle.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return scoped;
    return scoped.filter((r) => {
      const text = [
        r.title,
        r.summary,
        r.scope,
        r.id,
        ...r.open,
        ...r.projects.map(
          (path) => snapshot.nodes[path]?.label ?? base(path),
        ),
      ]
        .join(" ")
        .toLowerCase();
      return (
        terms.every((term) => text.includes(term)) ||
        Boolean(found?.snippets.has(r.id))
      );
    });
  }, [snapshot, all, filter, needle, found]);
  return { needle, fullText, found, shown };
}

/** Texts already read, by report and version, so going back to one shows it at once. */
const texts = new Map<string, string>();
/**
 * A report's text (`reports/read`); the last 30 read are kept. `error` says why it couldn't be read,
 * and `retry` asks again.
 */
export function useReportText(report: Report) {
  const key = `${report.id}\n${report.modified}`;
  const [state, setState] = useState<{ raw?: string; error?: string }>(() =>
    texts.has(key) ? { raw: texts.get(key) } : {},
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (texts.has(key)) {
      setState({ raw: texts.get(key) });
      return;
    }
    let live = true;
    // A newer version replaces the text when it arrives; until then the last one stays.
    api<ReportText>("reports/read", { id: report.id }).then(
      (read) => {
        texts.set(key, read.raw);
        if (texts.size > 30) {
          const oldest = texts.keys().next().value;
          if (oldest !== undefined) texts.delete(oldest);
        }
        if (live) setState({ raw: read.raw });
      },
      (error) => {
        if (live) setState((was) => ({ ...was, error: errorText(error) }));
      },
    );
    return () => {
      live = false;
    };
  }, [key, report.id, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/** readme.ts, which draws Markdown with marked and DOMPurify. */
type Markdown = typeof import("./readme");
let markdown: Markdown | undefined;
let markdownLoading: Promise<Markdown | undefined> | undefined;
/**
 * Loads readme.ts, and marked and DOMPurify with it, the first time anything asks: they are not part
 * of the code a window starts with. A view that will soon draw Markdown asks ahead. Undefined if it
 * couldn't load; the next ask tries again.
 */
export function loadMarkdown() {
  markdownLoading ??= import("./readme").then(
    (module) => (markdown = module),
    () => {
      markdownLoading = undefined;
      return undefined;
    },
  );
  return markdownLoading;
}
/**
 * readme.ts once it is in, else undefined while it loads. Until then a view draws no Markdown at all,
 * never its raw text. A view drawn after the first load has it at once.
 */
export function useMarkdown() {
  const [loaded, setLoaded] = useState(markdown);
  useEffect(() => {
    if (loaded) return;
    let live = true;
    void loadMarkdown().then((module) => {
      if (live && module) setLoaded(module);
    });
    return () => {
      live = false;
    };
  }, [loaded]);
  return loaded ?? markdown;
}
