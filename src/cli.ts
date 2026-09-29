import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Node, Snapshot } from './core/types.ts'
import { scan } from './core/scan.ts'
import { bytes } from './core/tidy.ts'
import { daysSince, tilde } from './core/util.ts'
import { VENDOR } from './vendor.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tty = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = c(2), red = c(31), yellow = c(33), green = c(32), bold = c(1)

const ago = (at?: string) => {
  const d = daysSince(at)
  return d === Infinity ? '—' : d < 1 ? 'today' : d < 2 ? '1d' : d < 60 ? `${Math.floor(d)}d` : `${Math.floor(d / 30)}mo`
}
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))

function table(snap: Snapshot) {
  const projects = Object.values(snap.nodes).filter(n => n.kind === 'project').sort((a, b) => (b.lastActivity?.at ?? '').localeCompare(a.lastActivity?.at ?? ''))
  console.log(bold(`${pad('PROJECT', 34)} ${pad('STATUS', 9)} ${pad('LAST', 6)} ${pad('AI', 6)} ISSUES`))
  for (const n of projects) {
    const sessions = n.agents.claude.reduce((a, k) => a + snap.claude[k].sessions.length, 0) + n.agents.codex.length
    const top = n.issues[0]
    const issue = top ? (top.severity === 'high' ? red : top.severity === 'med' ? yellow : dim)(top.title + (n.issues.length > 1 ? dim(` +${n.issues.length - 1}`) : '')) : green('ok')
    console.log(`${pad(tilde(n.path).replace('~/', ''), 34)} ${pad(n.status.value, 9)} ${pad(ago(n.lastActivity?.at), 6)} ${pad(sessions ? String(sessions) : '', 6)} ${issue}`)
  }
}

function doctor(snap: Snapshot) {
  const rows: [Node, string, string][] = []
  for (const n of Object.values(snap.nodes)) for (const i of n.issues) if (i.severity !== 'low') rows.push([n, i.severity, i.title + (i.detail ? dim(` — ${i.detail}`) : '')])
  rows.sort((a, b) => a[1].localeCompare(b[1]))
  console.log(bold('Needs attention'))
  for (const [n, sev, t] of rows) console.log(`  ${sev === 'high' ? red('●') : yellow('●')} ${pad(n.label, 22)} ${t}`)
  const open = Object.values(snap.nodes).flatMap(n => n.tasks.filter(t => t.kind === 'check' && !t.done).map(t => [n, t] as const))
  if (open.length) {
    console.log(bold('\nOpen checkboxes'))
    for (const [n, t] of open) console.log(`  ☐ ${pad(n.label, 22)} ${t.text.slice(0, 90)} ${dim(t.file)}`)
  }
  console.log(bold(`\nTidy-up proposals: ${snap.proposals.length}`))
  for (const p of snap.proposals) console.log(`  → ${p.title} ${dim(`(${p.category}, ${p.confidence})`)}`)
}

async function proto(snap: Snapshot) {
  const tpl = await fs.readFile(path.join(ROOT, 'prototype', 'app.html'), 'utf8')
  // Escape `<` so README text can never close the script tag it's embedded in.
  const json = JSON.stringify(snap).replace(/</g, '\\u003c')
  const out = path.join(ROOT, 'prototype', 'dist', 'index.html')
  await fs.mkdir(path.join(path.dirname(out), 'vendor'), { recursive: true })
  for (const [name, rel] of Object.entries(VENDOR)) await fs.copyFile(path.join(ROOT, 'node_modules', rel), path.join(path.dirname(out), 'vendor', name))
  await fs.writeFile(out, tpl.replace('/*__SNAPSHOT__*/null', json))
  return out
}

const [cmd = 'ls', ...args] = process.argv.slice(2)
const snap = await scan()
const summary = dim(`${Object.values(snap.nodes).filter(n => n.kind === 'project').length} projects · ${Object.keys(snap.claude).length} Claude dirs · ${Object.keys(snap.codex).length} Codex sessions · ${snap.tookMs}ms`)

if (cmd === 'json') {
  const out = args[0] ?? path.join(ROOT, 'prototype', 'dist', 'snapshot.json')
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, JSON.stringify(snap, null, 2))
  console.log(`wrote ${out} (${bytes((await fs.stat(out)).size)})`)
} else if (cmd === 'doctor') doctor(snap)
else if (cmd === 'proto') console.log(`prototype: ${await proto(snap)}`)
else table(snap)
console.log(summary)
