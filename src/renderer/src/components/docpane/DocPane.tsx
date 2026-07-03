import { useEffect, useState } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'

const EXPANDED_KEY = 'architect:docpane-expanded'

interface DocPaneProps {
  title: string
  kindLabel: string
  onClose: () => void
  children: React.ReactNode
  // Optional controls rendered in the header, left of the close button — e.g.
  // the markdown edit/preview toggle, so the pane reads like an Obsidian note
  // view header.
  headerActions?: React.ReactNode
}

/**
 * Obsidian-style slide-in right-hand pane. Non-modal on purpose — the canvas
 * stays visible to the left and a soft hairline separates pane from canvas.
 * Esc closes; the corner × is the explicit close. Width is generous on
 * wide displays but never crowds the canvas.
 *
 * The header's expand toggle switches to a full-page note view: the pane
 * covers the window and the note settles into a centered readable column,
 * like Obsidian's reading/editing view. The choice persists per machine.
 */
export default function DocPane({
  title,
  kindLabel,
  onClose,
  children,
  headerActions,
}: DocPaneProps) {
  const [entered, setEntered] = useState(false)
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(EXPANDED_KEY) === '1' } catch { return false }
  })

  const toggleExpanded = () => {
    setExpanded(prev => {
      const next = !prev
      try { localStorage.setItem(EXPANDED_KEY, next ? '1' : '0') } catch {}
      return next
    })
  }

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const target = event.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return
        }
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  // In full-page mode the note settles into a centered readable column;
  // Obsidian's line length is the reference (~700–820px).
  const column = expanded ? 'mx-auto w-full max-w-[820px]' : ''

  return (
    // pointer-events: none on the outer shell lets the canvas underneath stay
    // interactive (selecting nodes, panning, zooming) while the pane is open.
    // The pane itself re-enables pointer events.
    <div className="pointer-events-none fixed inset-y-0 right-0 z-[120] flex w-full justify-end">
      <aside
        className={`pointer-events-auto flex h-full flex-col border-l border-node-border bg-panel shadow-[-20px_0_50px_-20px_rgba(0,0,0,0.55)] transition-[transform,width] duration-200 ease-out ${
          expanded ? 'w-full' : 'w-[min(820px,calc(100vw-260px))]'
        } ${entered ? 'translate-x-0' : 'translate-x-full'}`}
        role="dialog"
        aria-label={`${kindLabel}: ${title}`}
      >
        <header className="border-b border-node-border px-7 pt-5 pb-4">
          <div className={`flex items-center justify-between gap-4 ${column}`}>
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-fg-subtle">
                {kindLabel}
              </p>
              <h2
                className="mt-1 truncate text-[19px] font-medium leading-tight tracking-[-0.01em] text-fg"
                title={title}
              >
                {title}
              </h2>
            </div>
            <div className="flex flex-shrink-0 items-center gap-1">
              {headerActions}
              <button
                type="button"
                onClick={toggleExpanded}
                className="flex h-7 w-7 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg"
                aria-label={expanded ? 'Collapse to side pane' : 'Expand to full page'}
                title={expanded ? 'Collapse to side pane' : 'Expand to full page'}
              >
                {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex h-7 w-7 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg"
                aria-label="Close"
                title="Close (Esc)"
              >
                <X size={15} />
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-7">
          <div className={`text-[13px] leading-6 text-fg-muted ${column}`}>
            {children}
          </div>
        </div>
      </aside>
    </div>
  )
}
