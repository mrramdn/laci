import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { DialogFrame } from "./dialogs";
import {
  AgentFields,
  agentDraft,
  agentProviders,
  launchAgent,
  validateAgentDraft,
} from "./agent-launch";
import { Select } from "./select";
import { useApp, changed, selectWhenReady } from "./store";
import { parentOf, tilde, within } from "./helpers";
import type { Change, NewInfo } from "./types";

interface Recipe {
  id: string;
  name: string;
  program: string;
  args: string[];
  runtime?: string;
  download: boolean;
}
interface Info extends NewInfo {
  recipes: Recipe[];
}
interface Preview {
  command: string;
  runtime: string;
  runtimeVersion?: string;
  download: boolean;
  missing: string[];
}
interface Job {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  output: string;
  result?: Change;
  error?: string;
}
export function NewProject() {
  const s = useApp();
  const snapshot = s.snapshot!;
  const [info, setInfo] = useState<Info | null>(null);
  const [draft, setDraft] = useState({
    name: "",
    parent:
      s.view === "folder" &&
      [snapshot.home, ...snapshot.roots].some((root) => within(s.cwd, root))
        ? snapshot.nodes[s.cwd]?.kind === "project"
          ? parentOf(s.cwd)
          : s.cwd
        : (snapshot.roots[0] ?? snapshot.home),
    summary: "",
    from: "empty",
    template: "",
    url: "",
    remote: "none",
    recipe: "vite",
    generatorTemplate: "react-ts",
    scanProject: true,
  });
  const [templatePath, setTemplatePath] = useState("");
  const [recipeText, setRecipeText] = useState("");
  const [showRecipe, setShowRecipe] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [launchAfter, setLaunchAfter] = useState(false);
  const [agent, setAgent] = useState(() =>
    agentDraft(agentProviders(snapshot.connectors)[0]?.value, s.terminalTarget),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const jobId = job?.id;
  const jobStatus = job?.status;
  const [created, setCreated] = useState<Change | null>(null);
  const pending = useRef(false);
  const handledJob = useRef<string | null>(null);
  const submitted = useRef({
    agent,
    launchAfter,
    parent: draft.parent,
    name: draft.name,
    scanProject: draft.scanProject,
    modal: s.modal,
  });
  useEffect(() => {
    let live = true;
    void api<Info>("new/info").then(
      (value) => {
        if (live) setInfo(value);
      },
      (error) => {
        if (live) setError(errorText(error));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!jobId || jobStatus !== "running") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Job>("new/status", { id: jobId });
        if (!live) return;
        setJob(next);
        if (next.status === "running")
          timer = setTimeout(() => void poll(), 300);
        else if (next.status === "completed" && next.result) {
          if (handledJob.current === next.id) return;
          handledJob.current = next.id;
          setCreated(next.result);
          const saved = submitted.current;
          changed(
            next.result,
            `Created ${saved.name}`,
            tilde(next.result.path, snapshot.home),
          );
          if (saved.launchAfter && next.result.path) {
            try {
              await launchAgent(saved.agent, next.result.path);
              if (useApp.getState().modal === saved.modal) {
                useApp.getState().cd(saved.scanProject ? saved.parent : next.result.path);
                if (saved.scanProject) selectWhenReady(next.result.path);
                useApp.setState({ modal: null });
              }
            } catch (error) {
              if (useApp.getState().modal === saved.modal)
                setError(
                  `Project created. Agent launch failed: ${errorText(error)}`,
                );
            }
          }
          pending.current = false;
          if (useApp.getState().modal === saved.modal) setSaving(false);
        } else {
          setError(next.error ?? "Creation stopped");
          pending.current = false;
          setSaving(false);
        }
      } catch (error) {
        if (live) {
          setError(errorText(error));
          timer = setTimeout(() => void poll(), 1000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 100);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId, jobStatus, snapshot.home]);
  function finish(result: Change) {
    s.cd(draft.scanProject ? draft.parent : result.path ?? draft.parent);
    if (result.path && draft.scanProject) selectWhenReady(result.path);
    useApp.setState({ modal: null });
  }
  function update(key: keyof typeof draft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    if (["name", "recipe", "generatorTemplate", "parent"].includes(key))
      setPreview(null);
  }
  async function action(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setError("");
    setSaving(true);
    try {
      await work();
    } catch (error) {
      setError(errorText(error));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || saving || created) return;
    if (draft.from === "template" && !draft.template) {
      setError("Choose a local template or add a template folder first.");
      document
        .querySelector<HTMLElement>(
          '[role="combobox"][aria-label="Local template"]',
        )
        ?.focus();
      return;
    }
    if (draft.from === "generator" && (!preview || preview.missing.length)) {
      setError("Preview the generator and resolve its prerequisites first.");
      return;
    }
    if (launchAfter && !agent.provider) {
      setError("Add an agent connector in Settings first.");
      return;
    }
    if (launchAfter) {
      try {
        validateAgentDraft(agent);
      } catch (error) {
        setError(errorText(error));
        return;
      }
    }
    submitted.current = {
      agent: { ...agent },
      launchAfter,
      parent: draft.parent,
      name: draft.name,
      scanProject: draft.scanProject,
      modal: s.modal,
    };
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      setJob(await api<Job>("new/start", draft));
    } catch (error) {
      pending.current = false;
      setError(errorText(error));
      setSaving(false);
    }
  }
  const parents = [
    ...new Set([
      draft.parent,
      snapshot.home,
      ...snapshot.roots,
      ...Object.values(snapshot.nodes)
        .filter((n) => n.kind === "folder" && !n.archived)
        .map((n) => n.path),
    ]),
  ];
  return (
    <DialogFrame
      title="New project"
      description="Choose a starting point, then optionally launch an agent in the new project."
      form
      preserveDraft
      dismissible={!saving}
      onSubmit={(event) => void submit(event)}
      footer={
        <>
          <p
            className={error ? "err" : "mono"}
            role={error ? "alert" : "status"}
          >
            {error ||
              (created
                ? `Created ${created.path}`
                : tilde(
                    `${draft.parent}/${draft.name || "name"}`,
                    snapshot.home,
                  ))}
          </p>
          {created ? (
            <>
              {launchAfter ? (
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  onClick={() =>
                    void action(async () => {
                      await launchAgent(agent, created.path!);
                      finish(created);
                    })
                  }
                >
                  Retry agent launch
                </button>
              ) : null}
              <button
                type="button"
                className="btn primary"
                disabled={saving}
                onClick={() => finish(created)}
              >
                Open project
              </button>
            </>
          ) : (
            <>
              {job?.status === "running" && draft.from === "generator" ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void api("new/cancel", { id: job.id }).catch((error) =>
                      setError(errorText(error)),
                    )
                  }
                >
                  Cancel generator
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  onClick={() => useApp.setState({ modal: null })}
                >
                  Discard draft
                </button>
              )}
              <button
                className="btn primary"
                disabled={saving || s.historyPending}
              >
                {saving ? "Creating…" : "Create project"}
              </button>
            </>
          )}
        </>
      }
    >
      <fieldset className="creation-fields" disabled={saving || !!created}>
        <div className="row2">
          <label className="fld">
            <span>Name</span>
            <input
              className="inp mono"
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
              maxLength={100}
              autoComplete="off"
              placeholder="my-app"
            />
          </label>
          <label className="fld">
            <span>In</span>
            <Select
              label="Project location"
              disabled={saving || !!created}
              value={draft.parent}
              options={parents.map((path) => ({
                value: path,
                label: tilde(path, snapshot.home),
              }))}
              onValueChange={(value) => update("parent", value)}
            />
          </label>
        </div>
        <label className="fld">
          <span>
            What is it? <span className="faint">Optional</span>
          </span>
          <input
            className="inp"
            value={draft.summary}
            onChange={(e) => update("summary", e.target.value)}
            maxLength={300}
            placeholder="Landing page for the coffee shop"
          />
        </label>
        <div className="fld">
          <span>Start from</span>
          <div className="choices">
            {[
              ["empty", "Empty folder", "A README and a first Git commit."],
              ["template", "Local template", "Copy a folder you choose."],
              ["clone", "Clone a repo", "Use a Git repository URL."],
              [
                "generator",
                "Generator recipe",
                "Preview and run a scaffolding command.",
              ],
            ].map(([value, title, description]) => (
              <label className="choice" key={value}>
                <input
                  type="radio"
                  name="from"
                  checked={draft.from === value}
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
        {draft.from === "template" ? (
          <>
            <label className="fld">
              <span>Template</span>
              <Select
                label="Local template"
                disabled={saving || !!created}
                value={draft.template}
                options={[
                  { value: "", label: "Choose a template…" },
                  ...(info?.templates ?? []).map((path) => ({
                    value: path,
                    label: tilde(path, snapshot.home),
                  })),
                ]}
                onValueChange={(value) => update("template", value)}
              />
            </label>
            <label className="fld">
              <span>Reference a local folder</span>
              <input
                className="inp mono"
                value={templatePath}
                onChange={(e) => setTemplatePath(e.target.value)}
                placeholder="/absolute/path/to/starter"
              />
              <small>
                The source folder stays in place. Git history is excluded from
                copies.
              </small>
            </label>
            <button
              type="button"
              className="btn"
              disabled={!templatePath.trim() || !info}
              onClick={() =>
                void action(async () => {
                  const result = await api<{
                    templates: string[];
                    path: string;
                  }>("new/template", { path: templatePath });
                  setInfo((current) =>
                    current
                      ? { ...current, templates: result.templates }
                      : current,
                  );
                  update("template", result.path);
                  setTemplatePath("");
                })
              }
            >
              Add template folder
            </button>
          </>
        ) : null}
        {draft.from === "clone" ? (
          <label className="fld">
            <span>Repo URL</span>
            <input
              className="inp mono"
              value={draft.url}
              onChange={(e) => update("url", e.target.value)}
              placeholder="https://github.com/owner/repo"
              required
            />
          </label>
        ) : (
          <label className="fld">
            <span>Push to</span>
            <Select
              label="Remote repository"
              disabled={saving || !!created}
              value={draft.remote}
              options={[
                ["none", "Only this PC for now"],
                ["github", "New private repo on GitHub"],
                ["gitlab", "New private repo on GitLab"],
                ["both", "GitHub and GitLab"],
              ].map(([value, label]) => ({
                value,
                label,
                disabled:
                  value !== "none" &&
                  (!info ||
                    (value === "both"
                      ? !(info.hosts.github && info.hosts.gitlab)
                      : !info.hosts[value as "github" | "gitlab"])),
              }))}
              onValueChange={(value) => update("remote", value)}
            />
          </label>
        )}
        {draft.from === "generator" ? (
          <>
            <label className="fld">
              <span>Recipe</span>
              <Select
                label="Generator recipe"
                disabled={saving || !!created}
                value={draft.recipe}
                options={(info?.recipes ?? [{ id: "vite", name: "Vite" }]).map(
                  (recipe) => ({ value: recipe.id, label: recipe.name }),
                )}
                onValueChange={(value) => update("recipe", value)}
              />
            </label>
            {draft.recipe === "vite" ? (
              <label className="fld">
                <span>Vite template</span>
                <Select
                  label="Vite template"
                  disabled={saving || !!created}
                  value={draft.generatorTemplate}
                  options={[
                    "vanilla",
                    "vanilla-ts",
                    "react",
                    "react-ts",
                    "vue",
                    "vue-ts",
                    "svelte",
                    "svelte-ts",
                    "preact",
                    "preact-ts",
                    "solid",
                    "solid-ts",
                    "lit",
                    "lit-ts",
                    "qwik",
                    "qwik-ts",
                  ].map((value) => ({ value, label: value }))}
                  onValueChange={(value) => update("generatorTemplate", value)}
                />
              </label>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() =>
                void action(async () =>
                  setPreview(
                    await api<Preview>("new/preview", {
                      ...draft,
                      name: draft.name || "my-app",
                    }),
                  ),
                )
              }
            >
              Preview generator
            </button>
            {preview ? (
              <div className="generator-preview">
                <code>{preview.command}</code>
                <p>
                  Runs in {tilde(draft.parent, snapshot.home)}. Runtime:{" "}
                  {preview.runtime || "none"}
                  {preview.runtimeVersion ? ` ${preview.runtimeVersion}` : ""}.
                </p>
                <p>
                  {preview.download
                    ? draft.recipe === "vite"
                      ? "Downloads may be required. Vite uses create-vite@latest; installed project dependencies do not provide its CLI."
                      : "This recipe may download packages. Review the command before continuing."
                    : "This recipe declares no download requirement."}
                </p>
                {preview.missing.length ? (
                  <p className="err">Missing: {preview.missing.join(", ")}</p>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              className="btn link"
              onClick={() => setShowRecipe(!showRecipe)}
            >
              {showRecipe ? "Hide custom recipe" : "Add a custom recipe"}
            </button>
            {showRecipe ? (
              <>
                <label className="fld">
                  <span>Recipe JSON</span>
                  <textarea
                    className="inp mono"
                    rows={5}
                    value={recipeText}
                    onChange={(e) => setRecipeText(e.target.value)}
                    placeholder={
                      '{"id":"my-starter","name":"My starter","program":"pnpm","args":["create","my-starter","{name}"],"runtime":"node","download":true}'
                    }
                  />
                  <small>
                    Arguments are separate strings. {"{name}"} and{" "}
                    {"{template}"} are replaced with your selections.
                  </small>
                </label>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void action(async () => {
                      const recipe = JSON.parse(recipeText) as Recipe;
                      const result = await api<{ recipes: Recipe[] }>(
                        "new/recipe",
                        { recipe },
                      );
                      setInfo((current) =>
                        current
                          ? { ...current, recipes: result.recipes }
                          : current,
                      );
                      update("recipe", recipe.id);
                      setShowRecipe(false);
                    })
                  }
                >
                  Save recipe
                </button>
              </>
            ) : null}
          </>
        ) : null}
        <label className="choice">
          <input
            type="checkbox"
            checked={draft.scanProject}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                scanProject: event.target.checked,
              }))
            }
          />
          <div>
            <b>Include this project in scan locations</b>
            <p>
              Adds only this folder if it is outside your selected locations.
            </p>
          </div>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={launchAfter}
            onChange={(event) => setLaunchAfter(event.target.checked)}
          />
          <div>
            <b>Launch an agent after creation</b>
            <p>Starts only after the project is ready.</p>
          </div>
        </label>
      </fieldset>
      {launchAfter ? (
        <AgentFields draft={agent} onChange={setAgent} disabled={saving} />
      ) : null}
      {job ? (
        <div className="generator-progress" aria-live="polite">
          <p>
            {job.status === "running"
              ? "Creating project…"
              : `Creation ${job.status}`}
          </p>
          <pre tabIndex={0} aria-live="off" aria-label="Creation output">
            {job.output || "Waiting for output…"}
          </pre>
        </div>
      ) : null}
    </DialogFrame>
  );
}
