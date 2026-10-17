/**
 * Makes `Date.now()` and `new Date()` start at `from` and run on from there, so "3 days ago" and
 * "due in 5 days" read the same on every day the preview is opened. `advance` moves the clock on,
 * for checks of what changes with the day.
 */
export function freezeClock(from: string) {
  const RealDate = Date;
  const loaded = RealDate.now();
  let moved = RealDate.parse(from) - loaded;
  const now = () => RealDate.now() + moved;
  window.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length ? args : [now()], newTarget),
    // `Date()` without `new` tells the time as text.
    apply: () => new RealDate(now()).toString(),
    get: (target, property, receiver) =>
      property === "now" ? now : Reflect.get(target, property, receiver),
  });
  return {
    advance(ms: number) {
      moved += ms;
    },
  };
}
