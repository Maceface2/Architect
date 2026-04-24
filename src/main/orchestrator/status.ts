import type { ActivityEvent } from './activity'
import type { ParticipantState } from './state'

// Participant lifecycle label derived from multiple signals. This is what
// the scheduler reasons on + what the renderer paints on zone tabs.
//
//   starting  — spawned but no activity line yet
//   running   — working on a task
//   idle      — last activity line was `done` for the currently-tracked task
//   blocked   — last activity line was `ask`
//   failed    — last activity line was `failed`
//   stale     — both PTY and activity log have been quiet past threshold
//   exited    — PTY process is gone
export type ParticipantStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'blocked'
  | 'failed'
  | 'stale'
  | 'exited'

export interface StatusInput {
  state: ParticipantState
  // Most recent parsed line from the activity log, or null if none exist yet.
  lastActivity: ActivityEvent | null
  // Derived idleness — ms since the PTY last produced output and ms since
  // the most recent activity line, respectively. Callers compute against
  // `Date.now()`.
  ptyIdleMs: number
  activityIdleMs: number
  // Threshold for the stale signal. When BOTH idleMs exceed this, the
  // participant is considered stale.
  idleThresholdMs: number
}

// Multi-signal status computation. Signals, in priority order:
//
//   1. PTY alive?           no  → 'exited'
//   2. Agent report          ask → 'blocked'; failed → 'failed';
//                            done on current task → 'idle'
//   3. Staleness             both idle past threshold → 'stale'
//   4. Default                                       → 'running' (or 'starting')
//
// Intentionally pure — no timers, no side effects. The scheduler wraps
// this with escalation logic (increment state.staleEscalations etc.).
export function computeParticipantStatus(input: StatusInput): ParticipantStatus {
  const { state, lastActivity, ptyIdleMs, activityIdleMs, idleThresholdMs } = input

  if (!state.ptyAlive) return 'exited'

  if (lastActivity) {
    if (lastActivity.kind === 'ask') return 'blocked'
    if (lastActivity.kind === 'failed') return 'failed'
    if (
      lastActivity.kind === 'done' &&
      // Only map to idle when the `done` matches the task we're tracking.
      // A stale `done` for a superseded task shouldn't mark the participant
      // idle while a new task is in flight.
      (!state.lastTaskId || lastActivity.taskId === state.lastTaskId)
    ) {
      return 'idle'
    }
  }

  // Stale only counts when BOTH signals are quiet. PTY output alone (e.g.
  // a long tool call printing progress) keeps us out of stale; activity
  // lines alone (e.g. a quiet CLI that only writes markers) likewise.
  if (
    ptyIdleMs > idleThresholdMs &&
    activityIdleMs > idleThresholdMs
  ) {
    return 'stale'
  }

  // If the participant has never emitted an activity line and also has no
  // current task, it is still starting up; otherwise it's running.
  if (!lastActivity && state.lastTaskStatus === 'none') return 'starting'
  return 'running'
}

// How long the participant has been in the 'stale' status. Returns the
// difference between `now` and the stored `staleAt`, or 0 if not stale.
export function staleDurationMs(state: ParticipantState, now: number): number {
  if (!state.staleAt) return 0
  const ts = Date.parse(state.staleAt)
  if (!Number.isFinite(ts)) return 0
  return Math.max(0, now - ts)
}

// Decides whether the scheduler should emit a staleness escalation to the
// conductor. Fires only once per stale streak — once escalated the caller
// should increment `state.staleEscalations` and reset `state.staleAt`.
export function shouldEscalateStale(
  state: ParticipantState,
  now: number,
  staleEscalationMs: number,
): boolean {
  if (!state.staleAt) return false
  return staleDurationMs(state, now) >= staleEscalationMs
}
