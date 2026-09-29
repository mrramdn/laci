import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { GitInfo, Remote } from './types.ts'
import { remoteWeb, run } from './util.ts'

const AI_TRAILER = String.raw`(co-authored-by:.*(claude|copilot|codex|cursor|gemini|devin|aider))|(generated with .*claude)`

export async function gitInfo(dir: string): Promise<GitInfo> {
  const g = (...args: string[]) => run('git', ['-C', dir, ...args])
  const [count, last, roots, branch, remotes, status, stash, recent, authors, trailers, dotgit] = await Promise.all([
    g('rev-list', '--count', 'HEAD'),
    g('log', '-1', '--format=%cI%x1f%s'),
    g('log', '--max-parents=0', '--format=%H%x1f%cI', 'HEAD'),
    g('branch', '--show-current'),
    g('remote', '-v'),
    g('status', '--porcelain=v1', '-b', '--untracked-files=normal'),
    g('stash', 'list'),
    g('log', '--since=182.days', '--format=%ct'),
    g('shortlog', '-sne', 'HEAD'),
    g('log', '-E', '-i', `--grep=${AI_TRAILER}`, '--format=%h'),
    stat(path.join(dir, '.git')).catch(() => undefined),
  ])

  const commits = count.ok ? Number(count.out) || 0 : 0
  const [lastCommitAt, lastSubject] = last.ok && last.out ? last.out.split('\x1f') : []
  const rootLine = roots.ok ? roots.out.split('\n').filter(Boolean).at(-1) : undefined
  const [rootCommit, firstCommitAt] = rootLine ? rootLine.split('\x1f') : []

  const seen = new Set<string>()
  const remoteList: Remote[] = []
  for (const line of remotes.out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    remoteList.push({ name: m[1], ...remoteWeb(m[2]) })
  }

  const lines = status.out.split('\n')
  const head = lines[0]?.startsWith('## ') ? lines.shift()! : ''
  const upstream = head.match(/\.\.\.(\S+)/)?.[1]
  const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(head.match(/behind (\d+)/)?.[1] ?? 0)

  const weekly = new Array(26).fill(0)
  const now = Date.now() / 1000
  for (const t of recent.out.split('\n').filter(Boolean)) {
    const w = Math.floor((now - Number(t)) / (7 * 86400))
    if (w >= 0 && w < 26) weekly[25 - w]++
  }

  return {
    rootCommit,
    firstCommitAt,
    lastCommitAt,
    lastSubject,
    commits,
    branch: branch.out || undefined,
    remotes: remoteList,
    upstream,
    dirty: lines.filter(Boolean).length,
    ahead,
    behind,
    stashes: stash.out ? stash.out.split('\n').length : 0,
    weekly,
    authors: authors.out ? authors.out.split('\n').length : 0,
    aiTrailers: trailers.out ? trailers.out.split('\n').length : 0,
    worktree: !!dotgit && dotgit.isFile(),
  }
}
