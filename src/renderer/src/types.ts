import type { Node } from '@xyflow/react'
import type { AgentRuntime, AgentRuntimeMode } from '../../shared/agentRuntimes'

export type ComponentCategory = 'infrastructure' | 'services' | 'storage' | 'custom'
export type NodeStatus = 'idle' | 'running' | 'done' | 'error'
export type RunMode = 'sequential' | 'parallel' | 'loop'
export type OnFailure = 'stop' | 'retry' | 'skip'

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

export interface ProjectSettings {
  defaultRuntime: AgentRuntime
}

export type RuntimeModelMap = Partial<Record<AgentRuntime, string>>

// A zone is the agent. It owns a bounded canvas area and drives a single PTY.
export interface ZoneNodeData {
  label: string
  description: string
  color: string
  status: NodeStatus
  prompt: string
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
    id: string
    source: string
    target: string
  }>
  settings: ProjectSettings
  savedAt?: string
}
