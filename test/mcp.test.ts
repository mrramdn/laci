// Agents can move folders through MCP, so the confirm step and the destination rule must hold.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const home = mkdtempSync(path.join(os.tmpdir(), 'laci-mcp-'))
execFileSync(process.execPath, ['scripts/sandbox.ts', home])
const client = new Client({ name: 'laci-test', version: '0' })

before(async () => {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp.ts'], env: { ...process.env, HOME: home } as Record<string, string>, stderr: 'ignore' }))
})
after(() => client.close())

async function call(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args })
  return { text: r.content.map((c: any) => c.text).join('\n') as string, error: !!r.isError }
}

const alpha = path.join(home, 'project', 'alpha')
const dest = path.join(home, 'project', 'clients', 'alpha')

test('a move without confirm only returns the plan', async () => {
  const r = await call('move_project', { project: 'alpha', destination: '~/project/clients/alpha' })
  assert.equal(r.error, false)
  assert.match(r.text, /Nothing has changed yet/)
  assert.match(r.text, /Move Claude sessions \+ memory/)
  assert.ok(existsSync(alpha) && !existsSync(dest))
})

test('destinations outside the home folder are refused', async () => {
  const r = await call('move_project', { project: 'alpha', destination: '/tmp/somewhere-else', confirm: true })
  assert.equal(r.error, true)
  assert.match(r.text, /inside your home folder/)
  assert.ok(existsSync(alpha))
})

test('a confirmed move carries the session along, and undo_change restores it', async () => {
  const r = await call('move_project', { project: 'alpha', destination: '~/project/clients/alpha', confirm: true })
  assert.equal(r.error, false, r.text)
  const id = r.text.match(/id "([^"]+)"/)![1]
  const moved = path.join(home, '.claude', 'projects', dest.replace(/[^A-Za-z0-9]/g, '-'), 's1.jsonl')
  assert.ok(readFileSync(moved, 'utf8').includes(`"cwd":"${dest}"`))
  assert.equal((await call('undo_change', { id })).error, false)
  assert.ok(existsSync(alpha) && !existsSync(dest))
})
