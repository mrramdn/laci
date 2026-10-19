// The steps of a change: what a suggestion in Clean up will do, or what a change in Activity did.
// They are the engine's own words and paths, so they stay behind "What will change" and "What
// changed", in the mono font (design-research §3.2, rule 5).
import { Icon } from "../common";
import type { Op } from "../types";

const ICON: Record<Op["kind"], string> = {
  move: "move",
  rename: "rename",
  rewrite: "rewrite",
  delete: "delete",
  write: "write",
  git: "commit",
  keep: "keep",
};

export function Steps({ ops }: { ops: Op[] }) {
  return (
    <ul className="s-steps">
      {ops.map((op, i) => (
        <li key={i} className="s-step">
          <Icon name={ICON[op.kind] ?? "history"} />
          <div className="s-step-text">
            <span className="s-mono">{op.label}</span>
            {op.from || op.to ? (
              <span className="s-mono s-quiet">
                {[op.from, op.to].filter(Boolean).join(" → ")}
              </span>
            ) : null}
            {op.detail ? <span className="s-mono s-quiet">{op.detail}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
