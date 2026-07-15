import { memo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react'
import { Trash2, X } from 'lucide-react'
import type { CanvasEdge, ComponentEdgeData } from '../../types'
import { normalizeEdgeData } from '../../lib/canvas'
import { getEdgeParams } from './floatingEdgeMath'

function edgeMarkerId(id: string): string {
  return `component-edge-end-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function ComponentEdge(props: EdgeProps<CanvasEdge>) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    data,
    selected,
  } = props
  const { setEdges, getNode } = useReactFlow()
  const [editorOpen, setEditorOpen] = useState(false)

  // Floating edge: no ports. Anchor points are computed per render as the
  // intersection of the center-to-center line with each card's rect, so the
  // edge re-anchors to the nearest side as cards move. Stored source/target
  // handle ids from legacy canvases are ignored. Falls back to React Flow's
  // handle-derived coordinates when a node isn't measurable yet.
  const sourceNode = useInternalNode(props.source)
  const targetNode = useInternalNode(props.target)

  let pathParams = {
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  }
  if (sourceNode && targetNode) {
    const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode)
    pathParams = {
      sourceX: sx,
      sourceY: sy,
      sourcePosition: sourcePos,
      targetX: tx,
      targetY: ty,
      targetPosition: targetPos,
    }
  }
  const [edgePath, labelX, labelY] = getBezierPath(pathParams)

  const edgeData = normalizeEdgeData(data)
  const label = edgeData.label ?? ''
  const isCrossFolder = !!edgeData.targetFolder
  // Dangling: persisted edge whose target folder isn't loaded into the
  // current workspace. We can't draw a real connection (the target node
  // isn't in the graph), so the renderer just dims the source endpoint
  // marker via the muted color/dash.
  const isDangling = (data as { dangling?: boolean } | undefined)?.dangling === true
  // Neutral gray connection lines. Selection is signalled by stroke width
  // (below), cross-folder by the dashed pattern — so color stays a quiet
  // two-step gray rather than another saturated signal.
  const color = selected
    ? 'rgb(var(--accent))'
    : isDangling
      ? '#424242'
      : '#525252'
  const editable = getNode(props.source)?.type === 'component' && getNode(props.target)?.type === 'component'

  const updateEdge = (next: ComponentEdgeData) => {
    const normalized = normalizeEdgeData(next)
    window.dispatchEvent(new Event('architect:edge-mutating'))
    setEdges(edges => edges.map(edge =>
      edge.id === id
        ? { ...edge, type: 'component-edge', data: normalized }
        : edge
    ))
  }

  const deleteEdge = () => {
    window.dispatchEvent(new Event('architect:edge-mutating'))
    setEdges(edges => edges.filter(edge => edge.id !== id))
    setEditorOpen(false)
  }

  return (
    <>
      <defs>
        <marker
          id={edgeMarkerId(id)}
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
        </marker>
      </defs>

      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={`url(#${edgeMarkerId(id)})`}
        style={{
          ...style,
          stroke: color,
          strokeWidth: selected ? 2 : 1.5,
          // Dashed style is the cross-folder-edge tell, so users can spot
          // dependencies that span workspace folders without inspecting
          // the edge data.
          ...(isCrossFolder ? { strokeDasharray: '6 4' } : {}),
          ...(isDangling ? { opacity: 0.5 } : {}),
        }}
      />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        className="cursor-pointer"
        onDoubleClick={event => {
          event.stopPropagation()
          if (editable) setEditorOpen(true)
        }}
      />

      {label && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan absolute -translate-x-1/2 -translate-y-1/2 rounded border border-white/10 bg-component px-2 py-0.5 text-[10px] font-medium text-fg shadow-lg"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onDoubleClick={event => {
              event.stopPropagation()
              if (editable) setEditorOpen(true)
            }}
            title={editable ? 'Double-click to edit connection' : undefined}
          >
            {label}
          </button>
        </EdgeLabelRenderer>
      )}

      {editorOpen && editable && createPortal(
        <EdgeEditorModal
          data={edgeData}
          onChange={updateEdge}
          onDelete={deleteEdge}
          onClose={() => setEditorOpen(false)}
        />,
        document.body,
      )}
    </>
  )
}

function EdgeEditorModal({
  data,
  onChange,
  onDelete,
  onClose,
}: {
  data: ComponentEdgeData
  onChange: (data: ComponentEdgeData) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(data.label ?? '')

  const save = () => {
    // Preserve fields the simplified UI no longer edits (direction from
    // legacy canvases, targetFolder for cross-folder edges).
    onChange({ ...data, label })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="w-[360px] rounded-lg border border-node-border bg-panel p-4 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Connection</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-fg-subtle hover:bg-white/10 hover:text-fg"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        <label className="mb-5 block">
          <span className="mb-1.5 block text-xs font-medium text-fg-muted">Label</span>
          <input
            value={label}
            onChange={event => setLabel(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') save() }}
            placeholder="e.g. publishes events"
            autoFocus
            className="w-full rounded border border-node-border bg-node px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
          />
        </label>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1.5 rounded px-2.5 py-2 text-xs font-medium text-red-300 hover:bg-red-500/15"
          >
            <Trash2 size={13} />
            Delete
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded bg-accent px-3 py-2 text-xs font-semibold text-fg hover:bg-accent/90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export default memo(ComponentEdge)
