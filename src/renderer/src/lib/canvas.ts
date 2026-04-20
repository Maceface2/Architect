import type { Edge } from '@xyflow/react'
import {
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_BY_RUNTIME,
  isAgentRuntime,
  isAgentRuntimeMode,
  type AgentRuntime,
} from '../../../shared/agentRuntimes'
import type {
  ArchitectCanvasData,
  CanvasNode,
  ComponentNodeData,
  ComponentNodeType,
  ProjectSettings,
  RuntimeModelMap,
  ZoneNodeData,
  ZoneNodeType,
} from '../types'

export function createDefaultProjectSettings(): ProjectSettings {
  return {
    defaultRuntime: DEFAULT_AGENT_RUNTIME,
  }
}

export function createDefaultZoneAgentConfig(defaultRuntime: AgentRuntime = DEFAULT_AGENT_RUNTIME) {
  return {
    agentRuntimeMode: 'inherit' as const,
    agentRuntime: defaultRuntime,
    providerModels: { [defaultRuntime]: DEFAULT_MODEL_BY_RUNTIME[defaultRuntime] } as RuntimeModelMap,
    openSections: [],
    skills: [],
    tools: { webSearch: false, codeExec: false, fileRead: false, fileWrite: false, apiCalls: false, shell: false },
    behavior: { mode: 'sequential' as const, retries: 0, onFailure: 'stop' as const, timeoutMs: 30000 },
    permissions: { readFiles: false, writeFiles: false, network: false, shell: false },
    envVars: [],
  }
}

export function createDefaultZoneData(defaultRuntime: AgentRuntime = DEFAULT_AGENT_RUNTIME): ZoneNodeData {
  return {
    label: 'Zone',
    description: '',
    color: '#58A6FF',
    status: 'idle',
    systemPrompt: '',
    ...createDefaultZoneAgentConfig(defaultRuntime),
  }
}

export function getEffectiveRuntime(
  data: Pick<ZoneNodeData, 'agentRuntimeMode' | 'agentRuntime'>,
  settings: ProjectSettings
): AgentRuntime {
  return data.agentRuntimeMode === 'override' ? data.agentRuntime : settings.defaultRuntime
}

export function getEffectiveModel(
  data: Pick<ZoneNodeData, 'providerModels' | 'agentRuntimeMode' | 'agentRuntime'>,
  settings: ProjectSettings
): string {
  const runtime = getEffectiveRuntime(data, settings)
  return data.providerModels?.[runtime] ?? DEFAULT_MODEL_BY_RUNTIME[runtime]
}

function normalizeProviderModels(
  rawData: Record<string, unknown>,
  defaultRuntime: AgentRuntime
): RuntimeModelMap {
  const rawProviderModels = rawData.providerModels
  const providerModels: RuntimeModelMap = {}

  if (rawProviderModels && typeof rawProviderModels === 'object') {
    for (const [runtime, value] of Object.entries(rawProviderModels)) {
      if (isAgentRuntime(runtime) && typeof value === 'string' && value.trim()) {
        providerModels[runtime] = value
      }
    }
  }

  if (typeof rawData.model === 'string' && !providerModels.claude) {
    providerModels.claude = rawData.model
  }

  if (!providerModels[defaultRuntime]) {
    providerModels[defaultRuntime] = DEFAULT_MODEL_BY_RUNTIME[defaultRuntime]
  }

  return providerModels
}

export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  const rawSettings = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const defaultRuntime = isAgentRuntime(rawSettings.defaultRuntime)
    ? rawSettings.defaultRuntime
    : DEFAULT_AGENT_RUNTIME

  return { defaultRuntime }
}

function normalizeZoneData(raw: Record<string, unknown>, settings: ProjectSettings): ZoneNodeData {
  const defaults = createDefaultZoneAgentConfig(settings.defaultRuntime)
  const agentRuntime = isAgentRuntime(raw.agentRuntime) ? raw.agentRuntime : DEFAULT_AGENT_RUNTIME

  // Legacy migration: pre-refactor zones stored their behavior customization under `prompt`.
  // The field has been renamed to `systemPrompt`; fall back to the old key when present.
  const systemPrompt = typeof raw.systemPrompt === 'string'
    ? raw.systemPrompt
    : typeof raw.prompt === 'string'
      ? raw.prompt
      : ''

  return {
    label: typeof raw.label === 'string' ? raw.label : 'Zone',
    description: typeof raw.description === 'string' ? raw.description : '',
    color: typeof raw.color === 'string' ? raw.color : '#58A6FF',
    status: (raw.status as ZoneNodeData['status']) ?? 'idle',
    systemPrompt,
    agentRuntimeMode: isAgentRuntimeMode(raw.agentRuntimeMode) ? raw.agentRuntimeMode : defaults.agentRuntimeMode,
    agentRuntime,
    providerModels: normalizeProviderModels(raw, settings.defaultRuntime),
    openSections: Array.isArray(raw.openSections) ? (raw.openSections as string[]) : defaults.openSections,
    skills: Array.isArray(raw.skills) ? (raw.skills as ZoneNodeData['skills']) : defaults.skills,
    tools: raw.tools && typeof raw.tools === 'object' ? (raw.tools as ZoneNodeData['tools']) : defaults.tools,
    behavior: raw.behavior && typeof raw.behavior === 'object' ? (raw.behavior as ZoneNodeData['behavior']) : defaults.behavior,
    permissions: raw.permissions && typeof raw.permissions === 'object'
      ? (raw.permissions as ZoneNodeData['permissions'])
      : defaults.permissions,
    envVars: Array.isArray(raw.envVars) ? (raw.envVars as ZoneNodeData['envVars']) : defaults.envVars,
  }
}

function normalizeComponentData(raw: Record<string, unknown>): ComponentNodeData {
  return {
    label: typeof raw.label === 'string' ? raw.label : 'Component',
    description: typeof raw.description === 'string' ? raw.description : '',
    specs: typeof raw.specs === 'string' ? raw.specs : '',
    category: (raw.category as ComponentNodeData['category']) ?? 'services',
    iconName: typeof raw.iconName === 'string' ? raw.iconName : 'Settings2',
    color: typeof raw.color === 'string' ? raw.color : '#60a5fa',
    tag: typeof raw.tag === 'string' ? raw.tag : 'NODE',
  }
}

export function migrateCanvasData(raw: unknown): ArchitectCanvasData {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const settings = normalizeProjectSettings(root.settings)
  const rawNodes = Array.isArray(root.nodes) ? (root.nodes as Array<Record<string, unknown>>) : []
  const rawEdges = Array.isArray(root.edges) ? (root.edges as Array<Record<string, unknown>>) : []

  const nodes: CanvasNode[] = []

  // Path A — legacy "architectNode" save: one zone overlaying a single component, both at absolute positions
  const isLegacy = rawNodes.length > 0 && rawNodes.every(node => node.type === 'architectNode' || !node.type)

  if (isLegacy) {
    rawNodes.forEach((node, index) => {
      const id = typeof node.id === 'string' ? node.id : `node-${index}`
      const position = (node.position as { x: number; y: number }) ?? { x: 80 + index * 360, y: 80 }
      const rawData = node.data && typeof node.data === 'object' ? (node.data as Record<string, unknown>) : {}
      const zonePos = { x: position.x - 20, y: position.y - 40 }
      nodes.push({
        id: `zone-${id}`,
        type: 'zone',
        position: zonePos,
        data: normalizeZoneData(rawData, settings),
        width: 280,
        height: 200,
        zIndex: 0,
      })
      nodes.push({
        id,
        type: 'component',
        position: { x: zonePos.x + 20, y: zonePos.y + 48 },
        data: normalizeComponentData(rawData),
        zIndex: 1,
      })
    })
  } else {
    // Path B — new format: zones + components. Resolve any legacy parentId/extent to absolute positions.
    const zonePositionById = new Map<string, { x: number; y: number }>()
    for (const node of rawNodes) {
      if (node.type === 'zone' && typeof node.id === 'string') {
        const pos = (node.position as { x: number; y: number }) ?? { x: 0, y: 0 }
        zonePositionById.set(node.id, pos)
      }
    }

    rawNodes.forEach((node, index) => {
      const id = typeof node.id === 'string' ? node.id : `node-${index}`
      const position = (node.position as { x: number; y: number }) ?? { x: 80 + index * 280, y: 80 }
      const rawData = node.data && typeof node.data === 'object' ? (node.data as Record<string, unknown>) : {}

      if (node.type === 'zone') {
        nodes.push({
          id,
          type: 'zone',
          position,
          data: normalizeZoneData(rawData, settings),
          width: typeof node.width === 'number' ? node.width : 320,
          height: typeof node.height === 'number' ? node.height : 220,
          zIndex: 0,
        })
      } else {
        const parentId = typeof node.parentId === 'string' ? node.parentId : undefined
        const parentPos = parentId ? zonePositionById.get(parentId) : undefined
        const absolutePosition = parentPos
          ? { x: parentPos.x + position.x, y: parentPos.y + position.y }
          : position
        nodes.push({
          id,
          type: 'component',
          position: absolutePosition,
          data: normalizeComponentData(rawData),
          zIndex: 1,
        })
      }
    })
  }

  const edges: Edge[] = rawEdges.map((edge, index) => ({
    id: typeof edge.id === 'string' ? edge.id : `edge-${index}`,
    source: String(edge.source ?? ''),
    target: String(edge.target ?? ''),
  }))

  return {
    nodes,
    edges,
    settings,
    savedAt: typeof root.savedAt === 'string' ? root.savedAt : undefined,
  }
}
