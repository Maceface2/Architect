import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // File system
  readDir: (dirPath: string) => ipcRenderer.invoke('read-dir', dirPath),
  openDirectory: () => ipcRenderer.invoke('open-directory'),

  // Canvas persistence
  saveCanvas: (projectDir: string, data: string) => ipcRenderer.invoke('save-canvas', projectDir, data),
  loadCanvas: (projectDir: string) => ipcRenderer.invoke('load-canvas', projectDir),
  watchCanvas: (projectDir: string) => ipcRenderer.invoke('watch-canvas', projectDir),
  unwatchCanvas: () => ipcRenderer.invoke('unwatch-canvas'),

  // Start a fresh multi-zone (or single-zone) dispatch. Companion is
  // dispatches.resume for replaying a prior DispatchRecord.
  startDispatch: (
    nodes: unknown[],
    edges: unknown[],
    cwd: string,
    settings: unknown,
    dispatch: { userPrompt: string; model?: string; planMode?: boolean; onlyZoneIds?: string[]; conductorRuntime?: string },
    dispatchContext?: unknown,
  ) =>
    ipcRenderer.invoke('dispatch:start', nodes, edges, cwd, settings, dispatch, dispatchContext),

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
    // `opts` (new/resume, model, seed prompt) is optional. When absent the
    // main process preserves legacy behavior (auto-resume latest reachable);
    // when present it kills this mode's PTY and respawns with the choice.
    start: (
      projectDir: string,
      contextMd: string,
      runtime: unknown,
      mode: unknown,
      opts?: {
        model?: string
        session?: { mode: 'new' } | { mode: 'resume'; sessionId: string }
        initialPrompt?: string
        force?: boolean
      },
    ) =>
      ipcRenderer.invoke('start-assistant', projectDir, contextMd, runtime, mode, opts),
    stop: () =>
      ipcRenderer.send('stop-assistant'),
    stopMode: (mode: unknown) =>
      ipcRenderer.send('stop-assistant-mode', mode),
    listSessions: (projectDir: string, mode: unknown) =>
      ipcRenderer.invoke('assistant:list-sessions', projectDir, mode),
    deleteSession: (projectDir: string, mode: unknown, sessionId: string) =>
      ipcRenderer.invoke('assistant:delete-session', projectDir, mode, sessionId),
    updateSessionSummary: (projectDir: string, mode: unknown, sessionId: string, summary: string) =>
      ipcRenderer.invoke('assistant:update-session-summary', projectDir, mode, sessionId, summary),
  },

  onCanvasChanged: (cb: (event: { projectDir: string; raw: string }) => void) => {
    const handler = (_: unknown, event: { projectDir: string; raw: string }) => cb(event)
    ipcRenderer.on('canvas:changed', handler)
    return () => ipcRenderer.removeListener('canvas:changed', handler)
  },

  // Supabase auth (main-process owned, safeStorage-backed). Renderer never
  // sees access tokens — only { userId, email } | null.
  auth: {
    getSession: () => ipcRenderer.invoke('auth:get-session'),
    login: (email: string, password: string) =>
      ipcRenderer.invoke('auth:login', email, password),
    logout: () => ipcRenderer.invoke('auth:logout'),
    onSessionChanged: (
      cb: (session: { userId: string; email: string } | null) => void,
    ) => {
      const handler = (_: unknown, session: { userId: string; email: string } | null) => cb(session)
      ipcRenderer.on('auth:session-changed', handler)
      return () => ipcRenderer.removeListener('auth:session-changed', handler)
    },
  },

  // Terminal I/O
  terminal: {
    spawnShell: (cwd: string, opts?: { force?: boolean }) =>
      ipcRenderer.invoke('terminal:spawn-shell', cwd, opts),

    input: (id: string, data: string) =>
      ipcRenderer.send('terminal:input', id, data),

    setUserControl: (id: string, hasControl: boolean) =>
      ipcRenderer.send('terminal:set-user-control', id, hasControl),

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
      cb: (event: { zoneKey: string; zoneId: string; sessionId: string; runtime: string; summary: string; model?: string; dispatchId?: string }) => void,
    ) => {
      const handler = (_: unknown, event: { zoneKey: string; zoneId: string; sessionId: string; runtime: string; summary: string; model?: string; dispatchId?: string }) => cb(event)
      ipcRenderer.on('zone:session-captured', handler)
      return () => ipcRenderer.removeListener('zone:session-captured', handler)
    },
  },

  // v5 coordination observability — one event per activity-log line, plus
  // status-transition events from the scheduler's tick loop.
  activity: {
    onEvent: (
      cb: (event: {
        dispatchId: string
        participantId: string
        event: {
          ts: string
          kind: 'task-received' | 'progress' | 'ask' | 'answer' | 'done' | 'failed' | 'note'
          taskId?: string
          content: string
          structured?: Record<string, unknown>
        }
      }) => void,
    ) => {
      const handler = (_: unknown, event: Parameters<typeof cb>[0]) => cb(event)
      ipcRenderer.on('activity:event', handler)
      return () => ipcRenderer.removeListener('activity:event', handler)
    },
    onState: (
      cb: (event: {
        dispatchId: string
        participantId: string
        status: 'starting' | 'running' | 'idle' | 'blocked' | 'failed' | 'stale' | 'exited'
        lastTaskId?: string
      }) => void,
    ) => {
      const handler = (_: unknown, event: Parameters<typeof cb>[0]) => cb(event)
      ipcRenderer.on('activity:state', handler)
      return () => ipcRenderer.removeListener('activity:state', handler)
    },
    onDispatchComplete: (
      cb: (event: { dispatchId: string; summary: string }) => void,
    ) => {
      const handler = (_: unknown, event: { dispatchId: string; summary: string }) => cb(event)
      ipcRenderer.on('dispatch:complete', handler)
      return () => ipcRenderer.removeListener('dispatch:complete', handler)
    },
  },
})
