import fs from 'fs'
import { dirname, join } from 'path'

// v5 coordination transport: each participant owns a single append-only JSONL
// file under ARCHITECT/runtime/<dispatchId>/activity/<participant>.jsonl.
// Agents emit one line per meaningful step via a single-shot POSIX command
// (`printf '%s\n' '<json>' >> <path>`), which every runtime's shell tool
// supports uniformly. The harness tails the file via narrow per-file
// fs.watch and broadcasts each parsed line to the renderer + scheduler.
//
// No polling loop runs inside the agent. No bash scripts are shipped.

export type ActivityKind =
  | 'task-received'   // agent confirms receipt of a task prompt
  | 'progress'        // mid-work note
  | 'ask'             // blocked on clarification from conductor/user
  | 'answer'          // reply to a prior 'ask'
  | 'done'            // task finished successfully
  | 'failed'          // task aborted with reason
  | 'note'            // free-form log line unattached to a taskId

const KNOWN_KINDS: ReadonlySet<string> = new Set<ActivityKind>([
  'task-received', 'progress', 'ask', 'answer', 'done', 'failed', 'note',
])

export interface ActivityEvent {
  ts: string                              // ISO8601
  kind: ActivityKind
  taskId?: string                         // optional; many lines will have one
  content: string                         // free-form text for humans / conductor
  structured?: Record<string, unknown>    // optional structured payload
}

function runtimeRoot(projectDir: string, dispatchId: string): string {
  return join(projectDir, 'ARCHITECT', 'runtime', dispatchId)
}

export function activityDir(projectDir: string, dispatchId: string): string {
  return join(runtimeRoot(projectDir, dispatchId), 'activity')
}

export function activityLogPath(
  projectDir: string,
  dispatchId: string,
  participantId: string,
): string {
  return join(activityDir(projectDir, dispatchId), `${participantId}.jsonl`)
}

// mkdirs + `touch` the log file so watchers can attach before the agent
// has written its first line.
export function ensureActivityLog(path: string): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  try {
    fs.closeSync(fs.openSync(path, 'a'))
  } catch (err) {
    throw new Error(`failed to create activity log ${path}: ${(err as Error).message}`)
  }
}

export function parseActivityLine(line: string): ActivityEvent | null {
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
  if (typeof obj.content !== 'string') return null
  const event: ActivityEvent = {
    ts: obj.ts,
    kind: obj.kind as ActivityKind,
    content: obj.content,
  }
  if (typeof obj.taskId === 'string') event.taskId = obj.taskId
  if (obj.structured && typeof obj.structured === 'object' && !Array.isArray(obj.structured)) {
    event.structured = obj.structured as Record<string, unknown>
  }
  return event
}

// Appends one event as a single JSON line. Used by harness-side writers
// (e.g. synthetic events, bootstrap markers). Agents write their own lines
// via `printf ... >> file` from their shell tool — we don't proxy those.
export function appendActivity(path: string, event: ActivityEvent): void {
  const line = JSON.stringify(event) + '\n'
  fs.appendFileSync(path, line, 'utf-8')
}

// Returns every parsed event in the file in chronological order. Malformed
// lines are silently skipped. Used for resume / debugging.
export function readAllActivity(path: string): ActivityEvent[] {
  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  const events: ActivityEvent[] = []
  for (const line of raw.split('\n')) {
    const event = parseActivityLine(line)
    if (event) events.push(event)
  }
  return events
}

// Returns the last `n` parsed events. Convenience for status computation.
export function tailActivity(path: string, n = 1): ActivityEvent[] {
  const all = readAllActivity(path)
  return n >= all.length ? all : all.slice(all.length - n)
}

export interface ActivityWatcher {
  dispose(): void
}

// Tails a single activity log file, firing `onEvent` for each newly-appended
// parsed line. Returns a disposer that stops the watcher.
//
// Implementation notes:
//   - Narrow per-file fs.watch. On macOS the watcher may fire multiple times
//     per write; we re-check size each event and only emit newly-seen bytes.
//   - Carries a partial-line buffer across reads so writes that straddle a
//     newline boundary don't produce broken lines.
//   - Tolerates the file being truncated (size < last offset): resets to 0.
//   - Malformed lines are reported via `onParseError` and otherwise dropped.
export function watchActivity(
  path: string,
  onEvent: (event: ActivityEvent) => void,
  onParseError?: (line: string, err: Error) => void,
): ActivityWatcher {
  // Drain any lines that landed before the watcher could attach. The
  // scheduler is constructed after spawning the conductor, and Claude's
  // first activity-log write can arrive during that window. Callers
  // ensure the activity file is empty at setup time (setupWorkspaceV5
  // wipes the runtime subtree), so this drain is a no-op outside the
  // tight race window.
  for (const event of readAllActivity(path)) onEvent(event)

  let offset = 0
  let buffer = ''
  let closed = false

  try {
    offset = fs.statSync(path).size
  } catch {
    offset = 0
  }

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
      // File was truncated or replaced; re-read from the start.
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
    // Last element is the trailing partial line (empty if the chunk ended
    // with \n) — keep for the next drain.
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (!part) continue
      const event = parseActivityLine(part)
      if (event) {
        onEvent(event)
      } else if (onParseError) {
        try {
          onParseError(part, new Error('malformed activity line'))
        } catch {}
      }
    }
  }

  const watcher = fs.watch(path, () => drain())
  // Fire an initial drain in case writes landed between the stat above and
  // the watcher attaching.
  drain()

  return {
    dispose(): void {
      if (closed) return
      closed = true
      try { watcher.close() } catch {}
    },
  }
}
