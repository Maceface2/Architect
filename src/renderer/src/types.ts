import type { Node } from '@xyflow/react'
import type { AgentRuntime, AgentRuntimeMode, AssistantMode, EffortLevel } from '../../shared/agentRuntimes'
export type { AssistantMode, EffortLevel } from '../../shared/agentRuntimes'

export type ComponentCategory =
  | "infrastructure"
  | "services"
  | "storage"
  | "custom";
export type NodeStatus = "idle" | "running" | "done" | "error";
export type RunMode = "sequential" | "parallel" | "loop";
export type OnFailure = "stop" | "retry" | "skip";

export interface NodeSkillFile {
  id: string
  name: string
  path: string
  builtin: boolean
}

export interface NodeTools {
  webSearch: boolean;
  codeExec: boolean;
  fileRead: boolean;
  fileWrite: boolean;
  apiCalls: boolean;
  shell: boolean;
}

export interface NodeBehavior {
  mode: RunMode;
  retries: number;
  onFailure: OnFailure;
  timeoutMs: number;
}

export interface NodePermissions {
  readFiles: boolean;
  writeFiles: boolean;
  network: boolean;
  shell: boolean;
}

export interface NodeEnvVar {
  key: string;
  value: string;
}

export interface HarnessTimeouts {
  deliveryWarningMs: number
  idleThresholdMs: number
  taskTimeoutMs: number
}

// Settings that exclusively drive zone launches and multi-zone dispatches.
// The side-panel assistant MUST NOT read any of these — its config lives in
// `AssistantSettings` below and is fully decoupled, including type-level.
// If you need a new knob for zones/dispatch, add it here; for the assistant,
// add a matching `assistant*` field in AssistantSettings.
export interface DispatchSettings {
  // The CLI used by zones and multi-zone dispatches.
  dispatchRuntime: AgentRuntime
  // Per-CLI default model for zones/dispatch. Seeds new zones + pre-fills
  // the Dispatch model picker.
  dispatchModels: RuntimeModelMap
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
  // Coordinator timing for multi-zone dispatches (delivery warning, idle
  // threshold, task timeout). Applied per dispatch run.
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

// Full project settings persisted in architect-canvas.json. Composed of the
// two scope-specific slices above. Components that only need one side should
// accept `DispatchSettings` or `AssistantSettings` directly, not this union.
export interface ProjectSettings extends DispatchSettings, AssistantSettings {}

export type RuntimeModelMap = Partial<Record<AgentRuntime, string>>

// A zone is the agent. It owns a bounded canvas area and drives a single PTY.
export interface ZoneNodeData {
  label: string
  description: string
  color: string
  status: NodeStatus
  systemPrompt: string
  agentRuntimeMode: AgentRuntimeMode
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
}

export interface DispatchRecord {
  architectSessionId: string
  architectRuntime: AgentRuntime
  zoneIds: string[]
  zoneLabels: string[]
  zoneSessions: DispatchZoneSession[]
  userPrompt: string
  summary: string
  model: string
  planMode: boolean
  timestamp: string
}

export type DispatchRequest =
  | {
      mode: 'new'
      userPrompt: string
      model: string
      planMode: boolean
      onlyZoneIds: string[]
    }
  | {
      mode: 'resume'
      dispatchId: string
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
  [key: string]: unknown
}

export type ZoneNodeType = Node<ZoneNodeData, 'zone'>
export type ComponentNodeType = Node<ComponentNodeData, 'component'>
export type CanvasNode = ZoneNodeType | ComponentNodeType

export interface ArchitectCanvasData {
  nodes: CanvasNode[]
  edges: Array<{
    id: string;
    source: string;
    target: string;
  }>;
  settings: ProjectSettings;
  savedAt?: string;
}
