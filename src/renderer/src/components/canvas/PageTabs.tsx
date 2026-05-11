import { useState } from 'react'
import { Plus, X, Pencil, Check } from 'lucide-react'
import { useWorkspace } from '../../context/WorkspaceContext'

export default function PageTabs() {
  const { pages, activePageId, setActivePageId, createPage, renamePage, deletePage, ready } = useWorkspace()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

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

  return (
    <div
      className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 px-1.5 py-1 rounded-md border border-white/10 bg-[#171717]/90 backdrop-blur shadow-lg max-w-[80%] overflow-x-auto"
    >
      {pages.map(page => {
        const isActive = page.id === activePageId
        const isRenaming = renamingId === page.id
        const isConfirmingDelete = confirmingDeleteId === page.id
        return (
          <div
            key={page.id}
            className={`group flex items-center gap-1 h-6 pl-2 pr-1 rounded-[3px] border text-[11px] flex-shrink-0 ${
              isActive
                ? 'border-accent/60 bg-accent/15 text-fg'
                : 'border-white/[0.06] text-fg-muted hover:bg-white/[0.05] hover:text-fg'
            }`}
          >
            {isRenaming ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={e => setRenameDraft(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={e => {
                  if (e.key === 'Enter') void commitRename()
                  else if (e.key === 'Escape') { setRenamingId(null); setRenameDraft('') }
                }}
                className="bg-transparent outline-none border-b border-white/20 w-24 text-[11px]"
              />
            ) : (
              <button
                onClick={() => void setActivePageId(page.id)}
                onDoubleClick={() => startRename(page.id, page.name)}
                title="Click to switch, double-click to rename"
                className="truncate max-w-[160px]"
              >
                {page.name}
              </button>
            )}
            <button
              onClick={() => startRename(page.id, page.name)}
              className="opacity-0 group-hover:opacity-60 hover:opacity-100 w-4 h-4 inline-flex items-center justify-center"
              title="Rename"
            >
              <Pencil size={9} />
            </button>
            {isConfirmingDelete ? (
              <>
                <button
                  onClick={() => void confirmDelete(page.id)}
                  className="w-4 h-4 inline-flex items-center justify-center text-red-300 hover:text-red-200"
                  title="Confirm delete"
                >
                  <Check size={10} />
                </button>
                <button
                  onClick={() => setConfirmingDeleteId(null)}
                  className="w-4 h-4 inline-flex items-center justify-center text-fg-muted hover:text-fg"
                  title="Cancel"
                >
                  <X size={10} />
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmingDeleteId(page.id)}
                className="opacity-0 group-hover:opacity-60 hover:opacity-100 w-4 h-4 inline-flex items-center justify-center"
                title="Delete page"
              >
                <X size={10} />
              </button>
            )}
          </div>
        )
      })}
      {creating ? (
        <div className="flex items-center gap-1 h-6 pl-2 pr-1 rounded-[3px] border border-accent/40 bg-accent/10 text-[11px] flex-shrink-0">
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
            className="bg-transparent outline-none w-28 text-[11px] placeholder:text-fg-subtle"
          />
        </div>
      ) : (
        <button
          onClick={startCreate}
          className="flex items-center justify-center w-6 h-6 rounded-[3px] border border-white/[0.06] text-fg-muted hover:bg-white/[0.05] hover:text-fg flex-shrink-0"
          title="New page"
        >
          <Plus size={11} />
        </button>
      )}
    </div>
  )
}
