import path from 'node:path'
import type { Plan } from '../types.ts'
import { HOME, iso, list, readText, stat } from '../util.ts'

export const CLAUDE_PLANS = path.join(HOME, '.claude', 'plans')

/** Plans carry no cwd, so they are linked to projects by the paths they mention. */
export async function scanPlans(): Promise<(Plan & { text: string })[]> {
  const out: (Plan & { text: string })[] = []
  for (const e of await list(CLAUDE_PLANS)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const file = path.join(CLAUDE_PLANS, e.name)
    const text = (await readText(file, 256 * 1024)) ?? ''
    const s = await stat(file)
    const title = text.match(/^#\s+(.+)/m)?.[1].replace(/[`*_]/g, '').trim() ?? e.name
    out.push({ file, title, at: iso(s!.mtimeMs), text })
  }
  return out
}
