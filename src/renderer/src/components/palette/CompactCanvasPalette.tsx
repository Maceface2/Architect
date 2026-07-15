import { useEffect } from 'react'
import { MousePointer2, StickyNote, UserRound, X } from 'lucide-react'

export type CanvasPaletteTool = 'zone' | 'component'

interface CompactCanvasPaletteProps {
  activeTool: CanvasPaletteTool | null
  placementHint: string | null
  onCreateComponent: () => void
  onCreateZone: () => void
  onCancel: () => void
}

// Two-tool palette: cards (natural-language notes) and agents (regions that
// own cards). Selecting a tool arms click-to-place; the placed node opens
// straight into its editor. Connections aren't a tool — drag a card's edge
// dot onto another card.
export default function CompactCanvasPalette({
  activeTool,
  placementHint,
  onCreateComponent,
  onCreateZone,
  onCancel,
}: CompactCanvasPaletteProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="pointer-events-none absolute left-4 top-4 z-30 flex items-start gap-3">
      <div className="pointer-events-auto flex flex-col gap-1 rounded-lg border border-node-border bg-panel/95 p-1 shadow-2xl backdrop-blur">
        <ToolButton
          label="New card"
          active={activeTool === 'component'}
          icon={<StickyNote size={16} />}
          onClick={onCreateComponent}
        />
        <ToolButton
          label="New agent"
          active={activeTool === 'zone'}
          icon={<UserRound size={16} />}
          onClick={onCreateZone}
        />
        {activeTool && (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-9 w-9 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-white/10 hover:text-fg"
            aria-label="Cancel tool"
            title="Cancel"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {placementHint && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-node-border bg-panel/95 px-3 py-2 text-xs text-fg-muted shadow-2xl backdrop-blur">
          <MousePointer2 size={14} className="text-accent" />
          {placementHint}
        </div>
      )}
    </div>
  )
}

function ToolButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded transition-colors ${
        active ? 'bg-accent text-fg' : 'text-fg-muted hover:bg-white/10 hover:text-fg'
      }`}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  )
}
