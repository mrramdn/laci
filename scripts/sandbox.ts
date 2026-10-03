// A fake HOME with a few projects and agent logs, for trying laci's write actions without touching real data.
// Usage: node scripts/sandbox.ts <dir>   then   LACI_HOME=<dir> pnpm dev
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const home = path.resolve(process.argv[2] ?? 'sandbox-home')
const P = (...p: string[]) => path.join(home, ...p)
const enc = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe', env })
const line = (o: object) => JSON.stringify(o) + '\n'

function repo(dir: string, remote?: string) {
  put(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), scripts: { dev: 'vite' }, dependencies: { next: '1' } }))
  put(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n\nA sandbox project called ${path.basename(dir)}.\n`)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  if (remote) git(dir, 'remote', 'add', 'origin', remote)
}

const alpha = P('project', 'alpha')
repo(alpha, 'git@github.com:me/alpha.git')
repo(P('project', 'client', 'beta'))
repo(P('project', '_archive', 'gamma'))
put(P('project', 'client', 'beta', 'NOTES.md'), '# Beta\n\n## Masih terbuka\n- [ ] rotate the root password\n- [x] add swap\n')
const ad = P('.claude', 'projects', enc(alpha))
put(path.join(ad, 's1.jsonl'), line({ type: 'user', cwd: alpha, sessionId: 's1' }) + line({ type: 'ai-title', aiTitle: 'Alpha landing page', sessionId: 's1' }))
put(path.join(ad, 'memory', 'MEMORY.md'), '- alpha facts\n')
const gd = P('.claude', 'projects', enc(P('project', 'gamma')))
put(path.join(gd, 's2.jsonl'), line({ type: 'user', cwd: P('project', 'gamma'), sessionId: 's2' }) + line({ type: 'ai-title', aiTitle: 'Gamma API', sessionId: 's2' }))
put(path.join(gd, 'memory', 'MEMORY.md'), '- gamma facts\n')
put(P('.codex', 'sessions', '2026', '09', '01', 'rollout-a.jsonl'), line({ type: 'session_meta', payload: { cwd: alpha, timestamp: '2026-09-01T00:00:00Z' } }))
console.log(home)
