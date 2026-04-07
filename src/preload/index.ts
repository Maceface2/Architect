import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  readDir: (dirPath: string) => ipcRenderer.invoke('read-dir', dirPath),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  openDirectory: () => ipcRenderer.invoke('open-directory'),
})
