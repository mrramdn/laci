// The terminal API runs commands on this machine, so any page on the web must not be able to reach it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const port = 4900 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${port}`
const home = mkdtempSync(path.join(os.tmpdir(), 'laci-srv-'))
let server: ReturnType<typeof spawn>

before(async () => {
  server = spawn(process.execPath, [path.resolve('src/server.ts')], { env: { ...process.env, HOME: home, LACI_PORT: String(port) }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/health`).then(r => r.ok, () => false)) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('server did not start')
})
after(() => server.kill())

const post = (p: string, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })

test('API calls without the page token are refused', async () => {
  for (const p of ['/api/term/open', '/api/term/input', '/api/open', '/api/archive', '/api/apply'])
    assert.equal((await post(p)).status, 403, p)
  assert.equal((await post('/api/term/open', { 'x-laci-token': 'guess' })).status, 403)
  assert.equal((await fetch(`${base}/api/term/stream?id=x`)).status, 403)
})

test('requests under another Host name are refused (DNS rebinding)', async () => {
  const status = await new Promise<number>(resolve =>
    http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } }, r => resolve(r.statusCode ?? 0)),
  )
  assert.equal(status, 403)
})

test('the page served to the app carries a token that works', async () => {
  const html = await (await fetch(`${base}/`)).text()
  const token = html.match(/"token":"([^"]+)"/)?.[1]
  assert.ok(token)
  const r = await post('/api/term/list', { 'x-laci-token': token! })
  assert.equal(r.status, 200)
})
