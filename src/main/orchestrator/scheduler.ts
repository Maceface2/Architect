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
  composePtyExitTurn,
  composeStaleTurn,
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
  // pty.write to the given participant. The scheduler translates
  // participantId → terminal PTY id internally.
  writeToPty(ptyId: string, text: string): void
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
  // body pinned in DispatchRecord.pendingTasks so downstream correlation
  // keeps working.
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
    this.updateStateAtomic(participantId, { lastActivityTs: event.ts })

    if (participantId === CONDUCTOR_PARTICIPANT_ID) {
      this.handleConductorActivity(event)
    } else {
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
      case 'final':
        if (!this.finalEmitted) {
          this.finalEmitted = true
          this.deps.onDispatchComplete(decision.summary)
        }
        break
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
    const currentTaskId = this.currentTaskByParticipant.get(zone.participantId)
    if (currentTaskId) {
      const task = this.tasksByTaskId.get(currentTaskId)
      if (task) {
        task.status = 'in-progress'
      }
      this.updateStateAtomic(zone.participantId, {
        lastTaskStatus: 'in-progress',
      })
    }
    const taskId = currentTaskId ?? 'unknown'
    this.writeToParticipant(zone.participantId, `ANSWER ${taskId}: ${decision.body}`)
    this.persistPendingTasks()
  }

  private handleZoneActivity(participantId: string, event: ActivityEvent): void {
    const zone = this.participantById.get(participantId)
    if (!zone) return
    const currentTaskId = this.currentTaskByParticipant.get(participantId)
    const task = currentTaskId ? this.tasksByTaskId.get(currentTaskId) : undefined

    switch (event.kind) {
      case 'task-received':
        if (task && (!event.taskId || event.taskId === task.taskId)) {
          task.status = 'in-progress'
          this.updateStateAtomic(participantId, {
            lastTaskStatus: 'in-progress',
          })
          this.persistPendingTasks()
        }
        break
      case 'progress':
      case 'note':
        // Activity line alone is enough; state already updated above.
        break
      case 'done':
        this.onZoneTaskDone(zone, event)
        break
      case 'failed':
        this.onZoneTaskFailed(zone, event)
        break
      case 'ask':
        this.onZoneTaskAsk(zone, event)
        break
      case 'answer':
        // Zones don't emit 'answer' — that kind is reserved for conductor
        // flows. Ignore if seen.
        break
    }

    this.broadcastStateFor(participantId)
  }

  private onZoneTaskDone(zone: SchedulerZone, event: ActivityEvent): void {
    const taskId = event.taskId ?? this.currentTaskByParticipant.get(zone.participantId)
    if (!taskId) return
    const task = this.tasksByTaskId.get(taskId)
    if (!task || task.status === 'done') return
    task.status = 'done'
    this.currentTaskByParticipant.delete(zone.participantId)
    this.updateStateAtomic(zone.participantId, {
      lastTaskStatus: 'done',
      lastTaskId: taskId,
    })
    this.persistPendingTasks()

    this.writeToParticipant(
      CONDUCTOR_PARTICIPANT_ID,
      composeZoneDoneTurn(zone.label, zone.participantId, taskId, event.content),
    )
    this.maybeSignalAllDone()
  }

  private onZoneTaskFailed(zone: SchedulerZone, event: ActivityEvent): void {
    const taskId = event.taskId ?? this.currentTaskByParticipant.get(zone.participantId)
    if (!taskId) return
    const task = this.tasksByTaskId.get(taskId)
    if (!task) return

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
      return
    }

    // Exhausted. Defer to conductor for recovery.
    task.status = 'failed'
    task.lastError = event.content
    this.currentTaskByParticipant.delete(zone.participantId)
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
  }

  private onZoneTaskAsk(zone: SchedulerZone, event: ActivityEvent): void {
    const taskId = event.taskId ?? this.currentTaskByParticipant.get(zone.participantId)
    if (!taskId) return
    const task = this.tasksByTaskId.get(taskId)
    if (task) task.status = 'blocked'
    this.updateStateAtomic(zone.participantId, {
      lastTaskStatus: 'blocked',
      lastTaskId: taskId,
    })
    this.persistPendingTasks()
    this.writeToParticipant(
      CONDUCTOR_PARTICIPANT_ID,
      composeZoneAskTurn(zone.label, zone.participantId, taskId, event.content),
    )
  }

  // ─── task dispatch ───────────────────────────────────────────────────────

  private dispatchTaskInternal(opts: {
    zoneId: string
    participantId: string
    body: string
    taskId?: string
    attempts: number
  }): string {
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

  private maybeSignalAllDone(): void {
    if (this.finalEmitted) return
    // "All done" = no in-flight tasks AND at least one completed task exists.
    const anyInFlight = Array.from(this.tasksByTaskId.values()).some(t =>
      t.status !== 'done' && t.status !== 'failed',
    )
    if (anyInFlight) return
    const anyDone = Array.from(this.tasksByTaskId.values()).some(t => t.status === 'done')
    if (!anyDone) return
    this.writeToParticipant(CONDUCTOR_PARTICIPANT_ID, composeAllDoneTurn())
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
    const events = tailActivity(path, 1)
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
    // Two-step submit: write the text as one chunk, then send Enter after a
    // short delay. Claude's multi-line TUI treats a single burst of bytes as
    // pasted content and doesn't interpret an embedded/trailing \r as the
    // Enter key — so the text lands in the input buffer but the turn never
    // submits. Separating Enter into its own event past the paste-detection
    // window (tmux uses ~50ms; we pad to 120ms for margin) makes the TUI
    // treat it as a distinct keystroke.
    this.deps.writeToPty(ptyId, text)
    setTimeout(() => {
      if (this.stopped) return
      this.deps.writeToPty(ptyId, '\r')
    }, 120)
  }
}

function mintTaskId(): string {
  return `t-${randomBytes(4).toString('hex')}`
}
