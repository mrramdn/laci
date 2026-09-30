// Connectors decide what laci reads and what a move renames, so what the Settings form accepts is a safety rule.
import assert from 'node:assert/strict'
import os from 'node:os'
import { test } from 'node:test'

const { checkConnector } = await import('../src/core/config.ts')
const add = (link: object) => () => checkConnector({ name: 'Tool', link }, [])

test('a connector cannot point outside the home folder', () => {
  assert.throws(add({ kind: 'cwd', dir: '/etc', ext: '.json', field: 'cwd' }), /inside your home folder/)
  assert.throws(add({ kind: 'named', dir: '~/../../tmp', naming: 'dashes' }), /inside your home folder/)
  assert.throws(add({ kind: 'mentions', dir: 'relative/dir', ext: '.md' }), /full path/)
})

test('an inside-the-project path cannot climb out of the project', () => {
  for (const p of ['../other', 'a/../../b', '/abs/path', ''])
    assert.throws(add({ kind: 'inside', path: p }), /Path inside the project/)
  assert.deepEqual(checkConnector({ name: 'Aider', link: { kind: 'inside', path: '.aider.chat.history.md' } }, []).link, { kind: 'inside', path: '.aider.chat.history.md' })
})

test('ids never collide with existing connectors', () => {
  const c = checkConnector({ name: 'My Tool', link: { kind: 'named', dir: `${os.homedir()}/.mytool`, naming: 'sha256' } }, ['custom-my-tool'])
  assert.equal(c.id, 'custom-my-tool-2')
})
