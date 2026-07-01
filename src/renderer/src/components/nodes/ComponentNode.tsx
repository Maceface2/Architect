import { memo } from 'react'
import { Handle, Position, useConnection, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { FileText, Trash2 } from 'lucide-react'
import { useInterfaceSettings } from '../../context/InterfaceSettingsContext'
import { useDocPane } from '../../context/DocPaneContext'
import type { ComponentNodeData } from '../../types'

type ComponentNodeProps = NodeProps<Node<ComponentNodeData>>

function ComponentNode({ id, data, selected }: ComponentNodeProps) {
  const { deleteElements } = useReactFlow()
  const { openComponent, close: closeDocPane } = useDocPane()
  const { theme } = useInterfaceSettings()
  const isLight = theme === 'light'

  const color = data.color
  const label = data.label
  const description = data.description
  const specs = data.specs ?? ''
  // The card previews the markdown note: the first few content lines of
  // `specs` (markdown tokens stripped), falling back to the legacy one-line
  // description so older canvases still read well.
  const cardPreview = deriveCardPreview(specs, description, label)

  // Portless connections: while a drag-connect is in progress the whole card
  // becomes the drop target; at rest the target handle is inert so it never
  // steals node drag/click/double-click.
  const connection = useConnection()
  const isConnecting = connection.inProgress
  const isConnectionTarget = isConnecting && connection.fromNode?.id !== id

  return (
    <div className="group relative architect-component-node">
      {/* Invisible full-card target handle. Always in the DOM so React Flow
          can resolve edges whose targetHandle is null; only interactive
          while a connection drag is live. */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectableStart={false}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          transform: 'none',
          borderRadius: 0,
          border: 'none',
          opacity: 0,
          background: 'transparent',
          pointerEvents: isConnecting ? 'all' : 'none',
          zIndex: 5,
        }}
      />

      {/* Natural-language card: title + a few lines of the note + a thin
          accent band. Selection ring stays accent blue (system signal);
          while a connection hovers, the ring switches to the card color so
          the drop target reads clearly. */}
      <div
        className="relative bg-component overflow-hidden select-none cursor-pointer transition-colors rounded-md min-w-[210px] max-w-[300px]"
        style={{
          border: '1px solid rgba(255, 255, 255, 0.06)',
          boxShadow: isConnectionTarget
            ? `0 0 0 1px ${color}, 0 0 20px ${color}33`
            : selected
              ? '0 0 0 1px rgba(88, 166, 255, 0.55), 0 0 24px rgba(88, 166, 255, 0.18)'
              : '0 6px 14px -8px rgba(0, 0, 0, 0.55)',
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          openComponent(id)
        }}
      >
        <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
          <span className="font-semibold text-fg truncate text-[14px]">
            {label}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation()
                openComponent(id)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`w-4 h-4 flex items-center justify-center rounded-[2px] text-fg-subtle hover:text-fg transition-colors nodrag ${
                isLight ? 'hover:bg-slate-200/70' : 'hover:bg-white/10'
              }`}
              title="Open note"
              aria-label="Open note"
            >
              <FileText size={10} strokeWidth={1.7} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeDocPane()
                deleteElements({ nodes: [{ id }] })
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="w-4 h-4 flex items-center justify-center rounded-[2px] text-fg-subtle hover:text-red-300 hover:bg-red-500/15 transition-colors nodrag"
              title="Delete card"
              aria-label="Delete card"
            >
              <Trash2 size={10} strokeWidth={1.7} />
            </button>
          </div>
        </div>

        {/* Body: a few lines of the card's note (markdown tokens stripped).
            Suppressed when the note is empty — the title reads as the card. */}
        {cardPreview && (
          <div className="px-3 pb-2">
            <p className="whitespace-pre-line text-[12px] text-fg-muted leading-relaxed line-clamp-3">
              {cardPreview}
            </p>
          </div>
        )}

        {/* Identity footer: thin accent band in the card's auto-assigned
            color. */}
        <div className="h-1 w-full" style={{ backgroundColor: color }} aria-hidden />
      </div>

      {/* Connect affordance: a grab dot on the right edge, visible on hover.
          Dragging it to another card creates an edge. */}
      <Handle
        type="source"
        position={Position.Right}
        className="clique-connect-dot nodrag"
        style={{
          width: 11,
          height: 11,
          right: -6,
          borderRadius: 9999,
          background: color,
          border: `2px solid ${isLight ? '#ffffff' : '#1e1e1e'}`,
          zIndex: 10,
        }}
      />
    </div>
  )
}

// Build the on-card preview from a card's markdown note. Strips heading
// hashes, list/blockquote markers, and inline-code backticks; skips a leading
// H1 that just repeats the card title; keeps the first 3 content lines.
// Falls back to the legacy one-line description when the note is empty.
function deriveCardPreview(specs: string, description: string, label: string): string {
  const out: string[] = []
  for (const raw of specs.split('\n')) {
    const text = raw
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '• ')
      .replace(/^\d+\.\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/`/g, '')
      .trim()
    if (!text) continue
    if (out.length === 0 && text.toLowerCase() === label.trim().toLowerCase()) continue
    out.push(text)
    if (out.length >= 3) break
  }
  return out.join('\n') || description.trim()
}

export default memo(ComponentNode)
