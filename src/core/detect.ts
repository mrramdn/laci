import path from 'node:path'
import { HEAVY, HOME, list, stat } from './util.ts'

export const CODE_MARKERS = new Set([
  'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'pubspec.yaml',
  'composer.json', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'CMakeLists.txt', 'Dockerfile',
  'docker-compose.yml', 'compose.yaml', 'wp-config.php', 'deno.json', 'shopify.theme.toml', 'artisan',
])
export const DOC_FILE = /^(readme|notes?|handoff|todo|tasks)[\w.-]*\.md$/i

export const DEFAULT_ROOTS = ['project', 'projects', 'code', 'dev', 'src', 'repos', 'work', 'tugas', 'Documents', 'Desktop', 'Downloads']

export interface Found {
  path: string
  kind: 'project' | 'folder'
  type?: 'code' | 'docs'
  git?: boolean
  children: Found[]
}

const hasRepo = (f: Found): boolean => !!f.git || f.children.some(hasRepo)

export async function defaultRoots() {
  const out: string[] = []
  for (const r of DEFAULT_ROOTS) {
    const p = path.join(HOME, r)
    if ((await stat(p))?.isDirectory()) out.push(p)
  }
  return out
}

/**
 * A folder is a project when it has `.git` or a build marker. Otherwise we descend; a folder that
 * holds projects becomes a group. A leaf with notes/handoff files, or one an agent worked in,
 * is a docs project (e.g. a server-notes folder with no code).
 */
export async function detect(roots: string[], agentPaths: Set<string>, maxDepth = 6): Promise<Found[]> {
  async function walk(dir: string, depth: number): Promise<Found | null> {
    const entries = await list(dir)
    const files = entries.filter(e => e.isFile())
    const git = entries.some(e => e.name === '.git')
    const code = files.some(e => CODE_MARKERS.has(e.name) || /\.(csproj|sln)$/.test(e.name))
    const md = files.filter(e => /\.md$/i.test(e.name))
    if (git) return { path: dir, kind: 'project', type: code || !md.length ? 'code' : 'docs', git: true, children: [] }

    const children: Found[] = []
    if (depth < maxDepth) {
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || HEAVY.has(e.name)) continue
        const f = await walk(path.join(dir, e.name), depth + 1)
        if (f) children.push(f)
      }
    }
    // A marker without .git that wraps real repos (e.g. a deploy shell around one) is a group, not a project.
    if (code) return children.some(hasRepo) ? { path: dir, kind: 'folder', children } : { path: dir, kind: 'project', type: 'code', children: [] }
    if (children.length) return { path: dir, kind: 'folder', children }
    if (depth > 0 && (agentPaths.has(dir) || md.some(e => DOC_FILE.test(e.name)))) return { path: dir, kind: 'project', type: 'docs', children: [] }
    return null
  }

  const out: Found[] = []
  for (const r of roots) {
    const f = await walk(r, 0)
    if (f) out.push(f)
  }
  return out
}
