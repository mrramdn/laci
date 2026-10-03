// Frozen compatibility probe for the v1 journal algorithm (src/core/ops.ts).
// Runs only in a temporary HOME; does not import the Electron/TypeScript runtime.
import { promises as fs } from 'node:fs'
import path from 'node:path'
const home = process.env.HOME
const data = path.join(home, '.local/share/laci')
const exists = async p => !!await fs.stat(p).catch(() => undefined)
async function rename(from, to) {
  try { await fs.rename(from, to) }
  catch (e) {
    if (e.code !== 'EXDEV') throw e
    await fs.cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
    await fs.rm(from, { recursive: true })
  }
}
async function undoEntries(entries) {
  for (const e of [...entries].reverse()) {
    if (e.kind === 'move' && e.from && e.to) {
      if (await exists(e.to)) {
        await fs.mkdir(path.dirname(e.from), { recursive: true })
        await rename(e.to, e.from)
      }
    } else if (e.kind === 'rewrite' && e.path && e.backup) {
      if (await exists(e.backup)) await rename(e.backup, e.path)
    } else if (e.kind === 'mkdir' && e.path) {
      await fs.rmdir(e.path).catch(() => {})
    } else if (e.kind === 'rmdir' && e.path) {
      await fs.mkdir(e.path, { recursive: true })
    } else if (e.kind === 'file' && e.path) {
      if (e.existed && e.backup) await fs.copyFile(e.backup, e.path)
      else await fs.rm(e.path, { force: true })
    }
  }
}
const [mode, idOrFrom, to, store, target] = process.argv.slice(2)
await fs.mkdir(path.join(data, 'journal'), { recursive: true })
if (mode === 'undo') {
  const file = path.join(data, 'journal', `${path.basename(idOrFrom)}.json`)
  const j = JSON.parse(await fs.readFile(file, 'utf8'))
  if (j.state !== 'applied') throw Error(`This change is ${j.state}, nothing to undo`)
  await undoEntries(j.entries)
  j.state = 'undone'
  await fs.writeFile(file, JSON.stringify(j, null, 2))
  console.log(JSON.stringify(j))
} else if (mode === 'move') {
  const at = new Date().toISOString()
  const id = at.replace(/[:.]/g, '-') + '-v1'
  const j = { id, at, title: 'Move from v1', state: 'running', entries: [] }
  const file = path.join(data, 'journal', `${id}.json`)
  const log = async e => { j.entries.push(e); await fs.writeFile(file, JSON.stringify(j, null, 2)) }
  const move = async (from, to) => {
    const missing = []
    for (let d = path.dirname(to); !(await exists(d)); d = path.dirname(d)) missing.unshift(d)
    for (const d of missing) { await fs.mkdir(d); await log({ kind: 'mkdir', path: d }) }
    await log({ kind: 'move', from, to }); await rename(from, to)
  }
  await move(idOrFrom, to)
  await move(store, target)
  const f = path.join(target, 'session.jsonl')
  const text = await fs.readFile(f, 'utf8')
  const backup = path.join(data, 'backup', id, '1-session.jsonl')
  await fs.mkdir(path.dirname(backup), { recursive: true })
  const was = await fs.stat(f)
  const tmp = `${f}.laci-tmp`
  await fs.writeFile(tmp, text.replaceAll(idOrFrom, to))
  await fs.utimes(tmp, was.atimeMs / 1000, was.mtimeMs / 1000)
  await log({ kind: 'rewrite', path: f, backup })
  await rename(f, backup); await fs.rename(tmp, f)
  j.state = 'applied'; await fs.writeFile(file, JSON.stringify(j, null, 2))
  console.log(JSON.stringify(j))
} else { throw Error('Unknown compatibility mode') }
