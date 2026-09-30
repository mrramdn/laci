import type { ClaudeDir, Issue, Node } from './types.ts'
import { daysSince, tilde, within } from './util.ts'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** Shortest paths among the ones given: the rest are inside them. */
export function roots(paths: string[]) {
  const out: string[] = []
  for (const p of [...new Set(paths)].sort((a, b) => a.length - b.length)) if (!out.some(r => within(p, r))) out.push(p)
  return out
}

/** Folders sessions started in that no longer exist. A session starts in the project root, so these are its former locations. */
export function goneStarts(c: ClaudeDir) {
  return roots(c.sessions.flatMap(s => (s.cwd && c.gone.includes(s.cwd) && !(c.path && within(s.cwd, c.path)) ? [s.cwd] : [])))
}

/** Former locations of this dir's folder, when it still resolves to a folder today (a move or rename happened). */
export function staleRoots(c: ClaudeDir) {
  return c.path ? goneStarts(c) : []
}

/**
 * cwd values recorded under a former location: leftovers of a move. A session that `cd`s into some other
 * folder, even one deleted since, keeps its real history and isn't counted.
 */
export function staleCwds(c: ClaudeDir) {
  const r = staleRoots(c)
  return Object.entries(c.cwds).filter(([cwd]) => r.some(x => within(cwd, x)))
}

export function issuesFor(n: Node, claude: Record<string, ClaudeDir>, now = Date.now()): Issue[] {
  const out: Issue[] = []
  const g = n.git

  if (n.kind === 'project') {
    if (g) {
      if (!g.commits) out.push({ code: 'no-commits', severity: 'high', title: 'No commits yet', detail: g.dirty ? `${plural(g.dirty, 'file')} never committed, no history to go back to` : undefined })
      else if (!g.remotes.length) out.push({ code: 'no-remote', severity: 'high', title: 'No remote', detail: `${plural(g.commits, 'commit')} ${g.commits === 1 ? 'exists' : 'exist'} only on this disk` })
      if (g.dirty && g.commits)
        out.push({ code: 'dirty', severity: n.archived ? 'high' : 'med', title: `${plural(g.dirty, 'uncommitted change')}`, detail: n.archived ? 'Archived with work that was never committed' : undefined })
      if (g.ahead) out.push({ code: 'unpushed', severity: 'med', title: `${plural(g.ahead, 'commit')} not pushed`, detail: g.upstream ? `ahead of ${g.upstream}` : undefined })
      if (g.stashes) out.push({ code: 'stash', severity: 'med', title: `${plural(g.stashes, 'forgotten stash')}`, detail: 'Stashes are easy to lose and never pushed' })
      if (g.behind) out.push({ code: 'behind', severity: 'low', title: `${plural(g.behind, 'commit')} behind remote` })
    } else if (n.type === 'code') {
      out.push({ code: 'no-git', severity: 'med', title: 'Not under version control' })
    }
    if (n.type === 'code' && !n.archived) {
      if (!n.readme) out.push({ code: 'no-readme', severity: 'low', title: 'No README', detail: 'Summary falls back to package.json or stays empty' })
      else if (n.readme.template) out.push({ code: 'template-readme', severity: 'low', title: 'README is still the scaffold template' })
    }
  }

  for (const name of n.agents.claude) {
    const stale = staleCwds(claude[name])
    if (!stale.length) continue
    const lines = stale.reduce((s, [, k]) => s + k, 0)
    out.push({ code: 'stale-cwd', severity: 'low', title: 'Agent logs point to an old path', detail: `${plural(lines, 'line')} still ${lines === 1 ? 'says' : 'say'} ${stale.map(([p]) => tilde(p)).slice(0, 2).join(', ')}` })
  }

  const deadline = n.meta.deadline ? Date.parse(n.meta.deadline) : NaN
  if (!Number.isNaN(deadline) && n.status.value !== 'done' && !n.archived) {
    const days = Math.ceil((deadline - now) / 86400000)
    if (days < 0) out.push({ code: 'overdue', severity: 'high', title: `Deadline passed ${-days}d ago` })
    else if (days <= 7) out.push({ code: 'due-soon', severity: 'high', title: `Due in ${days}d` })
  }
  if (n.meta.status === 'active' && daysSince(n.lastActivity?.at, now) > 30)
    out.push({ code: 'stalled', severity: 'med', title: `Marked active, untouched ${Math.floor(daysSince(n.lastActivity?.at, now))}d` })

  for (const f of n.taskFiles) {
    const age = daysSince(f.at, now)
    if (f.open && age > 14 && !n.archived)
      out.push({ code: 'old-handoff', severity: 'low', title: `${f.file}: ${plural(f.open, 'open item')}`, detail: `last edited ${Math.floor(age)} days ago` })
  }

  const rank = { high: 0, med: 1, low: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}
