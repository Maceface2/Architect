import { useState, useEffect } from 'react'
import { Folder, File, ArrowLeft, FolderOpen } from 'lucide-react'

interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

interface Props {
  rootDir: string
}

export default function FilesPanel({ rootDir }: Props) {
  const [currentPath, setCurrentPath] = useState(rootDir)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  // Reset when the root dir changes
  useEffect(() => {
    setHistory([])
    setCurrentPath(rootDir)
  }, [rootDir])

  useEffect(() => {
    if (!currentPath) return
    setLoading(true)
    window.electron.readDir(currentPath).then(result => {
      setEntries(result)
      setLoading(false)
    })
  }, [currentPath])

  const navigateTo = (dirPath: string) => {
    setHistory(h => [...h, currentPath])
    setCurrentPath(dirPath)
  }

  const navigateBack = () => {
    // Don't navigate above rootDir
    const prev = history[history.length - 1]
    if (prev !== undefined) {
      setHistory(h => h.slice(0, -1))
      setCurrentPath(prev)
    }
  }

  const canGoBack = history.length > 0

  const folderName = currentPath.split('/').filter(Boolean).pop() ?? currentPath

  return (
    <div className="h-full flex flex-col bg-canvas">
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
