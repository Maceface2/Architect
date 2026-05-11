import { BrowserWindow } from 'electron'
import fs from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

import {
  DEFAULT_MODEL_BY_RUNTIME,
  type AgentRuntime,
} from '../../shared/agentRuntimes'
import {
  saveDispatch,
  upsertDispatchZoneSession,
  getDispatch,
  summarizeFromPrompt,
  DISPATCH_PROTOCOL_VERSION,
  type DispatchRecord,
  type PendingTask,
} from '../dispatchCapture'
import { appendZoneSession, getZoneSessionRecord } from '../sessionCapture'
import { getRuntimeAdapter } from '../runtimes'
import {
  getSessionLastActivityMs,
  indexGraph,
  getZoneRuntime,
  getZoneModel,
  normalizeProjectSettings,
  readSkillContent,
  sanitize,
  serializeAgentSpawn,
  setActiveDispatchCoordinator,
  spawnAgentSession,
  submitTurnToTerminal,
  killAll,
  type GraphEdge,
  type GraphNode,
  type TerminalInfo,
  type ZoneGraphNode,
  type ComponentGraphNode,
} from '../terminals'
import { runZone } from '../terminals'
import { CONDUCTOR_PARTICIPANT_ID, Scheduler, type SchedulerDeps, type SchedulerZone } from './scheduler'
import { composeInitialTurn, composePlanModeInitialTurn } from './conductor'
import { activityLogPath } from './activity'
import { appendOrchestration, orchestrationLogPath, type OrchestrationEvent } from './orchestrationLog'
import { recordHelperPath } from './recordHelper'
import { setupWorkspaceV5, type WorkspaceInput, type WorkspaceZoneInput } from './workspace'

// Minimal bootstrap prompt delivered to every fresh-spawned zone as its
// first user turn. Purpose: force the CLI to create an on-disk session
// file so session capture can succeed (otherwise a zone sitting idle at
// its prompt never materializes in ~/.claude/projects/, ~/.codex/sessions/,
// etc., and resumes later have no id to key on). The prompt asks for a
// one-word ack — not an activity-log line, since the zone hasn't been
// handed a taskId yet.
const ZONE_BOOTSTRAP_PROMPT =
  'Acknowledge readiness with a single short line ("Ready"). Do NOT append an activity-log line yet — the conductor has not assigned a taskId. Then stop and wait for your first TASK.'

// v5 dispatch entry points. Replaces terminals.ts's v4 startDispatch +
// resumeDispatch. Those remain as thin forwarders that dynamic-import this
// module (to avoid a module-load cycle).

export const CONDUCTOR_PTY_ID = 'conductor-agent'

const CAPTURE_SERIAL_TIMEOUT_MS = 20_000
const STATUS_TICK_MS = 15_000

export interface StartDispatchV5Input {
  win: BrowserWindow
  nodes: GraphNode[]
  edges: GraphEdge[]
  projectDir: string
  rawSettings: unknown
  dispatch: {
    userPrompt: string
    model?: string
    planMode?: boolean
    onlyZoneIds?: string[]
    // Orchestrator (Conductor) CLI chosen in the DispatchModal dropdown.
    // When absent, falls back to settings.dispatchRuntime. Zone CLIs are
    // unaffected — each zone keeps its own agentRuntime.
    conductorRuntime?: AgentRuntime
  }
}

export interface ResumeDispatchV5Input {
  win: BrowserWindow
  projectDir: string
  dispatchId: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  rawSettings: unknown
}

export type ResumeDispatchV5Result =
  | { ok: true; info: TerminalInfo[] }
  | { ok: false; error: 'not-found' | 'legacy-protocol' }

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

interface ZoneIdentity {
  participantId: string
  displayLabel: string
}

// Read canvas-minted participantIds off each zone and pair with the current
// display label. Uniqueness is enforced in the renderer (see mintParticipantId
// + migrateCanvasData); this helper layers a defensive fallback in case a
// zone arrives without a participantId (stale clients, hand-edited canvas
// files) — it synthesizes one from the label with dedup against ids already
// seen in this dispatch set.
function assignZoneIdentities(zones: ZoneGraphNode[]): Map<string, ZoneIdentity> {
  const used = new Set<string>()
  const out = new Map<string, ZoneIdentity>()
  const pending: ZoneGraphNode[] = []

  for (const zone of zones) {
    const stored = typeof zone.data.participantId === 'string' ? zone.data.participantId.trim() : ''
    if (stored && !used.has(stored)) {
      used.add(stored)
      out.set(zone.id, { participantId: stored, displayLabel: zone.data.label })
    } else {
      pending.push(zone)
    }
  }
  for (const zone of pending) {
    const base = sanitize(zone.data.label) || 'zone'
    let pid = base
    let n = 2
    while (used.has(pid)) {
      pid = `${base}-${n}`
      n += 1
    }
    used.add(pid)
    out.set(zone.id, { participantId: pid, displayLabel: zone.data.label })
    console.warn(`[dispatch-v5] zone ${zone.id} missing participantId; synthesized ${pid}`)
  }
  return out
}

function buildWorkspaceZoneInput(
  zone: ZoneGraphNode,
  identities: Map<string, ZoneIdentity>,
  runtime: AgentRuntime,
  model: string,
): WorkspaceZoneInput {
  const identity = identities.get(zone.id)
  if (!identity) throw new Error(`buildWorkspaceZoneInput: missing identity for zone ${zone.id}`)
  const enabledTools = Object.entries(zone.data.tools ?? {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
  const skills = (zone.data.skills ?? [])
    .map(skill => ({ name: skill.name, content: readSkillContent(skill.path) }))
    .filter(s => !!s.content)

  return {
    zoneId: zone.id,
    participantId: identity.participantId,
    label: identity.displayLabel,
    description: zone.data.description,
    runtime,
    model,
    enabledTools,
    systemPromptOverride: (zone.data.systemPrompt ?? '').trim(),
    skills,
  }
}

function buildWorkspaceInput(
  projectDir: string,
  dispatchId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  filteredZones: ZoneGraphNode[],
  userPrompt: string | undefined,
  dispatchRuntime: AgentRuntime,
  rawSettings: unknown,
): { input: WorkspaceInput; zones: WorkspaceZoneInput[] } {
  const identities = assignZoneIdentities(filteredZones)

  const zones: WorkspaceZoneInput[] = filteredZones.map(zone => {
    const runtime = getZoneRuntime(zone, normalizeProjectSettings(rawSettings))
    const model = getZoneModel(zone, runtime)
    return buildWorkspaceZoneInput(zone, identities, runtime, model)
  })

  return {
    input: {
      projectDir,
      dispatchId,
      dispatchRuntime,
      userPrompt,
      nodes,
      edges,
      zones,
    },
    zones,
  }
}

function buildSchedulerZones(workspaceZones: WorkspaceZoneInput[], filteredZones: ZoneGraphNode[]): SchedulerZone[] {
  const byId = new Map(workspaceZones.map(z => [z.zoneId, z]))
  return filteredZones.map(zone => {
    const ws = byId.get(zone.id)
    const retries = typeof zone.data.behavior?.retries === 'number' ? zone.data.behavior.retries : 0
    return {
      zoneId: zone.id,
      participantId: ws?.participantId ?? sanitize(zone.data.label),
      label: ws?.label ?? zone.data.label,
      runtime: ws?.runtime ?? 'claude',
      retriesAllowed: Math.max(0, retries),
    }
  })
}

// Append-and-broadcast helper for orchestration events. Pulled out of the
// SchedulerDeps closure so both the scheduler and the dispatch entry points
// (e.g. the dispatch-started kickoff) can emit through the same path.
function emitOrchestrationDirect(
  projectDir: string,
  dispatchId: string,
  broadcastFn: typeof broadcast,
  event: OrchestrationEvent,
): void {
  try {
    appendOrchestration(orchestrationLogPath(projectDir, dispatchId), event)
  } catch (err) {
    console.error('[dispatch-v5] failed to append orchestration log', err)
  }
  broadcastFn('activity:orchestration', { dispatchId, event })
}

// Shared SchedulerDeps builder used by both startDispatchV5 and resumeDispatchV5.
// Keeps the wiring identical between the two entry points so a deps change
// (e.g. adding recordOrchestration) doesn't have to be remembered in two places.
// Annotated with `: SchedulerDeps` so a future field addition fails compilation
// here rather than letting the inferred shape silently drift from the contract.
function buildSchedulerDeps(
  projectDir: string,
  dispatchId: string,
  broadcastFn: typeof broadcast,
): SchedulerDeps {
  return {
    submitTurn: (ptyId, text) => submitTurnToTerminal(ptyId, text),
    broadcastActivity: event => broadcastFn('activity:event', event),
    broadcastState: event => broadcastFn('activity:state', event),
    onDispatchComplete: summary => broadcastFn('dispatch:complete', { dispatchId, summary }),
    onPendingTasksChanged: () => {
      // setDispatchPendingTasks is called inside the scheduler for durable
      // persistence; this callback is the IPC broadcast hook. (No listeners
      // today — renderer reads state via activity:state.)
    },
    getPtyLastActivityMs: ptyId => getSessionLastActivityMs(ptyId),
    recordOrchestration: event =>
      emitOrchestrationDirect(projectDir, dispatchId, broadcastFn, event),
  }
}

export async function startDispatchV5(input: StartDispatchV5Input): Promise<TerminalInfo[]> {
  const { win, nodes, edges, projectDir, rawSettings, dispatch } = input
  killAll()
  const settings = normalizeProjectSettings(rawSettings)
  const userPrompt = (dispatch.userPrompt ?? '').trim()
  const dispatchSummary = summarizeFromPrompt(userPrompt)

  // Graph selection — filter to onlyZoneIds if caller requested.
  const { zones: allZones } = indexGraph(nodes)
  const onlyIds = dispatch.onlyZoneIds && dispatch.onlyZoneIds.length > 0
    ? new Set(dispatch.onlyZoneIds)
    : null
  const selectedZones = onlyIds ? allZones.filter(z => onlyIds.has(z.id)) : allZones
  if (selectedZones.length === 0) {
    throw new Error('no zones selected for dispatch')
  }
  const selectedIdSet = new Set(selectedZones.map(z => z.id))

  // Single-zone dispatch: no conductor needed. runZone handles the solo
  // prompt + direct user-driven interaction path.
  if (selectedZones.length === 1) {
    const zone = selectedZones[0]
    const runtime = getZoneRuntime(zone, settings)
    const result = await runZone(win, {
      projectDir,
      zoneId: zone.id,
      nodes,
      edges,
      mode: 'new',
      summary: dispatchSummary,
      userPrompt,
      model: dispatch.model,
      planMode: dispatch.planMode === true,
      settings: rawSettings,
    })
    if (!result.ok) throw new Error(`runZone failed: ${result.reason ?? 'unknown'}`)
    return [{ id: zone.id, label: zone.data.label, runtime }]
  }

  // Multi-zone dispatch. Mint a fresh dispatchId and lay down the workspace.
  const dispatchId = randomBytes(8).toString('hex')
  const filteredNodes = nodes.filter(n => n.type !== 'zone' || selectedIdSet.has(n.id))
  // Resolve the Conductor runtime early — preferred source is the explicit
  // dropdown pick in the DispatchModal, with the canvas default as fallback.
  const conductorRuntime: AgentRuntime = dispatch.conductorRuntime ?? settings.dispatchRuntime
  const { input: workspaceInput, zones: workspaceZones } = buildWorkspaceInput(
    projectDir,
    dispatchId,
    filteredNodes,
    edges,
    selectedZones,
    userPrompt,
    conductorRuntime,
    rawSettings,
  )
  setupWorkspaceV5(workspaceInput)

  // Emit the originating user prompt as the first orchestration line so the
  // swimlane's conductor column opens with the actual task instead of a blank
  // wait until the conductor's first decision lands.
  emitOrchestrationDirect(projectDir, dispatchId, broadcast, {
    ts: new Date().toISOString(),
    kind: 'dispatch-started',
    participantId: CONDUCTOR_PARTICIPANT_ID,
    summary: userPrompt || '(no user prompt)',
    structured: { model: dispatch.model, planMode: dispatch.planMode === true },
  })

  // Broadcast the initial TerminalInfo set so the renderer can begin rendering
  // tabs incrementally as each PTY spawns.
  const wsByZoneId = new Map(workspaceZones.map(w => [w.zoneId, w]))
  const allInfo: TerminalInfo[] = [
    { id: CONDUCTOR_PTY_ID, label: 'Conductor', runtime: conductorRuntime, coordinatedMode: true },
    ...selectedZones.map(zone => ({
      id: zone.id,
      label: wsByZoneId.get(zone.id)?.label ?? zone.data.label,
      runtime: getZoneRuntime(zone, settings),
      coordinatedMode: true,
    })),
  ]

  let architectSessionId: string | null = null
  const pendingZoneUpserts: Array<() => void> = []
  let scheduler: Scheduler | null = null

  const onZoneExit = (participantId: string) => (exitCode: number | null | undefined): void => {
    scheduler?.handlePtyExit(participantId, exitCode ?? null)
  }

  // Spawn zones serially (same rationale as v4 — serialized capture avoids
  // concurrent polls converging on the earliest-written session file).
  for (const zone of selectedZones) {
    const ws = workspaceZones.find(w => w.zoneId === zone.id)
    if (!ws) continue
    const runtime = ws.runtime
    const adapter = getRuntimeAdapter(runtime)
    const promptPath = join(projectDir, 'ARCHITECT', 'prompts', `${ws.participantId}.md`)
    const systemPrompt = fs.readFileSync(promptPath, 'utf-8')
    // Deliver a minimal bootstrap user turn at spawn so the CLI materializes
    // a session file (required for capture + later resume). Without this the
    // zone sits at its prompt and the session poll times out.
    const composed = adapter.composeSystemAndUser(systemPrompt, ZONE_BOOTSTRAP_PROMPT)
    const env: Record<string, string> = {
      // Helper script + identity vars so agents can write activity-log lines
      // via "$ARCHITECT_RECORD <kind> <content> ..." instead of constructing
      // heredocs (which breaks under command-rewriters like rtk).
      ARCHITECT_RECORD: recordHelperPath(projectDir, dispatchId),
      ARCHITECT_PARTICIPANT_ID: ws.participantId,
      ARCHITECT_ACTIVITY_LOG: activityLogPath(projectDir, dispatchId, ws.participantId),
    }
    for (const { key, value } of zone.data.envVars ?? []) {
      if (key) env[key] = value
    }

    await serializeAgentSpawn(() => new Promise<void>(resolve => {
      let settled = false
      const done = (): void => { if (!settled) { settled = true; resolve() } }
      const timer = setTimeout(() => {
        console.warn(`[dispatch-v5] zone "${ws.label}" capture did not settle in ${CAPTURE_SERIAL_TIMEOUT_MS}ms`)
        done()
      }, CAPTURE_SERIAL_TIMEOUT_MS)

      const zoneInfo = spawnAgentSession({
        win,
        id: zone.id,
        label: ws.label,
        runtime,
        env,
        cwd: projectDir,
        initialPrompt: composed.firstUserPrompt,
        appendSystemPrompt: composed.appendSystemPromptFlag,
        model: ws.model,
        effort: settings.dispatchEffort,
        coordinatedMode: true,
        onExit: onZoneExit(ws.participantId),
        capture: {
          projectDir,
          zoneKey: zone.id,
          legacyKey: ws.participantId,
          summary: dispatchSummary,
          dispatchId: undefined,
        },
        onSessionCaptured: zoneSessionId => {
          const upsert = (): void => {
            if (!architectSessionId) return
            try {
              upsertDispatchZoneSession(projectDir, architectSessionId, {
                zoneId: zone.id,
                label: ws.label,
                runtime,
                sessionId: zoneSessionId,
              })
            } catch (err) {
              console.error('[dispatch-v5] failed to upsert zone session', err)
            }
            try {
              const rec = getZoneSessionRecord(projectDir, zone.id, zoneSessionId, ws.participantId)
              if (rec && !rec.dispatchId) {
                appendZoneSession(projectDir, zone.id, { ...rec, dispatchId: architectSessionId })
              }
            } catch {}
          }
          if (architectSessionId) upsert()
          else pendingZoneUpserts.push(upsert)
        },
        onCaptureSettled: () => {
          clearTimeout(timer)
          done()
        },
      })
      broadcast('terminal:spawned', zoneInfo)
    }))
  }

  // Spawn conductor with the initial-turn prompt baked in. Delivering
  // composeInitialTurn at spawn (not post-spawn via pty.write) materializes
  // a session file AND kicks off the conductor's first decision in one
  // shot — no race between seedInitialTurn and Claude's TUI being ready.
  const conductorPromptPath = join(projectDir, 'ARCHITECT', 'prompts', 'conductor.md')
  const conductorPrompt = fs.readFileSync(conductorPromptPath, 'utf-8')
  const conductorModel = dispatch.model || DEFAULT_MODEL_BY_RUNTIME[conductorRuntime] || ''
  const conductorAdapter = getRuntimeAdapter(conductorRuntime)
  const planMode = dispatch.planMode === true
  // Plan mode in Architect = "the conductor plans with the user in prose
  // before any zone gets a task." It is NOT the same as Claude's
  // --permission-mode plan (read-only). We deliberately do NOT pass
  // planMode=true to spawnAgentSession below — agents run with normal
  // permissions and the conductor's planning is enforced by its prompt.
  const conductorInitialTurn = planMode
    ? composePlanModeInitialTurn(userPrompt, conductorRuntime)
    : composeInitialTurn(userPrompt)
  const conductorComposed = conductorAdapter.composeSystemAndUser(
    conductorPrompt,
    conductorInitialTurn,
  )

  await serializeAgentSpawn(() => new Promise<void>(resolve => {
    let settled = false
    const done = (): void => { if (!settled) { settled = true; resolve() } }
    const timer = setTimeout(() => {
      console.warn(`[dispatch-v5] Conductor capture did not settle in ${CAPTURE_SERIAL_TIMEOUT_MS}ms`)
      done()
    }, CAPTURE_SERIAL_TIMEOUT_MS)

    const conductorInfo = spawnAgentSession({
      win,
      id: CONDUCTOR_PTY_ID,
      label: 'Conductor',
      runtime: conductorRuntime,
      env: {
        ARCHITECT_RECORD: recordHelperPath(projectDir, dispatchId),
        ARCHITECT_PARTICIPANT_ID: CONDUCTOR_PARTICIPANT_ID,
        ARCHITECT_ACTIVITY_LOG: activityLogPath(projectDir, dispatchId, CONDUCTOR_PARTICIPANT_ID),
      },
      cwd: projectDir,
      initialPrompt: conductorComposed.firstUserPrompt,
      appendSystemPrompt: conductorComposed.appendSystemPromptFlag,
      model: conductorModel,
      effort: settings.dispatchEffort,
      // Pass planMode through to the conductor's CLI so Claude Code's
      // status bar reflects "plan mode on". The conductor's prompt
      // additionally instructs it to wait for the user to type GO before
      // emitting any {type:"assign"} decisions.
      planMode,
      planModeBadge: planMode,
      coordinatedMode: true,
      capture: {
        projectDir,
        zoneKey: CONDUCTOR_PTY_ID,
        legacyKey: 'Conductor',
        summary: dispatchSummary,
      },
      onSessionCaptured: sessionId => {
        architectSessionId = sessionId
        const record: DispatchRecord = {
          architectSessionId: sessionId,
          architectRuntime: conductorRuntime,
          dispatchId,
          zoneIds: selectedZones.map(z => z.id),
          zoneLabels: selectedZones.map(z => wsByZoneId.get(z.id)?.label ?? z.data.label),
          zoneSessions: [],
          userPrompt,
          summary: dispatchSummary,
          model: conductorModel,
          planMode: dispatch.planMode === true,
          timestamp: new Date().toISOString(),
          protocolVersion: DISPATCH_PROTOCOL_VERSION,
          pendingTasks: [],
          conductorDecisions: [],
        }
        try { saveDispatch(projectDir, record) } catch (err) {
          console.error('[dispatch-v5] failed to save DispatchRecord', err)
        }
        for (const fn of pendingZoneUpserts.splice(0)) fn()
      },
      onCaptureSettled: () => {
        clearTimeout(timer)
        done()
      },
    })
    broadcast('terminal:spawned', conductorInfo)
  }))

  if (!architectSessionId) {
    // Conductor never captured an id — we still want a scheduler running so
    // resumes later have something to key on, but persistence calls that
    // depend on architectSessionId will no-op.
    console.warn('[dispatch-v5] conductor session id was not captured; persistence to DispatchRecord is disabled for this run')
  }

  const schedulerZones = buildSchedulerZones(workspaceZones, selectedZones)
  scheduler = new Scheduler(
    {
      projectDir,
      dispatchId,
      architectSessionId: architectSessionId ?? '',
      conductorZoneId: CONDUCTOR_PTY_ID,
      zones: schedulerZones,
      idleThresholdMs: settings.harnessTimeouts.idleThresholdMs,
      staleEscalationMs: settings.harnessTimeouts.staleEscalationMs,
      statusTickMs: STATUS_TICK_MS,
      userPrompt,
    },
    buildSchedulerDeps(projectDir, dispatchId, broadcast),
  )

  setActiveDispatchCoordinator({ stop: () => scheduler?.stop() })
  scheduler.start()
  // First conductor turn was delivered via argv at spawn (composeInitialTurn
  // folded into the --append-system-prompt call). No post-spawn pty.write
  // needed — the scheduler will pick up the conductor's first decision from
  // the activity-log watcher.

  return allInfo
}

export async function resumeDispatchV5(input: ResumeDispatchV5Input): Promise<ResumeDispatchV5Result> {
  const { win, projectDir, dispatchId, nodes, edges, rawSettings } = input
  killAll()
  const settings = normalizeProjectSettings(rawSettings)

  const record = getDispatch(projectDir, dispatchId)
  if (!record) return { ok: false, error: 'not-found' }
  if ((record.protocolVersion ?? 0) < DISPATCH_PROTOCOL_VERSION) {
    return { ok: false, error: 'legacy-protocol' }
  }

  const pinnedDispatchId = record.dispatchId ?? randomBytes(8).toString('hex')
  const { zones: allZones } = indexGraph(nodes)
  const zoneById = new Map(allZones.map(z => [z.id, z]))
  const dispatchZones = record.zoneIds
    .map(id => zoneById.get(id))
    .filter((z): z is ZoneGraphNode => !!z)
  if (dispatchZones.length === 0) {
    return { ok: false, error: 'not-found' }
  }

  const filteredNodes = nodes.filter(n => n.type !== 'zone' || zoneById.has(n.id))
  const zoneIdSet = new Set(dispatchZones.map(z => z.id))
  const filteredZones = dispatchZones

  const { input: workspaceInput, zones: workspaceZones } = buildWorkspaceInput(
    projectDir,
    pinnedDispatchId,
    filteredNodes.filter(n => n.type !== 'zone' || zoneIdSet.has(n.id)),
    edges,
    filteredZones,
    record.userPrompt,
    record.architectRuntime,
    rawSettings,
  )
  setupWorkspaceV5(workspaceInput)

  // Validate the conductor session up front. If it's pruned, abort before
  // spawning any worker PTYs — otherwise an aborted resume leaves zone
  // processes running with no scheduler attached.
  const conductorRuntime = record.architectRuntime
  const conductorAdapter = getRuntimeAdapter(conductorRuntime)
  if (!conductorAdapter.revalidateSession(projectDir, record.architectSessionId)) {
    console.warn(`[resume-v5] conductor session ${record.architectSessionId} not reachable; aborting resume`)
    return { ok: false, error: 'not-found' }
  }

  const info: TerminalInfo[] = [
    { id: CONDUCTOR_PTY_ID, label: 'Conductor', runtime: record.architectRuntime, coordinatedMode: true },
  ]

  let scheduler: Scheduler | null = null
  const onZoneExit = (participantId: string) => (exitCode: number | null | undefined): void => {
    scheduler?.handlePtyExit(participantId, exitCode ?? null)
  }

  // Track participants whose PTYs we couldn't revive. After the scheduler
  // is up we surface these to the conductor as exits so any pending tasks
  // targeting them fail visibly instead of dangling forever in writeToPty
  // no-op land.
  const skippedParticipantIds = new Set<string>()

  // Resume each zone with its pinned session id. Zones that can't be
  // revalidated on-disk are surfaced in TerminalInfo and recorded as
  // skipped — the scheduler will mark them exited once it starts.
  for (const zone of filteredZones) {
    const entry = record.zoneSessions.find(z => z.zoneId === zone.id)
    const ws = workspaceZones.find(w => w.zoneId === zone.id)
    const displayLabel = ws?.label ?? zone.data.label
    const runtime = entry?.runtime ?? (ws?.runtime ?? getZoneRuntime(zone, settings))
    const participantId = ws?.participantId ?? sanitize(zone.data.label)
    info.push({ id: zone.id, label: displayLabel, runtime, coordinatedMode: true })

    if (!entry) {
      console.warn(`[resume-v5] no session id stored for zone ${displayLabel}`)
      skippedParticipantIds.add(participantId)
      continue
    }
    const adapter = getRuntimeAdapter(runtime)
    if (!adapter.revalidateSession(projectDir, entry.sessionId)) {
      console.warn(`[resume-v5] zone ${displayLabel} session ${entry.sessionId} not reachable; skipping`)
      skippedParticipantIds.add(participantId)
      continue
    }

    const env: Record<string, string> = {
      ARCHITECT_RECORD: recordHelperPath(projectDir, pinnedDispatchId),
      ARCHITECT_PARTICIPANT_ID: participantId,
      ARCHITECT_ACTIVITY_LOG: activityLogPath(projectDir, pinnedDispatchId, participantId),
    }
    for (const { key, value } of zone.data.envVars ?? []) {
      if (key) env[key] = value
    }
    spawnAgentSession({
      win,
      id: zone.id,
      label: displayLabel,
      runtime,
      env,
      cwd: projectDir,
      model: ws?.model ?? getZoneModel(zone, runtime),
      resumeSessionId: entry.sessionId,
      effort: settings.dispatchEffort,
      coordinatedMode: true,
      onExit: onZoneExit(participantId),
    })
  }

  // Resume conductor. No initial prompt — it comes back idle and waits
  // for the scheduler's next pty.write (either a re-delivery or a fresh
  // user-turn prompted by the next material event).
  spawnAgentSession({
    win,
    id: CONDUCTOR_PTY_ID,
    label: 'Conductor',
    runtime: conductorRuntime,
    env: {
      ARCHITECT_RECORD: recordHelperPath(projectDir, pinnedDispatchId),
      ARCHITECT_PARTICIPANT_ID: CONDUCTOR_PARTICIPANT_ID,
      ARCHITECT_ACTIVITY_LOG: activityLogPath(projectDir, pinnedDispatchId, CONDUCTOR_PARTICIPANT_ID),
    },
    cwd: projectDir,
    model: record.model || DEFAULT_MODEL_BY_RUNTIME[conductorRuntime],
    resumeSessionId: record.architectSessionId,
    planMode: record.planMode === true,
    planModeBadge: record.planMode === true,
    coordinatedMode: true,
    effort: settings.dispatchEffort,
  })

  const schedulerZones = buildSchedulerZones(workspaceZones, filteredZones)
  scheduler = new Scheduler(
    {
      projectDir,
      dispatchId: pinnedDispatchId,
      architectSessionId: record.architectSessionId,
      conductorZoneId: CONDUCTOR_PTY_ID,
      zones: schedulerZones,
      idleThresholdMs: settings.harnessTimeouts.idleThresholdMs,
      staleEscalationMs: settings.harnessTimeouts.staleEscalationMs,
      statusTickMs: STATUS_TICK_MS,
      // Rehydrate the dependsOn dep gate from the prior run so a queued
      // task whose upstream had already completed releases on resume.
      initialCompletedZones: record.completedZones,
      initialPlanRevision: record.planRevision,
      userPrompt: record.userPrompt,
      initialPendingTasks: record.pendingTasks,
    },
    buildSchedulerDeps(projectDir, pinnedDispatchId, broadcast),
  )
  setActiveDispatchCoordinator({ stop: () => scheduler?.stop() })
  scheduler.start()

  // Re-deliver any in-flight tasks from the prior run. Completed tasks stay
  // completed (they're not in pendingTasks); zones that were idle come back
  // idle. Tasks targeting skipped participants are still registered so
  // handlePtyExit can fail them — without that, redispatch would write to
  // a missing PTY (no-op) and the conductor would never see a failure.
  for (const task of record.pendingTasks ?? []) {
    scheduler.redispatchTask(task as PendingTask)
  }

  // Surface skipped participants as exits so the conductor can recover.
  // This both fails any pending task we just registered for that zone and
  // emits a composePtyExitTurn so the conductor knows to reroute or finish.
  for (const participantId of skippedParticipantIds) {
    scheduler.handlePtyExit(participantId, null)
  }

  return { ok: true, info }
}
