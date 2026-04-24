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
  topoSort,
  writeToTerminal,
  killAll,
  type GraphEdge,
  type GraphNode,
  type TerminalInfo,
  type ZoneGraphNode,
  type ComponentGraphNode,
} from '../terminals'
import { runZone } from '../terminals'
import { CONDUCTOR_PARTICIPANT_ID, Scheduler, type SchedulerZone } from './scheduler'
import { composeInitialTurn } from './conductor'
import { setupWorkspaceV5, type WorkspaceInput, type WorkspaceZoneInput } from './workspace'
import type { ZoneComponentSpec, ZoneUpstreamRef } from './prompts/zone'

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
  }
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] }
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

function buildWorkspaceZoneInput(
  zone: ZoneGraphNode,
  componentsByZone: Map<string, ComponentGraphNode[]>,
  allZones: ZoneGraphNode[],
  zoneEdges: GraphEdge[],
  runtime: AgentRuntime,
  model: string,
): WorkspaceZoneInput {
  const participantId = sanitize(zone.data.label)
  const components: ZoneComponentSpec[] = (componentsByZone.get(zone.id) ?? []).map(c => ({
    label: c.data.label,
    tag: c.data.tag,
    category: c.data.category,
    description: c.data.description,
    specs: c.data.specs,
  }))
  const upstream: ZoneUpstreamRef[] = zoneEdges
    .filter(e => e.target === zone.id)
    .map(e => allZones.find(z => z.id === e.source))
    .filter((z): z is ZoneGraphNode => !!z)
    .map(z => ({ label: z.data.label, participantId: sanitize(z.data.label) }))
  const downstreamLabels = zoneEdges
    .filter(e => e.source === zone.id)
    .map(e => allZones.find(z => z.id === e.target)?.data.label)
    .filter((label): label is string => !!label)
  const enabledTools = Object.entries(zone.data.tools ?? {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
  const skills = (zone.data.skills ?? [])
    .map(skill => ({ name: skill.name, content: readSkillContent(skill.path) }))
    .filter(s => !!s.content)

  return {
    zoneId: zone.id,
    participantId,
    label: zone.data.label,
    description: zone.data.description,
    runtime,
    model,
    components,
    upstream,
    downstreamLabels,
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
  const { zones: allZones, componentsByZone, unassignedComponents } = indexGraph(nodes)
  const zoneIdSet = new Set(filteredZones.map(z => z.id))
  const zoneEdges = edges.filter(e => zoneIdSet.has(e.source) && zoneIdSet.has(e.target))

  const zones: WorkspaceZoneInput[] = filteredZones.map(zone => {
    const runtime = getZoneRuntime(zone, normalizeProjectSettings(rawSettings))
    const model = getZoneModel(zone, runtime)
    return buildWorkspaceZoneInput(zone, componentsByZone, allZones, zoneEdges, runtime, model)
  })

  const labelByZoneId = new Map(filteredZones.map(z => [z.id, z.data.label]))
  const zoneEdgePairs = zoneEdges.map(e => ({
    fromLabel: labelByZoneId.get(e.source) ?? e.source,
    toLabel: labelByZoneId.get(e.target) ?? e.target,
  }))

  return {
    input: {
      projectDir,
      dispatchId,
      dispatchRuntime,
      userPrompt,
      zones,
      zoneEdges: zoneEdgePairs,
      unassignedComponents: unassignedComponents.map(c => ({
        id: c.id,
        label: c.data.label,
        tag: c.data.tag,
        category: c.data.category,
        description: c.data.description,
        specs: c.data.specs,
      })),
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
      label: zone.data.label,
      runtime: ws?.runtime ?? 'claude',
      retriesAllowed: Math.max(0, retries),
    }
  })
}

function wireScheduler(
  scheduler: Scheduler,
  architectSessionId: string,
  projectDir: string,
): void {
  // Nothing needs wiring at construction time — deps are passed in at
  // construction. This helper is a placeholder for future observability
  // hooks (e.g. telemetry) the scheduler should emit to.
  void scheduler
  void architectSessionId
  void projectDir
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
  const zoneEdges = edges.filter(e => selectedIdSet.has(e.source) && selectedIdSet.has(e.target))
  const sorted = topoSort(selectedZones, zoneEdges)

  // Single-zone dispatch: no conductor needed. runZone handles the solo
  // prompt + direct user-driven interaction path.
  if (sorted.length === 1) {
    const zone = sorted[0]
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
  const { input: workspaceInput, zones: workspaceZones } = buildWorkspaceInput(
    projectDir,
    dispatchId,
    filteredNodes,
    edges,
    sorted,
    userPrompt,
    settings.dispatchRuntime,
    rawSettings,
  )
  setupWorkspaceV5(workspaceInput)

  // Broadcast the initial TerminalInfo set so the renderer can begin rendering
  // tabs incrementally as each PTY spawns.
  const allInfo: TerminalInfo[] = [
    { id: CONDUCTOR_PTY_ID, label: 'Conductor', runtime: settings.dispatchRuntime },
    ...sorted.map(zone => ({
      id: zone.id,
      label: zone.data.label,
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
  for (const zone of sorted) {
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
    const env: Record<string, string> = {}
    for (const { key, value } of zone.data.envVars ?? []) {
      if (key) env[key] = value
    }

    await serializeAgentSpawn(() => new Promise<void>(resolve => {
      let settled = false
      const done = (): void => { if (!settled) { settled = true; resolve() } }
      const timer = setTimeout(() => {
        console.warn(`[dispatch-v5] zone "${zone.data.label}" capture did not settle in ${CAPTURE_SERIAL_TIMEOUT_MS}ms`)
        done()
      }, CAPTURE_SERIAL_TIMEOUT_MS)

      const zoneInfo = spawnAgentSession({
        win,
        id: zone.id,
        label: zone.data.label,
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
                label: zone.data.label,
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
  const conductorRuntime = settings.dispatchRuntime
  const conductorModel = dispatch.model || DEFAULT_MODEL_BY_RUNTIME[conductorRuntime]
  const conductorAdapter = getRuntimeAdapter(conductorRuntime)
  const conductorComposed = conductorAdapter.composeSystemAndUser(
    conductorPrompt,
    composeInitialTurn(userPrompt),
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
      env: {},
      cwd: projectDir,
      initialPrompt: conductorComposed.firstUserPrompt,
      appendSystemPrompt: conductorComposed.appendSystemPromptFlag,
      model: conductorModel,
      effort: settings.dispatchEffort,
      planMode: dispatch.planMode === true,
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
          zoneIds: sorted.map(z => z.id),
          zoneLabels: sorted.map(z => z.data.label),
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

  const schedulerZones = buildSchedulerZones(workspaceZones, sorted)
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
    },
    {
      writeToPty: (ptyId, text) => writeToTerminal(ptyId, text),
      broadcastActivity: event => broadcast('activity:event', event),
      broadcastState: event => broadcast('activity:state', event),
      onDispatchComplete: summary => broadcast('dispatch:complete', { dispatchId, summary }),
      onPendingTasksChanged: () => {
        // setDispatchPendingTasks is called inside the scheduler for
        // durable persistence; this callback is the IPC broadcast hook.
        // (No listeners today — renderer reads state via activity:state.)
      },
      getPtyLastActivityMs: (ptyId: string) => getSessionLastActivityMs(ptyId),
    },
  )

  wireScheduler(scheduler, architectSessionId ?? '', projectDir)
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

  const info: TerminalInfo[] = [
    { id: CONDUCTOR_PTY_ID, label: 'Conductor', runtime: record.architectRuntime },
  ]

  let scheduler: Scheduler | null = null
  const onZoneExit = (participantId: string) => (exitCode: number | null | undefined): void => {
    scheduler?.handlePtyExit(participantId, exitCode ?? null)
  }

  // Resume each zone with its pinned session id. Zones that can't be
  // revalidated on-disk are surfaced in TerminalInfo (runtime=shell? no —
  // keep runtime; scheduler sees them as exited immediately).
  for (const zone of filteredZones) {
    const entry = record.zoneSessions.find(z => z.zoneId === zone.id)
    const ws = workspaceZones.find(w => w.zoneId === zone.id)
    const runtime = entry?.runtime ?? (ws?.runtime ?? getZoneRuntime(zone, settings))
    info.push({ id: zone.id, label: zone.data.label, runtime, coordinatedMode: true })

    if (!entry) {
      console.warn(`[resume-v5] no session id stored for zone ${zone.data.label}`)
      continue
    }
    const adapter = getRuntimeAdapter(runtime)
    if (!adapter.revalidateSession(projectDir, entry.sessionId)) {
      console.warn(`[resume-v5] zone ${zone.data.label} session ${entry.sessionId} not reachable; skipping`)
      continue
    }

    const env: Record<string, string> = {}
    for (const { key, value } of zone.data.envVars ?? []) {
      if (key) env[key] = value
    }
    spawnAgentSession({
      win,
      id: zone.id,
      label: zone.data.label,
      runtime,
      env,
      cwd: projectDir,
      model: ws?.model ?? getZoneModel(zone, runtime),
      resumeSessionId: entry.sessionId,
      effort: settings.dispatchEffort,
      coordinatedMode: true,
      onExit: onZoneExit(ws?.participantId ?? sanitize(zone.data.label)),
    })
  }

  // Resume conductor. No initial prompt — it comes back idle and waits
  // for the scheduler's next pty.write (either a re-delivery or a fresh
  // user-turn prompted by the next material event).
  const conductorRuntime = record.architectRuntime
  const conductorAdapter = getRuntimeAdapter(conductorRuntime)
  if (!conductorAdapter.revalidateSession(projectDir, record.architectSessionId)) {
    console.warn(`[resume-v5] conductor session ${record.architectSessionId} not reachable; aborting resume`)
    return { ok: false, error: 'not-found' }
  }
  spawnAgentSession({
    win,
    id: CONDUCTOR_PTY_ID,
    label: 'Conductor',
    runtime: conductorRuntime,
    env: {},
    cwd: projectDir,
    model: record.model || DEFAULT_MODEL_BY_RUNTIME[conductorRuntime],
    resumeSessionId: record.architectSessionId,
    planMode: record.planMode === true,
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
    },
    {
      writeToPty: (ptyId, text) => writeToTerminal(ptyId, text),
      broadcastActivity: event => broadcast('activity:event', event),
      broadcastState: event => broadcast('activity:state', event),
      onDispatchComplete: summary => broadcast('dispatch:complete', { dispatchId: pinnedDispatchId, summary }),
      onPendingTasksChanged: () => {},
      getPtyLastActivityMs: (ptyId: string) => getSessionLastActivityMs(ptyId),
    },
  )
  setActiveDispatchCoordinator({ stop: () => scheduler?.stop() })
  scheduler.start()

  // Re-deliver any in-flight tasks from the prior run. Completed tasks stay
  // completed (they're not in pendingTasks); zones that were idle come back
  // idle.
  for (const task of record.pendingTasks ?? []) {
    scheduler.redispatchTask(task as PendingTask)
  }

  return { ok: true, info }
}
