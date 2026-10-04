import { Icon } from "./common";
import { Select } from "./select";
import { external, useApp } from "./store";
import { openTerminal } from "./terminal-api";
import type { TerminalTarget } from "./types";

export function launchShell(path: string, target: TerminalTarget) {
  if (target === "external") external(path, "terminal");
  else void openTerminal(path, "shell");
}

export function TerminalButton({ path }: { path: string }) {
  const target = useApp((s) => s.terminalTarget);
  const label = target === "internal" ? "Laci terminal" : "external terminal";
  return (
    <div className="terminal-action">
      <button
        className="icon-btn"
        title={`Open ${label} here`}
        aria-label={`Open ${label} here`}
        onClick={() => launchShell(path, target)}
      >
        <Icon name="terminal" />
      </button>
      <Select
        label="Choose terminal target for this launch"
        className="icon-btn terminal-target"
        value=""
        options={[
          { value: "internal", label: "Open in Laci terminal" },
          { value: "external", label: "Open in external terminal" },
        ]}
        onValueChange={(value) => launchShell(path, value as TerminalTarget)}
      >
        <span className="sr-only">Terminal target</span>
      </Select>
    </div>
  );
}
