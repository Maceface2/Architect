// Two output formats over the same CanvasProjection: a pretty-printed JSON
// blob for ARCHITECT/manifest.json (the canonical on-disk artifact) and a
// markdown rendering for inline embedding in agent prompts. Both formats
// open with the same graph-semantics glossary so direction / relation
// meaning is explicit at every site.

import type {
  CanvasProjection,
  ComponentEdgeDirection,
  ProjectedComponent,
  ProjectedCrossZoneEdge,
  ProjectedEdge,
  ProjectedInternalEdge,
  ProjectedZone,
} from './projection'

const GRAPH_SEMANTICS_TEXT =
  'Components are subsystems. Zones are agent-ownership overlays — a zone owns every component whose center sits in its bounding box. ' +
  'An edge with direction `source-to-target` means source references / depends on / talks to target; ' +
  '`bidirectional` means both ways; `none` means undirected. ' +
  'Edge labels are free-text channel names (e.g. "window.electron", "startDispatch"), not formal relation kinds.'

export function renderGraphSemanticsHeader(): string {
  return `> **Graph semantics:** ${GRAPH_SEMANTICS_TEXT}`
}

// ---------- JSON ----------

export function renderProjectionJson(proj: CanvasProjection): string {
  const out = {
    graph_semantics: GRAPH_SEMANTICS_TEXT,
    zones: proj.zones,
    unassignedComponents: proj.unassignedComponents,
    crossZoneEdges: proj.crossZoneEdges,
    internalEdges: proj.internalEdges,
    unassignedEdges: proj.unassignedEdges,
  }
  return JSON.stringify(out, null, 2)
}

// ---------- Markdown ----------

export type RenderScope =
  | { kind: 'full' }
  | {
      kind: 'focus'
      focusZoneParticipantId: string
      includeSiblingRoster: boolean
      includeManifestPointer: boolean
    }

export interface RenderMarkdownOptions {
  scope: RenderScope
  showCrossZoneSection: boolean
  showUnassignedSection: boolean
}

export function renderProjectionMarkdown(
  proj: CanvasProjection,
  opts: RenderMarkdownOptions,
): string {
  const sections: string[] = [renderGraphSemanticsHeader()]
  if (opts.scope.kind === 'full') {
    sections.push(renderFullScope(proj, opts))
  } else {
    sections.push(renderFocusScope(proj, opts.scope, opts))
  }
  return sections.join('\n\n')
}

function renderFullScope(proj: CanvasProjection, opts: RenderMarkdownOptions): string {
  const blocks: string[] = []

  blocks.push('## Zones')
  if (proj.zones.length === 0) {
    blocks.push('_(no zones drawn on the canvas)_')
  } else {
    for (const zone of proj.zones) {
      blocks.push(renderZoneFullBlock(zone))
    }
  }

  if (opts.showCrossZoneSection) {
    blocks.push('## Cross-zone edges')
    blocks.push(renderCrossZoneEdgeList(proj.crossZoneEdges))

    blocks.push('## Intra-zone edges')
    blocks.push(renderInternalEdgeList(proj.internalEdges))
  }

  if (opts.showUnassignedSection) {
    blocks.push('## Unassigned components')
    blocks.push(
      proj.unassignedComponents.length
        ? proj.unassignedComponents.map(renderComponentBullet).join('\n\n')
        : '_(none)_',
    )

    blocks.push('## Unassigned edges')
    blocks.push(renderPlainEdgeList(proj.unassignedEdges))
  }

  return blocks.join('\n\n')
}

function renderFocusScope(
  proj: CanvasProjection,
  scope: Extract<RenderScope, { kind: 'focus' }>,
  opts: RenderMarkdownOptions,
): string {
  const focus = proj.zones.find(z => z.participantId === scope.focusZoneParticipantId)
  const blocks: string[] = []

  if (!focus) {
    blocks.push(`## Your zone\n_(could not find zone with participantId \`${scope.focusZoneParticipantId}\` in the projection — falling back to manifest)_`)
  } else {
    const heading = `## Your zone: ${focus.label} (\`${focus.participantId}\`${focus.runtime ? `, ${focus.runtime}` : ''})`
    const desc = focus.description ? `\n${focus.description}` : ''
    const components = focus.components.length
      ? `\n\nComponents you own:\n${focus.components.map(renderComponentBullet).join('\n\n')}`
      : '\n\nComponents you own: _(none — work from the task alone)_'
    blocks.push(`${heading}${desc}${components}`)
  }

  if (opts.showCrossZoneSection) {
    const myEdges = proj.crossZoneEdges.filter(
      e =>
        e.fromZoneParticipantId === scope.focusZoneParticipantId ||
        e.toZoneParticipantId === scope.focusZoneParticipantId,
    )
    blocks.push('## Your cross-zone touchpoints')
    if (myEdges.length === 0) {
      blocks.push('_(no cross-zone edges touch your components)_')
    } else {
      blocks.push(myEdges.map(e => renderCrossZoneTouchpoint(e, scope.focusZoneParticipantId)).join('\n'))
    }

    const myInternal = proj.internalEdges.filter(
      e => e.zoneParticipantId === scope.focusZoneParticipantId,
    )
    if (myInternal.length) {
      blocks.push('## Edges within your zone')
      blocks.push(myInternal.map(renderInternalEdgeBullet).join('\n'))
    }
  }

  if (scope.includeSiblingRoster) {
    const siblings = proj.zones.filter(z => z.participantId !== scope.focusZoneParticipantId)
    if (siblings.length) {
      blocks.push('## Sibling zones (read-only roster)')
      blocks.push(
        siblings
          .map(z => `- **${z.label}** (\`${z.participantId}\`)${z.description ? ` — ${z.description}` : ''}`)
          .join('\n'),
      )
    }
  }

  if (opts.showUnassignedSection) {
    if (proj.unassignedComponents.length) {
      blocks.push('## Unassigned components (canvas reference)')
      blocks.push(proj.unassignedComponents.map(renderComponentBullet).join('\n\n'))
    }
    if (proj.unassignedEdges.length) {
      blocks.push('## Unassigned edges')
      blocks.push(renderPlainEdgeList(proj.unassignedEdges))
    }
  }

  if (scope.includeManifestPointer) {
    blocks.push(
      '## Manifest\nFull canvas projection at `ARCHITECT/manifest.json` — `cat` it for cross-zone detail you don\'t see above.',
    )
  }

  return blocks.join('\n\n')
}

// ---------- Bullet helpers ----------

function renderZoneFullBlock(zone: ProjectedZone): string {
  const heading = `### ${zone.label} (\`${zone.participantId}\`${zone.runtime ? `, ${zone.runtime}` : ''})`
  const desc = zone.description ? `\n${zone.description}` : ''
  const componentBlock = zone.components.length
    ? `\n\nComponents:\n${zone.components.map(renderComponentBullet).join('\n\n')}`
    : '\n\n_(no components in this zone)_'
  return `${heading}${desc}${componentBlock}`
}

function renderComponentBullet(c: ProjectedComponent): string {
  const tagBits: string[] = []
  if (c.tag) tagBits.push(c.tag)
  if (c.type) tagBits.push(c.type)
  const tagStr = tagBits.length ? ` [${tagBits.join(' · ')}]` : ''
  const descStr = c.description ? ` — ${c.description}` : ''
  const head = `- **${c.label}**${tagStr}${descStr}`

  const specs = (c.specs ?? '').trim()
  const propsBlock = (c.properties ?? []).length
    ? `\n\n  Properties:\n${(c.properties ?? []).map(p => `    - \`${p.key}\` : \`${p.value}\``).join('\n')}`
    : ''

  if (!specs) return `${head}${propsBlock}`
  const indentedSpecs = specs.split('\n').join('\n  ')
  return `${head}\n\n  ${indentedSpecs}${propsBlock}`
}

function arrow(direction: ComponentEdgeDirection): string {
  if (direction === 'bidirectional') return '<-->'
  if (direction === 'none') return '---'
  return '-->'
}

function edgeLabelSuffix(edge: ProjectedEdge): string {
  return edge.label ? ` — ${edge.label}` : ''
}

function renderCrossZoneEdgeList(edges: ProjectedCrossZoneEdge[]): string {
  if (!edges.length) return '_(no cross-zone edges)_'
  return edges
    .map(
      e =>
        `- ${e.fromZoneLabel}.**${e.fromComponentLabel}** ${arrow(e.direction)} ${e.toZoneLabel}.**${e.toComponentLabel}**${edgeLabelSuffix(e)}`,
    )
    .join('\n')
}

function renderInternalEdgeList(edges: ProjectedInternalEdge[]): string {
  if (!edges.length) return '_(no intra-zone edges)_'
  return edges
    .map(
      e =>
        `- ${e.zoneLabel}: **${e.fromComponentLabel}** ${arrow(e.direction)} **${e.toComponentLabel}**${edgeLabelSuffix(e)}`,
    )
    .join('\n')
}

function renderInternalEdgeBullet(e: ProjectedInternalEdge): string {
  return `- **${e.fromComponentLabel}** ${arrow(e.direction)} **${e.toComponentLabel}**${edgeLabelSuffix(e)}`
}

function renderPlainEdgeList(edges: ProjectedEdge[]): string {
  if (!edges.length) return '_(none)_'
  return edges
    .map(
      e => `- **${e.fromComponentLabel}** ${arrow(e.direction)} **${e.toComponentLabel}**${edgeLabelSuffix(e)}`,
    )
    .join('\n')
}

function renderCrossZoneTouchpoint(e: ProjectedCrossZoneEdge, focusParticipantId: string): string {
  const isOutbound = e.fromZoneParticipantId === focusParticipantId
  const otherZoneLabel = isOutbound ? e.toZoneLabel : e.fromZoneLabel
  const otherParticipantId = isOutbound ? e.toZoneParticipantId : e.fromZoneParticipantId
  const main = `- ${e.fromZoneLabel}.**${e.fromComponentLabel}** ${arrow(e.direction)} ${e.toZoneLabel}.**${e.toComponentLabel}**${edgeLabelSuffix(e)}`
  return `${main}\n  (talk to participant \`${otherParticipantId}\` for changes touching ${otherZoneLabel})`
}
