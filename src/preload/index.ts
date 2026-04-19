import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // File system
  readDir: (dirPath: string) => ipcRenderer.invoke('read-dir', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  openDirectory: () => ipcRenderer.invoke('open-directory'),

  // Canvas persistence
  saveCanvas: (projectDir: string, data: string) => ipcRenderer.invoke('save-canvas', projectDir, data),
  loadCanvas: (projectDir: string) => ipcRenderer.invoke('load-canvas', projectDir),
  watchCanvas: (projectDir: string) => ipcRenderer.invoke('watch-canvas', projectDir),
  unwatchCanvas: () => ipcRenderer.invoke('unwatch-canvas'),

  // Custom component discovery
  scanComponents: (dirPath: string) => ipcRenderer.invoke('scan-components', dirPath),

  // Graph execution
  runGraph: (nodes: unknown[], edges: unknown[], cwd: string, settings: unknown, dispatchContext?: unknown) =>
    ipcRenderer.invoke('run-graph', nodes, edges, cwd, settings, dispatchContext),

  // Architecture assistant
  assistant: {
    start: (projectDir: string, contextMd: string, runtime: unknown) =>
      ipcRenderer.invoke('start-assistant', projectDir, contextMd, runtime),
    stop: () =>
      ipcRenderer.send('stop-assistant'),
  },

  onCanvasChanged: (cb: (event: { projectDir: string; raw: string }) => void) => {
    const handler = (_: unknown, event: { projectDir: string; raw: string }) => cb(event)
    ipcRenderer.on('canvas:changed', handler)
    return () => ipcRenderer.removeListener('canvas:changed', handler)
  },

  // Terminal I/O
  terminal: {
    spawnShell: (cwd: string) =>
      ipcRenderer.invoke('terminal:spawn-shell', cwd),

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

    popout: (opts: { id: string; label: string; runtime: string }) =>
      ipcRenderer.invoke('terminal:popout', opts),

    dock: (id: string) =>
      ipcRenderer.invoke('terminal:dock', id),

    onPopoutClosed: (cb: (event: { id: string }) => void) => {
      const handler = (_: unknown, event: { id: string }) => cb(event)
      ipcRenderer.on('terminal:popout-closed', handler)
      return () => ipcRenderer.removeListener('terminal:popout-closed', handler)
    },
  },

  // Terminal layout persistence (per project)
  loadTerminalLayout: (projectDir: string) =>
    ipcRenderer.invoke('terminal-layout:load', projectDir),
  saveTerminalLayout: (projectDir: string, json: unknown) =>
    ipcRenderer.invoke('terminal-layout:save', projectDir, json),

  // Per-zone Claude session capture/resume
  zone: {
    getSession: (projectDir: string, label: string) =>
      ipcRenderer.invoke('zone:get-session', projectDir, label),

    resume: (opts: {
      projectDir: string
      zoneId: string
      label: string
      runtime: string
      model?: string
      envVars?: Array<{ key: string; value: string }>
    }) => ipcRenderer.invoke('zone:resume', opts),

    onSessionCaptured: (
      cb: (event: { zoneSafe: string; zoneId: string; sessionId: string; runtime: string }) => void,
    ) => {
      const handler = (_: unknown, event: { zoneSafe: string; zoneId: string; sessionId: string; runtime: string }) => cb(event)
      ipcRenderer.on('zone:session-captured', handler)
      return () => ipcRenderer.removeListener('zone:session-captured', handler)
    },
  },
})
