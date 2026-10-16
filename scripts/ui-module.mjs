// Runs a source file of the interface in plain Node, without a browser or a bundler, so its logic
// can be tested. Used by ui-state-smoke.mjs and by every scripts/ui-tests/*.test.mjs.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ui = fileURLToPath(new URL("../ui/", import.meta.url));
/** Finds packages the way the interface does: in ui/node_modules. */
export const requireUi = createRequire(
  new URL("../ui/package.json", import.meta.url),
);
/** The same for a package that only comes as an ES module. */
export const importUi = (name) =>
  import(pathToFileURL(requireUi.resolve(name)).href);

const ts = requireUi("typescript");
const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
};

/** The file a relative import names: with its extension, or as a folder's index. */
function find(base) {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  throw new Error(`Cannot find ${base}`);
}

/**
 * Compiles `file` (relative to ui/src, or an absolute path), runs it and returns what it exports.
 * Each call starts from scratch, so a store made here is not shared with the next call.
 *
 * - `deps` replaces imports by the text of the specifier, such as `{"./api": stub}`. Any other
 *   import of a package is the real one from ui/node_modules, and a relative one is compiled and
 *   run the same way.
 * - `globals` are names the file may use without importing them, such as `document`.
 */
export function load(file, deps = {}, globals = {}) {
  const modules = new Map();
  const names = Object.keys(globals);
  const values = Object.values(globals);
  function run(absolute) {
    const known = modules.get(absolute);
    if (known) return known.exports;
    const source = readFileSync(absolute, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions,
      fileName: absolute,
    }).outputText;
    const module = { exports: {} };
    // Before it runs, so that two files that import each other get the half that exists.
    modules.set(absolute, module);
    const needs = (specifier) => {
      if (Object.hasOwn(deps, specifier)) return deps[specifier];
      if (specifier.startsWith("."))
        return run(find(path.resolve(path.dirname(absolute), specifier)));
      return requireUi(specifier);
    };
    new Function("require", "module", "exports", ...names, compiled)(
      needs,
      module,
      module.exports,
      ...values,
    );
    return module.exports;
  }
  return run(path.isAbsolute(file) ? file : path.join(ui, "src", file));
}
