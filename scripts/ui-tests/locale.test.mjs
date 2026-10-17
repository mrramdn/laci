// The language of dates in ui/src/helpers.ts: the system's, or British English, which every date was
// written in before. With en-GB the helpers give what the old code gave.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "../ui-module.mjs";

/** helpers.ts on a page whose `navigator` is `navigator`, or on none when it is undefined. */
const on = (navigator) => load("helpers.ts", {}, { navigator });

/** The date helpers as they were with "en-GB" written into them. */
function before(helpers) {
  const year = (d) => d.getFullYear() !== new Date().getFullYear();
  const date = (at) =>
    at
      ? new Date(at).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          ...(year(new Date(at)) ? { year: "numeric" } : {}),
        })
      : "—";
  return {
    date,
    dayLabel: (day) => {
      const back = helpers.daysBack(day);
      return back === 0
        ? "Today"
        : back === 1
          ? "Yesterday"
          : day.toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "short",
              ...(year(day) ? { year: "numeric" } : {}),
            });
    },
    shortDay: (ymd) => {
      const day = helpers.localDay(ymd);
      return day
        ? day.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            ...(year(day) ? { year: "numeric" } : {}),
          })
        : ymd;
    },
    when: (at) => {
      if (!at) return "—";
      const d = new Date(at);
      const seconds = (Date.now() - d.getTime()) / 1000;
      const clock = d.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      });
      if (seconds < 60) return "just now";
      if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
      const back = helpers.daysBack(d);
      if (back === 0) return `${Math.floor(seconds / 3600)} h ago · ${clock}`;
      if (back === 1) return `yesterday ${clock}`;
      if (back < 7)
        return `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${clock}`;
      return `${date(at)}${d.getFullYear() === new Date().getFullYear() ? ` ${clock}` : ""}`;
    },
  };
}

const HOUR = 36e5;
/** Moments in the middle of what each helper tells apart, so that a second more or less changes nothing. */
const MOMENTS = [
  undefined,
  new Date(Date.now() - 10e3).toISOString(),
  new Date(Date.now() - 90e3).toISOString(),
  new Date(Date.now() - 5.5 * HOUR).toISOString(),
  new Date(Date.now() - 36 * HOUR).toISOString(),
  new Date(Date.now() - 3.5 * 24 * HOUR).toISOString(),
  new Date(Date.now() - 10.5 * 24 * HOUR).toISOString(),
  new Date(Date.now() - 100.5 * 24 * HOUR).toISOString(),
  new Date(Date.now() - 800.5 * 24 * HOUR).toISOString(),
  "2020-03-05T10:00:00",
  "2031-12-24T18:30:00",
];
const DAYS = ["2020-01-02", "2026-10-13", "2031-12-24", "13 Oct", ""];

export async function withBritishEnglishTheDatesAreWhatTheyAlwaysWere() {
  for (const navigator of [
    { language: "en-GB" },
    undefined,
    { language: "" },
  ]) {
    const helpers = on(navigator);
    const was = before(helpers);
    assert.equal(helpers.LOCALE, "en-GB");
    for (const at of MOMENTS) {
      assert.equal(helpers.date(at), was.date(at), `date ${at}`);
      assert.equal(helpers.when(at), was.when(at), `when ${at}`);
    }
    for (const at of MOMENTS.slice(1)) {
      const day = new Date(at);
      assert.equal(helpers.dayLabel(day), was.dayLabel(day), `dayLabel ${at}`);
    }
    for (const ymd of DAYS)
      assert.equal(helpers.shortDay(ymd), was.shortDay(ymd), `shortDay ${ymd}`);
  }
  // A year ago is written the way it always was.
  assert.equal(
    on({ language: "en-GB" }).date("2020-03-05T10:00:00"),
    "5 Mar 2020",
  );
  assert.equal(on({ language: "en-GB" }).shortDay("2020-01-02"), "2 Jan 2020");
}

export async function theDatesFollowTheLanguageOfTheSystem() {
  for (const language of ["en-US", "de-DE", "id-ID", "fr-FR"]) {
    const helpers = on({ language });
    assert.equal(helpers.LOCALE, language);
    const at = "2020-03-05T10:00:00";
    assert.equal(
      helpers.date(at),
      new Date(at).toLocaleDateString(language, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
      language,
    );
    assert.equal(
      helpers.shortDay("2020-01-02"),
      new Date(2020, 0, 2).toLocaleDateString(language, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
      language,
    );
    // Three and a half days back are a weekday and a time, wherever the clock stands.
    const week = new Date(Date.now() - 3.5 * 24 * HOUR);
    assert.equal(
      helpers.when(week.toISOString()),
      `${week.toLocaleDateString(language, { weekday: "short" })} ${week.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}`,
      language,
    );
    assert.equal(
      helpers.dayLabel(week),
      week.toLocaleDateString(language, {
        weekday: "long",
        day: "numeric",
        month: "short",
        // Early in January, a day of last year.
        ...(week.getFullYear() !== new Date().getFullYear()
          ? { year: "numeric" }
          : {}),
      }),
      language,
    );
  }
  // It is another language: not British English written again.
  assert.notEqual(
    on({ language: "en-US" }).date("2020-03-05T10:00:00"),
    on({ language: "en-GB" }).date("2020-03-05T10:00:00"),
  );
}

export async function aLanguageThePageDoesNotGiveOrKnowIsBritishEnglish() {
  for (const navigator of [
    undefined,
    {},
    { language: undefined },
    { language: null },
    { language: "" },
    { language: "not a tag!" },
    { language: "en_US_POSIX" },
    { language: "xx-YY" },
  ])
    assert.equal(on(navigator).LOCALE, "en-GB", JSON.stringify(navigator));
}

export async function noOtherFileWritesALanguageIntoItsDates() {
  const src = fileURLToPath(new URL("../../ui/src/", import.meta.url));
  const named = readdirSync(src, { recursive: true })
    .filter((file) => /\.tsx?$/.test(file) && !file.startsWith("preview"))
    .filter((file) => readFileSync(src + file, "utf8").includes('"en-GB"'));
  assert.deepEqual(named, ["helpers.ts"]);
}
