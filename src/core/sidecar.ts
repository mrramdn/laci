import { promises as fs } from 'node:fs'
import path from 'node:path'
import { stripMd } from './readme.ts'
import { readText, run } from './util.ts'

/** The file laci owns. Lives in the project folder so it moves with it; kept out of git via .git/info/exclude. */
export const SIDECAR = '.laci.md'

const TEMPLATE = '---\n---\n\n## Next\n\n## Notes\n'

/** Fields laci writes to the frontmatter, and what each accepts. Empty clears the field. */
export const META_RULES: Record<string, RegExp> = {
  status: /^(active|idle|dormant|idea|paused|done|archived)?$/,
  priority: /^(high|medium|low)?$/,
  deadline: /^(\d{4}-\d{2}-\d{2})?$/,
  client: /^[^\n]{0,80}$/,
}
const CHECK = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$/

function split(text: string) {
  const m = text.match(/^---\n([\s\S]*?)\n?---\n?/)
  if (!m) return { fm: [] as string[], body: text }
  return { fm: m[1] ? m[1].split('\n') : [], body: text.slice(m[0].length) }
}

function join(fm: string[], body: string) {
  const lines = fm.filter(l => l.trim())
  return `---\n${lines.length ? lines.join('\n') + '\n' : ''}---\n${body.startsWith('\n') ? body : '\n' + body}`
}

/** [heading index, end index) of a `## Name` section, or undefined. */
function range(lines: string[], name: string): [number, number] | undefined {
  const start = lines.findIndex(l => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(l))
  if (start < 0) return
  let end = start + 1
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++
  return [start, end]
}

export function section(text: string | undefined, name: string) {
  if (!text) return undefined
  const lines = split(text).body.split('\n')
  const r = range(lines, name)
  return r ? lines.slice(r[0] + 1, r[1]).join('\n').trim() || undefined : undefined
}

async function writeAtomic(file: string, text: string) {
  const tmp = `${file}.laci-tmp`
  await fs.writeFile(tmp, text)
  await fs.rename(tmp, file)
}

async function edit(dir: string, fn: (text: string) => string) {
  const file = path.join(dir, SIDECAR)
  const before = (await readText(file, 1024 * 1024)) ?? TEMPLATE
  await writeAtomic(file, fn(before))
  await ensureExcluded(dir)
}

export async function excludeFile(dir: string) {
  const r = await run('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude'])
  return r.ok && r.out ? path.resolve(dir, r.out) : undefined
}

/** Add `.laci.md` to the repo's local exclude list (not .gitignore), so it never gets committed. */
export async function ensureExcluded(dir: string) {
  const file = await excludeFile(dir)
  if (!file) return
  const cur = (await readText(file)) ?? ''
  if (cur.split('\n').some(l => l.trim() === SIDECAR)) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${SIDECAR}\n`)
}

export function setMeta(dir: string, key: string, value: string | undefined) {
  return edit(dir, text => {
    const { fm, body } = split(text)
    const i = fm.findIndex(l => l.startsWith(key + ':'))
    if (value === undefined || value === '') {
      if (i >= 0) fm.splice(i, 1)
    } else if (i >= 0) fm[i] = `${key}: ${value}`
    else fm.push(`${key}: ${value}`)
    return join(fm, body)
  })
}

export function addNext(dir: string, item: string) {
  return edit(dir, text => {
    const { fm, body } = split(text)
    const lines = body.split('\n')
    let r = range(lines, 'Next')
    if (!r) {
      lines.unshift('', '## Next', '')
      r = range(lines, 'Next')!
    }
    let at = r[1]
    while (at > r[0] + 1 && !lines[at - 1].trim()) at--
    lines.splice(at, 0, `- [ ] ${item.replace(/\s+/g, ' ').trim()}`)
    return join(fm, lines.join('\n'))
  })
}

export function setNotes(dir: string, notes: string) {
  return edit(dir, text => {
    const { fm, body } = split(text)
    const lines = body.split('\n')
    const r = range(lines, 'Notes')
    const content = notes.trim() ? ['', ...notes.trimEnd().split('\n'), ''] : ['']
    if (r) lines.splice(r[0] + 1, r[1] - r[0] - 1, ...content)
    else lines.push('## Notes', ...content)
    return join(fm, lines.join('\n'))
  })
}

/** Find the checkbox line: trust `line` only if its text still matches, else search by text. */
function locate(lines: string[], line: number, text: string) {
  const same = (l: string) => {
    const m = l.match(CHECK)
    return !!m && stripMd(m[4]) === text
  }
  if (same(lines[line - 1] ?? '')) return line - 1
  const i = lines.findIndex(same)
  if (i < 0) throw new Error(`Couldn't find "${text.slice(0, 60)}" anymore. Rescan and try again.`)
  return i
}

export async function toggleCheck(file: string, line: number, text: string, done: boolean) {
  const src = await fs.readFile(file, 'utf8')
  const lines = src.split('\n')
  const i = locate(lines, line, text)
  lines[i] = lines[i].replace(CHECK, (_, a, _x, b, t) => `${a}${done ? 'x' : ' '}${b}${t}`)
  await writeAtomic(file, lines.join('\n'))
}

export async function deleteCheck(file: string, line: number, text: string) {
  const lines = (await fs.readFile(file, 'utf8')).split('\n')
  lines.splice(locate(lines, line, text), 1)
  await writeAtomic(file, lines.join('\n'))
}
