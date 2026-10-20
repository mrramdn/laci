// ui/src/pick.tsx: the folder picker gives a path, nothing when cancelled, or an error, and the
// button says which.
import assert from "node:assert/strict";
import { load, requireUi } from "../ui-module.mjs";

const ALREADY_OPEN = "The folder picker is already open";

/** pick.tsx with the desktop's reply to `pick/folder` made by `reply`, and its toasts collected. */
function picker(reply) {
  const requests = [];
  const toasts = [];
  const exports = load("pick.tsx", {
    "./api": {
      api: async (name, body) => {
        requests.push([name, body]);
        return reply();
      },
      errorText: (error) =>
        error instanceof Error ? error.message : String(error),
    },
    "./store": { toast: (...args) => toasts.push(args) },
    "./common": { Icon: () => null },
  });
  return { ...exports, requests, toasts };
}

export async function aChosenFolderComesBackAsItsPath() {
  const p = picker(async () => ({ path: "/home/demo/project" }));
  assert.equal(
    await p.pickFolder({ title: "Choose a project folder", defaultPath: "~/project" }),
    "/home/demo/project",
  );
  assert.deepEqual(p.requests, [
    ["pick/folder", { title: "Choose a project folder", defaultPath: "~/project" }],
  ]);
  const picked = [];
  await p.chooseFolder({}, (path) => picked.push(path));
  assert.deepEqual(picked, ["/home/demo/project"]);
  assert.deepEqual(p.toasts, []);
}

export async function aCancelledPickerGivesNothing() {
  const p = picker(async () => ({ path: null }));
  assert.equal(await p.pickFolder(), null);
  const picked = [];
  await p.chooseFolder({}, (path) => picked.push(path));
  assert.deepEqual(picked, []);
  assert.deepEqual(p.toasts, [], "cancelling is not an error");
}

export async function aPickerAlreadyOpenIsAnErrorNotACancel() {
  // The desktop refuses as a string, the way an error reaches the window.
  const p = picker(async () => {
    throw ALREADY_OPEN;
  });
  await assert.rejects(p.pickFolder(), (error) => error === ALREADY_OPEN);
  const picked = [];
  await p.chooseFolder({ title: "Choose" }, (path) => picked.push(path));
  assert.deepEqual(picked, []);
  assert.deepEqual(p.toasts, [
    ["Couldn’t open the folder picker", ALREADY_OPEN, { error: true }],
  ]);
}

export async function aFaultInOnPickIsNotBlamedOnThePicker() {
  const p = picker(async () => ({ path: "/home/demo/project" }));
  await assert.rejects(
    p.chooseFolder({}, () => {
      throw new Error("The form is gone");
    }),
    /The form is gone/,
  );
  assert.deepEqual(p.toasts, []);
}

export async function theButtonSaysWhatItDoes() {
  const { renderToStaticMarkup } = requireUi("react-dom/server");
  const { createElement } = requireUi("react");
  const { ChooseFolder } = picker(async () => ({ path: null }));
  assert.equal(
    renderToStaticMarkup(createElement(ChooseFolder, { onPick() {} })),
    '<button type="button" class="btn">Choose folder…</button>',
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(ChooseFolder, {
        onPick() {},
        label: "Choose another folder…",
        className: "btn sm",
        disabled: true,
      }),
    ),
    '<button type="button" class="btn sm" disabled="">Choose another folder…</button>',
  );
}

export async function aButtonBesideAFieldSaysWhichFolderItChooses() {
  const { renderToStaticMarkup } = requireUi("react-dom/server");
  const { createElement } = requireUi("react");
  const { ChooseFolder } = picker(async () => ({ path: null }));
  // Its words are the same beside every field; its name for a screen reader is not.
  assert.equal(
    renderToStaticMarkup(
      createElement(ChooseFolder, {
        onPick() {},
        label: "Choose…",
        name: "Choose your archive folder",
        title: "Choose your archive folder",
      }),
    ),
    '<button type="button" class="btn" aria-label="Choose your archive folder">Choose…</button>',
  );
}
