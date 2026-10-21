// What the window says while the first scan runs, in either design. A first scan of a big history
// takes minutes; saying what it reads, and how far it has come, shows it isn't stuck.
import { bytes } from "./helpers";
import type { ScanProgress } from "./types";

export interface BootSay {
  title: string;
  /** How far it has come, when it counts. */
  detail?: string;
  /** Why it takes a while. */
  note?: string;
}
const size = (b: number) => (b > 0 ? bytes(b) : "0 MB");
export function bootSay(progress?: ScanProgress | null): BootSay {
  switch (progress?.step) {
    case "history":
      return {
        title: "Reading your AI chat history…",
        detail: progress.total
          ? `${progress.done} of ${progress.total} files · ${size(progress.bytes)} of ${size(progress.totalBytes)}`
          : undefined,
        note: "Laci reads it all once, the first time. After that it opens straight away.",
      };
    case "folders":
      return { title: "Looking through your folders…" };
    case "projects":
      return {
        title: "Reading your projects…",
        detail: progress.total
          ? `${progress.done} of ${progress.total} folders`
          : undefined,
      };
    default:
      return { title: "Looking for your projects…" };
  }
}
