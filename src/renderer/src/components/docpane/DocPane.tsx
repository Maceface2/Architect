import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

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
 */
export default function DocPane({
  title,
  kindLabel,
  onClose,
  children,
  headerActions,
}: DocPaneProps) {
  const [entered, setEntered] = useState(false)

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

  return (
    // pointer-events: none on the outer shell lets the canvas underneath stay
    // interactive (selecting nodes, panning, zooming) while the pane is open.
    // The pane itself re-enables pointer events.
    <div className="pointer-events-none fixed inset-y-0 right-0 z-[120] flex">
      <aside
        className={`pointer-events-auto flex h-full w-[min(820px,calc(100vw-260px))] flex-col border-l border-node-border bg-panel shadow-[-20px_0_50px_-20px_rgba(0,0,0,0.55)] transition-transform duration-200 ease-out ${
          entered ? 'translate-x-0' : 'translate-x-full'
        }`}
        role="dialog"
        aria-label={`${kindLabel}: ${title}`}
      >
        <header className="flex items-center justify-between gap-4 border-b border-node-border px-7 pt-5 pb-4">
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
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg"
              aria-label="Close"
              title="Close (Esc)"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-7">
          <div className="text-[13px] leading-6 text-fg-muted">
            {children}
          </div>
        </div>
      </aside>
    </div>
  )
}
