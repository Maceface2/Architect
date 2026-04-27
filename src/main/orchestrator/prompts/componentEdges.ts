// Shared edge-render contract used by every prompt builder. Component edges
// are reference-only metadata on the canvas — they aren't used for zone
// scheduling or task ordering. Both the Conductor and zone prompts surface
// them so the agent has design context, but no behavior depends on them.

export type ComponentEdgeDirection = 'source-to-target' | 'bidirectional' | 'none'

export interface ComponentEdgeSpec {
  id: string
  sourceId: string
  sourceLabel: string
  targetId: string
  targetLabel: string
  label?: string
  direction: ComponentEdgeDirection
}

export function renderComponentEdges(
  edges: ComponentEdgeSpec[],
  emptyMessage = '_(no component edges touch your owned components)_'
): string {
  if (!edges.length) return emptyMessage
  return edges.map(edge => {
    const relation = edge.label ? ` — ${edge.label}` : ''
    return `- ${edge.sourceLabel} (\`${edge.sourceId}\`) -> ${edge.targetLabel} (\`${edge.targetId}\`) · direction: ${edge.direction}${relation}`
  }).join('\n')
}
