import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CodexSession } from '../types.ts'
import { HOME, iso, list, readEdges } from '../util.ts'

export const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions')

async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await list(dir)) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await files(p)))
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/** Codex keeps one flat archive by date; the project link is the `cwd` inside each log. */
export async function scanCodex(): Promise<CodexSession[]> {
  const out: CodexSession[] = []
  for (const file of await files(CODEX_SESSIONS)) {
    const { head } = await readEdges(file, 64 * 1024, 0)
    let meta: any
    try {
      meta = JSON.parse(head.split('\n')[0])
    } catch {
      continue
    }
    const cwd: string | undefined = meta?.payload?.cwd
    const text = await fs.readFile(file, 'utf8')
    const cwdLines = cwd ? text.split(`"cwd":${JSON.stringify(cwd)}`).length - 1 : 0
    const s = await fs.stat(file)
    out.push({ file, at: meta?.payload?.timestamp ?? iso(s.mtimeMs), cwd, subagent: !!meta?.payload?.source?.subagent, cwdLines })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}
