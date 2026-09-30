// MCP server over stdio: agents (Claude Code, Codex, …) get laci's map of projects and make the same
// journaled, undoable changes the app makes, instead of `mv`-ing folders and leaving agent history behind.
// Logs go to stderr; stdout is the protocol.
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import type { Issue, Node, Op, Snapshot } from './core/types.ts'
import { applyAction, archiveProject, journals, moveProject, undo } from './core/ops.ts'
import { scan, sessionCount } from './core/scan.ts'
import { META_RULES, addNext, setMeta, setNotes, toggleCheck } from './core/sidecar.ts'
import { moveOps } from './core/tidy.ts'
import { HOME, stat, tilde, within } from './core/util.ts'

const RISK = new Set(['no-commits', 'no-remote', 'dirty', 'unpushed', 'stash', 'no-git'])
const CONFIRM_HINT = 'Nothing has changed yet. Show this plan to the user; if they agree, call again with confirm: true.'

let snap: Snapshot | undefined
let scannedAt = 0
let inflight: Promise<Snapshot> | undefined

/** Scans take ~10s, so reads reuse a recent one. Changes always start from a fresh scan. */
async function current(maxAge = 60_000) {
  if (snap && Date.now() - scannedAt < maxAge) return snap
  inflight ??= scan()
    .then(s => {
      snap = s
      scannedAt = Date.now()
      return s
    })
    .finally(() => (inflight = undefined))
  return inflight
}
const stale = () => (scannedAt = 0)

const expand = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p)

/** A project by path (absolute or ~/…) or by its name when that name is unique. */
function find(s: Snapshot, ref: string): Node {
  const p = expand(ref.trim()).replace(/\/+$/, '')
  if (path.isAbsolute(p) && s.nodes[p]) return s.nodes[p]
  const hits = Object.values(s.nodes).filter(n => n.label === ref || n.name === ref)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.map(n => tilde(n.path)).join(', ')}. Use the full path.`)
  throw new Error(`No project or folder "${ref}" in the last scan. Call list_projects to see what exists.`)
}

const sessions = sessionCount

function row(s: Snapshot, n: Node) {
  return {
    path: tilde(n.path),
    status: n.status.value + (n.status.auto ? ' (auto)' : ''),
    last_activity: n.lastActivity && `${n.lastActivity.at.slice(0, 10)} (${n.lastActivity.source})`,
    summary: n.summary?.text,
    stack: n.stack?.labels.length ? n.stack.labels : undefined,
    priority: n.meta.priority,
    deadline: n.meta.deadline,
    issues: n.issues.filter(i => i.severity !== 'low').map(i => i.title),
    agent_sessions: sessions(s, n) || undefined,
  }
}

function plan(title: string, ops: Op[], checks: Issue[] = []) {
  const lines = [`Plan: ${title}`]
  if (checks.length) lines.push('', 'Warnings:', ...checks.map(c => `- ${c.title}${c.detail ? `: ${c.detail}` : ''}`))
  lines.push('', 'Changes:')
  ops.forEach((o, i) => lines.push(`${i + 1}. ${o.label}${o.from || o.to ? `: ${o.from ?? ''}${o.from && o.to ? ' → ' : ''}${o.to ?? ''}` : ''}${o.detail ? ` (${o.detail})` : ''}`))
  lines.push('', CONFIRM_HINT)
  return lines.join('\n')
}

const done = (what: string, journalId: string) => `${what}. Every step is journaled; undo_change with id "${journalId}" puts it all back.`

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
/** Tool errors go back to the model as readable text it can act on, not as protocol failures. */
const tool =
  <A>(fn: (a: A) => Promise<unknown>) =>
  async (a: A) => {
    try {
      const r = await fn(a)
      return text(typeof r === 'string' ? r : JSON.stringify(r, null, 1))
    } catch (e) {
      return { ...text((e as Error).message ?? String(e)), isError: true }
    }
  }

const server = new McpServer(
  { name: 'laci', version: '0.1.0' },
  {
    instructions:
      "laci knows every project folder on this machine: git state, README summary, stack, open to-dos, and which Claude Code/Codex sessions and memory belong to it. Use it instead of ls/mv when sorting, moving or archiving projects: its moves carry the agent history along and can be undone. Changes are two-step: call without confirm to get a plan, show it to the user, then call again with confirm: true.",
  },
)

const project = z.string().describe('Project or folder: absolute path, ~/path, or its name if unique')
const confirm = z.boolean().optional().describe('Leave out to get the plan. true only after the user agreed to that plan.')
const read = { readOnlyHint: true, openWorldHint: false }
const edit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const risky = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

server.registerTool(
  'list_projects',
  {
    description: 'List projects with status, last activity, summary, stack and problems. Newest activity first.',
    inputSchema: z.object({
      filter: z.enum(['all', 'active', 'idle', 'dormant', 'archived', 'at_risk']).optional().describe('at_risk = uncommitted, unpushed or no-remote work'),
      query: z.string().optional().describe('Words to match in name, path, summary or stack'),
    }),
    annotations: read,
  },
  tool(async ({ filter = 'all', query }) => {
    const s = await current()
    const words = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
    return Object.values(s.nodes)
      .filter(n => n.kind === 'project')
      .filter(n =>
        filter === 'all' ? true
        : filter === 'archived' ? n.archived
        : filter === 'at_risk' ? n.issues.some(i => RISK.has(i.code))
        : n.status.value === filter && !n.archived,
      )
      .filter(n => words.every(w => `${n.path} ${n.summary?.text ?? ''} ${(n.stack?.labels ?? []).join(' ')}`.toLowerCase().includes(w)))
      .sort((a, b) => (b.lastActivity?.at ?? '').localeCompare(a.lastActivity?.at ?? ''))
      .map(n => row(s, n))
  }),
)

server.registerTool(
  'project_details',
  {
    description: 'Everything laci knows about one project: git, scripts, setup, open to-dos, notes, agent sessions and memory, archive destination.',
    inputSchema: z.object({ project }),
    annotations: read,
  },
  tool(async ({ project: ref }) => {
    const s = await current()
    const n = find(s, ref)
    const g = n.git
    return {
      ...row(s, n),
      kind: n.kind,
      created: n.createdAt && `${n.createdAt.at.slice(0, 10)} (${n.createdAt.source})`,
      git: g && {
        branch: g.branch,
        remote: g.remotes[0]?.web ?? g.remotes[0]?.url ?? null,
        commits: g.commits,
        first_commit: g.firstCommitAt?.slice(0, 10),
        last_commit: g.lastSubject && `${g.lastCommitAt?.slice(0, 10)} ${g.lastSubject}`,
        uncommitted: g.dirty,
        unpushed: g.ahead,
        stashes: g.stashes,
      },
      scripts: n.stack?.scripts.map(x => x.name),
      package_manager: n.stack?.packageManager,
      services: n.stack?.services.length ? n.stack.services : undefined,
      all_issues: n.issues.map(i => `${i.severity}: ${i.title}${i.detail ? ` (${i.detail})` : ''}`),
      open_todos: n.tasks.filter(t => !t.done).map(t => `${t.text} [${t.file}:${t.line}]`),
      notes: n.notes,
      claude_sessions: n.agents.claude.flatMap(k => s.claude[k].sessions).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10).map(x => `${x.at.slice(0, 10)} ${x.title ?? 'untitled'} (id ${x.id})`),
      claude_memory: n.agents.claude.flatMap(k => s.claude[k].memory),
      other_agent_history: (() => {
        const by: Record<string, string[]> = {}
        for (const it of n.agents.items.map(i => s.items[i]).sort((a, b) => b.at.localeCompare(a.at))) {
          const name = s.connectors.find(c => c.id === it.connector)?.name ?? it.connector
          ;(by[name] ??= []).push(`${it.at.slice(0, 10)} ${it.title ?? path.basename(it.file)}`)
        }
        return Object.keys(by).length ? Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.slice(0, 10)])) : undefined
      })(),
      children: n.kind === 'folder' ? n.children.map(c => tilde(c)) : undefined,
      archive_to: n.archivePlan && tilde(n.archivePlan.dest),
    }
  }),
)

server.registerTool(
  'needs_attention',
  {
    description: 'What could be lost or forgotten: work only on this disk, open checkboxes in notes, deadlines, stale handoffs, global warnings.',
    inputSchema: z.object({}),
    annotations: read,
  },
  tool(async () => {
    const s = await current()
    const nodes = Object.values(s.nodes)
    return {
      warnings: s.warnings.map(w => `${w.title}. ${w.detail ?? ''}`),
      could_lose_work: nodes.flatMap(n => n.issues.filter(i => RISK.has(i.code)).map(i => `${tilde(n.path)}: ${i.title}${i.detail ? ` (${i.detail})` : ''}`)),
      deadlines: nodes.filter(n => n.meta.deadline).map(n => `${tilde(n.path)}: ${n.meta.deadline}`),
      open_todos: nodes.flatMap(n => n.tasks.filter(t => t.kind === 'check' && !t.done).map(t => `${tilde(n.path)}: ${t.text} [${t.file}]`)),
      handoffs: nodes.flatMap(n => n.taskFiles.filter(f => f.open && n.tasks.some(t => t.file === f.file && t.kind === 'list' && !t.done)).map(f => `${tilde(n.path)}/${f.file}: ${f.open} open items, edited ${f.at.slice(0, 10)}`)),
    }
  }),
)

server.registerTool(
  'tidy_suggestions',
  {
    description: 'Cleanups laci found: agent history left behind by earlier moves, orphaned sessions, dormant projects, reclaimable space, duplicate clones. Apply one with apply_suggestion.',
    inputSchema: z.object({}),
    annotations: read,
  },
  tool(async () => {
    const s = await current()
    return s.proposals.map(p => ({ id: p.id, title: p.title, why: p.why, confidence: p.confidence, changes: p.ops.length, can_apply: !!p.action }))
  }),
)

server.registerTool(
  'set_project_fields',
  {
    description: "Set status, priority or deadline. Written to the project's .laci.md (never committed). Empty string clears a field.",
    inputSchema: z.object({
      project,
      status: z.enum(['active', 'idle', 'dormant', 'idea', 'paused', 'done', 'archived', '']).optional(),
      priority: z.enum(['high', 'medium', 'low', '']).optional(),
      deadline: z.string().optional().describe('YYYY-MM-DD'),
    }),
    annotations: edit,
  },
  tool(async ({ project: ref, ...fields }) => {
    const n = find(await current(), ref)
    const set = Object.entries(fields).filter(([, v]) => v !== undefined) as [string, string][]
    if (!set.length) throw new Error('Nothing to set')
    for (const [k, v] of set) if (!META_RULES[k].test(v)) throw new Error(`Invalid ${k}: ${v}`)
    for (const [k, v] of set) await setMeta(n.path, k, v || undefined)
    stale()
    return `Saved to ${tilde(n.path)}/.laci.md: ${set.map(([k, v]) => `${k}=${v || '(cleared)'}`).join(', ')}`
  }),
)

server.registerTool(
  'add_next_step',
  {
    description: "Add a to-do under Next in the project's .laci.md. Use it to leave the next step at the end of a session.",
    inputSchema: z.object({ project, text: z.string().min(1).max(300) }),
    annotations: edit,
  },
  tool(async ({ project: ref, text: item }) => {
    const n = find(await current(), ref)
    await addNext(n.path, item)
    stale()
    return `Added to ${tilde(n.path)}/.laci.md`
  }),
)

server.registerTool(
  'complete_task',
  {
    description: 'Tick an open checkbox (in .laci.md, NOTES.md, TODO.md, …) by its text.',
    inputSchema: z.object({ project, text: z.string().describe('The checkbox text, or a unique part of it') }),
    annotations: edit,
  },
  tool(async ({ project: ref, text: q }) => {
    const n = find(await current(0), ref)
    const hits = n.tasks.filter(t => t.kind === 'check' && !t.done && t.text.toLowerCase().includes(q.toLowerCase()))
    if (hits.length !== 1) throw new Error(hits.length ? `"${q}" matches ${hits.length} tasks: ${hits.map(t => t.text).join(' | ')}` : `No open checkbox matching "${q}"`)
    const t = hits[0]
    await toggleCheck(path.join(n.path, t.file), t.line, t.text, true)
    stale()
    return `Ticked "${t.text}" in ${t.file}`
  }),
)

server.registerTool(
  'write_notes',
  {
    description: "Write the Notes section of the project's .laci.md: context for the next session or for the user.",
    inputSchema: z.object({ project, notes: z.string().max(20000), mode: z.enum(['append', 'replace']).optional().describe('Default append') }),
    annotations: edit,
  },
  tool(async ({ project: ref, notes, mode = 'append' }) => {
    const n = find(await current(0), ref)
    const next = mode === 'replace' || !n.notes ? notes : `${n.notes}\n\n${notes}`
    await setNotes(n.path, next)
    stale()
    return `Notes ${mode === 'replace' ? 'replaced' : 'updated'} in ${tilde(n.path)}/.laci.md`
  }),
)

server.registerTool(
  'move_project',
  {
    description: 'Move or rename a project folder and carry its Claude/Codex sessions and memory along. Use for sorting instead of mv. Two-step: plan first, then confirm.',
    inputSchema: z.object({ project, destination: z.string().describe('New full path, e.g. ~/project/clients/acme-site. Must not exist yet.'), confirm }),
    annotations: risky,
  },
  tool(async ({ project: ref, destination, confirm: go }) => {
    const s = await current(go ? 0 : 60_000)
    const n = find(s, ref)
    const dest = path.resolve(expand(destination))
    if (!within(dest, HOME) || dest === HOME) throw new Error('The destination must be inside your home folder')
    if (within(dest, n.path)) throw new Error("Can't move a folder into itself")
    if (await stat(dest)) throw new Error(`${tilde(dest)} already exists`)
    if (!go) return plan(`Move ${n.name} → ${tilde(dest)}`, moveOps(n.path, dest, s), n.issues.filter(i => RISK.has(i.code)))
    const j = await moveProject(s, n.id, dest)
    stale()
    return done(`Moved ${tilde(n.path)} → ${tilde(dest)}`, j.id)
  }),
)

server.registerTool(
  'archive_project',
  {
    description: "Move a project into the nearest _archive folder with its agent history, and mark it archived. Two-step: plan first, then confirm.",
    inputSchema: z.object({ project, confirm }),
    annotations: risky,
  },
  tool(async ({ project: ref, confirm: go }) => {
    const s = await current(go ? 0 : 60_000)
    const n = find(s, ref)
    if (n.kind !== 'project' || n.archived || !n.archivePlan) throw new Error(`${tilde(n.path)} is ${n.archived ? 'already archived' : 'not a project'}`)
    if (!go) return plan(`Archive ${n.name} → ${tilde(n.archivePlan.dest)}`, n.archivePlan.ops, n.archivePlan.checks)
    const j = await archiveProject(s, n.id)
    stale()
    return done(`Archived ${n.name} to ${tilde(n.archivePlan.dest)}`, j.id)
  }),
)

server.registerTool(
  'apply_suggestion',
  {
    description: 'Apply one of tidy_suggestions by id. Two-step: plan first, then confirm.',
    inputSchema: z.object({ id: z.string(), confirm }),
    annotations: risky,
  },
  tool(async ({ id, confirm: go }) => {
    const s = await current(go ? 0 : 60_000)
    const p = s.proposals.find(x => x.id === id)
    if (!p) throw new Error(`No suggestion "${id}" in the latest scan. Call tidy_suggestions again.`)
    if (!p.action) throw new Error(`"${p.title}" is for a person to decide; there's nothing to apply automatically.`)
    if (!go) return plan(p.title, p.ops)
    const j = await applyAction(s, p.title, p.action)
    stale()
    return done(`Applied: ${p.title}`, j.id)
  }),
)

server.registerTool(
  'recent_changes',
  {
    description: 'Changes laci made (from the app or agents), newest first, with ids for undo_change.',
    inputSchema: z.object({}),
    annotations: read,
  },
  tool(async () => (await journals(15)).map(j => ({ id: j.id, title: j.title, state: j.state, at: j.at, error: j.error }))),
)

server.registerTool(
  'undo_change',
  {
    description: 'Undo a change laci made: folders, agent history and edited files go back exactly as they were.',
    inputSchema: z.object({ id: z.string() }),
    annotations: risky,
  },
  tool(async ({ id }) => {
    const j = await undo(id)
    stale()
    return `Undone: ${j.title}`
  }),
)

await server.connect(new StdioServerTransport())
console.error('laci MCP server ready on stdio')
