// The loader the other tests stand on: replaced imports, relative imports, names without an import.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "../ui-module.mjs";

/** Runs `body` with a function that writes source files into a folder that is gone afterwards. */
function inFolder(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "laci-ui-module-"));
  const write = (name, text) => {
    writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };
  try {
    body(write);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A default export is given `test`, to register tests as it likes.
export default function (test) {
  test("a file gets its replaced imports, its relative imports and its free names", () =>
    inFolder((write) => {
      write("answer.ts", "export const answer: number = 41 + 1;");
      const main = write(
        "main.ts",
        `import { answer } from "./answer";
         import { ask } from "./ask";
         export const result: string = ask(answer) + ", " + typeof document;`,
      );
      const exported = load(
        main,
        { "./ask": { ask: (n) => `the answer is ${n}` } },
        { document: {} },
      );
      assert.equal(exported.result, "the answer is 42, object");
    }));

  test("every call starts again from nothing", () =>
    inFolder((write) => {
      const counter = write(
        "counter.ts",
        "let n = 0; export const next = () => ++n;",
      );
      const [first, second] = [load(counter), load(counter)];
      assert.equal(first.next(), 1);
      assert.equal(first.next(), 2);
      assert.equal(second.next(), 1);
    }));

  test("two files that import each other still load", () =>
    inFolder((write) => {
      const a = write(
        "a.ts",
        `import { b } from "./b"; export const a = () => "a" + b();`,
      );
      write(
        "b.ts",
        `import * as a from "./a"; export const b = () => "b" + typeof a.a;`,
      );
      assert.equal(load(a).a(), "abfunction");
    }));

  test("an import that is nowhere is an error", () =>
    inFolder((write) => {
      const lost = write("lost.ts", `import "./nowhere"; export const x = 1;`);
      assert.throws(() => load(lost), /Cannot find .*nowhere/);
    }));
}
