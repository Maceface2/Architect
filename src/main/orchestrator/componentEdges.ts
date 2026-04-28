import type { ComponentEdgeDirection, ComponentEdgeSpec } from './prompts/componentEdges'

interface ComponentNodeLike {
  id: string
  type: string
  data: {
    label: string
  }
}

interface EdgeLike {
  id: string
  source: string
  target: string
  data?: {
    label?: string
    direction?: ComponentEdgeDirection
  }
}

export function normalizeComponentEdgeDirection(raw: unknown): ComponentEdgeDirection {
  return raw === 'bidirectional' || raw === 'none' || raw === 'source-to-target'
    ? raw
    : 'source-to-target'
}

export function buildComponentEdgeSpecs<NodeLike extends ComponentNodeLike, Edge extends EdgeLike>(
  nodes: NodeLike[],
  edges: Edge[]
): ComponentEdgeSpec[] {
  const components = new Map<string, NodeLike>()
  for (const node of nodes) {
    if (node.type === 'component') components.set(node.id, node)
  }

  return edges
    .map(edge => {
      const source = components.get(edge.source)
      const target = components.get(edge.target)
      if (!source || !target) return null
      const label = typeof edge.data?.label === 'string' ? edge.data.label.trim() : ''
      return {
        id: edge.id,
        sourceId: source.id,
        sourceLabel: source.data.label,
        targetId: target.id,
        targetLabel: target.data.label,
        direction: normalizeComponentEdgeDirection(edge.data?.direction),
        ...(label ? { label } : {}),
      } satisfies ComponentEdgeSpec
    })
    .filter((edge): edge is ComponentEdgeSpec => !!edge)
}
