import { useState, useEffect, useMemo } from 'react'
import { Folder, File, ArrowLeft, FolderOpen, FolderPlus, X, FilePlus, Check } from 'lucide-react'
import type { FileEntry } from '../../../../shared/electronTypes'
import { useWorkspace, type WorkspacePage } from '../../context/WorkspaceContext'

interface PendingLink {
  folderPath: string
  folderLabel: string
  pages: WorkspacePage[]
}

export default function FilesPanel() {
  const { loadedFolders, primaryFolder, activeFolder, setActiveFolderPath, removeFolder, pages, activePageId, activePage, refresh } =
    useWorkspace()
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null)
  const [creatingPageDraft, setCreatingPageDraft] = useState<string | null>(null)
  // Which host page the link will be added to. Defaults to the currently
  // active page each time the picker opens.
  const [hostPageChoice, setHostPageChoice] = useState<string>(activePageId)
  // pageId -> name for every linked folder's active link. Fetched lazily so
  // the directory rows can show "<folder> · <linked page name>" without
  // hardcoding the name onto the PageLink schema.
  const [linkedPageNameByFolder, setLinkedPageNameByFolder] = useState<Record<string, string>>({})

  // Per-folder navigation history. Drilling into a subfolder pushes onto
  // that folder's history; switching to another loaded folder restores its
  // own breadcrumb without bleeding the previous folder's path.
  const [pathByFolder, setPathByFolder] = useState<Record<string, string>>(() => ({
    [primaryFolder.path]: primaryFolder.path,
  }))
  const [historyByFolder, setHistoryByFolder] = useState<Record<string, string[]>>(() => ({}))
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  // Resolve the linked page name for each non-host folder once per change to
  // the active page's link set. One IPC call per linked folder; results are
  // cached locally and refreshed when the user switches active pages.
  useEffect(() => {
    let cancelled = false
    const links = activePage.links
    if (links.length === 0) {
      setLinkedPageNameByFolder({})
      return
    }
    void Promise.all(
      links.map(async link => {
        const res = await window.electron.workspace.listPagesInFolder(link.folderPath)
        const name = res.ok ? res.pages.find(p => p.id === link.pageId)?.name : undefined
        return { folderPath: link.folderPath, name: name ?? '' }
      }),
    ).then(results => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const r of results) if (r.name) next[r.folderPath] = r.name
      setLinkedPageNameByFolder(next)
    })
    return () => { cancelled = true }
  }, [activePage])

  // Seed pathByFolder for any folder we've never tracked yet (newly added).
  useEffect(() => {
    setPathByFolder(prev => {
      let changed = false
      const next = { ...prev }
      for (const folder of loadedFolders) {
        if (!(folder.path in next)) {
          next[folder.path] = folder.path
          changed = true
        }
      }
      // Drop entries for folders that are no longer loaded.
      for (const key of Object.keys(next)) {
        if (!loadedFolders.some(f => f.path === key)) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [loadedFolders])

  const currentPath = pathByFolder[activeFolder.path] ?? activeFolder.path
  const history = historyByFolder[activeFolder.path] ?? []

  useEffect(() => {
    if (!currentPath) return
    setLoading(true)
    let cancelled = false
    window.electron.readDir(currentPath).then(result => {
      if (cancelled) return
      setEntries(result)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [currentPath])

  const navigateTo = (dirPath: string) => {
    setHistoryByFolder(prev => ({
      ...prev,
      [activeFolder.path]: [...(prev[activeFolder.path] ?? []), currentPath],
    }))
    setPathByFolder(prev => ({ ...prev, [activeFolder.path]: dirPath }))
  }

  const navigateBack = () => {
    const prev = history[history.length - 1]
    if (prev === undefined) return
    setHistoryByFolder(p => ({
      ...p,
      [activeFolder.path]: (p[activeFolder.path] ?? []).slice(0, -1),
    }))
    setPathByFolder(p => ({ ...p, [activeFolder.path]: prev }))
  }

  const handleAddFolder = async () => {
    if (adding) return
    setAdding(true)
    try {
      const picked = await window.electron.openDirectory()
      if (!picked) return
      if (picked === primaryFolder.path) return
      if (loadedFolders.some(f => f.path === picked)) return
      // Fetch the folder's pages so the user can pick which one to link to
      // the active page (or create a fresh page in that folder).
      const res = await window.electron.workspace.listPagesInFolder(picked)
      const otherPages = res.ok ? res.pages : []
      const trimmed = picked.replace(/[\\/]+$/, '')
      const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      const label = idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed
      setHostPageChoice(activePageId)
      setPendingLink({ folderPath: picked, folderLabel: label, pages: otherPages })
    } finally {
      setAdding(false)
    }
  }

  const cancelPendingLink = () => {
    setPendingLink(null)
    setCreatingPageDraft(null)
  }

  const confirmLinkToExisting = async (otherPageId: string) => {
    if (!pendingLink) return
    const target = pendingLink.folderPath
    const hostPageId = hostPageChoice
    setPendingLink(null)
    setCreatingPageDraft(null)
    await window.electron.workspace.addLink(primaryFolder.path, hostPageId, target, otherPageId)
    await refresh()
  }

  const confirmLinkToNew = async () => {
    if (!pendingLink) return
    const name = (creatingPageDraft ?? '').trim() || 'Untitled'
    const target = pendingLink.folderPath
    const hostPageId = hostPageChoice
    setPendingLink(null)
    setCreatingPageDraft(null)
    const created = await window.electron.workspace.createPage(target, name)
    if (!created.ok) return
    await window.electron.workspace.addLink(primaryFolder.path, hostPageId, target, created.page.id)
    await refresh()
  }

  const handleRemoveFolder = async (path: string) => {
    await removeFolder(path)
  }

  const canGoBack = history.length > 0
  const folderName = useMemo(() => {
    const trimmed = currentPath.replace(/[\\/]+$/, '')
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed
  }, [currentPath])

  return (
    <div className="relative h-full flex flex-col bg-canvas">
      {/* Workspace folder list. Each row is one loaded folder; click to make
          it the active folder (file tree below switches to it). The "+ Add"
          row at the bottom appends to workspace.json on the primary anchor. */}
      <div className="flex flex-col bg-panel border-b border-node-border">
        <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-fg-subtle font-mono">
          Workspace
        </div>
        <div className="px-1.5 pb-1.5">
          {loadedFolders.map(folder => {
            const isActive = folder.path === activeFolder.path
            const pageName = folder.isPrimary
              ? activePage.name
              : linkedPageNameByFolder[folder.path]
            return (
              <div
                key={folder.path}
                className={`group flex items-start gap-1.5 rounded px-1.5 py-1 cursor-pointer transition-colors ${
                  isActive ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                }`}
                onClick={() => setActiveFolderPath(folder.path)}
              >
                <span
                  aria-hidden
                  className="flex-shrink-0 w-2 h-2 rounded-sm mt-1"
                  style={{ background: folder.color }}
                />
                <FolderOpen
                  size={12}
                  className={`flex-shrink-0 mt-0.5 ${isActive ? 'text-amber-400' : 'text-fg-subtle'}`}
                />
                <div className="flex-1 min-w-0">
                  <div
                    className={`truncate text-xs font-mono ${isActive ? 'text-fg' : 'text-fg-muted'}`}
                    title={folder.path}
                  >
                    {folder.label}
                    {folder.isPrimary && (
                      <span className="ml-1.5 text-[9px] uppercase tracking-wider text-fg-subtle">
                        primary
                      </span>
                    )}
                  </div>
                  {pageName && (
                    <div
                      className="truncate text-[10px] font-mono text-fg-subtle"
                      title={`Canvas page: ${pageName}`}
                    >
                      <span className="text-fg-subtle/60">/</span> {pageName}
                    </div>
                  )}
                </div>
                {!folder.isPrimary && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      void handleRemoveFolder(folder.path)
                    }}
                    className="p-0.5 rounded text-fg-subtle opacity-0 group-hover:opacity-100 hover:text-fg hover:bg-white/10 transition-colors mt-0.5"
                    title="Remove from workspace"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            )
          })}
          <button
            onClick={() => void handleAddFolder()}
            disabled={adding}
            className="flex items-center gap-1.5 w-full rounded px-1.5 py-1 text-xs text-fg-subtle hover:text-fg hover:bg-white/[0.03] transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <FolderPlus size={12} className="flex-shrink-0" />
            <span className="font-mono">{adding ? 'Adding…' : 'Add Folder'}</span>
          </button>
        </div>
      </div>

      {/* Tree navigation for the currently-active folder. Back button is
          per-folder so switching folders preserves your scroll position
          inside each one. */}
      <div className="flex items-center gap-2 px-3 py-2 bg-panel border-b border-node-border flex-shrink-0">
        <button
          onClick={navigateBack}
          disabled={!canGoBack}
          className="p-1 rounded text-fg-muted hover:text-fg hover:bg-node transition-colors disabled:opacity-25 disabled:pointer-events-none"
        >
          <ArrowLeft size={14} />
        </button>
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <FolderOpen size={13} className="text-amber-400 flex-shrink-0" />
          <span className="text-xs text-fg-muted truncate font-mono">{folderName}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-xs text-fg-subtle">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-xs text-fg-subtle">Empty directory</div>
        ) : (
          entries.map(entry => (
            <button
              key={entry.path}
              onClick={() => entry.isDirectory ? navigateTo(entry.path) : undefined}
              className={`flex items-center gap-2.5 w-full px-4 py-1.5 text-left hover:bg-white/[0.04] transition-colors ${
                entry.isDirectory ? 'cursor-pointer' : 'cursor-default'
              }`}
            >
              {entry.isDirectory
                ? <Folder size={13} className="text-amber-400 flex-shrink-0" />
                : <File   size={13} className="text-fg-subtle flex-shrink-0" />
              }
              <span className={`text-sm truncate ${entry.isDirectory ? 'text-fg' : 'text-fg-subtle'}`}>
                {entry.name}
              </span>
            </button>
          ))
        )}
      </div>

      {pendingLink && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={cancelPendingLink}
        >
          <div
            className="w-[min(420px,90%)] rounded-md border border-white/10 bg-[#171717] shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 pt-3 pb-2 border-b border-white/[0.06]">
              <div className="text-[10px] uppercase tracking-wider text-fg-subtle font-mono">Link folder</div>
              <div className="text-sm text-fg mt-1">
                Pick which page in <span className="font-mono text-accent">{primaryFolder.label}</span> to link to a page in <span className="font-mono text-amber-300">{pendingLink.folderLabel}</span>.
              </div>
            </div>

            <div className="px-4 pt-3 pb-1">
              <div className="text-[10px] uppercase tracking-wider text-fg-subtle font-mono mb-1.5">
                Host page in {primaryFolder.label}
              </div>
              <div className="flex flex-wrap gap-1">
                {pages.map(hp => {
                  const isSelected = hp.id === hostPageChoice
                  return (
                    <button
                      key={hp.id}
                      onClick={() => setHostPageChoice(hp.id)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-[3px] border text-[11px] ${
                        isSelected
                          ? 'border-accent/60 bg-accent/15 text-fg'
                          : 'border-white/[0.06] text-fg-muted hover:bg-white/[0.05] hover:text-fg'
                      }`}
                      title={hp.id === activePageId ? 'Currently active page' : undefined}
                    >
                      <span className="truncate max-w-[140px]">{hp.name}</span>
                      {hp.id === activePageId && (
                        <span className="text-[9px] uppercase tracking-wider text-fg-subtle ml-1">active</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="px-4 pt-3 pb-2">
              <div className="text-[10px] uppercase tracking-wider text-fg-subtle font-mono mb-1.5">
                Target page in {pendingLink.folderLabel}
              </div>
              {pendingLink.pages.length === 0 ? (
                <div className="text-xs text-fg-subtle">No pages yet. Create one below.</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {pendingLink.pages.map(p => (
                    <button
                      key={p.id}
                      onClick={() => void confirmLinkToExisting(p.id)}
                      className="flex items-center gap-1 px-2 py-1 rounded-[3px] border border-white/[0.06] text-[11px] text-fg-muted hover:bg-white/[0.05] hover:text-fg"
                    >
                      <span className="truncate max-w-[140px]">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="border-t border-white/[0.06] px-3 py-2">
              {creatingPageDraft === null ? (
                <button
                  onClick={() => setCreatingPageDraft('Untitled')}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-fg-muted hover:text-fg hover:bg-white/[0.04] transition-colors"
                >
                  <FilePlus size={12} />
                  <span className="text-xs">Create new page in {pendingLink.folderLabel}</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 px-2 py-1">
                  <FilePlus size={12} className="text-fg-muted flex-shrink-0" />
                  <input
                    autoFocus
                    value={creatingPageDraft}
                    onChange={e => setCreatingPageDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void confirmLinkToNew()
                      else if (e.key === 'Escape') setCreatingPageDraft(null)
                    }}
                    className="flex-1 bg-transparent outline-none border-b border-white/20 text-xs text-fg placeholder:text-fg-subtle"
                    placeholder="New page name"
                  />
                  <button
                    onClick={() => void confirmLinkToNew()}
                    className="p-1 rounded text-emerald-300 hover:bg-white/[0.05]"
                    title="Create and link"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    onClick={() => setCreatingPageDraft(null)}
                    className="p-1 rounded text-fg-muted hover:bg-white/[0.05]"
                    title="Cancel"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
            </div>
            <div className="border-t border-white/[0.06] px-3 py-2 flex justify-end">
              <button
                onClick={cancelPendingLink}
                className="px-2.5 py-1 text-[11px] rounded text-fg-muted hover:text-fg hover:bg-white/[0.05]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
