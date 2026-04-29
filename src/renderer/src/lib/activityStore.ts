// Singleton store for `window.electron.activity.*` events.
//
// DispatchView/DispatchSwimlane only mount when the user opens the Dispatch
// tab. If we let those components own the IPC subscription, every event that
// fired before the tab opened (including the first task-received batch from a
// fresh dispatch) is dropped. This module subscribes once at first import and
// retains everything since, so lane data is available the moment the view
// renders.
//
// Snapshot updates are referentially distinct so React's `useSyncExternalStore`
// triggers a re-render. State for each dispatch is grouped by participantId →
// task blocks for the swimlane, plus a flat per-dispatch event log for the
// raw view.

type ActivityKind = 'task-received' | 'progress' | 'ask' | 'answer' | 'done' | 'failed' | 'note'

export type OrchestrationKind =
  | 'dispatch-started'
  | 'task-dispatched' | 'task-superseded' | 'task-retried' | 'task-exhausted'
  | 'task-answered' | 'all-done-detected' | 'conductor-decision' | 'assign-rejected'
  | 'premature-final' | 'pty-exit' | 'status-change' | 'stale-escalation'
  | 'unassigned-ask-dropped' | 'deadlock-detected' | 'redispatched'

export type ParticipantStatus = 'starting' | 'running' | 'idle' | 'blocked' | 'failed' | 'stale' | 'exited'

export type BlockStatus = 'running' | 'done' | 'failed' | 'blocked'

export interface ActivityEventEntry {
  ts: string
  kind: ActivityKind
  taskId?: string
  content: string
  structured?: Record<string, unknown>
}

export interface ActivityEnvelope {
  dispatchId: string
  participantId: string
  event: ActivityEventEntry
}

export interface OrchestrationEvent {
  ts: string
  kind: OrchestrationKind
  participantId?: string
  taskId?: string
  summary: string
  structured?: Record<string, unknown>
}

export interface OrchestrationEnvelope {
  dispatchId: string
  event: OrchestrationEvent
}

export interface TaskBlock {
  taskId: string
  participantId: string
  startedAt: number
  endedAt: number | null
  status: BlockStatus
  summary: string
  events: ActivityEventEntry[]
}

// Stored entries carry a monotonic `seq` assigned at apply-time. The swimlane
// orders by seq instead of the embedded `ts` because agent-supplied ts can lag
// real time (e.g. an agent that emits task-received and done in quick
// succession with a stale cached timestamp); harness arrival order is the only
// reliable causal clock for interleaving these two streams.
export type StoredActivityEnvelope = ActivityEnvelope & { seq: number }
export type StoredOrchestrationEvent = OrchestrationEvent & { seq: number }

export interface DispatchActivityState {
  dispatchId: string
  blocks: Map<string, TaskBlock>
  participantsOrder: string[]
  participantStatuses: Map<string, ParticipantStatus>
  log: StoredActivityEnvelope[]
  // Harness-authored orchestration log (status transitions, retries, conductor
  // decisions, etc.). Kept separate from `log` so swimlane rendering can
  // distinguish "agent said this" from "harness observed this", and so the
  // task-block reducer at applyEvent doesn't try to attach orchestration
  // events to phantom task blocks.
  orchestrationLog: StoredOrchestrationEvent[]
  firstTs: number
  lastEventTs: number
  completedSummary: string | null
}

export interface ActivityStoreSnapshot {
  // Most-recently-active dispatchId — the one whose events arrived last. The
  // Dispatch tab uses this when the user hasn't pinned a specific dispatch.
  latestDispatchId: string | null
  byDispatch: Map<string, DispatchActivityState>
}

const MAX_LOG_PER_DISPATCH = 1000
const MAX_ORCH_PER_DISPATCH = 1000
const MAX_DISPATCHES_RETAINED = 12

let snapshot: ActivityStoreSnapshot = {
  latestDispatchId: null,
  byDispatch: new Map(),
}

// Module-level monotonic sequence. Bumped each time the store accepts an
// envelope (live IPC or seed). Provides a single causal clock across both the
// activity log and the orchestration log so the swimlane can render events in
// arrival order regardless of what `event.ts` claims.
let nextSeq = 0
function bumpSeq(): number { nextSeq += 1; return nextSeq }

const listeners = new Set<() => void>()
let bound = false

function notify() {
  for (const l of listeners) l()
}

function ensureBound() {
  if (bound) return
  if (typeof window === 'undefined' || !window.electron?.activity) return
  bound = true
  window.electron.activity.onEvent((payload: ActivityEnvelope) => {
    snapshot = applyEvent(snapshot, payload)
    notify()
  })
  window.electron.activity.onState(payload => {
    snapshot = applyState(snapshot, payload)
    notify()
  })
  window.electron.activity.onDispatchComplete(({ dispatchId, summary }) => {
    snapshot = applyComplete(snapshot, dispatchId, summary)
    notify()
  })
  window.electron.activity.onOrchestration((payload: OrchestrationEnvelope) => {
    snapshot = applyOrchestration(snapshot, payload)
    notify()
  })
}

export function subscribeActivityStore(listener: () => void): () => void {
  ensureBound()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getActivityStoreSnapshot(): ActivityStoreSnapshot {
  ensureBound()
  return snapshot
}

// Bulk-apply persisted activity history (read from
// `ARCHITECT/runtime/<dispatchId>/activity/*.jsonl`) into the store. Used on
// resume so the swimlane shows the previous session's events — the resume
// itself wipes the runtime dir, so we have to capture them first.
export function seedDispatchHistory(
  dispatchId: string,
  history: Array<{ participantId: string; event: { ts: string; kind: string; taskId?: string; content: string; structured?: Record<string, unknown> } }>,
): void {
  ensureBound()
  let next = snapshot
  for (const item of history) {
    next = applyEvent(next, {
      dispatchId,
      participantId: item.participantId,
      event: {
        ts: item.event.ts,
        kind: item.event.kind as ActivityEventEntry['kind'],
        taskId: item.event.taskId,
        content: item.event.content,
        structured: item.event.structured,
      },
    })
  }
  snapshot = next
  notify()
}

// Pre-create a dispatch entry with its known participant list so the
// swimlane can render columns/lines for every zone before any event has
// fired. Used by resume (we know the dispatchId up front) and by new
// dispatches once the dispatchId is known. If the entry already exists
// (e.g. a late event arrived first), participants are merged into the
// existing order without disturbing it.
export function seedDispatch(dispatchId: string, participantIds: string[]): void {
  ensureBound()
  const existing = snapshot.byDispatch.get(dispatchId)
  const order = existing ? [...existing.participantsOrder] : []
  for (const pid of participantIds) {
    if (!order.includes(pid)) order.push(pid)
  }
  const seeded: DispatchActivityState = existing
    ? { ...existing, participantsOrder: order }
    : {
        dispatchId,
        blocks: new Map(),
        participantsOrder: order,
        participantStatuses: new Map(),
        log: [],
        orchestrationLog: [],
        firstTs: 0,
        lastEventTs: 0,
        completedSummary: null,
      }
  const byDispatch = new Map(snapshot.byDispatch).set(dispatchId, seeded)
  snapshot = { latestDispatchId: dispatchId, byDispatch }
  notify()
}

function ensureDispatch(state: ActivityStoreSnapshot, dispatchId: string): DispatchActivityState {
  const existing = state.byDispatch.get(dispatchId)
  if (existing) return existing
  return {
    dispatchId,
    blocks: new Map(),
    participantsOrder: [],
    participantStatuses: new Map(),
    log: [],
    orchestrationLog: [],
    firstTs: 0,
    lastEventTs: 0,
    completedSummary: null,
  }
}

function evictOldDispatches(byDispatch: Map<string, DispatchActivityState>): Map<string, DispatchActivityState> {
  if (byDispatch.size <= MAX_DISPATCHES_RETAINED) return byDispatch
  // Drop the oldest by lastEventTs. Insertion-order Map iteration would also
  // work for FIFO, but using lastEventTs is more honest about "least recently
  // active" than "least recently created."
  const entries = Array.from(byDispatch.entries()).sort((a, b) => a[1].lastEventTs - b[1].lastEventTs)
  const next = new Map(byDispatch)
  while (next.size > MAX_DISPATCHES_RETAINED && entries.length > 0) {
    const [oldestId] = entries.shift()!
    next.delete(oldestId)
  }
  return next
}

function statusFromKind(kind: ActivityKind): BlockStatus | null {
  switch (kind) {
    case 'task-received':
    case 'progress':
    case 'note':
    case 'answer':
      return 'running'
    case 'done': return 'done'
    case 'failed': return 'failed'
    case 'ask': return 'blocked'
  }
}

function applyEvent(state: ActivityStoreSnapshot, payload: ActivityEnvelope): ActivityStoreSnapshot {
  const tsRaw = Date.parse(payload.event.ts)
  const ts = Number.isFinite(tsRaw) ? tsRaw : Date.now()
  const dispatch = ensureDispatch(state, payload.dispatchId)
  const stored: StoredActivityEnvelope = { ...payload, seq: bumpSeq() }
  const log = dispatch.log.length >= MAX_LOG_PER_DISPATCH
    ? [...dispatch.log.slice(-MAX_LOG_PER_DISPATCH + 1), stored]
    : [...dispatch.log, stored]
  const participantsOrder = dispatch.participantsOrder.includes(payload.participantId)
    ? dispatch.participantsOrder
    : [...dispatch.participantsOrder, payload.participantId]
  const firstTs = dispatch.firstTs === 0 ? ts : Math.min(dispatch.firstTs, ts)
  const lastEventTs = Math.max(dispatch.lastEventTs, ts)

  let blocks = dispatch.blocks
  const taskId = payload.event.taskId
  if (taskId) {
    const key = `${payload.participantId}:${taskId}`
    const existing = blocks.get(key)
    const events = existing ? [...existing.events, payload.event] : [payload.event]
    const incoming = statusFromKind(payload.event.kind)
    const summary = payload.event.kind === 'task-received'
      ? payload.event.content
      : (payload.event.content && payload.event.content.length > 0 ? payload.event.content : existing?.summary ?? '')
    const isTerminal = payload.event.kind === 'done' || payload.event.kind === 'failed'
    const block: TaskBlock = {
      taskId,
      participantId: payload.participantId,
      startedAt: existing?.startedAt ?? ts,
      endedAt: isTerminal ? ts : existing?.endedAt ?? null,
      status: incoming ?? existing?.status ?? 'running',
      summary,
      events,
    }
    blocks = new Map(blocks)
    blocks.set(key, block)
  }

  const updated: DispatchActivityState = {
    ...dispatch,
    blocks,
    participantsOrder,
    log,
    firstTs,
    lastEventTs,
  }
  const byDispatch = evictOldDispatches(new Map(state.byDispatch).set(payload.dispatchId, updated))
  return { latestDispatchId: payload.dispatchId, byDispatch }
}

function applyState(
  state: ActivityStoreSnapshot,
  payload: { dispatchId: string; participantId: string; status: ParticipantStatus },
): ActivityStoreSnapshot {
  const dispatch = ensureDispatch(state, payload.dispatchId)
  const statuses = new Map(dispatch.participantStatuses)
  statuses.set(payload.participantId, payload.status)
  const updated: DispatchActivityState = { ...dispatch, participantStatuses: statuses }
  const byDispatch = new Map(state.byDispatch).set(payload.dispatchId, updated)
  return { ...state, byDispatch }
}

function applyComplete(state: ActivityStoreSnapshot, dispatchId: string, summary: string): ActivityStoreSnapshot {
  const dispatch = ensureDispatch(state, dispatchId)
  const updated: DispatchActivityState = { ...dispatch, completedSummary: summary }
  const byDispatch = new Map(state.byDispatch).set(dispatchId, updated)
  return { ...state, byDispatch }
}

function applyOrchestration(state: ActivityStoreSnapshot, payload: OrchestrationEnvelope): ActivityStoreSnapshot {
  const dispatch = ensureDispatch(state, payload.dispatchId)
  const stored: StoredOrchestrationEvent = { ...payload.event, seq: bumpSeq() }
  const log = dispatch.orchestrationLog.length >= MAX_ORCH_PER_DISPATCH
    ? [...dispatch.orchestrationLog.slice(-MAX_ORCH_PER_DISPATCH + 1), stored]
    : [...dispatch.orchestrationLog, stored]
  // Surface any participantId not seen yet so dispatch-wide events from a
  // not-yet-active zone don't keep its column hidden.
  const pid = payload.event.participantId
  const participantsOrder = pid && !dispatch.participantsOrder.includes(pid)
    ? [...dispatch.participantsOrder, pid]
    : dispatch.participantsOrder
  const updated: DispatchActivityState = { ...dispatch, orchestrationLog: log, participantsOrder }
  const byDispatch = new Map(state.byDispatch).set(payload.dispatchId, updated)
  return { ...state, byDispatch }
}

// Bulk-seed orchestration history on resume — same flow as seedDispatchHistory
// but for the harness-only orchestration log file.
export function seedDispatchOrchestration(
  dispatchId: string,
  history: OrchestrationEvent[],
): void {
  ensureBound()
  let next = snapshot
  for (const event of history) {
    next = applyOrchestration(next, { dispatchId, event })
  }
  snapshot = next
  notify()
}

// Single-shot resume seeder. Interleaves the activity-log history and the
// orchestration-log history by `ts` BEFORE applying so the assigned seq
// matches chronological order from the prior session — without this, all
// activity events would land before all orchestration events, mangling the
// resumed swimlane.
export function seedDispatchCombined(
  dispatchId: string,
  activityHistory: Array<{ participantId: string; event: { ts: string; kind: string; taskId?: string; content: string; structured?: Record<string, unknown> } }>,
  orchestrationHistory: OrchestrationEvent[],
): void {
  ensureBound()
  type Item =
    | { kind: 'activity'; ts: number; payload: ActivityEnvelope }
    | { kind: 'orch'; ts: number; payload: OrchestrationEnvelope }
  const items: Item[] = []
  for (const a of activityHistory) {
    const ts = Date.parse(a.event.ts)
    items.push({
      kind: 'activity',
      ts: Number.isFinite(ts) ? ts : 0,
      payload: {
        dispatchId,
        participantId: a.participantId,
        event: {
          ts: a.event.ts,
          kind: a.event.kind as ActivityEventEntry['kind'],
          taskId: a.event.taskId,
          content: a.event.content,
          structured: a.event.structured,
        },
      },
    })
  }
  for (const o of orchestrationHistory) {
    const ts = Date.parse(o.ts)
    items.push({ kind: 'orch', ts: Number.isFinite(ts) ? ts : 0, payload: { dispatchId, event: o } })
  }
  items.sort((a, b) => a.ts - b.ts)
  let next = snapshot
  for (const item of items) {
    next = item.kind === 'activity' ? applyEvent(next, item.payload) : applyOrchestration(next, item.payload)
  }
  snapshot = next
  notify()
}
