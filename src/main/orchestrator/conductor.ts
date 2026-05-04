import type { ActivityEvent } from './activity'
import type { AgentRuntime } from '../../shared/agentRuntimes'

// Parser + turn composers for the v5 Conductor flow.
//
// The conductor emits decisions as `kind:'note'` activity lines with a
// `structured.type` field. The scheduler reads the conductor's activity
// log via the standard watcher, feeds each event through `parseDecision`,
// and acts on the returned shape.
//
// The harness drives the conductor's turn-taking by pty.writing compact
// user-turn strings. Each material event (zone done/failed/ask, staleness,
// all-done) maps to one of the `compose*Turn` helpers below.

export type ConductorDecision =
  | {
      type: 'assign'
      assignments: Array<{
        zoneId: string
        body: string
        taskId?: string
        // participantIds the harness must observe in `done` before this task
        // releases. Empty / absent → dispatch immediately. The conductor
        // declares the wave plan; the scheduler queues + releases.
        dependsOn?: string[]
      }>
    }
  | { type: 'answer'; targetZoneId: string; body: string }
  | { type: 'cancel'; zoneId: string; taskId?: string; reason?: string }
  | { type: 'final'; summary: string }
  | { type: 'noop'; reason?: string }

export interface ParsedDecision {
  decision: ConductorDecision
  // Raw JSON string of the structured block; saved to DispatchRecord for
  // audit + resume.
  raw: string
}

// Parses a single activity event emitted by the conductor. Returns null if
// the event is not a structured decision (malformed or a different kind).
export function parseDecision(event: ActivityEvent): ParsedDecision | null {
  if (event.kind !== 'note') return null
  if (event.structured == null || typeof event.structured !== 'object') return null
  const s = event.structured as Record<string, unknown>
  if (typeof s.type !== 'string') return null

  let decision: ConductorDecision | null = null
  if (s.type === 'assign') {
    if (!Array.isArray(s.assignments)) return null
    const assignments: Array<{ zoneId: string; body: string; taskId?: string; dependsOn?: string[] }> = []
    for (const row of s.assignments) {
      if (!row || typeof row !== 'object') return null
      const a = row as Record<string, unknown>
      if (typeof a.zoneId !== 'string' || typeof a.body !== 'string') return null
      if (a.zoneId.trim().length === 0) return null
      if (a.body.trim().length === 0) return null
      const entry: { zoneId: string; body: string; taskId?: string; dependsOn?: string[] } = {
        zoneId: a.zoneId,
        body: a.body,
      }
      if (typeof a.taskId === 'string') entry.taskId = a.taskId
      // dependsOn is optional. If present it must be string[] of non-empty
      // trimmed participantIds. We accept the empty array as a no-op (same as
      // omitting the field) so the conductor can emit `dependsOn: []` without
      // it being treated as malformed.
      if (a.dependsOn !== undefined) {
        if (!Array.isArray(a.dependsOn)) return null
        const deps: string[] = []
        for (const dep of a.dependsOn) {
          if (typeof dep !== 'string') return null
          const trimmed = dep.trim()
          if (trimmed.length === 0) return null
          deps.push(trimmed)
        }
        if (deps.length > 0) entry.dependsOn = deps
      }
      assignments.push(entry)
    }
    if (!assignments.length) return null
    decision = { type: 'assign', assignments }
  } else if (s.type === 'answer') {
    if (typeof s.targetZoneId !== 'string' || typeof s.body !== 'string') return null
    if (s.targetZoneId.trim().length === 0) return null
    if (s.body.trim().length === 0) return null
    decision = { type: 'answer', targetZoneId: s.targetZoneId, body: s.body }
  } else if (s.type === 'cancel') {
    if (typeof s.zoneId !== 'string') return null
    if (s.zoneId.trim().length === 0) return null
    const taskId = typeof s.taskId === 'string' && s.taskId.trim().length > 0
      ? s.taskId
      : undefined
    const reason = typeof s.reason === 'string' && s.reason.trim().length > 0
      ? s.reason
      : undefined
    decision = { type: 'cancel', zoneId: s.zoneId, taskId, reason }
  } else if (s.type === 'final') {
    if (typeof s.summary !== 'string') return null
    if (s.summary.trim().length === 0) return null
    decision = { type: 'final', summary: s.summary }
  } else if (s.type === 'noop') {
    decision = { type: 'noop', reason: typeof s.reason === 'string' ? s.reason : undefined }
  } else {
    return null
  }

  return { decision, raw: JSON.stringify(s) }
}

// ─── User-turn composers ────────────────────────────────────────────────────
// Each returns the text we pty.write to the conductor. Keep them terse —
// they accumulate in the conductor's context across a dispatch.

export function composeInitialTurn(userPrompt: string): string {
  const trimmed = userPrompt.trim()
  return `New dispatch. User task:\n${trimmed || '(empty — ask the user for one before assigning work)'}\n\nEmit one {type:"assign"} decision line with the initial round of assignments.`
}

// Plan-mode kick-off. The user wants to think through the plan with the
// conductor before any zone gets a task. The conductor stays in
// conversation with the user (its PTY is unlocked) and only emits its
// first {type:"assign"} once the user has signalled GO — either by typing
// the literal token GO into the terminal, or (Claude only) by approving
// the plan via the native plan-approval UI (ExitPlanMode).
//
// `conductorRuntime` is used to gate runtime-specific tool references:
// non-Claude runtimes (codex/gemini/opencode) don't have ExitPlanMode and
// will hallucinate calls to it if it's mentioned in the prompt.
export function composePlanModeInitialTurn(userPrompt: string, conductorRuntime: AgentRuntime): string {
  const trimmed = userPrompt.trim()
  const goSignal = conductorRuntime === 'claude'
    ? `The user signals GO in either of two equivalent ways:
1. They type the literal token \`GO\` (case-insensitive) on its own line in the terminal.
2. They approve your plan via the plan-approval UI (ExitPlanMode tool).`
    : `The user signals GO by typing the literal token \`GO\` (case-insensitive) on its own line in the terminal.`

  return `New dispatch in **plan mode**. User task:
${trimmed || '(empty — ask the user what they want built)'}

You are paired with the user directly: the user will type into your terminal. Work through the plan with them. Cover:

- which zones own which files / parts of the system
- the seams between zones (interface contracts, shared file paths)
- order of operations (which zone goes first, what blocks what)
- acceptance criteria
- anything ambiguous in the user's task that needs clarifying

When you have alternatives the user should choose between (test framework, file layout, library, etc.), surface them as a clear numbered list — don't bury the choice in prose.

**Architecture canvas changes during planning.** The zones, components, and edges shown to you above are a snapshot taken when this dispatch started — and zones were spawned from that snapshot. If the discussion uncovers a structural change (a zone needs to be added/removed/renamed, a component should move to a different zone), call it out plainly and ask the user to update the canvas in the UI before giving GO. Structural changes only take effect on a fresh dispatch — the zones you have right now are fixed for this run.

Iterate until the plan is solid. **Do NOT emit any \`{type:"assign"}\` or other structured activity decision yet.** Activity-log lines are reserved for after the user gives GO.

${goSignal}

When the user gives GO, emit your first \`{type:"assign"}\` activity line based on the agreed plan and proceed exactly as you would in a normal dispatch.`
}

export function composeZoneDoneTurn(
  zoneLabel: string,
  participantId: string,
  taskId: string,
  summary: string,
): string {
  return `Zone ${zoneLabel} (\`${participantId}\`) completed ${taskId}: ${summary}\n\nEmit the next decision line.`
}

export function composeZoneFailedTurn(
  zoneLabel: string,
  participantId: string,
  taskId: string,
  reason: string,
  attempts: number,
  retriesAllowed: number,
  exhausted: boolean,
): string {
  const suffix = exhausted
    ? `retries exhausted (${attempts}/${retriesAllowed + 1}). Recover, reroute, or emit {type:"final"}.`
    : `will retry automatically (${attempts}/${retriesAllowed + 1}). Emit {type:"noop"} to acknowledge or override with a new {type:"assign"}.`
  return `Zone ${zoneLabel} (\`${participantId}\`) failed ${taskId}: ${reason}\n${suffix}`
}

export function composeZoneAskTurn(
  zoneLabel: string,
  participantId: string,
  taskId: string,
  question: string,
): string {
  return `Zone ${zoneLabel} (\`${participantId}\`) is blocked on ${taskId}: ${question}\n\nEmit a {type:"answer", targetZoneId:"${participantId}", body:"..."} decision, or reassign.`
}

export function composeStaleTurn(
  zoneLabel: string,
  participantId: string,
  taskId: string,
  staleMinutes: number,
): string {
  return `Zone ${zoneLabel} (\`${participantId}\`) has been stale for ${staleMinutes}m on ${taskId} (no PTY output or activity line). Retry with a new assignment, reassign the task, or mark it failed.`
}

export function composeAllDoneTurn(): string {
  return `All engaged zones reported done. Emit one {type:"final","summary":"..."} decision for the user.`
}

export function composePtyExitTurn(
  zoneLabel: string,
  participantId: string,
  exitCode: number | null,
): string {
  return `Zone ${zoneLabel} (\`${participantId}\`) PTY exited (code ${exitCode ?? 'n/a'}). Further messages to it will fail. Decide how to proceed.`
}

// Conductor emitted {type:'final'} while zones are still in-flight. Tell it
// who's still working and require it to wait for the all-done signal.
export function composePrematureFinalTurn(
  stillRunning: Array<{ label: string; participantId: string; taskId: string | null }>,
): string {
  const list = stillRunning
    .map(z => `${z.label} (\`${z.participantId}\`)${z.taskId ? ` on ${z.taskId}` : ''}`)
    .join(', ')
  return `Premature {type:"final"} rejected. Zones still in-flight: ${list}. Wait for the all-done signal before emitting final, or reassign/cancel the outstanding tasks.`
}

// A zone emitted kind:'ask' for a taskId that isn't currently assigned to
// it. KV was not mutated; tell the conductor the ask was dropped so it
// doesn't try to ANSWER a phantom.
export function composeUnassignedAskDroppedTurn(
  zoneLabel: string,
  participantId: string,
  claimedTaskId: string,
  question: string,
): string {
  return `Zone ${zoneLabel} (\`${participantId}\`) emitted an ask for task \`${claimedTaskId}\` that it was never assigned. Dropped. Question content (for context): ${question}. Reassign if needed.`
}

// An assignment was rejected. Used for unknown-zone, duplicate-task,
// empty-body, and unknown-dependency reasons (parametric so we don't
// proliferate composers).
export function composeAssignRejectedTurn(
  reason: 'unknown-zone' | 'duplicate-task' | 'empty-body' | 'unknown-dependency',
  details: { zoneId?: string; taskId?: string; knownZoneIds?: string[]; unknownDependency?: string },
): string {
  switch (reason) {
    case 'unknown-zone': {
      const known = details.knownZoneIds?.length ? details.knownZoneIds.join(', ') : '(none)'
      return `Assignment to unknown zone \`${details.zoneId ?? '?'}\` rejected. Known zones: ${known}. Reassign or emit {type:"final"}.`
    }
    case 'duplicate-task':
      return `Assignment with duplicate taskId \`${details.taskId ?? '?'}\` rejected — that id is already tracked. Use a new taskId or omit it.`
    case 'empty-body':
      return `Assignment to \`${details.zoneId ?? '?'}\` rejected: body was empty. Provide a concrete task description.`
    case 'unknown-dependency': {
      const known = details.knownZoneIds?.length ? details.knownZoneIds.join(', ') : '(none)'
      return `Assignment to \`${details.zoneId ?? '?'}\` rejected: \`dependsOn\` references unknown zone \`${details.unknownDependency ?? '?'}\`. Known zones: ${known}. Fix the dependency list and re-emit.`
    }
  }
}

// A cancel decision was rejected. Either the named zone doesn't exist or it
// has no current/queued task to cancel.
export function composeCancelRejectedTurn(
  reason: 'unknown-zone' | 'no-current-task',
  details: { zoneId?: string; taskId?: string; knownZoneIds?: string[] },
): string {
  switch (reason) {
    case 'unknown-zone': {
      const known = details.knownZoneIds?.length ? details.knownZoneIds.join(', ') : '(none)'
      return `Cancel for unknown zone \`${details.zoneId ?? '?'}\` rejected. Known zones: ${known}.`
    }
    case 'no-current-task':
      return `Cancel for \`${details.zoneId ?? '?'}\` rejected: that zone has no current or queued task${details.taskId ? ` matching taskId \`${details.taskId}\`` : ''}. Nothing to cancel.`
  }
}

// A queued task can no longer release because one of its declared upstreams
// landed in a terminal failure state (retries exhausted, or cancelled). The
// queued task is auto-failed; tell the conductor so it can recover or
// reassign with a different upstream context.
export function composeQueuedTaskAutoFailedTurn(
  zoneLabel: string,
  participantId: string,
  taskId: string,
  deadUpstreamLabel: string,
  deadUpstreamId: string,
  upstreamFate: 'failed' | 'cancelled',
): string {
  const verb = upstreamFate === 'failed' ? 'exhausted retries' : 'was cancelled'
  return `Queued task ${taskId} for ${zoneLabel} (\`${participantId}\`) auto-failed: upstream ${deadUpstreamLabel} (\`${deadUpstreamId}\`) ${verb}, so the dependency can never be satisfied. Reassign with a different plan or emit {type:"final"} if the dispatch is dead.`
}

// Two or more zones are blocked on each other. Surface the cycle to the
// conductor; do not auto-resolve.
export function composeDeadlockTurn(cycle: Array<{ label: string; participantId: string }>): string {
  const chain = cycle.map(z => `${z.label} (\`${z.participantId}\`)`).join(' → ')
  return `Deadlock detected: ${chain} → (back to start). Break the cycle by answering one of the asks or cancelling/reassigning a task.`
}
