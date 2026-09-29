import path from 'node:path'
import type { ReadmeInfo } from './types.ts'
import { list, readText } from './util.ts'

const TEMPLATES = [
  /bootstrapped with \[?create-next-app/i,
  /this template provides a minimal setup/i,
  /getting started with create react app/i,
  /^#\s*react \+ typescript \+ vite/im,
  /^#\s*vue 3 \+ (typescript \+ )?vite/im,
  /^#\s*sv\s*$/im,
  /laravel is a web application framework/i,
  /a new flutter project\./i,
  /this is a \[?next\.js\]? project/i,
  /^#\s*astro starter kit/im,
]

const WEAK_TITLE = /^(development|readme|project|app|frontend|backend|api|web|my[- ]?app|untitled|getting started|or|todo|docs?)$/i

const BADGE_OR_ASSET = /shields\.io|badge|badgen|img\.shields|\.(png|jpe?g|gif|svg|webp)(\?|$)|github\.com\/[^/]+\/[^/]+\/(actions|workflows)/i

export const stripMd = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

export async function findReadme(dir: string) {
  const entry = (await list(dir)).find(e => e.isFile() && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.name))
  return entry ? path.join(dir, entry.name) : undefined
}

export async function parseReadme(dir: string): Promise<ReadmeInfo | undefined> {
  const file = await findReadme(dir)
  if (!file) return
  const raw = (await readText(file, 48 * 1024)) ?? ''
  const lines = raw.split('\n')

  let title: string | undefined
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+(.+?)\s*#*\s*$/)
    if (m) {
      title = stripMd(m[1])
      start = i + 1
      break
    }
    const html = lines[i].match(/<h1[^>]*>(.*?)<\/h1>/i)
    if (html) {
      title = stripMd(html[1])
      start = i + 1
      break
    }
  }

  // Tagline: the first real paragraph after the title, skipping badges, images, HTML and code.
  let tagline: string | undefined
  let inCode = false
  const para: string[] = []
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].trim()
    if (l.startsWith('```')) {
      inCode = !inCode
      if (para.length) break
      continue
    }
    if (inCode) continue
    if (!l) {
      if (para.length) break
      continue
    }
    if (/^(#|!\[|\[!\[|<|---|\||- \[|\* \[)/.test(l)) {
      if (para.length) break
      continue
    }
    para.push(l.replace(/^>\s?/, ''))
  }
  if (para.length) {
    const text = stripMd(para.join(' '))
    tagline = (text.length > 280 ? text.slice(0, 280).replace(/\s+\S*$/, '') + '…' : text) || undefined
  }

  const links: { label: string; url: string }[] = []
  const seen = new Set<string>()
  for (const m of raw.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(?<![(\[])(https?:\/\/[^\s)<>"'`]+)/g)) {
    const url = (m[2] ?? m[3]).replace(/[.,;:]+$/, '')
    if (BADGE_OR_ASSET.test(url) || seen.has(url)) continue
    seen.add(url)
    const label = stripMd(m[1] ?? '') || new URL(url).hostname.replace(/^www\./, '')
    links.push({ label, url })
    if (links.length >= 6) break
  }

  return {
    file: path.basename(file),
    title,
    weakTitle: !title || title.length < 3 || WEAK_TITLE.test(title),
    tagline,
    template: TEMPLATES.some(r => r.test(raw)),
    links,
    sections: lines.filter(l => /^##\s/.test(l)).map(l => stripMd(l.replace(/^##\s+/, ''))).slice(0, 12),
    images: (raw.match(/!\[|<img\b/g) ?? []).length,
    raw,
  }
}
