import { useState, useEffect } from 'react'
import { Folder, File, ArrowLeft, FolderOpen } from 'lucide-react'

interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

export default function FilesPanel() {
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

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
    const prev = history[history.length - 1]
    if (prev !== undefined) {
      setHistory(h => h.slice(0, -1))
      setCurrentPath(prev)
    }
  }

  const pickFolder = async () => {
    const dir = await window.electron.openDirectory()
    if (dir) {
      setHistory([])
      setCurrentPath(dir)
    }
  }

  const folderName = currentPath ? (currentPath.split('/').filter(Boolean).pop() ?? currentPath) : 'No folder open'

  return (
    <div className="h-full flex flex-col bg-canvas">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-panel border-b border-node-border flex-shrink-0">
        <button
          onClick={navigateBack}
          disabled={history.length === 0}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-node transition-colors disabled:opacity-25 disabled:pointer-events-none"
        >
          <ArrowLeft size={14} />
        </button>
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <FolderOpen size={13} className="text-amber-400 flex-shrink-0" />
          <span className="text-xs text-slate-400 truncate font-mono">{folderName}</span>
        </div>
        <button
          onClick={pickFolder}
          className="px-2.5 py-1 text-xs text-slate-400 border border-node-border rounded hover:bg-node hover:text-slate-200 transition-colors flex-shrink-0"
        >
          Open
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto py-1">
        {!currentPath ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-4">
            <FolderOpen size={32} className="text-slate-600" />
            <p className="text-xs text-slate-500 text-center">No folder open</p>
            <button
              onClick={pickFolder}
              className="px-3 py-1.5 text-xs text-slate-300 border border-node-border rounded hover:bg-node hover:text-white transition-colors"
            >
              Open Folder
            </button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-24 text-xs text-slate-600">
            Loading...
          </div>
        ) : entries.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-xs text-slate-600">
            Empty directory
          </div>
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
                : <File   size={13} className="text-slate-600 flex-shrink-0" />
              }
              <span className={`text-sm truncate ${entry.isDirectory ? 'text-slate-200' : 'text-slate-500'}`}>
                {entry.name}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
