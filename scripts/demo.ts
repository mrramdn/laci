// A believable fake HOME for screenshots and demos: clients, a thesis, side projects, agent history,
// a half-done move and an orphan. Usage: node scripts/demo.ts <dir>  then  LACI_HOME=<dir> pnpm dev
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const home = path.resolve(process.argv[2] ?? 'demo-home')
const P = (...p: string[]) => path.join(home, 'project', ...p)
const enc = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')
const DAY = 86400000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const line = (o: object) => JSON.stringify(o) + '\n'
/** A real session id, so the report about this session can name it. */
const ACME_SESSION = '5f0c2a1e-8d4b-4c7a-9e21-3b6d0f9a7c42'

/** Set every file's mtime (outside .git) to `daysAgo`, so activity dates look lived-in. */
function age(dir: string, daysAgo: number) {
  const t = new Date(Date.now() - daysAgo * DAY)
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) age(p, daysAgo)
    else utimesSync(p, t, t)
  }
}

function git(cwd: string, args: string[], at = ago(0)) {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.com', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  })
}

/** A repo whose commits are spread over the given days-ago values, oldest first. */
function repo(dir: string, files: Record<string, string>, commits: [number, string][], remote?: string) {
  for (const [f, t] of Object.entries(files)) put(path.join(dir, f), t)
  git(dir, ['init', '-q', '-b', 'main'])
  for (const [i, [d, msg]] of commits.entries()) {
    put(path.join(dir, '.history'), `${i}\n`)
    git(dir, ['add', '-A'], ago(d))
    git(dir, ['commit', '-qm', msg], ago(d))
  }
  if (remote) git(dir, ['remote', 'add', 'origin', remote])
  age(dir, commits.at(-1)![0])
}

function sessions(dir: string, list: { id: string; cwd: string; title: string; daysAgo: number }[], memory: string[] = []) {
  const d = path.join(home, '.claude', 'projects', enc(dir))
  for (const s of list) {
    const f = path.join(d, `${s.id}.jsonl`)
    put(f, line({ type: 'user', cwd: s.cwd, sessionId: s.id, timestamp: ago(s.daysAgo), gitBranch: 'main' }) + line({ type: 'ai-title', aiTitle: s.title, sessionId: s.id }))
    const t = new Date(Date.now() - s.daysAgo * DAY)
    utimesSync(f, t, t)
  }
  for (const m of memory) put(path.join(d, 'memory', m), `- ${m.replace('.md', '')}\n`)
}

const pkg = (name: string, deps: string[], scripts = { dev: 'next dev', build: 'next build', lint: 'eslint .' }, description?: string) =>
  JSON.stringify({ name, description, scripts, dependencies: Object.fromEntries(deps.map(d => [d, '*'])) }, null, 2)

// Clients
const acme = P('clients', 'acme-store')
repo(acme, {
  'package.json': pkg('acme-store', ['next', 'react', 'tailwindcss', 'prisma', '@prisma/client', 'typescript']),
  'pnpm-lock.yaml': '',
  'README.md': '# Acme Store\n\nHeadless storefront for Acme Coffee: product catalog, cart and Midtrans checkout, on Next.js and Prisma.\n\n## Setup\n\n```sh\npnpm install\npnpm dev\n```\n\nLive: [acme-coffee.example](https://acme-coffee.example)\n',
  '.env.example': 'DATABASE_URL=\nMIDTRANS_SERVER_KEY=\nNEXT_PUBLIC_SITE_URL=\n',
  'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
  'src/app/page.tsx': 'export default function Page() { return null }\n',
  '.laci.md': '---\nstatus: active\npriority: high\ndeadline: ' + new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10) + '\n---\n\n## Next\n- [ ] Fix checkout total on mobile Safari\n- [ ] Send staging link to the client\n\n## Notes\nClient wants the launch before the coffee expo. Midtrans sandbox keys are in 1Password.\n',
}, [[80, 'chore: scaffold next app'], [60, 'feat: product catalog'], [41, 'feat: cart'], [30, 'feat: midtrans checkout'], [16, 'fix: stock sync'], [9, 'feat: order emails'], [3, 'fix: checkout rounding'], [1, 'feat: promo codes']], 'git@github.com:acme/acme-store.git')
put(path.join(acme, 'src/app/checkout.tsx'), 'export const Checkout = () => null\n')
// Sessions started at the old path: the folder was moved into clients/ by hand, the logs never followed.
sessions(acme, [
  { id: 'a1', cwd: P('acme-store'), title: 'Midtrans checkout integration', daysAgo: 30 },
  { id: ACME_SESSION, cwd: acme, title: 'Checkout total wrong on mobile', daysAgo: 1 },
], ['MEMORY.md', 'client-preferences.md', 'deploy.md'])

const kopi = P('clients', 'kopi-landing')
repo(kopi, {
  'package.json': pkg('kopi-landing', ['astro', 'tailwindcss'], { dev: 'astro dev', build: 'astro build', preview: 'astro preview' }),
  'README.md': '# Kopi Landing\n\nOne-page landing site for a coffee shop in Bandung, built with Astro.\n',
}, [[12, 'init'], [6, 'feat: hero and menu'], [2, 'feat: contact form']])
put(path.join(kopi, 'src/pages/index.astro'), '---\n---\n<h1>Kopi</h1>\n')
sessions(kopi, [{ id: 'k1', cwd: kopi, title: 'Hero section copy and layout', daysAgo: 2 }])
put(path.join(home, '.codex', 'sessions', ago(4).slice(0, 10).replaceAll('-', '/'), 'rollout-kopi.jsonl'), line({ type: 'session_meta', payload: { cwd: kopi, timestamp: ago(4) } }))

// Thesis
const lms = P('thesis', 'campus-lms')
repo(lms, {
  'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
  'artisan': '',
  'docker-compose.yml': 'services:\n  app:\n    image: php:8.3\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n',
  '.env.example': 'APP_KEY=\nDB_HOST=\nDB_PASSWORD=\nREDIS_HOST=\n',
  'README.md': '# Campus LMS\n\nLearning management system for my thesis: courses, assignments and grading for a boarding school.\n',
  'HANDOFF.md': '# Handoff\n\n## Next steps\n1. Finish the grading export (CSV + PDF)\n2. Load test the quiz page with 300 students\n3. Write chapter 4 results from the load test\n',
}, [[120, 'init laravel'], [95, 'feat: courses'], [70, 'feat: assignments'], [44, 'feat: grading'], [20, 'wip: export']], 'git@gitlab.com:me/campus-lms.git')
put(path.join(lms, 'app/Export.php'), '<?php\n')
git(lms, ['stash', 'push', '-q', '-u', '-m', 'half-done export'])
sessions(lms, [{ id: 'l1', cwd: lms, title: 'Grading export to PDF', daysAgo: 19 }])

// Side projects
const habit = P('side', 'habit-app')
repo(habit, {
  'package.json': pkg('habit-app', ['expo', 'react-native', 'react'], { start: 'expo start', android: 'expo run:android' }, 'Tiny habit tracker for my phone'),
  '.gitignore': 'node_modules/\n',
}, [[210, 'init expo'], [180, 'feat: streaks'], [150, 'feat: reminders']])
mkdirSync(path.join(habit, 'node_modules'), { recursive: true })
// A sparse file: shows up as 420 MB of reclaimable space without using the disk.
execFileSync('truncate', ['-s', '420M', path.join(habit, 'node_modules', '.demo-weight')])
age(habit, 150)

const dots = P('side', 'dotfiles')
repo(dots, { 'README.md': '# dotfiles\n\nHyprland, kitty and shell config.\n', 'install.sh': '#!/bin/sh\n' }, [[40, 'init'], [8, 'hyprland: new binds']], 'git@github.com:me/dotfiles.git')

// Notes-only folder with an open checklist
put(P('infra-notes', 'NOTES.md'), '# Server notes\n\n## Open\n- [ ] Rotate the SSH keys on the staging droplet\n- [ ] Renew the SSL cert before it expires\n- [x] Add 2 GB swap\n')
age(P('infra-notes'), 5)
sessions(P('infra-notes'), [{ id: 'n1', cwd: P('infra-notes'), title: 'Why the droplet keeps running out of memory', daysAgo: 5 }])

// Archived portfolio, whose agent history stayed at the old address
const old = P('_archive', 'old-portfolio')
repo(old, { 'package.json': pkg('old-portfolio', ['next', 'react']), 'README.md': '# Portfolio v1\n\nMy first portfolio site.\n' }, [[300, 'init'], [260, 'feat: projects page']], 'git@github.com:me/portfolio-v1.git')
sessions(P('old-portfolio'), [{ id: 'o1', cwd: P('old-portfolio'), title: 'Portfolio projects grid', daysAgo: 26 }], ['MEMORY.md'])

// Session reports, as an agent following Laci's instruction writes them. Choose ~/Documents/agent-reports
// in Settings to see them.
const reports = path.join(home, 'Documents', 'agent-reports')
const dayOf = (daysAgo: number) => {
  const t = new Date(Date.now() - daysAgo * DAY)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}
function report(daysAgo: number, slug: string, text: string) {
  const file = path.join(reports, `${dayOf(daysAgo)}-${slug}.md`)
  put(file, text.replace(/\{day\}/g, dayOf(daysAgo)))
  const t = new Date(Date.now() - daysAgo * DAY + 3 * 3600_000)
  utimesSync(file, t, t)
  return path.basename(file)
}
put(path.join(reports, 'README.md'), '# Session reports\n\nOne file per session that did real work. Newest first.\n')
report(1, 'checkout-total-on-mobile-safari', `# Checkout total wrong on mobile Safari

- **Date:** {day}
- **Session:** \`~/project/clients/acme-store\` · \`${ACME_SESSION}\`
- **Projects:** ~/project/clients/acme-store

## Summary
Safari on iOS showed a checkout total one rupiah off. The cart rounded each line before adding them up; it now adds first and rounds once, as Midtrans does. Fixed, tested on Safari, Chrome and Firefox, and deployed to staging.

## What was done
- \`src/app/checkout.tsx\`: the total is computed in whole rupiah and rounded once.
- A test for a cart of three discounted items (\`pnpm test checkout\`).
- Staging redeployed at [acme-coffee-staging.example](https://acme-coffee-staging.example).

## State now
- Staging shows the right total on Safari, Chrome and Firefox.
- Production still rounds per line. The release waits for the client.

## Open
- Send the staging link to the client and ask for the go to release.
- Promo codes stack with the expo discount; ask whether that is wanted.
`)
report(2, 'kopi-hero-and-contact-form', `# Kopi landing: hero copy and contact form

- **Date:** {day}
- **Session:** ~/project/clients/kopi-landing · Codex
- **Projects:** Kopi Landing, the Astro site

## Summary
Wrote the hero copy in Indonesian and English and added a contact form that posts to the shop's WhatsApp.

## What was done
- Hero and menu sections in \`src/pages/index.astro\`.
- The form opens WhatsApp with the message filled in; no server needed.

## State now
Builds with \`pnpm build\`; not deployed yet.

## Open
- The shop's opening hours for the footer.
- Photos of the real menu instead of the placeholders.
`)
report(3, 'email-filters', `# Email filters for the work inbox

- **Date:** {day}
- **Session:** ~ · Claude Code
- **Projects:** Gmail (work account)

## Summary
Sorted the work inbox: six filters label invoices, client mail and newsletters as they arrive.

## Open
Nothing open.
`)
report(5, 'droplet-memory-and-swap', `# Why the droplet keeps running out of memory

- **Date:** {day}
- **Session:** ~/project/infra-notes · Claude Code
- **Projects:** ~/project/infra-notes/NOTES.md

## Summary
The staging droplet has 1 GB of memory and Postgres plus two Node apps. Added 2 GB of swap and capped Postgres; the out-of-memory kills stopped.

## State now
Swap is on and survives a reboot. Memory peaks at 840 MB under the nightly import.

## Open
- Rotate the SSH keys on the staging droplet.
- Renew the SSL certificate before it expires on the 30th.
`)
report(8, 'hyprland-binds', `# New Hyprland binds

- **Date:** {day}
- **Session:** ~/project/side/dotfiles · Claude Code
- **Projects:** ~/project/side/dotfiles

## Summary
Moved window focus to Super+HJKL and added a bind for the screenshot tool.

## Open
Nothing open.
`)
const rubrics = report(44, 'grading-model-and-rubrics', `# Grading model and rubrics

- **Date:** {day}
- **Session:** ~/project/thesis/campus-lms · Claude Code
- **Projects:** ~/project/thesis/campus-lms

## Summary
Designed how grades are stored: a rubric per assignment, a score per criterion, and a weighted total computed when it is read.

## Open
- Export the grades for the school's report cards.
`)
report(19, 'grading-export-to-pdf', `# Grading export to PDF

- **Date:** {day}
- **Session:** ~/project/thesis/campus-lms · Claude Code
- **Projects:** ~/project/thesis/campus-lms

## Summary
Started the grading export the school asked for: one CSV for the office and one PDF report card per student. The CSV works; the PDF is half done and stashed. This continues [the grading model](${rubrics}).

## What was done
- \`app/Export.php\` builds the CSV from the weighted totals, one row per student and course.
- The PDF layout follows the school's paper report card: the student's name, the class, then one table per course.
- Chose DomPDF over a headless browser: it runs inside the PHP container, so the school's server needs nothing new.

## Decisions
- Grades are rounded to whole numbers only on the report card. The CSV keeps two decimals, because the office recalculates class ranks from it.
- A course without a score is left out of the report card instead of showing zero.
- Report cards are generated on request, not stored: the rubric can change until the term closes.

## Load test plan
The quiz page must hold 300 students at once on exam day. The plan for chapter 4:

1. Seed a course with 300 students and a 40-question quiz.
2. Run k6 with 300 virtual users answering a question every 20 seconds.
3. Measure the 95th percentile response time and the database's connection count.
4. Repeat with Redis caching the quiz questions.

\`\`\`sh
k6 run --vus 300 --duration 15m load/quiz.js
\`\`\`

## State now
- The CSV export works and is tested against last term's grades.
- The PDF export is in a stash named "half-done export".
- Nothing of this is deployed.

## Open
1. Finish the PDF report card from the stash.
2. Load test the quiz page with 300 students.
3. Write chapter 4 from the load test results.
`)

// A neutral prompt for terminal screenshots (login shells read ~/.bash_profile).
put(path.join(home, '.bash_profile'), "PS1='\\W $ '\n")

console.log(home)
