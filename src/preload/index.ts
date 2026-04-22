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
  runGraph: (
    nodes: unknown[],
    edges: unknown[],
    cwd: string,
    settings: unknown,
    dispatch: { userPrompt: string; model?: string; planMode?: boolean; onlyZoneIds?: string[] },
    dispatchContext?: unknown,
  ) =>
    ipcRenderer.invoke('run-graph', nodes, edges, cwd, settings, dispatch, dispatchContext),

  // Dispatch history
  dispatches: {
    list: (projectDir: string) => ipcRenderer.invoke('dispatches:list', projectDir),
    delete: (projectDir: string, dispatchId: string) =>
      ipcRenderer.invoke('dispatches:delete', projectDir, dispatchId),
    updateSummary: (projectDir: string, dispatchId: string, summary: string) =>
      ipcRenderer.invoke('dispatches:update-summary', projectDir, dispatchId, summary),
    resume: (opts: {
      projectDir: string
      dispatchId: string
      nodes: unknown[]
      edges: unknown[]
      settings: unknown
    }) => ipcRenderer.invoke('dispatches:resume', opts),
  },

  // Architecture assistant
  assistant: {
    start: (projectDir: string, contextMd: string, runtime: unknown, mode: unknown) =>
      ipcRenderer.invoke('start-assistant', projectDir, contextMd, runtime, mode),
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

    close: (id: string) =>
      ipcRenderer.invoke('terminal:close', id),

    getCaptureState: (id: string) =>
      ipcRenderer.invoke('terminal:capture-state', id),

    onCaptureState: (cb: (event: { id: string; state: 'pending' | 'ready' }) => void) => {
      const handler = (_: unknown, event: { id: string; state: 'pending' | 'ready' }) => cb(event)
      ipcRenderer.on('terminal:capture-state', handler)
      return () => ipcRenderer.removeListener('terminal:capture-state', handler)
    },

    onStatus: (
      cb: (event: {
        id: string
        status: 'spawning' | 'ready' | 'running' | 'finished' | 'failed'
        lastError: { kind: string; message: string; ts: number } | null
      }) => void,
    ) => {
      const handler = (
        _: unknown,
        event: {
          id: string
          status: 'spawning' | 'ready' | 'running' | 'finished' | 'failed'
          lastError: { kind: string; message: string; ts: number } | null
        },
      ) => cb(event)
      ipcRenderer.on('terminal:status', handler)
      return () => ipcRenderer.removeListener('terminal:status', handler)
    },

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

    onSpawned: (cb: (info: { id: string; label: string; runtime: string }) => void) => {
      const handler = (_: unknown, info: { id: string; label: string; runtime: string }) => cb(info)
      ipcRenderer.on('terminal:spawned', handler)
      return () => ipcRenderer.removeListener('terminal:spawned', handler)
    },
  },

  // Terminal layout persistence (per project)
  loadTerminalLayout: (projectDir: string) =>
    ipcRenderer.invoke('terminal-layout:load', projectDir),
  saveTerminalLayout: (projectDir: string, json: unknown) =>
    ipcRenderer.invoke('terminal-layout:save', projectDir, json),

  // Per-zone session history + launch
  zone: {
    listSessions: (projectDir: string, zoneId: string, label?: string) =>
      ipcRenderer.invoke('zone:list-sessions', projectDir, zoneId, label),

    deleteSession: (projectDir: string, zoneId: string, sessionId: string, label?: string) =>
      ipcRenderer.invoke('zone:delete-session', projectDir, zoneId, sessionId, label),

    updateSessionSummary: (projectDir: string, zoneId: string, sessionId: string, summary: string, label?: string) =>
      ipcRenderer.invoke('zone:update-session-summary', projectDir, zoneId, sessionId, summary, label),

    resetSession: (opts: { projectDir: string; zoneId: string; label?: string }) =>
      ipcRenderer.invoke('zone:reset-session', opts.projectDir, opts.zoneId, opts.label),

    launch: (opts: {
      projectDir: string
      zoneId: string
      nodes: unknown[]
      edges: unknown[]
      mode: 'new' | 'resume'
      sessionId?: string
      summary?: string
      userPrompt?: string
      model?: string
      planMode?: boolean
      settings: unknown
    }) => ipcRenderer.invoke('terminal:run-zone', opts),

    onSessionCaptured: (
      cb: (event: { zoneKey: string; zoneId: string; sessionId: string; runtime: string; summary: string; dispatchId?: string }) => void,
    ) => {
      const handler = (_: unknown, event: { zoneKey: string; zoneId: string; sessionId: string; runtime: string; summary: string; dispatchId?: string }) => cb(event)
      ipcRenderer.on('zone:session-captured', handler)
      return () => ipcRenderer.removeListener('zone:session-captured', handler)
    },
  },

  // Mailbox observability — emits one event per inbox/outbox write so the
  // renderer can reflect message flow in real time. Payload is intentionally
  // light (ids + type); consumers read the dispatch's _index.json for the
  // full snapshot.
  mailbox: {
    onActivity: (
      cb: (event: {
        dispatchId: string
        participantId: string
        direction: 'inbox' | 'outbox'
        filename: string
        msgId?: string
        type?: string
        from?: string
        to?: string
      }) => void,
    ) => {
      const handler = (_: unknown, event: {
        dispatchId: string
        participantId: string
        direction: 'inbox' | 'outbox'
        filename: string
        msgId?: string
        type?: string
        from?: string
        to?: string
      }) => cb(event)
      ipcRenderer.on('mailbox:activity', handler)
      return () => ipcRenderer.removeListener('mailbox:activity', handler)
    },
  },
})
