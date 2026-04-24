import type { ActivityEvent } from './activity'

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
  | { type: 'assign'; assignments: Array<{ zoneId: string; body: string; taskId?: string }> }
  | { type: 'answer'; targetZoneId: string; body: string }
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
  if (!event.structured || typeof event.structured !== 'object') return null
  const s = event.structured as Record<string, unknown>
  if (typeof s.type !== 'string') return null

  let decision: ConductorDecision | null = null
  if (s.type === 'assign') {
    if (!Array.isArray(s.assignments)) return null
    const assignments: Array<{ zoneId: string; body: string; taskId?: string }> = []
    for (const row of s.assignments) {
      if (!row || typeof row !== 'object') return null
      const a = row as Record<string, unknown>
      if (typeof a.zoneId !== 'string' || typeof a.body !== 'string') return null
      const entry: { zoneId: string; body: string; taskId?: string } = {
        zoneId: a.zoneId,
        body: a.body,
      }
      if (typeof a.taskId === 'string') entry.taskId = a.taskId
      assignments.push(entry)
    }
    if (!assignments.length) return null
    decision = { type: 'assign', assignments }
  } else if (s.type === 'answer') {
    if (typeof s.targetZoneId !== 'string' || typeof s.body !== 'string') return null
    decision = { type: 'answer', targetZoneId: s.targetZoneId, body: s.body }
  } else if (s.type === 'final') {
    if (typeof s.summary !== 'string') return null
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
