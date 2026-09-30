import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Connector } from './agents/connectors.ts'
import type { Item, Link, Node, Snapshot } from './types.ts'
import { saveCache } from './agents/cache.ts'
import { scanClaude } from './agents/claude.ts'
import { CATALOG, MOVES, connectors, readInside, readStores, storeName, where } from './agents/connectors.ts'
import { loadConfig } from './config.ts'
import { type Found, defaultRoots, detect } from './detect.ts'
import { gitInfo } from './git.ts'
import { issuesFor } from './health.ts'
import { parseReadme } from './readme.ts'
import { detectStack } from './stack.ts'
import { readTasks } from './tasks.ts'
import { buildProposals, bytes as bytesText, planArchive } from './tidy.ts'
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
    sidecar: false,
    agents: { claude: [], items: [], aiFiles: [] },
    issues: [],
  }
}

/** What a folder says about itself in files people edit: README, .laci.md, task lists. Cheap to re-read. */
async function readFolder(n: Node) {
  const [readme, t] = await Promise.all([parseReadme(n.path), readTasks(n.path)])
  n.readme = readme
  n.meta = t.meta
  n.tasks = t.tasks
  n.taskFiles = t.files
  n.notes = t.notes
  n.sidecar = t.sidecar
  if (t.summary) n.summary = { text: t.summary, source: '.laci.md' }
  else if (readme?.tagline && !readme.template) n.summary = { text: readme.tagline, source: readme.file }
  else if (n.summary?.source !== 'package.json') n.summary = undefined
}

async function readGit(n: Node) {
  if (!(await stat(path.join(n.path, '.git')))) return (n.git = undefined)
  n.git = await gitInfo(n.path)
  if (n.git.rootCommit) n.stableId = 'git:' + n.git.rootCommit.slice(0, 12)
  if (n.git.firstCommitAt) n.createdAt = { at: n.git.firstCommitAt, source: 'first commit' }
}

async function enrich(n: Node, inside: Connector[], items: Record<string, Item>) {
  await readFolder(n)
  for (const f of AI_FILES) if (await stat(path.join(n.path, f))) n.agents.aiFiles.push(f)
  for (const c of inside) {
    const it = await readInside(c, c.link as Extract<Link, { kind: 'inside' }>, n.path)
    if (!it) continue
    items[it.id] = it
    n.agents.items.push(it.id)
  }

  const s = await stat(n.path)
  if (s?.birthtimeMs) n.createdAt = { at: iso(s.birthtimeMs), source: 'folder' }
  if (n.kind !== 'project') return

  await readGit(n)
  const stack = await detectStack(n.path)
  const { description, newestMs, files: _files, ...rest } = stack
  n.stack = rest
  if (newestMs) n.ownActivity = { at: iso(newestMs), source: 'files' }
  if (n.git?.lastCommitAt && (!n.ownActivity || n.git.lastCommitAt > n.ownActivity.at)) n.ownActivity = { at: n.git.lastCommitAt, source: 'commit' }

  if (!n.summary && description) n.summary = { text: description, source: 'package.json' }

  const parts = await pool(await heavyDirs(n.path), 4, async p => ({ path: path.relative(n.path, p), bytes: await du(p) }))
  const big = parts.filter(p => p.bytes > 1e6).sort((a, b) => b.bytes - a.bytes)
  n.size = { total: await du(n.path), reclaimable: big.reduce((a, p) => a + p.bytes, 0), parts: big.slice(0, 4) }
}

/** Agent sessions in a folder: Claude sessions plus every log or store folder another connector links to it. */
export function sessionCount(s: Pick<Snapshot, 'claude' | 'items' | 'connectors'>, n: Node) {
  const counted = new Set(s.connectors.filter(c => c.link.kind === 'cwd' || c.link.kind === 'named').map(c => c.id))
  return n.agents.claude.reduce((a, k) => a + s.claude[k].sessions.length, 0) + n.agents.items.filter(i => counted.has(s.items[i].connector)).length
}

export function autoStatus(n: Node) {
  if (n.meta.status) return { value: n.meta.status, auto: false }
  if (n.archived) return { value: 'archived', auto: true }
  const d = daysSince(n.lastActivity?.at)
  return { value: d <= 14 ? 'active' : d <= 60 ? 'idle' : 'dormant', auto: true }
}

/** Everything the added connectors know, read (mostly from the cache) in one go. */
async function readAgents(on: Connector[]) {
  const claudeOn = on.some(c => c.id === 'claude')
  const [claudeDirs, stores] = await Promise.all([claudeOn ? scanClaude() : Promise.resolve([]), readStores(on.filter(c => c.id !== 'claude'))])
  const exists = new Map<string, Promise<boolean>>()
  const alive = (p: string) => {
    if (!exists.has(p)) exists.set(p, stat(p).then(Boolean))
    return exists.get(p)!
  }
  const linked = stores.items.filter(it => it.cwd)
  const aliveCwd = await Promise.all(linked.map(it => alive(it.cwd!)))
  // Folders an agent worked in count as projects even without code or git (a notes folder, say).
  const agentPaths = new Set<string>([...claudeDirs.flatMap(c => (c.path ? [c.path] : [])), ...linked.filter((_, i) => aliveCwd[i]).map(it => it.cwd!)])
  return { on, claudeOn, claudeDirs, stores, agentPaths, alive }
}
type Agents = Awaited<ReturnType<typeof readAgents>>

export async function scan(opts: { roots?: string[] } = {}): Promise<Snapshot> {
  const t0 = Date.now()
  const cfg = await loadConfig()
  const roots = opts.roots ?? cfg.roots ?? (await defaultRoots())
  const on = await connectors(cfg)
  const agents = await readAgents(on)

  const found = await detect(roots, agents.agentPaths)
  const nodes: Record<string, Node> = {}
  const add = (f: Found, parent?: string): string => {
    const n = blank(f, parent)
    nodes[n.id] = n
    n.children = f.children.map(c => add(c, n.id))
    return n.id
  }
  const rootIds = found.map(f => add(f))
  const items: Record<string, Item> = {}
  const inside = on.filter(c => c.link.kind === 'inside')
  await pool(Object.values(nodes), 6, n => enrich(n, inside, items))

  const counts = new Map<string, number>()
  for (const n of Object.values(nodes)) counts.set(n.name, (counts.get(n.name) ?? 0) + 1)
  for (const n of Object.values(nodes))
    if (n.parent && ((counts.get(n.name) ?? 0) > 1 || GENERIC.test(n.name))) n.label = `${nodes[n.parent].name}/${n.name}`

  const snap: Snapshot = {
    scannedAt: new Date().toISOString(),
    home: HOME,
    host: os.hostname(),
    roots,
    configured: !!(opts.roots || cfg.roots),
    rootIds,
    nodes,
    claude: {},
    items,
    connectors: [],
    suggestions: [],
    global: { claude: [], items: [] },
    orphans: { claude: [], items: [] },
    unmatched: [],
    proposals: [],
    warnings: [],
    tookMs: 0,
  }
  await link(snap, agents)
  await saveCache()
  snap.tookMs = Date.now() - t0
  return snap
}

/** Agent logs changed (a session went on, a new one started): attach them again, without a full scan. */
export async function relinkAgents(snap: Snapshot) {
  const agents = await readAgents(await connectors(await loadConfig()))
  await link(snap, agents)
  await saveCache()
}

/**
 * A project's files or git changed: re-read what it says about itself and its git state, then
 * everything that depends on them. `touchedMs` is the newest change the watcher saw in it.
 */
export async function refreshProject(snap: Snapshot, n: Node, touchedMs = 0) {
  await readFolder(n)
  if (n.kind === 'project') {
    await readGit(n)
    const at = [n.ownActivity?.at, n.git?.lastCommitAt, touchedMs ? iso(touchedMs) : undefined].filter(Boolean).sort().at(-1)
    if (at && at !== n.ownActivity?.at) n.ownActivity = { at, source: at === n.git?.lastCommitAt ? 'commit' : 'files' }
  }
  settle(snap)
  await plan(snap)
}

/**
 * Attach agent history to folders, then work out everything that depends on it: activity, status,
 * issues, connector cards, archive plans and Tidy suggestions. Run after a full scan, and on its own
 * when only agent logs changed.
 */
async function link(snap: Snapshot, a: Agents) {
  const { on, claudeOn, claudeDirs, stores, agentPaths, alive } = a
  const nodes = snap.nodes
  const kind = Object.fromEntries(on.map(c => [c.id, c.link.kind]))
  // Start over, except for history kept inside the folders, which only a full scan reads.
  const insideItems = Object.values(snap.items).filter(it => kind[it.connector] === 'inside')
  for (const n of Object.values(nodes)) {
    n.agents.claude = []
    n.agents.items = n.agents.items.filter(i => kind[snap.items[i]?.connector] === 'inside')
  }
  const items: Record<string, Item> = Object.fromEntries([...insideItems, ...stores.items].map(it => [it.id, it]))
  const claude = Object.fromEntries(claudeDirs.map(c => [c.name, c]))
  Object.assign(snap, { items, claude, global: { claude: [], items: [] }, orphans: { claude: [], items: [] }, unmatched: [], warnings: [] })

  const byDepth = Object.values(nodes).sort((a, b) => b.path.length - a.path.length)
  const nearest = (p: string) => byDepth.find(n => within(p, n.path))

  // A hashed store name can only be matched against folders we know of.
  const hashed = on.filter(c => c.link.kind === 'named' && c.link.naming === 'sha256')
  if (hashed.length) {
    const known = new Set([HOME, ...snap.roots, ...Object.keys(nodes), ...agentPaths])
    for (const c of hashed) {
      const byName = new Map([...known].map(p => [storeName(c.link as Extract<Link, { kind: 'named' }>, p), p]))
      for (const it of stores.items) if (it.connector === c.id) it.cwd = byName.get(path.basename(it.file))
    }
  }

  for (const c of claudeDirs) {
    if (!c.path) snap.orphans.claude.push(c.name)
    else {
      const n = nearest(c.path)
      if (n) n.agents.claude.push(c.name)
      else snap.global.claude.push(c.name)
    }
  }
  for (const it of stores.items) {
    const k = kind[it.connector]
    if (k === 'mentions') {
      const text = stores.mentions.get(it.id) ?? ''
      for (const n of byDepth) {
        const hit = [n.path, tilde(n.path)].some(q => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w./-])').test(text))
        if (hit) n.agents.items.push(it.id)
      }
    } else if (!it.cwd) {
      // Hashed names with no known folder, or a log with no folder in it: nothing to say about where it belongs.
      if (k === 'named' && hashed.some(c => c.id === it.connector)) snap.unmatched.push(it.id)
      else if (k === 'named') snap.orphans.items.push(it.id)
    } else if (!(await alive(it.cwd))) snap.orphans.items.push(it.id)
    else {
      const n = nearest(it.cwd)
      if (n) n.agents.items.push(it.id)
      else snap.global.items.push(it.id)
    }
  }

  // Catalog connectors not added yet, with a hint when this PC has data for them.
  const projectPaths = Object.values(nodes).filter(n => n.kind === 'project').map(n => n.path)
  snap.suggestions = await Promise.all(
    CATALOG.filter(c => !on.some(o => o.id === c.id)).map(async c => {
      const l = c.link
      let found = false
      let detail: string | undefined
      if (l.kind === 'inside') {
        const hits = (await Promise.all(projectPaths.map(p => stat(path.join(p, l.path))))).filter(Boolean).length
        found = hits > 0
        if (found) detail = `in ${hits} project${hits === 1 ? '' : 's'}`
      } else if ((await list(l.dir)).length) {
        found = true
        detail = bytesText(await du(l.dir))
      }
      return { id: c.id, name: c.name, about: c.about, where: where(l), found, detail }
    }),
  )

  // Plans and proposals below read the connector list, so it's filled first.
  const sessions = claudeDirs.reduce((a, c) => a + c.sessions.length, 0)
  snap.connectors = await Promise.all(
    on.map(async c => {
      const l = c.link
      const mine = Object.values(items).filter(it => it.connector === c.id)
      const isClaude = c.id === 'claude'
      const dir = 'dir' in l ? l.dir : undefined
      const present = dir ? !!(await stat(dir)) : mine.length > 0
      const bytes = isClaude ? claudeDirs.reduce((a, d) => a + d.bytes, 0) : dir ? (present ? await du(dir) : 0) : mine.reduce((a, it) => a + it.bytes, 0)
      return {
        id: c.id,
        name: c.name,
        link: l,
        builtin: c.builtin,
        about: isClaude ? `${claudeDirs.length} project folders · ${sessions} sessions` : c.about,
        moves: isClaude ? 'Its folder is renamed and paths in the logs are rewritten' : MOVES[l.kind],
        where: where(l),
        present,
        bytes,
        count: isClaude ? sessions : mine.length,
      }
    }),
  )

  settle(snap)
  await plan(snap)
  // Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). Memory files survive; history doesn't.
  const settings = await readText(path.join(HOME, '.claude', 'settings.json'), 256 * 1024)
  const keep = Number(settings?.match(/"cleanupPeriodDays"\s*:\s*(\d+)/)?.[1] ?? 30)
  const oldest = claudeDirs.flatMap(c => c.sessions.map(s => s.at)).sort()[0]
  if (claudeOn && keep < 3650)
    snap.warnings.push({
      code: 'claude-cleanup',
      severity: 'high',
      title: `Claude Code deletes session logs after ${keep} days`,
      detail: `Your oldest surviving session is from ${oldest?.slice(0, 10) ?? '—'}. Memory files are kept, conversation history is not.`,
    })
}

/** Activity (the folder's own, its agent sessions, its children), status and issues. Deepest folders first. */
function settle(snap: Snapshot) {
  const kind = Object.fromEntries(snap.connectors.map(c => [c.id, c.link.kind]))
  for (const n of Object.values(snap.nodes).sort((a, b) => b.path.length - a.path.length)) {
    n.lastActivity = n.ownActivity
    const agentAt = [
      ...n.agents.claude.map(c => snap.claude[c]?.sessions[0]?.at),
      ...n.agents.items.filter(i => kind[snap.items[i]?.connector] !== 'mentions').map(i => snap.items[i]?.at),
      ...n.children.map(c => snap.nodes[c].lastActivity?.at),
    ].filter(Boolean) as string[]
    for (const at of agentAt) if (!n.lastActivity || at > n.lastActivity.at) n.lastActivity = { at, source: n.children.length ? 'inside' : 'agent' }
    n.status = autoStatus(n)
    n.issues = issuesFor(n, snap.claude)
  }
}

/** Archive plans and Tidy suggestions, from the state as it is now. */
async function plan(snap: Snapshot) {
  for (const n of Object.values(snap.nodes)) n.archivePlan = n.kind === 'project' && !n.archived ? await planArchive(n, snap) : undefined
  snap.proposals = buildProposals(snap)
}
