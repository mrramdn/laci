import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ConnectorSpec, Link } from './types.ts'
import { HOME, stat, tilde, within } from './util.ts'

export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'laci')
const FILE = path.join(CONFIG_DIR, 'config.json')

export interface Apps {
  terminal?: string
  editor?: string
  files?: string
}

/** What the user chose. Paths are stored as `~/…` so the file reads well and survives a new username. */
export interface Config {
  /** Folders laci looks for projects in. Missing until the first-run setup is done. */
  roots?: string[]
  /**
   * Catalog connectors the user added. Missing until they add or remove one: until then, the ones
   * with data on this PC count as added, so an archive never leaves existing history behind.
   */
  presets?: string[]
  custom: ConnectorSpec[]
  apps: Apps
  /** Missing means follow the system. The desktop window reads it too, so it opens in the right colors. */
  theme?: 'light' | 'dark'
}

export class ConfigError extends Error {}
const bad = (msg: string): never => {
  throw new ConfigError(msg)
}

export const expand = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p)

/** A folder the user typed: absolute (or `~/…`), inside the home folder, normalized. */
export function homePath(raw: unknown, what: string) {
  if (typeof raw !== 'string' || !raw.trim()) return bad(`${what}: pick a folder`)
  const e = expand(raw.trim())
  if (!path.isAbsolute(e)) return bad(`${what}: use a full path like ~/project`)
  const p = path.resolve(e)
  if (!within(p, HOME)) return bad(`${what}: must be inside your home folder`)
  return p
}

const APP = /^[\w.+-]{1,40}$/
const FIELD = /^[A-Za-z_][\w.-]{0,40}$/
const EXT = /^\.[A-Za-z0-9]{1,10}$/

export function checkLink(l: any): Link {
  if (!l || typeof l !== 'object') return bad('Pick how this tool is linked to projects')
  if (l.kind === 'cwd') {
    const field = String(l.field ?? 'cwd').trim()
    const ext = String(l.ext ?? '.jsonl').trim()
    if (!FIELD.test(field)) bad('Field name: letters, numbers, dots or dashes')
    if (!EXT.test(ext)) bad('File type: like .jsonl or .json')
    return { kind: 'cwd', dir: homePath(l.dir, 'Log folder'), ext, field }
  }
  if (l.kind === 'named') {
    if (l.naming !== 'dashes' && l.naming !== 'sha256') bad('Pick how the folders are named')
    return { kind: 'named', dir: homePath(l.dir, 'Store folder'), naming: l.naming }
  }
  if (l.kind === 'mentions') {
    const ext = String(l.ext ?? '.md').trim()
    if (!EXT.test(ext)) bad('File type: like .md')
    return { kind: 'mentions', dir: homePath(l.dir, 'Folder'), ext }
  }
  if (l.kind === 'inside') {
    const rel = String(l.path ?? '').trim().replace(/\/+$/, '')
    // Stays inside the project: moves carry it along, and nothing outside gets read.
    if (!rel || path.isAbsolute(rel) || rel.split('/').some(s => s === '..' || s === '') || rel.length > 200) bad('Path inside the project: like .aider.chat.history.md or .tool/history')
    return { kind: 'inside', path: rel }
  }
  return bad('Pick how this tool is linked to projects')
}

export function checkConnector(raw: any, taken: string[]): ConnectorSpec {
  const name = String(raw?.name ?? '').trim()
  if (!name || name.length > 40) bad('Give it a name (up to 40 characters)')
  const base = 'custom-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tool')
  let id = base
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`
  return { id, name, link: checkLink(raw?.link) }
}

export function checkApps(raw: any): Apps {
  const out: Apps = {}
  for (const k of ['terminal', 'editor', 'files'] as const) {
    const v = String(raw?.[k] ?? '').trim()
    if (!v) continue
    if (!APP.test(v)) bad(`${k}: a program name like kitty or code`)
    out[k] = v
  }
  return out
}

const store = (l: Link): Link => ('dir' in l ? { ...l, dir: tilde(l.dir) } : l)
const load = (l: Link): Link => ('dir' in l ? { ...l, dir: expand(l.dir) } : l)

export async function loadConfig(): Promise<Config> {
  let raw: any = {}
  try {
    raw = JSON.parse(await fs.readFile(FILE, 'utf8'))
  } catch {}
  const custom: ConnectorSpec[] = []
  for (const c of Array.isArray(raw.custom) ? raw.custom : []) {
    try {
      if (typeof c?.id === 'string' && /^custom-[a-z0-9-]+$/.test(c.id)) custom.push({ id: c.id, name: String(c.name), link: checkLink(load(c.link)) })
    } catch {} // a hand-edited entry that no longer validates is skipped, not fatal
  }
  return {
    roots: Array.isArray(raw.roots) ? raw.roots.map((r: string) => expand(String(r))) : undefined,
    presets: Array.isArray(raw.presets) ? raw.presets.map(String) : undefined,
    custom,
    apps: (() => {
      try {
        return checkApps(raw.apps)
      } catch {
        return {}
      }
    })(),
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : undefined,
  }
}

export async function saveConfig(c: Config) {
  const out = {
    roots: c.roots?.map(tilde),
    presets: c.presets,
    custom: c.custom.map(x => ({ ...x, link: store(x.link) })),
    apps: c.apps,
    theme: c.theme,
  }
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(out, null, 2) + '\n')
  await fs.rename(tmp, FILE)
}

let saving: Promise<unknown> = Promise.resolve()
/** Read, change and write the config, one change at a time, so two quick edits can't undo each other. */
export function updateConfig(fn: (c: Config) => Promise<void> | void) {
  const run = saving.then(async () => {
    const c = await loadConfig()
    await fn(c)
    await saveConfig(c)
    return c
  })
  saving = run.catch(() => {})
  return run
}

/** Roots the user picked: each must be an existing folder in the home folder. */
export async function checkRoots(raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw) || !raw.length) return bad('Pick at least one folder')
  const out: string[] = []
  for (const r of raw) {
    const p = homePath(r, 'Folder')
    if (!(await stat(p))?.isDirectory()) bad(`${tilde(p)} doesn't exist`)
    if (!out.some(o => within(p, o))) out.push(p)
  }
  return out.filter(p => !out.some(o => o !== p && within(p, o)))
}
