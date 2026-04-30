import fs from 'fs'
import { join, relative } from 'path'
import type { AgentRuntime } from '../../shared/agentRuntimes'
import { getAgentRuntime } from '../../shared/agentRuntimes'
import { DISPATCH_PROTOCOL_VERSION } from '../dispatchCapture'
import { activityDir, activityLogPath, ensureActivityLog } from './activity'
import { ensureOrchestrationLog, orchestrationLogPath } from './orchestrationLog'
import { ensureRecordHelper } from './recordHelper'
import { initialState, stateDir, stateFilePath, writeState } from './state'
import { buildConductorPrompt, type ConductorZoneContext } from './prompts/conductor'
import { buildZonePrompt, type ZoneComponentSpec } from './prompts/zone'
import type { ComponentEdgeSpec } from './prompts/componentEdges'

// v5 workspace setup. Writes everything the dispatch needs on disk before
// any PTY is spawned: manifest, conductor + zone prompts, per-participant
// state skeletons, and empty activity-log files so watchers can attach.
//
// Also cleans up v4 artifacts (ARCHITECT/mailbox/ and ARCHITECT/scripts/)
// on first entry so a project that was previously dispatched under v4
// doesn't carry around stale shell scripts or inbox directories.

export interface WorkspaceZoneInput {
  zoneId: string
  participantId: string
  label: string
  description?: string
  runtime: AgentRuntime
  model: string
  components: ZoneComponentSpec[]
  componentEdges: ComponentEdgeSpec[]
  enabledTools: string[]
  systemPromptOverride: string
  skills: Array<{ name: string; content: string }>
}

export interface WorkspaceInput {
  projectDir: string
  dispatchId: string
  dispatchRuntime: AgentRuntime
  userPrompt?: string
  zones: WorkspaceZoneInput[]
  componentEdges: ComponentEdgeSpec[]
  unassignedComponents: Array<{
    id: string
    label: string
    tag?: string
    category?: string
    description?: string
    specs?: string
  }>
}

export interface WorkspaceOutput {
  conductorPrompt: string
  zonePrompts: Map<string, string>  // zoneId → prompt contents
}

function wipeLegacyArtifacts(projectDir: string): void {
  const legacy = [
    join(projectDir, 'ARCHITECT', 'mailbox'),
    join(projectDir, 'ARCHITECT', 'scripts'),
  ]
  for (const path of legacy) {
    try {
      fs.rmSync(path, { recursive: true, force: true })
    } catch {}
  }
}

function wipeDispatchRuntime(projectDir: string, dispatchId: string): void {
  const path = join(projectDir, 'ARCHITECT', 'runtime', dispatchId)
  try {
    fs.rmSync(path, { recursive: true, force: true })
  } catch {}
}

function ensureDispatchDirs(projectDir: string, dispatchId: string): void {
  const base = join(projectDir, 'ARCHITECT')
  for (const dir of ['outputs', 'prompts', 'sessions', 'dispatches'].map(name => join(base, name))) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.mkdirSync(activityDir(projectDir, dispatchId), { recursive: true })
  fs.mkdirSync(stateDir(projectDir, dispatchId), { recursive: true })
  fs.mkdirSync(join(base, 'runtime', dispatchId, 'tasks'), { recursive: true })
  ensureOrchestrationLog(orchestrationLogPath(projectDir, dispatchId))
  // Per-dispatch helper script that handles activity-log JSON encoding via
  // python3/jq, so agents in command-rewriter environments (rtk, ssh, etc.)
  // don't have to construct heredocs themselves.
  ensureRecordHelper(projectDir, dispatchId)
}

function writeManifest(input: WorkspaceInput): void {
  const { projectDir, dispatchId, dispatchRuntime, zones } = input
  const manifestPath = join(projectDir, 'ARCHITECT', 'manifest.json')
  const manifest = {
    generated: new Date().toISOString(),
    protocolVersion: DISPATCH_PROTOCOL_VERSION,
    dispatchId,
    dispatchRuntime,
    activityDir: relative(projectDir, activityDir(projectDir, dispatchId)),
    stateDir: relative(projectDir, stateDir(projectDir, dispatchId)),
    unassignedComponents: input.unassignedComponents.map(c => ({
      id: c.id,
      label: c.label,
      category: c.category ?? null,
      tag: c.tag ?? null,
      description: c.description ?? '',
      specs: c.specs ?? '',
    })),
    componentEdges: input.componentEdges,
    zones: zones.map(zone => ({
      id: zone.zoneId,
      label: zone.label,
      participantId: zone.participantId,
      description: zone.description ?? '',
      runtime: zone.runtime,
      runtimeLabel: getAgentRuntime(zone.runtime).label,
      model: zone.model,
      systemPrompt: zone.systemPromptOverride || null,
      activityLog: relative(projectDir, activityLogPath(projectDir, dispatchId, zone.participantId)),
      stateFile: relative(projectDir, stateFilePath(projectDir, dispatchId, zone.participantId)),
      outputFile: `ARCHITECT/outputs/${zone.participantId}.md`,
      enabledTools: zone.enabledTools,
      componentEdges: zone.componentEdges,
      components: zone.components.map(c => ({
        id: c.id,
        label: c.label,
        category: c.category ?? null,
        tag: c.tag ?? null,
        description: c.description ?? '',
        specs: c.specs ?? '',
      })),
    })),
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

function writePrompts(input: WorkspaceInput): WorkspaceOutput {
  const { projectDir, dispatchId, userPrompt, zones, componentEdges, unassignedComponents } = input
  const promptsDir = join(projectDir, 'ARCHITECT', 'prompts')

  const conductorContext: ConductorZoneContext[] = zones.map(zone => ({
    zoneId: zone.zoneId,
    participantId: zone.participantId,
    label: zone.label,
    description: zone.description,
    runtime: zone.runtime,
    model: zone.model,
    componentLabels: zone.components.map(c => c.label),
  }))

  const conductorPrompt = buildConductorPrompt({
    projectDir,
    dispatchId,
    userPrompt,
    zones: conductorContext,
    componentEdges,
    unassignedComponents: unassignedComponents.map(c => ({
      label: c.label,
      tag: c.tag,
      description: c.description,
    })),
  })
  fs.writeFileSync(join(promptsDir, 'conductor.md'), conductorPrompt)

  const zonePrompts = new Map<string, string>()
  for (const zone of zones) {
    const prompt = buildZonePrompt({
      projectDir,
      dispatchId,
      participantId: zone.participantId,
      label: zone.label,
      description: zone.description,
      components: zone.components,
      componentEdges: zone.componentEdges,
      toolNames: zone.enabledTools,
      skills: zone.skills,
      userSystemPrompt: zone.systemPromptOverride,
    })
    fs.writeFileSync(join(promptsDir, `${zone.participantId}.md`), prompt)
    zonePrompts.set(zone.zoneId, prompt)
  }

  return { conductorPrompt, zonePrompts }
}

function writeStateSkeletons(input: WorkspaceInput): void {
  const { projectDir, dispatchId, dispatchRuntime, zones } = input

  writeState(
    stateFilePath(projectDir, dispatchId, 'conductor'),
    initialState('conductor', 'Conductor', dispatchRuntime),
  )

  for (const zone of zones) {
    writeState(
      stateFilePath(projectDir, dispatchId, zone.participantId),
      initialState('zone', zone.label, zone.runtime),
    )
  }
}

function touchActivityLogs(input: WorkspaceInput): void {
  const { projectDir, dispatchId, zones } = input
  ensureActivityLog(activityLogPath(projectDir, dispatchId, 'conductor'))
  for (const zone of zones) {
    ensureActivityLog(activityLogPath(projectDir, dispatchId, zone.participantId))
  }
}

// Main entry point. Idempotent for the same dispatchId: rewrites everything.
// Callers pass a freshly-minted dispatchId on startDispatch and reuse the
// persisted dispatchId on resumeDispatch (after wipeDispatchRuntime).
export function setupWorkspaceV5(input: WorkspaceInput): WorkspaceOutput {
  wipeLegacyArtifacts(input.projectDir)
  wipeDispatchRuntime(input.projectDir, input.dispatchId)
  ensureDispatchDirs(input.projectDir, input.dispatchId)
  writeManifest(input)
  const output = writePrompts(input)
  writeStateSkeletons(input)
  touchActivityLogs(input)
  return output
}
