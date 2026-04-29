import { memo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react'
import { Trash2, X } from 'lucide-react'
import type { CanvasEdge, ComponentEdgeData, ComponentEdgeDirection } from '../../types'
import { normalizeEdgeData } from '../../lib/canvas'

const DIRECTION_LABELS: Record<ComponentEdgeDirection, string> = {
  'source-to-target': 'One-way',
  bidirectional: 'Two-way',
  none: 'None',
}

function edgeMarkerId(id: string, side: 'start' | 'end'): string {
  return `component-edge-${side}-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

// Component handles sit 5px outside the node body (left:-5 / right:-5 in
// ComponentNode), so the bezier from handle-center to handle-center leaves a
// 5px gap between the line and each node. Extend the path with a short
// straight segment on each end so the line (and arrow) reach the node edge
// while the dots stay where they are.
const HANDLE_INSET = 5

function outwardDelta(pos: Position): { x: number; y: number } {
  switch (pos) {
    case Position.Left:   return { x: -1, y: 0 }
    case Position.Right:  return { x:  1, y: 0 }
    case Position.Top:    return { x:  0, y: -1 }
    case Position.Bottom: return { x:  0, y: 1 }
  }
}

function extendPathToNodeEdges(
  bezierPath: string,
  sourceX: number, sourceY: number, sourcePosition: Position,
  targetX: number, targetY: number, targetPosition: Position,
): string {
  const sd = outwardDelta(sourcePosition)
  const td = outwardDelta(targetPosition)
  const sourceEdgeX = sourceX - sd.x * HANDLE_INSET
  const sourceEdgeY = sourceY - sd.y * HANDLE_INSET
  const targetEdgeX = targetX - td.x * HANDLE_INSET
  const targetEdgeY = targetY - td.y * HANDLE_INSET
  const cIdx = bezierPath.indexOf('C')
  if (cIdx < 0) return bezierPath
  const curve = bezierPath.slice(cIdx)
  return `M ${sourceEdgeX},${sourceEdgeY} L ${sourceX},${sourceY} ${curve} L ${targetEdgeX},${targetEdgeY}`
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

  const [bezierPath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const edgePath = extendPathToNodeEdges(
    bezierPath,
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  )
  const edgeData = normalizeEdgeData(data)
  const direction = edgeData.direction ?? 'source-to-target'
  const label = edgeData.label ?? ''
  const color = selected ? '#8b8bff' : '#4b5563'
  const markerStart = direction === 'bidirectional' ? `url(#${edgeMarkerId(id, 'start')})` : undefined
  const markerEnd = direction === 'source-to-target' || direction === 'bidirectional'
    ? `url(#${edgeMarkerId(id, 'end')})`
    : undefined
  const sourceNode = getNode(props.source)
  const targetNode = getNode(props.target)
  const editable = sourceNode?.type === 'component' && targetNode?.type === 'component'

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
          id={edgeMarkerId(id, 'end')}
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
        <marker
          id={edgeMarkerId(id, 'start')}
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
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={{ ...style, stroke: color, strokeWidth: selected ? 2 : 1.5 }}
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

      <EdgeLabelRenderer>
        <button
          type="button"
          className={`nodrag nopan absolute -translate-x-1/2 -translate-y-1/2 rounded border px-2 py-0.5 text-[10px] font-medium shadow-lg transition-colors ${
            label
              ? 'border-white/10 bg-[#1e1e1e] text-fg'
              : selected && editable
                ? 'border-white/10 bg-[#1e1e1e]/80 text-fg-subtle'
                : 'pointer-events-none opacity-0'
          }`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onDoubleClick={event => {
            event.stopPropagation()
            if (editable) setEditorOpen(true)
          }}
          title={editable ? 'Double-click to edit edge' : undefined}
        >
          {label || DIRECTION_LABELS[direction]}
        </button>
      </EdgeLabelRenderer>

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
  const [direction, setDirection] = useState<ComponentEdgeDirection>(data.direction ?? 'source-to-target')

  const save = () => {
    onChange({ label, direction })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="w-[360px] rounded-lg border border-white/10 bg-[#171717] p-4 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Component Edge</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-fg-subtle hover:bg-white/10 hover:text-fg"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        <label className="mb-4 block">
          <span className="mb-1.5 block text-xs font-medium text-fg-muted">Label</span>
          <input
            value={label}
            onChange={event => setLabel(event.target.value)}
            placeholder="e.g. publishes events"
            className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
          />
        </label>

        <div className="mb-5">
          <span className="mb-1.5 block text-xs font-medium text-fg-muted">Direction</span>
          <div className="grid grid-cols-3 gap-1 rounded bg-black/30 p-1">
            {(Object.keys(DIRECTION_LABELS) as ComponentEdgeDirection[]).map(value => (
              <button
                key={value}
                type="button"
                onClick={() => setDirection(value)}
                className={`rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                  direction === value
                    ? 'bg-accent text-fg'
                    : 'text-fg-muted hover:bg-white/10 hover:text-fg'
                }`}
              >
                {DIRECTION_LABELS[value]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1.5 rounded px-2.5 py-2 text-xs font-medium text-red-300 hover:bg-red-500/15"
          >
            <Trash2 size={13} />
            Delete
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLabel('')}
              className="rounded px-3 py-2 text-xs font-medium text-fg-muted hover:bg-white/10 hover:text-fg"
            >
              Clear Label
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded bg-accent px-3 py-2 text-xs font-semibold text-fg hover:bg-[#4a4ad0]"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(ComponentEdge)
