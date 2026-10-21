// A project's AI chats: the number on its card and the list on its page count the same chats
// (ui/src/helpers.ts chatsOf and agentCount, ui/src/simple/model.ts projectChats), and the words
// under the page's list say how many it leaves out.
import assert from "node:assert/strict";
import { load } from "../ui-module.mjs";

const helpers = load("helpers.ts");
const model = load("simple/model.ts");
const words = load("words.ts");
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const LACI = "/home/demo/project/laci";
const SITE = "/home/demo/project/site";
const node = (path) => ({ id: path, path, label: path.split("/").at(-1), kind: "project", agents: { claude: [], items: [] } });

/** A chat a day older than the last, `prompts` long; quick ones (two prompts, no file changed) fold away. */
function chat(cwd, id, i, { prompts = 5, ...more } = {}) {
  const at = new Date(NOW - (i + 1) * 86_400_000).toISOString();
  return {
    provider: "claude",
    sessionId: id,
    title: `Chat ${id}`,
    titleSource: "provider",
    cwd,
    sourceKind: "cli",
    updatedAt: at,
    resumeCapability: "supported",
    file: `/home/demo/.claude/projects/x/${id}.jsonl`,
    prompts,
    filesChanged: prompts > 2 ? 1 : 0,
    ...more,
  };
}
function scan(sessions) {
  return {
    home: "/home/demo",
    nodes: { [LACI]: node(LACI), [SITE]: node(SITE) },
    claude: {},
    items: {},
    connectors: [],
    proposals: [],
    sessions,
  };
}

export async function aProjectsPageListsEveryChatItsCardCounts() {
  // Five longer chats and three quick ones: the card said 8, the page listed 3 and "and 3 quick chats".
  const sessions = [
    ...[0, 1, 2, 3, 4].map((i) => chat(LACI, `long-${i}`, i)),
    ...[5, 6, 7].map((i) => chat(LACI, `quick-${i}`, i, { prompts: 1 })),
  ];
  const s = scan(sessions);
  const chats = model.projectChats(s, s.nodes[LACI], NOW);
  assert.equal(chats.total, 8);
  assert.equal(helpers.agentCount(s.nodes[LACI], s), 8);
  assert.deepEqual(chats.shown.map((c) => c.session.sessionId), ["long-0", "long-1", "long-2"]);
  assert.equal(chats.more, 2);
  assert.equal(chats.quick, 3);
  assert.equal(chats.shown.length + chats.more + chats.quick, chats.total, "nothing is left out unsaid");
  const say = words.project.chats.rest;
  assert.equal(say(chats.more, chats.quick), "and 2 more chats and 3 quick chats");
  assert.equal(say(0, 3), "and 3 quick chats");
  assert.equal(say(1, 0), "and 1 more chat");
}

export async function subagentsOfAChatInAnotherProjectAreNoChatsOfTheirOwn() {
  // A chat in laci ran subagents that worked in site. They are part of that chat, as every list shows,
  // so site's card doesn't count them as chats its page never lists.
  const parent = chat(LACI, "parent", 0);
  const subagents = [1, 2, 3].map((i) =>
    chat(SITE, `agent-${i}`, 0, {
      sourceKind: "subagent",
      parentId: "parent",
      resumeCapability: "history-only",
      file: `/home/demo/.claude/projects/x/parent/subagents/agent-${i}.jsonl`,
    }),
  );
  const s = scan([parent, ...subagents]);
  assert.equal(helpers.agentCount(s.nodes[SITE], s), 0);
  assert.equal(model.projectChats(s, s.nodes[SITE], NOW).total, 0);
  assert.equal(helpers.agentCount(s.nodes[LACI], s), 1);
  const [only] = helpers.chatsOf(s.nodes[LACI], s);
  assert.equal(only.children.length, 3, "the subagents stay with the chat that ran them");
}
