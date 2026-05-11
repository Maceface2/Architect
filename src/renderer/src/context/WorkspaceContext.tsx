import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

export interface LoadedFolder {
  path: string
  label: string
  color: string
  // True for the host folder of this canvas session (the folder the user
  // opened via DirectoryGate). All other folders are reached via the active
  // page's links.
  isPrimary: boolean
}

export interface WorkspacePage {
  id: string
  name: string
  createdAt: string
  links: Array<{ folderPath: string; pageId: string }>
}

interface WorkspaceContextValue {
  // Backwards-compatible surface kept stable so existing renderer code can
  // refer to "the host folder" without learning the page model first.
  loadedFolders: LoadedFolder[]
  primaryFolder: LoadedFolder
  activeFolder: LoadedFolder
  setActiveFolderPath: (path: string) => void
  // Folder-management API. addFolder/removeFolder now operate on the active
  // page's link list (mutual on both folders' workspace.json files).
  addFolder: (path: string, otherPageId?: string) => Promise<void>
  removeFolder: (path: string) => Promise<void>
  getFolderForPath: (path: string) => LoadedFolder | null

  // Multi-page surface.
  pages: WorkspacePage[]
  activePageId: string
  activePage: WorkspacePage
  setActivePageId: (id: string) => Promise<void>
  createPage: (name?: string) => Promise<string | null>
  renamePage: (id: string, name: string) => Promise<void>
  deletePage: (id: string) => Promise<void>
  // False until the initial workspace.load resolves. Renderer code that
  // depends on a real pageId (canvas load, watch, save) gates on this so
  // it doesn't try to load `pending.json`.
  ready: boolean
  // Pulls the latest workspace.json from main. Use after any out-of-band
  // mutation (e.g. addLink to a non-active host page) so the tabs row and
  // loadedFolders pick up the change.
  refresh: () => Promise<void>
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

function colorForIndex(i: number): string {
  return FOLDER_PALETTE[i % FOLDER_PALETTE.length]
}

const FALLBACK_PAGE_NAME = 'Default'

function fallbackPage(): WorkspacePage {
  return {
    id: 'pending',
    name: FALLBACK_PAGE_NAME,
    createdAt: new Date().toISOString(),
    links: [],
  }
}

export function WorkspaceProvider({
  primaryDir,
  children,
}: {
  primaryDir: string
  children: React.ReactNode
}) {
  const [pages, setPages] = useState<WorkspacePage[]>(() => [fallbackPage()])
  const [activePageId, setActivePageIdState] = useState<string>('pending')
  const [activePath, setActivePath] = useState<string>(primaryDir)
  const [ready, setReady] = useState(false)

  // Session-only memory: `pageId -> folderPath -> rememberedOtherPageId`. Used
  // for the "remember last link per page" rule on inline page switches.
  const sessionPairingsRef = useRef<Map<string, Map<string, string>>>(new Map())

  const refresh = useCallback(async () => {
    try {
      const saved = await window.electron.workspace.load(primaryDir)
      if (saved && Array.isArray(saved.pages) && saved.pages.length > 0) {
        setPages(saved.pages)
        setActivePageIdState(saved.activePageId)
        setReady(true)
      }
    } catch {
      // Empty / unreadable workspace: leave the fallback page in place. The
      // main process bootstraps a v2 file on demand, so this branch shouldn't
      // fire under normal conditions.
    }
  }, [primaryDir])

  useEffect(() => {
    setPages([fallbackPage()])
    setActivePageIdState('pending')
    setActivePath(primaryDir)
    setReady(false)
    sessionPairingsRef.current = new Map()
    void refresh()
  }, [primaryDir, refresh])

  const activePage = useMemo(
    () => pages.find(p => p.id === activePageId) ?? pages[0],
    [pages, activePageId],
  )

  const value = useMemo<WorkspaceContextValue>(() => {
    const linkedPaths = activePage.links.map(l => l.folderPath)
    const allPaths = [primaryDir, ...linkedPaths.filter(p => p !== primaryDir)]
    const labels = labelsForPaths(allPaths)
    const loaded: LoadedFolder[] = allPaths.map((p, i) => ({
      path: p,
      label: labels[i],
      color: colorForIndex(i),
      isPrimary: p === primaryDir,
    }))
    const primary = loaded[0]
    const active = loaded.find(f => f.path === activePath) ?? primary
    const byPath = new Map(loaded.map(f => [f.path, f]))

    const setActiveFolderPath = (path: string) => {
      setActivePath(curr => (curr === path ? curr : path))
    }

    const setActivePageId = async (id: string) => {
      if (id === activePageId) return
      try {
        const res = await window.electron.workspace.setActivePage(primaryDir, id)
        if (res.ok) {
          setActivePageIdState(id)
          setActivePath(primaryDir)
        }
      } catch {}
    }

    const createPage = async (name?: string) => {
      try {
        const res = await window.electron.workspace.createPage(primaryDir, name)
        if (!res.ok) return null
        await refresh()
        setActivePageIdState(res.page.id)
        return res.page.id
      } catch {
        return null
      }
    }

    const renamePage = async (id: string, name: string) => {
      try {
        await window.electron.workspace.renamePage(primaryDir, id, name)
        await refresh()
      } catch {}
    }

    const deletePage = async (id: string) => {
      try {
        const res = await window.electron.workspace.deletePage(primaryDir, id)
        if (res.ok) {
          setPages(res.workspace.pages)
          setActivePageIdState(res.workspace.activePageId)
        }
      } catch {}
    }

    const addFolder = async (path: string, otherPageId?: string) => {
      if (!path || path === primaryDir) return
      try {
        const res = await window.electron.workspace.addLink(
          primaryDir,
          activePageId,
          path,
          otherPageId,
        )
        if (res.ok) {
          const m = sessionPairingsRef.current.get(activePageId) ?? new Map()
          m.set(path, res.otherPageId)
          sessionPairingsRef.current.set(activePageId, m)
          await refresh()
        }
      } catch {}
    }

    const removeFolder = async (path: string) => {
      if (!path || path === primaryDir) return
      try {
        await window.electron.workspace.removeLink(primaryDir, activePageId, path)
        const m = sessionPairingsRef.current.get(activePageId)
        if (m) m.delete(path)
        await refresh()
      } catch {}
    }

    return {
      loadedFolders: loaded,
      primaryFolder: primary,
      activeFolder: active,
      setActiveFolderPath,
      addFolder,
      removeFolder,
      getFolderForPath: (p: string) => byPath.get(p) ?? null,
      pages,
      activePageId,
      activePage,
      setActivePageId,
      createPage,
      renamePage,
      deletePage,
      ready,
      refresh,
    }
  }, [pages, activePage, activePageId, activePath, primaryDir, refresh, ready])

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

export function useWorkspaceOptional(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext)
}
