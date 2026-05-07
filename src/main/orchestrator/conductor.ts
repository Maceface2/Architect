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
  | { type: 'plan'; markdown: string; summary?: string }
  | {
      type: 'explore'
      // Read-only investigation tasks dispatched in parallel before the plan.
      // Each zone returns one `done` event whose `structured` payload carries
      // the exploration_report shape (see prompts/zone.ts). No `dependsOn` —
      // exploration runs flat; synthesis happens afterwards in {type:"plan"}.
      assignments: Array<{
        zoneId: string
        body: string
        taskId?: string
      }>
    }
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
  if (s.type === 'plan') {
    if (typeof s.markdown !== 'string') return null
    if (s.markdown.trim().length === 0) return null
    decision = {
      type: 'plan',
      markdown: s.markdown,
      summary: typeof s.summary === 'string' && s.summary.trim().length > 0 ? s.summary : undefined,
    }
  } else if (s.type === 'assign') {
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
  } else if (s.type === 'explore') {
    if (!Array.isArray(s.assignments)) return null
    const assignments: Array<{ zoneId: string; body: string; taskId?: string }> = []
    for (const row of s.assignments) {
      if (!row || typeof row !== 'object') return null
      const a = row as Record<string, unknown>
      if (typeof a.zoneId !== 'string' || typeof a.body !== 'string') return null
      if (a.zoneId.trim().length === 0) return null
      if (a.body.trim().length === 0) return null
      const entry: { zoneId: string; body: string; taskId?: string } = {
        zoneId: a.zoneId,
        body: a.body,
      }
      if (typeof a.taskId === 'string') entry.taskId = a.taskId
      assignments.push(entry)
    }
    if (!assignments.length) return null
    decision = { type: 'explore', assignments }
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
  return `New dispatch. User task:
${trimmed || '(empty — ask the user for one before assigning work)'}

**Default flow: delegate code reading to zones via {type:"explore"} before you plan.** Each zone reads its own slice in parallel and returns a structured exploration_report (scope, current state, dependencies, findings, proposed work). The harness collects them, diffs cross-zone contracts (needs_from vs provides_to), and sends you the bundle plus any mismatches as one user turn. You then synthesize {type:"plan"} grounded in concrete reports instead of canvas projection alone.

Skip exploration only for trivial / well-scoped tasks (single-file change, isolated tweak). For anything spanning multiple zones, anything with uncertain scope, or anything where you'd otherwise read code yourself — emit {type:"explore"} first.

You retain the right to read project files yourself for cross-zone reconciliation when reports conflict, look thin, or surface a contract mismatch you need to verify. Use it as an escape hatch, not the default.

Sequence:
1. (optional but usual) {type:"explore"} → harness dispatches read-only investigations to zones in parallel.
2. Harness sends one user turn with all exploration_reports + contract-mismatch summary.
3. {type:"plan"} → markdown plan grounded in reports: goal, engaged zones, per-zone responsibilities, ordering/dependencies, cross-zone contracts, acceptance criteria, non-goals.
4. {type:"assign"} → execution waves. Plan can be revised mid-dispatch with another {type:"plan"} if the user prompts changes.

The dispatch stays open after the first wave finishes. When the user types more requests at you, treat them as follow-up dispatches — assign new tasks, optionally revise the plan, ask zones questions on the user's behalf. Only emit {type:"final"} when the user signals they're done with this dispatch.`
}

// Plan-mode kick-off. The user pairs with the conductor directly to shape
// the plan before any zone gets a task. The conductor reads project source
// as needed (Conductor catches integration issues zones can't see), but
// zones do NOT run their own plan loops — the conductor owns planning.
//
// `conductorRuntime` gates runtime-specific tool references. Claude has
// AskUserQuestion + ExitPlanMode; other runtimes get a tool-agnostic
// numbered-list + approval-keyword fallback.
export function composePlanModeInitialTurn(userPrompt: string, conductorRuntime: AgentRuntime): string {
  const trimmed = userPrompt.trim()
  const approvalGuidance = conductorRuntime === 'claude'
    ? `Use **AskUserQuestion** for clarifications (one question per call when the choice matters; batch with multiple questions only when several small choices arrive together). Do NOT dump grouped questions in prose. When the plan is ready, use **ExitPlanMode** to request approval — do not invent a custom approval keyword.`
    : `Surface clarifying choices as a clear numbered list (one decision at a time when it matters). When the plan is ready, ask the user to reply with \`approve\` (or \`revise <notes>\`) to signal go-ahead.`

  return `New dispatch in **plan mode**. User task:
${trimmed || '(empty — ask the user what they want built)'}

You are paired with the user directly: they will type into your terminal. Work through the plan with them.

**Default flow: delegate code reading to zones via {type:"explore"}.** When the user's task touches multiple zones or has uncertain scope, your first move (after any clarifying questions) is one \`{type:"explore"}\` decision dispatching read-only investigations to each relevant zone. Each zone reads its own slice in parallel and returns an exploration_report (scope, current state, dependencies, findings, proposed work, optional architecture flag). The harness bundles them with a cross-zone contract-mismatch summary and sends them back as one user turn. You then ground the plan you build with the user in those reports instead of skimming code yourself.

Skip exploration only for trivial / single-zone changes. Do NOT default to reading project files yourself — that's the slower serial path and the whole point of the zones is they can audit their own slices in parallel.

You may still read project files yourself as an **escape hatch** for cross-zone reconciliation: when two zones' reports disagree on a contract, when one zone's report is thin, or when the harness flags a mismatch you need to verify directly. Use it for surgical reads, not as the default investigation strategy.

Cover with the user:
- which zones own which files / parts of the system (informed by exploration_reports)
- seams between zones (interface contracts, shared file paths) — reconcile contract mismatches surfaced by the harness
- order of operations and what blocks what
- acceptance criteria
- anything ambiguous in the user's task

${approvalGuidance}

**Canvas is frozen for this dispatch.** Zones/components/edges shown above are a snapshot; zones were spawned from it. If exploration reports flag a structural change (\`architecture_update_required: true\`), or the discussion uncovers one, tell the user to apply it via the Architecture Assistant — the change takes effect on the next dispatch, not this one.

Sequence:
1. (usual) Clarifying \`AskUserQuestion\` if the task is ambiguous.
2. (usual for multi-zone) \`{type:"explore"}\` → harness dispatches read-only investigations.
3. Harness sends bundled exploration_reports + contract-mismatch summary back as one user turn.
4. Discuss the plan with the user in prose, grounded in reports.
5. On user approval, emit one \`{type:"plan"}\` with the agreed markdown plan.
6. \`{type:"assign"}\` only after the plan is recorded. Revise with another \`{type:"plan"}\` if the user prompts changes.

The dispatch stays open after the first wave finishes. When the user types more requests at you, treat them as follow-up dispatches — assign new tasks, optionally revise the plan, ask zones questions on the user's behalf. Only emit \`{type:"final"}\` when the user signals they're done with this dispatch.`
}

export function composePlanRecordedTurn(planRevision: number, planPath: string, workboardPath: string): string {
  return `Shared plan revision ${planRevision} recorded at ${planPath}. Workboard is at ${workboardPath}. You can keep planning with the user in this same dispatch and emit another {type:"plan"} revision if they request changes. When the recorded plan is ready to execute, emit one {type:"assign"} decision line for the next wave of work.`
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
  return `All engaged zones reported done for the current wave. The dispatch stays open — zones are still alive and you can dispatch more work. Stand by for the user's next instruction. If they ask for follow-up work (a tweak, a question for a zone, a new feature), emit {type:"assign"} (revising the plan first via {type:"plan"} if scope expanded). Only emit {type:"final","summary":"..."} when the user signals they're done with this dispatch (e.g. "we're done", "close it out", or by closing the UI).`
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
  reason: 'plan-required' | 'exploration-incomplete' | 'unknown-zone' | 'duplicate-task' | 'empty-body' | 'unknown-dependency',
  details: { zoneId?: string; taskId?: string; knownZoneIds?: string[]; unknownDependency?: string; pendingExploration?: string[] },
): string {
  switch (reason) {
    case 'plan-required':
      return `Assignment rejected: no shared plan has been recorded yet. First emit {type:"plan", markdown:"..."} with the big-picture plan. You may revise that plan through more {type:"plan"} decisions in this same dispatch before assigning work.`
    case 'exploration-incomplete': {
      const pending = details.pendingExploration?.length
        ? details.pendingExploration.join(', ')
        : '(unknown)'
      return `Assignment rejected: exploration is still in progress. Waiting on: ${pending}. Wait for the harness to forward the exploration_report bundle, then emit {type:"plan"} before assigning execution work.`
    }
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

// All exploration tasks are done; bundle the structured reports + a
// contract-mismatch summary into one user turn. The conductor reads this
// and emits {type:"plan"} grounded in concrete findings (or {type:"explore"}
// again for follow-ups, or targeted file reads for reconciliation).
export interface ExplorationReport {
  participantId: string
  label: string
  taskId: string
  scopeSummary: string
  currentState: string
  needsFrom: string[]
  providesTo: string[]
  findings: string[]
  proposedWork: string
  architectureUpdateRequired: boolean
  architectureChangeDescription?: string
}

export interface ContractMismatch {
  // 'unmatched-need' = zone A says it needs X from B, B's provides_to lacks
  // matching content. 'unmatched-provide' = zone A says it provides X to B,
  // B's needs_from lacks matching content.
  kind: 'unmatched-need' | 'unmatched-provide'
  fromParticipantId: string
  fromLabel: string
  toParticipantId: string
  toLabel: string
  detail: string
}

export function composeExplorationCompleteTurn(
  reports: ExplorationReport[],
  mismatches: ContractMismatch[],
): string {
  const lines: string[] = [
    `All exploration tasks reported done (${reports.length}). Synthesize a {type:"plan"} grounded in these reports.`,
    '',
    '## Reports',
    '',
  ]
  for (const r of reports) {
    lines.push(`### ${r.label} (\`${r.participantId}\`) — ${r.taskId}`)
    lines.push(`- **Scope:** ${r.scopeSummary}`)
    lines.push(`- **Current state:** ${r.currentState}`)
    if (r.needsFrom.length) lines.push(`- **Needs from:** ${r.needsFrom.join(', ')}`)
    if (r.providesTo.length) lines.push(`- **Provides to:** ${r.providesTo.join(', ')}`)
    if (r.findings.length) lines.push(`- **Findings:** ${r.findings.join('; ')}`)
    lines.push(`- **Proposed work:** ${r.proposedWork}`)
    if (r.architectureUpdateRequired) {
      lines.push(`- **⚠ architecture_update_required:** ${r.architectureChangeDescription ?? '(no description provided)'}`)
    }
    lines.push('')
  }
  if (mismatches.length) {
    lines.push('## Cross-zone contract mismatches')
    lines.push('')
    for (const m of mismatches) {
      lines.push(`- **${m.kind}** — ${m.fromLabel} (\`${m.fromParticipantId}\`) → ${m.toLabel} (\`${m.toParticipantId}\`): ${m.detail}`)
    }
    lines.push('')
    lines.push('Reconcile each mismatch in your plan: either revise the contract, ask a clarifying question via {type:"explore"} again, or read the relevant files directly.')
  } else {
    lines.push('## Cross-zone contract mismatches')
    lines.push('')
    lines.push('_(no contract mismatches detected across reports.)_')
  }
  lines.push('')
  lines.push('Now emit one {type:"plan"} decision integrating these findings, then {type:"assign"} when the plan is ready.')
  return lines.join('\n')
}

// Zone flagged a structural canvas change during exploration or execution.
// Notify-only contract: conductor pauses, user resolves manually via the
// Architecture Assistant, change applies on the next dispatch.
export function composeArchitectureFlagTurn(
  zoneLabel: string,
  participantId: string,
  description: string,
): string {
  return `Zone ${zoneLabel} (\`${participantId}\`) flagged a canvas change: ${description}\n\nPause execution dispatch. Tell the user to apply this change via the Architecture Assistant — the canvas is frozen for the current dispatch, so the change takes effect on the next one. Emit {type:"noop"} to acknowledge, or carry on with non-conflicting work if the flag does not block the rest of the plan.`
}

// Two or more zones are blocked on each other. Surface the cycle to the
// conductor; do not auto-resolve.
export function composeDeadlockTurn(cycle: Array<{ label: string; participantId: string }>): string {
  const chain = cycle.map(z => `${z.label} (\`${z.participantId}\`)`).join(' → ')
  return `Deadlock detected: ${chain} → (back to start). Break the cycle by answering one of the asks or cancelling/reassigning a task.`
}
