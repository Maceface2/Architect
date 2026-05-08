import { memo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { FileText, Trash2 } from 'lucide-react'
import { getIcon } from '../../lib/icons'
import { fieldTypeColor } from '../../lib/fieldTypes'
import { useInterfaceSettings } from '../../context/InterfaceSettingsContext'
import ComponentConfigModal from './ComponentConfigModal'
import type { ComponentField, ComponentNodeData } from '../../types'

type ComponentNodeProps = NodeProps<Node<ComponentNodeData>>

function ComponentNode({ id, data, selected }: ComponentNodeProps) {
  const { setNodes, deleteElements } = useReactFlow()
  const { theme } = useInterfaceSettings()
  const isLight = theme === 'light'
  const [modalOpen, setModalOpen] = useState(false)

  const color = data.color
  const tag = data.tag
  const label = data.label
  const description = data.description
  const specs = data.specs ?? ''
  const iconName = data.iconName
  const Icon = getIcon(iconName)
  const hasSpecs = specs.trim().length > 0
  const fields = (data.fields ?? []) as ComponentField[]
  const hasFields = fields.length > 0

  const patch = (partial: Partial<ComponentNodeData>) =>
    setNodes(nodes =>
      nodes.map(node =>
        node.id === id ? { ...node, data: { ...(node.data as ComponentNodeData), ...partial } } : node
      )
    )

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

      {/* UML class card. Neutral hairline border (no zone-color outline);
          zone identity is carried by the icon and tag inside the header.
          Body renders typed `name : type` rows from data.fields, with the
          type colored by category via fieldTypeColor (string=green,
          int=blue, enum=pink, ...). Selection ring uses accent blue so it
          reads as a system signal, not as zone overlap. */}
      <div
        className="relative bg-component overflow-hidden min-w-[220px] max-w-[280px] select-none cursor-pointer transition-colors rounded-[3px]"
        style={{
          border: '1px solid rgba(255, 255, 255, 0.06)',
          boxShadow: selected
            ? '0 0 0 1px rgba(88, 166, 255, 0.55), 0 0 24px rgba(88, 166, 255, 0.18)'
            : '0 6px 14px -8px rgba(0, 0, 0, 0.55)',
        }}
        onDoubleClick={(e) => { e.stopPropagation(); setModalOpen(true) }}
      >
        {/* Header band: darker than body (UML inverse-elevation). The
            stereotype tag renders in italic muted mono («entity» style),
            neutral rather than zone-colored; the icon also stays neutral.
            Zone identity now lives in spatial containment, not on the card
            chrome. */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-canvas border-b border-white/[0.06]">
          <div className="flex items-center gap-2 min-w-0">
            <Icon size={13} strokeWidth={1.7} className="text-fg-muted flex-shrink-0" />
            <span className="text-[13px] font-semibold text-fg truncate">{label}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {tag && (
              <span className="text-[11px] italic text-fg-subtle">
                «{tag.toLowerCase()}»
              </span>
            )}
            {hasSpecs && (
              <span
                className="w-1 h-1 rounded-full flex-shrink-0 bg-fg-subtle"
                aria-label="Has specs"
                title="Has specs"
              />
            )}
            <span className="w-px h-3 bg-white/[0.08] mx-0.5" aria-hidden />
            <button
              onClick={(e) => { e.stopPropagation(); setModalOpen(true) }}
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
              onClick={(e) => { e.stopPropagation(); deleteElements({ nodes: [{ id }] }) }}
              onMouseDown={(e) => e.stopPropagation()}
              className="w-4 h-4 flex items-center justify-center rounded-[2px] text-fg-subtle hover:text-red-300 hover:bg-red-500/15 transition-colors nodrag"
              title="Delete component"
              aria-label="Delete component"
            >
              <Trash2 size={10} strokeWidth={1.7} />
            </button>
          </div>
        </div>

        {/* Body. Render order: typed fields > description prose >
            placeholder. Each block is independent so a component with both
            fields and a description shows both. */}
        <div className="px-3 py-2 space-y-1">
          {hasFields && (
            <div className="space-y-0.5">
              {fields.map(field => (
                <div
                  key={field.id}
                  className="flex items-baseline justify-between gap-3 text-[12px] leading-relaxed"
                >
                  <span className="text-fg truncate">
                    {field.key || <span className="text-fg-subtle italic">unkeyed</span>}
                  </span>
                  <span
                    className="flex-shrink-0 truncate text-right max-w-[60%]"
                    style={{ color: fieldTypeColor(field.value) }}
                  >
                    {field.value || '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {description && (
            <p className={`text-[11px] text-fg-muted leading-relaxed line-clamp-3 ${hasFields ? 'pt-1.5 mt-1.5 border-t border-white/[0.05]' : ''}`}>
              {description}
            </p>
          )}
          {!hasFields && !description && (
            <p className="text-[10px] text-fg-subtle italic py-0.5">
              undocumented
            </p>
          )}
        </div>
      </div>

      {modalOpen && createPortal(
        <ComponentConfigModal
          label={label}
          tag={tag}
          color={color}
          iconName={iconName}
          description={description}
          specs={specs}
          fields={fields}
          patch={patch}
          onClose={() => setModalOpen(false)}
        />,
        document.body
      )}
    </div>
  )
}

export default memo(ComponentNode)
