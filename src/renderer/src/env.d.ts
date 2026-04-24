import type { AgentRuntime } from '../../shared/agentRuntimes'
import type { AssistantMode, DispatchRecord, ProjectSettings, ZoneSessionRecord } from './types'

interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime | 'shell'
  coordinatedMode?: boolean
}

interface ElectronAPI {
  platform: string
  readDir: (dirPath: string) => Promise<FileEntry[]>
  readFile: (filePath: string) => Promise<string | null>
  getHomeDir: () => Promise<string>
  openDirectory: () => Promise<string | null>
  saveCanvas: (projectDir: string, data: string) => Promise<void>
  loadCanvas: (projectDir: string) => Promise<string | null>
  watchCanvas: (projectDir: string) => Promise<void>
  unwatchCanvas: () => Promise<void>
  onCanvasChanged: (cb: (event: { projectDir: string; raw: string }) => void) => () => void
  scanComponents: (dirPath: string) => Promise<unknown[]>
  startDispatch: (
    nodes: unknown[],
    edges: unknown[],
    cwd: string,
    settings: ProjectSettings,
    dispatch: { userPrompt: string; model?: string; planMode?: boolean; onlyZoneIds?: string[]; conductorRuntime?: AgentRuntime },
    dispatchContext?: unknown
  ) => Promise<TerminalInfo[]>
  dispatches: {
    list: (projectDir: string) => Promise<DispatchRecord[]>
    delete: (projectDir: string, dispatchId: string) => Promise<boolean>
    updateSummary: (projectDir: string, dispatchId: string, summary: string) => Promise<boolean>
    resume: (opts: {
      projectDir: string
      dispatchId: string
      nodes: unknown[]
      edges: unknown[]
      settings: ProjectSettings
    }) => Promise<
      | { ok: true; info: TerminalInfo[] }
      | { ok: false; error: 'not-found' | 'legacy-protocol' }
    >
  }
  assistant: {
    start: (
      projectDir: string,
      contextMd: string,
      runtime: AgentRuntime,
      mode: AssistantMode,
      opts?: {
        model?: string
        session?: { mode: 'new' } | { mode: 'resume'; sessionId: string }
        initialPrompt?: string
        force?: boolean
      },
    ) => Promise<TerminalInfo | null>
    stop: () => void
    stopMode: (mode: AssistantMode) => void
    listSessions: (projectDir: string, mode: AssistantMode) => Promise<ZoneSessionRecord[]>
    deleteSession: (projectDir: string, mode: AssistantMode, sessionId: string) => Promise<boolean>
    updateSessionSummary: (projectDir: string, mode: AssistantMode, sessionId: string, summary: string) => Promise<boolean>
  }
  terminal: {
    spawnShell: (cwd: string, opts?: { force?: boolean }) => Promise<TerminalInfo | null>
    input: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    killAll: () => void
    close: (id: string) => Promise<{ ok: boolean; reason?: string }>
    getCaptureState: (id: string) => Promise<'pending' | 'ready' | null>
    onCaptureState: (
      cb: (event: { id: string; state: 'pending' | 'ready' }) => void,
    ) => () => void
    onStatus: (
      cb: (event: {
        id: string
        status: 'spawning' | 'ready' | 'running' | 'finished' | 'failed'
        lastError: { kind: string; message: string; ts: number } | null
      }) => void,
    ) => () => void
    onData: (cb: (event: { id: string; data: string }) => void) => () => void
    onExit: (cb: (event: { id: string; exitCode: number }) => void) => () => void
    popout: (opts: { id: string; label: string; runtime: string }) => Promise<{ ok: boolean }>
    dock: (id: string) => Promise<{ ok: boolean }>
    onPopoutClosed: (cb: (event: { id: string }) => void) => () => void
    onSpawned: (cb: (info: TerminalInfo) => void) => () => void
  }
  loadTerminalLayout: (projectDir: string) => Promise<unknown>
  saveTerminalLayout: (projectDir: string, json: unknown) => Promise<{ ok: boolean; error?: string }>
  zone: {
    listSessions: (
      projectDir: string,
      zoneId: string,
      label?: string,
    ) => Promise<ZoneSessionRecord[]>
    deleteSession: (
      projectDir: string,
      zoneId: string,
      sessionId: string,
      label?: string,
    ) => Promise<boolean>
    updateSessionSummary: (
      projectDir: string,
      zoneId: string,
      sessionId: string,
      summary: string,
      label?: string,
    ) => Promise<boolean>
    resetSession: (opts: {
      projectDir: string
      zoneId: string
      label?: string
    }) => Promise<boolean>
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
      settings: ProjectSettings
    }) => Promise<{ ok: boolean; reason?: string; info?: TerminalInfo }>
    onSessionCaptured: (
      cb: (event: {
        zoneKey: string
        zoneId: string
        sessionId: string
        runtime: AgentRuntime
        summary: string
        model?: string
        dispatchId?: string
      }) => void,
    ) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
  }
}

export {}
