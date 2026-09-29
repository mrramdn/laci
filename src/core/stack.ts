import path from 'node:path'
import type { StackInfo } from './types.ts'
import { list, readText, stat, walkFiles } from './util.ts'

// Order matters: the first labels shown are the most telling ones.
const DEPS: [string, string][] = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@sveltejs/kit', 'SvelteKit'], ['astro', 'Astro'], ['@remix-run/react', 'Remix'],
  ['expo', 'Expo'], ['react-native', 'React Native'], ['electron', 'Electron'], ['@tauri-apps/api', 'Tauri'],
  ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'],
  ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['elysia', 'Elysia'],
  ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['mongoose', 'MongoDB'],
  ['@supabase/supabase-js', 'Supabase'], ['firebase', 'Firebase'],
  ['tailwindcss', 'Tailwind'], ['@anthropic-ai/sdk', 'Claude SDK'], ['@anthropic-ai/claude-agent-sdk', 'Agent SDK'],
  ['ai', 'AI SDK'], ['openai', 'OpenAI SDK'], ['@modelcontextprotocol/sdk', 'MCP'],
  ['three', 'Three.js'], ['motion', 'Motion'], ['framer-motion', 'Motion'], ['gsap', 'GSAP'],
  ['vite', 'Vite'], ['vitest', 'Vitest'], ['jest', 'Jest'], ['@playwright/test', 'Playwright'],
  ['typescript', 'TypeScript'],
]

const LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', php: 'PHP', dart: 'Dart', liquid: 'Liquid', vue: 'Vue', svelte: 'Svelte',
  astro: 'Astro', css: 'CSS', scss: 'CSS', html: 'HTML', sh: 'Shell', java: 'Java', kt: 'Kotlin', swift: 'Swift',
  c: 'C', cpp: 'C++', cs: 'C#', rb: 'Ruby', sql: 'SQL', md: 'Markdown', docx: 'Docs', pdf: 'Docs', ipynb: 'Jupyter',
}

const has = async (dir: string, name: string) => !!(await stat(path.join(dir, name)))

async function readJson(p: string): Promise<any> {
  const t = await readText(p, 512 * 1024)
  if (!t) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

/** package.json files of the project and its workspace packages (apps/*, packages/*). */
async function packageJsons(dir: string) {
  const out: any[] = []
  const root = await readJson(path.join(dir, 'package.json'))
  if (root) out.push(root)
  for (const ws of ['apps', 'packages']) {
    for (const e of await list(path.join(dir, ws))) {
      if (!e.isDirectory()) continue
      const pj = await readJson(path.join(dir, ws, e.name, 'package.json'))
      if (pj) out.push(pj)
    }
  }
  return { root, all: out }
}

export async function detectStack(dir: string): Promise<StackInfo & { description?: string; newestMs: number; files: number }> {
  const labels: string[] = []
  const add = (l: string) => labels.includes(l) || labels.push(l)
  const { root, all } = await packageJsons(dir)

  const deps = new Set<string>()
  for (const pj of all) for (const k of Object.keys({ ...pj.dependencies, ...pj.devDependencies })) deps.add(k)
  for (const [dep, label] of DEPS) if (deps.has(dep)) add(label)
  // React is implied by Next/Expo/Remix, so it only adds noise next to them.
  if (labels.some(l => ['Next.js', 'Expo', 'Remix', 'React Native'].includes(l)) && labels.includes('React')) labels.splice(labels.indexOf('React'), 1)

  const pubspec = await readText(path.join(dir, 'pubspec.yaml'), 64 * 1024)
  if (pubspec) add(/\bflutter:/.test(pubspec) ? 'Flutter' : 'Dart')
  const composer = await readJson(path.join(dir, 'composer.json'))
  if (composer) add(composer.require?.['laravel/framework'] ? 'Laravel' : 'PHP')
  if (await has(dir, 'go.mod')) add('Go')
  if (await has(dir, 'Cargo.toml')) add('Rust')
  const py = (await readText(path.join(dir, 'pyproject.toml'), 64 * 1024)) ?? (await readText(path.join(dir, 'requirements.txt'), 64 * 1024))
  if (py) {
    for (const [re, l] of [[/django/i, 'Django'], [/fastapi/i, 'FastAPI'], [/flask/i, 'Flask']] as const) if (re.test(py)) add(l)
    add('Python')
  }
  if ((await has(dir, 'wp-config.php')) || (await has(dir, 'wp-content')) || ((await has(dir, 'style.css')) && (await has(dir, 'functions.php')))) add('WordPress')

  const scripts = Object.entries<string>(root?.scripts ?? {})
    .map(([name, cmd]) => ({ name, cmd }))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .slice(0, 8)

  let packageManager: string | undefined
  for (const [lock, pm] of [['pnpm-lock.yaml', 'pnpm'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']])
    if (!packageManager && (await has(dir, lock))) packageManager = pm
  if (!packageManager && root) packageManager = String(root.packageManager ?? '').split('@')[0] || undefined

  const services: string[] = []
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const t = await readText(path.join(dir, f), 64 * 1024)
    if (!t) continue
    for (const m of t.matchAll(/^\s+image:\s*["']?([^\s"':@]+)/gm)) services.push(m[1].split('/').at(-1)!)
    if (!services.length) {
      const body = t.split(/^services:\s*$/m)[1] ?? ''
      for (const m of body.matchAll(/^ {2}([A-Za-z0-9_.-]+):\s*$/gm)) services.push(m[1])
    }
    add('Docker Compose')
    break
  }

  const envText = await readText(path.join(dir, '.env.example'), 32 * 1024)
  const env = envText ? [...envText.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=/gm)].map(m => m[1]).slice(0, 40) : []

  const deploy: string[] = []
  for (const [f, l] of [['vercel.json', 'Vercel'], ['netlify.toml', 'Netlify'], ['fly.toml', 'Fly.io'], ['railway.json', 'Railway'], ['wrangler.toml', 'Cloudflare'], ['Procfile', 'Procfile'], ['Dockerfile', 'Dockerfile']])
    if (await has(dir, f)) deploy.push(l)
  const ci: string[] = []
  if ((await list(path.join(dir, '.github', 'workflows'))).length) ci.push('GitHub Actions')
  if (await has(dir, '.gitlab-ci.yml')) ci.push('GitLab CI')

  const langCount = new Map<string, number>()
  let newestMs = 0
  let liquid = false
  const files = await walkFiles(dir, 4000, (rel, mtime) => {
    if (mtime > newestMs) newestMs = mtime
    const ext = rel.split('.').at(-1)?.toLowerCase() ?? ''
    const lang = LANG[ext]
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1)
    if (rel.endsWith('theme.liquid')) liquid = true
  })
  if (liquid) add('Shopify theme')
  const languages = [...langCount].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files)

  return { labels, languages, packageManager, scripts, services: [...new Set(services)], env, deploy, ci, description: root?.description, newestMs, files }
}

function rank(name: string) {
  const i = ['dev', 'start', 'build', 'test', 'lint', 'typecheck', 'preview'].indexOf(name)
  return i < 0 ? 99 : i
}
