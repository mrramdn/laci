import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Node, Snapshot } from './core/types.ts'
import { issuesFor } from './core/health.ts'
import { applyAction, archiveProject, backupHistory, journals, undo } from './core/ops.ts'
import { autoStatus, scan } from './core/scan.ts'
import { META_RULES, SIDECAR, addNext, deleteCheck, setMeta, setNotes, toggleCheck } from './core/sidecar.ts'
import { readTasks } from './core/tasks.ts'
import { bytes } from './core/tidy.ts'
import { tilde, within } from './core/util.ts'
import * as term from './term.ts'
import { VENDOR } from './vendor.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.LACI_PORT ?? 4747)
const TERMINAL = process.env.LACI_TERMINAL ?? 'kitty'
const EDITOR = process.env.LACI_EDITOR ?? 'code'
const FILES = process.env.LACI_FILES ?? 'dolphin'
// A page on any other site could POST to localhost; it can't read this token out of our page.
const TOKEN = randomBytes(18).toString('base64url')

let snap: Snapshot | undefined
let scanning: Promise<Snapshot> = Promise.resolve(undefined as unknown as Snapshot)
const rescan = () => (scanning = scan().then(s => (snap = s)))
let lock: Promise<unknown> = Promise.resolve()
/** Changes on disk run one at a time, each against a fresh scan. */
const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = lock.then(async () => {
    await scanning
    return fn()
  })
  lock = run.catch(() => {})
  return run
}

class Bad extends Error {}
const need = <T>(v: T | undefined | null | false, msg: string): T => {
  if (!v) throw new Bad(msg)
  return v
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function detach(cmd: string, args: string[], cwd: string) {
  const env = { ...process.env }
  // Set when the server runs inside Electron; an editor like VS Code (also Electron) would break with it.
  delete env.ELECTRON_RUN_AS_NODE
  const p = spawn(cmd, args, { cwd, env, detached: true, stdio: 'ignore' })
  p.on('error', () => {})
  p.unref()
}

/** Open a terminal in `cwd`, optionally running `cmd`. `confirm` shows the command and waits for Enter. */
function terminal(cwd: string, cmd?: string, confirm = false) {
  const shell = `exec "\${SHELL:-bash}"`
  const script = !cmd ? undefined : confirm
    ? `printf '\\033[2m$ %s\\033[0m\\n' "$0"; read -rp 'Press Enter to run, Ctrl+C to cancel ' _ && eval "$0"; ${shell}`
    : `printf '\\033[2m$ %s\\033[0m\\n' "$0"; eval "$0"; ${shell}`
  const run = script ? ['bash', '-lc', script, cmd!] : []
  if (TERMINAL === 'konsole') detach('konsole', ['--workdir', cwd, ...(run.length ? ['-e', ...run] : [])], cwd)
  else detach(TERMINAL, ['--directory', cwd, ...run], cwd)
}

const FIX: Record<string, (n: Node) => string> = {
  'no-remote': n => `gh repo create ${shq(n.name)} --private --source . --remote origin --push`,
  'no-commits': () => `git add -A && git commit -m 'chore: initial commit'`,
  dirty: () => 'git status --short',
  unpushed: () => 'git push',
  stash: () => 'git stash show -p stash@{0}',
  'no-git': () => 'git init',
  behind: () => 'git pull --ff-only',
}

/** The command behind an action. The client only names the action; nothing it sends is run as-is. */
function command(n: Node, what: string, arg: unknown): { cmd?: string; run: boolean; title: string } {
  if (what === 'shell') return { run: false, title: n.name }
  if (what === 'resume') {
    const ok = n.agents.claude.some(k => snap!.claude[k].sessions.some(s => s.id === arg))
    return { cmd: `claude --resume ${shq(need(ok && String(arg), 'Unknown session'))}`, run: true, title: `${n.name} · claude` }
  }
  if (what === 'fix') {
    need(typeof arg === 'string' && FIX[arg] && n.issues.some(i => i.code === arg), 'Nothing to fix')
    return { cmd: FIX[arg as string](n), run: false, title: n.name }
  }
  if (what === 'script') {
    const s = need(n.stack?.scripts.find(x => x.name === arg), 'Unknown script')
    const pm = n.stack!.packageManager ?? 'npm'
    return { cmd: pm === 'npm' ? `npm run ${shq(s.name)}` : `${pm} ${shq(s.name)}`, run: true, title: `${n.name} · ${s.name}` }
  }
  if (what === 'summary')
    return {
      cmd: `claude ${shq(`Read this project (README, package files, recent commits) and write a two-sentence summary of what it is and its current state. Save it under a "## Summary" heading in ${SIDECAR}, creating the file if needed. Change nothing else.`)}`,
      run: true,
      title: `${n.name} · summary`,
    }
  throw new Bad('Unknown action')
}

function node(id: unknown): Node {
  return need(typeof id === 'string' && snap?.nodes[id], 'That folder is not in the last scan. Rescan and try again.')
}

/** Re-read what laci and the user edit (sidecar and task files) without a full rescan. */
async function refresh(n: Node) {
  const t = await readTasks(n.path)
  n.meta = t.meta
  n.tasks = t.tasks
  n.taskFiles = t.files
  n.notes = t.notes
  if (t.summary) n.summary = { text: t.summary, source: SIDECAR }
  n.status = autoStatus(n)
  n.issues = issuesFor(n, snap!.claude)
  return n
}

function taskFile(n: Node, file: unknown) {
  need(typeof file === 'string' && (file === SIDECAR || n.taskFiles.some(f => f.file === file)), 'Unknown task file')
  const p = path.resolve(n.path, file as string)
  need(within(p, n.path), 'Unknown task file')
  return p
}

const api: Record<string, (body: any) => Promise<unknown>> = {
  async snapshot() {
    return scanning
  },
  async rescan() {
    return exclusive(() => rescan())
  },
  async meta({ id, key, value }) {
    const n = node(id)
    need(META_RULES[key]?.test(String(value ?? '')), `Invalid ${key}`)
    await setMeta(n.path, key, value || undefined)
    return refresh(n)
  },
  async todo({ id, op, text, file, line, done }) {
    const n = node(id)
    if (op === 'add') await addNext(n.path, need(typeof text === 'string' && text.trim().slice(0, 300), 'Write something first'))
    else if (op === 'toggle') await toggleCheck(taskFile(n, file), Number(line), String(text), !!done)
    else if (op === 'delete') {
      need(file === SIDECAR, 'Only items in .laci.md can be deleted here')
      await deleteCheck(taskFile(n, file), Number(line), String(text))
    } else throw new Bad('Unknown to-do operation')
    return refresh(n)
  },
  async notes({ id, text }) {
    const n = node(id)
    await setNotes(n.path, String(text ?? '').slice(0, 20000))
    return refresh(n)
  },
  /** Open something outside laci: the editor, the file manager, or an external terminal. */
  async open({ id, what, arg }) {
    const n = node(id)
    if (what === 'editor') detach(EDITOR, [n.path], n.path)
    else if (what === 'files') detach(FILES, [n.path], n.path)
    else {
      const c = command(n, what === 'terminal' ? 'shell' : what, arg)
      terminal(n.path, c.cmd, !!c.cmd && !c.run)
    }
    return { ok: true }
  },
  async 'term/open'({ id, what, arg }) {
    if (!id) return term.open(snap?.home ?? process.env.HOME ?? '/', '~')
    const n = node(id)
    const c = command(n, String(what ?? 'shell'), arg)
    return term.open(n.path, c.title, c.cmd, c.run)
  },
  async 'term/list'() {
    return term.list()
  },
  async 'term/input'({ id, data }) {
    term.input(id, data)
    return {}
  },
  async 'term/resize'({ id, cols, rows }) {
    term.resize(id, cols, rows)
    return {}
  },
  async 'term/close'({ id }) {
    term.close(id)
    return {}
  },
  async archive({ id, trashHeavy }) {
    return exclusive(async () => {
      const journal = await archiveProject(snap!, node(id).id, { trashHeavy: !!trashHeavy })
      return { journal, snapshot: await rescan() }
    })
  },
  async apply({ id }) {
    return exclusive(async () => {
      const p = need(snap!.proposals.find(x => x.id === id), 'That suggestion is gone after the last scan')
      const journal = await applyAction(snap!, p.title, need(p.action, 'Nothing to apply here; open the folders and decide'))
      return { journal, snapshot: await rescan() }
    })
  },
  async journal() {
    return journals()
  },
  async undo({ id }) {
    return exclusive(async () => {
      const journal = await undo(need(typeof id === 'string' && id, 'Unknown change'))
      return { journal, snapshot: await rescan() }
    })
  },
  async backup() {
    const r = await backupHistory()
    return { ...r, dest: tilde(r.dest), size: bytes(r.bytes) }
  },
}

async function page() {
  const html = await fs.readFile(path.join(ROOT, 'prototype', 'app.html'), 'utf8')
  return html.replace('/*__SNAPSHOT__*/null;', `null; window.LACI = ${JSON.stringify({ token: TOKEN })};`)
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body))
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host ?? ''
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'Forbidden host' })
  const url = new URL(req.url ?? '/', `http://${host}`)
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await page(), 'text/html')
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { app: 'laci' })
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      const rel = VENDOR[url.pathname.slice(8)]
      if (!rel) return send(res, 404, { error: 'Not found' })
      const type = rel.endsWith('.css') ? 'text/css' : 'text/javascript'
      return send(res, 200, await fs.readFile(path.join(ROOT, 'node_modules', rel), 'utf8'), type)
    }
    if (req.method === 'GET' && url.pathname === '/api/term/stream') {
      // EventSource can't send headers, so the token comes in the query string here.
      if (url.searchParams.get('token') !== TOKEN) return send(res, 403, { error: 'Missing token' })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      const stop = term.watch(url.searchParams.get('id'), e => res.write(`data: ${JSON.stringify(e)}\n\n`))
      req.on('close', stop)
      return
    }
    const name = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : ''
    if (!api[name]) return send(res, 404, { error: 'Not found' })
    if (req.headers['x-laci-token'] !== TOKEN) return send(res, 403, { error: 'Missing token. Reload the window.' })
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 1e6) throw new Bad('Request too large')
    }
    const body = raw ? JSON.parse(raw) : {}
    send(res, 200, await api[name](body))
  } catch (e) {
    const err = e as Error
    if (!(err instanceof Bad)) console.error(`[laci] ${url.pathname}:`, err)
    send(res, err instanceof Bad ? 400 : 500, { error: err.message })
  }
})

function openWindow(url: string) {
  const onPath = (bin: string) => (process.env.PATH ?? '').split(':').some(d => existsSync(path.join(d, bin)))
  // Chromium's app mode gives a plain window without tabs or an address bar.
  const browser = ['chromium', 'google-chrome-stable', 'google-chrome', 'brave'].find(onPath)
  if (browser) detach(browser, [`--app=${url}`, '--class=laci'], process.env.HOME ?? '/')
  else detach('xdg-open', [url], process.env.HOME ?? '/')
}

const url = `http://127.0.0.1:${PORT}/`
server.on('error', async (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e
  const other = await fetch(`${url}health`).then(r => r.json()).catch(() => null)
  if (other?.app === 'laci') {
    console.log(`laci is already running at ${url}`)
    if (process.argv.includes('--open')) openWindow(url)
    process.exit(0)
  }
  console.error(`Port ${PORT} is taken by something else. Set LACI_PORT to use another one.`)
  process.exit(1)
})
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    term.closeAll()
    process.exit(0)
  })

server.listen(PORT, '127.0.0.1', () => {
  console.log(`laci running at ${url} (scanning…)`)
  rescan().then(
    s => console.log(`scanned ${Object.values(s.nodes).filter(n => n.kind === 'project').length} projects in ${(s.tookMs / 1000).toFixed(1)}s`),
    e => console.error('[laci] scan failed:', e),
  )
  if (process.argv.includes('--open')) openWindow(url)
})
