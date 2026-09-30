import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR, ConfigError, homePath } from './config.ts'
import { SIDECAR, ensureExcluded } from './sidecar.ts'
import { list, run, stat, tilde } from './util.ts'

/** Each folder in here is a template: copied as-is (minus `.git`) into a new project. */
export const TEMPLATES = path.join(CONFIG_DIR, 'templates')

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const GIT_URL = /^(https:\/\/[^\s]+|git@[^\s:]+:[^\s]+|ssh:\/\/[^\s]+)$/
const REMOTES = ['none', 'github', 'gitlab', 'both'] as const

const bad = (msg: string): never => {
  throw new ConfigError(msg)
}

export async function templates() {
  return (await list(TEMPLATES)).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort()
}

/** Which hosts the gh/glab CLIs are logged in to, so the form only offers what will work. */
export async function hosts() {
  const [github, gitlab] = await Promise.all([run('gh', ['auth', 'status'], 8000), run('glab', ['auth', 'status'], 8000)])
  return { github: github.ok, gitlab: gitlab.ok }
}

const git = (dir: string, ...args: string[]) => run('git', ['-C', dir, ...args], 60000)

async function gitlabRepo(name: string) {
  const made = await run('glab', ['repo', 'create', name, '--private', '--skipGitInit', '--defaultBranch', 'main'], 60000)
  if (!made.ok) return
  const user = await run('glab', ['api', 'user'], 15000)
  try {
    return `${JSON.parse(user.out).web_url}/${name}.git`
  } catch {}
}

/**
 * Make a project folder: empty, from a template or cloned; git with a first commit; `.laci.md`; and
 * optionally a private repo on GitHub and/or GitLab. Returns what couldn't be done, for the toast.
 */
export async function createProject(raw: any): Promise<{ path: string; warnings: string[] }> {
  const name = String(raw?.name ?? '').trim()
  if (!NAME.test(name)) bad('Name: letters, numbers, dots, dashes or underscores, no spaces')
  const parent = homePath(raw?.parent, 'Location')
  if (!(await stat(parent))?.isDirectory()) bad(`${tilde(parent)} doesn't exist`)
  const dest = path.join(parent, name)
  if (await stat(dest)) bad(`${tilde(dest)} already exists`)
  const summary = String(raw?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  const remote = raw?.remote ?? 'none'
  if (!REMOTES.includes(remote)) bad('Pick where to push it')
  const from = raw?.from
  const url = String(raw?.url ?? '').trim()
  const template = String(raw?.template ?? '')
  if (from === 'clone' && !GIT_URL.test(url)) bad('Repo URL: https://… or git@host:owner/repo')
  if (from === 'template' && !(await templates()).includes(template)) bad('Unknown template')
  if (!['empty', 'template', 'clone'].includes(from)) bad('Pick how to start')

  const warnings: string[] = []
  if (from === 'clone') {
    // `--` keeps a URL from being read as an option. git removes a half-made clone itself.
    const r = await git(parent, 'clone', '-q', '--', url, name)
    if (!r.ok) bad("git clone failed. Check the URL and that you're logged in to the host.")
  } else {
    await fs.mkdir(dest) // fails if something appeared since the check: then we never delete anything
    try {
      if (from === 'template') await fs.cp(path.join(TEMPLATES, template), dest, { recursive: true, filter: src => path.basename(src) !== '.git' })
      if (!(await stat(path.join(dest, 'README.md')))) await fs.writeFile(path.join(dest, 'README.md'), `# ${name}\n${summary ? `\n${summary}\n` : ''}`)
      if (!(await git(dest, 'init', '-q', '-b', 'main')).ok) throw new Error('git init failed')
      await git(dest, 'add', '-A')
      if (!(await git(dest, 'commit', '-qm', 'chore: initial commit')).ok) warnings.push('No first commit: set your name and email with git config')
    } catch (e) {
      await fs.rm(dest, { recursive: true, force: true }) // only what we just made
      throw e
    }
  }

  await fs.writeFile(path.join(dest, SIDECAR), `---\nstatus: active\n---\n${summary ? `\n## Summary\n\n${summary}\n` : ''}\n## Next\n\n## Notes\n`)
  await ensureExcluded(dest)

  if (remote !== 'none' && from !== 'clone') {
    if (!(await git(dest, 'rev-parse', '--verify', 'HEAD')).ok) warnings.push('Nothing committed yet, so no remote was created')
    else {
      let github: string | undefined
      if (remote === 'github' || remote === 'both') {
        const r = await run('gh', ['repo', 'create', name, '--private', '--source', dest, '--remote', 'origin', '--push'], 120000)
        if (r.ok) github = (await git(dest, 'remote', 'get-url', 'origin')).out
        else warnings.push('Creating the GitHub repo failed. Check `gh auth status`, or whether the name is taken.')
      }
      if (remote === 'gitlab' || remote === 'both') {
        const gl = await gitlabRepo(name)
        if (!gl) warnings.push('Creating the GitLab repo failed. Check `glab auth status`, or whether the name is taken.')
        else if (github) {
          // Same setup as a hand-made mirror: one `git push` updates both; `gitlab` is there to fetch from.
          await git(dest, 'remote', 'set-url', '--add', '--push', 'origin', github)
          await git(dest, 'remote', 'set-url', '--add', '--push', 'origin', gl)
          await git(dest, 'remote', 'add', 'gitlab', gl)
          if (!(await git(dest, 'push', '-q', 'origin', 'main')).ok) warnings.push('Pushing to GitLab failed; run git push later')
        } else {
          await git(dest, 'remote', 'add', 'origin', gl)
          if (!(await git(dest, 'push', '-q', '-u', 'origin', 'main')).ok) warnings.push('Pushing to GitLab failed; run git push later')
        }
      }
    }
  }
  return { path: dest, warnings }
}
