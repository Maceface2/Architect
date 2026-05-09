import type { Edge, Node } from '@xyflow/react'
import type { AgentRuntime, AssistantMode, EffortLevel } from '../../shared/agentRuntimes'
export type { AssistantMode, EffortLevel } from '../../shared/agentRuntimes'

export type ComponentCategory = 'infrastructure' | 'services' | 'storage' | 'custom'
export type NodeStatus = 'idle' | 'running' | 'done' | 'error'
export type RunMode = 'sequential' | 'parallel' | 'loop'
export type OnFailure = 'stop' | 'retry' | 'skip'
export type ComponentEdgeDirection = 'source-to-target' | 'bidirectional' | 'none'

export interface ComponentEdgeData extends Record<string, unknown> {
  label?: string
  direction?: ComponentEdgeDirection
  // Cross-folder edge metadata. When source and target nodes live in
  // different workspace folders, the edge is owned by the source folder's
  // canvas file and carries the target's absolute folder path so the merge
  // loader can resolve the target node id in the other folder's id space.
  // Persisted on disk under the source folder's edges[i].data.targetFolder.
  targetFolder?: string
  // Render hint set at load time when an edge's targetFolder is not
  // currently loaded into the workspace. Consumers style these muted/
  // dashed; never persisted (splitMergedForSave strips it on write).
  dangling?: boolean
}

export interface NodeSkillFile {
  id: string
  name: string
  path: string
  builtin: boolean
}

export interface NodeTools {
  webSearch: boolean
  codeExec: boolean
  fileRead: boolean
  fileWrite: boolean
  apiCalls: boolean
  shell: boolean
}

export interface NodeBehavior {
  mode: RunMode
  retries: number
  onFailure: OnFailure
  timeoutMs: number
}

export interface NodePermissions {
  readFiles: boolean
  writeFiles: boolean
  network: boolean
  shell: boolean
}

export interface NodeEnvVar {
  key: string
  value: string
}

export interface HarnessTimeouts {
  // When both the PTY and the activity log go quiet past this threshold,
  // the scheduler flips the participant to 'stale'.
  idleThresholdMs: number
  // How long a stale streak must persist before the scheduler invokes the
  // conductor for recovery.
  staleEscalationMs: number
}

// Settings that exclusively drive zone launches and multi-zone dispatches.
// The side-panel assistant MUST NOT read any of these — its config lives in
// `AssistantSettings` below and is fully decoupled, including type-level.
// If you need a new knob for zones/dispatch, add it here; for the assistant,
// add a matching `assistant*` field in AssistantSettings.
export interface DispatchSettings {
  // Canvas-default CLI for zones. Picking this in the Settings page bulk-
  // applies it to every zone on the canvas; zones can still override via
  // AgentConfigModal. Also seeds newly dragged zones.
  dispatchRuntime: AgentRuntime
  // Last-used Orchestrator CLI for multi-zone dispatch. Chosen per dispatch
  // in the DispatchModal dropdown; persisted here so the next dispatch pre-
  // selects it. Absence falls back to `dispatchRuntime`.
  conductorRuntime?: AgentRuntime
  // Per-CLI default model for zones/dispatch. Seeds new zones + pre-fills
  // the Dispatch model picker.
  dispatchModels: RuntimeModelMap
  // Per-CLI shortlist of models surfaced as quick-pick chips in zone
  // configs (AgentConfigModal, palette zone-create dialog). Capped at 5
  // per runtime — primarily there to tame opencode's 80+ model list. When
  // empty for a runtime, the zone falls back to the first 5 of its
  // detected/probed model list.
  pinnedModels?: Partial<Record<AgentRuntime, string[]>>
  // Reasoning-effort level applied at zone/dispatch spawn time.
  dispatchEffort: EffortLevel
  // Default plan-mode checkbox state in the Dispatch modal (Claude-only).
  dispatchPlanMode: boolean
  // Tool allowlist copied into new zones at creation time. Each zone owns
  // its own tool config after creation — editing this only affects zones
  // dragged onto the canvas AFTER the change.
  dispatchTools: NodeTools
  // Zone-timeout seed (ms) copied into new zones at creation time.
  dispatchTimeoutMs: number
  // Scheduler timing knobs for multi-zone dispatches. Applied per dispatch run.
  harnessTimeouts: HarnessTimeouts
}

// Settings that exclusively drive the side-panel Architecture / General
// assistant. Decoupled from `DispatchSettings` — Settings-page changes to
// dispatch/zone config never reach the assistant.
export interface AssistantSettings {
  assistantMode: AssistantMode
  // Last model the user picked for the assistant, keyed by runtime.
  // Seeds the AssistantLaunchModal; falls back to the runtime's baked-in
  // default (NOT to dispatchModels).
  assistantModels?: RuntimeModelMap
  // Per-assistant-mode CLI override. When a mode has no entry we fall back
  // to DEFAULT_AGENT_RUNTIME — NEVER to dispatchRuntime.
  assistantRuntimeByMode?: Partial<Record<AssistantMode, AgentRuntime>>
  // Last (runtime, sessionId, model) the user was actually working with per
  // mode. Authoritative for startup resume — beats latestReachableSession,
  // which only sees fresh-capture records and misses explicit resume picks.
  // `model` is captured so the resume replays the exact config even when the
  // user has since picked a different model in the launcher.
  assistantLastSessionByMode?: Partial<Record<AssistantMode, { runtime: AgentRuntime; sessionId: string; model?: string }>>
}

// Pure UI preferences. Distinct from Dispatch / Assistant settings: nothing
// here changes agent behavior — they only drive the renderer's chrome and
// how nodes paint on the canvas.
export type ZoneTreatment = 'default' | 'architectural' | 'terminal'
export type InterfaceTheme = 'dark' | 'light'
export type CanvasBackground = 'dots' | 'grid'
export type ComponentDensity = 'detailed' | 'simplified'

export interface InterfaceSettings {
  zoneTreatment: ZoneTreatment
  theme: InterfaceTheme
  canvasBackground: CanvasBackground
  componentDensity: ComponentDensity
}

// Full project settings persisted in architect-canvas.json. Composed of the
// scope-specific slices above. Components that only need one side should
// accept `DispatchSettings` / `AssistantSettings` / `InterfaceSettings`
// directly, not this union.
export interface ProjectSettings extends DispatchSettings, AssistantSettings {
  interface: InterfaceSettings
}

export type RuntimeModelMap = Partial<Record<AgentRuntime, string>>

// A zone is the agent. It owns a bounded canvas area and drives a single PTY.
export interface ZoneNodeData {
  // Immutable identifier used by the orchestrator for activity-log filenames,
  // state-file keys, prompt filenames, and in conductor/zone decision JSON.
  // Minted from the initial label at zone creation, made unique across the
  // canvas, and never changes afterwards — renames update `label` only so
  // on-disk artifacts and live dispatch coordination stay addressable.
  participantId: string
  label: string
  description: string
  color: string
  status: NodeStatus
  systemPrompt: string
  // Effective CLI this zone runs under. Seeded from settings.dispatchRuntime
  // at zone creation; user overrides via AgentConfigModal write here directly.
  // Legacy canvases also carried `agentRuntimeMode: 'inherit' | 'override'` —
  // that field is no longer read; the flat `agentRuntime` is the single
  // source of truth. (normalizeZoneData strips the legacy field on load.)
  agentRuntime: AgentRuntime
  providerModels: RuntimeModelMap
  openSections: string[]
  skills: NodeSkillFile[]
  tools: NodeTools
  behavior: NodeBehavior
  permissions: NodePermissions
  envVars: NodeEnvVar[]
  [key: string]: unknown
}

export interface ZoneSessionRecord {
  runtime: AgentRuntime
  sessionId: string
  capturedAt: string
  summary: string
  // Model the session was originally spawned with. Replayed verbatim on
  // resume so the config stays consistent even if the user has since picked
  // a different default.
  model?: string
  dispatchId?: string
}

export interface DispatchZoneSession {
  zoneId: string
  label: string
  runtime: AgentRuntime
  sessionId: string
  // Multi-folder dispatch: workspace folder this zone ran in. Used on
  // resume to auto-load the folder if it's been removed from the workspace
  // since dispatch time. Optional for back-compat with older v5 records.
  folderPath?: string
}

export interface DispatchRecord {
  architectSessionId: string
  architectRuntime: AgentRuntime
  dispatchId?: string
  zoneIds: string[]
  zoneLabels: string[]
  zoneSessions: DispatchZoneSession[]
  userPrompt: string
  summary: string
  model: string
  planMode: boolean
  timestamp: string
  protocolVersion?: number
  planRevision?: number
  planPath?: string
  workboardPath?: string
  planUpdatedAt?: string
  // Workspace anchor at dispatch time. Equal to the renderer's primary
  // folder for current dispatches; resumed records pin it so the runtime
  // tree is rebuilt at the same anchor regardless of where the workspace
  // is rooted later. Optional for back-compat with older v5 records.
  dispatchPrimaryFolder?: string
  // Distinct cwds across all zones at dispatch time. Resume uses this to
  // auto-load any folders that have been removed from the workspace since.
  involvedFolders?: string[]
}

export type DispatchRequest =
  | {
      mode: 'new'
      userPrompt: string
      model: string
      planMode: boolean
      onlyZoneIds: string[]
      conductorRuntime: AgentRuntime
    }
  | {
      mode: 'resume'
      dispatchId: string
    }

// A structured spec/note on a component. Renders as a `key · value` row on
// the canvas card; value drives a color via fieldTypeColor when it matches
// a known schema type (uuid, string, int…), otherwise neutral. Open-ended
// by design: any key, any value. id is a stable key for React keying.
export interface ComponentField {
  id: string
  key: string
  value: string
}

// A component is a design artifact. It carries the core context (description, specs)
// for one part of the system; zones overlay components to add agent behavior.
export interface ComponentNodeData {
  label: string
  description: string  // short tagline
  specs: string        // long-form description, API contracts, notes, requirements
  category: ComponentCategory
  iconName: string
  color: string
  tag: string
  fields?: ComponentField[]  // typed key/value rows shown on the card
  [key: string]: unknown
}

export type ZoneNodeType = Node<ZoneNodeData, 'zone'>
export type ComponentNodeType = Node<ComponentNodeData, 'component'>
export type CanvasNode = ZoneNodeType | ComponentNodeType
export type CanvasEdge = Edge<ComponentEdgeData, 'component-edge'>

export interface ArchitectCanvasData {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  settings: ProjectSettings
  savedAt?: string
}
