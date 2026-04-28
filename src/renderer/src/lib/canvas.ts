import {
  AGENT_RUNTIMES,
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_BY_RUNTIME,
  isAgentRuntime,
  isEffortLevel,
  type AgentRuntime,
} from '../../../shared/agentRuntimes'
import type {
  ArchitectCanvasData,
  CanvasEdge,
  CanvasNode,
  ComponentEdgeData,
  ComponentEdgeDirection,
  ComponentNodeData,
  ComponentNodeType,
  HarnessTimeouts,
  NodeTools,
  ProjectSettings,
  RuntimeModelMap,
  ZoneNodeData,
  ZoneNodeType,
} from '../types'

export const DEFAULT_HARNESS_TIMEOUTS: HarnessTimeouts = {
  idleThresholdMs: 3 * 60_000,
  staleEscalationMs: 10 * 60_000,
}

export const DEFAULT_ZONE_TIMEOUT_MS = 30_000
export const DEFAULT_EDGE_DIRECTION: ComponentEdgeDirection = 'source-to-target'

export const DEFAULT_TOOLS: NodeTools = {
  webSearch: false,
  codeExec: false,
  fileRead: false,
  fileWrite: false,
  apiCalls: false,
  shell: false,
}

function buildDispatchModels(): RuntimeModelMap {
  const map: RuntimeModelMap = {}
  for (const runtime of AGENT_RUNTIMES) map[runtime.id] = runtime.defaultModel
  return map
}

export function createDefaultProjectSettings(): ProjectSettings {
  return {
    dispatchRuntime: DEFAULT_AGENT_RUNTIME,
    assistantMode: 'architecture',
    dispatchModels: buildDispatchModels(),
    dispatchEffort: 'medium',
    dispatchPlanMode: false,
    dispatchTools: { ...DEFAULT_TOOLS },
    dispatchTimeoutMs: DEFAULT_ZONE_TIMEOUT_MS,
    harnessTimeouts: { ...DEFAULT_HARNESS_TIMEOUTS },
  }
}

export function createDefaultZoneAgentConfig(settings: ProjectSettings = createDefaultProjectSettings()) {
  const runtime = settings.dispatchRuntime
  const seedModel = settings.dispatchModels[runtime] ?? DEFAULT_MODEL_BY_RUNTIME[runtime]
  return {
    agentRuntime: runtime,
    providerModels: { [runtime]: seedModel } as RuntimeModelMap,
    openSections: [],
    skills: [],
    tools: { ...settings.dispatchTools },
    behavior: { mode: 'sequential' as const, retries: 0, onFailure: 'stop' as const, timeoutMs: settings.dispatchTimeoutMs },
    permissions: { readFiles: false, writeFiles: false, network: false, shell: false },
    envVars: [],
  }
}

// Sanitize a label into a filesystem/JSON-safe token. Duplicated from
// src/main/terminals.ts — kept in sync; the renderer mints participantIds
// the same way the main process used to derive them from labels.
export function sanitizeLabelForParticipantId(label: string): string {
  return label.replace(/[^a-zA-Z0-9-_]/g, '-')
}

// Mint a unique participantId for a zone given its label and the set of
// participantIds already used by sibling zones on the canvas. Preferred
// shape is the sanitized label; on collision, append `-2`, `-3`, etc.
// Callers own the `used` set; pass the new id back in before minting the
// next one so dedup stays correct.
export function mintParticipantId(label: string, used: Set<string>): string {
  const base = sanitizeLabelForParticipantId((label ?? '').trim()) || 'zone'
  if (!used.has(base)) return base
  for (let n = 2; n < 1_000_000; n += 1) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
  // Astronomically unreachable, but give the type checker a concrete return.
  return `${base}-${Date.now()}`
}

export function createDefaultZoneData(
  settings: ProjectSettings = createDefaultProjectSettings(),
  participantId = 'zone',
): ZoneNodeData {
  return {
    participantId,
    label: 'Zone',
    description: '',
    color: '#58A6FF',
    status: 'idle',
    systemPrompt: '',
    ...createDefaultZoneAgentConfig(settings),
  }
}

export function normalizeEdgeDirection(raw: unknown): ComponentEdgeDirection {
  return raw === 'bidirectional' || raw === 'none' || raw === 'source-to-target'
    ? raw
    : DEFAULT_EDGE_DIRECTION
}

export function normalizeEdgeData(raw: unknown): ComponentEdgeData {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const label = typeof rec.label === 'string' ? rec.label.trim() : ''
  return {
    direction: normalizeEdgeDirection(rec.direction),
    ...(label ? { label } : {}),
  }
}

export function getEffectiveRuntime(
  data: Pick<ZoneNodeData, 'agentRuntime'>,
  settings: ProjectSettings
): AgentRuntime {
  return data.agentRuntime ?? settings.dispatchRuntime
}

export function getEffectiveModel(
  data: Pick<ZoneNodeData, 'providerModels' | 'agentRuntime'>,
  settings: ProjectSettings
): string {
  const runtime = getEffectiveRuntime(data, settings)
  return data.providerModels?.[runtime] ?? DEFAULT_MODEL_BY_RUNTIME[runtime]
}

function normalizeProviderModels(
  rawData: Record<string, unknown>,
  dispatchRuntime: AgentRuntime
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

  if (!providerModels[dispatchRuntime]) {
    providerModels[dispatchRuntime] = DEFAULT_MODEL_BY_RUNTIME[dispatchRuntime]
  }

  return providerModels
}

function normalizeDispatchModels(raw: unknown): RuntimeModelMap {
  const map = buildDispatchModels()
  if (!raw || typeof raw !== 'object') return map
  for (const [runtime, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isAgentRuntime(runtime) && typeof value === 'string' && value.trim()) {
      map[runtime] = value
    }
  }
  return map
}

function normalizeDispatchTools(raw: unknown): NodeTools {
  const base = { ...DEFAULT_TOOLS }
  if (!raw || typeof raw !== 'object') return base
  const rec = raw as Record<string, unknown>
  for (const key of Object.keys(base) as (keyof NodeTools)[]) {
    if (typeof rec[key] === 'boolean') base[key] = rec[key] as boolean
  }
  return base
}

function normalizeHarnessTimeouts(raw: unknown): HarnessTimeouts {
  const base = { ...DEFAULT_HARNESS_TIMEOUTS }
  if (!raw || typeof raw !== 'object') return base
  const rec = raw as Record<string, unknown>
  for (const key of Object.keys(base) as (keyof HarnessTimeouts)[]) {
    const v = rec[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) base[key] = v
  }
  return base
}

export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  const rawSettings = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  // Backwards compat: older canvas files used `default*` names for what are
  // now `dispatch*` fields. Accept both on read so existing projects keep
  // working; writes always use the new names.
  const dispatchRuntime = isAgentRuntime(rawSettings.dispatchRuntime)
    ? rawSettings.dispatchRuntime
    : isAgentRuntime(rawSettings.defaultRuntime)
      ? rawSettings.defaultRuntime
      : DEFAULT_AGENT_RUNTIME
  const conductorRuntime = isAgentRuntime(rawSettings.conductorRuntime)
    ? rawSettings.conductorRuntime
    : undefined
  const assistantMode =
    rawSettings.assistantMode === 'general' ? 'general' : 'architecture'
  const rawDispatchEffort = rawSettings.dispatchEffort ?? rawSettings.defaultEffort
  const dispatchEffort = isEffortLevel(rawDispatchEffort) ? rawDispatchEffort : 'medium'
  const dispatchPlanMode = rawSettings.dispatchPlanMode === true || rawSettings.defaultPlanMode === true
  const rawDispatchTimeoutMs = rawSettings.dispatchTimeoutMs ?? rawSettings.defaultTimeoutMs
  const dispatchTimeoutMs =
    typeof rawDispatchTimeoutMs === 'number' && rawDispatchTimeoutMs >= 0
      ? rawDispatchTimeoutMs
      : DEFAULT_ZONE_TIMEOUT_MS

  const assistantModels = normalizeAssistantModels(rawSettings.assistantModels)
  const assistantRuntimeByMode = normalizeAssistantRuntimeByMode(rawSettings.assistantRuntimeByMode, rawSettings.assistantRuntime)
  const assistantLastSessionByMode = normalizeAssistantLastSessionByMode(rawSettings.assistantLastSessionByMode)

  const rawDispatchModels = rawSettings.dispatchModels ?? rawSettings.defaultModels
  const rawDispatchTools = rawSettings.dispatchTools ?? rawSettings.defaultTools

  return {
    dispatchRuntime,
    ...(conductorRuntime ? { conductorRuntime } : {}),
    assistantMode,
    dispatchModels: normalizeDispatchModels(rawDispatchModels),
    ...(assistantModels ? { assistantModels } : {}),
    ...(assistantRuntimeByMode ? { assistantRuntimeByMode } : {}),
    ...(assistantLastSessionByMode ? { assistantLastSessionByMode } : {}),
    dispatchEffort,
    dispatchPlanMode,
    dispatchTools: normalizeDispatchTools(rawDispatchTools),
    dispatchTimeoutMs,
    harnessTimeouts: normalizeHarnessTimeouts(rawSettings.harnessTimeouts),
  }
}

function normalizeAssistantModels(raw: unknown): RuntimeModelMap | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const map: RuntimeModelMap = {}
  for (const [runtime, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isAgentRuntime(runtime) && typeof value === 'string' && value.trim()) {
      map[runtime] = value
    }
  }
  return Object.keys(map).length > 0 ? map : undefined
}

function normalizeAssistantRuntimeByMode(
  raw: unknown,
  legacyAssistantRuntime: unknown,
): Partial<Record<'architecture' | 'general', import('../../../shared/agentRuntimes').AgentRuntime>> | undefined {
  const map: Partial<Record<'architecture' | 'general', import('../../../shared/agentRuntimes').AgentRuntime>> = {}
  if (raw && typeof raw === 'object') {
    for (const [mode, value] of Object.entries(raw as Record<string, unknown>)) {
      if ((mode === 'architecture' || mode === 'general') && isAgentRuntime(value)) {
        map[mode] = value
      }
    }
  }
  // Legacy migration: the prior single `assistantRuntime` field applied to
  // both modes. Seed both entries so existing projects keep their override.
  if (Object.keys(map).length === 0 && isAgentRuntime(legacyAssistantRuntime)) {
    map.architecture = legacyAssistantRuntime
    map.general = legacyAssistantRuntime
  }
  return Object.keys(map).length > 0 ? map : undefined
}

function normalizeAssistantLastSessionByMode(
  raw: unknown,
): Partial<Record<'architecture' | 'general', { runtime: import('../../../shared/agentRuntimes').AgentRuntime; sessionId: string; model?: string }>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const map: Partial<Record<'architecture' | 'general', { runtime: import('../../../shared/agentRuntimes').AgentRuntime; sessionId: string; model?: string }>> = {}
  for (const [mode, value] of Object.entries(raw as Record<string, unknown>)) {
    if (mode !== 'architecture' && mode !== 'general') continue
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    if (!isAgentRuntime(entry.runtime)) continue
    if (typeof entry.sessionId !== 'string' || !entry.sessionId.trim()) continue
    const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model : undefined
    map[mode] = { runtime: entry.runtime, sessionId: entry.sessionId, ...(model ? { model } : {}) }
  }
  return Object.keys(map).length > 0 ? map : undefined
}

function normalizeZoneData(raw: Record<string, unknown>, settings: ProjectSettings): ZoneNodeData {
  const defaults = createDefaultZoneAgentConfig(settings)
  // Legacy migration: older canvases had a two-field split
  // (`agentRuntimeMode: 'inherit' | 'override'` + `agentRuntime`). 'inherit'
  // zones ignored their stored runtime and followed settings.dispatchRuntime.
  // We collapse that here so `agentRuntime` is the single source of truth.
  // IMPORTANT: do NOT force 'inherit' legacy zones back to the canvas default
  // on every load — we only migrate once. If a user later overrides a zone,
  // re-snapping to default would wipe that choice on the next save/reload.
  // The one-shot migration is: if the saved data has legacyMode without a
  // valid agentRuntime, seed it from the default; otherwise trust the stored
  // agentRuntime (which is what the user last picked).
  const storedRuntime = isAgentRuntime(raw.agentRuntime) ? raw.agentRuntime : null
  const agentRuntime = storedRuntime ?? settings.dispatchRuntime ?? DEFAULT_AGENT_RUNTIME

  // Legacy migration: pre-refactor zones stored their behavior customization under `prompt`.
  // The field has been renamed to `systemPrompt`; fall back to the old key when present.
  const systemPrompt = typeof raw.systemPrompt === 'string'
    ? raw.systemPrompt
    : typeof raw.prompt === 'string'
      ? raw.prompt
      : ''

  // Per-zone participantId: preserve what was saved. An empty placeholder
  // here is backfilled by migrateCanvasData's post-pass (it needs the full
  // zone set to dedup collisions), so we don't mint one in isolation.
  const participantId = typeof raw.participantId === 'string' && raw.participantId.trim()
    ? raw.participantId
    : ''

  return {
    participantId,
    label: typeof raw.label === 'string' ? raw.label : 'Zone',
    description: typeof raw.description === 'string' ? raw.description : '',
    color: typeof raw.color === 'string' ? raw.color : '#58A6FF',
    status: (raw.status as ZoneNodeData['status']) ?? 'idle',
    systemPrompt,
    agentRuntime,
    providerModels: normalizeProviderModels(raw, settings.dispatchRuntime),
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
    category: (raw.category as ComponentNodeData['category']) ?? 'custom',
    iconName: typeof raw.iconName === 'string' ? raw.iconName : 'Wrench',
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

  // Canvas-wide participantId reconciliation: preserve stored ids when
  // present and unique, rename collisions deterministically, mint a fresh
  // one for zones that arrived without any id (legacy saves, assistant patches
  // that forgot, assistant-driven canvas patches).
  const usedParticipantIds = new Set<string>()
  for (const node of nodes) {
    if (node.type !== 'zone') continue
    const existing = (node.data as ZoneNodeData).participantId
    if (existing && !usedParticipantIds.has(existing)) {
      usedParticipantIds.add(existing)
    }
  }
  for (const node of nodes) {
    if (node.type !== 'zone') continue
    const data = node.data as ZoneNodeData
    if (data.participantId && usedParticipantIds.has(data.participantId) && !isCollisionOwner(nodes, node.id, data.participantId)) {
      // Duplicate of another zone's stored id — rename to keep data.kv /
      // activity-log files addressable per-zone.
      data.participantId = mintParticipantId(data.label, usedParticipantIds)
      usedParticipantIds.add(data.participantId)
    } else if (!data.participantId) {
      data.participantId = mintParticipantId(data.label, usedParticipantIds)
      usedParticipantIds.add(data.participantId)
    }
  }

  const edges: CanvasEdge[] = rawEdges.map((edge, index) => ({
    id: typeof edge.id === 'string' ? edge.id : `edge-${index}`,
    type: 'component-edge',
    source: String(edge.source ?? ''),
    target: String(edge.target ?? ''),
    sourceHandle: typeof edge.sourceHandle === 'string' ? edge.sourceHandle : null,
    targetHandle: typeof edge.targetHandle === 'string' ? edge.targetHandle : null,
    data: normalizeEdgeData(edge.data ?? edge),
  }))

  return {
    nodes,
    edges,
    settings,
    savedAt: typeof root.savedAt === 'string' ? root.savedAt : undefined,
  }
}

// First zone (by canvas order) to own a given participantId keeps it; any
// later zone with the same id is treated as a collision and renamed.
function isCollisionOwner(nodes: CanvasNode[], zoneId: string, participantId: string): boolean {
  for (const node of nodes) {
    if (node.type !== 'zone') continue
    if ((node.data as ZoneNodeData).participantId !== participantId) continue
    return node.id === zoneId
  }
  return false
}
