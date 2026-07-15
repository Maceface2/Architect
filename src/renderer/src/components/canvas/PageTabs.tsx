import { useEffect, useRef, useState } from 'react'
import { Check, Plus, X } from 'lucide-react'
import { useWorkspace } from '../../context/WorkspaceContext'

interface PageTabsProps {
  onSwitch: () => void
}

export default function PageTabs({ onSwitch }: PageTabsProps) {
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
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

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

  const onSelectPage = async (id: string) => {
    if (id !== activePageId) await setActivePageId(id)
    onSwitch()
  }

  return (
    <div className="flex items-end gap-1 overflow-x-auto border-b border-node-border bg-panel px-2 pt-2 scrollbar-hide">
      {pages.map(page => {
        const isActive = page.id === activePageId
        const isRenaming = renamingId === page.id
        const isConfirmingDelete = confirmingDeleteId === page.id

        return (
          <div
            key={page.id}
            className={`group relative -mb-px flex min-w-[144px] items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-2 text-xs transition-colors ${
              isActive
                ? 'border-node-border bg-canvas text-fg'
                : 'border-node-border bg-node text-fg-muted hover:text-fg'
            }`}
          >
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={event => setRenameDraft(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={event => {
                  if (event.key === 'Enter') void commitRename()
                  else if (event.key === 'Escape') {
                    setRenamingId(null)
                    setRenameDraft('')
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
              />
            ) : (
              <button
                onClick={() => void onSelectPage(page.id)}
                onDoubleClick={e => {
                  e.stopPropagation()
                  startRename(page.id, page.name)
                }}
                title="Click to switch, double-click to rename"
                className="min-w-0 flex-1 truncate text-left"
              >
                {page.name}
              </button>
            )}

            {isActive && (
              <span className="text-[9px] uppercase tracking-wider text-fg-subtle">
                active
              </span>
            )}

            {isConfirmingDelete ? (
              <>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    void confirmDelete(page.id)
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded text-red-300 transition-colors hover:bg-red-500/15"
                  title="Confirm delete"
                >
                  <Check size={10} />
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    setConfirmingDeleteId(null)
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded text-fg-muted transition-colors hover:bg-node hover:text-fg"
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
                className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle opacity-0 transition-colors group-hover:opacity-100 hover:bg-node hover:text-fg"
                title="Delete page"
              >
                <X size={10} />
              </button>
            )}
          </div>
        )
      })}

      {creating ? (
        <div className="relative -mb-px flex min-w-[160px] items-center gap-1.5 rounded-t-md border border-node-border border-b-0 bg-canvas px-3 py-2 text-xs text-fg">
          <input
            autoFocus
            value={createDraft}
            onChange={event => setCreateDraft(event.target.value)}
            onBlur={() => void commitCreate()}
            onKeyDown={event => {
              if (event.key === 'Enter') void commitCreate()
              else if (event.key === 'Escape') cancelCreate()
            }}
            placeholder="New page name"
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
          />
          <button
            onClick={() => void commitCreate()}
            className="flex h-4 w-4 items-center justify-center rounded text-fg-muted transition-colors hover:bg-node hover:text-fg"
            title="Create page"
          >
            <Check size={10} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setCreating(true)
            setCreateDraft('Untitled')
          }}
          className="relative -mb-px flex h-[34px] w-[34px] items-center justify-center rounded-t-md border border-node-border border-b-0 bg-node text-fg-subtle transition-colors hover:bg-canvas hover:text-fg"
          title="New page"
        >
          <Plus size={13} />
        </button>
      )}
    </div>
  )
}
