import { Fragment, useMemo, useState, useSyncExternalStore } from 'react'
import {
  getActivityStoreSnapshot,
  subscribeActivityStore,
  type ActivityEnvelope,
  type DispatchActivityState,
  type OrchestrationEvent,
} from '../../lib/activityStore'

type ActivityKind = ActivityEnvelope['event']['kind']

// One row of the merged timeline. `agent` rows render as the existing
// kind-colored cards (zone/conductor narrative). `harness` rows render as
// orchestration cards — sourced from the harness-only orchestration.jsonl,
// styled neutrally so they read as "harness observed/decided" rather than
// "agent said." `harness-wide` events with no participantId span every
// participant column (e.g. all-done-detected, premature-final).
type Row =
  | { kind: 'agent'; seq: number; ts: string; participantId: string; envelope: ActivityEnvelope }
  | { kind: 'harness'; seq: number; ts: string; participantId: string; event: OrchestrationEvent }
  | { kind: 'harness-wide'; seq: number; ts: string; event: OrchestrationEvent }

interface KindStyle {
  label: string
  border: string
  bg: string
}

const KIND_STYLES: Record<ActivityKind, KindStyle> = {
  'task-received': {
    label: 'rgb(148 163 184)',
    border: 'rgba(148, 163, 184, 0.35)',
    bg: 'rgba(148, 163, 184, 0.06)',
  },
  progress: {
    label: 'rgb(148 163 184)',
    border: 'rgba(148, 163, 184, 0.32)',
    bg: 'rgba(148, 163, 184, 0.05)',
  },
  note: {
    label: 'rgb(148 163 184)',
    border: 'rgba(148, 163, 184, 0.25)',
    bg: 'rgba(148, 163, 184, 0.04)',
  },
  done: {
    label: 'rgb(110 213 145)',
    border: 'rgba(110, 213, 145, 0.6)',
    bg: 'rgba(110, 213, 145, 0.08)',
  },
  failed: {
    label: 'rgb(248 113 113)',
    border: 'rgba(248, 113, 113, 0.6)',
    bg: 'rgba(248, 113, 113, 0.08)',
  },
  ask: {
    label: 'rgb(228 178 99)',
    border: 'rgba(228, 178, 99, 0.6)',
    bg: 'rgba(228, 178, 99, 0.08)',
  },
  answer: {
    label: 'rgb(180 167 224)',
    border: 'rgba(180, 167, 224, 0.5)',
    bg: 'rgba(180, 167, 224, 0.06)',
  },
}

// Harness cards stay monochrome on purpose — only event-kind variation is
// the label color, picked to communicate severity (failure-ish vs neutral
// vs positive completion) without competing with agent-event cards.
const HARNESS_LABEL_COLORS: Record<OrchestrationEvent['kind'], string> = {
  'dispatch-started': 'rgb(180 167 224)',
  'plan-recorded': 'rgb(180 167 224)',
  'task-dispatched': 'rgb(148 163 184)',
  'task-queued': 'rgb(148 163 184)',
  'task-released': 'rgb(110 213 145)',
  'task-superseded': 'rgb(148 163 184)',
  'task-retried': 'rgb(228 178 99)',
  'task-exhausted': 'rgb(248 113 113)',
  'task-answered': 'rgb(180 167 224)',
  'task-cancelled': 'rgb(228 178 99)',
  'queued-task-auto-failed': 'rgb(248 113 113)',
  'queued-task-resume-dropped': 'rgb(228 178 99)',
  'cancel-rejected': 'rgb(228 178 99)',
  'all-done-detected': 'rgb(110 213 145)',
  'conductor-decision': 'rgb(148 163 184)',
  'assign-rejected': 'rgb(248 113 113)',
  'premature-final': 'rgb(228 178 99)',
  'pty-exit': 'rgb(248 113 113)',
  'status-change': 'rgb(148 163 184)',
  'stale-escalation': 'rgb(228 178 99)',
  'unassigned-ask-dropped': 'rgb(228 178 99)',
  'deadlock-detected': 'rgb(248 113 113)',
  'redispatched': 'rgb(148 163 184)',
}

const TIME_GUTTER_PX = 80
const COLUMN_MIN_WIDTH = 220

interface Props {
  dispatchId: string | null
  participantLabels?: Record<string, string>
  participantColors?: Record<string, string>
}

export default function DispatchSwimlane({ dispatchId, participantLabels, participantColors }: Props) {
  const snapshot = useSyncExternalStore(subscribeActivityStore, getActivityStoreSnapshot, getActivityStoreSnapshot)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const state: DispatchActivityState | null = dispatchId ? snapshot.byDispatch.get(dispatchId) ?? null : null

  const { participants, rows } = useMemo(() => {
    if (!state) return { participants: [] as string[], rows: [] as Row[] }
    const merged: Row[] = []
    for (const env of state.log) {
      merged.push({ kind: 'agent', seq: env.seq, ts: env.event.ts, participantId: env.participantId, envelope: env })
    }
    for (const ev of state.orchestrationLog) {
      if (ev.participantId) {
        merged.push({ kind: 'harness', seq: ev.seq, ts: ev.ts, participantId: ev.participantId, event: ev })
      } else {
        merged.push({ kind: 'harness-wide', seq: ev.seq, ts: ev.ts, event: ev })
      }
    }
    // Sort by harness arrival seq, NOT by event.ts — the agent-supplied ts on
    // activity events can be stale or out of order (seen in the wild: a zone
    // emitting task-received and done in quick succession with the same cached
    // ts). Seq is the only causal clock that respects fs.watch arrival order.
    merged.sort((a, b) => a.seq - b.seq)
    return { participants: state.participantsOrder, rows: merged }
  }, [state])

  if (!dispatchId) {
    return <EmptyMessage>No active dispatch.</EmptyMessage>
  }
  if (!state || participants.length === 0) {
    return <EmptyMessage>Waiting for the first activity from any agent…</EmptyMessage>
  }

  const gridTemplate = `${TIME_GUTTER_PX}px repeat(${participants.length}, minmax(${COLUMN_MIN_WIDTH}px, 1fr))`

  return (
    <div className="h-full overflow-auto">
      <div className="relative min-h-full">
        <ColumnDividers participantCount={participants.length} />
        <div
          className="relative grid items-start"
          style={{ gridTemplateColumns: gridTemplate, columnGap: 24, rowGap: 16, padding: '24px 24px 32px' }}
        >
          {/* Sticky header row: empty corner + one cell per participant. */}
          <div className="sticky top-0 z-10 bg-canvas pb-3" />
          {participants.map(pid => {
            const color = participantColors?.[pid] ?? '#94a3b8'
            const label = participantLabels?.[pid] ?? pid
            return (
              <div
                key={`hdr-${pid}`}
                className="sticky top-0 z-10 bg-canvas pb-3 text-center text-[15px] font-semibold"
                style={{ color }}
              >
                {label}
              </div>
            )
          })}

          {rows.map((row, idx) => {
            const time = formatHm(row.ts)
            const showTime = idx === 0 || formatHm(rows[idx - 1].ts) !== time
            if (row.kind === 'harness-wide') {
              return (
                <Fragment key={`row-${idx}`}>
                  <div className="text-[12px] text-fg-subtle pt-2 select-none">
                    {showTime ? time : ''}
                  </div>
                  <div
                    className="min-w-0"
                    style={{ gridColumn: `span ${participants.length} / span ${participants.length}` }}
                  >
                    <HarnessWideCard event={row.event} />
                  </div>
                </Fragment>
              )
            }
            return (
              <Fragment key={`row-${idx}`}>
                <div className="text-[12px] text-fg-subtle pt-2 select-none">
                  {showTime ? time : ''}
                </div>
                {participants.map(pid => (
                  <div key={`${pid}-${idx}`} className="min-w-0">
                    {row.participantId === pid ? (
                      row.kind === 'agent' ? (
                        <AgentCard
                          envelope={row.envelope}
                          selected={selectedKey === keyForRow(idx)}
                          onClick={() => setSelectedKey(prev => (prev === keyForRow(idx) ? null : keyForRow(idx)))}
                        />
                      ) : (
                        <HarnessCard
                          event={row.event}
                          selected={selectedKey === keyForRow(idx)}
                          onClick={() => setSelectedKey(prev => (prev === keyForRow(idx) ? null : keyForRow(idx)))}
                        />
                      )
                    ) : null}
                  </div>
                ))}
              </Fragment>
            )
          })}

          {rows.length === 0 && (
            <Fragment>
              <div />
              {participants.map(pid => (
                <div key={`empty-${pid}`} className="text-center text-fg-subtle text-[11px] pt-6">
                  …
                </div>
              ))}
            </Fragment>
          )}
        </div>
      </div>
    </div>
  )
}

function ColumnDividers({ participantCount }: { participantCount: number }) {
  const lines: number[] = []
  for (let i = 0; i < participantCount; i += 1) lines.push(i)
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        display: 'grid',
        gridTemplateColumns: `${TIME_GUTTER_PX}px repeat(${participantCount}, minmax(${COLUMN_MIN_WIDTH}px, 1fr))`,
        columnGap: 24,
        padding: '0 24px',
      }}
    >
      <div className="border-r border-node-border/60" style={{ marginRight: -12 }} />
      {lines.map(i => (
        <div
          key={i}
          className={i < participantCount - 1 ? 'border-r border-node-border/40' : ''}
          style={{ marginRight: i < participantCount - 1 ? -12 : 0 }}
        />
      ))}
    </div>
  )
}

function keyForRow(idx: number): string {
  return `row:${idx}`
}

function AgentCard({ envelope, selected, onClick }: { envelope: ActivityEnvelope; selected: boolean; onClick: () => void }) {
  const kind = envelope.event.kind
  const style = KIND_STYLES[kind]
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-md px-3 py-2 transition-colors ${selected ? 'ring-1 ring-fg/40' : ''}`}
      style={{ border: `1px solid ${style.border}`, backgroundColor: style.bg }}
    >
      <div className="text-[13px] leading-snug">
        <span style={{ color: style.label }}>{kind}</span>
        <span className="text-fg-subtle"> · </span>
        <span className="text-fg whitespace-pre-wrap break-words">{envelope.event.content}</span>
      </div>
      {envelope.event.taskId && (
        <div className="mt-1 text-[10px] text-fg-subtle truncate">{envelope.event.taskId}</div>
      )}
    </button>
  )
}

function HarnessCard({ event, selected, onClick }: { event: OrchestrationEvent; selected: boolean; onClick: () => void }) {
  const labelColor = HARNESS_LABEL_COLORS[event.kind] ?? 'rgb(148 163 184)'
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-md px-3 py-2 transition-colors border border-dashed ${selected ? 'ring-1 ring-fg/40' : ''}`}
      style={{ borderColor: 'rgba(148, 163, 184, 0.35)', backgroundColor: 'rgba(148, 163, 184, 0.03)' }}
    >
      <div className="text-[12px] leading-snug">
        <span className="italic" style={{ color: labelColor }}>{event.kind}</span>
        <span className="text-fg-subtle"> · </span>
        <span className="text-fg-muted whitespace-pre-wrap break-words">{event.summary}</span>
      </div>
      {event.taskId && (
        <div className="mt-1 text-[10px] text-fg-subtle truncate">{event.taskId}</div>
      )}
    </button>
  )
}

function HarnessWideCard({ event }: { event: OrchestrationEvent }) {
  const labelColor = HARNESS_LABEL_COLORS[event.kind] ?? 'rgb(148 163 184)'
  return (
    <div
      className="w-full rounded-md px-3 py-1.5 border border-dashed"
      style={{ borderColor: 'rgba(148, 163, 184, 0.35)', backgroundColor: 'rgba(148, 163, 184, 0.03)' }}
    >
      <div className="text-[12px] leading-snug text-center">
        <span className="italic" style={{ color: labelColor }}>{event.kind}</span>
        <span className="text-fg-subtle"> · </span>
        <span className="text-fg-muted">{event.summary}</span>
      </div>
    </div>
  )
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-fg-subtle text-sm">
      {children}
    </div>
  )
}

function formatHm(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}
