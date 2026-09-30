import { promises as fs } from 'node:fs'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { HOME } from '../util.ts'

/**
 * What laci learned from each agent log, kept across scans and across runs, so an unchanged log is
 * never read twice. Claude's logs alone can be hundreds of MB; a scan used to spend most of its time
 * re-reading them. Keyed by file; an entry is valid while size, mtime and inode match.
 */
export const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'laci')
const FILE = path.join(CACHE_DIR, 'agent-logs.json')
const VERSION = 1

export interface Cached<T> {
  size: number
  mtime: number
  ino: number
  data: T
}

let mem: Map<string, Cached<any>> | undefined
let dirty = false

async function table() {
  if (mem) return mem
  mem = new Map()
  try {
    const raw = JSON.parse(await fs.readFile(FILE, 'utf8'))
    if (raw.version === VERSION) for (const [k, v] of Object.entries(raw.files)) mem.set(k, v as Cached<any>)
  } catch {}
  return mem
}

/**
 * The cached result for `file` if it hasn't changed, else `read(prev)`. `prev` is the last entry for
 * the same file (same inode, not smaller), so an append-only log can be read from where it left off.
 */
export async function cached<T>(kind: string, file: string, s: Stats, read: (prev?: Cached<T>) => Promise<T>): Promise<T> {
  const t = await table()
  const key = `${kind}:${file}`
  const hit = t.get(key) as Cached<T> | undefined
  if (hit && hit.size === s.size && hit.mtime === s.mtimeMs && hit.ino === s.ino) return hit.data
  const prev = hit && hit.ino === s.ino && hit.size <= s.size ? hit : undefined
  const data = await read(prev)
  t.set(key, { size: s.size, mtime: s.mtimeMs, ino: s.ino, data })
  dirty = true
  return data
}

/** Forget entries of `kind` for files that weren't seen in the last full read. */
export async function sweep(kind: string, seen: Set<string>) {
  const t = await table()
  for (const k of t.keys()) {
    if (k.startsWith(kind + ':') && !seen.has(k.slice(kind.length + 1))) {
      t.delete(k)
      dirty = true
    }
  }
}

export async function saveCache() {
  if (!dirty || !mem) return
  dirty = false
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ version: VERSION, files: Object.fromEntries(mem) }))
    await fs.rename(tmp, FILE)
  } catch {} // only a cache: the next scan reads the logs again
}
