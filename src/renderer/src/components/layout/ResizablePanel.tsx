import { useState, useCallback } from 'react'
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'

type Side = 'left' | 'right' | 'top' | 'bottom'

interface ResizablePanelProps {
  side: Side
  defaultSize: number
  minSize?: number
  maxSize?: number
  children: React.ReactNode
}

export default function ResizablePanel({
  side,
  defaultSize,
  minSize = 120,
  maxSize = 720,
  children,
}: ResizablePanelProps) {
  const [size, setSize] = useState(defaultSize)
  const [collapsed, setCollapsed] = useState(false)
  const horizontal = side === 'left' || side === 'right'
  const leading = side === 'left' || side === 'top'

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (collapsed) return
      e.preventDefault()
      const startCoord = horizontal ? e.clientX : e.clientY
      const startSize = size

      const onMove = (ev: MouseEvent) => {
        const current = horizontal ? ev.clientX : ev.clientY
        const delta = leading ? current - startCoord : startCoord - current
        setSize(Math.max(minSize, Math.min(maxSize, startSize + delta)))
      }
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [collapsed, size, horizontal, leading, minSize, maxSize]
  )

  const CollapseIcon = (() => {
    if (horizontal) {
      return collapsed
        ? leading ? ChevronRight : ChevronLeft
        : leading ? ChevronLeft  : ChevronRight
    }
    return collapsed
      ? leading ? ChevronDown : ChevronUp
      : leading ? ChevronUp   : ChevronDown
  })()

  const handle = (
    <div
      className={`relative flex-shrink-0 flex items-center justify-center group select-none ${
        horizontal ? 'w-2' : 'h-2'
      } ${
        collapsed
          ? 'cursor-default'
          : horizontal ? 'cursor-col-resize' : 'cursor-row-resize'
      }`}
      onMouseDown={onDragStart}
    >
      {/* Divider line */}
      <div
        className={
          horizontal
            ? 'absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-node-border group-hover:bg-[#5b5bf0]/50 transition-colors'
            : 'absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-node-border group-hover:bg-[#5b5bf0]/50 transition-colors'
        }
      />

      {/* Collapse toggle — visible on hover */}
      <button
        className={`relative z-10 flex items-center justify-center rounded-sm bg-panel border border-node-border text-slate-500 hover:text-white hover:border-[#5b5bf0] transition-all opacity-0 group-hover:opacity-100 flex-shrink-0 ${
          horizontal ? 'w-[18px] h-6' : 'h-[18px] w-6'
        }`}
        onMouseDown={e => e.stopPropagation()}
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        <CollapseIcon size={9} />
      </button>
    </div>
  );

  const content = (
    <div
      className="flex-shrink-0 overflow-hidden"
      style={horizontal ? { width: collapsed ? 0 : size } : { height: collapsed ? 0 : size }}
    >
      {children}
    </div>
  );

  return leading ? (
    <>{content}{handle}</>
  ) : (
    <>
      {handle}
      {content}
    </>
  );
}
