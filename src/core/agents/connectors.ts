import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.ts'
import type { ConnectorSpec, Item, Link } from '../types.ts'
import { HOME, du, iso, list, pool, readEdges, readText, stat, tilde, within } from '../util.ts'
import { resolveEncoded } from './claude.ts'

export interface Connector extends ConnectorSpec {
  builtin: boolean
  about: string
}

/**
 * Tools laci knows out of the box. Claude Code is special-cased in claude.ts (memory, stale paths);
 * the rest go through the generic readers below, same as a connector the user adds.
 */
export const CATALOG: Omit<Connector, 'builtin'>[] = [
  { id: 'claude', name: 'Claude Code', about: 'Sessions and memory, one folder per project', link: { kind: 'named', dir: path.join(HOME, '.claude', 'projects'), naming: 'dashes' } },
  { id: 'codex', name: 'Codex', about: 'Sessions filed by date; each log records its folder', link: { kind: 'cwd', dir: path.join(HOME, '.codex', 'sessions'), ext: '.jsonl', field: 'cwd' } },
  { id: 'gemini', name: 'Gemini CLI', about: 'Chats and checkpoints, one folder per project', link: { kind: 'named', dir: path.join(HOME, '.gemini', 'tmp'), naming: 'sha256' } },
  { id: 'claude-plans', name: 'Claude plans', about: 'Plan files, linked by the paths they mention', link: { kind: 'mentions', dir: path.join(HOME, '.claude', 'plans'), ext: '.md' } },
  { id: 'serena', name: 'Serena', about: 'Memories kept inside the project', link: { kind: 'inside', path: '.serena/memories' } },
  { id: 'aider', name: 'Aider', about: 'Chat history kept inside the project', link: { kind: 'inside', path: '.aider.chat.history.md' } },
]

/** Catalog connectors whose store exists on this PC and isn't empty. Inside-the-project ones are only suggested. */
export async function presetsFound() {
  const out: string[] = []
  for (const c of CATALOG) if ('dir' in c.link && (await list(c.link.dir)).length) out.push(c.id)
  return out
}

/** The connectors in use: catalog ones the user added, then their own. */
export async function connectors(cfg: Config): Promise<Connector[]> {
  const ids = cfg.presets ?? (await presetsFound())
  return [
    ...CATALOG.filter(c => ids.includes(c.id)).map(c => ({ ...c, builtin: true })),
    ...cfg.custom.map(c => ({ ...c, builtin: false, about: ABOUT[c.link.kind] })),
  ]
}

const ABOUT: Record<Link['kind'], string> = {
  cwd: 'Log files that record their folder',
  named: 'One folder per project',
  inside: 'Kept inside the project',
  mentions: 'Files that mention project paths',
}

/** What moving a project does to this connector's data. */
export const MOVES: Record<Link['kind'], string> = {
  cwd: 'Paths in the logs are rewritten',
  named: 'Its folder is renamed to match',
  inside: 'Travels with the folder',
  mentions: 'Left as is: they only mention the old path',
}

export const where = (l: Link) => ('dir' in l ? tilde(l.dir) : `<project>/${l.path}`)

/** Folder name a `named` store uses for a project path. */
export function storeName(l: Extract<Link, { kind: 'named' }>, p: string) {
  return l.naming === 'sha256' ? createHash('sha256').update(p).digest('hex') : p.replace(/[^A-Za-z0-9]/g, '-')
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Regex source for `"field": "` in JSON text, up to where the value starts. */
export const fieldKey = (field: string) => `"${esc(field)}"\\s*:\\s*"`
/** Matches `"field": "value"`; group 1 is the still-escaped value. */
export const fieldRe = (field: string, flags = '') => new RegExp(`${fieldKey(field)}((?:[^"\\\\]|\\\\.)*)"`, flags)
const unjson = (s: string) => {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return undefined
  }
}

async function filesUnder(dir: string, ext: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await list(dir)) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await filesUnder(p, ext)))
    else if (e.isFile() && e.name.endsWith(ext)) out.push(p)
  }
  return out
}

async function readCwd(c: ConnectorSpec, l: Extract<Link, { kind: 'cwd' }>): Promise<Item[]> {
  const files = await filesUnder(l.dir, l.ext)
  return pool(files, 8, async file => {
    const { head } = await readEdges(file, 64 * 1024, 0)
    const raw = head.match(fieldRe(l.field))?.[1]
    const found = raw ? unjson(raw) : undefined
    const cwd = found && path.isAbsolute(found) ? found.replace(/\/+$/, '') || '/' : undefined
    let lines = 0
    if (cwd) {
      const text = await fs.readFile(file, 'utf8')
      for (const m of text.matchAll(fieldRe(l.field, 'g'))) {
        const v = unjson(m[1])
        if (v && within(v, cwd)) lines++
      }
    }
    const s = await fs.stat(file)
    return { id: `${c.id}:${path.relative(l.dir, file)}`, connector: c.id, file, at: iso(s.mtimeMs), bytes: s.size, cwd, lines }
  })
}

async function readNamed(c: ConnectorSpec, l: Extract<Link, { kind: 'named' }>): Promise<Item[]> {
  const dirs = (await list(l.dir)).filter(e => e.isDirectory() && (l.naming === 'sha256' ? /^[0-9a-f]{64}$/.test(e.name) : e.name.startsWith('-')))
  return pool(dirs, 4, async e => {
    const file = path.join(l.dir, e.name)
    let newest = (await stat(file))?.mtimeMs ?? 0
    for (const x of await list(file)) newest = Math.max(newest, (await stat(path.join(file, x.name)))?.mtimeMs ?? 0)
    // A hashed name can't be decoded; scan() matches it against folders it knows.
    const cwd = l.naming === 'dashes' ? await resolveEncoded(e.name) : undefined
    return { id: `${c.id}:${e.name}`, connector: c.id, file, at: iso(newest), bytes: await du(file), cwd, lines: 0 }
  })
}

async function readMentions(c: ConnectorSpec, l: Extract<Link, { kind: 'mentions' }>) {
  const out: { item: Item; text: string }[] = []
  for (const file of await filesUnder(l.dir, l.ext)) {
    const text = (await readText(file, 256 * 1024)) ?? ''
    const s = await stat(file)
    const title = text.match(/^#\s+(.+)/m)?.[1].replace(/[`*_]/g, '').trim() ?? path.basename(file)
    out.push({ item: { id: `${c.id}:${path.relative(l.dir, file)}`, connector: c.id, file, at: iso(s?.mtimeMs ?? 0), bytes: s?.size ?? 0, lines: 0, title }, text })
  }
  return out
}

/** Everything the store-based connectors hold. `inside` connectors are read per project, in scan(). */
export async function readStores(on: Connector[]) {
  const items: Item[] = []
  const mentions = new Map<string, string>()
  for (const c of on) {
    const l = c.link
    if (l.kind === 'cwd') items.push(...(await readCwd(c, l)))
    else if (l.kind === 'named') items.push(...(await readNamed(c, l)))
    else if (l.kind === 'mentions')
      for (const { item, text } of await readMentions(c, l)) {
        items.push(item)
        mentions.set(item.id, text)
      }
  }
  return { items, mentions }
}

export async function readInside(c: Connector, l: Extract<Link, { kind: 'inside' }>, project: string): Promise<Item | undefined> {
  const file = path.join(project, l.path)
  const s = await stat(file)
  if (!s) return
  let title: string | undefined
  if (s.isDirectory()) {
    const n = (await list(file)).length
    title = `${n} file${n === 1 ? '' : 's'}`
  }
  return { id: `${c.id}:${project}`, connector: c.id, file, at: iso(s.mtimeMs), bytes: s.isDirectory() ? await du(file) : s.size, cwd: project, lines: 0, title }
}
