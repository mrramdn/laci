// Desktop shell: runs the laci server with Electron's own Node (no system Node needed) and shows it in a window.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, app, nativeTheme, shell } from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.LACI_PORT ?? 4747)
const url = `http://127.0.0.1:${port}/`

app.setName('laci')
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
if (!app.requestSingleInstanceLock()) app.quit()

let server
let win

/** The theme picked in laci (see src/core/config.ts), so the window opens in the colors the page will use. */
function savedTheme() {
  const dir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  try {
    const t = JSON.parse(readFileSync(path.join(dir, 'laci', 'config.json'), 'utf8')).theme
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

async function up() {
  try {
    return (await (await fetch(`${url}health`)).json()).app === 'laci'
  } catch {
    return false
  }
}

async function startServer() {
  if (await up()) return // `pnpm start` or another window already runs one
  server = spawn(process.execPath, [path.join(root, 'src', 'server.ts')], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LACI_PORT: String(port) },
    stdio: 'inherit',
  })
  for (let i = 0; i < 100; i++) {
    if (await up()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('The laci server did not start')
}

function createWindow() {
  nativeTheme.themeSource = savedTheme()
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 880,
    minHeight: 540,
    title: 'laci',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0C0C0D' : '#FFFFFF',
    // Shown once the page has painted, so there's no blank frame first. The timer covers a page that
    // waits on something slow (like the web font when offline); the background already matches.
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  const show = () => win.isVisible() || win.show()
  win.once('ready-to-show', show)
  setTimeout(show, 2500)
  // Links in READMEs open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault()
      shell.openExternal(target)
    }
  })
  win.loadURL(url)
}

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})
app.on('window-all-closed', () => app.quit())
app.on('quit', () => server?.kill())
app.whenReady().then(async () => {
  await startServer()
  createWindow()
})
