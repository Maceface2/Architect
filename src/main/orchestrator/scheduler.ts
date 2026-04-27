import { randomBytes } from 'crypto'
import type { AgentRuntime } from '../../shared/agentRuntimes'
import {
  appendDispatchConductorDecision,
  setDispatchPendingTasks,
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
  composeDeadlockTurn,
  composePrematureFinalTurn,
  composePtyExitTurn,
  composeStaleTurn,
  composeUnassignedAskDroppedTurn,
  composeZoneAskTurn,
  composeZoneDoneTurn,
  composeZoneFailedTurn,
  parseDecision,
  type ConductorDecision,
  type ParsedDecision,
} from './conductor'
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
  private statusTimer: NodeJS.Timeout | null = null
  private stopped = false
  private finalEmitted = false

  constructor(config: SchedulerConfig, deps: SchedulerDeps) {
    this.config = config
    this.deps = deps

    this.ptyByParticipant.set(CONDUCTOR_PARTICIPANT_ID, config.conductorZoneId)
    for (const zone of config.zones) {
      this.ptyByParticipant.set(zone.participantId, zone.zoneId)
      this.participantById.set(zone.participantId, zone)
    }
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false
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
  redispatchTask(task: PendingTask): void {
    const zone = this.participantById.get(task.participantId)
    if (!zone) {
      console.warn(`[scheduler] redispatch: unknown participant ${task.participantId}`)
      return
    }
    this.dispatchTaskInternal({
      zoneId: task.zoneId,
      participantId: task.participantId,
      body: task.body,
      taskId: task.taskId,
      attempts: task.attempts,
    })
  }

  // Called by dispatch.ts when a zone's PTY exits. Surfaces to the conductor
  // and marks the task failed.
  handlePtyExit(participantId: string, exitCode: number | null): void {
    if (this.stopped) return
    const zone = this.participantById.get(participantId)
    if (!zone) return
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
    this.executeDecision(parsed)
  }

  private executeDecision(parsed: ParsedDecision): void {
    const decision = parsed.decision
    switch (decision.type) {
      case 'assign':
        for (const assignment of decision.assignments) {
          const zone = this.findZoneByLoose(assignment.zoneId)
          if (!zone) {
            console.warn(`[scheduler] conductor assigned to unknown zone "${assignment.zoneId}"`)
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
            this.writeToParticipant(
              CONDUCTOR_PARTICIPANT_ID,
              composeAssignRejectedTurn('duplicate-task', { taskId: assignment.taskId }),
            )
            continue
          }
          if (!assignment.body || assignment.body.trim().length === 0) {
            this.writeToParticipant(
              CONDUCTOR_PARTICIPANT_ID,
              composeAssignRejectedTurn('empty-body', { zoneId: zone.participantId }),
            )
            continue
          }
          this.dispatchTaskInternal({
            zoneId: zone.zoneId,
            participantId: zone.participantId,
            body: assignment.body,
            taskId: assignment.taskId,
            attempts: 0,
          })
        }
        break
      case 'answer':
        this.deliverAnswer(decision)
        break
      case 'final': {
        if (this.finalEmitted) break
        // Premature-final gate: collect every still-in-flight task. If any
        // exist, push a correction turn back to the conductor and DO NOT
        // fire onDispatchComplete. Mitigates the conductor short-circuiting
        // a dispatch by saying "final" while zones are still working.
        const stillRunning: Array<{ label: string; participantId: string; taskId: string | null }> = []
        for (const task of this.tasksByTaskId.values()) {
          if (task.status === 'done' || task.status === 'failed') continue
          const zone = this.participantById.get(task.participantId)
          stillRunning.push({
            label: zone?.label ?? task.participantId,
            participantId: task.participantId,
            taskId: task.taskId,
          })
        }
        if (stillRunning.length) {
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
    // Assignment guard: the task must currently belong to this zone. Drops
    // orphan-done events that name a taskId assigned to someone else.
    if (task.participantId !== zone.participantId) {
      console.warn(`[scheduler] ${zone.participantId} cross-zone done dropped: taskId=${taskId} belongs to ${task.participantId}`)
      return false
    }
    task.status = 'done'
    this.currentTaskByParticipant.delete(zone.participantId)
    this.blockedOnByParticipant.delete(zone.participantId)
    this.updateStateAtomic(zone.participantId, {
      lastTaskStatus: 'done',
      lastTaskId: taskId,
    })
    this.persistPendingTasks()

    // If this completion drains the in-flight set, fold the all-done signal
    // into the same conductor turn. Two back-to-back writeToParticipant
    // calls would coalesce paste before Enter fires (writeToParticipant's
    // \r is delayed 120ms), submitting both texts as one muddled turn.
    let conductorTurn = composeZoneDoneTurn(zone.label, zone.participantId, taskId, event.content)
    if (!this.finalEmitted && this.isAllDone()) {
      conductorTurn += '\n\n' + composeAllDoneTurn()
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
      // Re-deliver immediately. Include the prior error in the prompt so
      // the zone knows to try a different approach.
      this.writeToParticipant(
        zone.participantId,
        `TASK ${taskId} (retry ${task.attempts}/${zone.retriesAllowed}): ${task.body}\n\nPrevious attempt failed: ${event.content}\nTry a different approach.`,
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

  private dispatchTaskInternal(opts: {
    zoneId: string
    participantId: string
    body: string
    taskId?: string
    attempts: number
  }): string {
    // Defense in depth — parseDecision rejects empty bodies, but a future
    // caller (resume path, retry path) might bypass that. Don't pty.write a
    // bare `TASK <id>:` prompt; it'd loop the zone into an empty ask.
    if (!opts.body || opts.body.trim().length === 0) {
      console.warn(`[scheduler] dispatchTaskInternal called with empty body for ${opts.participantId}; skipping`)
      return ''
    }
    // If the conductor reassigns a zone before its previous task reached a
    // terminal state, mark the prior task superseded so it stops counting
    // against maybeIsAllDone(). Without this, the dispatch can never reach
    // {type:'final'} — the orphaned task pins anyInFlight=true forever.
    const prevTaskId = this.currentTaskByParticipant.get(opts.participantId)
    if (prevTaskId && prevTaskId !== opts.taskId) {
      const prevTask = this.tasksByTaskId.get(prevTaskId)
      if (prevTask && prevTask.status !== 'done' && prevTask.status !== 'failed') {
        prevTask.status = 'failed'
        prevTask.lastError = 'superseded by conductor reassignment'
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
      status: 'dispatched',
      attempts: opts.attempts,
      startedAt: now,
    }
    this.tasksByTaskId.set(taskId, task)
    this.currentTaskByParticipant.set(opts.participantId, taskId)
    this.updateStateAtomic(opts.participantId, {
      lastTaskId: taskId,
      lastTaskStatus: 'dispatched',
      lastTaskStartedAt: now,
      staleAt: undefined,
    })
    this.persistPendingTasks()
    this.writeToParticipant(opts.participantId, `TASK ${taskId}: ${opts.body}`)
    return taskId
  }

  private persistPendingTasks(): void {
    const pending: PendingTask[] = []
    for (const task of this.tasksByTaskId.values()) {
      if (task.status === 'done' || task.status === 'failed') continue
      pending.push({
        taskId: task.taskId,
        zoneId: task.zoneId,
        participantId: task.participantId,
        body: task.body,
        status: task.status as 'pending' | 'dispatched' | 'in-progress' | 'blocked',
        attempts: task.attempts,
        startedAt: task.startedAt,
      })
    }
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
  private isAllDone(): boolean {
    const anyInFlight = Array.from(this.tasksByTaskId.values()).some(t =>
      t.status !== 'done' && t.status !== 'failed',
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
    this.deps.broadcastState({
      dispatchId: this.config.dispatchId,
      participantId,
      status,
      lastTaskId: state.lastTaskId,
    })
  }

  // ─── utilities ───────────────────────────────────────────────────────────

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
