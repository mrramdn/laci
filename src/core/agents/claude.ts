import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ClaudeDir, ClaudeSession } from '../types.ts'
import { HOME, du, enc, iso, list, pool, readEdges, stat } from '../util.ts'

export const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects')

/**
 * Turn an encoded dir name back into the folder that exists today.
 * The encoding is lossy (`/`, `.`, `_`, `-` all become `-`), so instead of decoding we walk the real
 * filesystem and keep every child whose encoded name is a prefix of what's left.
 */
export async function resolveEncoded(name: string): Promise<string | undefined> {
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
  return go('/', name)
}

const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/g

/** Count cwd values across a whole log. Needed to know exactly what a move would rewrite. */
async function countCwds(file: string, into: Record<string, number>) {
  const text = await fs.readFile(file, 'utf8')
  for (const m of text.matchAll(CWD)) into[m[1]] = (into[m[1]] ?? 0) + 1
}

async function readSession(file: string): Promise<ClaudeSession> {
  const { head, tail, size } = await readEdges(file)
  const s = await fs.stat(file)
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
  return { id: path.basename(file, '.jsonl'), title, at: iso(s.mtimeMs), cwd, branch: branch || undefined, bytes: size }
}

async function jsonlUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await list(dir)) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await jsonlUnder(p)))
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

export async function scanClaude(): Promise<ClaudeDir[]> {
  const dirs = (await list(CLAUDE_PROJECTS)).filter(e => e.isDirectory())
  return pool(dirs, 4, async e => {
    const dir = path.join(CLAUDE_PROJECTS, e.name)
    const entries = await list(dir)
    const top = entries.filter(x => x.isFile() && x.name.endsWith('.jsonl')).map(x => path.join(dir, x.name))
    const nested: string[] = []
    for (const x of entries) if (x.isDirectory() && x.name !== 'memory') nested.push(...(await jsonlUnder(path.join(dir, x.name))))
    const sessions = (await Promise.all(top.map(readSession))).sort((a, b) => b.at.localeCompare(a.at))
    const cwds: Record<string, number> = {}
    for (const f of [...top, ...nested]) await countCwds(f, cwds)
    const gone: string[] = []
    for (const cwd of Object.keys(cwds)) if (!(await stat(cwd))) gone.push(cwd)
    const memory = (await list(path.join(dir, 'memory'))).filter(x => x.isFile()).map(x => x.name)
    return {
      name: e.name,
      dir,
      path: await resolveEncoded(e.name),
      sessions,
      subagentLogs: nested.length,
      memory,
      bytes: await du(dir),
      cwds,
      gone,
    }
  })
}
