// Keeps the app current without "Scan again": watches the scanned folders, each project's files and
// git state, the agent logs, and the folders open in the app, then refreshes only what changed.
import { type FSWatcher, watch } from 'node:fs'
import path from 'node:path'
import type { Snapshot } from './core/types.ts'
import { CODE_MARKERS, DOC_FILE } from './core/detect.ts'
import { log } from './core/log.ts'
import { DATA, HEAVY, list, stat, within } from './core/util.ts'

export interface Hooks {
  /** The latest snapshot, updated in place by the refreshes below. */
  snap(): Snapshot | undefined
  /** A full rescan (folders appeared or went away). Resolves when done, after the app was told. */
  rescan(): Promise<unknown>
  /** Re-attach agent logs, then tell the app. */
  relink(): Promise<unknown>
  /** Re-read these projects (id -> newest change seen, in ms), then tell the app. */
  refresh(projects: Map<string, number>): Promise<unknown>
  /** Something the app shows directly changed: a listed folder, or the Log. */
  notify(event: { type: 'ls'; path: string } | { type: 'log' }): void
}

type Role = 'structure' | 'agents' | 'data' | 'ls' | `p:${string}` | `g:${string}`

// Budgets keep a huge tree from eating the system's inotify watches (shared with editors and the like).
const MAX_WATCHES = 12000
const PER_PROJECT = 1500
const LISTED = 24
/** Editors' swap and temp files, and laci's own atomic-write temp files. */
const NOISE = /(\.laci-tmp|\.swp|\.swx|\.tmp|~|^4913|^\.#.*)$/
const AGENTS_EVERY = 8000
const PROJECT_EVERY = 3000

export class Watcher {
  private dirs = new Map<string, { w: FSWatcher; roles: Set<Role> }>()
  private listed: string[] = []
  private full = 0
  private agents = 0
  private projects = new Map<string, number>()
  private lastAgents = 0
  private lastProject = new Map<string, number>()
  private lastFull = 0
  private timer: NodeJS.Timeout | undefined
  private running = false
  private warned = false
  private later = new Map<string, NodeJS.Timeout>()

  private hooks: Hooks
  constructor(hooks: Hooks) {
    this.hooks = hooks
  }

  /** Call when a full scan starts: events from before it are covered by it. */
  scanStarted() {
    this.lastFull = Date.now()
  }

  /** After a full scan: watch what's in it now, and stop watching what's gone. */
  async sync(snap: Snapshot) {
    const want = new Map<string, Set<Role>>()
    const add = (dir: string, role: Role) => {
      if (want.size >= MAX_WATCHES && !want.has(dir)) return false
      want.set(dir, (want.get(dir) ?? new Set()).add(role))
      return true
    }
    const nodes = Object.values(snap.nodes)
    const projects = nodes.filter(n => n.kind === 'project')

    // Where projects can appear: the roots and every folder a scan walks through to find them.
    const inProject = (p: string) => projects.some(n => within(p, n.path))
    for (const root of snap.roots) await this.walk(root, 6, d => !inProject(d) && add(d, 'structure'))
    for (const n of nodes) if (n.kind === 'folder') add(n.path, 'structure')

    for (const n of projects) {
      const id = n.id
      // Archived projects rarely change: their top folder is enough to notice a move or an edit.
      let budget = n.archived ? 1 : PER_PROJECT
      await this.walk(n.path, n.archived ? 0 : 10, d => budget-- > 0 && add(d, `p:${id}`))
      const git = path.join(n.path, '.git')
      if ((await stat(git))?.isDirectory()) {
        for (const d of [git, path.join(git, 'refs', 'heads')]) add(d, `g:${id}`)
        for (const e of await list(path.join(git, 'refs', 'remotes'))) if (e.isDirectory()) add(path.join(git, 'refs', 'remotes', e.name), `g:${id}`)
      }
    }

    for (const c of snap.connectors) {
      const l = c.link
      if (!('dir' in l)) continue
      // Store folders one level deep hold the logs (Claude, Gemini); dated trees go deeper (Codex).
      await this.walk(l.dir, l.kind === 'cwd' || l.kind === 'mentions' ? 4 : 1, d => add(d, 'agents'), true)
    }
    add(DATA, 'data')
    for (const d of this.listed) add(d, 'ls')

    for (const [dir, cur] of this.dirs) {
      if (want.has(dir)) continue
      cur.w.close()
      this.dirs.delete(dir)
    }
    for (const [dir, roles] of want) {
      const cur = this.dirs.get(dir)
      if (cur) cur.roles = roles
      else this.open(dir, roles)
    }
    log.info(`watching ${this.dirs.size} folders`)
  }

  /** The app listed this folder: keep it current while it's on screen (the last few stay watched). */
  listing(dir: string) {
    this.listed = [dir, ...this.listed.filter(d => d !== dir)].slice(0, LISTED)
    const cur = this.dirs.get(dir)
    if (cur) cur.roles.add('ls')
    else this.open(dir, new Set(['ls']))
    for (const [d, c] of this.dirs) {
      if (!c.roles.has('ls') || this.listed.includes(d)) continue
      c.roles.delete('ls')
      if (!c.roles.size) {
        c.w.close()
        this.dirs.delete(d)
      }
    }
  }

  close() {
    for (const { w } of this.dirs.values()) w.close()
    this.dirs.clear()
    clearTimeout(this.timer)
  }

  private async walk(dir: string, depth: number, visit: (d: string) => boolean | undefined, hidden = false) {
    if (!(await stat(dir))?.isDirectory() || visit(dir) === false || depth <= 0) return
    for (const e of await list(dir)) {
      if (!e.isDirectory() || HEAVY.has(e.name) || (!hidden && e.name.startsWith('.'))) continue
      await this.walk(path.join(dir, e.name), depth - 1, visit, hidden)
    }
  }

  private open(dir: string, roles: Set<Role>) {
    try {
      const w = watch(dir, { persistent: false }, (_type, name) => this.event(dir, name ? String(name) : ''))
      w.on('error', () => {
        w.close()
        this.dirs.delete(dir)
      })
      this.dirs.set(dir, { w, roles })
    } catch (e: any) {
      if (e.code === 'ENOSPC' || e.code === 'EMFILE') {
        if (!this.warned) log.warn(`can't watch more folders (${e.code}); some changes will only show after a rescan`)
        this.warned = true
      }
    }
  }

  private event(dir: string, name: string) {
    const cur = this.dirs.get(dir)
    if (!cur) return
    // In laci's own folder only the activity log matters. The debug log lives there too, and logging
    // its own changes would never stop.
    if (dir === DATA && name !== 'activity.jsonl') return
    const full = name ? path.join(dir, name) : dir
    log.debug(`event ${full} [${[...cur.roles].join(',')}]`)
    for (const role of cur.roles) {
      if (role === 'ls') this.debounce(`ls:${dir}`, 400, () => this.hooks.notify({ type: 'ls', path: dir }))
      else if (role === 'data') this.debounce('log', 500, () => this.hooks.notify({ type: 'log' }))
      else if (role === 'agents') {
        this.agents ||= Date.now()
        this.kick()
        // A new session folder (a project an agent just started in): its logs count from now on.
        if (name && !this.dirs.has(full)) void stat(full).then(s => s?.isDirectory() && !this.dirs.has(full) && this.open(full, new Set<Role>(['agents'])))
      } else if (role === 'structure') void this.structure(full, name)
      else if (role.startsWith('g:')) {
        if (!name.endsWith('.lock')) this.touch(role.slice(2), 0)
      } else if (role.startsWith('p:')) void this.inProject(role.slice(2), dir, full, name)
    }
  }

  /** A folder where projects live changed. Only new or removed folders, and new project markers, matter. */
  private async structure(full: string, name: string) {
    if (!name || NOISE.test(name) || (name.startsWith('.') && name !== '.git')) return
    const snap = this.hooks.snap()
    const s = await stat(full)
    if (snap?.nodes[full] || s?.isDirectory() || name === '.git' || CODE_MARKERS.has(name) || DOC_FILE.test(name)) {
      this.full ||= Date.now()
      this.kick()
    }
  }

  private async inProject(id: string, dir: string, full: string, name: string) {
    if (!name || NOISE.test(name) || HEAVY.has(name)) return
    // `.git` appearing or going away changes what the folder is; everything else is an edit.
    if (name === '.git' && dir === id) {
      this.full ||= Date.now()
      return this.kick()
    }
    // `.laci.md` is re-read (a status or to-do set elsewhere), but editing it isn't activity.
    if (name === '.laci.md') return this.touch(id, 0)
    if (name.startsWith('.')) return
    const s = await stat(full)
    // A new folder inside the project: watch it too, so edits in it count.
    if (s?.isDirectory() && !this.dirs.has(full)) this.open(full, new Set<Role>([`p:${id}`]))
    this.touch(id, s?.mtimeMs ?? Date.now())
  }

  private touch(id: string, ms: number) {
    this.projects.set(id, Math.max(this.projects.get(id) ?? 0, ms))
    this.kick()
  }

  private debounce(key: string, ms: number, fn: () => void) {
    clearTimeout(this.later.get(key))
    this.later.set(
      key,
      setTimeout(() => {
        this.later.delete(key)
        fn()
      }, ms),
    )
  }

  private kick(ms = 1200) {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, ms)
  }

  /** Changes arrive in bursts (a save, a checkout, an agent writing): batch them, then refresh once. */
  private async flush() {
    if (this.running) return this.kick(1000)
    this.running = true
    let again = 0
    try {
      if (this.full) {
        const since = this.full
        this.full = 0
        this.agents = 0
        this.projects.clear()
        // A scan that started after these events already saw them (e.g. the one after a move).
        if (since >= this.lastFull) await this.hooks.rescan()
        return
      }
      const now = Date.now()
      if (this.agents) {
        const wait = this.lastAgents + AGENTS_EVERY - now
        if (wait <= 0) {
          this.agents = 0
          this.lastAgents = now
          await this.hooks.relink()
        } else again = wait
      }
      const due = new Map<string, number>()
      for (const [id, ms] of this.projects) {
        const wait = (this.lastProject.get(id) ?? 0) + PROJECT_EVERY - now
        if (wait > 0) {
          again = again ? Math.min(again, wait) : wait
          continue
        }
        due.set(id, ms)
        this.projects.delete(id)
        this.lastProject.set(id, now)
      }
      if (due.size) await this.hooks.refresh(due)
    } catch (e) {
      log.error('live refresh failed', e)
    } finally {
      this.running = false
      if (this.full || this.agents || this.projects.size) this.kick(Math.max(again, 300))
    }
  }
}
