import { memo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { FileText, Trash2 } from 'lucide-react'
import { getIcon } from '../../lib/icons'
import { useInterfaceSettings } from '../../context/InterfaceSettingsContext'
import ComponentConfigModal from './ComponentConfigModal'
import type { ComponentNodeData } from '../../types'

type ComponentNodeProps = NodeProps<Node<ComponentNodeData>>

function ComponentNode({ id, data }: ComponentNodeProps) {
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
    background: isLight ? '#ffffff' : '#1e1e1e',
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

      <div
        className={`relative bg-component rounded-lg overflow-hidden min-w-[160px] max-w-[200px] border shadow-xl select-none cursor-pointer transition-colors ${
          isLight
            ? 'border-slate-300 hover:border-slate-400'
            : 'border-white/[0.06] hover:border-white/20'
        }`}
        onDoubleClick={(e) => { e.stopPropagation(); setModalOpen(true) }}
      >
        <div className="absolute left-0 top-0 bottom-0 w-[4px]" style={{ backgroundColor: color }} />
        <div className="pl-[14px] pr-3 pt-2.5 pb-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <Icon size={11} style={{ color }} />
            <span className="text-[10px] font-bold tracking-widest" style={{ color }}>{tag}</span>
            {hasSpecs && (
              <FileText size={9} className="text-fg-subtle ml-auto" aria-label="Has specs" />
            )}
          </div>
          <p className="text-[13px] font-semibold text-fg leading-snug">{label}</p>
          {description && (
            <p className="text-[10px] text-fg-subtle mt-1 line-clamp-2">{description}</p>
          )}
        </div>

        {/* Edit + delete buttons — absolute, pointer-events: auto */}
        <div className="absolute top-1 right-1 flex items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); setModalOpen(true) }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`w-5 h-5 flex items-center justify-center rounded text-fg-subtle hover:text-fg transition-colors nodrag ${
              isLight ? 'hover:bg-slate-200' : 'hover:bg-white/10'
            }`}
            title="Edit component"
            aria-label="Edit component"
          >
            <FileText size={11} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); deleteElements({ nodes: [{ id }] }) }}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-5 h-5 flex items-center justify-center rounded text-fg-subtle hover:text-red-300 hover:bg-red-500/15 transition-colors nodrag"
            title="Delete component"
            aria-label="Delete component"
          >
            <Trash2 size={11} />
          </button>
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
          patch={patch}
          onClose={() => setModalOpen(false)}
        />,
        document.body
      )}
    </div>
  )
}

export default memo(ComponentNode)
