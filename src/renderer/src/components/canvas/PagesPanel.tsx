import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useWorkspace } from '../../context/WorkspaceContext'
import PagePreview, { invalidatePagePreview } from './PagePreview'
import PageTabs from './PageTabs'

const HOVER_DWELL_MS = 180

interface Props {
  onSwitch: () => void
}

export default function PagesPanel({ onSwitch }: Props) {
  const { pages, activePageId, ready, setActivePageId } = useWorkspace()
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewTop, setPreviewTop] = useState<number>(0)
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
  }, [])

  useEffect(() => {
    if (activePageId) invalidatePagePreview(activePageId)
  }, [activePageId, pages])

  const activePageName = useMemo(
    () => pages.find(page => page.id === activePageId)?.name ?? 'preview',
    [activePageId, pages],
  )

  if (!ready) return null

  const onRowEnter = (id: string, e: ReactMouseEvent<HTMLButtonElement>) => {
    setHoveredId(id)
    const rowRect = e.currentTarget.getBoundingClientRect()
    const listRect = listRef.current?.getBoundingClientRect()
    const top = listRect ? rowRect.top - listRect.top : rowRect.top
    setPreviewTop(top)
    if (dwellRef.current) clearTimeout(dwellRef.current)
    dwellRef.current = setTimeout(() => setPreviewId(id), HOVER_DWELL_MS)
  }

  const onRowLeave = () => {
    if (dwellRef.current) {
      clearTimeout(dwellRef.current)
      dwellRef.current = null
    }
    setHoveredId(null)
    setPreviewId(null)
  }

  return (
    <div className="absolute inset-0 flex bg-canvas">
      <div className="flex w-80 flex-col border-r border-node-border bg-panel">
        <div className="border-b border-node-border px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-fg-subtle">
            Pages
          </div>
        </div>

        <PageTabs onSwitch={onSwitch} />

        <div ref={listRef} className="flex-1 overflow-y-auto p-2">
          {pages.map(page => {
            const isActive = page.id === activePageId
            const isHovered = hoveredId === page.id

            return (
              <button
                key={page.id}
                onMouseEnter={e => onRowEnter(page.id, e)}
                onMouseLeave={onRowLeave}
                onClick={() => {
                  void setActivePageId(page.id)
                  onSwitch()
                }}
                className={`mb-1 flex w-full items-center justify-between rounded border px-3 py-2 text-left text-xs transition-colors ${
                  isActive
                    ? 'border-node-border bg-node text-fg'
                    : isHovered
                      ? 'border-node-border bg-white/[0.04] text-fg'
                      : 'border-transparent text-fg-muted hover:bg-white/[0.02] hover:text-fg'
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{page.name}</div>
                  <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
                    {isActive ? 'active' : 'page'}
                  </div>
                </div>
                <div className="ml-2 rounded border border-node-border bg-panel px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-fg-subtle">
                  open
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden bg-canvas">
        {previewId ? (
          <div
            className="absolute pointer-events-none overflow-hidden rounded-lg border border-node-border bg-node shadow-xl"
            style={{
              left: 16,
              top: Math.max(16, previewTop),
              width: 'min(560px, calc(100% - 32px))',
              height: 360,
            }}
          >
            <div className="border-b border-node-border px-3 py-2 text-[10px] uppercase tracking-wider text-fg-subtle">
              {pages.find(p => p.id === previewId)?.name ?? activePageName}
            </div>
            <div className="absolute inset-0 top-[29px]">
              <PagePreview pageId={previewId} />
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-fg-subtle">
            hover a page to preview
          </div>
        )}
      </div>
    </div>
  )
}
