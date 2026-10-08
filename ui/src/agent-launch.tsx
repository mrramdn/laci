import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { Select } from "./select";
import { useTerms } from "./terminal-api";
import { Icon } from "./common";
import { useApp } from "./store";
import type { ConnectorState, TerminalInfo, TerminalTarget } from "./types";

export interface AgentDraft {
  provider: string;
  prompt: string;
  model: string;
  customModel: string;
  effort: string;
  target: TerminalTarget;
}
export interface AgentCapabilities {
  models: { id: string; label?: string; efforts: string[] }[];
  /** Effort levels that can be set while the model stays the provider's default. */
  defaultEfforts?: string[];
  customModel: boolean;
  installed: boolean;
  message: string;
  /** False when the model list has not been asked from the provider yet. */
  listed?: boolean;
  /** The model and effort last used to start this agent. */
  remembered?: { model: string | null; effort: string | null };
}
export function agentDraft(
  provider = "",
  target: TerminalTarget = "internal",
): AgentDraft {
  return {
    provider,
    target,
    prompt: "",
    model: "",
    customModel: "",
    effort: "",
  };
}
export const LAUNCHABLE_PROVIDERS = ["claude", "codex", "antigravity"];
export function agentProviders(connectors: ConnectorState[]) {
  const providers = new Map<string, { value: string; label: string }>();
  for (const connector of connectors) {
    const provider = connector.provider ?? connector.id;
    if (
      LAUNCHABLE_PROVIDERS.includes(provider) &&
      connector.capabilities?.launch !== false &&
      !providers.has(provider)
    ) {
      providers.set(provider, { value: provider, label: connector.name });
    }
  }
  return [...providers.values()];
}
export function validateAgentDraft(draft: AgentDraft) {
  if (!draft.provider) throw new Error("Choose a connected agent first.");
  if (draft.model === "custom" && !draft.customModel.trim())
    throw new Error("Enter a custom model ID or choose Default.");
  if (draft.model === "custom" && draft.effort)
    throw new Error("A custom model uses the default effort.");
}
/** Effort levels the chosen model offers; with the Default model, the provider's own list. */
export function effortsFor(caps: AgentCapabilities | undefined, model: string) {
  if (!caps) return [];
  if (model === "") return caps.defaultEfforts ?? [];
  return caps.models.find((item) => item.id === model)?.efforts ?? [];
}
/** The remembered model and effort, as far as this provider still offers them. */
function rememberedChoice(caps: AgentCapabilities) {
  const saved = caps.remembered;
  let model = "";
  let customModel = "";
  if (saved?.model) {
    if (caps.models.some((item) => item.id === saved.model))
      model = saved.model;
    else if (caps.customModel) {
      model = "custom";
      customModel = saved.model;
    }
  }
  const effort =
    model !== "custom" &&
    saved?.effort &&
    effortsFor(caps, model).includes(saved.effort)
      ? saved.effort
      : "";
  return { model, customModel, effort };
}
export function AgentFields({
  draft,
  onChange,
  fixedProvider = false,
  disabled = false,
}: {
  draft: AgentDraft;
  onChange: (draft: AgentDraft) => void;
  fixedProvider?: boolean;
  disabled?: boolean;
}) {
  const connectors = useApp((s) => s.snapshot?.connectors ?? []);
  const [capabilities, setCapabilities] = useState<
    Record<string, AgentCapabilities>
  >({});
  const [loadingFor, setLoadingFor] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const requests = useRef<Record<string, number>>({});
  const mounted = useRef(true);
  const touched = useRef(false);
  const applied = useRef("");
  const latest = useRef({ draft, onChange });
  latest.current = { draft, onChange };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const providers = agentProviders(connectors);
  const provider = draft.provider;
  const caps = capabilities[provider];
  const error = errors[provider];
  const loading = Boolean(loadingFor[provider]);
  async function discover(name: string, refresh: boolean) {
    const request = (requests.current[name] ?? 0) + 1;
    requests.current[name] = request;
    setLoadingFor((current) => ({ ...current, [name]: true }));
    setErrors((current) => ({ ...current, [name]: "" }));
    try {
      const result = await api<AgentCapabilities>("agent/models", {
        provider: name,
        // Opening the form never starts the provider's program; only the button does.
        ...(refresh ? { refresh: true } : { passive: true }),
      });
      if (mounted.current && requests.current[name] === request)
        setCapabilities((current) => ({ ...current, [name]: result }));
    } catch (failure) {
      if (mounted.current && requests.current[name] === request)
        setErrors((current) => ({ ...current, [name]: errorText(failure) }));
    } finally {
      if (mounted.current && requests.current[name] === request)
        setLoadingFor((current) => ({ ...current, [name]: false }));
    }
  }
  useEffect(() => {
    touched.current = false;
    applied.current = "";
    if (provider) void discover(provider, false);
  }, [provider]);
  useEffect(() => {
    if (!caps || touched.current || applied.current === provider) return;
    applied.current = provider;
    const current = latest.current.draft;
    if (current.provider !== provider) return;
    const choice = rememberedChoice(caps);
    if (choice.model || choice.effort)
      latest.current.onChange({ ...current, ...choice });
  }, [caps, provider]);
  const missingModel = Boolean(
    draft.model &&
    (draft.model === "custom"
      ? !caps?.customModel
      : !caps?.models.some((model) => model.id === draft.model)),
  );
  const efforts = effortsFor(caps, draft.model);
  const effortOff = !efforts.length && !draft.effort;
  return (
    <fieldset className="agent-fields" disabled={disabled}>
      <div className="row2">
        <label className="fld">
          <span>Agent</span>
          <Select
            label="Agent"
            value={draft.provider}
            disabled={fixedProvider || disabled || !providers.length}
            options={
              providers.length
                ? providers
                : [{ value: "", label: "No connected agent" }]
            }
            onValueChange={(provider) => {
              onChange({
                ...draft,
                provider,
                model: "",
                customModel: "",
                effort: "",
              });
            }}
          />
        </label>
        <label className="fld">
          <span>Open in</span>
          <Select
            label="Agent terminal target"
            value={draft.target}
            disabled={disabled}
            options={[
              { value: "internal", label: "Laci terminal" },
              { value: "external", label: "External terminal" },
            ]}
            onValueChange={(target) =>
              onChange({ ...draft, target: target as TerminalTarget })
            }
          />
        </label>
      </div>
      <label className="fld">
        <span>
          Prompt <span className="faint">Optional</span>
        </span>
        <textarea
          className="inp"
          name="agentPrompt"
          value={draft.prompt}
          rows={4}
          maxLength={65536}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
          placeholder="What would you like the agent to work on?"
        />
      </label>
      <div className="row2">
        <label className="fld">
          <span>Model</span>
          <Select
            label="Agent model"
            value={draft.model}
            disabled={disabled}
            options={[
              { value: "", label: "Default — provider settings" },
              ...(caps?.models ?? []).map((m) => ({
                value: m.id,
                label: m.label ?? m.id,
              })),
              ...(missingModel
                ? [
                    {
                      value: draft.model,
                      label: `${draft.model === "custom" ? "Custom model ID" : draft.model} (${caps ? "unavailable" : "not verified yet"})`,
                      disabled: true,
                    },
                  ]
                : []),
              ...(caps?.customModel
                ? [{ value: "custom", label: "Custom model ID…" }]
                : []),
            ]}
            onValueChange={(model) => {
              touched.current = true;
              onChange({ ...draft, model, effort: "" });
            }}
          />
        </label>
        <label className="fld">
          <span>Effort</span>
          <Select
            label="Agent effort"
            value={draft.effort}
            disabled={disabled || effortOff}
            options={[
              { value: "", label: "Default — provider settings" },
              ...efforts.map((effort) => ({ value: effort, label: effort })),
              ...(draft.effort && !efforts.includes(draft.effort)
                ? [
                    {
                      value: draft.effort,
                      label: `${draft.effort} (unavailable)`,
                      disabled: true,
                    },
                  ]
                : []),
            ]}
            onValueChange={(effort) => {
              touched.current = true;
              onChange({ ...draft, effort });
            }}
          />
          {caps && effortOff ? (
            <small className="agent-hint">
              {draft.model === "custom"
                ? "A custom model uses the default effort"
                : "This model has no effort levels"}
            </small>
          ) : null}
        </label>
      </div>
      {draft.model === "custom" ? (
        <label className="fld">
          <span>Custom model ID</span>
          <input
            className="inp mono"
            name="customModel"
            autoComplete="off"
            spellCheck={false}
            value={draft.customModel}
            maxLength={200}
            required
            onChange={(event) => {
              touched.current = true;
              onChange({ ...draft, customModel: event.target.value });
            }}
          />
          <small>
            Uses a model available to your provider account. Effort stays at
            Default.
          </small>
        </label>
      ) : null}
      <div className="agent-status">
        <p className="desc">
          {loading && !caps
            ? "Loading models…"
            : (caps?.message ?? "Default uses the provider's own settings.")}
        </p>
        <button
          type="button"
          className="btn sm ghost"
          aria-label="Refresh models"
          title="Ask the provider for its current models"
          disabled={loading || !draft.provider || disabled}
          onClick={() => void discover(draft.provider, true)}
        >
          <Icon name="refresh" className="sm" />
          {loading && caps
            ? "Loading…"
            : caps && !caps.listed
              ? "Load models"
              : "Refresh"}
        </button>
      </div>
      {!providers.length ? (
        <p className="err">
          Add an agent connector in Settings before launching.
        </p>
      ) : null}
      {caps &&
      (missingModel || (draft.effort && !efforts.includes(draft.effort))) ? (
        <p className="err">
          This override is no longer reported by the provider. Choose a
          supported value or Default.
        </p>
      ) : null}
      {caps && !caps.installed ? (
        <p className="err">This agent's CLI is not on PATH.</p>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
export async function launchAgent(
  draft: AgentDraft,
  projectPath: string,
  sessionId?: string,
) {
  validateAgentDraft(draft);
  const result = await api<{ target: TerminalTarget; terminal?: TerminalInfo }>(
    "agent/launch",
    {
      ...draft,
      model: draft.model === "custom" ? draft.customModel : draft.model,
      projectPath,
      sessionId,
    },
  );
  const terminal = result.terminal;
  if (terminal)
    useTerms.setState((current) => ({
      tabs: [...current.tabs.filter((t) => t.id !== terminal.id), terminal],
      active: terminal.id,
      shown: true,
    }));
  return result;
}
