import { randomBytes } from 'crypto'
import type { AgentRuntime } from '../../shared/agentRuntimes'
import {
  appendDispatchConductorDecision,
  setDispatchCompletedZones,
  setDispatchPendingTasks,
  setDispatchPlanMetadata,
  type PendingTask,
} from '../dispatchCapture'
import {
  activityLogPath,
  tailActivity,
  watchActivity,
  type ActivityEvent,
  type ActivityWatcher,
} from './activity'
import {
  composeAllDoneTurn,
  composeAssignRejectedTurn,
  composeCancelRejectedTurn,
  composeDeadlockTurn,
  composePlanRecordedTurn,
  composePrematureFinalTurn,
  composePtyExitTurn,
  composeQueuedTaskAutoFailedTurn,
  composeStaleTurn,
  composeUnassignedAskDroppedTurn,
  composeZoneAskTurn,
  composeZoneDoneTurn,
  composeZoneFailedTurn,
  parseDecision,
  type ConductorDecision,
  type ParsedDecision,
} from './conductor'
import type { OrchestrationEvent } from './orchestrationLog'
import {
  hasSharedPlan,
  sharedPlanPath,
  sharedWorkboardPath,
  writeMinimalSharedPlan,
  writeSharedPlan,
  writeWorkboard,
  type WorkboardTask,
} from './sharedPlan'
import { readState, stateFilePath, updateState, type ParticipantState, type TaskStatus } from './state'
import { computeParticipantStatus, shouldEscalateStale, type ParticipantStatus } from './status'

// v5 scheduler. Owns per-task state, activity-log watching, conductor
// invocation, and staleness escalation. A single Scheduler instance runs
// per dispatch; dispatch.ts constructs it after all PTYs are spawned.
//
// Pure coordinator: the scheduler never spawns PTYs directly. It calls
// `deps.writeToPty(participantId, text)` to deliver prompts and exposes
// state back to dispatch.ts so it can persist pendingTasks / decisions.

export const CONDUCTOR_PARTICIPANT_ID = 'conductor'

export interface SchedulerZone {
  zoneId: string       // PTY id, matches terminals.sessions key
  participantId: string // activity-log / state-file id
  label: string
  runtime: AgentRuntime
  retriesAllowed: number
}

export interface SchedulerConfig {
  projectDir: string
  dispatchId: string
  architectSessionId: string  // DispatchRecord key
  conductorZoneId: string     // PTY id for the conductor session
  zones: SchedulerZone[]
  idleThresholdMs: number
  // How long a stale streak must persist before the scheduler escalates
  // to the conductor. Default 10 min per the Layer 4 plan.
  staleEscalationMs: number
  statusTickMs: number
  // ParticipantIds known to have completed at least one task in this
  // dispatch already (loaded from DispatchRecord.completedZones on resume).
  // Seeds the in-memory `completedZones` set so dependsOn gates that
  // released during the prior run stay open across the resume.
  initialCompletedZones?: string[]
  // Shared plan metadata restored from DispatchRecord on resume. Older v5
  // records may not have it; the scheduler can create a minimal resume plan.
  initialPlanRevision?: number
  userPrompt?: string
  initialPendingTasks?: PendingTask[]
}

export interface SchedulerDeps {
  // Submit a full user turn (body + Enter) to the given PTY. The implementor
  // owns the two-step submit (body → 120ms gap → \r) and any queueing while
  // the user holds manual control. Scheduler doesn't time the submit itself.
  submitTurn(ptyId: string, text: string): void
  broadcastActivity(event: {
    dispatchId: string
    participantId: string
    event: ActivityEvent
  }): void
  broadcastState(event: {
    dispatchId: string
    participantId: string
    status: ParticipantStatus
    lastTaskId?: string
  }): void
  // Emitted exactly once when the conductor issues {type:"final",summary}.
  onDispatchComplete(summary: string): void
  // Called whenever the in-flight task set changes. Callers persist.
  onPendingTasksChanged(pendingTasks: PendingTask[]): void
  // Read the live PTY's last-activity timestamp (ms). Used alongside the
  // activity log to decide staleness. Returns null if the PTY is not alive.
  getPtyLastActivityMs(ptyId: string): number | null
  // Harness-authored orchestration log line. dispatch.ts implements this as
  // appendOrchestration(...) + broadcast('activity:orchestration', ...) so the
  // scheduler stays a pure coordinator (matches how broadcastActivity works —
  // scheduler observes, never writes the activity log itself).
  recordOrchestration(event: OrchestrationEvent): void
}

interface InFlightTask {
  taskId: string
  zoneId: string
  participantId: string
  body: string
  status: TaskStatus
  attempts: number
  startedAt: string
  lastError?: string
  // Populated for tasks created via {assign, dependsOn:[...]}. Tasks remain
  // in `status:'queued'` until every entry in `dependsOn` is observed in a
  // zone's `done` event (tracked via `completedZones`). The list does not
  // shrink as deps complete — `unmetUpstreams(task)` re-derives the live
  // unmet set from the current `completedZones` snapshot.
  dependsOn?: string[]
}

export class Scheduler {
  private readonly config: SchedulerConfig
  private readonly deps: SchedulerDeps
  private readonly watchers: ActivityWatcher[] = []
  private readonly tasksByTaskId = new Map<string, InFlightTask>()
  private readonly currentTaskByParticipant = new Map<string, string>()
  private readonly ptyByParticipant = new Map<string, string>()
  private readonly participantById = new Map<string, SchedulerZone>()
  // Tracks who each blocked zone is waiting on. Populated when a zone's
  // ask carries `structured.blockedOn` pointing at another known participant.
  // Cleared when the zone is unblocked (answered, done, or failed).
  private readonly blockedOnByParticipant = new Map<string, string>()
  // Participants that have produced at least one `done` event in this
  // dispatch. Used to evaluate `dependsOn` for queued tasks. We track the
  // participant rather than per-task because `dependsOn` references zones,
  // not specific taskIds — once a zone reaches `done`, anything waiting on
  // that zone is unblocked regardless of which task did it.
  private readonly completedZones = new Set<string>()
  // Last status broadcast per participant. Used to suppress duplicate
  // status-change orchestration entries — the 15s tick re-broadcasts the
  // current status unconditionally, so without this every tick would spam
  // a no-op 'status-change' line.
  private readonly lastStatusByParticipant = new Map<string, ParticipantStatus>()
  private statusTimer: NodeJS.Timeout | null = null
  private stopped = false
  private finalEmitted = false
  private planReady = false
  private planRevision = 0

  constructor(config: SchedulerConfig, deps: SchedulerDeps) {
    this.config = config
    this.deps = deps

    this.ptyByParticipant.set(CONDUCTOR_PARTICIPANT_ID, config.conductorZoneId)
    for (const zone of config.zones) {
      this.ptyByParticipant.set(zone.participantId, zone.zoneId)
      this.participantById.set(zone.participantId, zone)
    }
    if (config.initialCompletedZones) {
      for (const pid of config.initialCompletedZones) {
        if (this.participantById.has(pid)) this.completedZones.add(pid)
      }
    }
    const restoredRevision = config.initialPlanRevision ?? 0
    if (restoredRevision > 0 && hasSharedPlan(config.projectDir, config.dispatchId)) {
      this.planReady = true
      this.planRevision = restoredRevision
    }
  }

  private persistCompletedZones(): void {
    try {
      setDispatchCompletedZones(
        this.config.projectDir,
        this.config.architectSessionId,
        Array.from(this.completedZones),
      )
    } catch (err) {
      console.error('[scheduler] failed to persist completedZones', err)
    }
  }

  // ─── orchestration log helper ────────────────────────────────────────────

  // All orchestration events flow through here so the scheduler doesn't have
  // to repeat the ts/dispatchId boilerplate at every hook site. dispatch.ts
  // owns the actual append + IPC broadcast in its recordOrchestration impl.
  private recordOrchestration(event: Omit<OrchestrationEvent, 'ts'>): void {
    this.deps.recordOrchestration({ ts: new Date().toISOString(), ...event })
  }

  private participantLabel(participantId: string): string {
    if (participantId === CONDUCTOR_PARTICIPANT_ID) return 'Conductor'
    return this.participantById.get(participantId)?.label ?? participantId
  }

  // Emit a status-change orchestration line iff status actually moved. Both
  // the 15s tick path and the per-event broadcast path call this — without
  // dedup against `lastStatusByParticipant`, ticks would spam the log with
  // no-op transitions on every interval.
  private emitStatusChange(participantId: string, status: ParticipantStatus, lastTaskId: string | undefined): void {
    const prevStatus = this.lastStatusByParticipant.get(participantId)
    if (prevStatus === status) return
    this.lastStatusByParticipant.set(participantId, status)
    this.recordOrchestration({
      kind: 'status-change',
      participantId,
      taskId: lastTaskId,
      summary: `${this.participantLabel(participantId)}: ${prevStatus ?? '—'} → ${status}`,
      structured: { from: prevStatus ?? null, to: status },
    })
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false
    this.ensurePlanForResume()
    this.writeWorkboardSnapshot()
    // Attach a watcher per participant. Each log already exists (workspace
    // setup touched it), so watchActivity can attach synchronously.
    const attach = (participantId: string): void => {
      const path = activityLogPath(this.config.projectDir, this.config.dispatchId, participantId)
      const watcher = watchActivity(
        path,
        event => this.handleActivity(participantId, event),
        (line, err) => {
          console.warn(`[scheduler] ${participantId} activity parse error:`, err.message, 'line=', line.slice(0, 200))
        },
        participantId,
      )
      this.watchers.push(watcher)
    }
    attach(CONDUCTOR_PARTICIPANT_ID)
    for (const zone of this.config.zones) attach(zone.participantId)

    // Kick the status tick.
    this.statusTimer = setInterval(() => this.runStatusTick(), this.config.statusTickMs)
    // Node timers keep the event loop alive; we don't want the scheduler
    // to block app shutdown. unref so Ctrl-C / window-closed exits cleanly.
    this.statusTimer.unref()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const watcher of this.watchers) watcher.dispose()
    this.watchers.length = 0
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
  }

  // ─── public API used by dispatch.ts ──────────────────────────────────────

  // Re-deliver an in-flight task on resume. Callers pass the same taskId/
  // body pinned in DispatchRecord.pendingTasks so task correlation keeps
  // working.
  //
  // Queued tasks aren't auto-revived even though `completedZones` rehydrates
  // from DispatchRecord (so the dep gate could in principle release): the
  // conductor's plan may be stale across the resume gap, and silently
  // dispatching a task it no longer wants is worse than asking it to
  // re-emit. We drop with an orchestration line + a conductor turn so the
  // conductor sees the old plan was lost. Dispatched / in-progress /
  // blocked / pending tasks redispatch exactly as before.
  redispatchTask(task: PendingTask): void {
    const zone = this.participantById.get(task.participantId)
    if (!zone) {
      console.warn(`[scheduler] redispatch: unknown participant ${task.participantId}`)
      return
    }
    if (task.status === 'queued') {
      this.recordOrchestration({
        kind: 'queued-task-resume-dropped',
        participantId: task.participantId,
        taskId: task.taskId,
        summary: `Dropped queued task ${task.taskId} on resume — conductor plan may be stale; reissue if still needed`,
        structured: { dependsOn: task.dependsOn ?? [] },
      })
      this.writeToParticipant(
        CONDUCTOR_PARTICIPANT_ID,
        `Queued task ${task.taskId} for ${zone.label} (\`${task.participantId}\`, was waiting on ${task.dependsOn?.join(', ') ?? '—'}) was dropped on resume. Re-issue the assignment if you still want it dispatched.`,
      )
      return
    }
    this.recordOrchestration({
      kind: 'redispatched',
      participantId: task.participantId,
      taskId: task.taskId,
      summary: `Re-delivering pending task to ${zone.label} on resume`,
      structured: { attempts: task.attempts, status: task.status },
    })
    const created = this.createInFlightTask({
      zoneId: task.zoneId,
      participantId: task.participantId,
      body: task.body,
      taskId: task.taskId,
      attempts: task.attempts,
      initialStatus: 'pending',
    })
    if (created) this.writeTaskToZone(created)
  }

  // Called by dispatch.ts when a zone's PTY exits. Surfaces to the conductor
  // and marks the task failed.
  handlePtyExit(participantId: string, exitCode: number | null): void {
    if (this.stopped) return
    const zone = this.participantById.get(participantId)
    if (!zone) return
    this.recordOrchestration({
      kind: 'pty-exit',
      participantId,
      taskId: this.currentTaskByParticipant.get(participantId),
      summary: `${zone.label} PTY exited (code ${exitCode ?? 'n/a'})`,
      structured: { exitCode },
    })
    this.updateStateAtomic(participantId, { ptyAlive: false })
    this.blockedOnByParticipant.delete(participantId)
    const currentTaskId = this.currentTaskByParticipant.get(participantId)
    if (currentTaskId) {
      const task = this.tasksByTaskId.get(currentTaskId)
      if (task) {
        task.status = 'failed'
        task.lastError = `PTY exited with code ${exitCode ?? 'n/a'}`
      }
      this.currentTaskByParticipant.delete(participantId)
      this.persistPendingTasks()
    }
    this.writeToParticipant(
      CONDUCTOR_PARTICIPANT_ID,
      composePtyExitTurn(zone.label, participantId, exitCode),
    )
    // PTY exit is terminal for this zone — anything queued waiting on it
    // can never release. Treat like a retry-exhausted failure.
    this.cascadeAutoFail(participantId, 'failed')
  }

  // ─── activity handling ───────────────────────────────────────────────────

  private handleActivity(participantId: string, event: ActivityEvent): void {
    if (this.stopped) return
    this.deps.broadcastActivity({
      dispatchId: this.config.dispatchId,
      participantId,
      event,
    })

    if (participantId === CONDUCTOR_PARTICIPANT_ID) {
      // Conductor lines are always meaningful (they're decisions or audit
      // notes); refresh its lastActivityTs from wall-clock unconditionally.
      // The event-supplied `ts` is not trusted — a hostile/hallucinating
      // sender could backdate or post-date it to manipulate stale detection.
      this.updateStateAtomic(participantId, { lastActivityTs: new Date().toISOString() })
      this.handleConductorActivity(event)
    } else {
      // For zones, only refresh lastActivityTs if the event passes
      // validation (correct authorship, taskId actually assigned to this
      // zone). Orphan events from a confused zone shouldn't suppress its
      // own staleness clock.
      this.handleZoneActivity(participantId, event)
    }
  }

  private handleConductorActivity(event: ActivityEvent): void {
    const parsed = parseDecision(event)
    if (!parsed) return
    try {
      appendDispatchConductorDecision(
        this.config.projectDir,
        this.config.architectSessionId,
        parsed.raw,
      )
    } catch (err) {
      console.error('[scheduler] failed to persist conductor decision', err)
    }
    this.recordOrchestration({
      kind: 'conductor-decision',
      participantId: CONDUCTOR_PARTICIPANT_ID,
      summary: orchestrationSummaryForDecision(parsed.decision),
      structured: { decision: parsed.decision },
    })
    this.executeDecision(parsed)
  }

  private executeDecision(parsed: ParsedDecision): void {
    const decision = parsed.decision
    switch (decision.type) {
      case 'plan':
        this.recordSharedPlan(decision)
        break
      case 'assign':
        if (!this.planReady) {
          this.recordOrchestration({
            kind: 'assign-rejected',
            summary: 'Rejected assign before shared plan was recorded',
            structured: { reason: 'plan-required' },
          })
          this.writeToParticipant(
            CONDUCTOR_PARTICIPANT_ID,
            composeAssignRejectedTurn('plan-required', {}),
          )
          break
        }
        for (const assignment of decision.assignments) {
          const zone = this.findZoneByLoose(assignment.zoneId)
          if (!zone) {
            console.warn(`[scheduler] conductor assigned to unknown zone "${assignment.zoneId}"`)
            this.recordOrchestration({
              kind: 'assign-rejected',
              summary: `Rejected assign to unknown zone "${assignment.zoneId}"`,
              structured: { reason: 'unknown-zone', zoneId: assignment.zoneId },
            })
            this.writeToParticipant(
              CONDUCTOR_PARTICIPANT_ID,
              composeAssignRejectedTurn('unknown-zone', {
                zoneId: assignment.zoneId,
                knownZoneIds: this.config.zones.map(z => z.participantId),
              }),
            )
            continue
          }
          if (assignment.taskId && this.tasksByTaskId.has(assignment.taskId)) {
            console.warn(`[scheduler] duplicate taskId "${assignment.taskId}" rejected`)
            this.recordOrchestration({
              kind: 'assign-rejected',
              participantId: zone.participantId,
              taskId: assignment.taskId,
              summary: `Rejected duplicate taskId ${assignment.taskId}`,
              structured: { reason: 'duplicate-task' },
            })
            this.writeToParticipant(
              CONDUCTOR_PARTICIPANT_ID,
              composeAssignRejectedTurn('duplicate-task', { taskId: assignment.taskId }),
            )
            continue
          }
          if (!assignment.body || assignment.body.trim().length === 0) {
            this.recordOrchestration({
              kind: 'assign-rejected',
              participantId: zone.participantId,
              summary: `Rejected empty-body assign to ${zone.label}`,
              structured: { reason: 'empty-body' },
            })
            this.writeToParticipant(
              CONDUCTOR_PARTICIPANT_ID,
              composeAssignRejectedTurn('empty-body', { zoneId: zone.participantId }),
            )
            continue
          }
          // Validate dependsOn against the known participant set. The
          // conductor names zones by participantId in dependsOn; reject any
          // unknown id rather than silently letting the task stay queued
          // forever.
          const declaredDeps = assignment.dependsOn ?? []
          let depsValid = true
          for (const dep of declaredDeps) {
            const depZone = this.findZoneByLoose(dep)
            if (!depZone) {
              this.recordOrchestration({
                kind: 'assign-rejected',
                participantId: zone.participantId,
                summary: `Rejected assign to ${zone.label}: unknown dependsOn "${dep}"`,
                structured: { reason: 'unknown-dependency', zoneId: zone.participantId, unknownDependency: dep },
              })
              this.writeToParticipant(
                CONDUCTOR_PARTICIPANT_ID,
                composeAssignRejectedTurn('unknown-dependency', {
                  zoneId: zone.participantId,
                  unknownDependency: dep,
                  knownZoneIds: this.config.zones.map(z => z.participantId),
                }),
              )
              depsValid = false
              break
            }
          }
          if (!depsValid) continue

          // Normalize deps to participantIds (declaredDeps may contain
          // zoneIds via findZoneByLoose tolerance). Drop self-deps and
          // dedupe so we don't gate a zone on itself.
          const normalizedDeps = Array.from(
            new Set(
              declaredDeps
                .map(d => this.findZoneByLoose(d)?.participantId)
                .filter((pid): pid is string => !!pid && pid !== zone.participantId),
            ),
          )
          const unmet = normalizedDeps.filter(pid => !this.completedZones.has(pid))

          if (unmet.length === 0) {
            const created = this.createInFlightTask({
              zoneId: zone.zoneId,
              participantId: zone.participantId,
              body: assignment.body,
              taskId: assignment.taskId,
              attempts: 0,
              dependsOn: normalizedDeps.length > 0 ? normalizedDeps : undefined,
              initialStatus: 'pending',
            })
            if (created) this.writeTaskToZone(created)
          } else {
            // Queue the task. Don't pty.write; release happens in
            // onZoneTaskDone when the last unmet dep completes.
            const created = this.createInFlightTask({
              zoneId: zone.zoneId,
              participantId: zone.participantId,
              body: assignment.body,
              taskId: assignment.taskId,
              attempts: 0,
              dependsOn: normalizedDeps,
              initialStatus: 'queued',
            })
            if (created) {
              this.recordOrchestration({
                kind: 'task-queued',
                participantId: zone.participantId,
                taskId: created.taskId,
                summary: `Queued ${created.taskId} for ${zone.label} (waiting on: ${unmet.join(', ')})`,
                structured: { dependsOn: normalizedDeps, unmet },
              })
            }
          }
        }
        break
      case 'answer':
        this.deliverAnswer(decision)
        break
      case 'cancel':
        this.executeCancel(decision)
        break
      case 'final': {
        if (this.finalEmitted) break
        // Premature-final gate: collect every still-in-flight task. If any
        // exist, push a correction turn back to the conductor and DO NOT
        // fire onDispatchComplete. Mitigates the conductor short-circuiting
        // a dispatch by saying "final" while zones are still working.
        // Queued tasks count as in-flight — they have a declared plan that
        // hasn't released yet.
        const stillRunning: Array<{ label: string; participantId: string; taskId: string | null }> = []
        for (const task of this.tasksByTaskId.values()) {
          if (isTerminalStatus(task.status)) continue
          const zone = this.participantById.get(task.participantId)
          stillRunning.push({
            label: zone?.label ?? task.participantId,
            participantId: task.participantId,
            taskId: task.taskId,
          })
        }
        if (stillRunning.length) {
          this.recordOrchestration({
            kind: 'premature-final',
            summary: `Conductor sent {final} but ${stillRunning.length} task(s) still running`,
            structured: { stillRunning },
          })
          this.writeToParticipant(
            CONDUCTOR_PARTICIPANT_ID,
            composePrematureFinalTurn(stillRunning),
          )
          break
        }
        this.finalEmitted = true
        this.deps.onDispatchComplete(decision.summary)
        break
      }
      case 'noop':
        // Intentional no-op. Logged via appendDispatchConductorDecision.
        break
    }
  }

  private executeCancel(decision: Extract<ConductorDecision, { type: 'cancel' }>): void {
    const zone = this.findZoneByLoose(decision.zoneId)
    if (!zone) {
      this.recordOrchestration({
        kind: 'cancel-rejected',
        summary: `Cancel rejected: unknown zone "${decision.zoneId}"`,
        structured: { reason: 'unknown-zone', zoneId: decision.zoneId },
      })
      this.writeToParticipant(
        CONDUCTOR_PARTICIPANT_ID,
        composeCancelRejectedTurn('unknown-zone', {
          zoneId: decision.zoneId,
          knownZoneIds: this.config.zones.map(z => z.participantId),
        }),
      )
      return
    }
    // Resolve which task to cancel: an explicit taskId if provided and
    // assigned to this zone, otherwise the zone's current task, otherwise
    // any queued task for this zone. We pick the most-recent in-flight
    // entry — terminal tasks are not cancellable.
    let task: InFlightTask | undefined
    if (decision.taskId) {
      const candidate = this.tasksByTaskId.get(decision.taskId)
      if (candidate && candidate.participantId === zone.participantId && !isTerminalStatus(candidate.status)) {
        task = candidate
      }
    } else {
      const currentId = this.currentTaskByParticipant.get(zone.participantId)
      if (currentId) {
        const current = this.tasksByTaskId.get(currentId)
        if (current && !isTerminalStatus(current.status)) task = current
      }
      if (!task) {
        for (const t of this.tasksByTaskId.values()) {
          if (t.participantId === zone.participantId && t.status === 'queued') {
            task = t
            break
          }
        }
      }
    }
    if (!task) {
      this.recordOrchestration({
        kind: 'cancel-rejected',
        participantId: zone.participantId,
        taskId: decision.taskId,
        summary: `Cancel rejected: ${zone.label} has no current/queued task${decision.taskId ? ` matching ${decision.taskId}` : ''}`,
        structured: { reason: 'no-current-task', zoneId: zone.participantId },
      })
      this.writeToParticipant(
        CONDUCTOR_PARTICIPANT_ID,
        composeCancelRejectedTurn('no-current-task', {
          zoneId: zone.participantId,
          taskId: decision.taskId,
          knownZoneIds: this.config.zones.map(z => z.participantId),
        }),
      )
      return
    }

    const wasQueued = task.status === 'queued'
    const reason = decision.reason ?? 'cancelled by conductor'
    task.status = 'cancelled'
    task.lastError = reason
    if (this.currentTaskByParticipant.get(zone.participantId) === task.taskId) {
      this.currentTaskByParticipant.delete(zone.participantId)
    }
    this.blockedOnByParticipant.delete(zone.participantId)
    this.updateStateAtomic(zone.participantId, {
      lastTaskStatus: 'cancelled',
      lastTaskId: task.taskId,
    })
    this.persistPendingTasks()
    this.recordOrchestration({
      kind: 'task-cancelled',
      participantId: zone.participantId,
      taskId: task.taskId,
      summary: `${zone.label} task ${task.taskId} cancelled: ${reason}`,
      structured: { reason, wasQueued },
    })
    if (!wasQueued) {
      // The zone has the task in flight — tell it to abort. Queued tasks
      // never reached the PTY, so there's nothing to abort there.
      this.writeToParticipant(zone.participantId, `CANCEL ${task.taskId}: ${reason}`)
    }
    // Cascade: any queued task waiting on this zone can no longer release
    // (the cancelled task isn't a `done`). Auto-fail them.
    this.cascadeAutoFail(zone.participantId, 'cancelled')
  }

  private findZoneByLoose(identifier: string): SchedulerZone | null {
    // Accept either participantId (canonical) or zoneId (React Flow node
    // id). Conductor prompt refers to participantIds; be tolerant of either.
    const byPid = this.participantById.get(identifier)
    if (byPid) return byPid
    for (const zone of this.config.zones) {
      if (zone.zoneId === identifier) return zone
    }
    return null
  }

  private recordSharedPlan(decision: Extract<ConductorDecision, { type: 'plan' }>): void {
    this.planRevision += 1
    this.planReady = true
    const planPath = writeSharedPlan(
      this.config.projectDir,
      this.config.dispatchId,
      decision.markdown,
      this.planRevision,
    )
    const workboardPath = this.writeWorkboardSnapshot()
    try {
      setDispatchPlanMetadata(this.config.projectDir, this.config.architectSessionId, {
        planRevision: this.planRevision,
        planPath,
        workboardPath,
      })
    } catch (err) {
      console.error('[scheduler] failed to persist plan metadata', err)
    }
    this.recordOrchestration({
      kind: 'plan-recorded',
      participantId: CONDUCTOR_PARTICIPANT_ID,
      summary: decision.summary ?? `Shared plan revision ${this.planRevision} recorded`,
      structured: { planRevision: this.planRevision, planPath, workboardPath },
    })
    this.writeToParticipant(
      CONDUCTOR_PARTICIPANT_ID,
      composePlanRecordedTurn(this.planRevision, planPath, workboardPath),
    )
  }

  private deliverAnswer(decision: Extract<ConductorDecision, { type: 'answer' }>): void {
    const zone = this.findZoneByLoose(decision.targetZoneId)
    if (!zone) {
      console.warn(`[scheduler] conductor answered unknown zone "${decision.targetZoneId}"`)
      return
    }
    // Route by the ask's pending taskId, not the harness's stale notion of
    // what task the zone is currently on. If a zone asked about t-X but the
    // harness records its current task as t-Y, we want the answer to land
    // tagged as t-X — that's what the zone is actually waiting for.
    const blocked = this.findPendingAskFor(zone.participantId)
    const currentTaskId = blocked?.taskId ?? this.currentTaskByParticipant.get(zone.participantId)
    if (currentTaskId) {
      const task = this.tasksByTaskId.get(currentTaskId)
      if (task) {
        task.status = 'in-progress'
      }
      this.updateStateAtomic(zone.participantId, {
        lastTaskStatus: 'in-progress',
      })
    }
    // Clearing the blockedOn entry is part of unblocking the zone; if a
    // cycle was previously detected, this also breaks the recorded chain.
    this.blockedOnByParticipant.delete(zone.participantId)
    const taskId = currentTaskId ?? 'unknown'
    this.recordOrchestration({
      kind: 'task-answered',
      participantId: zone.participantId,
      taskId,
      summary: `Conductor answered ${zone.label}; task resumed`,
    })
    this.writeToParticipant(zone.participantId, `ANSWER ${taskId}: ${decision.body}`)
    this.persistPendingTasks()
  }

  private findPendingAskFor(participantId: string): InFlightTask | null {
    for (const task of this.tasksByTaskId.values()) {
      if (task.participantId === participantId && task.status === 'blocked') return task
    }
    return null
  }

  private handleZoneActivity(participantId: string, event: ActivityEvent): void {
    const zone = this.participantById.get(participantId)
    if (!zone) return
    const currentTaskId = this.currentTaskByParticipant.get(participantId)
    const task = currentTaskId ? this.tasksByTaskId.get(currentTaskId) : undefined

    // `validated` controls whether we refresh `lastActivityTs`. Orphan
    // events (claims about taskIds the zone wasn't assigned) shouldn't
    // suppress staleness — that would let a confused zone hide silence
    // behind fake activity.
    let validated = false

    switch (event.kind) {
      case 'task-received':
        if (task && (!event.taskId || event.taskId === task.taskId)) {
          task.status = 'in-progress'
          this.updateStateAtomic(participantId, {
            lastTaskStatus: 'in-progress',
          })
          this.persistPendingTasks()
          validated = true
        }
        break
      case 'progress':
        // Mid-work pings from the assigned zone: only honor if the taskId
        // actually matches the zone's current task. Bare progress notes
        // (no taskId) are accepted as long as the zone has a current task.
        if (task && (!event.taskId || event.taskId === task.taskId)) {
          validated = true
        }
        break
      case 'note':
        // Free-form notes are always allowed. Used for audit/debug; never
        // mutates task state.
        validated = true
        break
      case 'done':
        validated = this.onZoneTaskDone(zone, event)
        break
      case 'failed':
        validated = this.onZoneTaskFailed(zone, event)
        break
      case 'ask':
        validated = this.onZoneTaskAsk(zone, event)
        break
      case 'answer':
        // Zones don't emit 'answer' — that kind is reserved for conductor
        // flows. Ignore if seen.
        break
    }

    if (validated) {
      this.updateStateAtomic(participantId, { lastActivityTs: new Date().toISOString() })
    }
    this.broadcastStateFor(participantId)
  }

  private onZoneTaskDone(zone: SchedulerZone, event: ActivityEvent): boolean {
    const taskId = event.taskId ?? this.currentTaskByParticipant.get(zone.participantId)
    if (!taskId) {
      console.warn(`[scheduler] ${zone.participantId} done dropped: no taskId on event and no current task`)
      return false
    }
    const task = this.tasksByTaskId.get(taskId)
    if (!task) {
      // Orphan: claims a taskId that the harness doesn't track. Loud-warn
      // so stress tests can verify the validation path actually fires
      // (silent rejections were indistinguishable from "fix didn't run").
      console.warn(`[scheduler] ${zone.participantId} orphan done dropped: taskId=${taskId} not assigned`)
      return false
    }
    if (task.status === 'done') return false
    // Late-done after cancel: the conductor cancelled this task and the
    // cascade already auto-failed any downstream queued tasks. If the
    // zone's `done` event for the cancelled task arrives a few ms later,
    // flipping status back to `done` would silently add the zone to
    // `completedZones` and contradict the cancellation. Drop it — the
    // zone prompt teaches agents not to emit `done` for cancelled tasks,
    // so this branch only catches the race where the agent's emit beat
    // the CANCEL pty.write.
    if (task.status === 'cancelled') {
      console.warn(`[scheduler] ${zone.participantId} late-done dropped: taskId=${taskId} was cancelled`)
      return false
    }
    // Assignment guard: the task must currently belong to this zone. Drops
    // orphan-done events that name a taskId assigned to someone else.
    if (task.participantId !== zone.participantId) {
      console.warn(`[scheduler] ${zone.participantId} cross-zone done dropped: taskId=${taskId} belongs to ${task.participantId}`)
      return false
    }
    task.status = 'done'
    this.currentTaskByParticipant.delete(zone.participantId)
    this.blockedOnByParticipant.delete(zone.participantId)
    // Mark the zone as having completed at least one task. Queued tasks
    // gate on this set, not on per-task ids — once a zone reaches `done`,
    // anything `dependsOn` it is unblocked.
    const isFirstCompletion = !this.completedZones.has(zone.participantId)
    this.completedZones.add(zone.participantId)
    if (isFirstCompletion) this.persistCompletedZones()
    this.updateStateAtomic(zone.participantId, {
      lastTaskStatus: 'done',
      lastTaskId: taskId,
    })
    this.persistPendingTasks()
    // Release any queued tasks whose deps are now all green. This may also
    // fire writeTaskToZone, which will persistPendingTasks again — fine,
    // it's idempotent.
    this.tryReleaseQueuedTasks()

    // If this completion drains the in-flight set, fold the all-done signal
    // into the same conductor turn. Two back-to-back writeToParticipant
    // calls would coalesce paste before Enter fires (writeToParticipant's
    // \r is delayed 120ms), submitting both texts as one muddled turn.
    let conductorTurn = composeZoneDoneTurn(zone.label, zone.participantId, taskId, event.content)
    if (!this.finalEmitted && this.isAllDone()) {
      conductorTurn += '\n\n' + composeAllDoneTurn()
      this.recordOrchestration({
        kind: 'all-done-detected',
        summary: 'All engaged zones reported done; prompting conductor for {final}',
      })
    }
    this.writeToParticipant(CONDUCTOR_PARTICIPANT_ID, conductorTurn)
    return true
  }

  private onZoneTaskFailed(zone: SchedulerZone, event: ActivityEvent): boolean {
    const taskId = event.taskId ?? this.currentTaskByParticipant.get(zone.participantId)
    if (!taskId) {
      console.warn(`[scheduler] ${zone.participantId} failed dropped: no taskId on event and no current task`)
      return false
    }
    const task = this.tasksByTaskId.get(taskId)
    if (!task) {
      console.warn(`[scheduler] ${zone.participantId} orphan failed dropped: taskId=${taskId} not assigned`)
      return false
    }
    // Assignment guard: drop failed events that claim a taskId assigned to
    // a different zone.
    if (task.participantId !== zone.participantId) {
      console.warn(`[scheduler] ${zone.participantId} cross-zone failed dropped: taskId=${taskId} belongs to ${task.participantId}`)
      return false
    }

    // Retry path: keep the same taskId so the conductor's outgoing-task
    // correlation stays stable. Only the attempts counter increments.
    if (task.attempts < zone.retriesAllowed) {
      task.attempts += 1
      task.status = 'pending'
      task.lastError = event.content
      this.updateStateAtomic(zone.participantId, {
        lastTaskStatus: 'pending',
        lastTaskId: taskId,
      })
      this.persistPendingTasks()
      this.recordOrchestration({
        kind: 'task-retried',
        participantId: zone.participantId,
        taskId,
        summary: `Retrying ${zone.label} (attempt ${task.attempts}/${zone.retriesAllowed})`,
        structured: { attempts: task.attempts, retriesAllowed: zone.retriesAllowed, reason: event.content },
      })
      // Re-deliver immediately. Include the prior error in the prompt so
      // the zone knows to try a different approach.
      this.writeToParticipant(
        zone.participantId,
        this.composeTaskPrompt(
          task,
          `TASK ${taskId} (retry ${task.attempts}/${zone.retriesAllowed})`,
          `Previous attempt failed: ${event.content}\nTry a different approach.`,
        ),
      )
      this.writeToParticipant(
        CONDUCTOR_PARTICIPANT_ID,
        composeZoneFailedTurn(
          zone.label,
          zone.participantId,
          taskId,
          event.content,
          task.attempts,
          zone.retriesAllowed,
          false,
        ),
      )
      return true
    }

    // Exhausted. Defer to conductor for recovery.
    task.status = 'failed'
    task.lastError = event.content
    this.currentTaskByParticipant.delete(zone.participantId)
    this.blockedOnByParticipant.delete(zone.participantId)
    this.updateStateAtomic(zone.participantId, {
      lastTaskStatus: 'failed',
      lastTaskId: taskId,
    })
    this.persistPendingTasks()
    this.recordOrchestration({
      kind: 'task-exhausted',
      participantId: zone.participantId,
      taskId,
      summary: `${zone.label} exhausted retries (${task.attempts + 1}/${zone.retriesAllowed + 1})`,
      structured: { reason: event.content, attempts: task.attempts + 1 },
    })
    this.writeToParticipant(
      CONDUCTOR_PARTICIPANT_ID,
      composeZoneFailedTurn(
        zone.label,
        zone.participantId,
        taskId,
        event.content,
        task.attempts + 1,
        zone.retriesAllowed,
        true,
      ),
    )
    // Cascade auto-fail to anything queued waiting on this zone — it
    // didn't reach `done`, so the dep gate can never close.
    this.cascadeAutoFail(zone.participantId, 'failed')
    return true
  }

  private onZoneTaskAsk(zone: SchedulerZone, event: ActivityEvent): boolean {
    const taskId = event.taskId ?? this.currentTaskByParticipant.get(zone.participantId)
    if (!taskId) {
      console.warn(`[scheduler] ${zone.participantId} ask dropped: no taskId on event and no current task`)
      return false
    }
    const task = this.tasksByTaskId.get(taskId)
    // Assignment guard: a zone can't claim 'blocked' on a task it was never
    // given. Drop the event, do not mutate KV, and tell the conductor the
    // ask was discarded so it doesn't try to ANSWER a phantom.
    if (!task || task.participantId !== zone.participantId) {
      const reason = !task ? `taskId=${taskId} not assigned` : `taskId=${taskId} belongs to ${task.participantId}`
      console.warn(`[scheduler] ${zone.participantId} unassigned ask dropped: ${reason}`)
      this.recordOrchestration({
        kind: 'unassigned-ask-dropped',
        participantId: zone.participantId,
        taskId,
        summary: `Dropped ask from ${zone.label}: ${reason}`,
        structured: { reason },
      })
      this.writeToParticipant(
        CONDUCTOR_PARTICIPANT_ID,
        composeUnassignedAskDroppedTurn(zone.label, zone.participantId, taskId, event.content),
      )
      return false
    }
    task.status = 'blocked'
    this.updateStateAtomic(zone.participantId, {
      lastTaskStatus: 'blocked',
      lastTaskId: taskId,
    })
    this.persistPendingTasks()

    // Cycle tracking: if the zone names a `blockedOn` participantId in
    // `structured`, record the edge and walk for a cycle. The field is
    // optional and forward-compatible — pre-existing prompts won't include
    // it, in which case we just skip cycle detection for that ask.
    const blockedOnRaw = event.structured && typeof event.structured === 'object'
      ? (event.structured as Record<string, unknown>).blockedOn
      : undefined
    if (typeof blockedOnRaw === 'string' && this.participantById.has(blockedOnRaw) && blockedOnRaw !== zone.participantId) {
      this.blockedOnByParticipant.set(zone.participantId, blockedOnRaw)
      const cycle = this.detectCycle(zone.participantId)
      if (cycle) {
        this.recordOrchestration({
          kind: 'deadlock-detected',
          summary: `Deadlock cycle detected: ${cycle.map(pid => this.participantLabel(pid)).join(' → ')}`,
          structured: { cycle },
        })
        this.writeToParticipant(
          CONDUCTOR_PARTICIPANT_ID,
          composeDeadlockTurn(cycle.map(pid => ({
            label: this.participantById.get(pid)?.label ?? pid,
            participantId: pid,
          }))),
        )
        return true
      }
    }

    this.writeToParticipant(
      CONDUCTOR_PARTICIPANT_ID,
      composeZoneAskTurn(zone.label, zone.participantId, taskId, event.content),
    )
    return true
  }

  // Walks the blockedOn chain starting from `start` and returns the cycle
  // (in order, starting with the participant the cycle returns to) if one
  // exists. Bounded depth to prevent runaway in pathological maps.
  private detectCycle(start: string): string[] | null {
    const path: string[] = []
    const seen = new Set<string>()
    let cur: string | undefined = start
    const maxDepth = this.config.zones.length + 2
    while (cur && path.length <= maxDepth) {
      if (seen.has(cur)) {
        const idx = path.indexOf(cur)
        return idx >= 0 ? path.slice(idx) : null
      }
      seen.add(cur)
      path.push(cur)
      cur = this.blockedOnByParticipant.get(cur)
    }
    return null
  }

  // ─── task dispatch ───────────────────────────────────────────────────────

  // Splits the prior `dispatchTaskInternal` into a "create" step and a
  // "write to PTY" step. Queued tasks get only the create step; release
  // happens later in `tryReleaseQueuedTasks` once their dependsOn is met,
  // at which point we call writeTaskToZone on the existing record.
  private createInFlightTask(opts: {
    zoneId: string
    participantId: string
    body: string
    taskId?: string
    attempts: number
    dependsOn?: string[]
    initialStatus: 'pending' | 'queued'
  }): InFlightTask | null {
    // Defense in depth — parseDecision rejects empty bodies, but a future
    // caller (resume path, retry path) might bypass that. Don't pty.write a
    // bare `TASK <id>:` prompt; it'd loop the zone into an empty ask.
    if (!opts.body || opts.body.trim().length === 0) {
      console.warn(`[scheduler] createInFlightTask called with empty body for ${opts.participantId}; skipping`)
      return null
    }
    // If the conductor reassigns a zone before its previous task reached a
    // terminal state, mark the prior task superseded so it stops counting
    // against maybeIsAllDone(). Without this, the dispatch can never reach
    // {type:'final'} — the orphaned task pins anyInFlight=true forever.
    // A previously-queued task gets the same treatment — the conductor's
    // new assignment overrides the old plan.
    const prevTaskId = this.currentTaskByParticipant.get(opts.participantId)
    if (prevTaskId && prevTaskId !== opts.taskId) {
      const prevTask = this.tasksByTaskId.get(prevTaskId)
      if (prevTask && !isTerminalStatus(prevTask.status)) {
        prevTask.status = 'failed'
        prevTask.lastError = 'superseded by conductor reassignment'
        this.recordOrchestration({
          kind: 'task-superseded',
          participantId: opts.participantId,
          taskId: prevTaskId,
          summary: `Superseded ${prevTaskId} on ${this.participantLabel(opts.participantId)} (reassigned)`,
        })
      }
    }
    // Reassignment unblocks the zone — clear any recorded blockedOn edge.
    this.blockedOnByParticipant.delete(opts.participantId)

    const taskId = opts.taskId ?? mintTaskId()
    const now = new Date().toISOString()
    const task: InFlightTask = {
      taskId,
      zoneId: opts.zoneId,
      participantId: opts.participantId,
      body: opts.body,
      status: opts.initialStatus,
      attempts: opts.attempts,
      startedAt: now,
    }
    if (opts.dependsOn && opts.dependsOn.length > 0) task.dependsOn = opts.dependsOn
    this.tasksByTaskId.set(taskId, task)
    this.currentTaskByParticipant.set(opts.participantId, taskId)
    this.updateStateAtomic(opts.participantId, {
      lastTaskId: taskId,
      lastTaskStatus: opts.initialStatus,
      lastTaskStartedAt: now,
      staleAt: undefined,
    })
    this.persistPendingTasks()
    return task
  }

  private writeTaskToZone(task: InFlightTask): void {
    // Re-stamp startedAt at release time. createInFlightTask set it at
    // queue creation, which can be far in the past for tasks that waited on
    // a slow upstream — leaving it stale would make the UI / any future
    // duration-aware logic claim the task has been running since it was
    // queued, when in fact the zone hasn't seen the prompt yet.
    const now = new Date().toISOString()
    task.startedAt = now
    task.status = 'dispatched'
    this.updateStateAtomic(task.participantId, {
      lastTaskId: task.taskId,
      lastTaskStatus: 'dispatched',
      lastTaskStartedAt: now,
      staleAt: undefined,
    })
    this.persistPendingTasks()
    this.recordOrchestration({
      kind: 'task-dispatched',
      participantId: task.participantId,
      taskId: task.taskId,
      summary: `Dispatched ${task.taskId} to ${this.participantLabel(task.participantId)}`,
      structured: task.attempts > 0 ? { attempts: task.attempts } : undefined,
    })
    this.writeToParticipant(task.participantId, this.composeTaskPrompt(task, `TASK ${task.taskId}`))
  }

  private composeTaskPrompt(task: InFlightTask, heading: string, suffix?: string): string {
    const planPath = sharedPlanPath(this.config.projectDir, this.config.dispatchId)
    const workboardPath = sharedWorkboardPath(this.config.projectDir, this.config.dispatchId)
    const context = [
      'Shared dispatch context:',
      `- Main plan: ${planPath}`,
      `- Workboard: ${workboardPath}`,
      `- Plan revision: ${this.planRevision}`,
      'Read both files before editing. Use the plan for the big picture and the workboard to see what every other zone is doing.',
    ].join('\n')
    return `${heading}:\n${context}\n\n${task.body}${suffix ? `\n\n${suffix}` : ''}`
  }

  // Walks queued tasks and releases any whose dependsOn is now fully
  // satisfied by `completedZones`. Called from onZoneTaskDone after a
  // zone reaches `done`. Releases happen in insertion order so the
  // conductor sees a stable dispatch sequence in the orchestration log.
  private tryReleaseQueuedTasks(): void {
    for (const task of this.tasksByTaskId.values()) {
      if (task.status !== 'queued') continue
      const deps = task.dependsOn ?? []
      const stillUnmet = deps.filter(pid => !this.completedZones.has(pid))
      if (stillUnmet.length === 0) {
        this.recordOrchestration({
          kind: 'task-released',
          participantId: task.participantId,
          taskId: task.taskId,
          summary: `Released ${task.taskId} for ${this.participantLabel(task.participantId)} — dependsOn satisfied`,
          structured: { dependsOn: deps },
        })
        this.writeTaskToZone(task)
      }
    }
  }

  // Auto-fail any queued task that named `deadParticipantId` in its
  // dependsOn. Called when an upstream zone exhausts retries or has its
  // task cancelled — those are terminal, non-`done` states, so anything
  // waiting on them can never release.
  private cascadeAutoFail(deadParticipantId: string, fate: 'failed' | 'cancelled'): void {
    const deadZone = this.participantById.get(deadParticipantId)
    const deadLabel = deadZone?.label ?? deadParticipantId
    for (const task of this.tasksByTaskId.values()) {
      if (task.status !== 'queued') continue
      if (!task.dependsOn?.includes(deadParticipantId)) continue
      task.status = 'failed'
      task.lastError = `upstream ${deadParticipantId} ${fate === 'failed' ? 'exhausted retries' : 'was cancelled'}`
      if (this.currentTaskByParticipant.get(task.participantId) === task.taskId) {
        this.currentTaskByParticipant.delete(task.participantId)
      }
      this.updateStateAtomic(task.participantId, {
        lastTaskStatus: 'failed',
        lastTaskId: task.taskId,
      })
      this.recordOrchestration({
        kind: 'queued-task-auto-failed',
        participantId: task.participantId,
        taskId: task.taskId,
        summary: `Queued ${task.taskId} auto-failed: upstream ${deadLabel} ${fate}`,
        structured: { deadUpstream: deadParticipantId, fate },
      })
      this.writeToParticipant(
        CONDUCTOR_PARTICIPANT_ID,
        composeQueuedTaskAutoFailedTurn(
          this.participantLabel(task.participantId),
          task.participantId,
          task.taskId,
          deadLabel,
          deadParticipantId,
          fate,
        ),
      )
    }
    this.persistPendingTasks()
  }

  private persistPendingTasks(): void {
    const pending: PendingTask[] = []
    for (const task of this.tasksByTaskId.values()) {
      if (isTerminalStatus(task.status)) continue
      const entry: PendingTask = {
        taskId: task.taskId,
        zoneId: task.zoneId,
        participantId: task.participantId,
        body: task.body,
        status: task.status as 'pending' | 'queued' | 'dispatched' | 'in-progress' | 'blocked',
        attempts: task.attempts,
        startedAt: task.startedAt,
      }
      if (task.dependsOn && task.dependsOn.length > 0) entry.dependsOn = task.dependsOn
      pending.push(entry)
    }
    this.writeWorkboardSnapshot()
    this.deps.onPendingTasksChanged(pending)
    try {
      setDispatchPendingTasks(
        this.config.projectDir,
        this.config.architectSessionId,
        pending,
      )
    } catch (err) {
      console.error('[scheduler] failed to persist pendingTasks', err)
    }
  }

  // "All done" = no in-flight tasks AND at least one completed task exists.
  // Queued tasks count as in-flight (their plan hasn't released yet).
  // Cancelled / failed tasks count as terminal.
  private isAllDone(): boolean {
    const anyInFlight = Array.from(this.tasksByTaskId.values()).some(t =>
      !isTerminalStatus(t.status),
    )
    if (anyInFlight) return false
    return Array.from(this.tasksByTaskId.values()).some(t => t.status === 'done')
  }

  // ─── status tick ─────────────────────────────────────────────────────────

  private runStatusTick(): void {
    if (this.stopped) return
    const now = Date.now()
    const participants: string[] = [CONDUCTOR_PARTICIPANT_ID, ...this.config.zones.map(z => z.participantId)]
    for (const pid of participants) {
      this.tickParticipant(pid, now)
    }
  }

  private tickParticipant(participantId: string, now: number): void {
    const statePath = stateFilePath(this.config.projectDir, this.config.dispatchId, participantId)
    const state = readState(statePath)
    if (!state) return

    const ptyId = this.ptyByParticipant.get(participantId)
    const ptyLast = ptyId ? this.deps.getPtyLastActivityMs(ptyId) : null
    const ptyAliveNow = ptyLast !== null
    if (state.ptyAlive !== ptyAliveNow) {
      this.updateStateAtomic(participantId, { ptyAlive: ptyAliveNow })
    }

    const activityTs = state.lastActivityTs ? Date.parse(state.lastActivityTs) : state.lastTaskStartedAt ? Date.parse(state.lastTaskStartedAt) : now
    const ptyIdleMs = ptyLast ? now - ptyLast : Number.POSITIVE_INFINITY
    const activityIdleMs = Number.isFinite(activityTs) ? now - activityTs : Number.POSITIVE_INFINITY
    const lastEvent = this.lastActivityEvent(participantId)

    const status = computeParticipantStatus({
      state: { ...state, ptyAlive: ptyAliveNow },
      lastActivity: lastEvent,
      ptyIdleMs,
      activityIdleMs,
      idleThresholdMs: this.config.idleThresholdMs,
    })

    // Track staleAt transitions.
    if (status === 'stale' && !state.staleAt) {
      this.updateStateAtomic(participantId, { staleAt: new Date(now).toISOString() })
    } else if (status !== 'stale' && state.staleAt) {
      this.updateStateAtomic(participantId, { staleAt: undefined })
    }

    this.emitStatusChange(participantId, status, state.lastTaskId)
    this.deps.broadcastState({
      dispatchId: this.config.dispatchId,
      participantId,
      status,
      lastTaskId: state.lastTaskId,
    })

    // Escalation only applies to zones, not the conductor.
    if (participantId !== CONDUCTOR_PARTICIPANT_ID) {
      const zone = this.participantById.get(participantId)
      if (zone && status === 'stale') {
        const refreshed = readState(statePath)
        if (refreshed && shouldEscalateStale(refreshed, now, this.config.staleEscalationMs)) {
          const currentTaskId = this.currentTaskByParticipant.get(participantId) ?? refreshed.lastTaskId ?? 'unknown'
          const staleMinutes = Math.floor((now - Date.parse(refreshed.staleAt ?? new Date(now).toISOString())) / 60_000)
          this.recordOrchestration({
            kind: 'stale-escalation',
            participantId,
            taskId: currentTaskId,
            summary: `Escalating ${zone.label} (stale ${staleMinutes}m) to conductor`,
            structured: { staleMinutes, escalations: refreshed.staleEscalations + 1 },
          })
          this.writeToParticipant(
            CONDUCTOR_PARTICIPANT_ID,
            composeStaleTurn(zone.label, zone.participantId, currentTaskId, staleMinutes),
          )
          this.updateStateAtomic(participantId, {
            staleEscalations: refreshed.staleEscalations + 1,
            staleAt: undefined,
          })
        }
      }
    }
  }

  private lastActivityEvent(participantId: string): ActivityEvent | null {
    const path = activityLogPath(this.config.projectDir, this.config.dispatchId, participantId)
    const events = tailActivity(path, 1, participantId)
    return events[0] ?? null
  }

  private broadcastStateFor(participantId: string): void {
    const statePath = stateFilePath(this.config.projectDir, this.config.dispatchId, participantId)
    const state = readState(statePath)
    if (!state) return
    const lastEvent = this.lastActivityEvent(participantId)
    const ptyId = this.ptyByParticipant.get(participantId)
    const ptyLast = ptyId ? this.deps.getPtyLastActivityMs(ptyId) : null
    const now = Date.now()
    const activityTs = state.lastActivityTs ? Date.parse(state.lastActivityTs) : now
    const ptyIdleMs = ptyLast ? now - ptyLast : Number.POSITIVE_INFINITY
    const activityIdleMs = Number.isFinite(activityTs) ? now - activityTs : Number.POSITIVE_INFINITY
    const status = computeParticipantStatus({
      state: { ...state, ptyAlive: ptyLast !== null },
      lastActivity: lastEvent,
      ptyIdleMs,
      activityIdleMs,
      idleThresholdMs: this.config.idleThresholdMs,
    })
    this.emitStatusChange(participantId, status, state.lastTaskId)
    this.deps.broadcastState({
      dispatchId: this.config.dispatchId,
      participantId,
      status,
      lastTaskId: state.lastTaskId,
    })
  }

  // ─── utilities ───────────────────────────────────────────────────────────

  private ensurePlanForResume(): void {
    if (this.planReady) return
    const pending = this.config.initialPendingTasks ?? []
    if (pending.length === 0) return

    const planPath = writeMinimalSharedPlan(
      this.config.projectDir,
      this.config.dispatchId,
      this.config.userPrompt ?? '',
      pending,
    )
    this.planReady = true
    this.planRevision = 1
    const workboardPath = this.writeWorkboardSnapshot()
    try {
      setDispatchPlanMetadata(this.config.projectDir, this.config.architectSessionId, {
        planRevision: this.planRevision,
        planPath,
        workboardPath,
      })
    } catch (err) {
      console.error('[scheduler] failed to persist generated resume plan metadata', err)
    }
    this.recordOrchestration({
      kind: 'plan-recorded',
      participantId: CONDUCTOR_PARTICIPANT_ID,
      summary: 'Generated minimal shared plan for resumed dispatch',
      structured: { planRevision: this.planRevision, planPath, workboardPath, generated: true },
    })
  }

  private writeWorkboardSnapshot(): string {
    const tasks: WorkboardTask[] = Array.from(this.tasksByTaskId.values()).map(task => ({
      taskId: task.taskId,
      participantId: task.participantId,
      body: task.body,
      status: task.status,
      attempts: task.attempts,
      startedAt: task.startedAt,
      dependsOn: task.dependsOn,
      lastError: task.lastError,
    }))
    return writeWorkboard({
      projectDir: this.config.projectDir,
      dispatchId: this.config.dispatchId,
      planRevision: this.planRevision,
      zones: this.config.zones.map(zone => ({
        participantId: zone.participantId,
        label: zone.label,
        outputPath: `${this.config.projectDir}/ARCHITECT/outputs/${zone.participantId}.md`,
      })),
      tasks,
      completedZones: Array.from(this.completedZones),
    })
  }

  private updateStateAtomic(participantId: string, patch: Partial<ParticipantState>): void {
    const path = stateFilePath(this.config.projectDir, this.config.dispatchId, participantId)
    updateState(path, patch)
  }

  private writeToParticipant(participantId: string, text: string): void {
    const ptyId = this.ptyByParticipant.get(participantId)
    if (!ptyId) {
      console.warn(`[scheduler] no pty mapped for participant ${participantId}`)
      return
    }
    if (this.stopped) return
    // Delegates the two-step submit (body → 120ms → Enter) and the
    // user-manual-control queue to terminals.ts. See submitTurnToTerminal.
    this.deps.submitTurn(ptyId, text)
  }
}

function mintTaskId(): string {
  return `t-${randomBytes(4).toString('hex')}`
}

// Tasks in any of these states are terminal — no further state transitions
// happen, and they don't count toward "still in flight" gates (premature
// final, all-done detection, etc.). Centralised so additions to the
// TaskStatus union (e.g. 'cancelled' in v5) only need updating in one place.
function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function orchestrationSummaryForDecision(decision: ConductorDecision): string {
  switch (decision.type) {
    case 'plan':
      return `Conductor plan${decision.summary ? `: ${decision.summary}` : ''}`
    case 'assign':
      return decision.assignments.length === 1
        ? `Conductor assign → ${decision.assignments[0].zoneId}`
        : `Conductor assign × ${decision.assignments.length}`
    case 'answer':
      return `Conductor answer → ${decision.targetZoneId}`
    case 'cancel':
      return `Conductor cancel → ${decision.zoneId}${decision.taskId ? ` (${decision.taskId})` : ''}`
    case 'final':
      return `Conductor final: ${decision.summary}`
    case 'noop':
      return `Conductor noop${decision.reason ? `: ${decision.reason}` : ''}`
  }
}
