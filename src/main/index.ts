import { app, shell, BrowserWindow, ipcMain, dialog, nativeImage } from 'electron'
import { join } from 'path'
import fs from 'fs'
import path from 'path'

app.name = 'Architect'
app.setName('Architect')

const iconPath = join(__dirname, '../../resources/icon.png')

function createWindow(): void {
  const icon = nativeImage.createFromPath(iconPath)

  const mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => mainWindow.show())

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

ipcMain.handle('get-home-dir', () => app.getPath('home'))

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
    properties: ['openDirectory']
  })
  return result.filePaths[0] ?? null
})

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
