import { useMemo, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import DispatchSwimlane from './DispatchSwimlane'
import {
  getActivityStoreSnapshot,
  subscribeActivityStore,
  type DispatchActivityState,
  type StoredActivityEnvelope,
  type StoredOrchestrationEvent,
} from '../../lib/activityStore'

type LogRow =
  | { kind: 'activity'; seq: number; envelope: StoredActivityEnvelope }
  | { kind: 'orchestration'; seq: number; event: StoredOrchestrationEvent }

interface Props {
  dispatchId: string | null
  participantLabels?: Record<string, string>
  participantColors?: Record<string, string>
  onStartDispatch: () => void
  canStartDispatch: boolean
  // When true, a dispatch is mid-launch but no events have arrived yet.
  // Suppresses the "No active dispatch" empty state in that brief window.
  isLaunching?: boolean
  onDismiss?: () => void
}

type ViewMode = 'swimlane' | 'log'

export default function DispatchView({
  dispatchId,
  participantLabels,
  participantColors,
  onStartDispatch,
  canStartDispatch,
  isLaunching = false,
  onDismiss,
}: Props) {
  const [mode, setMode] = useState<ViewMode>('swimlane')
  const snapshot = useSyncExternalStore(subscribeActivityStore, getActivityStoreSnapshot, getActivityStoreSnapshot)
  const state: DispatchActivityState | null = dispatchId ? snapshot.byDispatch.get(dispatchId) ?? null : null

  // Merge agent activity + harness orchestration into one chronological table
  // ordered by the harness arrival seq (same clock the swimlane uses). Two
  // separate ts-sorted arrays would interleave incorrectly because agent ts
  // can lag wall-clock; seq is the only causal clock that matches reality.
  const logRows: LogRow[] = useMemo(() => {
    if (!state) return []
    const rows: LogRow[] = []
    for (const env of state.log) rows.push({ kind: 'activity', seq: env.seq, envelope: env })
    for (const ev of state.orchestrationLog) rows.push({ kind: 'orchestration', seq: ev.seq, event: ev })
    rows.sort((a, b) => a.seq - b.seq)
    return rows
  }, [state])
  const showEmptyState = !isLaunching && dispatchId === null && snapshot.byDispatch.size === 0

  const status = isLaunching && !state ? 'active' : computeStatus(state)

  return (
    <div className="h-full flex flex-col bg-canvas">
      {/* Status banner — green pulse + "Dispatch active" + dispatchId on
          the left, view toggle + close on the right. Always rendered so
          the toggle stays available even on the empty state. */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-node-border">
        <div className="flex items-center gap-3 min-w-0">
          <StatusDot status={status} />
          <span className="text-[15px] text-fg font-medium">{statusLabel(status)}</span>
          {dispatchId && (
            <span className="text-[12px] text-fg-subtle truncate" title={dispatchId}>
              {dispatchId}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded border border-node-border overflow-hidden">
            <button
              onClick={() => setMode('swimlane')}
              className={`px-2.5 py-1 text-[11px] transition-colors ${mode === 'swimlane' ? 'bg-node text-fg' : 'text-fg-muted hover:text-fg'}`}
            >
              Swimlane
            </button>
            <button
              onClick={() => setMode('log')}
              className={`px-2.5 py-1 text-[11px] transition-colors ${mode === 'log' ? 'bg-node text-fg' : 'text-fg-muted hover:text-fg'}`}
            >
              Log
            </button>
          </div>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="w-7 h-7 flex items-center justify-center rounded text-fg-subtle hover:text-fg hover:bg-node transition-colors"
              title="Close dispatch view"
              aria-label="Close dispatch view"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {showEmptyState ? (
          <EmptyState onStart={onStartDispatch} canStart={canStartDispatch} />
        ) : mode === 'swimlane' ? (
          <DispatchSwimlane
            dispatchId={dispatchId}
            participantLabels={participantLabels}
            participantColors={participantColors}
          />
        ) : (
          <LogView rows={logRows} participantLabels={participantLabels} />
        )}
      </div>
    </div>
  )
}

type Status = 'idle' | 'active' | 'complete' | 'failed'

function computeStatus(state: DispatchActivityState | null): Status {
  if (!state) return 'idle'
  if (state.completedSummary) return 'complete'
  if (Array.from(state.participantStatuses.values()).some(s => s === 'failed')) return 'failed'
  return 'active'
}

function statusLabel(status: Status): string {
  switch (status) {
    case 'active': return 'Dispatch active'
    case 'complete': return 'Dispatch complete'
    case 'failed': return 'Dispatch failed'
    case 'idle': return 'No active dispatch'
  }
}

function StatusDot({ status }: { status: Status }) {
  if (status === 'idle') {
    return <span className="w-2.5 h-2.5 rounded-full bg-fg-subtle/60" />
  }
  const color =
    status === 'active' ? 'rgb(110, 213, 145)' :
    status === 'complete' ? 'rgb(110, 213, 145)' :
    'rgb(248, 113, 113)'
  return (
    <span className="relative inline-flex w-2.5 h-2.5">
      {status === 'active' && (
        <span
          className="absolute inset-0 rounded-full animate-ping"
          style={{ backgroundColor: color, opacity: 0.45 }}
        />
      )}
      <span
        className="relative w-2.5 h-2.5 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}66` }}
      />
    </span>
  )
}

function EmptyState({ onStart, canStart }: { onStart: () => void; canStart: boolean }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
      <p className="text-fg-muted text-sm">No active dispatch.</p>
      <button
        onClick={onStart}
        disabled={!canStart}
        className="px-3 py-1.5 text-xs font-medium text-fg bg-accent rounded hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        Start a dispatch
      </button>
      <p className="text-fg-subtle text-[11px] max-w-md">
        Once running, the swimlane shows one column per zone with event cards
        stacked by time. The Log tab is the same data flattened to a scrolling
        event list.
      </p>
    </div>
  )
}

function LogView({ rows, participantLabels }: { rows: LogRow[]; participantLabels?: Record<string, string> }) {
  if (rows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-fg-subtle text-sm">
        Waiting for the first activity…
      </div>
    )
  }
  return (
    <div className="h-full overflow-y-auto text-[11px]">
      <table className="w-full">
        <tbody>
          {rows.map((row, i) => {
            if (row.kind === 'activity') {
              const env = row.envelope
              const label = participantLabels?.[env.participantId] ?? env.participantId
              const decisionTag = formatStructuredDecision(env.event.structured, participantLabels)
              return (
                <tr key={i} className="border-b border-node-border/30 hover:bg-panel/40">
                  <td className="px-3 py-1 text-fg-subtle align-top whitespace-nowrap">{new Date(env.event.ts).toLocaleTimeString()}</td>
                  <td className="px-3 py-1 text-fg-muted align-top whitespace-nowrap">{label}</td>
                  <td className="px-3 py-1 text-fg align-top whitespace-nowrap">{env.event.kind}</td>
                  <td className="px-3 py-1 text-fg-muted align-top whitespace-nowrap">{env.event.taskId ?? '—'}</td>
                  <td className="px-3 py-1 text-fg-muted">
                    <div>{env.event.content}</div>
                    {decisionTag && (
                      <div className="text-[10px] text-fg-subtle mt-0.5">{decisionTag}</div>
                    )}
                  </td>
                </tr>
              )
            }
            // Orchestration row: italic kind to read as a harness observation.
            const ev = row.event
            const label = ev.participantId
              ? (participantLabels?.[ev.participantId] ?? ev.participantId)
              : 'harness'
            return (
              <tr key={i} className="border-b border-node-border/30 hover:bg-panel/40 bg-panel/20">
                <td className="px-3 py-1 text-fg-subtle align-top whitespace-nowrap">{new Date(ev.ts).toLocaleTimeString()}</td>
                <td className="px-3 py-1 text-fg-subtle italic align-top whitespace-nowrap">{label}</td>
                <td className="px-3 py-1 text-fg-muted italic align-top whitespace-nowrap">{ev.kind}</td>
                <td className="px-3 py-1 text-fg-muted align-top whitespace-nowrap">{ev.taskId ?? '—'}</td>
                <td className="px-3 py-1 text-fg-muted">{ev.summary}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Compact one-line tag for the conductor's structured decision payload.
// Keeps the LogView scannable: at a glance the user can tell whether a
// `kind:note` line carried a real assign/answer/final/noop or was just
// narration.
function formatStructuredDecision(
  structured: Record<string, unknown> | undefined,
  participantLabels?: Record<string, string>,
): string | null {
  if (!structured || typeof structured !== 'object') return null
  const type = structured.type
  if (typeof type !== 'string') return null
  const labelOf = (pid: string): string => participantLabels?.[pid] ?? pid
  if (type === 'assign' && Array.isArray(structured.assignments)) {
    const assignments = structured.assignments as Array<{ zoneId?: string; taskId?: string }>
    if (assignments.length === 1) {
      const a = assignments[0]
      const zone = typeof a?.zoneId === 'string' ? labelOf(a.zoneId) : '?'
      const taskId = typeof a?.taskId === 'string' ? ` (${a.taskId})` : ''
      return `assign → ${zone}${taskId}`
    }
    const zones = assignments
      .map(a => (typeof a?.zoneId === 'string' ? labelOf(a.zoneId) : '?'))
      .join(', ')
    return `assign × ${assignments.length} → ${zones}`
  }
  if (type === 'answer' && typeof structured.targetZoneId === 'string') {
    return `answer → ${labelOf(structured.targetZoneId)}`
  }
  if (type === 'final' && typeof structured.summary === 'string') {
    const s = structured.summary
    return `final: ${s.length > 80 ? s.slice(0, 80) + '…' : s}`
  }
  if (type === 'noop') {
    const reason = typeof structured.reason === 'string' ? structured.reason : ''
    return reason ? `noop: ${reason}` : 'noop'
  }
  return null
}
