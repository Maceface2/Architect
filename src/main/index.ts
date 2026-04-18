import { app, shell, BrowserWindow, ipcMain, dialog, nativeImage } from 'electron'
import { join } from 'path'
import fs from 'fs'
import path from 'path'
import { initShellEnv, runGraph, writeToTerminal, resizeTerminal, killAll, startAssistant, stopAssistant, spawnShellSession, resumeZone, getZoneSession, type ResumeZoneOptions } from './terminals'
import type { AgentRuntime } from '../shared/agentRuntimes'

app.name = 'Architect'
app.setName('Architect')
process.title = 'Architect'

const iconPath = join(__dirname, '../../resources/icon.png')
const CANVAS_FILENAME = 'architect-canvas.json'

let mainWindow: BrowserWindow | null = null
let canvasWatcher: fs.FSWatcher | null = null
let canvasWatchTimer: ReturnType<typeof setTimeout> | null = null
let watchedProjectDir: string | null = null

function emitCanvasChanged(projectDir: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const raw = fs.readFileSync(path.join(projectDir, CANVAS_FILENAME), 'utf-8')
    mainWindow.webContents.send('canvas:changed', { projectDir, raw })
  } catch {}
}

function stopCanvasWatcher() {
  if (canvasWatchTimer) {
    clearTimeout(canvasWatchTimer)
    canvasWatchTimer = null
  }
  canvasWatcher?.close()
  canvasWatcher = null
  watchedProjectDir = null
}

function startCanvasWatcher(projectDir: string) {
  stopCanvasWatcher()
  watchedProjectDir = projectDir

  try {
    canvasWatcher = fs.watch(projectDir, (_eventType, filename) => {
      if (filename && filename !== CANVAS_FILENAME) return
      if (canvasWatchTimer) clearTimeout(canvasWatchTimer)
      canvasWatchTimer = setTimeout(() => {
        canvasWatchTimer = null
        if (watchedProjectDir !== projectDir) return
        emitCanvasChanged(projectDir)
      }, 120)
    })
  } catch {
    canvasWatcher = null
    watchedProjectDir = null
  }
}

function createWindow(): void {
  const icon = nativeImage.createFromPath(iconPath)

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#111111',
    icon,
    title: 'Architect',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    }
  })

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  mainWindow.on('ready-to-show', () => mainWindow!.show())
  mainWindow.on('closed', () => { stopCanvasWatcher(); killAll(); mainWindow = null })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── File system IPC ────────────────────────────────────────────────────────

ipcMain.handle('get-home-dir', () => app.getPath('home'))

ipcMain.handle('read-file', (_event, filePath: string) => {
  try { return fs.readFileSync(filePath, 'utf-8') } catch { return null }
})

ipcMain.handle('read-dir', (_event, dirPath: string) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return entries
      .filter(e => !e.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(dirPath, entry.name),
      }))
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })
  } catch {
    return []
  }
})

ipcMain.handle('open-directory', async () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory']
  })
  return result.filePaths[0] ?? null
})

ipcMain.handle('save-canvas', (_event, projectDir: string, data: string) => {
  fs.writeFileSync(path.join(projectDir, CANVAS_FILENAME), data, 'utf-8')
})

ipcMain.handle('load-canvas', (_event, projectDir: string) => {
  try { return fs.readFileSync(path.join(projectDir, CANVAS_FILENAME), 'utf-8') }
  catch { return null }
})

ipcMain.handle('watch-canvas', (_event, projectDir: string) => {
  startCanvasWatcher(projectDir)
})

ipcMain.handle('unwatch-canvas', () => {
  stopCanvasWatcher()
})

ipcMain.handle('scan-components', (_event, dirPath: string) => {
  const results: unknown[] = []
  const walk = (d: string) => {
    let entries: import('fs').Dirent[]
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(d, entry.name))
      else if (entry.name === 'architect-component.json') {
        try { results.push(...JSON.parse(fs.readFileSync(path.join(d, entry.name), 'utf-8'))) } catch {}
      }
    }
  }
  walk(dirPath)
  return results
})

// ── Terminal IPC ───────────────────────────────────────────────────────────

ipcMain.handle('run-graph', (_event, nodes, edges, cwd, settings, dispatchContext) => {
  if (!mainWindow) return []
  return runGraph(mainWindow, nodes, edges, cwd ?? app.getPath('home'), settings, dispatchContext)
})

ipcMain.handle('start-assistant', (_event, projectDir: string, contextMd: string, runtime: AgentRuntime) => {
  if (!mainWindow) return null
  return startAssistant(mainWindow, projectDir, contextMd, runtime)
})

ipcMain.on('stop-assistant', () => {
  stopAssistant()
})

ipcMain.handle('terminal:spawn-shell', (_event, cwd: string) => {
  if (!mainWindow) return null
  return spawnShellSession(mainWindow, cwd ?? app.getPath('home'))
})

ipcMain.on('terminal:input', (_event, id: string, data: string) => {
  writeToTerminal(id, data)
})

ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => {
  resizeTerminal(id, cols, rows)
})

ipcMain.on('terminal:kill-all', () => {
  killAll()
})

ipcMain.handle('zone:get-session', (_event, projectDir: string, label: string) => {
  return getZoneSession(projectDir, label)
})

ipcMain.handle('zone:resume', (_event, opts: ResumeZoneOptions) => {
  if (!mainWindow) return { ok: false, reason: 'no-window' }
  return resumeZone(mainWindow, opts)
})

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await initShellEnv()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopCanvasWatcher()
  if (process.platform !== 'darwin') app.quit()
})
