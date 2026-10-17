// The shared clock in ui/src/clock.ts: one value per minute, one timer however many listen, a wake
// just after the minute turns, and no timer once nobody listens.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const MINUTE = 60_000;
/** 23:59:30 on 8 October 2026: half a minute before the day turns. */
const EVENING = Date.UTC(2026, 9, 8, 23, 59, 30);

/**
 * clock.ts with a clock and timers the test moves by hand. React's useSyncExternalStore is
 * replaced by one that hands back what it was given, so the test can subscribe and read.
 */
function clock(start) {
  let now = start;
  let id = 0;
  const timers = new Map();
  const { useNow } = load(
    "clock.ts",
    {
      react: {
        useSyncExternalStore: (subscribe, getSnapshot) => ({
          subscribe,
          getSnapshot,
        }),
      },
    },
    {
      Date: { now: () => now },
      setTimeout: (callback, ms) => {
        timers.set(++id, { callback, at: now + ms });
        return id;
      },
      clearTimeout: (handle) => timers.delete(handle),
    },
  );
  return {
    ...useNow(),
    timers,
    /** Moves the clock on by `ms`, running each timer that comes due, in order. */
    pass(ms) {
      const end = now + ms;
      for (;;) {
        const [next] = [...timers].sort((a, b) => a[1].at - b[1].at);
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = end;
    },
  };
}

export async function theTimeHoldsStillUntilTheMinuteTurns() {
  const time = clock(EVENING);
  const minute = time.getSnapshot();
  assert.equal(minute, EVENING - 30_000);
  time.pass(29_000);
  assert.equal(time.getSnapshot(), minute, "the same value, so nothing draws again");
  time.pass(1_000);
  assert.equal(time.getSnapshot(), minute + MINUTE);
}

export async function oneTimerWakesEveryListenerJustAfterTheMinuteTurns() {
  const time = clock(EVENING);
  const heard = [];
  const stopFirst = time.subscribe(() => heard.push(["first", time.getSnapshot()]));
  const stopSecond = time.subscribe(() => heard.push(["second", time.getSnapshot()]));
  assert.equal(time.timers.size, 1);
  const midnight = EVENING + 30_000;
  const [wake] = time.timers.values();
  assert.ok(
    wake.at > midnight && wake.at - midnight < 1_000,
    "it wakes just after midnight, so Today becomes Yesterday on time",
  );
  time.pass(30_000);
  assert.deepEqual(heard, [], "not before the minute turns");
  time.pass(1_000);
  assert.deepEqual(heard, [
    ["first", midnight],
    ["second", midnight],
  ]);
  time.pass(MINUTE);
  assert.equal(heard.length, 4, "and again each minute");
  assert.equal(time.timers.size, 1);
  stopFirst();
  assert.equal(time.timers.size, 1, "the other one still listens");
  stopSecond();
  assert.equal(time.timers.size, 0, "nobody listens, so no timer runs");
  time.pass(5 * MINUTE);
  assert.equal(heard.length, 4);
}

export async function listeningAgainStartsTheTimerAgain() {
  const time = clock(EVENING);
  time.subscribe(() => {})();
  assert.equal(time.timers.size, 0);
  time.pass(10 * MINUTE);
  let heard = 0;
  time.subscribe(() => heard++);
  assert.equal(time.timers.size, 1);
  time.pass(MINUTE);
  assert.equal(heard, 1);
}
