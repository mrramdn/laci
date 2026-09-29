import path from 'node:path'
import type { ArchivePlan, ClaudeDir, CodexSession, Node, Op, Proposal, Snapshot } from './types.ts'
import { CLAUDE_PROJECTS } from './agents/claude.ts'
import { goneStarts, staleCwds, staleRoots } from './health.ts'
import { HOME, daysSince, enc, stat, tilde, within } from './util.ts'

export const QUARANTINE = path.join(HOME, '.local', 'share', 'laci', 'orphans')

export const bytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** Archive into the nearest existing `_archive` up the tree, keeping the path below it (matches the layout already on disk). */
export async function archiveDest(n: Node, roots: string[]) {
  const root = roots.find(r => within(n.path, r)) ?? path.dirname(n.path)
  let dir = path.dirname(n.path)
  while (within(dir, root)) {
    if ((await stat(path.join(dir, '_archive')))?.isDirectory()) return path.join(dir, '_archive', path.relative(dir, n.path))
    if (dir === root) break
    dir = path.dirname(dir)
  }
  return path.join(root, '_archive', path.relative(root, n.path))
}

/** Every operation a move of `from` to `to` implies, so the user sees agent data move with the folder. */
export function moveOps(from: string, to: string, snap: Pick<Snapshot, 'claude' | 'codex'>): Op[] {
  const ops: Op[] = [{ kind: 'move', label: 'Move folder', from: tilde(from), to: tilde(to) }]

  const dirs = Object.values(snap.claude).filter(c => c.path && within(c.path, from))
  for (const c of dirs) {
    const target = to + c.path!.slice(from.length)
    ops.push({
      kind: 'rename',
      label: 'Move Claude sessions + memory',
      from: `~/.claude/projects/${c.name}`,
      to: `~/.claude/projects/${enc(target)}`,
      detail: `${c.sessions.length} sessions · ${c.memory.length} memory files · ${bytes(c.bytes)}`,
    })
    const stale = staleCwds(c)
    const lines = sum(Object.entries(c.cwds).filter(([cwd]) => within(cwd, from)).map(([, k]) => k)) + sum(stale.map(([, k]) => k))
    if (lines) ops.push({ kind: 'rewrite', label: 'Rewrite cwd in Claude logs', detail: `${lines} lines → ${tilde(target)}${stale.length ? ' (also fixes paths left by earlier moves)' : ''}` })
  }

  const codex = Object.values(snap.codex).filter(s => s.cwd && within(s.cwd, from))
  if (codex.length) ops.push({ kind: 'rewrite', label: 'Rewrite cwd in Codex logs', detail: `${sum(codex.map(s => s.cwdLines))} lines in ${codex.length} files` })
  return ops
}

export async function planArchive(n: Node, snap: Pick<Snapshot, 'claude' | 'codex' | 'roots'>): Promise<ArchivePlan> {
  const dest = await archiveDest(n, snap.roots)
  const checks = n.issues.filter(i => ['no-commits', 'no-remote', 'dirty', 'unpushed', 'stash'].includes(i.code))
  const ops = moveOps(n.path, dest, snap)
  const inFolder = [...n.agents.aiFiles, '.laci.md']
  ops.push({ kind: 'keep', label: 'Travels with the folder', detail: inFolder.join(', ') })
  ops.push({ kind: 'write', label: 'Set status: archived', to: `${tilde(dest)}/.laci.md` })
  if (n.size && n.size.reclaimable > 50e6)
    ops.push({ kind: 'delete', label: 'Optional: delete deps & build output', detail: `${bytes(n.size.reclaimable)} (${n.size.parts.map(p => p.path).join(', ')})` })
  ops.push({ kind: 'write', label: 'Write undo journal', to: '~/.local/share/laci/journal/' })
  return { dest, checks, ops }
}

function reconnectCandidates(c: ClaudeDir, nodes: Node[]) {
  return nodes
    .filter(n => c.name.endsWith('-' + enc(n.name)))
    .map(n => ({ n, exact: enc(n.path.replace(/\/_archive(?=\/)/g, '')) === c.name }))
    .sort((a, b) => Number(b.exact) - Number(a.exact))
}

/**
 * Where a missing path lives now. A session dir that resolves to a real folder but whose logs still record
 * the missing path means the folder was renamed or moved from there (e.g. claude-control-plane → kiicode).
 */
function formerly(p: string, snap: Snapshot, nodes: Node[]) {
  for (const c of Object.values(snap.claude)) {
    if (!c.path) continue
    const old = staleCwds(c).map(([g]) => g).sort((a, b) => a.length - b.length)[0]
    if (!old || !within(p, old)) continue
    const n = nodes.filter(x => within(c.path!, x.path)).sort((a, b) => b.path.length - a.path.length)[0]
    if (n) return { n, old }
  }
}

export function buildProposals(snap: Snapshot): Proposal[] {
  const nodes = Object.values(snap.nodes)
  const out: Proposal[] = []

  for (const name of snap.orphans.claude) {
    const c = snap.claude[name]
    const cands = reconnectCandidates(c, nodes)
    const what = `${c.sessions.length} session${c.sessions.length === 1 ? '' : 's'}${c.memory.length ? ` + ${c.memory.length} memory file${c.memory.length === 1 ? '' : 's'}` : ''}`
    if (cands.length) {
      const { n, exact } = cands[0]
      const lines = sum(Object.values(c.cwds))
      out.push({
        id: `reconnect:${name}`,
        category: 'reconnect',
        title: `Reconnect ${what} to ${n.label}`,
        why: exact
          ? `The folder was moved into _archive, but its agent history stayed at the old address. Claude can't find these when you open ${tilde(n.path)}.`
          : `No folder matches this address anymore. ${tilde(n.path)} has the same name. Check before applying.`,
        confidence: exact ? 'high' : cands.length === 1 ? 'med' : 'low',
        nodeId: n.id,
        ops: [
          { kind: 'rename', label: 'Move Claude sessions + memory', from: `~/.claude/projects/${name}`, to: `~/.claude/projects/${enc(n.path)}`, detail: what },
          ...(lines ? [{ kind: 'rewrite' as const, label: 'Rewrite cwd in Claude logs', detail: `${lines} lines → ${tilde(n.path)}` }] : []),
        ],
        action: { type: 'reconnect-claude', dir: c.dir, target: path.join(CLAUDE_PROJECTS, enc(n.path)), pairs: goneStarts(c).map(r => [r, n.path]) },
      })
    } else {
      out.push({
        id: `orphan:${name}`,
        category: 'orphan',
        title: `${what} for a folder that's gone`,
        why: `Nothing on disk matches ${name}. Last used ${c.sessions[0]?.at.slice(0, 10) ?? 'unknown'}${c.sessions[0]?.title ? ` ("${c.sessions[0].title}")` : ''}.`,
        confidence: 'med',
        ops: [{ kind: 'move', label: 'Quarantine (restorable)', from: `~/.claude/projects/${name}`, to: `${tilde(QUARANTINE)}/claude/${name}` }],
        action: { type: 'quarantine', paths: [c.dir] },
      })
    }
  }

  const half = Object.values(snap.claude).filter(c => c.path && staleCwds(c).length)
  if (half.length)
    out.push({
      id: 'migration:stale-cwd',
      category: 'migration',
      title: `Finish ${half.length} half-done moves`,
      why: 'These session folders were renamed after a move, but the logs inside still record the old path. Resume works; search, stats and the next move would get it wrong.',
      confidence: 'high',
      ops: half.map(c => {
        const stale = staleCwds(c)
        return { kind: 'rewrite', label: tilde(c.path!), from: stale.map(([p]) => tilde(p)).join(', '), to: tilde(c.path!), detail: `${sum(stale.map(([, k]) => k))} lines` }
      }),
      action: { type: 'rewrite-claude', items: half.map(c => ({ dir: c.dir, pairs: staleRoots(c).map(r => [r, c.path!] as [string, string]) })) },
    })

  const byCwd = new Map<string, CodexSession[]>()
  for (const id of snap.orphans.codex) {
    const s = snap.codex[id]
    byCwd.set(s.cwd!, [...(byCwd.get(s.cwd!) ?? []), s])
  }
  for (const [cwd, list] of byCwd) {
    const was = formerly(cwd, snap, nodes)
    const s = list.length === 1 ? '' : 's'
    if (was) {
      const target = was.n.path + cwd.slice(was.old.length)
      out.push({
        id: `codex-orphan:${cwd}`,
        category: 'reconnect',
        title: `Reconnect ${list.length} Codex session${s} to ${was.n.label}`,
        why: `${was.n.label} used to live at ${tilde(was.old)}: its Claude logs still say so. These Codex sessions stayed at the old address.`,
        confidence: 'high',
        nodeId: was.n.id,
        ops: [{ kind: 'rewrite', label: 'Rewrite cwd in Codex logs', from: tilde(cwd), to: tilde(target), detail: `${sum(list.map(x => x.cwdLines))} lines in ${list.length} file${s}` }],
        action: { type: 'rewrite-codex', files: list.map(x => x.file), pairs: [[was.old, was.n.path]] },
      })
    } else
      out.push({
        id: `codex-orphan:${cwd}`,
        category: 'orphan',
        title: `${list.length} Codex session${s} for deleted ${path.basename(cwd)}`,
        why: `${tilde(cwd)} no longer exists. Last used ${list[0].at.slice(0, 10)}.`,
        confidence: 'med',
        ops: list.map(x => ({ kind: 'move' as const, label: 'Quarantine (restorable)', from: tilde(x.file), to: `${tilde(QUARANTINE)}/codex/` })),
        action: { type: 'quarantine', paths: list.map(x => x.file) },
      })
  }

  for (const n of nodes) {
    if (n.kind !== 'project' || n.archived || n.status.value !== 'dormant' || !n.archivePlan) continue
    out.push({
      id: `archive:${n.id}`,
      category: 'status',
      title: `Archive ${n.label}?`,
      why: `No commits, file changes or agent sessions for ${Math.floor(daysSince(n.lastActivity?.at))} days.`,
      confidence: 'med',
      nodeId: n.id,
      ops: n.archivePlan.ops,
      action: { type: 'archive', nodeId: n.id },
    })
  }

  const heavy = nodes.filter(n => n.size && n.size.reclaimable > 100e6 && (n.archived || n.status.value === 'dormant'))
  if (heavy.length)
    out.push({
      id: 'space:inactive',
      category: 'space',
      title: `Free ${bytes(sum(heavy.map(n => n.size!.reclaimable)))} from ${heavy.length} inactive project${heavy.length === 1 ? '' : 's'}`,
      why: 'Dependencies and build output in archived or dormant projects. They go to the system trash; a `pnpm install` brings them back.',
      confidence: 'high',
      action: { type: 'trash', paths: heavy.flatMap(n => n.size!.parts.map(p => path.join(n.path, p.path))) },
      ops: heavy.map(n => ({ kind: 'delete' as const, label: n.label, detail: `${bytes(n.size!.reclaimable)} · ${n.size!.parts.map(p => p.path).join(', ')}` })),
    })

  const byRoot = new Map<string, Node[]>()
  for (const n of nodes) if (n.git?.rootCommit) byRoot.set(n.git.rootCommit, [...(byRoot.get(n.git.rootCommit) ?? []), n])
  for (const [root, same] of byRoot) {
    if (same.length < 2) continue
    out.push({
      id: `dup:${root}`,
      category: 'duplicate',
      title: `${same[0].name} exists in ${same.length} places`,
      why: `${same.map(n => tilde(n.path)).join(' and ')} share their first commit. One is probably a stale copy.`,
      confidence: 'med',
      ops: same.map(n => ({ kind: 'keep' as const, label: tilde(n.path), detail: `last commit ${n.git!.lastCommitAt?.slice(0, 10) ?? '—'} · ${n.git!.commits} commits` })),
    })
  }

  // Surest and most useful first: a wrong "archive?" guess costs less attention at the bottom.
  const conf = { high: 0, med: 1, low: 2 }
  const cat = ['reconnect', 'migration', 'space', 'duplicate', 'orphan', 'status']
  return out.sort((a, b) => conf[a.confidence] - conf[b.confidence] || cat.indexOf(a.category) - cat.indexOf(b.category))
}
