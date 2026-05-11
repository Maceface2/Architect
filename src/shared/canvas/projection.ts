// Shared canvas projection — the single normalization layer between the
// raw React Flow nodes/edges (as saved in architect-canvas.json) and every
// place we hand canvas context to an agent or persist it on disk.
//
// Strips visual / interaction-only fields (positions, colors, sizes,
// iconNames, ReactFlow internals, edge handles) and groups edges by their
// zone-membership relationship: cross-zone, intra-zone, unassigned. Both
// the renderer and the main process import this module — no Node-only deps.

import type { AgentRuntime } from '../agentRuntimes'

export type ComponentEdgeDirection = 'source-to-target' | 'bidirectional' | 'none'

// Structural node shapes the projection accepts. Compatible with the
// renderer's React Flow `CanvasNode` union and the main process's
// `GraphNode` union (both ultimately satisfy these duck-typed interfaces).

export interface ProjectionZoneNodeLike {
  id: string
  type: 'zone'
  position: { x: number; y: number }
  width?: number
  height?: number
  data: {
    participantId?: string
    label: string
    description?: string
    [key: string]: unknown
  }
}

export interface ProjectionComponentNodeLike {
  id: string
  type: 'component'
  position: { x: number; y: number }
  data: {
    label: string
    description?: string
    specs?: string
    category?: string
    tag?: string
    fields?: Array<{ key: string; value: string }>
    [key: string]: unknown
  }
}

export type ProjectionNodeLike = ProjectionZoneNodeLike | ProjectionComponentNodeLike

export interface ProjectionEdgeLike {
  id: string
  source: string
  target: string
  data?: {
    label?: string
    direction?: ComponentEdgeDirection | string
    [key: string]: unknown
  } | null
}

// ---- Output shape ----

export interface ProjectedComponent {
  id: string
  type?: string
  label: string
  tag?: string
  description?: string
  specs?: string
  properties?: Array<{ key: string; value: string }>
}

export interface ProjectedZone {
  participantId: string
  label: string
  description?: string
  runtime?: AgentRuntime
  components: ProjectedComponent[]
}

export interface ProjectedEdge {
  fromComponentId: string
  fromComponentLabel: string
  toComponentId: string
  toComponentLabel: string
  direction: ComponentEdgeDirection
  label?: string
}

export interface ProjectedCrossZoneEdge extends ProjectedEdge {
  fromZoneParticipantId: string
  fromZoneLabel: string
  toZoneParticipantId: string
  toZoneLabel: string
}

export interface ProjectedInternalEdge extends ProjectedEdge {
  zoneParticipantId: string
  zoneLabel: string
}

export interface CanvasProjection {
  zones: ProjectedZone[]
  unassignedComponents: ProjectedComponent[]
  unassignedEdges: ProjectedEdge[]
  crossZoneEdges: ProjectedCrossZoneEdge[]
  internalEdges: ProjectedInternalEdge[]
}

// ---- Constants (mirror the renderer's canvas geometry; kept in sync with
// COMPONENT_APPROX_W / COMPONENT_APPROX_H / ZONE_DEFAULT_WIDTH / ZONE_DEFAULT_HEIGHT
// in src/main/terminals.ts and src/renderer/src/types.ts). ----

const COMPONENT_APPROX_W = 180
const COMPONENT_APPROX_H = 78
const ZONE_DEFAULT_WIDTH = 420
const ZONE_DEFAULT_HEIGHT = 280

// ---- Spatial ownership ----

export interface ZoneOwnershipIndex {
  zones: ProjectionZoneNodeLike[]
  componentsByZoneId: Map<string, ProjectionComponentNodeLike[]>
  unassignedComponents: ProjectionComponentNodeLike[]
}

// Overlay semantics: a component belongs to the smallest zone whose bbox
// contains its center. Smallest = lowest area; resolves ambiguity when zones
// overlap (inner-most wins). Lifted from src/main/terminals.ts:indexGraph so
// renderer + main share one implementation.
export function indexZoneOwnership(nodes: ProjectionNodeLike[]): ZoneOwnershipIndex {
  const zones: ProjectionZoneNodeLike[] = []
  const components: ProjectionComponentNodeLike[] = []
  const componentsByZoneId = new Map<string, ProjectionComponentNodeLike[]>()
  const unassignedComponents: ProjectionComponentNodeLike[] = []

  for (const node of nodes) {
    if (node.type === 'zone') {
      zones.push(node)
      componentsByZoneId.set(node.id, [])
    } else if (node.type === 'component') {
      components.push(node)
    }
  }

  for (const comp of components) {
    const cx = comp.position.x + COMPONENT_APPROX_W / 2
    const cy = comp.position.y + COMPONENT_APPROX_H / 2
    let best: ProjectionZoneNodeLike | null = null
    let bestArea = Infinity
    for (const zone of zones) {
      const w = zone.width ?? ZONE_DEFAULT_WIDTH
      const h = zone.height ?? ZONE_DEFAULT_HEIGHT
      const x0 = zone.position.x
      const y0 = zone.position.y
      const inside = cx >= x0 && cx <= x0 + w && cy >= y0 && cy <= y0 + h
      if (!inside) continue
      const area = w * h
      if (area < bestArea) {
        best = zone
        bestArea = area
      }
    }
    if (best) componentsByZoneId.get(best.id)!.push(comp)
    else unassignedComponents.push(comp)
  }

  return { zones, componentsByZoneId, unassignedComponents }
}

// ---- Helpers ----

function normalizeDirection(raw: unknown): ComponentEdgeDirection {
  return raw === 'bidirectional' || raw === 'none' || raw === 'source-to-target'
    ? raw
    : 'source-to-target'
}

function mintParticipantId(zone: ProjectionZoneNodeLike): string {
  // The renderer is responsible for minting a real participantId at zone
  // creation. This fallback only fires for pathological canvases that never
  // went through the normalization path — sanitize the label to keep the
  // projection self-consistent.
  if (typeof zone.data.participantId === 'string' && zone.data.participantId.trim()) {
    return zone.data.participantId
  }
  const fromLabel = (zone.data.label || zone.id || 'zone').replace(/[^a-zA-Z0-9_-]+/g, '-')
  return fromLabel || 'zone'
}

function projectComponent(node: ProjectionComponentNodeLike): ProjectedComponent {
  const out: ProjectedComponent = {
    id: node.id,
    label: node.data.label,
  }
  if (node.data.category) out.type = node.data.category
  if (node.data.tag) out.tag = node.data.tag
  if (node.data.description) out.description = node.data.description
  if (node.data.specs) out.specs = node.data.specs
  const fields = (node.data.fields ?? []).filter(
    f => typeof f?.key === 'string' && typeof f?.value === 'string',
  )
  if (fields.length) {
    out.properties = fields.map(f => ({ key: f.key, value: f.value }))
  }
  return out
}

// ---- Main entry ----

export interface BuildProjectionOptions {
  // Optional resolver for the zone's runtime label (e.g. for the conductor
  // prompt). When provided, the projected zone gets `runtime` populated.
  runtimeFor?: (zoneNode: ProjectionZoneNodeLike) => AgentRuntime | undefined
  // Filter zones to a subset (by node id). Edges/components keep their full
  // classification — components in dropped zones become unassigned, and
  // edges may move to unassigned/cross-zone accordingly. Used by per-zone
  // dispatches (`onlyZoneIds`).
  includeZoneIds?: ReadonlySet<string>
}

export function buildCanvasProjection(
  nodes: ProjectionNodeLike[],
  edges: ProjectionEdgeLike[],
  opts: BuildProjectionOptions = {},
): CanvasProjection {
  const ownership = indexZoneOwnership(nodes)

  const includeZoneIds = opts.includeZoneIds
  const activeZoneNodes = includeZoneIds
    ? ownership.zones.filter(z => includeZoneIds.has(z.id))
    : ownership.zones

  const projectedZones: ProjectedZone[] = activeZoneNodes.map(zone => {
    const zoneRuntime = opts.runtimeFor?.(zone)
    const ownedComponents = ownership.componentsByZoneId.get(zone.id) ?? []
    const out: ProjectedZone = {
      participantId: mintParticipantId(zone),
      label: zone.data.label,
      components: ownedComponents.map(projectComponent),
    }
    if (zone.data.description) out.description = zone.data.description
    if (zoneRuntime) out.runtime = zoneRuntime
    return out
  })

  // Build a node-id → owning-zone-node map so edges can be classified.
  const ownerZoneByComponentId = new Map<string, ProjectionZoneNodeLike>()
  for (const zone of activeZoneNodes) {
    for (const comp of ownership.componentsByZoneId.get(zone.id) ?? []) {
      ownerZoneByComponentId.set(comp.id, zone)
    }
  }

  // Build a node-id → component-node map for label/id resolution on edges.
  const componentById = new Map<string, ProjectionComponentNodeLike>()
  for (const node of nodes) {
    if (node.type === 'component') componentById.set(node.id, node)
  }

  // Components that are unassigned from the active zone set: any component
  // not owned by any *included* zone. (Includes components owned by excluded
  // zones, which is the correct behaviour for `onlyZoneIds` — the agent for
  // the included zone shouldn't see foreign-zone components as theirs.)
  const unassignedComponents: ProjectedComponent[] = []
  for (const comp of componentById.values()) {
    if (!ownerZoneByComponentId.has(comp.id)) {
      unassignedComponents.push(projectComponent(comp))
    }
  }

  const crossZoneEdges: ProjectedCrossZoneEdge[] = []
  const internalEdges: ProjectedInternalEdge[] = []
  const unassignedEdges: ProjectedEdge[] = []

  for (const edge of edges) {
    const source = componentById.get(edge.source)
    const target = componentById.get(edge.target)
    if (!source || !target) continue // skip orphan edges (zone-to-zone, dangling)

    const direction = normalizeDirection(edge.data?.direction)
    const labelRaw = typeof edge.data?.label === 'string' ? edge.data.label.trim() : ''
    const labelField = labelRaw ? { label: labelRaw } : {}

    const baseEdge: ProjectedEdge = {
      fromComponentId: source.id,
      fromComponentLabel: source.data.label,
      toComponentId: target.id,
      toComponentLabel: target.data.label,
      direction,
      ...labelField,
    }

    const sourceZone = ownerZoneByComponentId.get(source.id)
    const targetZone = ownerZoneByComponentId.get(target.id)

    if (!sourceZone || !targetZone) {
      unassignedEdges.push(baseEdge)
      continue
    }
    if (sourceZone.id === targetZone.id) {
      internalEdges.push({
        ...baseEdge,
        zoneParticipantId: mintParticipantId(sourceZone),
        zoneLabel: sourceZone.data.label,
      })
    } else {
      crossZoneEdges.push({
        ...baseEdge,
        fromZoneParticipantId: mintParticipantId(sourceZone),
        fromZoneLabel: sourceZone.data.label,
        toZoneParticipantId: mintParticipantId(targetZone),
        toZoneLabel: targetZone.data.label,
      })
    }
  }

  return {
    zones: projectedZones,
    unassignedComponents,
    unassignedEdges,
    crossZoneEdges,
    internalEdges,
  }
}
