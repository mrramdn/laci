import { useSyncExternalStore } from "react";

const MINUTE = 60_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** The start of the current minute: the same value until the minute turns. */
const thisMinute = () => Math.floor(Date.now() / MINUTE) * MINUTE;
function wakeNextMinute() {
  // Just past the turn of the minute, so "Today" becomes "Yesterday" at midnight, not a minute later.
  timer = setTimeout(
    () => {
      wakeNextMinute();
      for (const listener of listeners) listener();
    },
    MINUTE - (Date.now() % MINUTE) + 20,
  );
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) wakeNextMinute();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    clearTimeout(timer);
    timer = undefined;
  };
}
/**
 * The time to the minute, one value for the whole window. A component that says how long ago
 * something was, or which day it is, calls this and draws again when the minute turns. The store
 * stays as it is, so what the helpers keep per snapshot stays kept. One timer runs while anything
 * listens.
 */
export function useNow() {
  return useSyncExternalStore(subscribe, thisMinute);
}
