import path from 'node:path'
import type { Meta, Task, TaskFile } from './types.ts'
import { iso, list, readText, stat } from './util.ts'
import { stripMd } from './readme.ts'
import { SIDECAR, section } from './sidecar.ts'

const TASK_FILE = /^(\.laci|handoff[\w.-]*|todo[\w.-]*|tasks|notes?[\w.-]*|next)\.md$/i
const NESTED = ['tasks/todo.md', 'docs/TODO.md', 'docs/todo.md']
const TODO_HEADING = /\b(todo|to-do|next( steps)?|masih terbuka|open( items)?|pending|leftovers?|sisa|belum|lanjut|after submitting)\b/i

export function parseMeta(text: string | undefined): Meta {
  const fm = text?.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return {}
  const meta: Record<string, any> = {}
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*?)\s*(#.*)?$/)
    if (!m || !m[2]) continue
    const v = m[2]
    meta[m[1]] = v.startsWith('[') ? v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean) : v.replace(/^["']|["']$/g, '')
  }
  return meta
}

function parseTasks(text: string, file: string): Task[] {
  const out: Task[] = []
  const lines = text.split('\n')
  const headings: { level: number; text: string }[] = []
  // Plain list items only count inside a TODO-ish section, and only in handoff/todo files.
  const proseAllowed = /handoff|todo|next/i.test(file)
  let todoLevel = 0
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.trimStart().startsWith('```')) inCode = !inCode
    if (inCode) continue
    const h = l.match(/^(#{1,6})\s+(.+)/)
    if (h) {
      const level = h[1].length
      while (headings.length && headings.at(-1)!.level >= level) headings.pop()
      headings.push({ level, text: stripMd(h[2]) })
      if (todoLevel && level <= todoLevel) todoLevel = 0
      if (!todoLevel && TODO_HEADING.test(h[2])) todoLevel = level
      continue
    }
    const section = headings.slice(-2).map(x => x.text).join(' › ') || undefined
    const cb = l.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)/)
    if (cb) {
      const t = stripMd(cb[2])
      if (/[\p{L}\p{N}]/u.test(t)) out.push({ text: t, done: cb[1] !== ' ', kind: 'check', file, line: i + 1, section })
      continue
    }
    if (proseAllowed && todoLevel) {
      const li = l.match(/^\s{0,3}(?:[-*+]|\d+[.)])\s+(.+)/)
      if (li) out.push({ text: stripMd(li[1]).slice(0, 220), done: /✅|\bdone\b/i.test(li[1]), kind: 'list', file, line: i + 1, section })
    }
  }
  return out
}

export async function readTasks(dir: string): Promise<{ meta: Meta; tasks: Task[]; files: TaskFile[]; notes?: string; summary?: string }> {
  const names = (await list(dir)).filter(e => e.isFile() && TASK_FILE.test(e.name)).map(e => e.name)
  for (const n of NESTED) if (await stat(path.join(dir, n))) names.push(n)

  let meta: Meta = {}
  let notes: string | undefined
  let summary: string | undefined
  const tasks: Task[] = []
  const files: TaskFile[] = []
  for (const name of names) {
    const full = path.join(dir, name)
    const text = await readText(full, 128 * 1024)
    if (!text) continue
    if (name === SIDECAR) {
      meta = parseMeta(text)
      notes = section(text, 'Notes')
      summary = section(text, 'Summary')
    }
    const found = parseTasks(text, name)
    if (!found.length) continue
    tasks.push(...found)
    const s = await stat(full)
    files.push({ file: name, at: iso(s!.mtimeMs), open: found.filter(t => !t.done).length, done: found.filter(t => t.done).length })
  }
  return { meta, tasks, files, notes, summary }
}
