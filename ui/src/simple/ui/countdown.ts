// The clock behind Simple's Countdown: a few seconds to change your mind before something that
// can't be undone. Pure, with the timers passed in, so the tests can run it without waiting.

export interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}
/** The window's own timers. */
const real: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface Countdown {
  /** Stops it before the end. True if it was still counting: then `done` never runs. */
  cancel: () => boolean;
}

/**
 * Counts `seconds` down, one second at a time: `tick` gets the seconds left after each, and `done`
 * runs once at the end, unless `cancel` came first. Nothing is called when it starts.
 */
export function startCountdown(
  seconds: number,
  on: { tick: (left: number) => void; done: () => void },
  timers: Timers = real,
): Countdown {
  let left = Math.max(1, Math.round(seconds));
  let over = false;
  let timer: unknown;
  const step = () => {
    left -= 1;
    if (left > 0) {
      on.tick(left);
      timer = timers.setTimeout(step, 1000);
      return;
    }
    over = true;
    on.done();
  };
  timer = timers.setTimeout(step, 1000);
  return {
    cancel() {
      if (over) return false;
      over = true;
      timers.clearTimeout(timer);
      return true;
    },
  };
}
