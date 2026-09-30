// Found using laci on itself: "~/.local/share/laci" in a to-do came back as "/.local/share/laci".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripMd } from '../src/core/readme.ts'

test('markdown formatting is removed, but paths and names keep their characters', () => {
  assert.equal(stripMd('Debug log at ~/.local/share/laci/laci.log'), 'Debug log at ~/.local/share/laci/laci.log')
  assert.equal(stripMd('Move it to _archive/my_old_app'), 'Move it to _archive/my_old_app')
  assert.equal(stripMd('Ship the `menu` page, **today**, _maybe_ ~~not~~ *soon*'), 'Ship the menu page, today, maybe not soon')
})
