// The browser preview's stand-in for the desktop (ui/src/preview/ipc.ts), run without a browser.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../ui-module.mjs";

const source = fileURLToPath(new URL("../../ui/src/", import.meta.url));
const ACME = "/home/demo/project/clients/acme-store";

/**
 * Runs `body` with the preview's engine started fresh, and with what it reaches: `request` is the
 * interface's `api`, `invoke` its direct commands. The Tauri API finds the desktop through the
 * page's `window`, so there is a stand-in for it while `body` runs.
 */
async function onPreview(body, options = {}, deps = {}) {
  globalThis.window = { crypto: globalThis.crypto };
  try {
    load("preview/ipc.ts", deps).installIpc({
      design: "detailed",
      theme: "light",
      ...options,
    });
    const invoke = (command, args) =>
      window.__TAURI_INTERNALS__.invoke(command, args);
    await body({
      invoke,
      request: (name, body = {}) => invoke("request", { name, body }),
    });
  } finally {
    // The events a change sends are on their way. They need the window too.
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete globalThis.window;
  }
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === "preview"
        ? []
        : files(path.join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [path.join(dir, entry.name)]
        : [],
  );
}

/** What the interface asks for: the names it gives `api(...)`, and the commands it `invoke`s. */
function asked() {
  const requests = new Set();
  const commands = new Set();
  for (const file of files(source)) {
    const text = readFileSync(file, "utf8");
    for (const [, name] of text.matchAll(
      /\bapi(?:<[^()]*>)?\(\s*"([a-z][a-z/_-]*)"/g,
    ))
      requests.add(name);
    for (const [, name] of text.matchAll(/\binvoke(?:<[^()]*>)?\(\s*"(\w+)"/g))
      commands.add(name);
  }
  return { requests, commands };
}

export async function everyRequestTheInterfaceMakesHasAnAnswer() {
  const { requests, commands } = asked();
  assert.ok(requests.size > 50, `found only ${requests.size} requests`);
  assert.ok(commands.has("term_open"), "found no terminal commands");
  const refused = (error) => /has no answer/.test(String(error));
  const args = {
    id: "t",
    output: { onmessage() {} },
    data: "",
    cols: 1,
    rows: 1,
  };
  await onPreview(async ({ invoke, request }) => {
    for (const name of requests)
      await request(name).catch((error) =>
        assert.ok(!refused(error), `the preview cannot answer "${name}"`),
      );
    for (const command of commands)
      if (command !== "request")
        await invoke(command, args).catch((error) =>
          assert.ok(!refused(error), `the preview cannot answer ${command}`),
        );
  });
}

export async function aRequestNobodyAnsweredIsRefusedInPlainWords() {
  await onPreview(async ({ request }) => {
    await assert.rejects(request("no/such/request"), (error) => {
      assert.equal(typeof error, "string");
      assert.match(error, /no answer for "no\/such\/request"/);
      return true;
    });
  });
}

/**
 * The preview plays a setup whose choice about new versions is saved, so Today and Home show as
 * they do on any setup but one from before 3.0, whose card asks once (?updates=unset plays that).
 */
export async function thePreviewHasChosenToLookForNewVersions() {
  await onPreview(async ({ request }) => {
    assert.equal((await request("prefs")).updates, "daily");
    assert.equal((await request("update/status")).enabled, true);
  });
}

export async function theFixturesAreWhatTheEngineRecordedAtTheFixtureTime() {
  await onPreview(async ({ request }) => {
    const snapshot = await request("snapshot");
    assert.equal(snapshot.scannedAt, "2026-10-08T09:00:00.000Z");
    assert.equal(snapshot.home, "/home/demo");
    assert.ok(Object.hasOwn(snapshot.nodes, ACME));
    assert.deepEqual(await request("status"), {
      type: "status",
      busy: false,
      revision: snapshot.revision,
      historyPending: false,
    });
  });
}

export async function aTickedToDoShowsInTheProjectTheLogAndCanBeUndone() {
  await onPreview(async ({ request }) => {
    const before = await request("snapshot");
    const task = before.nodes[ACME].tasks.find((t) => !t.done);
    const done = (snapshot) =>
      snapshot.nodes[ACME].tasks.find((t) => t.text === task.text).done;
    const node = await request("todo", {
      id: ACME,
      op: "toggle",
      file: task.file,
      line: task.line,
      text: task.text,
      done: true,
    });
    assert.equal(node.tasks.find((t) => t.text === task.text).done, true);
    assert.ok(node.revision > before.revision);
    assert.equal(done(await request("snapshot")), true);
    const [entry] = (await request("log")).entries;
    assert.equal(entry.title, "Ticked a to-do in acme-store");
    assert.equal(entry.canUndo, true);

    await request("undo", { id: entry.id });
    assert.equal(done(await request("snapshot")), false);
    const log = (await request("log")).entries;
    assert.equal(log[0].title, "Undid: Ticked a to-do in acme-store");
    assert.equal(log[1].state, "undone");
  });
}

export async function theCopyOfChatsMovesToAChosenFolderAndUndoBringsItBack() {
  await onPreview(async ({ request }) => {
    const before = (await request("snapshot")).backup;
    assert.deepEqual([before.dest, before.chosen], ["~/.local/share/laci/history", false]);
    await request("backup");
    assert.equal((await request("snapshot")).backup.packed, true, "a backup packs every file");
    const moved = await request("backup/move", { dir: "/media/backup/ai-chats" });
    assert.deepEqual([moved.dest, moved.moved, moved.bytes], ["/media/backup/ai-chats", true, 40960]);
    assert.equal(moved.journal.canUndo, true);
    const after = (await request("snapshot")).backup;
    assert.deepEqual([after.dest, after.chosen], ["/media/backup/ai-chats", true]);
    const part = (await request("storage")).parts.find((p) => p.id === "history");
    assert.deepEqual([part.dir, part.elsewhere], ["/media/backup/ai-chats", true]);
    const [entry] = (await request("log")).entries;
    assert.deepEqual(entry.say, { form: "movedCopy", dir: "/media/backup/ai-chats", own: false });
    await assert.rejects(request("backup/move", { dir: "/media/backup/ai-chats" }), /already/);
    // A folder in home is said with ~, as the engine says it.
    await request("undo", { id: entry.id });
    assert.deepEqual((await request("snapshot")).backup.dest, "~/.local/share/laci/history");
    assert.equal((await request("backup/move", { dir: "/home/demo/chats" })).dest, "~/chats");
    assert.equal((await request("backup/move", { dir: "" })).dest, "~/.local/share/laci/history");
    assert.deepEqual((await request("log")).entries[0].say, {
      form: "movedCopy",
      dir: "~/.local/share/laci/history",
      own: true,
    });
  });
}

export async function theCopyCanTakeOnlyTheProjectsChosenForIt() {
  await onPreview(async ({ request }) => {
    assert.equal((await request("snapshot")).backup.only, undefined);
    const chosen = { paths: [ACME, "/home/demo/project/clients"], outside: true };
    const saved = await request("backup/only", { only: chosen });
    assert.deepEqual(saved.only, { paths: ["/home/demo/project/clients", ACME], outside: true });
    // The folders holding chats that aren't taken: the top folder, kopi-landing, infra-notes and campus-lms.
    assert.deepEqual((await request("snapshot")).backup.only, { ...saved.only, notCopied: 4, missing: [] });
    assert.deepEqual(saved.snapshot.backup.only, { ...saved.only, notCopied: 4, missing: [] });
    const [entry] = (await request("log")).entries;
    // Two folders, of which one is a project, as the engine says them.
    assert.deepEqual(
      [entry.key, entry.say],
      ["copyChoice", { form: "copyChosen", folders: 2, projects: 1, outside: true }],
    );
    // The title is in Detailed's words, as its Log shows it: by projects, and the chats outside them.
    assert.equal(entry.title, "History backup takes only 1 project you chose, and chats outside your projects");
    // The same choice again is no change, and no entry.
    await request("backup/only", { only: chosen });
    assert.equal((await request("log")).entries[0].id, entry.id);
    // Every project again, which Undo of the first choice would also give.
    assert.equal((await request("backup/only", { only: null })).only, null);
    assert.equal((await request("snapshot")).backup.only, undefined);
    const [every] = (await request("log")).entries;
    assert.deepEqual([every.title, every.say], ["History backup takes every project", { form: "copyEveryProject" }]);
    await request("undo", { id: every.id });
    assert.equal((await request("snapshot")).backup.only.paths.length, 2);
  });
}

export async function theLogSaysAChoiceByProjectsElseFoldersElseTheChatsOutsideThem() {
  await onPreview(async ({ request }) => {
    const said = async (only) => {
      await request("backup/only", { only });
      const [entry] = (await request("log")).entries;
      return [entry.title, entry.say];
    };
    // By projects, without the chats outside them.
    assert.deepEqual(await said({ paths: [ACME, "/home/demo/project/clients/kopi-landing"], outside: false }), [
      "History backup takes only 2 projects you chose",
      { form: "copyChosen", folders: 2, projects: 2, outside: false },
    ]);
    // Only groups: by folders.
    assert.deepEqual(await said({ paths: ["/home/demo/project/clients"], outside: false }), [
      "History backup takes only 1 folder you chose",
      { form: "copyChosen", folders: 1, projects: 0, outside: false },
    ]);
    assert.deepEqual(await said({ paths: ["/home/demo/project/clients", "/home/demo/Documents"], outside: true }), [
      "History backup takes only 2 folders you chose, and chats outside your projects",
      { form: "copyChosen", folders: 2, projects: 0, outside: true },
    ]);
    // No folder, and the chats outside them: those alone, not "0 chosen folders".
    assert.deepEqual(await said({ paths: [], outside: true }), [
      "History backup takes only chats outside your projects",
      { form: "copyChosen", folders: 0, projects: 0, outside: true },
    ]);
    assert.deepEqual(await said({ paths: [], outside: false }), [
      "History backup takes no project",
      { form: "copyChosen", folders: 0, projects: 0, outside: false },
    ]);
  });
}

export async function aChosenFolderTheDemoDiskLacksIsMissingAndCountsFollowTheChats() {
  await onPreview(async ({ request }) => {
    const gone = "/home/demo/project/old-name";
    const there = "/home/demo/Documents";
    await request("backup/only", { only: { paths: [ACME, gone, there], outside: false } });
    // Only a folder the demo disk doesn't have is missing; a scanned one or one outside the project folders isn't.
    assert.deepEqual((await request("snapshot")).backup.only.missing, [gone]);
    assert.deepEqual((await request("log")).entries[0].say, {
      form: "copyChosen",
      folders: 3,
      projects: 1,
      outside: false,
    });
    // The chats of kopi-landing and infra-notes deleted, the next choice counts what is left: the top folder and
    // campus-lms, not the folders whose chats are gone.
    const files = (await request("snapshot")).sessions
      .filter((s) => /kopi-landing|infra-notes/.test(s.cwd))
      .map((s) => s.file);
    await request("session/delete", { files });
    await request("backup/only", { only: { paths: [ACME], outside: false } });
    assert.equal((await request("snapshot")).backup.only.notCopied, 2);
  });
}

export async function theArchivedGroupGoesBackWholeAndItsProjectsWaitForIt() {
  const group = "/home/demo/project/_archive/old-clients";
  const batik = `${group}/batik-shop`;
  const origin = "/home/demo/project/old-clients";
  await onPreview(async ({ request }) => {
    const nodes = (await request("snapshot")).nodes;
    // The group: a folder in the archive, archived by its .laci.md, whose old place is a link to it.
    assert.deepEqual(
      [nodes[group].kind, nodes[group].archived, nodes[group].inArchive, nodes[group].meta.status],
      ["folder", true, true, "archived"],
    );
    assert.deepEqual(
      nodes[group].restorePlan.ops.map((op) => [op.kind, op.label, op.from, op.to]).slice(0, 2),
      [
        ["unlink", "Remove the old link", "~/project/old-clients", "~/project/_archive/old-clients"],
        ["move", "Move folder", "~/project/_archive/old-clients", "~/project/old-clients"],
      ],
    );
    // Each of its projects is reached through that link, so it waits for the group.
    assert.deepEqual(
      [nodes[batik].restorePlan.reason, nodes[batik].restorePlan.dest],
      ["linked", `${origin}/batik-shop`],
    );
    assert.match(nodes[batik].restorePlan.error, /^~\/project\/old-clients is a link into the archive\. Restore the whole group old-clients/);
    // Another place for it is fine; a place through the link isn't, and the link itself is the group's.
    const away = await request("restore/plan", { id: batik, destination: "/home/demo/project/batik-shop" });
    assert.equal(away.error, undefined);
    const through = await request("restore/plan", { id: batik, destination: `${origin}/shop` });
    assert.equal(through.reason, "linked");
    const onLink = await request("restore/plan", { id: batik, destination: origin });
    assert.equal(onLink.reason, "occupied");
    // Elsewhere, the group leaves the link where it is.
    const moved = await request("restore/plan", { id: group, destination: "/home/demo/project/clients-old" });
    assert.deepEqual(moved.ops.map((op) => op.kind).includes("unlink"), false);
    const back = await request("restore/plan", { id: group, destination: origin });
    assert.equal(back.ops[0].kind, "unlink");
    // Put back: the group and its projects leave the archive, and the Log says the link went first.
    await request("restore", { id: group, destination: origin });
    const after = (await request("snapshot")).nodes;
    assert.deepEqual(
      [group, batik].map((id) => [after[id].archived, after[id].inArchive, after[id].restorePlan]),
      [
        [false, false, undefined],
        [false, false, undefined],
      ],
    );
    const [entry] = (await request("log")).entries;
    assert.deepEqual(
      entry.steps.map((step) => [step.kind, step.label]),
      [
        ["unlink", "Removed the old link"],
        ["move", "Moved"],
        ["write", "Edited .laci.md"],
      ],
    );
    assert.deepEqual([entry.steps[0].from, entry.steps[0].to], ["~/project/old-clients", "~/project/_archive/old-clients"]);
    // Undo puts the marks back.
    await request("undo", { id: entry.id });
    const undone = (await request("snapshot")).nodes;
    assert.equal(undone[batik].restorePlan.reason, "linked");
    assert.equal(undone[group].meta.archivedFrom, "~/project/old-clients");
  });
}

export async function aRestoredGroupClearsTheArchivedMarkOfEverythingInIt() {
  const group = "/home/demo/project/_archive/old-clients";
  const batik = `${group}/batik-shop`;
  const warung = `${group}/warung-pos`;
  await onPreview(async ({ request }) => {
    // warung-pos says archived in its own .laci.md; batik-shop is archived only by where it is.
    await request("archive", { id: warung });
    await request("restore", { id: group, destination: "/home/demo/project/old-clients" });
    const after = (await request("snapshot")).nodes;
    // As the engine does it: the group's .laci.md and every one in it that says archived lose the
    // mark in the same change, so nothing in the group stays archived where it now is.
    assert.deepEqual(
      [group, batik, warung].map((id) => [
        after[id].archived,
        after[id].inArchive,
        after[id].status.value,
        after[id].meta.status,
        after[id].restorePlan,
      ]),
      [
        [false, false, "idle", undefined, undefined],
        [false, false, "idle", undefined, undefined],
        [false, false, "idle", undefined, undefined],
      ],
    );
    // One Undo brings every mark back.
    const [entry] = (await request("log")).entries;
    await request("undo", { id: entry.id });
    const undone = (await request("snapshot")).nodes;
    assert.deepEqual(
      [group, warung].map((id) => [undone[id].archived, undone[id].meta.status]),
      [
        [true, "archived"],
        [true, "archived"],
      ],
    );
  });
}

export async function aFolderOfProjectsIsArchivedAsAGroupAndComesBackWhole() {
  const clients = "/home/demo/project/clients";
  const acme = `${clients}/acme-store`;
  const kopi = `${clients}/kopi-landing`;
  await onPreview(async ({ request }) => {
    const nodes = (await request("snapshot")).nodes;
    // Each folder of projects has a plan as a group; a scan location, the archive and an archived
    // group have none.
    const planned = Object.values(nodes)
      .filter((n) => n.kind === "folder" && n.archivePlan)
      .map((n) => n.path)
      .sort();
    assert.deepEqual(planned, ["clients", "side", "thesis"].map((name) => `/home/demo/project/${name}`));
    assert.equal(nodes[clients].projectCount, 2);
    // Its checks are those of its projects, each naming its project beside its own title.
    assert.deepEqual(
      nodes[clients].archivePlan.checks.map((c) => [c.code, c.project, c.projectId, c.title]),
      [
        ["dirty", "acme-store", acme, "1 uncommitted change"],
        ["unpushed", "acme-store", acme, "8 commits not pushed"],
        ["no-remote", "kopi-landing", kopi, "No remote"],
        ["dirty", "kopi-landing", kopi, "1 uncommitted change"],
      ],
    );
    const plan = await request("archive/plan", { id: clients });
    // The recorded plan of each folder planned as a group is the one its scan holds.
    for (const id of ["clients", "side", "thesis"].map((name) => `/home/demo/project/${name}`))
      assert.deepEqual(await request("archive/plan", { id }), nodes[id].archivePlan);
    assert.equal(plan.dest, "/home/demo/project/_archive/clients");
    assert.equal(plan.ops.at(-2).label, "Set status: archived");
    // Archived: an archived group, with everything in it in the archive and its own .laci.md saying
    // where it came from.
    await request("archive", { id: clients, destination: plan.dest, trashHeavy: false });
    const after = (await request("snapshot")).nodes;
    assert.deepEqual(
      [after[clients].archived, after[clients].inArchive, after[clients].meta.status],
      [true, true, "archived"],
    );
    assert.equal(after[clients].meta.archivedFrom, "~/project/clients");
    assert.equal(after[clients].restorePlan.dest, clients);
    assert.deepEqual(
      [acme, kopi].map((id) => [after[id].archived, after[id].inArchive]),
      [
        [true, true],
        [true, true],
      ],
    );
    const { isArchivedGroup, archivedGroupOf, linkedGroup } = load("helpers.ts");
    assert.equal(isArchivedGroup(after[clients]), true);
    assert.equal(archivedGroupOf(after, after[acme])?.id, clients);
    // Each project in it goes back with it, as the engine says it: alone, only to a place of its own.
    // The refusal names no place, as the one it came from is the group's.
    assert.deepEqual(
      [after[acme].restorePlan.reason, after[acme].restorePlan.group, "dest" in after[acme].restorePlan],
      ["inGroup", clients, false],
    );
    assert.equal(linkedGroup(after, after[acme])?.id, clients);
    // A place inside the one the group goes back to would be in its way: refused the same.
    const own = await request("restore/plan", { id: acme, destination: acme });
    assert.deepEqual([own.reason, own.group, "dest" in own], ["inGroup", clients, false]);
    assert.match(own.error, /goes back whole to ~\/project\/clients\. Restore clients, or choose a place outside it/);
    const [entry] = (await request("log")).entries;
    assert.equal(entry.title, "Archived clients");
    // Restored, the group and every one in it leave the archive, and none says archived.
    await request("restore", { id: clients, destination: clients });
    const back = (await request("snapshot")).nodes;
    // acme-store's own status, active, was never an archived mark: it stays.
    assert.deepEqual(
      [clients, acme, kopi].map((id) => [back[id].archived, back[id].inArchive, back[id].meta.status]),
      [
        [false, false, undefined],
        [false, false, "active"],
        [false, false, undefined],
      ],
    );
    assert.deepEqual(
      [acme, kopi].map((id) => [back[id].status.value, back[id].status.auto]),
      [
        ["active", false],
        ["idle", true],
      ],
    );
    // Undo of the archive, after Undo of the restore, gives the folder back as it was.
    const [restored, archived] = (await request("log")).entries;
    await request("undo", { id: restored.id });
    await request("undo", { id: archived.id });
    const undone = (await request("snapshot")).nodes;
    assert.deepEqual(
      [undone[clients].archived, undone[clients].inArchive, undone[clients].meta.status],
      [false, false, undefined],
    );
    assert.equal(undone[acme].meta.status, "active");
  });
}

export async function aProjectInAGroupThePreviewArchivedGoesBackAloneToAPlaceOfItsOwn() {
  const clients = "/home/demo/project/clients";
  const acme = `${clients}/acme-store`;
  await onPreview(async ({ request }) => {
    const plan = await request("archive/plan", { id: clients });
    await request("archive", { id: clients, destination: plan.dest, trashHeavy: false });
    // Without a place, the engine's refusal; with one, a plan, and the restore.
    await assert.rejects(request("restore", { id: acme }), /in the archived group clients/);
    const away = "/home/demo/project/acme-store";
    assert.equal((await request("restore/plan", { id: acme, destination: away })).dest, away);
    await request("restore", { id: acme, destination: away });
    const after = (await request("snapshot")).nodes;
    assert.deepEqual([after[acme].archived, after[clients].archived], [false, true]);
  });
}

export async function aGroupInsideAGroupThePreviewArchivedGoesBackWithItAsTheEngineSays() {
  // clients holds 2024, a folder whose own .laci.md says archived, with a project in it, and plain,
  // a folder with none. Archived with clients, 2024 is an archived group inside it: the engine
  // refuses it alone without a place (reason "inGroup", naming clients), as a project in it.
  const clients = "/home/demo/project/clients";
  const nested = `${clients}/2024`;
  const plain = `${clients}/plain`;
  const site = `${nested}/site`;
  const fixtures = JSON.parse(
    readFileSync(new URL("../../ui/src/preview/fixtures.json", import.meta.url), "utf8"),
  );
  const nodes = fixtures.snapshot.nodes;
  const folder = (path, meta) => ({
    ...structuredClone(nodes[clients]),
    id: path,
    path,
    name: path.split("/").pop(),
    label: path.split("/").pop(),
    parent: clients,
    children: [],
    meta,
    archivePlan: undefined,
    projectCount: undefined,
  });
  nodes[nested] = folder(nested, { status: "archived" });
  nodes[plain] = folder(plain, {});
  nodes[site] = {
    ...structuredClone(nodes[`${clients}/kopi-landing`]),
    id: site,
    path: site,
    name: "site",
    label: "site",
    parent: nested,
  };
  nodes[nested].children = [site];
  await onPreview(
    async ({ request }) => {
      const plan = await request("archive/plan", { id: clients });
      await request("archive", { id: clients, destination: plan.dest, trashHeavy: false });
      const after = (await request("snapshot")).nodes;
      const { isArchivedGroup, archivedGroupOf } = load("helpers.ts");
      assert.deepEqual(
        [nested, site].map((id) => [after[id].restorePlan?.reason, after[id].restorePlan?.group]),
        [
          ["inGroup", clients],
          ["inGroup", clients],
        ],
      );
      assert.equal(isArchivedGroup(after[nested]), true);
      // A plain folder in it has no plan of its own: it isn't put back by itself.
      assert.equal(after[plain].restorePlan, undefined);
      // The outermost group is the one listed and restored for both.
      assert.equal(archivedGroupOf(after, after[site])?.id, clients);
      await assert.rejects(request("restore", { id: nested }), /in the archived group clients/);
      await assert.rejects(request("restore", { id: site }), /in the archived group clients/);
      // With a place of its own, it goes back alone, with what it holds.
      const away = "/home/demo/project/2024";
      assert.equal((await request("restore/plan", { id: nested, destination: away })).dest, away);
      await request("restore", { id: nested, destination: away });
      const back = (await request("snapshot")).nodes;
      assert.deepEqual(
        [nested, site, clients].map((id) => back[id].archived),
        [false, false, true],
      );
    },
    {},
    { "./fixtures.json": fixtures },
  );
}

export async function theCopyOfChatsIsToldAsTheEngineTellsIt() {
  await onPreview(async ({ request }) => {
    // Laci's own folder: no status.
    assert.equal((await request("snapshot")).copyStatus, null);
    await request("backup/move", { dir: "/home/demo/Backups" });
    assert.deepEqual((await request("snapshot")).copyStatus, { path: "/home/demo/Backups", available: true });
    const [entry] = (await request("log")).entries;
    await request("undo", { id: entry.id });
    assert.equal((await request("snapshot")).copyStatus, null);
  });
  // "?copy=offline": a folder on a drive that isn't connected, unavailable with why.
  await onPreview(
    async ({ request }) => {
      const snapshot = await request("snapshot");
      const { OFFLINE_COPY } = load("preview/ipc.ts");
      assert.deepEqual(
        [snapshot.copyStatus.path, snapshot.copyStatus.available],
        [OFFLINE_COPY, false],
      );
      assert.match(snapshot.copyStatus.reason, /Connect its drive/);
      assert.equal(snapshot.backup.error, snapshot.copyStatus.reason);
      const { copyOffline } = load("helpers.ts");
      assert.equal(copyOffline(snapshot)?.path, OFFLINE_COPY);
    },
    { copy: "offline" },
  );
}

export async function aReportIsFoundByTheWordsInIt() {
  await onPreview(async ({ request }) => {
    const hits = await request("reports/search", { query: "checkout safari" });
    assert.deepEqual(
      hits.map((hit) => hit.id),
      ["2026-10-07-checkout-total-on-mobile-safari.md"],
    );
    assert.match(hits[0].snippet, /checkout/i);
  });
}
