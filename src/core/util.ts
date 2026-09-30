import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME = os.homedir()
/** laci's own files: undo journals, the activity log, the debug log, backups. */
export const DATA = path.join(HOME, '.local', 'share', 'laci')

/** Claude Code's project-dir encoding: every non-alphanumeric char becomes `-`. Lossy on purpose. */
export const enc = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')

export const tilde = (p: string) => (p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p)

export const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')

/** Dirs that are build output or dependencies: never walked, and counted as reclaimable space. */
export const HEAVY = new Set([
  'node_modules', '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.vercel', 'dist', 'build', 'out',
  'target', '.venv', 'venv', '__pycache__', 'vendor', '.dart_tool', '.gradle', 'coverage', 'test-results',
  '.expo', '.parcel-cache', '.cache',
])

export async function run(cmd: string, args: string[], timeout = 20000): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      // GIT_OPTIONAL_LOCKS=0 keeps `git status` from touching the index, so scanning stays read-only.
      { timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '').trimEnd() }),
    )
  })
}

export async function readText(p: string, max = 256 * 1024): Promise<string | undefined> {
  try {
    const fh = await fs.open(p, 'r')
    try {
      const { size } = await fh.stat()
      const buf = Buffer.alloc(Math.min(size, max))
      await fh.read(buf, 0, buf.length, 0)
      return buf.toString('utf8')
    } finally {
      await fh.close()
    }
  } catch {
    return undefined
  }
}

/** First `head` and last `tail` bytes of a file, for big JSONL logs we only need the edges of. */
export async function readEdges(p: string, head = 64 * 1024, tail = 512 * 1024) {
  const fh = await fs.open(p, 'r')
  try {
    const { size } = await fh.stat()
    const h = Buffer.alloc(Math.min(size, head))
    await fh.read(h, 0, h.length, 0)
    const tlen = Math.min(size, tail)
    const t = Buffer.alloc(tlen)
    await fh.read(t, 0, tlen, size - tlen)
    return { head: h.toString('utf8'), tail: t.toString('utf8'), size }
  } finally {
    await fh.close()
  }
}

export async function stat(p: string) {
  try {
    return await fs.stat(p)
  } catch {
    return undefined
  }
}

export async function list(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    }),
  )
  return out
}

export async function du(p: string): Promise<number> {
  const r = await run('du', ['-sb', p], 60000)
  return r.ok ? Number(r.out.split('\t')[0]) || 0 : 0
}

/** Walk regular files under `root`, skipping hidden and heavy dirs. Stops after `limit` files. */
export async function walkFiles(root: string, limit: number, onFile: (rel: string, mtimeMs: number) => void) {
  let seen = 0
  const stack = [root]
  while (stack.length && seen < limit) {
    const dir = stack.pop()!
    for (const e of await list(dir)) {
      if (seen >= limit) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !HEAVY.has(e.name)) stack.push(full)
      } else if (e.isFile()) {
        const s = await stat(full)
        if (s) onFile(path.relative(root, full), s.mtimeMs)
        seen++
      }
    }
  }
  return seen
}

/** Strip credentials from a remote URL and turn it into a browsable https link. */
export function remoteWeb(url: string): { url: string; web?: string; host?: string } {
  const clean = url.replace(/^(https?:\/\/)[^@/]+@/, '$1')
  let web: string | undefined
  const ssh = clean.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/)
  if (ssh) web = `https://${ssh[1]}/${ssh[2]}`
  else if (/^https?:\/\//.test(clean)) web = clean.replace(/\.git\/?$/, '')
  const host = web ? new URL(web).hostname.replace(/^www\./, '') : undefined
  return { url: clean, web, host }
}

export const iso = (ms: number) => new Date(ms).toISOString()
export const daysSince = (at: string | undefined, now = Date.now()) => (at ? (now - Date.parse(at)) / 86400000 : Infinity)
