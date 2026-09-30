// Runs the move/archive engine against a throwaway HOME. Nothing here touches the real home directory.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const home = mkdtempSync(path.join(os.tmpdir(), 'laci-home-'))
process.env.HOME = home
delete process.env.XDG_CONFIG_HOME // config must come from the throwaway HOME, never the real one
delete process.env.XDG_CACHE_HOME
const { scan } = await import('../src/core/scan.ts')
const { archiveProject, applyAction, undo, moveProject } = await import('../src/core/ops.ts')
const { setMeta, addNext, setNotes, toggleCheck } = await import('../src/core/sidecar.ts')
const { readTasks } = await import('../src/core/tasks.ts')
const { enc } = await import('../src/core/util.ts')

const P = (...p: string[]) => path.join(home, ...p)
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
const line = (o: object) => JSON.stringify(o) + '\n'

function repo(dir: string, remote?: string) {
  put(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), scripts: { dev: 'vite' }, dependencies: { next: '1' } }))
  put(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n\nA test project.\n`)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  if (remote) git(dir, 'remote', 'add', 'origin', remote)
}

/** Hash every file under HOME except laci's own data and cache, to prove undo restores bytes exactly. */
function fingerprint() {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (p.startsWith(P('.local', 'share', 'laci')) || p.startsWith(P('.cache', 'laci'))) continue
      if (e.isDirectory()) walk(p)
      else out[path.relative(home, p)] = createHash('sha1').update(readFileSync(p)).digest('hex')
    }
  }
  walk(home)
  return out
}

const changed = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).map(k => `${k}: ${a[k] ? (b[k] ? 'modified' : 'missing') : 'added'}`)

const alpha = P('project', 'alpha')
const gammaNow = P('project', '_archive', 'gamma')
const alphaDir = P('.claude', 'projects', enc(alpha))
const gammaDir = P('.claude', 'projects', enc(P('project', 'gamma')))
const codexFile = P('.codex', 'sessions', '2026', '09', '01', 'rollout-a.jsonl')
const sha = (p: string) => createHash('sha256').update(p).digest('hex')
const geminiDir = P('.gemini', 'tmp', sha(alpha))
// A connector the user added: pretty-printed JSON logs whose folder is in `workdir`.
const customLog = P('.mytool', 'logs', 'run1.json')

repo(alpha, 'git@github.com:me/alpha.git')
repo(P('project', 'beta'))
repo(gammaNow)
put(P('project', 'beta', 'NOTES.md'), '# Beta\n\n## Masih terbuka\n- [ ] rotate the root password\n- [x] add swap\n')
put(path.join(alphaDir, 's1.jsonl'),
  line({ type: 'user', cwd: alpha, sessionId: 's1', message: { content: `work in ${alpha}` } }) +
  line({ type: 'user', cwd: path.join(alpha, 'src'), sessionId: 's1' }) +
  line({ type: 'user', cwd: P('project', 'alpha-old'), sessionId: 's1' }) +
  line({ type: 'user', cwd: P('project', 'alphabet'), sessionId: 's1' }) +
  line({ type: 'ai-title', aiTitle: 'Alpha work', sessionId: 's1' }))
put(path.join(alphaDir, 's0.jsonl'), line({ type: 'user', cwd: P('project', 'alpha-old'), sessionId: 's0' }) + line({ type: 'user', cwd: P('project', 'alpha-old', 'lib'), sessionId: 's0' }))
put(path.join(alphaDir, 's1', 'subagents', 'a.jsonl'), line({ type: 'user', cwd: alpha }))
put(path.join(alphaDir, 'memory', 'MEMORY.md'), '- alpha facts\n')
put(path.join(gammaDir, 's2.jsonl'), line({ type: 'user', cwd: P('project', 'gamma'), sessionId: 's2' }))
put(path.join(gammaDir, 'memory', 'MEMORY.md'), '- gamma facts\n')
put(codexFile, line({ type: 'session_meta', payload: { cwd: alpha, timestamp: '2026-09-01T00:00:00Z' } }) + line({ type: 'turn_context', payload: { cwd: alpha } }))
put(path.join(geminiDir, 'chats', 'session-1.json'), '{"messages":[]}\n')
put(customLog, JSON.stringify({ workdir: alpha, steps: [{ workdir: path.join(alpha, 'src') }, { workdir: P('project', 'alphabet') }] }, null, 2))
put(P('.config', 'laci', 'config.json'), JSON.stringify({ custom: [{ id: 'custom-mytool', name: 'My tool', link: { kind: 'cwd', dir: '~/.mytool/logs', ext: '.json', field: 'workdir' } }] }))

test('scan links sessions, flags the orphan and proposes a reconnect', async () => {
  const snap = await scan({ roots: [P('project')] })
  assert.equal(snap.claude[enc(alpha)].path, alpha)
  assert.deepEqual(snap.nodes[alpha].agents.claude, [enc(alpha)])
  const linked = snap.nodes[alpha].agents.items.map(i => snap.items[i].connector).sort()
  assert.deepEqual(linked, ['codex', 'custom-mytool', 'gemini'])
  // The plan shown before an archive must list every connector's change, not only Claude's.
  const labels = snap.nodes[alpha].archivePlan!.ops.map(o => o.label)
  for (const l of ['Rewrite paths in Codex logs', 'Rewrite paths in My tool logs', 'Move Gemini CLI history']) assert.ok(labels.includes(l), `plan is missing "${l}"`)
  assert.deepEqual(snap.orphans.claude, [enc(P('project', 'gamma'))])
  const rc = snap.proposals.find(p => p.category === 'reconnect')!
  assert.equal(rc.confidence, 'high')
  assert.equal(rc.nodeId, gammaNow)
  assert.equal(snap.nodes[P('project', 'beta')].tasks.filter(t => !t.done).length, 1)
  assert.ok(snap.nodes[P('project', 'beta')].issues.some(i => i.code === 'no-remote'))
})

test('archive moves the folder and its agent history, and undo restores every byte', async () => {
  const before = fingerprint()
  const snap = await scan({ roots: [P('project')] })
  const j = await archiveProject(snap, alpha)
  assert.equal(j.state, 'applied')

  const dest = P('project', '_archive', 'alpha')
  const newDir = P('.claude', 'projects', enc(dest))
  assert.ok(existsSync(path.join(dest, 'package.json')))
  assert.ok(!existsSync(alpha))
  assert.ok(!existsSync(alphaDir))
  assert.ok(existsSync(path.join(newDir, 'memory', 'MEMORY.md')))
  const log = readFileSync(path.join(newDir, 's1.jsonl'), 'utf8')
  assert.ok(log.includes(`"cwd":"${dest}"`))
  assert.ok(log.includes(`"cwd":"${dest}/src"`))
  const old = readFileSync(path.join(newDir, 's0.jsonl'), 'utf8')
  assert.ok(old.includes(`"cwd":"${dest}"`) && old.includes(`"cwd":"${dest}/lib"`), 'paths left by an earlier move are fixed too')
  assert.ok(!log.includes(`"cwd":"${P('project', 'alpha-old')}"`), 'every line under a former location moves with it')
  assert.ok(log.includes(`"cwd":"${P('project', 'alphabet')}"`), 'a deleted folder the session only cd-ed into keeps its real path')
  assert.ok(log.includes(`work in ${alpha}`), 'message text is not rewritten, only cwd fields')
  assert.ok(readFileSync(path.join(newDir, 's1', 'subagents', 'a.jsonl'), 'utf8').includes(`"cwd":"${dest}"`))
  assert.equal(readFileSync(codexFile, 'utf8').split(`"cwd":"${dest}"`).length - 1, 2)
  assert.ok(!existsSync(geminiDir) && existsSync(path.join(P('.gemini', 'tmp', sha(dest)), 'chats', 'session-1.json')), 'hashed store folder is renamed for the new path')
  const custom = JSON.parse(readFileSync(customLog, 'utf8'))
  assert.equal(custom.workdir, dest)
  assert.equal(custom.steps[0].workdir, path.join(dest, 'src'))
  assert.equal(custom.steps[1].workdir, P('project', 'alphabet'), 'a sibling with a shared prefix is left alone')
  assert.match(readFileSync(path.join(dest, '.laci.md'), 'utf8'), /status: archived/)
  assert.match(readFileSync(path.join(dest, '.git', 'info', 'exclude'), 'utf8'), /^\.laci\.md$/m)

  await undo(j.id)
  assert.deepEqual(changed(before, fingerprint()), [])
})

test('reconnecting an orphan moves it to the new address and can be undone', async () => {
  const before = fingerprint()
  const snap = await scan({ roots: [P('project')] })
  const p = snap.proposals.find(x => x.category === 'reconnect')!
  const j = await applyAction(snap, p.title, p.action!)
  const target = P('.claude', 'projects', enc(gammaNow))
  assert.ok(existsSync(path.join(target, 'memory', 'MEMORY.md')))
  assert.ok(readFileSync(path.join(target, 's2.jsonl'), 'utf8').includes(`"cwd":"${gammaNow}"`))
  const after = await scan({ roots: [P('project')] })
  assert.deepEqual(after.orphans.claude, [])
  assert.deepEqual(after.nodes[gammaNow].agents.claude, [enc(gammaNow)])
  await undo(j.id)
  assert.deepEqual(changed(before, fingerprint()), [])
})

test('a folder in use by a running process is not moved', async () => {
  const snap = await scan({ roots: [P('project')] })
  const beta = P('project', 'beta')
  const child = spawn('sleep', ['5'], { cwd: beta })
  try {
    await new Promise(r => setTimeout(r, 100))
    await assert.rejects(moveProject(snap, beta, P('project', 'beta2')), /In use by sleep/)
    assert.ok(existsSync(beta))
  } finally {
    child.kill()
  }
})

test('sidecar edits round-trip through the parser', async () => {
  const beta = P('project', 'beta')
  await setMeta(beta, 'priority', 'high')
  await setMeta(beta, 'deadline', '2026-10-15')
  await addNext(beta, 'ship the landing page')
  await setNotes(beta, 'Client wants dark mode.\nAsk about hosting.')
  let t = await readTasks(beta)
  assert.equal(t.meta.priority, 'high')
  assert.equal(t.meta.deadline, '2026-10-15')
  assert.equal(t.notes, 'Client wants dark mode.\nAsk about hosting.')
  const item = t.tasks.find(x => x.file === '.laci.md')!
  assert.equal(item.text, 'ship the landing page')
  await toggleCheck(path.join(beta, item.file), item.line, item.text, true)
  await setMeta(beta, 'priority', undefined)
  t = await readTasks(beta)
  assert.equal(t.meta.priority, undefined)
  assert.equal(t.tasks.find(x => x.file === '.laci.md')!.done, true)
  const other = t.tasks.find(x => x.file === 'NOTES.md' && !x.done)!
  await toggleCheck(path.join(beta, 'NOTES.md'), other.line + 5, other.text, true)
  assert.match(readFileSync(path.join(beta, 'NOTES.md'), 'utf8'), /- \[x\] rotate the root password/)
  assert.match(readFileSync(path.join(beta, '.git', 'info', 'exclude'), 'utf8'), /^\.laci\.md$/m)
  assert.ok(statSync(path.join(beta, '.laci.md')).isFile())
})
