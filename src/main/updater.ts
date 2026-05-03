import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 10_000

let initialized = false
let recheckTimer: ReturnType<typeof setInterval> | null = null
let downloadedVersion: string | null = null

type Snapshot = { channel: string; payload?: unknown }
const latestByChannel = new Map<string, Snapshot>()

function broadcast(channel: string, payload?: unknown) {
  latestByChannel.set(channel, { channel, payload })
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

function replayTo(window: BrowserWindow) {
  if (window.isDestroyed()) return
  for (const { channel, payload } of latestByChannel.values()) {
    window.webContents.send(channel, payload)
  }
}

function attachListeners() {
  autoUpdater.on('checking-for-update', () => broadcast('update:checking'))

  autoUpdater.on('update-available', (info) => {
    broadcast('update:available', {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    })
  })

  autoUpdater.on('update-not-available', () => broadcast('update:none'))

  autoUpdater.on('download-progress', (progress) => {
    broadcast('update:progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    broadcast('update:downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    broadcast('update:error', msg)
  })
}

export function initAutoUpdater() {
  if (initialized) return
  if (!app.isPackaged) return
  initialized = true

  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  attachListeners()

  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('did-finish-load', () => replayTo(win))
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] initial check failed:', err)
    })
  }, INITIAL_CHECK_DELAY_MS)

  recheckTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] periodic check failed:', err)
    })
  }, RECHECK_INTERVAL_MS)

  app.on('before-quit', () => {
    if (recheckTimer) {
      clearInterval(recheckTimer)
      recheckTimer = null
    }
  })
}

export async function checkForUpdatesManual(): Promise<{ ok: boolean; error?: string }> {
  if (!app.isPackaged) {
    return { ok: false, error: 'Updates are disabled in development.' }
  }
  try {
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function quitAndInstall() {
  if (!downloadedVersion) return
  autoUpdater.quitAndInstall()
}
