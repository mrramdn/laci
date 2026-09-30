import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ConnectorSpec } from './types.ts'
import { type Apps, ConfigError, homePath, updateConfig } from './config.ts'
import { log } from './log.ts'
import { type Journal, journals, undo as undoJournal } from './ops.ts'
import { META_RULES, SIDECAR, addNext, deleteCheck, setMeta, setNotes, toggleCheck } from './sidecar.ts'
import { DATA, readEdges, stat, tilde, within } from './util.ts'

/**
 * Every change laci makes, from the app or from an agent over MCP, one JSON line each. Moves and
 * archives also have an undo journal; this log is the readable list on top, with a way back where
 * there is one.
 */
export const ACTIVITY = path.join(DATA, 'activity.jsonl')

/** How to put a change back. Only laci writes these, and each is checked again before it runs. */
export type Undo =
  | { type: 'meta'; key: string; value: string }
  | { type: 'check'; file: string; text: string; done: boolean }
  /** Remove the next step that was added. */
  | { type: 'drop'; text: string }
  /** Add a deleted next step back (at the end of Next). */
  | { type: 'add'; text: string; done: boolean }
  | { type: 'notes'; text: string }
  | { type: 'journal'; id: string }
  | { type: 'connector'; remove?: string; preset?: string; spec?: ConnectorSpec }
  | { type: 'config'; roots?: string[]; presets?: string[]; apps: Apps }

export interface Activity {
  id: string
  at: string
  by: 'app' | 'agent'
  title: string
  /** The project it happened in. */
  path?: string
  detail?: string
  /** Changes to the same thing share a key; undoing an older one would overwrite a newer one. */
  key?: string
  journal?: string
  undo?: Undo
  /** This entry put that one back. */
  undoes?: string
}

export interface LogEntry extends Activity {
  state: 'applied' | 'undone' | 'failed' | 'running'
  canUndo: boolean
  /** Changed again later, so undoing this one would overwrite the newer change. */
  superseded?: boolean
  error?: string
  steps?: { kind: string; label: string; from?: string; to?: string }[]
}

let seq = 0
export async function record(a: Omit<Activity, 'id' | 'at'>): Promise<Activity> {
  const at = new Date().toISOString()
  const entry: Activity = { id: `${at.replace(/[:.]/g, '-')}-${(seq++).toString(36)}${process.pid.toString(36)}`, at, ...a }
  log.info(`${a.by}: ${a.title}${a.path ? ` (${tilde(a.path)})` : ''}`)
  try {
    await fs.mkdir(DATA, { recursive: true })
    const s = await stat(ACTIVITY)
    if (s && s.size > 4 * 1024 * 1024) await fs.rename(ACTIVITY, `${ACTIVITY}.1`)
    await fs.appendFile(ACTIVITY, JSON.stringify(entry) + '\n')
  } catch (e) {
    log.error('Could not write the activity log', e)
  }
  return entry
}

async function readActivity(): Promise<Activity[]> {
  if (!(await stat(ACTIVITY))) return []
  const { tail, size } = await readEdges(ACTIVITY, 0, 2 * 1024 * 1024)
  const lines = tail.split('\n')
  if (size > 2 * 1024 * 1024) lines.shift() // cut mid-line
  const out: Activity[] = []
  for (const l of lines) {
    try {
      if (l.trim()) out.push(JSON.parse(l))
    } catch {}
  }
  return out
}

/** What a journal did, short enough to read: the moves, then counts. */
function steps(j: Journal): LogEntry['steps'] {
  const out: NonNullable<LogEntry['steps']> = []
  const moves = j.entries.filter(e => e.kind === 'move')
  for (const m of moves.slice(0, 20)) out.push({ kind: 'move', label: 'Moved', from: tilde(m.from!), to: tilde(m.to!) })
  if (moves.length > 20) out.push({ kind: 'move', label: `And ${moves.length - 20} more moves` })
  const rewrites = j.entries.filter(e => e.kind === 'rewrite').length
  if (rewrites) out.push({ kind: 'rewrite', label: `Rewrote the folder path in ${rewrites} log file${rewrites === 1 ? '' : 's'}` })
  for (const e of j.entries.filter(x => x.kind === 'trash')) out.push({ kind: 'delete', label: 'Moved to the trash', from: tilde(e.path!) })
  for (const e of j.entries.filter(x => x.kind === 'file'))
    out.push(
      path.basename(e.path!) === 'exclude'
        ? { kind: 'write', label: 'Kept .laci.md out of git', from: tilde(e.path!) }
        : { kind: 'write', label: `Edited ${path.basename(e.path!)}`, from: tilde(path.dirname(e.path!)) },
    )
  return out
}

/**
 * The log, newest first. Changes from before this log existed still show, from their journals.
 * Journal state wins, so a move undone by an agent shows as undone here too.
 */
export async function readLog(limit = 300): Promise<LogEntry[]> {
  const acts = await readActivity()
  const js = await journals(200)
  const byJournal = new Map(js.map(j => [j.id, j]))
  const covered = new Set(acts.flatMap(a => (a.journal ? [a.journal] : [])))
  const older: Activity[] = js
    .filter(j => !covered.has(j.id))
    .map(j => ({ id: `j:${j.id}`, at: j.at, by: 'app', title: j.title, journal: j.id, undo: { type: 'journal', id: j.id } }))
  const undone = new Set(acts.flatMap(a => (a.undoes ? [a.undoes] : [])))
  const seen = new Set<string>()
  return [...acts, ...older]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map(a => {
      const j = a.journal ? byJournal.get(a.journal) : undefined
      const state = j ? j.state : undone.has(a.id) ? 'undone' : 'applied'
      const superseded = !!a.key && seen.has(a.key)
      if (a.key && !a.undoes && state === 'applied') seen.add(a.key)
      return { ...a, state, superseded, canUndo: !!a.undo && !a.undoes && state === 'applied' && !superseded, error: j?.error, steps: j ? steps(j) : undefined }
    })
}

const bad = (msg: string): never => {
  throw new ConfigError(msg)
}

/** A project folder named in the log: still inside the home folder, and still there. */
async function projectDir(p: string | undefined) {
  const dir = homePath(p, 'Project')
  if (!(await stat(dir))?.isDirectory()) bad(`${tilde(dir)} is gone. It may have been moved since.`)
  return dir
}

/**
 * Put a change back, and log that. Returns what the app has to refresh: one project, or everything
 * after a move or a config change.
 */
export async function undoActivity(id: string, by: Activity['by']): Promise<{ refresh: 'project' | 'all'; path?: string; entry: Activity }> {
  const a = (await readLog(2000)).find(x => x.id === id) ?? bad('That change is no longer in the log')
  if (!a.canUndo || !a.undo) bad(a.superseded ? 'It was changed again after this. Undo the newer change first.' : a.state === 'undone' ? 'Already undone' : "This change can't be undone from here")
  const u = a.undo!
  let refresh: 'project' | 'all' = 'project'
  let dir: string | undefined
  if (u.type === 'journal') {
    await undoJournal(u.id)
    refresh = 'all'
  } else if (u.type === 'connector' || u.type === 'config') {
    await updateConfig(c => {
      if (u.type === 'config') {
        c.roots = u.roots
        c.presets = u.presets
        c.apps = u.apps
      } else if (u.remove) {
        c.presets = c.presets?.filter(x => x !== u.remove)
        c.custom = c.custom.filter(x => x.id !== u.remove)
      } else if (u.preset) c.presets = [...new Set([...(c.presets ?? []), u.preset])]
      else if (u.spec && !c.custom.some(x => x.id === u.spec!.id)) c.custom.push(u.spec)
    })
    refresh = 'all'
  } else {
    dir = await projectDir(a.path)
    if (u.type === 'meta') {
      if (!META_RULES[u.key]?.test(u.value)) bad('Unknown field')
      await setMeta(dir, u.key, u.value || undefined)
    } else if (u.type === 'check') {
      const file = path.resolve(dir, u.file)
      if (!within(file, dir)) bad('Unknown task file')
      await toggleCheck(file, 0, u.text, u.done)
    } else if (u.type === 'drop') await deleteCheck(path.join(dir, SIDECAR), 0, u.text)
    else if (u.type === 'add') {
      await addNext(dir, u.text)
      if (u.done) await toggleCheck(path.join(dir, SIDECAR), 0, u.text, true)
    } else if (u.type === 'notes') await setNotes(dir, u.text)
  }
  const entry = await record({ by, title: `Undid: ${a.title}`, path: a.path, undoes: a.id })
  return { refresh, path: dir, entry }
}

/** The log entry for a journal, so undoing a move from its toast marks the same row in the Log. */
export async function entryForJournal(journalId: string) {
  return (await readActivity()).find(a => a.journal === journalId)?.id ?? `j:${journalId}`
}
