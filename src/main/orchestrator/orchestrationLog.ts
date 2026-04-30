import fs from 'fs'
import { dirname, join } from 'path'
import type { OrchestrationEvent, OrchestrationKind } from '../../shared/orchestration'

// Harness-only orchestration log. Mirrors activity.ts but every line is
// authored by the scheduler/dispatch layer — never by an agent CLI. One
// file per dispatch, append-only JSONL. Used by the renderer's swimlane
// to surface coordination decisions (status transitions, retries,
// conductor decisions parsed, PTY exits, stale escalations, etc.) so the
// view becomes a debugging-quality orchestration log without asking the
// CLIs to emit anything beyond the existing activity events.
//
// Wire shape (OrchestrationKind / OrchestrationEvent) lives in
// src/shared/orchestration.ts so preload + renderer can import it without
// pulling in main-only code.

export type { OrchestrationEvent, OrchestrationKind } from '../../shared/orchestration'

const KNOWN_KINDS: ReadonlySet<string> = new Set<OrchestrationKind>([
  'dispatch-started', 'task-dispatched', 'task-superseded', 'task-retried',
  'task-exhausted', 'task-answered', 'all-done-detected', 'conductor-decision',
  'assign-rejected', 'premature-final', 'pty-exit', 'status-change',
  'stale-escalation', 'unassigned-ask-dropped', 'deadlock-detected', 'redispatched',
])

function runtimeRoot(projectDir: string, dispatchId: string): string {
  return join(projectDir, 'ARCHITECT', 'runtime', dispatchId)
}

export function orchestrationLogPath(projectDir: string, dispatchId: string): string {
  return join(runtimeRoot(projectDir, dispatchId), 'orchestration.jsonl')
}

export function ensureOrchestrationLog(path: string): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.closeSync(fs.openSync(path, 'a'))
}

export function appendOrchestration(path: string, event: OrchestrationEvent): void {
  fs.appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8')
}

function parseLine(line: string): OrchestrationEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.ts !== 'string') return null
  if (typeof obj.kind !== 'string' || !KNOWN_KINDS.has(obj.kind)) return null
  if (typeof obj.summary !== 'string') return null
  const event: OrchestrationEvent = {
    ts: obj.ts,
    kind: obj.kind as OrchestrationKind,
    summary: obj.summary,
  }
  if (typeof obj.participantId === 'string') event.participantId = obj.participantId
  if (typeof obj.taskId === 'string') event.taskId = obj.taskId
  if (obj.structured && typeof obj.structured === 'object' && !Array.isArray(obj.structured)) {
    event.structured = obj.structured as Record<string, unknown>
  }
  return event
}

export function readAllOrchestration(path: string): OrchestrationEvent[] {
  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  const events: OrchestrationEvent[] = []
  for (const line of raw.split('\n')) {
    const event = parseLine(line)
    if (event) events.push(event)
  }
  return events
}

export interface OrchestrationWatcher {
  dispose(): void
}

// Same offset+buffer pattern as watchActivity in activity.ts. The harness is
// the only writer here, but using the same fs.watch pipeline keeps the
// renderer-update path uniform with the activity log.
export function watchOrchestration(
  path: string,
  onEvent: (event: OrchestrationEvent) => void,
  onParseError?: (line: string, err: Error) => void,
): OrchestrationWatcher {
  let offset = 0
  let buffer = ''
  let closed = false

  const drain = (): void => {
    if (closed) return
    let size: number
    try {
      size = fs.statSync(path).size
    } catch {
      return
    }
    if (size === offset) return
    if (size < offset) {
      offset = 0
      buffer = ''
    }
    let fd: number
    try {
      fd = fs.openSync(path, 'r')
    } catch {
      return
    }
    try {
      const length = size - offset
      const chunk = Buffer.alloc(length)
      const bytes = fs.readSync(fd, chunk, 0, length, offset)
      offset += bytes
      buffer += chunk.slice(0, bytes).toString('utf-8')
    } finally {
      try { fs.closeSync(fd) } catch {}
    }

    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (!part) continue
      const event = parseLine(part)
      if (event) {
        onEvent(event)
      } else if (onParseError) {
        try {
          onParseError(part, new Error('orchestration line rejected'))
        } catch {}
      }
    }
  }

  drain()
  // See watchActivity for the rationale on dual fs.watch + fs.watchFile.
  // FSEvents-based fs.watch can silently drop appends on macOS; polling
  // covers the gap. drain() is idempotent so double-firing is harmless.
  const watcher = fs.watch(path, () => drain())
  const watchFileListener = (): void => drain()
  fs.watchFile(path, { interval: 1000, persistent: true }, watchFileListener)
  drain()

  return {
    dispose(): void {
      if (closed) return
      closed = true
      try { watcher.close() } catch {}
      try { fs.unwatchFile(path, watchFileListener) } catch {}
    },
  }
}
