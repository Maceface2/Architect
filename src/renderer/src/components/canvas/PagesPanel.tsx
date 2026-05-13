import { useEffect, useRef, useState } from 'react'
import { Plus, X, Pencil, Check, FileStack } from 'lucide-react'
import { useWorkspace } from '../../context/WorkspaceContext'
import PagePreview, { invalidatePagePreview } from './PagePreview'

const HOVER_DWELL_MS = 180

interface Props {
  onSwitch: () => void
}

export default function PagesPanel({ onSwitch }: Props) {
  const {
    pages,
    activePageId,
    setActivePageId,
    createPage,
    renamePage,
    deletePage,
    ready,
  } = useWorkspace()

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewTop, setPreviewTop] = useState<number>(0)
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
  }, [])

  // The currently-active page may have been edited since its cached preview
  // was built. Invalidate it on every render so its hover preview reloads
  // from disk and reflects the latest saved state.
  useEffect(() => {
    if (activePageId) invalidatePagePreview(activePageId)
  }, [activePageId, pages])

  if (!ready) return null

  const startRename = (id: string, current: string) => {
    setRenamingId(id)
    setRenameDraft(current)
  }
  const commitRename = async () => {
    if (renamingId && renameDraft.trim()) await renamePage(renamingId, renameDraft.trim())
    setRenamingId(null)
    setRenameDraft('')
  }
  const startCreate = () => {
    setCreating(true)
    setCreateDraft('Untitled')
  }
  const commitCreate = async () => {
    const name = createDraft.trim() || 'Untitled'
    setCreating(false)
    setCreateDraft('')
    await createPage(name)
  }
  const cancelCreate = () => {
    setCreating(false)
    setCreateDraft('')
  }
  const confirmDelete = async (id: string) => {
    setConfirmingDeleteId(null)
    await deletePage(id)
  }

  const onRowEnter = (id: string, e: React.MouseEvent<HTMLDivElement>) => {
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

  const onRowClick = async (id: string) => {
    if (id !== activePageId) await setActivePageId(id)
    onSwitch()
  }

  return (
    <div className="absolute inset-0 flex bg-canvas">
      <div className="flex flex-col w-72 border-r border-node-border bg-panel">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-node-border">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-fg-subtle font-mono">
            Pages
          </div>
          {creating ? null : (
            <button
              onClick={startCreate}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] border border-white/[0.06] text-[10px] text-fg-muted hover:bg-white/[0.05] hover:text-fg"
              title="New page"
            >
              <Plus size={10} />
              <span>new</span>
            </button>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1 relative">
          {creating && (
            <div className="flex items-center gap-2 mx-2 my-1 px-2 py-1.5 rounded-[3px] border border-accent/40 bg-accent/10">
              <FileStack size={12} className="text-accent flex-shrink-0" />
              <input
                autoFocus
                value={createDraft}
                onChange={e => setCreateDraft(e.target.value)}
                onBlur={() => void commitCreate()}
                onKeyDown={e => {
                  if (e.key === 'Enter') void commitCreate()
                  else if (e.key === 'Escape') cancelCreate()
                }}
                placeholder="New page name"
                className="flex-1 bg-transparent outline-none border-b border-white/20 text-xs text-fg placeholder:text-fg-subtle"
              />
            </div>
          )}

          {pages.map(page => {
            const isActive = page.id === activePageId
            const isRenaming = renamingId === page.id
            const isConfirmingDelete = confirmingDeleteId === page.id
            const isHovered = hoveredId === page.id
            return (
              <div
                key={page.id}
                onMouseEnter={e => onRowEnter(page.id, e)}
                onMouseLeave={onRowLeave}
                className={`group flex items-center gap-2 mx-2 my-0.5 px-2 py-1.5 rounded-[3px] border cursor-pointer transition-colors ${
                  isActive
                    ? 'border-accent/60 bg-accent/15 text-fg'
                    : isHovered
                      ? 'border-white/[0.10] bg-white/[0.04] text-fg'
                      : 'border-transparent text-fg-muted hover:text-fg'
                }`}
              >
                <FileStack
                  size={12}
                  className={`flex-shrink-0 ${isActive ? 'text-accent' : 'text-fg-subtle'}`}
                />
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void commitRename()
                      else if (e.key === 'Escape') {
                        setRenamingId(null)
                        setRenameDraft('')
                      }
                    }}
                    onClick={e => e.stopPropagation()}
                    className="flex-1 bg-transparent outline-none border-b border-white/20 text-xs"
                  />
                ) : (
                  <button
                    onClick={() => void onRowClick(page.id)}
                    onDoubleClick={e => {
                      e.stopPropagation()
                      startRename(page.id, page.name)
                    }}
                    title="Click to switch, double-click to rename"
                    className="flex-1 text-left text-xs truncate"
                  >
                    {page.name}
                  </button>
                )}
                {isActive && (
                  <span className="text-[9px] uppercase tracking-wider text-fg-subtle font-mono">
                    active
                  </span>
                )}
                <button
                  onClick={e => {
                    e.stopPropagation()
                    startRename(page.id, page.name)
                  }}
                  className="opacity-0 group-hover:opacity-60 hover:opacity-100 w-4 h-4 inline-flex items-center justify-center"
                  title="Rename"
                >
                  <Pencil size={10} />
                </button>
                {isConfirmingDelete ? (
                  <>
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        void confirmDelete(page.id)
                      }}
                      className="w-4 h-4 inline-flex items-center justify-center text-red-300 hover:text-red-200"
                      title="Confirm delete"
                    >
                      <Check size={10} />
                    </button>
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        setConfirmingDeleteId(null)
                      }}
                      className="w-4 h-4 inline-flex items-center justify-center text-fg-muted hover:text-fg"
                      title="Cancel"
                    >
                      <X size={10} />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      setConfirmingDeleteId(page.id)
                    }}
                    className="opacity-0 group-hover:opacity-60 hover:opacity-100 w-4 h-4 inline-flex items-center justify-center"
                    title="Delete page"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {previewId ? (
          <div
            className="absolute pointer-events-none border border-white/10 rounded-md bg-[#171717] shadow-xl overflow-hidden"
            style={{
              left: 16,
              top: Math.max(16, previewTop),
              width: 'min(560px, calc(100% - 32px))',
              height: 360,
            }}
          >
            <div className="px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-fg-subtle font-mono">
              {pages.find(p => p.id === previewId)?.name ?? 'preview'}
            </div>
            <div className="absolute inset-0 top-[29px]">
              <PagePreview pageId={previewId} />
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-fg-subtle font-mono">
            hover a page to preview
          </div>
        )}
      </div>
    </div>
  )
}
