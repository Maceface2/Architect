import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

export interface LoadedFolder {
  path: string
  label: string
  color: string
  isPrimary: boolean
}

interface WorkspaceContextValue {
  loadedFolders: LoadedFolder[]
  primaryFolder: LoadedFolder
  activeFolder: LoadedFolder
  setActiveFolderPath: (path: string) => void
  addFolder: (path: string) => Promise<void>
  removeFolder: (path: string) => Promise<void>
  getFolderForPath: (path: string) => LoadedFolder | null
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

const FOLDER_PALETTE = [
  '#3d3dbf',
  '#9c5fbd',
  '#5fbd95',
  '#bd955f',
  '#bd5f5f',
  '#5f9cbd',
  '#bd5f9c',
  '#5fbdbd',
]

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed
}

function parentBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx <= 0) return ''
  const parent = trimmed.slice(0, idx)
  return basename(parent)
}

// Derive display labels for the full folder set: when basenames collide
// (e.g. two folders both named "client"), append the parent segment so
// the user can tell them apart in the picker / region chrome.
function labelsForPaths(paths: string[]): string[] {
  const bases = paths.map(basename)
  const counts = new Map<string, number>()
  for (const b of bases) counts.set(b, (counts.get(b) ?? 0) + 1)
  return paths.map((p, i) => {
    const b = bases[i]
    if ((counts.get(b) ?? 0) <= 1) return b
    const parent = parentBasename(p)
    return parent ? `${parent}/${b}` : b
  })
}

// Assign palette colors by index. Folders 0..PALETTE.length-1 each get a
// unique color in load order; any beyond that wrap around (rare — the user
// would need 9+ folders loaded). Stable per index, so adding/removing
// trailing folders doesn't reshuffle the existing folders' colors.
function colorForIndex(i: number): string {
  return FOLDER_PALETTE[i % FOLDER_PALETTE.length]
}

// State stores just paths + isPrimary. Labels and colors are derived in
// the value memo so disambiguation runs over the *current* set — adding a
// second "client" folder retroactively rewrites the first one's label too.
interface FolderEntry {
  path: string
  isPrimary: boolean
}

export function WorkspaceProvider({
  primaryDir,
  children,
}: {
  primaryDir: string
  children: React.ReactNode
}) {
  const [folders, setFolders] = useState<FolderEntry[]>(() => [
    { path: primaryDir, isPrimary: true },
  ])
  const [activePath, setActivePath] = useState<string>(primaryDir)

  // Reset state when the primary folder changes (e.g. user picks a new
  // workspace via DirectoryGate or "Change folder" in TopNav).
  useEffect(() => {
    setFolders([{ path: primaryDir, isPrimary: true }])
    setActivePath(primaryDir)
  }, [primaryDir])

  // Hydrate additional folders from the primary's workspace.json. Step 5
  // wires the FilesPanel "Add Folder" button to extend this list; for now
  // it just restores any previously persisted entries.
  useEffect(() => {
    let cancelled = false
    void window.electron.workspace.load(primaryDir).then(saved => {
      if (cancelled) return
      const extras = (saved?.folders ?? [])
        .map(f => f.path)
        .filter(p => p && p !== primaryDir)
      if (extras.length === 0) return
      setFolders(prev => {
        const seen = new Set(prev.map(f => f.path))
        const next = [...prev]
        for (const p of extras) {
          if (seen.has(p)) continue
          next.push({ path: p, isPrimary: false })
          seen.add(p)
        }
        return next
      })
    })
    return () => { cancelled = true }
  }, [primaryDir])

  const persist = useCallback(
    async (next: FolderEntry[]) => {
      const extras = next.filter(f => !f.isPrimary).map(f => ({ path: f.path }))
      await window.electron.workspace.save(primaryDir, extras)
    },
    [primaryDir],
  )

  const addFolder = useCallback(
    async (path: string) => {
      if (!path || path === primaryDir) return
      let next: FolderEntry[] | null = null
      setFolders(prev => {
        if (prev.some(f => f.path === path)) {
          next = null
          return prev
        }
        next = [...prev, { path, isPrimary: false }]
        return next
      })
      if (next) await persist(next)
    },
    [primaryDir, persist],
  )

  const removeFolder = useCallback(
    async (path: string) => {
      if (path === primaryDir) return
      let next: FolderEntry[] | null = null
      setFolders(prev => {
        const filtered = prev.filter(f => f.path !== path)
        if (filtered.length === prev.length) {
          next = null
          return prev
        }
        next = filtered
        return filtered
      })
      setActivePath(curr => (curr === path ? primaryDir : curr))
      if (next) await persist(next)
    },
    [primaryDir, persist],
  )

  const setActiveFolderPath = useCallback(
    (path: string) => {
      setActivePath(curr => (curr === path ? curr : path))
    },
    [],
  )

  const value = useMemo<WorkspaceContextValue>(() => {
    const labels = labelsForPaths(folders.map(f => f.path))
    const loaded: LoadedFolder[] = folders.map((f, i) => ({
      path: f.path,
      label: labels[i],
      color: colorForIndex(i),
      isPrimary: f.isPrimary,
    }))
    const primary =
      loaded.find(f => f.isPrimary) ??
      { path: primaryDir, label: basename(primaryDir), color: colorForIndex(0), isPrimary: true }
    const active = loaded.find(f => f.path === activePath) ?? primary
    const byPath = new Map(loaded.map(f => [f.path, f]))
    return {
      loadedFolders: loaded,
      primaryFolder: primary,
      activeFolder: active,
      setActiveFolderPath,
      addFolder,
      removeFolder,
      getFolderForPath: (p: string) => byPath.get(p) ?? null,
    }
  }, [folders, activePath, primaryDir, setActiveFolderPath, addFolder, removeFolder])

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider')
  }
  return ctx
}

// Optional variant for components that may render outside the provider
// (e.g. error boundaries, loading gates). Returns null instead of throwing.
export function useWorkspaceOptional(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext)
}
