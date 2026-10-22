import { invoke } from "@tauri-apps/api/core";
import { engineSays } from "./words";
export function api<T>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>("request", { name, body });
}
/**
 * What a failure says, with the engine's own reasons in the words of the design on the page
 * (`engineSays`), as the store puts it on the page's root.
 */
export function errorText(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  const design =
    typeof document !== "undefined" &&
    document.documentElement?.dataset.design === "simple"
      ? "simple"
      : "detailed";
  return typeof text === "string" ? engineSays(text, design) : text;
}
