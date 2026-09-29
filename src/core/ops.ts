import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Action, Snapshot } from './types.ts'
import { CLAUDE_PROJECTS } from './agents/claude.ts'
import { CODEX_SESSIONS } from './agents/codex.ts'
import { staleRoots } from './health.ts'
import { excludeFile, setMeta } from './sidecar.ts'
import { archiveDest } from './tidy.ts'
import { HOME, enc, list, run, stat, tilde, within } from './util.ts'

export const DATA = path.join(HOME, '.local', 'share', 'laci')
export const JOURNALS = path.join(DATA, 'journal')
const BACKUPS = path.join(DATA, 'backup')
const QUARANTINE = path.join(DATA, 'orphans')

interface Entry {
  kind: 'move' | 'rewrite' | 'mkdir' | 'rmdir' | 'trash' | 'file'
  from?: string
  to?: string
  path?: string
  backup?: string
  existed?: boolean
}

export interface Journal {
  id: string
  at: string
  title: string
  state: 'running' | 'applied' | 'failed' | 'undone'
  entries: Entry[]
  error?: string
}

const exists = async (p: string) => !!(await stat(p))

async function rename(from: string, to: string) {
  try {
    await fs.rename(from, to)
  } catch (e: any) {
    if (e.code !== 'EXDEV') throw e
    await fs.cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
    await fs.rm(from, { recursive: true })
  }
}

/** Processes whose working directory is inside one of `paths`: moving under them breaks them. */
export async function busyIn(paths: string[]) {
  const out: { pid: number; name: string; cwd: string }[] = []
  for (const e of await list('/proc')) {
    if (!/^\d+$/.test(e.name) || Number(e.name) === process.pid) continue
    try {
      const cwd = await fs.readlink(`/proc/${e.name}/cwd`)
      if (!paths.some(p => within(cwd, p))) continue
      const name = (await fs.readFile(`/proc/${e.name}/comm`, 'utf8')).trim()
      out.push({ pid: Number(e.name), name, cwd })
    } catch {}
  }
  return out
}

/**
 * One undoable change set. Every step is written to the journal before the next one starts, so a crash
 * mid-way still leaves a record that `undo` can walk back.
 */
export class Tx {
  j: Journal
  file: string
  n = 0

  constructor(title: string) {
    const at = new Date().toISOString()
    const id = at.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6)
    this.j = { id, at, title, state: 'running', entries: [] }
    this.file = path.join(JOURNALS, `${id}.json`)
  }

  async save() {
    await fs.mkdir(JOURNALS, { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.j, null, 2))
  }

  async log(e: Entry) {
    this.j.entries.push(e)
    await this.save()
  }

  async mkdirs(dir: string) {
    const missing: string[] = []
    for (let d = dir; !(await exists(d)); d = path.dirname(d)) missing.unshift(d)
    for (const d of missing) {
      await fs.mkdir(d)
      await this.log({ kind: 'mkdir', path: d })
    }
  }

  async move(from: string, to: string) {
    if (await exists(to)) throw new Error(`${tilde(to)} already exists`)
    await this.mkdirs(path.dirname(to))
    await this.log({ kind: 'move', from, to })
    await rename(from, to)
  }

  /** Move a directory into `to`, merging entry by entry when `to` already exists. */
  async moveInto(from: string, to: string) {
    if (!(await exists(to))) return this.move(from, to)
    for (const e of await list(from)) {
      const src = path.join(from, e.name)
      let dst = path.join(to, e.name)
      if (await exists(dst)) {
        if (e.isDirectory()) {
          await this.moveInto(src, dst)
          continue
        }
        dst = path.join(to, `${path.parse(e.name).name}.from-${path.basename(from)}${path.extname(e.name)}`)
      }
      await this.move(src, dst)
    }
    await fs.rmdir(from)
    await this.log({ kind: 'rmdir', path: from })
  }

  /** Replace `"cwd":"<from>…"` prefixes. The original file is kept in the backup dir for undo. */
  async rewrite(file: string, pairs: [string, string][]) {
    const text = await fs.readFile(file, 'utf8')
    let changed = 0
    let out = text
    for (const [from, to] of [...pairs].sort((a, b) => b[0].length - a[0].length)) {
      const f = JSON.stringify(from).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(`"cwd":"${f}(?=["/])`, 'g'), () => {
        changed++
        return `"cwd":${JSON.stringify(to).slice(0, -1)}`
      })
    }
    if (!changed) return 0
    const backup = path.join(BACKUPS, this.j.id, `${++this.n}-${path.basename(file)}`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    const tmp = `${file}.laci-tmp`
    await fs.writeFile(tmp, out)
    await this.log({ kind: 'rewrite', path: file, backup })
    await rename(file, backup)
    await fs.rename(tmp, file)
    return changed
  }

  async trash(p: string) {
    if (!(await exists(p))) return
    const r = await run('gio', ['trash', p], 120000)
    if (!r.ok) throw new Error(`Couldn't move ${tilde(p)} to trash`)
    await this.log({ kind: 'trash', path: p })
  }

  /** Remember a file as it is now (or that it didn't exist), so undo can put it back. */
  async keep(file: string) {
    const existed = await exists(file)
    const backup = path.join(BACKUPS, this.j.id, `${++this.n}-${path.basename(file)}`)
    if (existed) {
      await fs.mkdir(path.dirname(backup), { recursive: true })
      await fs.copyFile(file, backup)
    }
    await this.log({ kind: 'file', path: file, backup: existed ? backup : undefined, existed })
  }

  /** Edit `.laci.md` (which may also add it to .git/info/exclude); both are restorable. */
  async sidecar(dir: string, fn: () => Promise<void>) {
    await this.keep(path.join(dir, '.laci.md'))
    const ex = await excludeFile(dir)
    if (ex) await this.keep(ex)
    await fn()
  }

  async commit() {
    this.j.state = 'applied'
    await this.save()
    return this.j
  }

  async abort(err: unknown) {
    this.j.error = String((err as Error)?.message ?? err)
    try {
      await undoEntries(this.j.entries)
      this.j.state = 'undone'
    } catch (e) {
      this.j.state = 'failed'
      this.j.error += ` · rollback failed: ${(e as Error).message}`
    }
    await this.save()
  }
}

async function undoEntries(entries: Entry[]) {
  for (const e of [...entries].reverse()) {
    if (e.kind === 'move' && e.from && e.to) {
      if (await exists(e.to)) {
        await fs.mkdir(path.dirname(e.from), { recursive: true })
        await rename(e.to, e.from)
      }
    } else if (e.kind === 'rewrite' && e.path && e.backup) {
      if (await exists(e.backup)) await rename(e.backup, e.path)
    } else if (e.kind === 'mkdir' && e.path) {
      await fs.rmdir(e.path).catch(() => {})
    } else if (e.kind === 'rmdir' && e.path) {
      await fs.mkdir(e.path, { recursive: true })
    } else if (e.kind === 'file' && e.path) {
      if (e.existed && e.backup) await fs.copyFile(e.backup, e.path)
      else await fs.rm(e.path, { force: true })
    }
    // `trash` isn't reversed automatically: the items are in the system trash.
  }
}

export async function journals(limit = 20): Promise<Journal[]> {
  const files = (await list(JOURNALS)).filter(e => e.name.endsWith('.json')).map(e => e.name).sort().reverse().slice(0, limit)
  const out: Journal[] = []
  for (const f of files) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(JOURNALS, f), 'utf8')))
    } catch {}
  }
  return out
}

export async function undo(id: string) {
  const file = path.join(JOURNALS, `${path.basename(id)}.json`)
  const j: Journal = JSON.parse(await fs.readFile(file, 'utf8'))
  if (j.state !== 'applied') throw new Error(`This change is ${j.state}, nothing to undo`)
  const busy = await busyIn(j.entries.flatMap(e => (e.kind === 'move' ? [e.to!] : [])))
  if (busy.length) throw new Error(`Close ${busy.map(b => `${b.name} (pid ${b.pid})`).join(', ')} first`)
  await undoEntries(j.entries)
  j.state = 'undone'
  await fs.writeFile(file, JSON.stringify(j, null, 2))
  return j
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

async function guard(paths: string[]) {
  const busy = await busyIn(paths)
  if (busy.length) throw new Error(`In use by ${busy.map(b => `${b.name} (pid ${b.pid})`).join(', ')}. Close it first.`)
}

async function transact(title: string, fn: (tx: Tx) => Promise<void>) {
  const tx = new Tx(title)
  await tx.save()
  try {
    await fn(tx)
    return await tx.commit()
  } catch (e) {
    await tx.abort(e)
    throw e
  }
}

/** Move a folder and carry its Claude/Codex history along. */
export async function moveProject(snap: Snapshot, id: string, dest: string, opts: { status?: string; trashHeavy?: boolean; title?: string } = {}) {
  const n = snap.nodes[id]
  if (!n) throw new Error('Unknown project. Rescan and try again.')
  const from = n.path
  if (within(dest, from)) throw new Error("Can't move a folder into itself")
  await guard([from])
  return transact(opts.title ?? `Move ${n.name} → ${tilde(dest)}`, async tx => {
    await tx.move(from, dest)
    for (const c of Object.values(snap.claude)) {
      if (!c.path || !within(c.path, from)) continue
      const now = dest + c.path.slice(from.length)
      const target = path.join(CLAUDE_PROJECTS, enc(now))
      await tx.moveInto(c.dir, target)
      const pairs: [string, string][] = [[from, dest], ...staleRoots(c).map(r => [r, now] as [string, string])]
      for (const f of await jsonlUnder(target)) await tx.rewrite(f, pairs)
    }
    for (const s of Object.values(snap.codex)) if (s.cwd && within(s.cwd, from)) await tx.rewrite(s.file, [[from, dest]])
    if (opts.status) await tx.sidecar(dest, () => setMeta(dest, 'status', opts.status))
    if (opts.trashHeavy && n.size) for (const p of n.size.parts) await tx.trash(path.join(dest, p.path))
  })
}

export async function archiveProject(snap: Snapshot, id: string, opts: { trashHeavy?: boolean } = {}) {
  const n = snap.nodes[id]
  if (!n) throw new Error('Unknown project. Rescan and try again.')
  return moveProject(snap, id, await archiveDest(n, snap.roots), { ...opts, status: 'archived', title: `Archive ${n.name}` })
}

export async function applyAction(snap: Snapshot, title: string, a: Action) {
  if (a.type === 'archive') return archiveProject(snap, a.nodeId)
  return transact(title, async tx => {
    if (a.type === 'reconnect-claude') {
      await tx.moveInto(a.dir, a.target)
      for (const f of await jsonlUnder(a.target)) await tx.rewrite(f, a.pairs)
    } else if (a.type === 'rewrite-claude') {
      for (const it of a.items) for (const f of await jsonlUnder(it.dir)) await tx.rewrite(f, it.pairs)
    } else if (a.type === 'rewrite-codex') {
      for (const f of a.files) await tx.rewrite(f, a.pairs)
    } else if (a.type === 'quarantine') {
      for (const p of a.paths) {
        const rel = within(p, CODEX_SESSIONS) ? path.join('codex', path.relative(CODEX_SESSIONS, p)) : path.join('claude', path.basename(p))
        await tx.move(p, path.join(QUARANTINE, rel))
      }
    } else if (a.type === 'trash') {
      for (const p of a.paths) await tx.trash(p)
    }
  })
}

/** Copy every agent log that isn't backed up yet. Claude deletes old transcripts; this keeps them. */
export async function backupHistory() {
  const dest = path.join(DATA, 'history')
  let copied = 0
  let bytes = 0
  const walk = async (src: string, dst: string) => {
    for (const e of await list(src)) {
      const s = path.join(src, e.name)
      const d = path.join(dst, e.name)
      if (e.isDirectory()) await walk(s, d)
      else if (e.isFile() && /\.(jsonl|md)$/.test(e.name)) {
        const [a, b] = await Promise.all([stat(s), stat(d)])
        if (b && a && b.size === a.size) continue
        await fs.mkdir(dst, { recursive: true })
        await fs.copyFile(s, d)
        copied++
        bytes += a?.size ?? 0
      }
    }
  }
  await walk(CLAUDE_PROJECTS, path.join(dest, 'claude'))
  await walk(CODEX_SESSIONS, path.join(dest, 'codex'))
  return { copied, bytes, dest }
}
