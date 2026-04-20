import type { AgentRuntime } from '../../shared/agentRuntimes'
import type { DispatchRecord, ProjectSettings } from './types'

interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime | 'shell'
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
  runGraph: (
    nodes: unknown[],
    edges: unknown[],
    cwd: string,
    settings: ProjectSettings,
    dispatch: { userPrompt: string; model?: string; planMode?: boolean; onlyZoneIds?: string[] },
    dispatchContext?: unknown
  ) => Promise<TerminalInfo[]>
  listDispatches: (projectDir: string) => Promise<DispatchRecord[]>
  assistant: {
    start: (projectDir: string, contextMd: string, runtime: AgentRuntime) => Promise<TerminalInfo | null>
    stop: () => void
  }
  terminal: {
    spawnShell: (cwd: string) => Promise<TerminalInfo | null>
    input: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    killAll: () => void
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
    getSession: (
      projectDir: string,
      zoneId: string,
      label?: string,
    ) => Promise<{ runtime: AgentRuntime; sessionId: string; capturedAt: string } | null>
    resume: (opts: {
      projectDir: string
      zoneId: string
      label: string
      runtime: AgentRuntime
      model?: string
      envVars?: Array<{ key: string; value: string }>
    }) => Promise<{ ok: boolean; reason?: string; info?: TerminalInfo; sessionId?: string }>
    resetSession: (opts: {
      projectDir: string
      zoneId: string
      label?: string
    }) => Promise<boolean>
    run: (opts: {
      projectDir: string
      zoneId: string
      nodes: unknown[]
      edges: unknown[]
      userPrompt: string
      model?: string
      planMode?: boolean
      settings: ProjectSettings
    }) => Promise<TerminalInfo | null>
    onSessionCaptured: (
      cb: (event: { zoneKey: string; zoneId: string; sessionId: string; runtime: AgentRuntime }) => void,
    ) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
  }
}

export {}
