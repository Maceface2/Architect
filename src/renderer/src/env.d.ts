import type { AgentRuntime } from '../../shared/agentRuntimes'
import type { ProjectSettings } from './types'

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
    dispatchContext?: unknown
  ) => Promise<TerminalInfo[]>
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
  }
  zone: {
    getSession: (
      projectDir: string,
      label: string,
    ) => Promise<{ runtime: AgentRuntime; sessionId: string; capturedAt: string } | null>
    resume: (opts: {
      projectDir: string
      zoneId: string
      label: string
      runtime: AgentRuntime
      model?: string
      envVars?: Array<{ key: string; value: string }>
    }) => Promise<{ ok: boolean; reason?: string; info?: TerminalInfo; sessionId?: string }>
    onSessionCaptured: (
      cb: (event: { zoneSafe: string; zoneId: string; sessionId: string; runtime: AgentRuntime }) => void,
    ) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
  }
}

export {}
