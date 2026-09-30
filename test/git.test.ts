// Found using laci on itself: a repo pushed to GitHub (origin) and mirrored to GitLab showed GitLab as its remote.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { gitInfo } from '../src/core/git.ts'

test('origin is the remote shown, even when another remote sorts first by name', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'laci-git-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('remote', 'add', 'gitlab', 'git@gitlab.com:me/app.git')
  git('remote', 'add', 'origin', 'git@github.com:me/app.git')
  const g = await gitInfo(dir)
  assert.equal(g.remotes[0].name, 'origin')
  assert.equal(g.remotes[0].web, 'https://github.com/me/app')
})
