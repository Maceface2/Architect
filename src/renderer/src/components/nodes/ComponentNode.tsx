import { memo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { FileText, Trash2 } from 'lucide-react'
import { getIcon } from '../../lib/icons'
import ComponentConfigModal from './ComponentConfigModal'
import type { ComponentNodeData } from '../../types'

type ComponentNodeProps = NodeProps<Node<ComponentNodeData>>

function ComponentNode({ id, data }: ComponentNodeProps) {
  const { setNodes, deleteElements } = useReactFlow()
  const [modalOpen, setModalOpen] = useState(false)
  const [hovered, setHovered] = useState(false)

  const color = data.color
  const tag = data.tag
  const label = data.label
  const description = data.description
  const specs = data.specs ?? ''
  const category = data.category
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
    background: '#1e1e1e',
    border: `2px solid ${color}`,
    zIndex: 10,
    opacity: hovered ? 1 : 0,
    transition: 'opacity 150ms ease',
  } as const

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ ...handleBaseStyle, left: -5 }}
      />

      <div
        className="relative bg-[#1e1e1e] rounded-lg overflow-hidden min-w-[160px] max-w-[200px] border border-white/[0.06] shadow-xl select-none cursor-pointer hover:border-white/20 transition-colors"
        onDoubleClick={(e) => { e.stopPropagation(); setModalOpen(true) }}
      >
        <div className="absolute left-0 top-0 bottom-0 w-[4px]" style={{ backgroundColor: color }} />
        <div className="pl-[14px] pr-3 pt-2.5 pb-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <Icon size={11} style={{ color }} />
            <span className="text-[10px] font-bold tracking-widest" style={{ color }}>{tag}</span>
            {hasSpecs && (
              <FileText size={9} className="text-slate-500 ml-auto" aria-label="Has specs" />
            )}
          </div>
          <p className="text-[13px] font-semibold text-white leading-snug">{label}</p>
          {description && (
            <p className="text-[10px] text-slate-500 mt-1 line-clamp-2">{description}</p>
          )}
        </div>

        {/* Edit + delete buttons — absolute, pointer-events: auto */}
        <div className="absolute top-1 right-1 flex items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); setModalOpen(true) }}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-5 h-5 flex items-center justify-center rounded text-slate-600 hover:text-white hover:bg-white/10 transition-colors nodrag"
            title="Edit component"
            aria-label="Edit component"
          >
            <FileText size={11} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); deleteElements({ nodes: [{ id }] }) }}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-5 h-5 flex items-center justify-center rounded text-slate-600 hover:text-red-300 hover:bg-red-500/15 transition-colors nodrag"
            title="Delete component"
            aria-label="Delete component"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{ ...handleBaseStyle, right: -5 }}
      />

      {modalOpen && createPortal(
        <ComponentConfigModal
          label={label}
          tag={tag}
          color={color}
          iconName={iconName}
          description={description}
          specs={specs}
          category={category}
          patch={patch}
          onClose={() => setModalOpen(false)}
        />,
        document.body
      )}
    </div>
  )
}

export default memo(ComponentNode)
