import { Fragment, useMemo, useState, useSyncExternalStore } from 'react'
import {
  getActivityStoreSnapshot,
  subscribeActivityStore,
  type ActivityEnvelope,
  type DispatchActivityState,
} from '../../lib/activityStore'

type ActivityKind = ActivityEnvelope['event']['kind']

interface KindStyle {
  label: string
  border: string
  bg: string
}

// Tuned to match the spec: cards are mostly transparent with a tinted
// border + subtle bg wash; the "kind" word in monospace echoes the same
// hue. `done` and `ask` get the most saturation; `task-received`/`progress`
// stay neutral so they don't fight for attention against state changes.
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
    if (!state) return { participants: [] as string[], rows: [] as ActivityEnvelope[] }
    // Stable per-event ordering: events arrive in append order from the
    // activity log; sorting by ts gives a strict timeline regardless of which
    // log they came from. Ties resolved by insertion order in the log slice.
    const sorted = [...state.log].sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts))
    return { participants: state.participantsOrder, rows: sorted }
  }, [state])

  if (!dispatchId) {
    return <EmptyMessage>No active dispatch.</EmptyMessage>
  }
  // We render the column structure as soon as we have a participants list,
  // even with zero events — that way a freshly-resumed dispatch shows its
  // zone columns immediately and the user can see "lines" for each agent.
  if (!state || participants.length === 0) {
    return <EmptyMessage>Waiting for the first activity from any zone…</EmptyMessage>
  }

  const gridTemplate = `${TIME_GUTTER_PX}px repeat(${participants.length}, minmax(${COLUMN_MIN_WIDTH}px, 1fr))`

  // Column-divider strategy: render thin vertical lines absolutely-positioned
  // behind the grid so they stretch the full scroll height (`relative`
  // wrapper + sticky-positioned column tracks). Each line sits between two
  // columns at the calculated split point of the grid template.
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
                className="sticky top-0 z-10 bg-canvas pb-3 text-center font-mono uppercase tracking-[0.2em] text-[15px]"
                style={{ color }}
              >
                {label}
              </div>
            )
          })}

          {/* One row per activity event: time on the left, card in the
              participant's column, blanks elsewhere. */}
          {rows.map((entry, idx) => {
            const time = formatHm(entry.event.ts)
            const showTime = idx === 0 || formatHm(rows[idx - 1].event.ts) !== time
            return (
              <Fragment key={`${entry.dispatchId}-${idx}`}>
                <div className="font-mono text-[12px] text-fg-subtle pt-2 select-none">
                  {showTime ? time : ''}
                </div>
                {participants.map(pid => (
                  <div key={`${pid}-${idx}`} className="min-w-0">
                    {entry.participantId === pid ? (
                      <EventCard
                        envelope={entry}
                        selected={selectedKey === keyFor(entry, idx)}
                        onClick={() => setSelectedKey(prev => (prev === keyFor(entry, idx) ? null : keyFor(entry, idx)))}
                      />
                    ) : null}
                  </div>
                ))}
              </Fragment>
            )
          })}

          {/* Empty-state row when columns are seeded but no events have
              landed yet — keeps the swimlane structurally visible during
              the gap between resume/launch and the first activity. */}
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

// Thin vertical line between every pair of columns. We render N+1 segments
// (left edge of time gutter is intentionally skipped) using a CSS grid that
// matches the parent's gridTemplateColumns minus the gap math. Lines are
// inset 12px from the column edges so they sit centered in the gap.
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
      {/* Right edge of the time gutter — separates time column from lanes. */}
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

function keyFor(envelope: ActivityEnvelope, idx: number): string {
  return `${envelope.participantId}:${envelope.event.taskId ?? 'none'}:${idx}`
}

function EventCard({ envelope, selected, onClick }: { envelope: ActivityEnvelope; selected: boolean; onClick: () => void }) {
  const kind = envelope.event.kind
  const style = KIND_STYLES[kind]
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-md px-3 py-2 transition-colors ${selected ? 'ring-1 ring-fg/40' : ''}`}
      style={{
        border: `1px solid ${style.border}`,
        backgroundColor: style.bg,
      }}
    >
      <div className="text-[13px] leading-snug">
        <span className="font-mono" style={{ color: style.label }}>{kind}</span>
        <span className="text-fg-subtle"> · </span>
        <span className="text-fg whitespace-pre-wrap break-words">{envelope.event.content}</span>
      </div>
      {envelope.event.taskId && (
        <div className="mt-1 font-mono text-[10px] text-fg-subtle truncate">{envelope.event.taskId}</div>
      )}
    </button>
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
