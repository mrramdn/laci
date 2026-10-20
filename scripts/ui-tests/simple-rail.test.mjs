// Simple's rail in a short window whose scrollbars take room, as GTK's classic ones do with
// GTK_OVERLAY_SCROLLING=0 (ui/src/simple/simple.css), and the preview check that sees it
// (scripts/ui-preview-check.mjs --scrollbars --overflow). At 720×560 the rail is taller than the
// window and scrolls. Its scrollbar used to take its room from a rail of a fixed 72 px, until the
// places' words broke in two and the rail scrolled sideways on every screen, 69 px of content in 61.
// - measureBoxes names a box that scrolls sideways by itself, and leaves code, fields and hidden
//   boxes alone;
// - in the preview, the scrollbar widens the rail while it scrolls, so its parts keep their 59 px and
//   nothing scrolls sideways; a window tall enough has the rail of 72 px, and the larger tiers keep
//   their sidebar of 216 and 232 px;
// - the toggle's words fit their buttons on one line, and where a rail is squeezed all the same they
//   wrap rather than spill.
// The browser tests need a Chromium, and skip without one; the rail's builds the preview first.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPreview,
  findBrowser,
  measureBoxes,
  measureOverflow,
  parseArgs,
  serve,
  untilFonts,
  untilQuiet,
} from "../ui-preview-check.mjs";

const requireUi = createRequire(new URL("../../ui/package.json", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = JSON.parse(
  readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
);

/**
 * Runs `body(browser)` in a Chromium whose scrollbars take room, or skips without one: Playwright
 * hides headless Chromium's scrollbars unless told not to.
 */
async function withBrowser(t, body) {
  const executablePath = findBrowser();
  if (!executablePath) return t.skip("no Chromium to open a page in");
  const browser = await requireUi("playwright-core").chromium.launch({
    executablePath,
    headless: true,
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  try {
    return await body(browser);
  } finally {
    await browser.close();
  }
}

export async function thePreviewCheckCanShowScrollbarsThatTakeRoom() {
  assert.equal(parseArgs([]).scrollbars, false, "the shots look as they did");
  assert.equal(parseArgs(["--scrollbars", "--overflow"]).scrollbars, true);
}

export async function measureBoxesNamesWhatScrollsSidewaysByItself(t) {
  await withBrowser(t, async (browser) => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<!doctype html><html lang="en"><body style="margin:0">
      <nav id="side" class="rail tight" style="width:100px;overflow:auto"><div style="width:150px">wide</div></nav>
      <div style="width:100px;overflow:hidden"><div style="width:150px">clipped on purpose</div></div>
      <pre style="width:100px;overflow:auto">a line of code that keeps its length</pre>
      <div style="width:100px;overflow:auto;display:none"><div style="width:150px">hidden</div></div>
      <div style="width:100px;overflow:auto"><input style="width:60px" value="a field with more words than it shows"></div>
    </body></html>`);
    assert.deepEqual(await page.evaluate(measureBoxes), [
      { where: "nav#side.rail.tight", scrollWidth: 150, clientWidth: 100 },
    ]);
    await page.setContent('<!doctype html><html lang="en"><body><p>fits</p></body></html>');
    assert.deepEqual(await page.evaluate(measureBoxes), []);
  });
}

/**
 * The rail of Simple's Home in the preview at `width`×`height`, with `css` added: how wide it is, the
 * room its scrollbar takes, whether it scrolls either way, its parts, how the toggle's words sit in
 * their buttons, and what scrolls sideways.
 */
async function railOf(browser, site, [width, height], css = "") {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: "en-GB",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(fixtures.meta.now));
    await page.goto(`${site.url}/preview.html?design=simple&theme=light`);
    await page.locator('[data-ui="nav"]').waitFor();
    if (css) await page.addStyleTag({ content: css });
    await page.evaluate(untilFonts);
    await page.evaluate(untilQuiet, [250, 5_000]);
    const rail = await page.evaluate(() => {
      const nav = document.querySelector('[data-ui="nav"]');
      const range = document.createRange();
      return {
        width: nav.getBoundingClientRect().width,
        // Less the rail's border on the right.
        scrollbar: nav.offsetWidth - nav.clientWidth - 1,
        scrolls: nav.scrollHeight > nav.clientHeight,
        sideways: nav.scrollWidth - nav.clientWidth,
        parts: [...nav.children].map((part) => part.getBoundingClientRect().width),
        toggle: [...nav.querySelectorAll(".s-seg-btn")].map((button) => {
          range.selectNodeContents(button);
          return {
            words: button.textContent,
            spills: button.scrollWidth > button.clientWidth,
            lines: range.getClientRects().length,
          };
        }),
      };
    });
    return {
      ...rail,
      boxes: await page.evaluate(measureBoxes),
      wider: (({ scrollWidth, clientWidth }) => scrollWidth > clientWidth)(
        await page.evaluate(measureOverflow),
      ),
    };
  } finally {
    await context.close();
  }
}

/** The toggle as it should be: each word on one line, inside its button. */
const fits = [
  { words: "Simple", spills: false, lines: 1 },
  { words: "Detailed", spills: false, lines: 1 },
];

export async function theRailNeverScrollsSidewaysWhereScrollbarsTakeRoom(t) {
  await withBrowser(t, async (browser) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "laci-rail-"));
    let site;
    try {
      await buildPreview(root, dir);
      site = await serve(dir);
      const short = await railOf(browser, site, [720, 560]);
      if (short.scrollbar <= 0) return t.skip("this Chromium's scrollbars take no room");
      // The rail scrolls up and down, and its scrollbar sits beside its parts instead of in their room.
      assert.ok(short.scrolls, "the rail is taller than a window 560 px high");
      assert.ok(Math.abs(short.width - (72 + short.scrollbar)) < 1, `${short.width} px wide`);
      assert.deepEqual(short.parts, [59, 59, 59, 59]);
      assert.ok(short.sideways <= 0, `the rail scrolls sideways by ${short.sideways} px`);
      assert.deepEqual(short.toggle, fits);
      assert.deepEqual(short.boxes, []);
      assert.equal(short.wider, false);
      // Tall enough for all of it, the rail is 72 px, as it always is where scrollbars float.
      const tall = await railOf(browser, site, [720, 900]);
      assert.equal(tall.scrolls, false);
      assert.equal(tall.width, 72);
      assert.deepEqual(tall.parts, [59, 59, 59, 59]);
      assert.deepEqual(tall.toggle, fits);
      assert.deepEqual(tall.boxes, []);
      // A browser that leaves the scrollbar's room out of the rail squeezes its parts: their words
      // wrap, and still nothing scrolls sideways.
      const squeezed = await railOf(
        browser,
        site,
        [720, 560],
        ".s-frame { grid-template-columns: 72px minmax(0, 1fr) !important; }",
      );
      assert.equal(squeezed.width, 72);
      assert.ok(squeezed.parts.every((width) => width < 59), `parts of ${squeezed.parts} px`);
      assert.ok(squeezed.sideways <= 0, `the rail scrolls sideways by ${squeezed.sideways} px`);
      assert.deepEqual(squeezed.boxes, []);
      // From 840 px the sidebar has a width of its own, whatever its scrollbar, and the toggle's
      // words sit in a row.
      for (const [size, width] of [
        [[840, 560], 216],
        [[840, 900], 216],
        [[1200, 900], 232],
      ]) {
        const wide = await railOf(browser, site, size);
        assert.equal(wide.width, width, size.join("×"));
        assert.deepEqual(wide.toggle, fits, size.join("×"));
        assert.deepEqual(wide.boxes, [], size.join("×"));
      }
    } finally {
      await site?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
