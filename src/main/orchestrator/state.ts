import fs from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import type { AgentRuntime } from '../../shared/agentRuntimes'

// Per-participant ephemeral snapshot. Rewritten atomically on every state
// transition. Crash-safe, greppable, replaces v4's _index.json per-participant
// entry. The file lives under ARCHITECT/runtime/<dispatchId>/state/<id>.kv
// and is wiped on every fresh dispatch entry (ephemeral by design — it's
// always reconstructable from the activity log + DispatchRecord).

export type ParticipantRole = 'conductor' | 'zone' | 'harness'

export type TaskStatus =
  | 'none'              // no task assigned yet
  | 'pending'           // scheduled, not yet dispatched
  | 'dispatched'        // written to PTY, awaiting receipt
  | 'in-progress'       // task-received or progress line observed
  | 'blocked'           // agent emitted 'ask', waiting on answer
  | 'done'              // agent emitted 'done'
  | 'failed'            // agent emitted 'failed' or retries exhausted
  | 'resumed'           // re-hydrated at resume before first event

export interface ParticipantState {
  role: ParticipantRole
  label: string
  runtime: AgentRuntime
  sessionId?: string
  lastTaskId?: string
  lastTaskStatus: TaskStatus
  lastTaskStartedAt?: string    // ISO8601
  lastActivityTs?: string       // ISO8601 — from most recent activity line
  ptyAlive: boolean
  staleEscalations: number      // bumped once per staleness escalation
  staleAt?: string              // ISO8601 — when the current stale streak began
}

function runtimeRoot(projectDir: string, dispatchId: string): string {
  return join(projectDir, 'ARCHITECT', 'runtime', dispatchId)
}

export function stateDir(projectDir: string, dispatchId: string): string {
  return join(runtimeRoot(projectDir, dispatchId), 'state')
}

export function stateFilePath(
  projectDir: string,
  dispatchId: string,
  participantId: string,
): string {
  return join(stateDir(projectDir, dispatchId), `${participantId}.kv`)
}

export function initialState(
  role: ParticipantRole,
  label: string,
  runtime: AgentRuntime,
): ParticipantState {
  return {
    role,
    label,
    runtime,
    lastTaskStatus: 'none',
    ptyAlive: true,
    staleEscalations: 0,
  }
}

function sanitizeValue(value: string): string {
  // key=value storage disallows \n in values. Replace with a single space to
  // preserve readability; values here are labels / ISO timestamps / short ids
  // that shouldn't contain newlines in practice.
  return value.replace(/[\r\n]+/g, ' ')
}

function serialize(state: ParticipantState): string {
  const lines: string[] = []
  const push = (k: string, v: string | number | boolean | undefined): void => {
    if (v === undefined) return
    lines.push(`${k}=${sanitizeValue(String(v))}`)
  }
  push('role', state.role)
  push('label', state.label)
  push('runtime', state.runtime)
  push('sessionId', state.sessionId)
  push('lastTaskId', state.lastTaskId)
  push('lastTaskStatus', state.lastTaskStatus)
  push('lastTaskStartedAt', state.lastTaskStartedAt)
  push('lastActivityTs', state.lastActivityTs)
  push('ptyAlive', state.ptyAlive)
  push('staleEscalations', state.staleEscalations)
  push('staleAt', state.staleAt)
  return lines.join('\n') + '\n'
}

function parseValue(raw: string): string {
  return raw
}

function isTaskStatus(value: string): value is TaskStatus {
  return (
    value === 'none' || value === 'pending' || value === 'dispatched' ||
    value === 'in-progress' || value === 'blocked' || value === 'done' ||
    value === 'failed' || value === 'resumed'
  )
}

function isParticipantRole(value: string): value is ParticipantRole {
  return value === 'conductor' || value === 'zone' || value === 'harness'
}

// Parses a k=v file into a ParticipantState. Missing / malformed required
// fields cause a throw — callers treat that as "no state yet" via readState.
function deserialize(raw: string): ParticipantState {
  const map = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq)
    const value = parseValue(trimmed.slice(eq + 1))
    map.set(key, value)
  }
  const role = map.get('role')
  const label = map.get('label')
  const runtime = map.get('runtime')
  const lastTaskStatus = map.get('lastTaskStatus')
  if (!role || !isParticipantRole(role)) throw new Error('invalid role')
  if (!label) throw new Error('missing label')
  if (!runtime) throw new Error('missing runtime')
  if (!lastTaskStatus || !isTaskStatus(lastTaskStatus)) throw new Error('invalid lastTaskStatus')

  const state: ParticipantState = {
    role,
    label,
    runtime: runtime as AgentRuntime,
    lastTaskStatus,
    ptyAlive: map.get('ptyAlive') !== 'false',
    staleEscalations: Number(map.get('staleEscalations') ?? '0') || 0,
  }
  const sessionId = map.get('sessionId')
  if (sessionId) state.sessionId = sessionId
  const lastTaskId = map.get('lastTaskId')
  if (lastTaskId) state.lastTaskId = lastTaskId
  const lastTaskStartedAt = map.get('lastTaskStartedAt')
  if (lastTaskStartedAt) state.lastTaskStartedAt = lastTaskStartedAt
  const lastActivityTs = map.get('lastActivityTs')
  if (lastActivityTs) state.lastActivityTs = lastActivityTs
  const staleAt = map.get('staleAt')
  if (staleAt) state.staleAt = staleAt
  return state
}

export function readState(path: string): ParticipantState | null {
  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  try {
    return deserialize(raw)
  } catch {
    return null
  }
}

// Atomic write: mktemp in the same dir, write, rename. Callers are expected
// to serialize writes per file (state.ts is not reentrant across concurrent
// writers to the same path).
export function writeState(path: string, state: ParticipantState): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, serialize(state), 'utf-8')
  fs.renameSync(tmp, path)
}

// Read-modify-write convenience. Returns the new state after the patch,
// or null if the file didn't exist (callers should have initialized).
export function updateState(
  path: string,
  patch: Partial<ParticipantState>,
): ParticipantState | null {
  const current = readState(path)
  if (!current) return null
  const next: ParticipantState = { ...current, ...patch }
  writeState(path, next)
  return next
}
