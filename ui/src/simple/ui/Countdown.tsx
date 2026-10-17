import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { blocks } from "../../words";
import { Button } from "./Button";
import { startCountdown } from "./countdown";
import type { Countdown as Clock } from "./countdown";

/**
 * The last step before something that can't be undone: `what` happens in `seconds` seconds unless
 * the user cancels, with the Cancel button or Escape. Nothing is asked of the engine before the end:
 * `onDone` runs then, and only then. Leaving the screen cancels too. A ring runs out beside the
 * words; with reduced motion there are only the words.
 */
export function Countdown({
  what,
  seconds = 5,
  onDone,
  onCancel,
}: {
  /** What will happen, as "Moving acme-store to the Trash". */
  what: string;
  seconds?: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [left, setLeft] = useState(seconds);
  const clock = useRef<Clock | null>(null);
  const handlers = useRef({ onDone, onCancel });
  handlers.current = { onDone, onCancel };
  useEffect(() => {
    const running = startCountdown(seconds, {
      tick: setLeft,
      done: () => handlers.current.onDone(),
    });
    clock.current = running;
    return () => {
      running.cancel();
    };
  }, [seconds]);
  const cancel = () => {
    if (clock.current?.cancel()) handlers.current.onCancel();
  };
  useEffect(() => {
    // Escape stops the countdown first, before a sheet around it could take it as "close".
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !clock.current?.cancel()) return;
      event.preventDefault();
      event.stopPropagation();
      handlers.current.onCancel();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);
  return (
    <div
      className="s-countdown"
      data-ui="countdown"
      style={{ "--s-seconds": `${seconds}s` } as CSSProperties}
    >
      <svg className="s-countdown-ring" viewBox="0 0 40 40" aria-hidden="true">
        <circle className="s-countdown-track" cx="20" cy="20" r="17" />
        <circle className="s-countdown-left" cx="20" cy="20" r="17" />
      </svg>
      <div className="s-countdown-text">
        <p role="timer">{blocks.countdown(what, left)}</p>
        <p className="s-quiet">{blocks.countdownHint}</p>
      </div>
      <Button kind="outline" onClick={cancel} autoFocus>
        {blocks.cancel}
      </Button>
    </div>
  );
}
