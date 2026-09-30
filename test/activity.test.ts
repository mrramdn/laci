// The Log's Undo writes files from what the log says. It must only reach projects in the home folder,
// and never put back an older change over a newer one.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const home = mkdtempSync(path.join(os.tmpdir(), 'laci-act-'))
process.env.HOME = home
delete process.env.XDG_CONFIG_HOME
const { ACTIVITY, readLog, record, undoActivity } = await import('../src/core/activity.ts')
const { setMeta } = await import('../src/core/sidecar.ts')

const dir = path.join(home, 'project', 'app')
mkdirSync(dir, { recursive: true })
const status = () => readFileSync(path.join(dir, '.laci.md'), 'utf8').match(/status: (\w+)/)?.[1]

test('undo puts a field back, but not over a newer change to it', async () => {
  await setMeta(dir, 'status', 'paused')
  const first = await record({ by: 'app', title: 'paused', path: dir, key: `meta:${dir}:status`, undo: { type: 'meta', key: 'status', value: '' } })
  await setMeta(dir, 'status', 'done')
  const second = await record({ by: 'app', title: 'done', path: dir, key: `meta:${dir}:status`, undo: { type: 'meta', key: 'status', value: 'paused' } })

  await assert.rejects(undoActivity(first.id, 'app'), /changed again/)
  await undoActivity(second.id, 'app')
  assert.equal(status(), 'paused')
  // With the newer change undone, the older one can go back too.
  await undoActivity(first.id, 'app')
  assert.equal(status(), undefined)
  const log = await readLog()
  assert.deepEqual([first.id, second.id].map(id => log.find(e => e.id === id)?.state), ['undone', 'undone'])
  await assert.rejects(undoActivity(first.id, 'app'), /Already undone/)
})

test('an edited log line cannot point undo outside the home folder', async () => {
  const bad = { id: 'x1', at: new Date().toISOString(), by: 'app', title: 'evil', path: '/tmp', undo: { type: 'notes', text: 'owned' } }
  appendFileSync(ACTIVITY, JSON.stringify(bad) + '\n')
  await assert.rejects(undoActivity('x1', 'app'), /inside your home folder/)
  const escape = { ...bad, id: 'x2', path: dir, undo: { type: 'check', file: '../../../etc/passwd', text: 'a', done: true } }
  appendFileSync(ACTIVITY, JSON.stringify(escape) + '\n')
  await assert.rejects(undoActivity('x2', 'app'), /Unknown task file/)
})
