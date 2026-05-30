import { memo, type CSSProperties } from 'react'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { FileText, Trash2 } from 'lucide-react'
import { getIcon } from '../../lib/icons'
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
  const iconName = data.iconName
  const Icon = getIcon(iconName)
  // The card previews the component's markdown note: the first few content
  // lines of `specs` (markdown tokens stripped), falling back to the legacy
  // one-line description so older canvases still read well.
  const cardPreview = deriveCardPreview(specs, description, label)

  const handleBaseStyle = {
    width: 9,
    height: 9,
    // Match the card body so the handle reads as a subtle clip, not a dot.
    // Hardcoded dark used to bleed through in light mode — pull from the
    // same theme token the card uses.
    background: isLight ? '#ffffff' : '#2a2723',
    border: `2px solid ${color}`,
    zIndex: 10,
  } as const

  const handlePairs: Array<{ side: 'left' | 'right' | 'top' | 'bottom'; position: Position; style: CSSProperties }> = [
    { side: 'left', position: Position.Left, style: { left: -5 } },
    { side: 'right', position: Position.Right, style: { right: -5 } },
    { side: 'top', position: Position.Top, style: { top: -5 } },
    { side: 'bottom', position: Position.Bottom, style: { bottom: -5 } },
  ]

  return (
    <div className="relative architect-component-node">
      {handlePairs.flatMap(({ side, position, style }) => [
        <Handle
          key={`target-${side}`}
          id={`target-${side}`}
          type="target"
          position={position}
          className="architect-component-handle"
          style={{ ...handleBaseStyle, ...style }}
        />,
        <Handle
          key={`source-${side}`}
          id={`source-${side}`}
          type="source"
          position={position}
          className="architect-component-handle"
          style={{ ...handleBaseStyle, ...style }}
        />,
      ])}

      {/* Markdown note card. Neutral hairline border (no zone-color outline);
          zone identity is carried by the icon in the header and the color band
          at the foot. The body previews the component's markdown note.
          Selection ring uses accent blue so it reads as a system signal, not
          as zone overlap. */}
      <div
        className="relative bg-component overflow-hidden select-none cursor-pointer transition-colors rounded-md min-w-[210px] max-w-[300px]"
        style={{
          border: '1px solid rgba(255, 255, 255, 0.06)',
          boxShadow: selected
            ? '0 0 0 1px rgba(88, 166, 255, 0.55), 0 0 24px rgba(88, 166, 255, 0.18)'
            : '0 6px 14px -8px rgba(0, 0, 0, 0.55)',
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          openComponent(id)
        }}
      >
        {/* Header band: darker than body. Holds the (neutral) icon + name and
            the edit/delete actions. The bottom border is dropped when the note
            preview is empty, so the header reads as the whole card. */}
        <div className={`flex items-center justify-between gap-2 px-3 py-2 bg-canvas ${cardPreview ? 'border-b border-node-border' : ''}`}>
          <div className="flex items-center gap-2 min-w-0">
            <Icon
              size={14}
              strokeWidth={1.7}
              style={{ color }}
              className="flex-shrink-0"
            />
            <span className="font-semibold text-fg truncate text-[14px]">
              {label}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation()
                openComponent(id)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`w-4 h-4 flex items-center justify-center rounded-[2px] text-fg-subtle hover:text-fg transition-colors nodrag ${
                isLight ? 'hover:bg-slate-200/70' : 'hover:bg-white/10'
              }`}
              title="Edit component"
              aria-label="Edit component"
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
              title="Delete component"
              aria-label="Delete component"
            >
              <Trash2 size={10} strokeWidth={1.7} />
            </button>
          </div>
        </div>

        {/* Body: a few lines of the component's markdown note (markdown tokens
            stripped). Suppressed entirely when the note is empty — the header
            then reads as the whole card. */}
        {cardPreview && (
          <div className="px-3 py-2">
            <p className="whitespace-pre-line text-[12px] text-fg-muted leading-relaxed line-clamp-3">
              {cardPreview}
            </p>
          </div>
        )}

        {/* Identity footer: a thin solid band in the node's zone color
            anchored to the bottom of the card. Reintroduces the per-zone
            color signal we dropped from the border without re-creating a
            banned side-stripe. */}
        <div className="h-1 w-full" style={{ backgroundColor: color }} aria-hidden />
      </div>

    </div>
  )
}

// Build the on-card preview from a component's markdown note. Strips heading
// hashes, list/blockquote markers, and inline-code backticks; skips a leading
// H1 that just repeats the component name; keeps the first 3 content lines.
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
