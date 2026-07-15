import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { ChevronRight, FolderPlus, X, FilePlus, Check } from 'lucide-react'
import type { FileEntry } from '../../../../shared/electronTypes'
import { useWorkspace, type WorkspacePage } from '../../context/WorkspaceContext'

/** Map a filename to a single flat dev-convention symbol — no letter
    abbreviations, no colored chip. JSON -> {}, code -> </>, styles -> #,
    config -> =, docs -> ≡, everything else a quiet dot. */
function fileSymbol(name: string): string {
  const lower = name.toLowerCase()
  if (lower === 'dockerfile' || lower === 'makefile') return '='
  if (lower.startsWith('.env')) return '='
  if (lower === 'package-lock.json' || lower === 'yarn.lock' || lower.endsWith('.lock')) return '='
  if (lower.startsWith('.git')) return '·'
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  switch (ext) {
    case 'json': case 'jsonc':
      return '{}'
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'py': case 'rb': case 'go': case 'rs': case 'java': case 'php':
    case 'c': case 'h': case 'cpp': case 'cc': case 'hpp': case 'swift': case 'kt':
    case 'html': case 'htm': case 'xml': case 'svg': case 'vue': case 'svelte':
      return '</>'
    case 'sh': case 'bash': case 'zsh':
      return '$_'
    case 'css': case 'scss': case 'sass': case 'less':
      return '#'
    case 'yml': case 'yaml': case 'toml': case 'ini': case 'cfg': case 'conf': case 'properties':
      return '='
    case 'md': case 'mdx': case 'markdown': case 'txt': case 'log': case 'rst':
    case 'pdf': case 'csv': case 'tsv':
      return '≡'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'ico': case 'bmp': case 'avif':
    case 'zip': case 'tar': case 'gz': case 'tgz': case 'rar': case '7z':
      return '◆'
    default:
      return '·'
  }
}

/** Flat gray, filled folder glyph (no amber, no outline). */
function FolderGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className="text-fg-subtle flex-shrink-0"
      aria-hidden
    >
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.5.68l1.2 1.32H18.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />
    </svg>
  )
}

/** Bare monochrome convention symbol for a file — no box, fixed-width so
    filenames stay aligned regardless of symbol length. */
function FileGlyph({ name }: { name: string }) {
  return (
    <span
      className="inline-flex items-center justify-center w-[18px] text-fg-subtle font-mono text-[10px] leading-none flex-shrink-0 select-none"
      aria-hidden
    >
      {fileSymbol(name)}
    </span>
  )
}

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

  // Expandable file tree (replaces the old drill-in breadcrumb). The active
  // workspace folder is the tree root; directories expand in place rather
  // than replacing the view. childrenByDir caches one readDir per dir.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childrenByDir, setChildrenByDir] = useState<Record<string, FileEntry[]>>({})
  const [adding, setAdding] = useState(false)

  // Resolve the linked page name for each non-host folder once per change to
  // the active page's link set. One IPC call per linked folder; results are
  // cached locally and refreshed when the user switches active pages.
  const activeLinksKey = useMemo(
    () => activePage.links.map(l => `${l.folderPath}:${l.pageId}`).join('\n'),
    [activePage.links],
  )
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLinksKey])

  const rootPath = activeFolder.path

  const loadDir = (dir: string) => {
    void window.electron.readDir(dir).then(result => {
      setChildrenByDir(prev => ({ ...prev, [dir]: result }))
    })
  }

  // Switching the active workspace folder re-roots the tree: collapse all,
  // expand just the new root, and (re)read its children.
  useEffect(() => {
    setExpanded(new Set([rootPath]))
    loadDir(rootPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  const toggleDir = (dir: string) => {
    const isOpen = expanded.has(dir)
    setExpanded(prev => {
      const n = new Set(prev)
      if (isOpen) n.delete(dir)
      else n.add(dir)
      return n
    })
    if (!isOpen && !(dir in childrenByDir)) loadDir(dir)
  }

  const renderTree = (dir: string, depth: number): ReactNode[] => {
    const items = childrenByDir[dir]
    if (!items) return []
    return items.map(entry => {
      if (entry.isDirectory) {
        const open = expanded.has(entry.path)
        return (
          <div key={entry.path}>
            <button
              onClick={() => toggleDir(entry.path)}
              className="flex items-center gap-1.5 w-full py-1.5 pr-3 text-left hover:bg-white/[0.04] transition-colors cursor-pointer"
              style={{ paddingLeft: 12 + depth * 14 }}
            >
              <ChevronRight
                size={12}
                className={`flex-shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-90' : ''}`}
              />
              <FolderGlyph size={14} />
              <span className="text-sm truncate text-fg">{entry.name}</span>
            </button>
            {open && renderTree(entry.path, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={entry.path}
          className="flex items-center gap-2.5 w-full py-1.5 pr-3 cursor-default"
          style={{ paddingLeft: 12 + depth * 14 + 18 }}
        >
          <FileGlyph name={entry.name} />
          <span className="text-sm truncate text-fg-subtle">{entry.name}</span>
        </div>
      )
    })
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

  const rootName = useMemo(() => {
    const trimmed = rootPath.replace(/[\\/]+$/, '')
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed
  }, [rootPath])

  return (
    <div className="relative flex h-full flex-col bg-canvas">
      {/* Workspace folder list. Each row is one loaded folder; click to make
          it the active folder (file tree below switches to it). The "+ Add"
          row at the bottom appends to workspace.json on the primary anchor. */}
      <div className="flex flex-col border-b border-node-border bg-panel">
        <div className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
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
                className={`group flex cursor-pointer items-start gap-1.5 rounded px-1.5 py-1 transition-colors ${
                  isActive ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                }`}
                onClick={() => setActiveFolderPath(folder.path)}
              >
                <span className="mt-0.5 flex-shrink-0">
                  <FolderGlyph size={13} />
                </span>
                <div className="flex-1 min-w-0">
                  <div
                  className={`truncate font-mono text-xs ${isActive ? 'text-fg' : 'text-fg-muted'}`}
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
                    className="mt-0.5 rounded p-0.5 text-fg-subtle opacity-0 transition-colors group-hover:opacity-100 hover:bg-node hover:text-fg"
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
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs text-fg-subtle transition-colors hover:bg-white/[0.03] hover:text-fg disabled:pointer-events-none disabled:opacity-50"
          >
            <FolderPlus size={12} className="flex-shrink-0" />
            <span className="font-mono">{adding ? 'Adding…' : 'Add Folder'}</span>
          </button>
        </div>
      </div>

      {/* Tree root header for the active workspace folder. */}
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-node-border bg-panel px-3 py-2">
        <FolderGlyph size={14} />
        <span className="text-xs text-fg-muted truncate font-mono">{rootName}</span>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {!(rootPath in childrenByDir) ? (
          <div className="flex h-24 items-center justify-center text-xs text-fg-subtle">Loading…</div>
        ) : (childrenByDir[rootPath]?.length ?? 0) === 0 ? (
          <div className="flex h-24 items-center justify-center text-xs text-fg-subtle">Empty directory</div>
        ) : (
          renderTree(rootPath, 0)
        )}
      </div>

      {pendingLink && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={cancelPendingLink}
        >
          <div
            className="w-[min(420px,90%)] rounded-md border border-node-border bg-node shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="border-b border-node-border px-4 pb-2 pt-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">Link folder</div>
              <div className="mt-1 text-sm text-fg">
                Pick which page in <span className="font-mono text-accent">{primaryFolder.label}</span> to link to a page in <span className="font-mono text-amber-300">{pendingLink.folderLabel}</span>.
              </div>
            </div>

            <div className="px-4 pt-3 pb-1">
              <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                Host page in {primaryFolder.label}
              </div>
              <div className="flex flex-wrap gap-1">
                {pages.map(hp => {
                  const isSelected = hp.id === hostPageChoice
                  return (
                    <button
                      key={hp.id}
                      onClick={() => setHostPageChoice(hp.id)}
                      className={`flex items-center gap-1 rounded-[3px] border px-2 py-1 text-[11px] ${
                        isSelected
                          ? 'border-accent/60 bg-accent/15 text-fg'
                          : 'border-node-border text-fg-muted hover:bg-node hover:text-fg'
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
              <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
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
                      className="flex items-center gap-1 rounded-[3px] border border-node-border px-2 py-1 text-[11px] text-fg-muted hover:bg-node hover:text-fg"
                    >
                      <span className="truncate max-w-[140px]">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="border-t border-node-border px-3 py-2">
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
                    className="flex-1 border-b border-node-border bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
                    placeholder="New page name"
                  />
                  <button
                    onClick={() => void confirmLinkToNew()}
                    className="rounded p-1 text-emerald-300 hover:bg-node"
                    title="Create and link"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    onClick={() => setCreatingPageDraft(null)}
                    className="rounded p-1 text-fg-muted hover:bg-node"
                    title="Cancel"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
            </div>
            <div className="flex justify-end border-t border-node-border px-3 py-2">
              <button
                onClick={cancelPendingLink}
                className="rounded px-2.5 py-1 text-[11px] text-fg-muted hover:bg-node hover:text-fg"
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
