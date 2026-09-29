import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Node, Snapshot } from './types.ts'
import { scanClaude } from './agents/claude.ts'
import { scanCodex } from './agents/codex.ts'
import { scanPlans } from './agents/plans.ts'
import { type Found, defaultRoots, detect } from './detect.ts'
import { gitInfo } from './git.ts'
import { issuesFor } from './health.ts'
import { parseReadme } from './readme.ts'
import { detectStack } from './stack.ts'
import { readTasks } from './tasks.ts'
import { buildProposals, planArchive } from './tidy.ts'
import { HEAVY, HOME, daysSince, du, iso, list, pool, readText, stat, tilde, within } from './util.ts'

const AI_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.claude', '.cursor', '.cursorrules', '.windsurf', '.serena', '.mcp.json', '.codex', '.aider.conf.yml', '.github/copilot-instructions.md']
const ARCHIVE_SEGMENT = /^_?archived?s?$/i
const GENERIC = /^(docs?|root|app|api|web|frontend|backend|server|client|site|rewrite|main|src)$/i

async function heavyDirs(dir: string, depth = 0): Promise<string[]> {
  const out: string[] = []
  for (const e of await list(dir)) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (HEAVY.has(e.name)) out.push(p)
    else if (!e.name.startsWith('.') && depth < 3) out.push(...(await heavyDirs(p, depth + 1)))
  }
  return out
}

function blank(f: Found, parent?: string): Node {
  const rel = path.relative(HOME, f.path)
  return {
    id: f.path,
    kind: f.kind,
    type: f.type,
    name: path.basename(f.path),
    label: path.basename(f.path),
    path: f.path,
    parent,
    children: [],
    archived: rel.split('/').some(s => ARCHIVE_SEGMENT.test(s)),
    stableId: 'p:' + createHash('sha1').update(f.path).digest('hex').slice(0, 12),
    meta: {},
    status: { value: 'active', auto: true },
    tasks: [],
    taskFiles: [],
    agents: { claude: [], codex: [], plans: [], aiFiles: [], serenaMemories: 0 },
    issues: [],
  }
}

async function enrich(n: Node) {
  const [readme, t] = await Promise.all([parseReadme(n.path), readTasks(n.path)])
  n.readme = readme
  n.meta = t.meta
  n.tasks = t.tasks
  n.taskFiles = t.files
  n.notes = t.notes
  if (t.summary) n.summary = { text: t.summary, source: '.laci.md' }
  else if (readme?.tagline && !readme.template) n.summary = { text: readme.tagline, source: readme.file }

  for (const f of AI_FILES) if (await stat(path.join(n.path, f))) n.agents.aiFiles.push(f)
  n.agents.serenaMemories = (await list(path.join(n.path, '.serena', 'memories'))).length

  const s = await stat(n.path)
  if (s?.birthtimeMs) n.createdAt = { at: iso(s.birthtimeMs), source: 'folder' }
  if (n.kind !== 'project') return

  if (await stat(path.join(n.path, '.git'))) {
    n.git = await gitInfo(n.path)
    if (n.git.rootCommit) n.stableId = 'git:' + n.git.rootCommit.slice(0, 12)
    if (n.git.firstCommitAt) n.createdAt = { at: n.git.firstCommitAt, source: 'first commit' }
  }

  const stack = await detectStack(n.path)
  const { description, newestMs, files: _files, ...rest } = stack
  n.stack = rest
  if (newestMs) n.lastActivity = { at: iso(newestMs), source: 'files' }
  if (n.git?.lastCommitAt && (!n.lastActivity || n.git.lastCommitAt > n.lastActivity.at)) n.lastActivity = { at: n.git.lastCommitAt, source: 'commit' }

  if (!n.summary && description) n.summary = { text: description, source: 'package.json' }

  const parts = await pool(await heavyDirs(n.path), 4, async p => ({ path: path.relative(n.path, p), bytes: await du(p) }))
  const big = parts.filter(p => p.bytes > 1e6).sort((a, b) => b.bytes - a.bytes)
  n.size = { total: await du(n.path), reclaimable: big.reduce((a, p) => a + p.bytes, 0), parts: big.slice(0, 4) }
}

export function autoStatus(n: Node) {
  if (n.meta.status) return { value: n.meta.status, auto: false }
  if (n.archived) return { value: 'archived', auto: true }
  const d = daysSince(n.lastActivity?.at)
  return { value: d <= 14 ? 'active' : d <= 60 ? 'idle' : 'dormant', auto: true }
}

export async function scan(opts: { roots?: string[] } = {}): Promise<Snapshot> {
  const t0 = Date.now()
  const roots = opts.roots ?? (await defaultRoots())
  const [claudeDirs, codexList, plans] = await Promise.all([scanClaude(), scanCodex(), scanPlans()])

  const codexAlive = await Promise.all(codexList.map(async s => !!s.cwd && !!(await stat(s.cwd))))
  const agentPaths = new Set<string>([
    ...claudeDirs.flatMap(c => (c.path ? [c.path] : [])),
    ...codexList.flatMap((s, i) => (codexAlive[i] ? [s.cwd!] : [])),
  ])

  const found = await detect(roots, agentPaths)
  const nodes: Record<string, Node> = {}
  const add = (f: Found, parent?: string): string => {
    const n = blank(f, parent)
    nodes[n.id] = n
    n.children = f.children.map(c => add(c, n.id))
    return n.id
  }
  const rootIds = found.map(f => add(f))
  await pool(Object.values(nodes), 6, enrich)

  const counts = new Map<string, number>()
  for (const n of Object.values(nodes)) counts.set(n.name, (counts.get(n.name) ?? 0) + 1)
  for (const n of Object.values(nodes))
    if (n.parent && ((counts.get(n.name) ?? 0) > 1 || GENERIC.test(n.name))) n.label = `${nodes[n.parent].name}/${n.name}`

  const byDepth = Object.values(nodes).sort((a, b) => b.path.length - a.path.length)
  const nearest = (p: string) => byDepth.find(n => within(p, n.path))

  const claude = Object.fromEntries(claudeDirs.map(c => [c.name, c]))
  const codex = Object.fromEntries(codexList.map(s => [path.basename(s.file), s]))
  const snap: Snapshot = {
    scannedAt: new Date().toISOString(),
    home: HOME,
    host: os.hostname(),
    roots,
    rootIds,
    nodes,
    claude,
    codex,
    plans: {},
    global: { claude: [], codex: [] },
    orphans: { claude: [], codex: [] },
    stores: [],
    proposals: [],
    warnings: [],
    tookMs: 0,
  }

  for (const c of claudeDirs) {
    if (!c.path) snap.orphans.claude.push(c.name)
    else {
      const n = nearest(c.path)
      if (n) n.agents.claude.push(c.name)
      else snap.global.claude.push(c.name)
    }
  }
  codexList.forEach((s, i) => {
    const id = path.basename(s.file)
    if (!codexAlive[i]) snap.orphans.codex.push(id)
    else {
      const n = nearest(s.cwd!)
      if (n) n.agents.codex.push(id)
      else snap.global.codex.push(id)
    }
  })
  for (const p of plans) {
    const { text, ...plan } = p
    const id = path.basename(p.file)
    snap.plans[id] = plan
    for (const n of byDepth) {
      const hit = [n.path, tilde(n.path)].some(q => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w./-])').test(text))
      if (hit) n.agents.plans.push(id)
    }
  }

  // Activity: projects know their own; agent sessions count too; folders take the newest child.
  for (const n of byDepth) {
    const agentAt = [
      ...n.agents.claude.map(c => claude[c].sessions[0]?.at),
      ...n.agents.codex.map(c => codex[c].at),
      ...n.children.map(c => nodes[c].lastActivity?.at),
    ].filter(Boolean) as string[]
    for (const at of agentAt) if (!n.lastActivity || at > n.lastActivity.at) n.lastActivity = { at, source: n.children.length ? 'inside' : 'agent' }
    n.status = autoStatus(n)
    n.issues = issuesFor(n, claude)
  }
  for (const n of Object.values(nodes)) if (n.kind === 'project' && !n.archived) n.archivePlan = await planArchive(n, snap)

  snap.proposals = buildProposals(snap)
  const store = async (name: string, rel: string, note: string) => {
    const p = path.join(HOME, rel)
    const present = !!(await stat(p))
    snap.stores.push({ name, path: tilde(p), present, bytes: present ? await du(p) : 0, note })
  }
  const sessions = claudeDirs.reduce((a, c) => a + c.sessions.length, 0)
  await store('Claude Code', '.claude/projects', `${claudeDirs.length} project dirs · ${sessions} sessions`)
  await store('Codex', '.codex/sessions', `${codexList.length} sessions, linked by cwd inside each log`)
  await store('Gemini CLI', '.gemini/tmp', 'keyed by a hash of the project path')
  await store('Serena', '.serena/memories', `+ ${Object.values(nodes).filter(n => n.agents.serenaMemories).length} projects with .serena/ in the folder`)
  await store('Claude plans', '.claude/plans', `${plans.length} plans, linked by paths they mention`)

  // Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). Memory files survive; history doesn't.
  const settings = await readText(path.join(HOME, '.claude', 'settings.json'), 256 * 1024)
  const keep = Number(settings?.match(/"cleanupPeriodDays"\s*:\s*(\d+)/)?.[1] ?? 30)
  const oldest = claudeDirs.flatMap(c => c.sessions.map(s => s.at)).sort()[0]
  if (keep < 3650)
    snap.warnings.push({
      code: 'claude-cleanup',
      severity: 'high',
      title: `Claude Code deletes session logs after ${keep} days`,
      detail: `Your oldest surviving session is from ${oldest?.slice(0, 10) ?? '—'}. Memory files are kept, conversation history is not.`,
    })

  snap.tookMs = Date.now() - t0
  return snap
}
