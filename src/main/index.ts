import { app, shell, BrowserWindow, ipcMain, dialog, nativeImage, Menu } from 'electron'
import { join } from 'path'
import fs from 'fs'
import path from 'path'
import type { ActivityEvent } from './orchestrator/activity'
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
  killAllIncludingShells,
  closeTerminal,
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
import { registerAuthIpc, setAuthMainWindow, setAuthLogoutHandler } from './auth'
import { detectRuntimes, getDetected, rescanRuntimes, refreshCliPromptModels } from './runtimeDetection'
import { initAutoUpdater, checkForUpdatesManual, quitAndInstall } from './updater'
import { logMain, getMainLogPath } from './logger'
import { bundleBugReport } from './bugReport'
import type { AgentRuntime, AssistantMode } from '../shared/agentRuntimes'

app.name = 'Architect'
app.setName('Architect')
process.title = 'Architect'

process.on('uncaughtException', (err) => {
  logMain('error', 'uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  logMain('error', 'unhandledRejection', reason)
})
app.on('render-process-gone', (_event, _wc, details) => {
  logMain('error', `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
})
app.on('child-process-gone', (_event, details) => {
  logMain('error', `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
})

const iconPath = join(__dirname, '../../resources/icon.png')
const CANVAS_FILENAME = 'architect-canvas.json'
const ARCHITECT_DIRNAME = 'ARCHITECT'
const IGNORED_PROJECT_ENTRIES = new Set(['.DS_Store'])

let mainWindow: BrowserWindow | null = null
interface CanvasWatcherEntry {
  watcher: fs.FSWatcher
  timer: ReturnType<typeof setTimeout> | null
}
const canvasWatchers = new Map<string, CanvasWatcherEntry>()
const popouts = new Map<string, BrowserWindow>()

function emitCanvasChanged(projectDir: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const raw = fs.readFileSync(path.join(projectDir, CANVAS_FILENAME), 'utf-8')
    mainWindow.webContents.send('canvas:changed', { projectDir, raw })
  } catch {}
}

function stopCanvasWatcher(projectDir?: string) {
  if (typeof projectDir === 'string') {
    const entry = canvasWatchers.get(projectDir)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    try { entry.watcher.close() } catch {}
    canvasWatchers.delete(projectDir)
    return
  }
  for (const entry of canvasWatchers.values()) {
    if (entry.timer) clearTimeout(entry.timer)
    try { entry.watcher.close() } catch {}
  }
  canvasWatchers.clear()
}

function startCanvasWatcher(projectDir: string) {
  if (canvasWatchers.has(projectDir)) return
  try {
    const entry: CanvasWatcherEntry = {
      watcher: fs.watch(projectDir, (_eventType, filename) => {
        if (filename && filename !== CANVAS_FILENAME) return
        const current = canvasWatchers.get(projectDir)
        if (!current) return
        if (current.timer) clearTimeout(current.timer)
        current.timer = setTimeout(() => {
          const live = canvasWatchers.get(projectDir)
          if (!live) return
          live.timer = null
          emitCanvasChanged(projectDir)
        }, 120)
      }),
      timer: null,
    }
    canvasWatchers.set(projectDir, entry)
  } catch {}
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const send = (action: string) => () => mainWindow?.webContents.send('menu:action', action)

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: send('open-folder') },
        { type: 'separator' as const },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { type: 'separator' as const },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    { role: 'viewMenu' as const },
    { role: 'windowMenu' as const },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
    // macOS: keep the traffic lights but drop the native title bar strip.
    // Lights inset over TopNav row 1; the renderer reserves padding-left + a
    // drag region so the user can grab the bar to move the window.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
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
  mainWindow.on('closed', () => { stopCanvasWatcher(); killAll(); setAuthMainWindow(null); mainWindow = null })

  setAuthMainWindow(mainWindow)

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

ipcMain.handle('inspect-project', (_event, projectDir: string) => {
  const architectDir = path.join(projectDir, ARCHITECT_DIRNAME)
  const canvasFile = path.join(projectDir, CANVAS_FILENAME)
  let hasArchitectDir = false
  let hasCanvasFile = false
  let projectIsNonEmpty = false
  let canvasIsEmpty = false

  try { hasArchitectDir = fs.statSync(architectDir).isDirectory() } catch {}
  try { hasCanvasFile = fs.statSync(canvasFile).isFile() } catch {}

  try {
    projectIsNonEmpty = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .some(entry => entry.name !== ARCHITECT_DIRNAME && !IGNORED_PROJECT_ENTRIES.has(entry.name))
  } catch {
    projectIsNonEmpty = false
  }

  if (hasCanvasFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(canvasFile, 'utf-8')) as {
        nodes?: unknown
        edges?: unknown
      }
      const nodeCount = Array.isArray(raw.nodes) ? raw.nodes.length : 0
      const edgeCount = Array.isArray(raw.edges) ? raw.edges.length : 0
      canvasIsEmpty = nodeCount === 0 && edgeCount === 0
    } catch {
      canvasIsEmpty = false
    }
  }

  return { projectIsNonEmpty, hasArchitectDir, hasCanvasFile, canvasIsEmpty }
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

ipcMain.handle('unwatch-canvas', (_event, projectDir?: string) => {
  stopCanvasWatcher(projectDir)
})

// Workspace persistence: list of additional folders co-loaded with the
// primary anchor. Stored at <primary>/ARCHITECT/workspace.json. Primary is
// implicit (the anchor that owns the workspace.json file), so the file
// only ever holds the *other* folders.
const WORKSPACE_FILENAME = 'workspace.json'

interface WorkspaceFile {
  folders: Array<{ path: string }>
}

ipcMain.handle('workspace:load', (_event, primaryDir: string): WorkspaceFile => {
  try {
    const raw = fs.readFileSync(
      path.join(primaryDir, ARCHITECT_DIRNAME, WORKSPACE_FILENAME),
      'utf-8',
    )
    const parsed = JSON.parse(raw) as Partial<WorkspaceFile>
    const folders = Array.isArray(parsed.folders)
      ? parsed.folders
          .filter((f): f is { path: string } => !!f && typeof f.path === 'string')
          .map(f => ({ path: f.path }))
      : []
    return { folders }
  } catch {
    return { folders: [] }
  }
})

ipcMain.handle(
  'workspace:save',
  (_event, primaryDir: string, folders: Array<{ path: string }>) => {
    try {
      const dir = path.join(primaryDir, ARCHITECT_DIRNAME)
      fs.mkdirSync(dir, { recursive: true })
      const safe: WorkspaceFile = {
        folders: (Array.isArray(folders) ? folders : [])
          .filter((f): f is { path: string } => !!f && typeof f.path === 'string')
          .map(f => ({ path: f.path })),
      }
      fs.writeFileSync(
        path.join(dir, WORKSPACE_FILENAME),
        JSON.stringify(safe, null, 2),
        'utf-8',
      )
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: String(err) }
    }
  },
)

// ── Terminal IPC ───────────────────────────────────────────────────────────

ipcMain.handle('dispatch:start', (_event, nodes, edges, cwd, settings, dispatch: StartDispatchOptions) => {
  if (!mainWindow) return []
  return startDispatch(mainWindow, nodes, edges, cwd ?? app.getPath('home'), settings, dispatch ?? { userPrompt: '' })
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

// Defense-in-depth check on the dispatchId IPC argument. Renderer is trusted
// today, but joining an attacker-controlled `../` into the runtime path would
// let any caller read arbitrary JSONL files outside ARCHITECT/runtime/. A
// dispatchId is a UUID-like token in practice — slashes, backslashes, NUL,
// and parent refs have no legitimate use.
function isSafeDispatchId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return false
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return false
  if (id === '.' || id === '..' || id.includes('..')) return false
  return true
}

// Read every persisted activity-log line for a dispatch, oldest first.
// Used so the swimlane shows the previous session's history when a user
// resumes a dispatch — without it, the wipe in setupWorkspaceV5 would
// drop those lines before the new run starts.
ipcMain.handle('dispatches:load-activity', async (_event, projectDir: string, dispatchId: string) => {
  if (!isSafeDispatchId(dispatchId)) return []
  const fsMod = await import('fs')
  const pathMod = await import('path')
  const { activityDir, readAllActivity } = await import('./orchestrator/activity')
  const dir = activityDir(projectDir, dispatchId)
  let entries: string[] = []
  try {
    entries = fsMod.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
  } catch {
    return [] as Array<{ participantId: string; event: ActivityEvent }>
  }
  const out: Array<{ participantId: string; event: ActivityEvent }> = []
  for (const file of entries) {
    const participantId = file.replace(/\.jsonl$/, '')
    const events = readAllActivity(pathMod.join(dir, file), participantId)
    for (const event of events) out.push({ participantId, event })
  }
  out.sort((a, b) => {
    const aTs = Date.parse(a.event.ts)
    const bTs = Date.parse(b.event.ts)
    // Treat unparseable ts as 0 so they sort to the head rather than producing
    // NaN comparisons (which leave order undefined).
    return (Number.isFinite(aTs) ? aTs : 0) - (Number.isFinite(bTs) ? bTs : 0)
  })
  return out
})

// Sibling of dispatches:load-activity for the harness-only orchestration log.
// Lets the renderer seed the swimlane on resume with prior-session decisions
// (status transitions, retries, conductor decisions, etc.) before the wipe.
ipcMain.handle('dispatches:load-orchestration', async (_event, projectDir: string, dispatchId: string) => {
  if (!isSafeDispatchId(dispatchId)) return []
  const { orchestrationLogPath, readAllOrchestration } = await import('./orchestrator/orchestrationLog')
  return readAllOrchestration(orchestrationLogPath(projectDir, dispatchId))
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

// ── Terminal page popout (entire panel, singleton) ─────────────────────────
//
// A separate BrowserWindow that owns the full TerminalPanel UI while open.
// Main window state (sessions + layout) is forwarded via two IPC channels:
//   - terminal-page:publish-sessions   (main window → main proc → popout)
//   - terminal-page:publish-layout     (any window  → main proc → other window)
// The cache below holds the last-published snapshot so a freshly-opened
// popout can render immediately without round-tripping for the data.

let terminalPagePopout: BrowserWindow | null = null
let terminalPageSessionsCache: unknown = null
let terminalPageLayoutCache: unknown = null
let terminalPageProjectDirCache: string = ''
let terminalPageThemeCache: 'dark' | 'light' = 'dark'

function broadcastToTerminalPagePeers(channel: string, payload: unknown, except?: BrowserWindow): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow !== except) {
    mainWindow.webContents.send(channel, payload)
  }
  if (terminalPagePopout && !terminalPagePopout.isDestroyed() && terminalPagePopout !== except) {
    terminalPagePopout.webContents.send(channel, payload)
  }
}

interface TerminalPagePopoutOpts {
  sessions: unknown
  layout: unknown
  projectDir: string
  theme: 'dark' | 'light'
}

ipcMain.handle('terminal-page:popout', (_event, opts: TerminalPagePopoutOpts) => {
  if (terminalPagePopout && !terminalPagePopout.isDestroyed()) {
    terminalPagePopout.focus()
    return { ok: true }
  }

  // Seed the cache with whatever main window had at popout time so the
  // popout's first render has the full session/layout snapshot available
  // by the time it asks for it.
  terminalPageSessionsCache = opts.sessions
  terminalPageLayoutCache = opts.layout
  terminalPageProjectDirCache = opts.projectDir ?? ''
  terminalPageThemeCache = opts.theme === 'light' ? 'light' : 'dark'

  const win = new BrowserWindow({
    width: 1200,
    height: 720,
    backgroundColor: '#0d0d0d',
    title: 'Terminal',
    // Match the main window's macOS chrome: traffic lights inset over the
    // app's own title bar so the renderer can paint a tab strip flush
    // against the top edge with the lights tucked into its left padding.
    titleBarStyle: 'hiddenInset',
    // Title bar is a 6px drag micro-strip + the tab row underneath. y=14
    // visually centers the lights against the tab content while leaving
    // the micro-strip clear above for click-and-drag grabs.
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  terminalPagePopout = win
  win.on('closed', () => {
    terminalPagePopout = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-page:closed', { layout: terminalPageLayoutCache })
    }
  })

  const params = `panel=terminal-page`
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${params}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { search: params })
  }
  return { ok: true }
})

ipcMain.handle('terminal-page:dock', () => {
  if (terminalPagePopout && !terminalPagePopout.isDestroyed()) {
    terminalPagePopout.close()
  }
  return { ok: true }
})

// Returns the cached snapshot. The popout window asks for this once after
// mount because `did-finish-load` fires before its IPC subscribers attach.
ipcMain.handle('terminal-page:request-initial', () => {
  return {
    sessions: terminalPageSessionsCache,
    layout: terminalPageLayoutCache,
    projectDir: terminalPageProjectDirCache,
    theme: terminalPageThemeCache,
  }
})

// Sender publishes its sessions list. We cache + forward to peer windows.
ipcMain.on('terminal-page:publish-sessions', (event, sessions: unknown) => {
  terminalPageSessionsCache = sessions
  const sender = BrowserWindow.fromWebContents(event.sender) ?? undefined
  broadcastToTerminalPagePeers('terminal-page:sessions', sessions, sender)
})

// Same pattern for layout.
ipcMain.on('terminal-page:publish-layout', (event, layout: unknown) => {
  terminalPageLayoutCache = layout
  const sender = BrowserWindow.fromWebContents(event.sender) ?? undefined
  broadcastToTerminalPagePeers('terminal-page:layout', layout, sender)
})

// Theme broadcast from main window. The popout mirrors it via the same bus
// so a theme flip in the parent app updates the detached terminal page too.
ipcMain.on('terminal-page:publish-theme', (event, theme: unknown) => {
  const next = theme === 'light' ? 'light' : 'dark'
  terminalPageThemeCache = next
  const sender = BrowserWindow.fromWebContents(event.sender) ?? undefined
  broadcastToTerminalPagePeers('terminal-page:theme', next, sender)
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

// ── Auth IPC ───────────────────────────────────────────────────────────────

function closeAllPopouts() {
  for (const win of popouts.values()) {
    try {
      if (!win.isDestroyed()) win.close()
    } catch {}
  }
  popouts.clear()
  if (terminalPagePopout && !terminalPagePopout.isDestroyed()) {
    try { terminalPagePopout.close() } catch {}
  }
  terminalPagePopout = null
}

registerAuthIpc()
setAuthLogoutHandler(() => {
  killAllIncludingShells()
  closeAllPopouts()
})

// ── Runtime detection IPC ──────────────────────────────────────────────────

ipcMain.handle('runtime:get-detected', () => getDetected())
ipcMain.handle('runtime:rescan', () => rescanRuntimes())
ipcMain.handle('runtime:refresh-models', () => refreshCliPromptModels())

// ── Update IPC ─────────────────────────────────────────────────────────────

ipcMain.handle('update:check', () => checkForUpdatesManual())
ipcMain.handle('update:install', () => { quitAndInstall() })
ipcMain.handle('app:get-version', () => app.getVersion())

// ── Bug report IPC ─────────────────────────────────────────────────────────

ipcMain.handle('bugreport:bundle', (_event, args: {
  userMessage: string
  rendererLogs: string
  projectDir: string | null
  activeDispatchId: string | null
  includeLogs: boolean
}) => {
  return bundleBugReport({
    userMessage: args.userMessage,
    rendererLogs: args.rendererLogs,
    projectDir: args.projectDir,
    activeDispatchId: args.activeDispatchId,
    appVersion: app.getVersion(),
    includeLogs: args.includeLogs,
  })
})

ipcMain.handle('bugreport:save-to-file', (_event, args: { text: string }) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(app.getPath('downloads'), `architect-bug-report-${stamp}.txt`)
  try {
    fs.writeFileSync(file, args.text, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Couldn't save bug report to ${file}: ${msg}`)
  }
  shell.showItemInFolder(file)
  return file
})

ipcMain.handle('bugreport:get-log-path', () => getMainLogPath())

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await initShellEnv()
  // Pre-warm the runtime cache before the renderer mounts so its first
  // getDetected() call returns a populated snapshot synchronously.
  await detectRuntimes()
  initAutoUpdater()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopCanvasWatcher()
  if (process.platform !== 'darwin') app.quit()
})
