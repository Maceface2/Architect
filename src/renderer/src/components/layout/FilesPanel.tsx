import { useState, useEffect, useMemo } from 'react'
import { Folder, File, ArrowLeft, FolderOpen, FolderPlus, X } from 'lucide-react'
import type { FileEntry } from '../../../../shared/electronTypes'
import { useWorkspace } from '../../context/WorkspaceContext'

export default function FilesPanel() {
  const { loadedFolders, primaryFolder, activeFolder, setActiveFolderPath, addFolder, removeFolder } =
    useWorkspace()

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
      if (picked) await addFolder(picked)
    } finally {
      setAdding(false)
    }
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
    <div className="h-full flex flex-col bg-canvas">
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
            return (
              <div
                key={folder.path}
                className={`group flex items-center gap-1.5 rounded px-1.5 py-1 cursor-pointer transition-colors ${
                  isActive ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                }`}
                onClick={() => setActiveFolderPath(folder.path)}
              >
                <span
                  aria-hidden
                  className="flex-shrink-0 w-2 h-2 rounded-sm"
                  style={{ background: folder.color }}
                />
                <FolderOpen
                  size={12}
                  className={`flex-shrink-0 ${isActive ? 'text-amber-400' : 'text-fg-subtle'}`}
                />
                <span
                  className={`flex-1 truncate text-xs font-mono ${isActive ? 'text-fg' : 'text-fg-muted'}`}
                  title={folder.path}
                >
                  {folder.label}
                  {folder.isPrimary && (
                    <span className="ml-1.5 text-[9px] uppercase tracking-wider text-fg-subtle">
                      primary
                    </span>
                  )}
                </span>
                {!folder.isPrimary && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      void handleRemoveFolder(folder.path)
                    }}
                    className="p-0.5 rounded text-fg-subtle opacity-0 group-hover:opacity-100 hover:text-fg hover:bg-white/10 transition-colors"
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
    </div>
  )
}
