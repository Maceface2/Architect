// Shared orchestration types — used by main, preload, and renderer. The
// main-side authoritative definition lives in src/main/orchestrator/orchestrationLog.ts;
// this module re-declares the wire-level shape so the renderer + preload don't
// have to import main-only modules. Keep this in sync with OrchestrationKind /
// OrchestrationEvent in orchestrationLog.ts.

export type OrchestrationKind =
  | 'dispatch-started'
  | 'task-dispatched'
  | 'task-queued'                  // assignment received but waiting on dependsOn upstreams
  | 'task-released'                // queued task's dependsOn satisfied; now dispatched
  | 'task-superseded'
  | 'task-retried'
  | 'task-exhausted'
  | 'task-answered'
  | 'task-cancelled'               // conductor emitted {type:'cancel'} for this task
  | 'queued-task-auto-failed'      // queued task's upstream failed/cancelled before it could release
  | 'queued-task-resume-dropped'   // queued task lost on resume (completedZones starts cold)
  | 'cancel-rejected'              // {type:'cancel'} targeted unknown zone or no current task
  | 'all-done-detected'
  | 'conductor-decision'
  | 'plan-recorded'
  | 'assign-rejected'
  | 'premature-final'
  | 'pty-exit'
  | 'status-change'
  | 'stale-escalation'
  | 'unassigned-ask-dropped'
  | 'deadlock-detected'
  | 'redispatched'
  | 'exploration-dispatched'       // conductor dispatched a read-only exploration task to a zone
  | 'exploration-complete'         // all exploration_reports collected; bundle sent to conductor
  | 'explore-rejected'             // {type:'explore'} after plan was already recorded
  | 'architecture-flag'            // zone flagged a structural canvas change (notify-only)

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
