import fs from 'fs'
import { join } from 'path'
import type { AgentRuntime } from '../../shared/agentRuntimes'
import {
  buildCanvasProjection,
  type CanvasProjection,
  type ProjectionEdgeLike,
  type ProjectionNodeLike,
  type ProjectionZoneNodeLike,
} from '../../shared/canvas/projection'
import { renderProjectionJson } from '../../shared/canvas/render'
import { activityDir, activityLogPath, ensureActivityLog } from './activity'
import { ensureOrchestrationLog, orchestrationLogPath } from './orchestrationLog'
import { ensureRecordHelper } from './recordHelper'
import { initialState, stateDir, stateFilePath, writeState } from './state'
import { buildConductorPrompt } from './prompts/conductor'
import { buildZonePrompt } from './prompts/zone'

// v5 workspace setup. Writes everything the dispatch needs on disk before
// any PTY is spawned:
//   - ARCHITECT/manifest.json — slim canvas projection (zones, components
//     with full specs, unassigned components, edges) — pretty-printed JSON
//     that mirrors the same projection embedded in every prompt.
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
  // Raw canvas inputs — workspace builds the canonical CanvasProjection
  // internally so manifest.json and every prompt embed share one source of
  // truth.
  nodes: ProjectionNodeLike[]
  edges: ProjectionEdgeLike[]
  // Per-zone wiring (dispatch-time choices). Limited to the zones included
  // in this dispatch (after onlyZoneIds filtering).
  zones: WorkspaceZoneInput[]
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

// Build the shared CanvasProjection used for both the manifest and every
// prompt embed. The runtimeFor callback maps each included zone's React Flow
// node id to the dispatch-time runtime resolved by the caller.
function buildProjectionForDispatch(input: WorkspaceInput): CanvasProjection {
  const includeZoneIds = new Set(input.zones.map(z => z.zoneId))
  const runtimeByZoneId = new Map(input.zones.map(z => [z.zoneId, z.runtime]))
  return buildCanvasProjection(input.nodes, input.edges, {
    includeZoneIds,
    runtimeFor: (zoneNode: ProjectionZoneNodeLike) => runtimeByZoneId.get(zoneNode.id),
  })
}

function writeManifest(projectDir: string, projection: CanvasProjection): void {
  const manifestPath = join(projectDir, 'ARCHITECT', 'manifest.json')
  fs.writeFileSync(manifestPath, renderProjectionJson(projection))
}

function writePrompts(input: WorkspaceInput, projection: CanvasProjection): WorkspaceOutput {
  const { projectDir, dispatchId, userPrompt, zones } = input
  const promptsDir = join(projectDir, 'ARCHITECT', 'prompts')

  // Multi-folder dispatch: surface per-zone cwds to the conductor. Built
  // from WorkspaceZoneInput (dispatch state), kept off the shared canvas
  // projection so folderPath doesn't leak into the on-disk manifest schema.
  const zoneFolderPaths = new Map<string, string>()
  for (const zone of zones) {
    if (zone.folderPath) zoneFolderPaths.set(zone.participantId, zone.folderPath)
  }

  const conductorPrompt = buildConductorPrompt({
    projectDir,
    dispatchId,
    userPrompt,
    projection,
    zoneFolderPaths: zoneFolderPaths.size > 0 ? zoneFolderPaths : undefined,
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
      projection,
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
  const projection = buildProjectionForDispatch(input)
  writeManifest(input.projectDir, projection)
  const output = writePrompts(input, projection)
  writeStateSkeletons(input)
  touchActivityLogs(input)
  return output
}
