import { randomBytes } from 'node:crypto'
import pty from 'node-pty'

type Event = { type: 'data'; data: string } | { type: 'exit'; code: number }

interface Term {
  id: string
  cwd: string
  title: string
  proc: pty.IPty
  /** Recent output, replayed when the UI reconnects (e.g. after a reload). */
  buf: string
  listeners: Set<(e: Event) => void>
  exited?: number
}

const KEEP = 256 * 1024
const terms = new Map<string, Term>()

/**
 * Start a login shell in `cwd`. `cmd` is typed into it once the prompt shows; with `run` it's also
 * executed, otherwise it waits for the user to press Enter.
 */
export function open(cwd: string, title: string, cmd?: string, run = false) {
  const shell = process.env.SHELL || 'bash'
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
  // The server may run inside Electron in node mode; shells started from it must not inherit that.
  delete env.ELECTRON_RUN_AS_NODE
  const proc = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env })
  const t: Term = { id: randomBytes(6).toString('hex'), cwd, title, proc, buf: '', listeners: new Set() }
  let pending = cmd
  const type = () => {
    if (!pending) return
    proc.write(pending + (run ? '\r' : ''))
    pending = undefined
  }
  const fallback = setTimeout(type, 800)
  proc.onData(data => {
    t.buf = (t.buf + data).slice(-KEEP)
    for (const l of t.listeners) l({ type: 'data', data })
    if (pending) {
      clearTimeout(fallback)
      setTimeout(type, 60)
    }
  })
  proc.onExit(({ exitCode }) => {
    t.exited = exitCode
    for (const l of t.listeners) l({ type: 'exit', code: exitCode })
  })
  terms.set(t.id, t)
  return info(t)
}

const info = (t: Term) => ({ id: t.id, cwd: t.cwd, title: t.title, exited: t.exited })

export const list = () => [...terms.values()].map(info)

function get(id: unknown) {
  const t = typeof id === 'string' ? terms.get(id) : undefined
  if (!t) throw new Error('That terminal is gone')
  return t
}

export function input(id: unknown, data: unknown) {
  const t = get(id)
  if (t.exited === undefined && typeof data === 'string') t.proc.write(data)
}

export function resize(id: unknown, cols: unknown, rows: unknown) {
  const t = get(id)
  const c = Math.max(2, Math.min(500, Number(cols) | 0))
  const r = Math.max(2, Math.min(300, Number(rows) | 0))
  if (t.exited === undefined) t.proc.resize(c, r)
}

export function close(id: unknown) {
  const t = get(id)
  if (t.exited === undefined) t.proc.kill()
  terms.delete(t.id)
}

/** Subscribe to a terminal: the buffered output first, then live events. Returns the unsubscribe. */
export function watch(id: unknown, send: (e: Event) => void) {
  const t = get(id)
  if (t.buf) send({ type: 'data', data: t.buf })
  if (t.exited !== undefined) send({ type: 'exit', code: t.exited })
  t.listeners.add(send)
  return () => t.listeners.delete(send)
}

export function closeAll() {
  for (const t of terms.values()) if (t.exited === undefined) t.proc.kill()
}
