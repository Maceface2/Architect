import { app, shell, BrowserWindow, ipcMain, dialog, nativeImage } from 'electron'
import { join } from 'path'
import fs from 'fs'
import path from 'path'
import {
  initShellEnv,
  startDispatch,
  runZone,
  resumeDispatch,
  resetZoneSession,
  writeToTerminal,
  setUserControl,
  resizeTerminal,
  killAll,
  closeTerminal,
  getCaptureState,
  startAssistant,
  stopAllAssistants,
  stopAssistantMode,
  listAssistantSessions,
  deleteAssistantSession,
  updateAssistantSessionSummary,
  spawnShellSession,
  listZoneSessionsForZone,
  deleteZoneSessionEntry,
  renameZoneSessionEntry,
  type StartAssistantOpts,
  type StartDispatchOptions,
  type RunZoneOptions,
  type ResumeDispatchOptions,
} from './terminals'
import {
  listDispatches,
  deleteDispatch,
  updateDispatchSummary,
} from './dispatchCapture'
import type { AgentRuntime, AssistantMode } from '../shared/agentRuntimes'

app.name = 'Architect'
app.setName('Architect')
process.title = 'Architect'

const iconPath = join(__dirname, '../../resources/icon.png')
const CANVAS_FILENAME = 'architect-canvas.json'

let mainWindow: BrowserWindow | null = null
let canvasWatcher: fs.FSWatcher | null = null
let canvasWatchTimer: ReturnType<typeof setTimeout> | null = null
let watchedProjectDir: string | null = null
const popouts = new Map<string, BrowserWindow>()

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

// ── Terminal IPC ───────────────────────────────────────────────────────────

ipcMain.handle('dispatch:start', (_event, nodes, edges, cwd, settings, dispatch: StartDispatchOptions, dispatchContext) => {
  if (!mainWindow) return []
  return startDispatch(mainWindow, nodes, edges, cwd ?? app.getPath('home'), settings, dispatch ?? { userPrompt: '' }, dispatchContext)
})

ipcMain.handle('terminal:run-zone', (_event, opts: RunZoneOptions) => {
  if (!mainWindow) return { ok: false, reason: 'no-window' }
  return runZone(mainWindow, opts)
})

ipcMain.handle('zone:list-sessions', (_event, projectDir: string, zoneId: string, label?: string) => {
  return listZoneSessionsForZone(projectDir, zoneId, label)
})

ipcMain.handle('zone:delete-session', (_event, projectDir: string, zoneId: string, sessionId: string, label?: string) => {
  return deleteZoneSessionEntry(projectDir, zoneId, sessionId, label)
})

ipcMain.handle('zone:update-session-summary', (_event, projectDir: string, zoneId: string, sessionId: string, summary: string, label?: string) => {
  return renameZoneSessionEntry(projectDir, zoneId, sessionId, summary, label)
})

ipcMain.handle('zone:reset-session', (_event, projectDir: string, zoneId: string, label?: string) => {
  return resetZoneSession(projectDir, zoneId, label)
})

ipcMain.handle('dispatches:list', (_event, projectDir: string) => {
  return listDispatches(projectDir)
})

ipcMain.handle('dispatches:delete', (_event, projectDir: string, dispatchId: string) => {
  return deleteDispatch(projectDir, dispatchId)
})

ipcMain.handle('dispatches:update-summary', (_event, projectDir: string, dispatchId: string, summary: string) => {
  return updateDispatchSummary(projectDir, dispatchId, summary)
})

ipcMain.handle('dispatches:resume', (_event, opts: ResumeDispatchOptions) => {
  if (!mainWindow) return { ok: false, error: 'not-found' as const }
  return resumeDispatch(mainWindow, opts)
})

ipcMain.handle('start-assistant', (_event, projectDir: string, contextMd: string, runtime: AgentRuntime, mode: AssistantMode, opts?: StartAssistantOpts) => {
  if (!mainWindow) return null
  return startAssistant(mainWindow, projectDir, contextMd, runtime, mode, opts)
})

ipcMain.on('stop-assistant', () => {
  stopAllAssistants()
})

ipcMain.on('stop-assistant-mode', (_event, mode: AssistantMode) => {
  stopAssistantMode(mode)
})

ipcMain.handle('assistant:list-sessions', (_event, projectDir: string, mode: AssistantMode) => {
  return listAssistantSessions(projectDir, mode)
})

ipcMain.handle('assistant:delete-session', (_event, projectDir: string, mode: AssistantMode, sessionId: string) => {
  return deleteAssistantSession(projectDir, mode, sessionId)
})

ipcMain.handle('assistant:update-session-summary', (_event, projectDir: string, mode: AssistantMode, sessionId: string, summary: string) => {
  return updateAssistantSessionSummary(projectDir, mode, sessionId, summary)
})

ipcMain.handle('terminal:spawn-shell', (_event, cwd: string, opts?: { force?: boolean }) => {
  if (!mainWindow) return null
  return spawnShellSession(mainWindow, cwd ?? app.getPath('home'), opts)
})

ipcMain.on('terminal:input', (_event, id: string, data: string) => {
  writeToTerminal(id, data)
})

ipcMain.on('terminal:set-user-control', (_event, id: string, hasControl: boolean) => {
  setUserControl(id, hasControl)
})

ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => {
  resizeTerminal(id, cols, rows)
})

ipcMain.on('terminal:kill-all', () => {
  killAll()
})

ipcMain.handle('terminal:close', (_event, id: string) => {
  return closeTerminal(id)
})

ipcMain.handle('terminal:capture-state', (_event, id: string) => {
  return getCaptureState(id)
})

// ── Terminal popout windows ────────────────────────────────────────────────

ipcMain.handle('terminal:popout', (_event, opts: { id: string; label: string; runtime: string }) => {
  const existing = popouts.get(opts.id)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return { ok: true }
  }

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    backgroundColor: '#0d0d0d',
    title: opts.label,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  popouts.set(opts.id, win)
  win.on('closed', () => {
    popouts.delete(opts.id)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:popout-closed', { id: opts.id })
    }
  })

  const params = `popout=${encodeURIComponent(opts.id)}&label=${encodeURIComponent(opts.label)}&runtime=${encodeURIComponent(opts.runtime)}`
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${params}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { search: params })
  }
  return { ok: true }
})

ipcMain.handle('terminal:dock', (_event, id: string) => {
  const win = popouts.get(id)
  if (win && !win.isDestroyed()) win.close()
  return { ok: true }
})

// ── Terminal layout persistence ────────────────────────────────────────────

ipcMain.handle('terminal-layout:load', (_event, projectDir: string) => {
  try {
    const raw = fs.readFileSync(path.join(projectDir, 'ARCHITECT', 'terminal-layout.json'), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
})

ipcMain.handle('terminal-layout:save', (_event, projectDir: string, json: unknown) => {
  try {
    const dir = path.join(projectDir, 'ARCHITECT')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'terminal-layout.json'), JSON.stringify(json, null, 2), 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
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
