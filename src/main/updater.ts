import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 10_000

let initialized = false
let recheckTimer: ReturnType<typeof setInterval> | null = null
let downloadedVersion: string | null = null

function send(window: BrowserWindow, channel: string, payload?: unknown) {
  if (window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function attachListeners(window: BrowserWindow) {
  autoUpdater.on('checking-for-update', () => send(window, 'update:checking'))

  autoUpdater.on('update-available', (info) => {
    send(window, 'update:available', {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    })
  })

  autoUpdater.on('update-not-available', () => send(window, 'update:none'))

  autoUpdater.on('download-progress', (progress) => {
    send(window, 'update:progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    send(window, 'update:downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    send(window, 'update:error', msg)
  })
}

export function initAutoUpdater(window: BrowserWindow) {
  if (initialized) return
  if (!app.isPackaged) return
  initialized = true

  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  attachListeners(window)

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
