import { useCallback, useEffect, useState } from 'react'
import TerminalPanel from './TerminalPanel'
import { emptyLayout, migrateLayout } from './terminalLayoutOps'
import type { TerminalLayout } from './terminalLayoutTypes'
import { ProjectDirProvider } from '../../context/ProjectDirContext'
import { InterfaceSettingsProvider } from '../../context/InterfaceSettingsContext'
import { DEFAULT_INTERFACE_SETTINGS } from '../../lib/canvas'
import type { InterfaceSettings } from '../../types'
import type { AgentRuntime } from '../../../../shared/agentRuntimes'

// Mirrors the TerminalInfo shape declared in App.tsx and env.d.ts. There is
// no shared module for this type today; the existing App.tsx redefines it
// locally and we follow suit until someone consolidates.
interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime | 'shell'
  coordinatedMode?: boolean
  planMode?: boolean
}

// The detached terminal page. Loads in its own BrowserWindow when the user
// clicks "Popout" on the docked panel. State (sessions / layout / theme /
// projectDir) flows over the terminalPage IPC bus.
//
// Scrollback caveat: the popout creates fresh xterm instances when it
// mounts, so any output the user already saw in the docked panel does not
// follow them across. PTY state in main is unaffected; new bytes after the
// popout opens render normally.
export default function TerminalPagePopoutApp() {
  const [sessions, setSessions] = useState<TerminalInfo[]>([])
  const [layout, setLayout] = useState<TerminalLayout | null>(null)
  const [projectDir, setProjectDir] = useState<string>('')
  const [interfaceSettings, setInterfaceSettings] = useState<InterfaceSettings>(DEFAULT_INTERFACE_SETTINGS)

  useEffect(() => {
    document.title = 'Architect — Terminal'
  }, [])

  // Pull the cached snapshot once on mount. Main process kept it from the
  // popout-open call; this avoids a race where the open IPC resolves before
  // our event subscriptions have attached.
  useEffect(() => {
    let cancelled = false
    void window.electron.terminalPage.requestInitial().then(snapshot => {
      if (cancelled) return
      if (snapshot.sessions) setSessions(snapshot.sessions)
      const incomingLayout = snapshot.layout as TerminalLayout | null
      if (incomingLayout) {
        setLayout(migrateLayout(incomingLayout, (snapshot.sessions ?? []).map(s => s.id)))
      } else {
        setLayout(emptyLayout())
      }
      if (snapshot.projectDir) setProjectDir(snapshot.projectDir)
      if (snapshot.theme) {
        setInterfaceSettings(prev => ({ ...prev, theme: snapshot.theme }))
      }
    })
    return () => { cancelled = true }
  }, [])

  // Live updates from main window.
  useEffect(() => {
    const offSessions = window.electron.terminalPage.onSessions(next => {
      setSessions(next)
    })
    const offLayout = window.electron.terminalPage.onLayout(next => {
      const incoming = next as TerminalLayout | null
      if (incoming) setLayout(incoming)
    })
    const offTheme = window.electron.terminalPage.onTheme(next => {
      setInterfaceSettings(prev => ({ ...prev, theme: next }))
    })
    return () => {
      offSessions()
      offLayout()
      offTheme()
    }
  }, [])

  const handleLayoutChange = useCallback((next: TerminalLayout) => {
    setLayout(next)
    window.electron.terminalPage.publishLayout(next)
  }, [])

  const handleRemoveSession = useCallback((id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      window.electron.terminalPage.publishSessions(next)
      return next
    })
  }, [])

  return (
    <InterfaceSettingsProvider value={interfaceSettings}>
      <ProjectDirProvider value={projectDir}>
        <div className="h-screen w-screen bg-canvas text-fg flex flex-col">
          <TerminalPanel
            sessions={sessions}
            isVisible
            projectDir={projectDir}
            layout={layout}
            onLayoutChange={handleLayoutChange}
            onRemoveSession={handleRemoveSession}
            // Canvas snapshot is only used for "resume in this terminal"
            // flows that need the current graph; popout doesn't have one,
            // so we pass empty arrays. If the user resumes a zone from the
            // popout the call falls back to whatever's persisted to disk.
            getCanvasSnapshot={() => ({ nodes: [], edges: [], settings: null })}
            // Tells the topmost pane's tab strip to behave as the macOS
            // title bar: traffic-light padding + drag region + Architect
            // mark. The window itself uses titleBarStyle: 'hiddenInset'.
            popoutMode
          />
        </div>
      </ProjectDirProvider>
    </InterfaceSettingsProvider>
  )
}
