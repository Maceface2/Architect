/// <reference types="vite/client" />
// vite/client gives ImportMeta { env, hot } typings — needed for both the
// RENDERER_VITE_* env reads in App.tsx and the import.meta.hot HMR guard
// in lib/activityStore.ts.

import type { AgentRuntime } from '../../shared/agentRuntimes'
import type {
  AuthLoginResult,
  FileEntry,
  SessionInfo,
  TerminalInfo,
} from '../../shared/electronTypes'
import type { AssistantMode, DispatchRecord, ProjectSettings, ZoneSessionRecord } from './types'

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
  auth: {
    getSession: () => Promise<SessionInfo | null>
    login: (email: string, password: string) => Promise<AuthLoginResult>
    logout: () => Promise<{ ok: boolean }>
    onSessionChanged: (cb: (session: SessionInfo | null) => void) => () => void
  }
  startDispatch: (
    nodes: unknown[],
    edges: unknown[],
    cwd: string,
    settings: ProjectSettings,
    dispatch: { userPrompt: string; model?: string; planMode?: boolean; onlyZoneIds?: string[]; conductorRuntime?: AgentRuntime },
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
    loadActivity: (
      projectDir: string,
      dispatchId: string,
    ) => Promise<Array<{
      participantId: string
      event: {
        ts: string
        from: string
        kind: 'task-received' | 'progress' | 'ask' | 'answer' | 'done' | 'failed' | 'note'
        taskId?: string
        content: string
        structured?: Record<string, unknown>
      }
    }>>
    loadOrchestration: (
      projectDir: string,
      dispatchId: string,
    ) => Promise<Array<{
      ts: string
      kind:
        | 'dispatch-started'
        | 'task-dispatched' | 'task-superseded' | 'task-retried' | 'task-exhausted'
        | 'task-answered' | 'all-done-detected' | 'conductor-decision' | 'assign-rejected'
        | 'premature-final' | 'pty-exit' | 'status-change' | 'stale-escalation'
        | 'unassigned-ask-dropped' | 'deadlock-detected' | 'redispatched'
      participantId?: string
      taskId?: string
      summary: string
      structured?: Record<string, unknown>
    }>>
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
    setUserControl: (id: string, hasControl: boolean) => void
    resize: (id: string, cols: number, rows: number) => void
    killAll: () => void
    close: (id: string) => Promise<{ ok: boolean; reason?: string }>
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
  terminalPage: {
    popout: (snapshot: {
      sessions: TerminalInfo[]
      layout: unknown
      projectDir: string
      theme: 'dark' | 'light'
    }) => Promise<{ ok: boolean }>
    dock: () => Promise<{ ok: boolean }>
    requestInitial: () => Promise<{
      sessions: TerminalInfo[] | null
      layout: unknown
      projectDir: string
      theme: 'dark' | 'light'
    }>
    publishSessions: (sessions: TerminalInfo[]) => void
    publishLayout: (layout: unknown) => void
    publishTheme: (theme: 'dark' | 'light') => void
    onSessions: (cb: (sessions: TerminalInfo[]) => void) => () => void
    onLayout: (cb: (layout: unknown) => void) => () => void
    onTheme: (cb: (theme: 'dark' | 'light') => void) => () => void
    onClosed: (cb: (event: { layout: unknown }) => void) => () => void
  }
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
    ) => () => void
    onState: (
      cb: (event: {
        dispatchId: string
        participantId: string
        status: 'starting' | 'running' | 'idle' | 'blocked' | 'failed' | 'stale' | 'exited'
        lastTaskId?: string
      }) => void,
    ) => () => void
    onDispatchComplete: (
      cb: (event: { dispatchId: string; summary: string }) => void,
    ) => () => void
    onOrchestration: (
      cb: (event: {
        dispatchId: string
        event: {
          ts: string
          kind:
            | 'dispatch-started'
            | 'task-dispatched' | 'task-superseded' | 'task-retried' | 'task-exhausted'
            | 'task-answered' | 'all-done-detected' | 'conductor-decision' | 'assign-rejected'
            | 'premature-final' | 'pty-exit' | 'status-change' | 'stale-escalation'
            | 'unassigned-ask-dropped' | 'deadlock-detected' | 'redispatched'
          participantId?: string
          taskId?: string
          summary: string
          structured?: Record<string, unknown>
        }
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
