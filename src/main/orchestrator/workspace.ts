import fs from 'fs'
import { join } from 'path'
import type { AgentRuntime } from '../../shared/agentRuntimes'
import { activityDir, activityLogPath, ensureActivityLog } from './activity'
import { ensureOrchestrationLog, orchestrationLogPath } from './orchestrationLog'
import { ensureRecordHelper } from './recordHelper'
import { initialState, stateDir, stateFilePath, writeState } from './state'
import { buildConductorPrompt, type ConductorZoneContext } from './prompts/conductor'
import { buildZonePrompt, type ZoneComponentSpec } from './prompts/zone'
import type { ComponentEdgeSpec } from './prompts/componentEdges'

// v5 workspace setup. Writes everything the dispatch needs on disk before
// any PTY is spawned:
//   - ARCHITECT/manifest.json — slim canvas projection (zones, components
//     with full specs, unassigned components, edges). Read on demand by
//     the conductor and zones for cross-zone context. No dispatch metadata,
//     no runtime/model wiring, no file paths, no zone systemPrompts.
//   - ARCHITECT/prompts/conductor.md + <participantId>.md — system prompts
//     consumed at PTY spawn.
//   - per-participant state skeletons + empty activity-log files so the
//     scheduler's watchers can attach safely.
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
  // Workspace folder this zone runs in. Multi-folder dispatches set this
  // per zone so each PTY spawns with its own folder as cwd; the conductor
  // continues to anchor at the dispatch-primary `projectDir`. Single-folder
  // dispatches leave it undefined and inherit `projectDir`.
  folderPath?: string
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
  ensureOrchestrationLog(orchestrationLogPath(projectDir, dispatchId))
  // Per-dispatch helper script that handles activity-log JSON encoding via
  // python3/jq, so agents in command-rewriter environments (rtk, ssh, etc.)
  // don't have to construct heredocs themselves.
  ensureRecordHelper(projectDir, dispatchId)
}

// Slim canvas projection. Read on demand by the conductor + zones for
// cross-zone context. Strips dispatch metadata, runtime/model wiring,
// file paths, agent-private fields (systemPrompt, enabledTools), and
// canvas-only visuals (positions, colors, ids). Same shape the conductor
// renders inline — having it on disk gives agents a redundancy path if
// the inline embed gets truncated and gives zones cross-zone awareness
// without bloating each zone prompt with the full canvas.
function writeManifest(input: WorkspaceInput): void {
  const { projectDir, zones } = input
  const manifestPath = join(projectDir, 'ARCHITECT', 'manifest.json')
  const manifest = {
    // Workspace anchor folder for the dispatch. The conductor reads this to
    // know its own cwd; zones use it to derive cross-folder file paths.
    primaryFolder: projectDir,
    zones: zones.map(zone => ({
      participantId: zone.participantId,
      label: zone.label,
      description: zone.description ?? '',
      // Where this zone's PTY runs. Equal to primaryFolder for single-folder
      // dispatches; differs for cross-folder dispatches so the conductor can
      // tell zones their cwds apart when reasoning about file paths.
      folderPath: zone.folderPath ?? projectDir,
      components: zone.components.map(c => ({
        label: c.label,
        tag: c.tag ?? '',
        description: c.description ?? '',
        specs: c.specs ?? '',
      })),
    })),
    unassignedComponents: input.unassignedComponents.map(c => ({
      label: c.label,
      tag: c.tag ?? '',
      description: c.description ?? '',
      specs: c.specs ?? '',
    })),
    componentEdges: input.componentEdges,
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
    folderPath: zone.folderPath,
    components: zone.components.map(c => ({
      label: c.label,
      tag: c.tag,
      description: c.description,
      specs: c.specs,
    })),
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
      specs: c.specs,
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
