import type { ReactNode } from "react";
import { Icon } from "../../common";
import { safety as said } from "../../words";
import { safetyOf } from "../model";
import type { Tone } from "../model";
import type { Node } from "../../types";

/** Each tone has its own shape, so colour is never the only sign (WCAG 1.4.1). */
export const TONE_ICON: Record<Tone, string> = {
  safe: "shield-check",
  soon: "circle-alert",
  act: "triangle-alert",
  fyi: "info",
};

/** A status: its icon and its words, and colour as a third sign. */
export function StatusChip({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`s-chip s-tone-${tone}`} data-ui="status" title={title}>
      <Icon name={TONE_ICON[tone]} />
      <span>{children}</span>
    </span>
  );
}

/** A status that takes a sentence: its icon, then the words, on a tint. */
export function Callout({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <p className={`s-callout s-tone-${tone}`} data-ui="status">
      <Icon name={TONE_ICON[tone]} />
      <span>{children}</span>
    </p>
  );
}

/** The words for a project's worst problem, or for none. */
export function safetyWords(node: Node) {
  const { issue, noHistory } = safetyOf(node);
  if (issue) return said.issues[issue.code]?.title ?? issue.title;
  return noHistory ? said.noHistory : said.safe;
}

/** How safe a project is, in one chip. A screen reader hears the tone first, as "Act now: …". */
export function SafetyBadge({ node }: { node: Node }) {
  const { tone } = safetyOf(node);
  const words = safetyWords(node);
  return (
    <StatusChip tone={tone}>
      {tone === "act" || tone === "soon" ? (
        <span className="sr-only">{said.tones[tone]}: </span>
      ) : null}
      {words}
    </StatusChip>
  );
}
