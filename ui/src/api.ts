import { invoke } from "@tauri-apps/api/core";
export function api<T>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>("request", { name, body });
}
export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);
}
