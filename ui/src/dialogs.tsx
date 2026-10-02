import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, errorText } from "./api";
import { useApp, changed, toast } from "./store";
import { parentOf, plural, tilde, within } from "./helpers";
import { Icon, Ops, SeverityGlyph } from "./common";
import type { Change, Link, NewInfo, Snapshot } from "./types";
function close() {
  useApp.setState({ modal: null });
}
function DialogFrame({
  title,
  description,
  children,
  footer,
  form,
  onSubmit,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  form?: boolean;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const host = ref.current;
    host
      ?.querySelector<HTMLElement>("input:not([type=checkbox]),button,select")
      ?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(
        host?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea,[tabindex="0"]',
        ) ?? [],
      ).filter((e) => e.offsetParent !== null);
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    host?.addEventListener("keydown", key);
    return () => {
      host?.removeEventListener("keydown", key);
      before?.focus();
    };
  }, []);
  const body = (
    <>
      <div className="dh">
        <h2 id="dialog-title">{title}</h2>
        <p className="desc">{description}</p>
      </div>
      <div className="db">{children}</div>
      <div className="df">{footer}</div>
    </>
  );
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      ref={ref}
    >
      {form ? (
        <form
          className="dialog cform"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
          onSubmit={onSubmit}
        >
          {body}
        </form>
      ) : (
        <div
          className="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
        >
          {body}
        </div>
      )}
    </div>
  );
}
export function Dialogs() {
  const modal = useApp((s) => s.modal);
  return modal?.kind === "shortcuts" ? (
    <Shortcuts />
  ) : modal?.kind === "archive" ? (
    <Archive id={modal.id} />
  ) : modal?.kind === "new" ? (
    <NewProject />
  ) : modal?.kind === "connector" ? (
    <ConnectorDialog />
  ) : null;
}
function Shortcuts() {
  const sections = [
    [
      "Navigation",
      [
        ["Command palette", ["Ctrl", "K"]],
        ["Next / Prev row", ["↓", "↑"]],
        ["Open / Select", ["↵"]],
        ["Parent folder", ["⌫"]],
        ["Close / Dismiss", ["Esc"]],
      ],
    ],
    [
      "Workspace",
      [
        ["Toggle terminal", ["F4", "Ctrl `"]],
        ["Toggle hidden files", ["Ctrl", "H"]],
        ["Shortcuts help", ["?"]],
      ],
    ],
  ] as const;
  return (
    <DialogFrame
      title="Keyboard shortcuts"
      description="Quick navigation and handy power actions."
      footer={
        <>
          <span className="grow" />
          <button className="btn primary" onClick={close}>
            Got it
          </button>
        </>
      }
    >
      <div className="short-grid">
        {sections.map(([title, rows]) => (
          <div className="short-sec" key={title}>
            <h3>{title}</h3>
            {rows.map(([label, keys]) => (
              <div className="short-row" key={label}>
                <span>{label}</span>
                <div className="short-keys">
                  {keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </DialogFrame>
  );
}
function Archive({ id }: { id: string }) {
  const s = useApp();
  const n = s.snapshot!.nodes[id];
  const plan = n?.archivePlan;
  const [heavy, setHeavy] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  if (!n || !plan) return null;
  async function archive() {
    setSaving(true);
    useApp.setState({ working: `Archiving ${n.name}…` });
    try {
      const change = await api<Change>("archive", { id, trashHeavy: heavy });
      close();
      changed(change, `Archived ${n.name}`);
      if (change.snapshot?.nodes[plan!.dest]) s.select(plan!.dest);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
      useApp.setState({ working: "" });
    }
  }
  return (
    <DialogFrame
      title={`Archive ${n.name}?`}
      description={
        <>
          Moves it to{" "}
          <span className="mono">{tilde(plan.dest, s.snapshot!.home)}</span> and
          takes its agent history along, so sessions and memory still open from
          the new place.
        </>
      }
      footer={
        <>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : (
            <p>
              {heavy
                ? "Written to an undo journal first. Undo puts the folder and its history back; deleted dependencies and build output remain in the system trash."
                : "Written to an undo journal first. Undo puts the folder and its history back."}
            </p>
          )}
          <button className="btn" disabled={saving} onClick={close}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={saving}
            onClick={() => void archive()}
          >
            Archive
          </button>
        </>
      }
    >
      {plan.checks.length ? (
        <div className="warnbox">
          {plan.checks.map((check, i) => (
            <div className="issue" key={i}>
              <SeverityGlyph severity={check.severity} />
              <div className="txt">
                <p>{check.title}</p>
                <p className="d">
                  {[
                    check.detail,
                    ["no-remote", "no-commits"].includes(check.code)
                      ? "Archiving keeps it on this disk only"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(". ")}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="sec-t">{plural(plan.ops.length, "change")}</div>
      <Ops ops={plan.ops} optional onHeavy={setHeavy} />
    </DialogFrame>
  );
}
function NewProject() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const initialParent =
    s.view === "folder" && within(s.cwd, snapshot.home)
      ? snapshot.nodes[s.cwd]?.kind === "project"
        ? parentOf(s.cwd)
        : s.cwd
      : (snapshot.roots[0] ?? snapshot.home);
  const [info, setInfo] = useState<NewInfo | null>(null);
  const [draft, setDraft] = useState({
    name: "",
    parent: initialParent,
    summary: "",
    from: "empty",
    template: "",
    url: "",
    remote: "none",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void api<NewInfo>("new/info").then(
      (info) => {
        if (live) {
          setInfo(info);
          setDraft((d) => ({
            ...d,
            template: d.template || info.templates[0] || "",
          }));
        }
      },
      (error) => live && setError(errorText(error)),
    );
    return () => {
      live = false;
    };
  }, []);
  function update(key: keyof typeof draft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  const parents = [
    ...new Set([
      draft.parent,
      ...snapshot.roots,
      ...Object.values(snapshot.nodes)
        .filter((n) => n.kind === "folder" && !n.archived)
        .map((n) => n.path),
    ]),
  ];
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");
    useApp.setState({
      working: draft.from === "clone" ? "Cloning…" : "Creating the project…",
    });
    try {
      const result = await api<Change>("new", draft);
      if (result.snapshot) s.load(result.snapshot);
      s.cd(draft.parent);
      if (result.path && result.snapshot?.nodes[result.path])
        s.select(result.path);
      close();
      toast(
        `Created ${draft.name}`,
        result.warnings?.length
          ? result.warnings.join(". ")
          : tilde(result.path, snapshot.home),
        { error: !!result.warnings?.length },
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
      useApp.setState({ working: "" });
    }
  }
  return (
    <DialogFrame
      title="New project"
      description="Makes the folder, starts git with a first commit, and sets it up in laci."
      form
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : (
            <p className="mono">
              {tilde(`${draft.parent}/${draft.name || "name"}`, snapshot.home)}
            </p>
          )}
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={close}
          >
            Cancel
          </button>
          <button className="btn primary" disabled={saving}>
            {saving ? "Creating…" : "Create project"}
          </button>
        </>
      }
    >
      <div className="row2">
        <label className="fld">
          <span>Name</span>
          <input
            className="inp mono"
            value={draft.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="my-app"
            autoComplete="off"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
            maxLength={100}
          />
        </label>
        <label className="fld">
          <span>In</span>
          <select
            className="inp mono"
            value={draft.parent}
            onChange={(e) => update("parent", e.target.value)}
          >
            {parents.map((path) => (
              <option key={path} value={path}>
                {tilde(path, snapshot.home)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="fld">
        <span>
          What is it?{" "}
          <span className="faint" style={{ fontWeight: 400 }}>
            Optional
          </span>
        </span>
        <input
          className="inp"
          value={draft.summary}
          onChange={(e) => update("summary", e.target.value)}
          placeholder="Landing page for the coffee shop"
          maxLength={300}
          autoComplete="off"
        />
        <small>Goes into the README and the project's summary.</small>
      </label>
      <div className="fld">
        <span>Start from</span>
        <div className="choices">
          {[
            ["empty", "Empty folder", "A README and nothing else."],
            [
              "template",
              "A template",
              info?.templates.length
                ? `Copies a folder from ${info.templatesDir}`
                : `None yet. Put starter folders in ${info?.templatesDir ?? "~/.config/laci/templates"} to use them here.`,
            ],
            ["clone", "Clone a repo", "From GitHub, GitLab or any git URL."],
          ].map(([value, title, description]) => (
            <label className="choice" key={value}>
              <input
                type="radio"
                name="from"
                value={value}
                checked={draft.from === value}
                disabled={value === "template" && !info?.templates.length}
                onChange={() => update("from", value)}
              />
              <div>
                <b>{title}</b>
                <p>{description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>
      {draft.from === "template" && info?.templates.length ? (
        <label className="fld">
          <span>Template</span>
          <select
            className="inp"
            value={draft.template}
            onChange={(e) => update("template", e.target.value)}
          >
            {info.templates.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      ) : null}
      {draft.from === "clone" ? (
        <label className="fld">
          <span>Repo URL</span>
          <input
            className="inp mono"
            value={draft.url}
            onChange={(e) => update("url", e.target.value)}
            placeholder="https://github.com/owner/repo"
            autoComplete="off"
            required
          />
        </label>
      ) : (
        <label className="fld">
          <span>Push to</span>
          <select
            className="inp"
            value={draft.remote}
            onChange={(e) => update("remote", e.target.value)}
          >
            {[
              ["none", "Only this PC for now"],
              ["github", "New private repo on GitHub"],
              ["gitlab", "New private repo on GitLab"],
              ["both", "GitHub and GitLab (one push updates both)"],
            ].map(([value, label]) => (
              <option
                key={value}
                value={value}
                disabled={
                  value !== "none" &&
                  (!info ||
                    (value === "both"
                      ? !(info.hosts.github && info.hosts.gitlab)
                      : !info.hosts[value as "github" | "gitlab"]))
                }
              >
                {label}
              </option>
            ))}
          </select>
          <small>
            {!info
              ? "Checking gh and glab…"
              : info.hosts.github || info.hosts.gitlab
                ? `Uses your ${[info.hosts.github && "gh", info.hosts.gitlab && "glab"].filter(Boolean).join(" and ")} login.`
                : "Log in with gh or glab to create repos from here."}
          </small>
        </label>
      )}
    </DialogFrame>
  );
}
const KINDS: Record<Link["kind"], [string, string]> = {
  cwd: [
    "Log files that record the folder",
    "Each log names the folder it ran in, like Codex.",
  ],
  named: [
    "One folder per project",
    "The tool keeps a folder named after each project, like Claude Code.",
  ],
  inside: [
    "Inside the project",
    "History sits in the project folder itself, like Aider.",
  ],
  mentions: [
    "Files that mention the project",
    "Notes or plans that mention a project path, like Claude plans.",
  ],
};
function ConnectorDialog() {
  const s = useApp();
  const [custom, setCustom] = useState(false);
  const [kind, setKind] = useState<Link["kind"]>("cwd");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function add(body: Record<string, unknown>) {
    setSaving(true);
    setError("");
    try {
      const snapshot = await api<Snapshot>("connector/add", body);
      s.load(snapshot);
      close();
      toast(
        `Added ${typeof body.name === "string" ? body.name : (snapshot.connectors.find((c) => c.id === body.preset)?.name ?? "connector")}`,
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
    }
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const text = (key: string) => String(fields[key] ?? "");
    const link: Link =
      kind === "cwd"
        ? { kind, dir: text("dir"), ext: text("ext"), field: text("field") }
        : kind === "named"
          ? {
              kind,
              dir: text("dir"),
              naming: text("naming") as "dashes" | "sha256",
            }
          : kind === "inside"
            ? { kind, path: text("path") }
            : { kind, dir: text("dir"), ext: text("ext") };
    void add({ name: text("name"), link });
  }
  if (!custom)
    return (
      <DialogFrame
        title="Add a connector"
        description="Pick the AI tool. laci shows its history on each project and carries it along when you move or archive one."
        footer={
          <>
            {error ? (
              <p className="err" role="alert">
                {error}
              </p>
            ) : (
              <p>Saved in ~/.config/laci/config.json</p>
            )}
            <button className="btn" disabled={saving} onClick={close}>
              Cancel
            </button>
          </>
        }
      >
        {[...s.snapshot!.suggestions]
          .sort((a, b) => Number(b.found) - Number(a.found))
          .map((suggestion) => (
            <button
              className="pick"
              key={suggestion.id}
              disabled={saving}
              onClick={() => void add({ preset: suggestion.id })}
            >
              <Icon name="bot" />
              <div className="txt">
                <b>{suggestion.name}</b>
                <p>
                  {suggestion.about} ·{" "}
                  <span className="mono">{suggestion.where}</span>
                </p>
              </div>
              {suggestion.found ? (
                <span className="found">
                  Found{suggestion.detail ? ` · ${suggestion.detail}` : ""}
                </span>
              ) : (
                <span className="faint" style={{ fontSize: 12 }}>
                  Not on this PC
                </span>
              )}
            </button>
          ))}
        <button className="pick" onClick={() => setCustom(true)}>
          <Icon name="plus" />
          <div className="txt">
            <b>Another tool…</b>
            <p>Tell laci where it keeps its history</p>
          </div>
          <Icon name="chev" className="sm" />
        </button>
      </DialogFrame>
    );
  return (
    <DialogFrame
      title="Another tool"
      description="Tell laci where it keeps its history. It will show up on each project, and move along when you move or archive one."
      form
      onSubmit={submit}
      footer={
        <>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : (
            <p>Saved in ~/.config/laci/config.json</p>
          )}
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => setCustom(false)}
          >
            Back
          </button>
          <button className="btn primary" disabled={saving}>
            Add connector
          </button>
        </>
      }
    >
      <label className="fld">
        <span>Name</span>
        <input
          className="inp"
          name="name"
          placeholder="OpenCode, Cursor, my own agent…"
          autoComplete="off"
          required
          maxLength={40}
        />
      </label>
      <div className="fld">
        <span>Where does it keep its history?</span>
        <div className="choices">
          {Object.entries(KINDS).map(([value, [title, description]]) => (
            <label className="choice" key={value}>
              <input
                type="radio"
                name="kind"
                value={value}
                checked={kind === value}
                onChange={() => setKind(value as Link["kind"])}
              />
              <div>
                <b>{title}</b>
                <p>{description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>
      <div key={kind}>
        {kind === "cwd" ? (
          <>
            <label className="fld">
              <span>Folder with the logs</span>
              <input
                className="inp mono"
                name="dir"
                placeholder="~/.tool/sessions"
                required
              />
              <small>Searched with every subfolder.</small>
            </label>
            <div className="row2">
              <label className="fld">
                <span>File type</span>
                <input
                  className="inp mono"
                  name="ext"
                  defaultValue=".jsonl"
                  required
                />
              </label>
              <label className="fld">
                <span>Field that holds the folder</span>
                <input
                  className="inp mono"
                  name="field"
                  defaultValue="cwd"
                  required
                />
              </label>
            </div>
          </>
        ) : kind === "named" ? (
          <>
            <label className="fld">
              <span>Folder that holds one folder per project</span>
              <input
                className="inp mono"
                name="dir"
                placeholder="~/.tool/projects"
                required
              />
            </label>
            <label className="fld">
              <span>How the folders are named</span>
              <select className="inp" name="naming">
                <option value="dashes">
                  Path with dashes: -home-me-project-app
                </option>
                <option value="sha256">SHA-256 hash of the path</option>
              </select>
            </label>
          </>
        ) : kind === "inside" ? (
          <label className="fld">
            <span>Path inside each project</span>
            <input
              className="inp mono"
              name="path"
              placeholder=".tool/history"
              required
            />
            <small>
              A file or a folder. It already moves with the project; laci shows
              it on the project.
            </small>
          </label>
        ) : (
          <div className="row2">
            <label className="fld">
              <span>Folder</span>
              <input
                className="inp mono"
                name="dir"
                placeholder="~/.tool/plans"
                required
              />
            </label>
            <label className="fld">
              <span>File type</span>
              <input
                className="inp mono"
                name="ext"
                defaultValue=".md"
                required
              />
            </label>
          </div>
        )}
      </div>
    </DialogFrame>
  );
}
