// Cross-boundary value types that both the main process and the renderer
// need. Centralizing them here is what keeps `TerminalInfo` and `FileEntry`
// from drifting across env.d.ts, App.tsx, TerminalPanel.tsx, FilesPanel.tsx,
// and src/main/terminals.ts. The full ElectronAPI surface stays in
// src/renderer/src/env.d.ts because it also references renderer-only types
// (ProjectSettings, ZoneSessionRecord, DispatchRecord, AssistantMode) and we
// don't want shared/ depending on src/renderer/.
import type { AgentRuntime } from './agentRuntimes'

export interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

export interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime | 'shell'
  // True when this terminal is part of a scheduler-driven dispatch (any zone
  // OR the Conductor). The renderer uses it to lock user input by default so
  // accidental typing doesn't interleave with scheduler-delivered prompts —
  // the scheduler's two-step submit (text → 120ms → \r) races with concurrent
  // user keystrokes and corrupts whichever turn is mid-flight. The user can
  // click "Take manual control" to type (e.g. to send GO in plan mode or chat
  // with the Conductor mid-dispatch). Never set on solo-zone launches, the
  // assistant, or shell sessions.
  coordinatedMode?: boolean
  // True when this terminal is the Conductor of a dispatch the user has
  // requested in plan mode. The renderer renders a "plan mode — waiting
  // for GO" pill in the terminal's header until the user types GO. The
  // conductor's prompt teaches it to discuss the plan with the user
  // before emitting any {type:"assign"} decisions.
  planMode?: boolean
}

export interface SessionInfo {
  userId: string
  email: string
}

export interface AuthLoginResult {
  ok: boolean
  error?: string
  session?: SessionInfo
}
