import { existsSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_ROOTS } from './detect.ts'
import { HEAVY, HOME, list } from './util.ts'

/** Programs laci can open things with, most common first. Only the installed ones are offered. */
export const APP_CHOICES = {
  terminal: ['kitty', 'konsole', 'alacritty', 'wezterm', 'foot', 'ghostty', 'gnome-terminal', 'xfce4-terminal', 'xterm'],
  editor: ['code', 'cursor', 'zed', 'codium', 'windsurf', 'subl', 'kate', 'gnome-text-editor'],
  files: ['dolphin', 'nautilus', 'thunar', 'nemo', 'pcmanfm', 'caja'],
}

export const onPath = (bin: string) => (process.env.PATH ?? '').split(':').some(d => d && existsSync(path.join(d, bin)))

export function installedApps() {
  return {
    terminal: APP_CHOICES.terminal.filter(onPath),
    editor: APP_CHOICES.editor.filter(onPath),
    files: APP_CHOICES.files.filter(onPath),
  }
}

/** Git repos under `dir`, a few levels down. Bounded so a huge Downloads folder can't stall the setup screen. */
async function countRepos(dir: string, depth = 3, budget = { left: 4000 }): Promise<number> {
  let n = 0
  for (const e of await list(dir)) {
    if (--budget.left < 0) break
    if (!e.isDirectory()) continue
    if (e.name === '.git') return 1
    if (e.name.startsWith('.') || HEAVY.has(e.name) || depth === 0) continue
    n += await countRepos(path.join(dir, e.name), depth - 1, budget)
  }
  return n
}

/** Folders in the home folder someone might keep projects in, with how many repos each holds. */
export async function rootCandidates() {
  const top = (await list(HOME)).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name)
  const names = [...new Set([...DEFAULT_ROOTS.filter(r => top.includes(r)), ...top])]
  const out = await Promise.all(names.map(async name => ({ path: path.join(HOME, name), repos: await countRepos(path.join(HOME, name)) })))
  return out.sort((a, b) => b.repos - a.repos || a.path.localeCompare(b.path))
}
