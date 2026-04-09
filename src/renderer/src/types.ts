import type { Node } from '@xyflow/react'
import type { AgentRuntime, AgentRuntimeMode } from '../../../shared/agentRuntimes'

export type ComponentCategory = 'infrastructure' | 'services' | 'storage' | 'custom'
export type NodeStatus = 'idle' | 'running' | 'done' | 'error'
export type RunMode = 'sequential' | 'parallel' | 'loop'
export type OnFailure = 'stop' | 'retry' | 'skip'

// Skills = markdown files pre-injected as agent context for the selected coding CLI
export interface NodeSkillFile {
  id: string       // e.g. 'researcher'
  name: string     // display name
  path: string     // path to .md file, or built-in key
  builtin: boolean // true = from preset library
}

// Tools = concrete runtime capabilities the agent can invoke
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

export interface ArchitectNodeData {
  label: string
  description: string
  category: ComponentCategory
  iconName: string
  color: string
  tag: string
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

export type ArchitectNodeType = Node<ArchitectNodeData, 'architectNode'>

export interface ArchitectCanvasData {
  nodes: ArchitectNodeType[]
  edges: Array<{
    id: string
    source: string
    target: string
  }>
  settings: ProjectSettings
  savedAt?: string
}
