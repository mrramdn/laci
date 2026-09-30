import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ClaudeDir, ClaudeSession } from '../types.ts'
import { HOME, enc, iso, list, pool, readEdges, stat } from '../util.ts'
import { cached, sweep } from './cache.ts'

export const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects')

const resolved = new Map<string, string>()

/**
 * Turn an encoded dir name back into the folder that exists today.
 * The encoding is lossy (`/`, `.`, `_`, `-` all become `-`), so instead of decoding we walk the real
 * filesystem and keep every child whose encoded name is a prefix of what's left.
 */
export async function resolveEncoded(name: string): Promise<string | undefined> {
  // Remembered while the folder is still there; scans run often now, and this walks the disk.
  const known = resolved.get(name)
  if (known && (await stat(known))) return known
  async function go(dir: string, rest: string): Promise<string | undefined> {
    if (!rest) return dir
    for (const e of await list(dir)) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      const piece = '-' + enc(e.name)
      if (rest === piece || rest.startsWith(piece + '-')) {
        const hit = await go(path.join(dir, e.name), rest.slice(piece.length))
        if (hit) return hit
      }
    }
  }
  const hit = await go('/', name)
  if (hit) resolved.set(name, hit)
  else resolved.delete(name)
  return hit
}

const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/g

/** What one log says, cached per file (see cache.ts). */
interface LogFacts {
  session?: ClaudeSession
  /** cwd value -> lines carrying it, counted up to `offset` (the end of the last full line). */
  cwds: Record<string, number>
  offset: number
}

/**
 * Count cwd values from `start` to the last full line. Needed to know exactly what a move would
 * rewrite. Logs only grow, so a log seen before is read from where the last count stopped.
 */
async function countCwds(file: string, start: number, into: Record<string, number>) {
  const fh = await fs.open(file, 'r')
  try {
    const { size } = await fh.stat()
    if (size <= start) return start
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    const end = buf.lastIndexOf(10)
    if (end < 0) return start
    for (const m of buf.subarray(0, end + 1).toString('utf8').matchAll(CWD)) into[m[1]] = (into[m[1]] ?? 0) + 1
    return start + end + 1
  } finally {
    await fh.close()
  }
}

async function readSession(file: string, s: { size: number; mtimeMs: number }): Promise<ClaudeSession> {
  const { head, tail } = await readEdges(file)
  let title: string | undefined
  for (const src of [tail, head]) {
    const all = [...src.matchAll(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)]
    if (all.length) {
      title = JSON.parse(`"${all.at(-1)![1]}"`)
      break
    }
  }
  const cwd = head.match(CWD.source)?.[1]
  const branch = head.match(/"gitBranch":"([^"]*)"/)?.[1]
  return { id: path.basename(file, '.jsonl'), title, at: iso(s.mtimeMs), cwd, branch: branch || undefined, bytes: s.size }
}

/** Every file under `dir` with its size, so one walk gives both the logs and the folder's total. */
async function filesUnder(dir: string, out: { path: string; size: number; memory: boolean }[] = [], memory = false) {
  for (const e of await list(dir)) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await filesUnder(p, out, memory || e.name === 'memory')
    else if (e.isFile()) out.push({ path: p, size: (await stat(p))?.size ?? 0, memory })
  }
  return out
}

export async function scanClaude(): Promise<ClaudeDir[]> {
  const dirs = (await list(CLAUDE_PROJECTS)).filter(e => e.isDirectory())
  const seen = new Set<string>()
  const out = await pool(dirs, 4, async e => {
    const dir = path.join(CLAUDE_PROJECTS, e.name)
    const files = await filesUnder(dir)
    const logs = files.filter(f => !f.memory && f.path.endsWith('.jsonl'))
    const sessions: ClaudeSession[] = []
    const cwds: Record<string, number> = {}
    for (const f of logs) {
      const s = await stat(f.path)
      if (!s) continue
      seen.add(f.path)
      const top = path.dirname(f.path) === dir
      const facts = await cached<LogFacts>('claude', f.path, s, async prev => {
        const counts = { ...prev?.data.cwds }
        const offset = await countCwds(f.path, prev?.data.offset ?? 0, counts)
        return { session: top ? await readSession(f.path, s) : undefined, cwds: counts, offset }
      })
      if (facts.session) sessions.push(facts.session)
      for (const [k, v] of Object.entries(facts.cwds)) cwds[k] = (cwds[k] ?? 0) + v
    }
    const gone: string[] = []
    for (const cwd of Object.keys(cwds)) if (!(await stat(cwd))) gone.push(cwd)
    return {
      name: e.name,
      dir,
      path: await resolveEncoded(e.name),
      sessions: sessions.sort((a, b) => b.at.localeCompare(a.at)),
      subagentLogs: logs.length - sessions.length,
      memory: (await list(path.join(dir, 'memory'))).filter(x => x.isFile()).map(x => x.name),
      bytes: files.reduce((a, f) => a + f.size, 0),
      cwds,
      gone,
    }
  })
  await sweep('claude', seen)
  return out
}
