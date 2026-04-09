import { contextBridge, ipcRenderer } from 'electron'
import type { RunGraphOptions } from '../shared/graphDispatch'

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // File system
  readDir: (dirPath: string) => ipcRenderer.invoke('read-dir', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  readOutputs: (outputsDir: string) => ipcRenderer.invoke('read-outputs', outputsDir),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  openDirectory: () => ipcRenderer.invoke('open-directory'),

  // Canvas persistence
  saveCanvas: (projectDir: string, data: string) => ipcRenderer.invoke('save-canvas', projectDir, data),
  loadCanvas: (projectDir: string) => ipcRenderer.invoke('load-canvas', projectDir),

  // Custom component discovery
  scanComponents: (dirPath: string) => ipcRenderer.invoke('scan-components', dirPath),

  // Graph execution
  runGraph: (nodes: unknown[], edges: unknown[], cwd: string, settings: unknown, options?: RunGraphOptions) =>
    ipcRenderer.invoke('run-graph', nodes, edges, cwd, settings, options),

  // Architecture assistant
  assistant: {
    start: (projectDir: string, contextMd: string, runtime: unknown) =>
      ipcRenderer.invoke('start-assistant', projectDir, contextMd, runtime),
    stop: () =>
      ipcRenderer.send('stop-assistant'),
  },

  // Terminal I/O
  terminal: {
    input: (id: string, data: string) =>
      ipcRenderer.send('terminal:input', id, data),

    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('terminal:resize', id, cols, rows),

    killAll: () =>
      ipcRenderer.send('terminal:kill-all'),

    onData: (cb: (event: { id: string; data: string }) => void) => {
      const handler = (_: unknown, event: { id: string; data: string }) => cb(event)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },

    onExit: (cb: (event: { id: string; exitCode: number }) => void) => {
      const handler = (_: unknown, event: { id: string; exitCode: number }) => cb(event)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    },
  },
})
