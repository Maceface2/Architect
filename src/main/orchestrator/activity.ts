import fs from 'fs'
import { dirname, join } from 'path'

// v5 coordination transport: each participant owns a single append-only JSONL
// file under ARCHITECT/runtime/<dispatchId>/activity/<participant>.jsonl.
// Agents emit one line per meaningful step via a `cat << EOF` heredoc append,
// which every runtime's shell tool supports uniformly. The harness tails the
// file via narrow per-file fs.watch and broadcasts each parsed line to the
// renderer + scheduler. No polling loop runs inside the agent.

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

// Hard cap on the `content` field. ~8 KB is roughly 2K tokens — fits the
// conductor's per-turn context budget and prevents log-spam / disk
// exhaustion from a runaway zone. Lines exceeding the cap are rejected at
// parse time.
export const MAX_CONTENT_BYTES = 8192

export interface ActivityEvent {
  ts: string                              // ISO8601
  // Authorship marker. Must equal the participantId that owns the activity
  // log file. The watcher rejects events whose `from` doesn't match the
  // file's expected participantId — defends against a hallucinating zone
  // writing into another zone's log (cross-impersonation) and against
  // newline-injection forgery (the forged half can't claim a different
  // `from` and still match the file owner).
  from: string
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

// Specific reasons an activity line can be rejected. Kept tagged so log
// lines can say WHY a write was dropped — silent drops were a real pain
// point during stress testing (e.g. an orphan-claim line that's syntactically
// valid but rejected by an in-memory guard looks identical from outside to a
// dropped malformed line).
export type ActivityRejection =
  | 'empty-line'
  | 'non-json'
  | 'not-object'
  | 'missing-ts'
  | 'missing-or-unknown-kind'
  | 'missing-content'
  | 'oversized-content'
  | 'missing-from'
  | 'from-mismatch'

export type ActivityParseResult =
  | { ok: true; event: ActivityEvent }
  | { ok: false; reason: ActivityRejection }

// Detailed parser. Use this when you want to log the rejection reason.
export function parseActivityLineDetailed(line: string, expectedFrom?: string): ActivityParseResult {
  const trimmed = line.trim()
  if (!trimmed) return { ok: false, reason: 'empty-line' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'non-json' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not-object' }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.ts !== 'string') return { ok: false, reason: 'missing-ts' }
  if (typeof obj.kind !== 'string' || !KNOWN_KINDS.has(obj.kind)) return { ok: false, reason: 'missing-or-unknown-kind' }
  if (typeof obj.content !== 'string') return { ok: false, reason: 'missing-content' }
  if (Buffer.byteLength(obj.content, 'utf-8') > MAX_CONTENT_BYTES) return { ok: false, reason: 'oversized-content' }
  if (typeof obj.from !== 'string' || !obj.from) return { ok: false, reason: 'missing-from' }
  if (expectedFrom !== undefined && obj.from !== expectedFrom) return { ok: false, reason: 'from-mismatch' }
  const event: ActivityEvent = {
    ts: obj.ts,
    from: obj.from,
    kind: obj.kind as ActivityKind,
    content: obj.content,
  }
  if (typeof obj.taskId === 'string') event.taskId = obj.taskId
  if (obj.structured && typeof obj.structured === 'object' && !Array.isArray(obj.structured)) {
    event.structured = obj.structured as Record<string, unknown>
  }
  return { ok: true, event }
}

// Thin wrapper preserving the original null-on-reject API for callers that
// don't care about the reason (readers, tail).
export function parseActivityLine(line: string, expectedFrom?: string): ActivityEvent | null {
  const result = parseActivityLineDetailed(line, expectedFrom)
  return result.ok ? result.event : null
}

// Appends one event as a single JSON line. Used by harness-side writers
// (e.g. synthetic events, bootstrap markers). Agents write their own lines
// via `printf ... >> file` from their shell tool — we don't proxy those.
export function appendActivity(path: string, event: ActivityEvent): void {
  const line = JSON.stringify(event) + '\n'
  fs.appendFileSync(path, line, 'utf-8')
}

// Returns every parsed event in the file in chronological order. Malformed
// lines and lines whose `from` field doesn't match `expectedFrom` are
// silently skipped. Used for resume / debugging.
export function readAllActivity(path: string, expectedFrom?: string): ActivityEvent[] {
  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  const events: ActivityEvent[] = []
  for (const line of raw.split('\n')) {
    const event = parseActivityLine(line, expectedFrom)
    if (event) events.push(event)
  }
  return events
}

// Returns the last `n` parsed events. Convenience for status computation.
export function tailActivity(path: string, n = 1, expectedFrom?: string): ActivityEvent[] {
  const all = readAllActivity(path, expectedFrom)
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
  expectedFrom?: string,
): ActivityWatcher {
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
      const result = parseActivityLineDetailed(part, expectedFrom)
      if (result.ok) {
        onEvent(result.event)
      } else if (result.reason !== 'empty-line' && onParseError) {
        try {
          onParseError(part, new Error(`activity line rejected: ${result.reason}`))
        } catch {}
      }
    }
  }

  // Drain pre-existing bytes through the same offset-advancing path. This
  // replaces a prior readAllActivity()+statSync pattern that had a race
  // window: a write landing between the read and the stat would push the
  // initial offset past bytes the read didn't see, so the line was
  // neither replayed nor tailed.
  drain()

  // Belt-and-suspenders watching:
  //   - fs.watch (FSEvents on macOS) — fires immediately when it works, but
  //     can silently drop appends to recently-created/size-0 files. Hit in the
  //     wild: a zone's first `done` line was missed, the conductor never got
  //     the corresponding "Zone X done" turn, and the dispatch hung.
  //   - fs.watchFile (polling) — reliable, catches anything fs.watch misses.
  //     drain() is offset-based and idempotent, so double-firing is harmless.
  // Together: we still get sub-millisecond latency when fs.watch fires, and
  // a 1s worst-case catch-up when it doesn't.
  const watcher = fs.watch(path, () => drain())
  const watchFileListener = (): void => drain()
  fs.watchFile(path, { interval: 1000, persistent: true }, watchFileListener)
  // One more drain in case bytes landed between the drain above and the
  // watchers attaching.
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
