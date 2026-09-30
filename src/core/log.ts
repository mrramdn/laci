import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { DATA } from './util.ts'

/**
 * The debug log: what laci did and what went wrong, for when something looks off. Plain text, one line
 * per event, rotated at 1 MB. Also echoed to stderr (stdout belongs to the MCP protocol).
 */
export const LOG_FILE = path.join(DATA, 'laci.log')
const MAX = 1024 * 1024
const DEBUG = !!process.env.LACI_DEBUG
let who = 'laci'
let ready = false

/** Name this process in each line: app, mcp or cli. */
export function logAs(name: string) {
  who = name
}

function write(level: string, msg: string) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${who} ${process.pid}] ${msg}\n`
  process.stderr.write(line)
  try {
    if (!ready) {
      mkdirSync(DATA, { recursive: true })
      ready = true
    }
    if ((statSync(LOG_FILE, { throwIfNoEntry: false })?.size ?? 0) > MAX) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    appendFileSync(LOG_FILE, line)
  } catch {} // a log that can't be written must never break the app
}

const text = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e))

export const log = {
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string, e?: unknown) => write('error', e === undefined ? msg : `${msg}: ${text(e)}`),
  /** Only with LACI_DEBUG=1: noisy things like file watcher events. */
  debug: (msg: string) => DEBUG && write('debug', msg),
}
