import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { Select } from "./select";
import { useTerms } from "./terminal-api";
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
export function agentProviders(connectors: ConnectorState[]) {
  const providers = new Map<string, { value: string; label: string }>();
  for (const connector of connectors) {
    const provider = connector.provider ?? connector.id;
    if (
      ["claude", "codex", "antigravity"].includes(provider) &&
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
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const providers = agentProviders(connectors);
  const caps = capabilities[draft.provider];
  const error = errors[draft.provider];
  const missingModel = Boolean(
    draft.model &&
    (draft.model === "custom"
      ? !caps?.customModel
      : !caps?.models.some((model) => model.id === draft.model)),
  );
  const efforts =
    caps?.models.find((model) => model.id === draft.model)?.efforts ?? [];
  async function discover() {
    if (pending.current) return;
    pending.current = true;
    const provider = draft.provider;
    setLoading(true);
    setErrors((current) => ({ ...current, [provider]: "" }));
    try {
      const caps = await api<AgentCapabilities>("agent/models", {
        provider,
        refresh: true,
      });
      if (mounted.current)
        setCapabilities((current) => ({ ...current, [provider]: caps }));
    } catch (error) {
      if (mounted.current)
        setErrors((current) => ({ ...current, [provider]: errorText(error) }));
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  }
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
                      label: `${draft.model === "custom" ? "Custom model ID" : draft.model} (${caps ? "unavailable" : "load models to verify"})`,
                      disabled: true,
                    },
                  ]
                : []),
              ...(caps?.customModel
                ? [{ value: "custom", label: "Custom model ID…" }]
                : []),
            ]}
            onValueChange={(model) => onChange({ ...draft, model, effort: "" })}
          />
        </label>
        <label className="fld">
          <span>Effort</span>
          <Select
            label="Agent effort"
            value={draft.effort}
            disabled={disabled || (!efforts.length && !draft.effort)}
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
            onValueChange={(effort) => onChange({ ...draft, effort })}
          />
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
            onChange={(event) =>
              onChange({ ...draft, customModel: event.target.value })
            }
          />
          <small>
            Uses a model available to your provider account. Effort stays at
            Default.
          </small>
        </label>
      ) : null}
      <button
        type="button"
        className="btn"
        disabled={loading || !draft.provider || disabled}
        onClick={() => void discover()}
      >
        {loading
          ? "Loading models…"
          : caps
            ? "Refresh models"
            : "Load provider models"}
      </button>
      <p className="desc">
        {caps?.message ??
          "Default uses the provider's own settings. Load models only when you want an override."}
      </p>
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
