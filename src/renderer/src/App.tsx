import { useState, useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  type Connection,
  type Edge,
  type XYPosition,
} from '@xyflow/react'

import TopNav from './components/layout/TopNav'
import AssistantPanel, { type AssistantOrientation } from './components/layout/AssistantPanel'
import type { AssistantRelaunchOpts } from './components/layout/AssistantLaunchModal'
import Sidebar from './components/layout/Sidebar'
import FilesPanel from './components/layout/FilesPanel'
import TerminalPanel from './components/layout/TerminalPanel'
import PopoutTerminalApp from './components/layout/PopoutTerminalApp'
import ResizablePanel from './components/layout/ResizablePanel'
import SettingsPanel from './components/settings/SettingsPanel'
import type { TerminalLayout } from './components/layout/terminalLayoutTypes'
import { emptyLayout } from './components/layout/terminalLayoutOps'
import { palette, ZONE_PALETTE_ITEM } from './data/componentPalette'
import { nodeTypes } from './components/nodes/nodeTypes'
import type {
  AssistantMode,
  CanvasNode,
  ComponentNodeType,
  ProjectSettings,
  ZoneNodeData,
  ZoneNodeType,
} from './types'
import type { PaletteItemConfig } from './data/componentPalette'
import {
  createDefaultZoneAgentConfig,
  createDefaultProjectSettings,
  migrateCanvasData,
  mintParticipantId,
} from './lib/canvas'
import { ProjectSettingsProvider } from './context/ProjectSettingsContext'
import { ProjectDirProvider } from './context/ProjectDirContext'
import DispatchModal from './components/dispatch/DispatchModal'
import type { DispatchRequest } from './types'
import { DEFAULT_AGENT_RUNTIME, type AgentRuntime } from '../../shared/agentRuntimes'

interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime | 'shell'
}

interface CanvasUpdate {
  zones?: unknown[]
  components?: unknown[]
  nodes?: unknown[]
  edges: unknown[]
}

// Must match the main-process ASSISTANT_ZONES keys (terminals.ts) — those
// are sanitize('Architecture Assistant Design'|'General') with non-alnum
// chars replaced by '-'. Used here to route zone:session-captured events
// for the two assistant modes back into the per-mode last-session store.
const ASSISTANT_ZONE_KEYS: Record<AssistantMode, string> = {
  architecture: 'Architecture-Assistant-Design',
  general:      'Architecture-Assistant-General',
}

const ZONE_DEFAULT_WIDTH = 420
const ZONE_DEFAULT_HEIGHT = 280
const COMPONENT_APPROX_W = 180
const COMPONENT_APPROX_H = 78
const FIT_VIEW_OPTIONS = { padding: 0.18, duration: 280 }

function buildDemoGraph(settings: ProjectSettings): { nodes: CanvasNode[]; edges: Edge[] } {
  const zoneX = 120
  const zoneY = 120
  const zone: ZoneNodeType = {
    id: 'demo-zone-1',
    type: 'zone',
    position: { x: zoneX, y: zoneY },
    width: 520,
    height: 360,
    zIndex: 0,
    data: {
      participantId: mintParticipantId('Backend Platform', new Set()),
      label: 'Backend Platform',
      description: 'API + auth + storage',
      color: '#58A6FF',
      status: 'idle',
      systemPrompt: 'You are a backend platform agent. Build a small Express API backed by Postgres with JWT auth. Keep it minimal and runnable.',
      ...createDefaultZoneAgentConfig(settings),
    },
  }
  const comps: ComponentNodeType[] = [
    {
      id: 'demo-c-1',
      type: 'component',
      position: { x: zoneX + 30, y: zoneY + 70 },
      zIndex: 1,
      data: {
        label: 'API Gateway',
        description: 'Request routing',
        specs: 'Express server listening on :3000.\nRoutes: /api/* → service handlers.\nDelegates auth to the Auth component before dispatching protected routes.',
        category: 'infrastructure',
        iconName: 'Shield',
        color: '#fb923c',
        tag: 'API',
      },
    },
    {
      id: 'demo-c-2',
      type: 'component',
      position: { x: zoneX + 300, y: zoneY + 70 },
      zIndex: 1,
      data: {
        label: 'Auth',
        description: 'JWT sessions',
        specs: 'POST /auth/login { email, password } → { token }.\nGET /auth/me with Bearer token → user profile.\nTokens signed with HS256, 1h expiry.',
        category: 'infrastructure',
        iconName: 'Lock',
        color: '#4ade80',
        tag: 'AUTH',
      },
    },
    {
      id: 'demo-c-3',
      type: 'component',
      position: { x: zoneX + 165, y: zoneY + 220 },
      zIndex: 1,
      data: {
        label: 'PostgreSQL',
        description: 'Persistent storage',
        specs: 'Schema: users(id uuid PK, email unique, password_hash, created_at).\nRun migrations via scripts/migrate.js.',
        category: 'storage',
        iconName: 'Database',
        color: '#60a5fa',
        tag: 'DB',
      },
    },
  ]
  const edges: Edge[] = [
    { id: 'demo-ce-1', source: 'demo-c-1', target: 'demo-c-2' },
    { id: 'demo-ce-2', source: 'demo-c-1', target: 'demo-c-3' },
  ]
  return { nodes: [zone, ...comps], edges }
}

function serializeCanvasData(
  nodes: CanvasNode[],
  edges: Edge[],
  settings: ProjectSettings,
): string {
  return JSON.stringify({
    nodes,
    edges,
    settings,
    savedAt: new Date().toISOString(),
  })
}

function buildPaletteContext(): string {
  return JSON.stringify(
    {
      zoneTemplate: {
        id: ZONE_PALETTE_ITEM.id,
        label: ZONE_PALETTE_ITEM.label,
        description: ZONE_PALETTE_ITEM.description,
        defaults: {
          color: ZONE_PALETTE_ITEM.color,
          tag: ZONE_PALETTE_ITEM.tag,
          kind: ZONE_PALETTE_ITEM.kind,
        },
      },
      components: palette.map(item => ({
        id: item.id,
        label: item.label,
        description: item.description,
        category: item.category,
        iconName: item.iconName,
        color: item.color,
        tag: item.tag,
      })),
    },
    null,
    2,
  )
}

function DirectoryGate({ onOpen }: { onOpen: (dir: string) => void }) {
  const [loading, setLoading] = useState(false)

  const pick = async () => {
    setLoading(true)
    try {
      const dir = await window.electron.openDirectory()
      if (dir) onOpen(dir)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="h-screen w-screen bg-canvas flex flex-col items-center justify-center gap-8 select-none">
      <div className="flex flex-col items-center gap-4">
        <svg width="52" height="52" viewBox="0 0 400 400" fill="none">
          <line x1="40" y1="360" x2="360" y2="40" stroke="#58A6FF" strokeWidth="14" strokeLinecap="round" />
          <line x1="40" y1="360" x2="200" y2="360" stroke="#58A6FF" strokeWidth="14" strokeLinecap="round" />
          <line x1="200" y1="360" x2="360" y2="40" stroke="#58A6FF" strokeWidth="14" strokeLinecap="round" />
          <circle cx="40" cy="360" r="14" fill="#58A6FF" />
          <circle cx="200" cy="360" r="14" fill="#58A6FF" />
          <circle cx="360" cy="40" r="14" fill="#58A6FF" />
        </svg>
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-white tracking-tight">Architect</h1>
          <p className="text-sm text-slate-500 mt-1">Open a project folder to get started</p>
        </div>
      </div>

      <button
        onClick={pick}
        disabled={loading}
        className="flex items-center gap-2.5 px-6 py-3 bg-accent hover:bg-[#4a4ad0] disabled:opacity-50 disabled:pointer-events-none text-white text-sm font-medium rounded-lg transition-colors"
      >
        {loading ? 'Opening…' : 'Open Project Folder'}
      </button>

      <p className="text-xs text-slate-700">
        All agents will be scoped to this directory
      </p>
    </div>
  )
}

function CanvasConflictModal({
  onLoadIncoming,
  onKeepLocal,
}: {
  onLoadIncoming: () => void
  onKeepLocal: () => void
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/[0.08] bg-[#151515] shadow-2xl">
        <div className="border-b border-white/[0.06] px-5 py-4">
          <h2 className="text-sm font-semibold text-white">External canvas changes detected</h2>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            The assistant updated `architect-canvas.json`, but you still have unsaved canvas edits in memory.
          </p>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs leading-5 text-slate-500">
            Choose whether to replace the current canvas with the assistant&apos;s version or keep your local edits and ignore this incoming change.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
          <button
            onClick={onKeepLocal}
            className="px-3 py-1.5 text-xs text-slate-300 border border-node-border rounded hover:bg-node transition-colors"
          >
            Keep local edits
          </button>
          <button
            onClick={onLoadIncoming}
            className="px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:bg-[#4a4ad0] transition-colors"
          >
            Load assistant changes
          </button>
        </div>
      </div>
    </div>
  )
}

function zoneHash(n: ZoneNodeType): string {
  const { data: { status: _s, ...data } } = n
  return JSON.stringify(data)
}

function zonesContainingPoint(zones: ZoneNodeType[], point: XYPosition): ZoneNodeType[] {
  return zones.filter(zone => {
    const w = zone.width ?? ZONE_DEFAULT_WIDTH
    const h = zone.height ?? ZONE_DEFAULT_HEIGHT
    return (
      point.x >= zone.position.x &&
      point.x <= zone.position.x + w &&
      point.y >= zone.position.y &&
      point.y <= zone.position.y + h
    )
  })
}

function ArchitectFlow({ projectDir, onChangeDir }: { projectDir: string; onChangeDir: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>(createDefaultProjectSettings())
  const [activeTab, setActiveTab] = useState('Canvas')
  const [terminalSessions, setTerminalSessions] = useState<TerminalInfo[]>([])
  const [dispatching, setDispatching] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [dispatchedGraph, setDispatchedGraph] = useState<Record<string, string> | null>(null)
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false)
  const [dispatchPrefill, setDispatchPrefill] = useState<string>('')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantRuntime, setAssistantRuntime] = useState<AgentRuntime | null>(null)
  const [assistantOrientation, setAssistantOrientation] = useState<AssistantOrientation>(() => {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('architect:assistant-orientation') : null
    return raw === 'bottom' ? 'bottom' : 'right'
  })
  const [pendingExternalCanvasRaw, setPendingExternalCanvasRaw] = useState<string | null>(null)
  const [terminalLayout, setTerminalLayout] = useState<TerminalLayout | null>(null)
  const terminalLayoutSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nodesRef = useRef<CanvasNode[]>([])
  const edgesRef = useRef<Edge[]>([])
  const settingsRef = useRef<ProjectSettings>(projectSettings)
  const isDirtyRef = useRef(false)
  const lastAppliedCanvasRef = useRef('')
  const dismissedExternalCanvasRef = useRef<string | null>(null)
  const { screenToFlowPosition, fitView } = useReactFlow()

  // Canvas undo/redo: snapshot {nodes, edges} on structural changes (add,
  // remove, connect) and at the start of a drag/resize. Data-only edits from
  // node config modals go through setNodes directly and aren't captured — only
  // graph-shape changes are undoable.
  type CanvasSnapshot = { nodes: CanvasNode[]; edges: Edge[] }
  const historyPastRef = useRef<CanvasSnapshot[]>([])
  const historyFutureRef = useRef<CanvasSnapshot[]>([])
  const dragOrResizeInFlightRef = useRef(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const MAX_HISTORY = 50

  const snapshotHistory = useCallback(() => {
    historyPastRef.current = [
      ...historyPastRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
    ].slice(-MAX_HISTORY)
    historyFutureRef.current = []
    setHistoryVersion(v => v + 1)
  }, [])

  const resetHistory = useCallback(() => {
    historyPastRef.current = []
    historyFutureRef.current = []
    dragOrResizeInFlightRef.current = false
    setHistoryVersion(v => v + 1)
  }, [])

  const undoCanvas = useCallback(() => {
    const prev = historyPastRef.current[historyPastRef.current.length - 1]
    if (!prev) return
    historyPastRef.current = historyPastRef.current.slice(0, -1)
    historyFutureRef.current = [
      ...historyFutureRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
    ]
    setNodes(prev.nodes)
    setEdges(prev.edges)
    setIsDirty(true)
    setHistoryVersion(v => v + 1)
  }, [setNodes, setEdges])

  const redoCanvas = useCallback(() => {
    const next = historyFutureRef.current[historyFutureRef.current.length - 1]
    if (!next) return
    historyFutureRef.current = historyFutureRef.current.slice(0, -1)
    historyPastRef.current = [
      ...historyPastRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
    ]
    setNodes(next.nodes)
    setEdges(next.edges)
    setIsDirty(true)
    setHistoryVersion(v => v + 1)
  }, [setNodes, setEdges])

  const canUndo = historyPastRef.current.length > 0
  const canRedo = historyFutureRef.current.length > 0
  void historyVersion // re-renders flip canUndo/canRedo via ref reads

  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])
  useEffect(() => { settingsRef.current = projectSettings }, [projectSettings])
  useEffect(() => { isDirtyRef.current = isDirty }, [isDirty])

  useEffect(() => () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    if (terminalLayoutSaveTimer.current) clearTimeout(terminalLayoutSaveTimer.current)
  }, [])

  // Pick up ad-hoc PTY spawns (e.g. canvas Play button) so they get a terminal tab.
  useEffect(() => {
    const unsub = window.electron.terminal.onSpawned(info => {
      setTerminalSessions(prev => {
        const existing = prev.findIndex(s => s.id === info.id)
        if (existing === -1) return [...prev, info]
        const next = prev.slice()
        next[existing] = info
        return next
      })
      setActiveTab('Terminal')
    })
    return unsub
  }, [])

  // Load persisted terminal layout when project changes; reset on dir switch.
  useEffect(() => {
    let cancelled = false
    setTerminalLayout(null)
    window.electron.loadTerminalLayout(projectDir).then(raw => {
      if (cancelled) return
      const parsed = raw && typeof raw === 'object' && 'root' in (raw as object)
        ? (raw as TerminalLayout)
        : emptyLayout()
      // Popout windows aren't reopened automatically on project load — drop the list
      // so those terminals show up in panes again instead of staying invisible.
      parsed.poppedOut = []
      setTerminalLayout(parsed)
    })
    return () => { cancelled = true }
  }, [projectDir])

  const handleTerminalLayoutChange = useCallback((next: TerminalLayout) => {
    setTerminalLayout(next)
    if (terminalLayoutSaveTimer.current) clearTimeout(terminalLayoutSaveTimer.current)
    terminalLayoutSaveTimer.current = setTimeout(() => {
      terminalLayoutSaveTimer.current = null
      void window.electron.saveTerminalLayout(projectDir, next)
    }, 400)
  }, [projectDir])

  const queueFitView = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void fitView(FIT_VIEW_OPTIONS)
      })
    })
  }, [fitView])

  const persistCanvasRaw = useCallback(async (raw: string, clearDirty: boolean) => {
    lastAppliedCanvasRef.current = raw
    dismissedExternalCanvasRef.current = null
    setPendingExternalCanvasRaw(null)
    await window.electron.saveCanvas(projectDir, raw)
    if (clearDirty) setIsDirty(false)
  }, [projectDir])

  // Track the last (runtime, sessionId) actually used per assistant mode so
  // the next app start auto-resumes it. Fresh-spawn captures fire this event;
  // explicit resumes don't capture and are persisted in handleAssistantRelaunch.
  useEffect(() => {
    const unsub = window.electron.zone.onSessionCaptured(event => {
      const mode: AssistantMode | null =
        event.zoneKey === ASSISTANT_ZONE_KEYS.architecture ? 'architecture'
        : event.zoneKey === ASSISTANT_ZONE_KEYS.general ? 'general'
        : null
      if (!mode) return
      const runtime = event.runtime
      if (runtime !== 'claude' && runtime !== 'codex' && runtime !== 'gemini' && runtime !== 'opencode') return
      // Persist immediately. A setIsDirty-only path loses this pointer if the
      // app closes before the next save, and the next startup would fall
      // through to DEFAULT_AGENT_RUNTIME — exactly the bug this field exists to fix.
      //
      // Captured `model` travels alongside so a later resume can replay the
      // exact config the user was running under (user-picked models can drift
      // in the launcher between spawns).
      const nextSettings: ProjectSettings = {
        ...settingsRef.current,
        assistantLastSessionByMode: {
          ...(settingsRef.current.assistantLastSessionByMode ?? {}),
          [mode]: {
            runtime,
            sessionId: event.sessionId,
            ...(event.model ? { model: event.model } : {}),
          },
        },
      }
      setProjectSettings(nextSettings)
      const raw = serializeCanvasData(nodesRef.current, edgesRef.current, nextSettings)
      void persistCanvasRaw(raw, false)
    })
    return unsub
  }, [persistCanvasRaw])

  const applyRawCanvas = useCallback((raw: string, clearDirty: boolean): boolean => {
    try {
      const migrated = migrateCanvasData(JSON.parse(raw))
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
      lastAppliedCanvasRef.current = raw
      dismissedExternalCanvasRef.current = null
      setPendingExternalCanvasRaw(null)
      setNodes(migrated.nodes)
      setEdges(migrated.edges)
      setProjectSettings(migrated.settings)
      setIsDirty(!clearDirty)
      setDispatchedGraph(null)
      setActiveTab('Canvas')
      resetHistory()
      queueFitView()
      return true
    } catch {
      return false
    }
  }, [queueFitView, setEdges, setNodes, resetHistory])

  useEffect(() => {
    let disposed = false
    lastAppliedCanvasRef.current = ''
    dismissedExternalCanvasRef.current = null
    setPendingExternalCanvasRaw(null)
    void window.electron.watchCanvas(projectDir)

    const unsubscribe = window.electron.onCanvasChanged(({ projectDir: changedProjectDir, raw }) => {
      if (changedProjectDir !== projectDir) return
      if (!raw) return
      if (raw === lastAppliedCanvasRef.current || raw === dismissedExternalCanvasRef.current) return
      try {
        migrateCanvasData(JSON.parse(raw))
      } catch {
        return
      }

      const currentRaw = serializeCanvasData(nodesRef.current, edgesRef.current, settingsRef.current)
      if (raw === currentRaw) {
        lastAppliedCanvasRef.current = raw
        dismissedExternalCanvasRef.current = null
        return
      }

      if (isDirtyRef.current) {
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current)
          autoSaveTimerRef.current = null
        }
        setPendingExternalCanvasRaw(raw)
        return
      }

      applyRawCanvas(raw, true)
    })

    window.electron.loadCanvas(projectDir).then((raw: string | null) => {
      if (disposed) return
      if (raw) {
        if (!applyRawCanvas(raw, true)) {
          lastAppliedCanvasRef.current = serializeCanvasData(nodesRef.current, edgesRef.current, settingsRef.current)
        }
        return
      }
      lastAppliedCanvasRef.current = serializeCanvasData(nodesRef.current, edgesRef.current, settingsRef.current)
    })

    return () => {
      disposed = true
      unsubscribe()
      void window.electron.unwatchCanvas()
    }
  }, [projectDir, applyRawCanvas])

  const onConnect = useCallback(
    (connection: Connection) => {
      snapshotHistory()
      setEdges(eds => addEdge(connection, eds))
      setIsDirty(true)
    },
    [setEdges, snapshotHistory]
  )

  const onSave = useCallback(async () => {
    const raw = serializeCanvasData(nodesRef.current, edgesRef.current, settingsRef.current)
    await persistCanvasRaw(raw, true)
    // Big Change: if we've dispatched before and zones changed since, auto-open the
    // dispatch modal with a prefilled prompt describing the diff.
    const snap = dispatchedGraph
    if (!snap) return
    const currentZones = nodesRef.current.filter((n): n is ZoneNodeType => n.type === 'zone')
    const changedLabels = currentZones
      .filter(n => snap[n.id] !== undefined && zoneHash(n) !== snap[n.id])
      .map(n => n.data.label)
    const addedLabels = currentZones
      .filter(n => snap[n.id] === undefined)
      .map(n => n.data.label)
    const removedIds = Object.keys(snap).filter(id => !currentZones.some(z => z.id === id))
    if (changedLabels.length + addedLabels.length + removedIds.length === 0) return
    const parts: string[] = []
    if (changedLabels.length) parts.push(`updated: ${changedLabels.join(', ')}`)
    if (addedLabels.length) parts.push(`added: ${addedLabels.join(', ')}`)
    if (removedIds.length) parts.push(`removed: ${removedIds.length} zone${removedIds.length === 1 ? '' : 's'}`)
    setDispatchPrefill(`Pick up these canvas changes — ${parts.join(' · ')}.`)
    setDispatchModalOpen(true)
  }, [persistCanvasRaw, dispatchedGraph])

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      const raw = event.dataTransfer.getData('application/architect-node')
      if (!raw) return
      const item: PaletteItemConfig = JSON.parse(raw)
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY })

      snapshotHistory()

      if (item.kind === 'zone') {
        setNodes(nds => {
          const usedParticipantIds = new Set<string>()
          for (const n of nds) {
            if (n.type === 'zone') usedParticipantIds.add((n.data as ZoneNodeData).participantId)
          }
          const newZone: ZoneNodeType = {
            id: `zone-${Date.now()}`,
            type: 'zone',
            position: { x: flowPoint.x - ZONE_DEFAULT_WIDTH / 2, y: flowPoint.y - ZONE_DEFAULT_HEIGHT / 2 },
            width: ZONE_DEFAULT_WIDTH,
            height: ZONE_DEFAULT_HEIGHT,
            zIndex: 0,
            data: {
              participantId: mintParticipantId('New Zone', usedParticipantIds),
              label: 'New Zone',
              description: '',
              color: '#58A6FF',
              status: 'idle',
              systemPrompt: '',
              ...createDefaultZoneAgentConfig(projectSettings),
            },
          }
          return [...nds, newZone]
        })
        setIsDirty(true)
        return
      }

      const newComp: ComponentNodeType = {
        id: `${item.id}-${Date.now()}`,
        type: 'component',
        position: { x: flowPoint.x - COMPONENT_APPROX_W / 2, y: flowPoint.y - COMPONENT_APPROX_H / 2 },
        zIndex: 1,
        data: {
          label: item.label,
          description: item.description,
          specs: '',
          category: item.category,
          iconName: item.iconName,
          color: item.color,
          tag: item.tag,
        },
      }
      setNodes(nds => [...nds, newComp])
      setIsDirty(true)
    },
    [projectSettings, screenToFlowPosition, setNodes, snapshotHistory]
  )

  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    // Snapshot once at the start of a drag/resize (not every frame) and once
    // per structural change batch.
    const hasSubstantive = changes.some(c => c.type !== 'position' && c.type !== 'select' && c.type !== 'dimensions')
    const startingDragOrResize = changes.some(c =>
      (c.type === 'position' && c.dragging === true) ||
      (c.type === 'dimensions' && c.resizing === true)
    )
    const endingDragOrResize = changes.some(c =>
      (c.type === 'position' && c.dragging === false) ||
      (c.type === 'dimensions' && c.resizing === false)
    )

    if (hasSubstantive) {
      snapshotHistory()
    } else if (startingDragOrResize && !dragOrResizeInFlightRef.current) {
      snapshotHistory()
      dragOrResizeInFlightRef.current = true
    }
    if (endingDragOrResize) {
      dragOrResizeInFlightRef.current = false
    }

    onNodesChange(changes)

    if (hasSubstantive) {
      setIsDirty(true)
      return
    }

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null
      const raw = serializeCanvasData(nodesRef.current, edgesRef.current, settingsRef.current)
      void persistCanvasRaw(raw, false)
    }, 1000)
  }, [onNodesChange, persistCanvasRaw, snapshotHistory])

  const handleEdgesChange = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    const hasSubstantive = changes.some(c => c.type !== 'select')
    if (hasSubstantive) snapshotHistory()
    onEdgesChange(changes)
    setIsDirty(true)
  }, [onEdgesChange, snapshotHistory])

  const onClear = useCallback(() => {
    snapshotHistory()
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    setPendingExternalCanvasRaw(null)
    dismissedExternalCanvasRef.current = null
    setNodes([])
    setEdges([])
    setIsDirty(true)
  }, [setEdges, setNodes, snapshotHistory])

  const onLoadDemo = useCallback(() => {
    snapshotHistory()
    const demo = buildDemoGraph(projectSettings)
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    setPendingExternalCanvasRaw(null)
    dismissedExternalCanvasRef.current = null
    setNodes(demo.nodes)
    setEdges(demo.edges)
    setIsDirty(true)
  }, [projectSettings, setEdges, setNodes, snapshotHistory])

  const zones = nodes.filter((n): n is ZoneNodeType => n.type === 'zone')

  const changedZoneLabels = dispatchedGraph
    ? zones.filter(n => zoneHash(n) !== dispatchedGraph[n.id]).map(n => n.data.label)
    : []

  const handleDispatchSubmit = useCallback(async (req: DispatchRequest) => {
    if (zones.length === 0) return
    setDispatchModalOpen(false)
    setDispatching(true)
    try {
      if (req.mode === 'resume') {
        const result = await window.electron.dispatches.resume({
          projectDir,
          dispatchId: req.dispatchId,
          nodes,
          edges,
          settings: projectSettings,
        })
        if (!result.ok) {
          const msg = result.error === 'legacy-protocol'
            ? 'This dispatch was created with the legacy protocol and can\'t be resumed under the current build. Start a new dispatch instead.'
            : 'Dispatch record not found.'
          window.alert(msg)
          return
        }
        setTerminalSessions(result.info)
        setActiveTab('Terminal')
        // Mark the full current canvas as "dispatched" — the resumed set covers it.
        const snapshot: Record<string, string> = {}
        for (const n of zones) snapshot[n.id] = zoneHash(n)
        setDispatchedGraph(snapshot)
        return
      }

      const isRedispatch = dispatchedGraph !== null
      const dispatchContext = isRedispatch
        ? { isRedispatch: true, changedNodeLabels: changedZoneLabels }
        : undefined
      // Persist the picked Orchestrator CLI so the next DispatchModal
      // pre-selects it. Keep this write alongside the IPC dispatch — they
      // describe the same user action.
      if (projectSettings.conductorRuntime !== req.conductorRuntime) {
        setProjectSettings(current => ({ ...current, conductorRuntime: req.conductorRuntime }))
        setIsDirty(true)
      }
      const sessions = await window.electron.startDispatch(
        nodes,
        edges,
        projectDir,
        projectSettings,
        {
          userPrompt: req.userPrompt,
          model: req.model,
          planMode: req.planMode,
          onlyZoneIds: req.onlyZoneIds,
          conductorRuntime: req.conductorRuntime,
        },
        dispatchContext,
      )
      setTerminalSessions(sessions)
      setActiveTab('Terminal')
      const onlySet = req.onlyZoneIds && req.onlyZoneIds.length > 0
        ? new Set(req.onlyZoneIds)
        : null
      const snapshot: Record<string, string> = { ...(dispatchedGraph ?? {}) }
      for (const n of zones) {
        if (!onlySet || onlySet.has(n.id)) snapshot[n.id] = zoneHash(n)
      }
      setDispatchedGraph(snapshot)
    } finally {
      setDispatching(false)
    }
  }, [zones, nodes, edges, projectDir, projectSettings, dispatchedGraph, changedZoneLabels])

  const onDispatch = useCallback(() => {
    if (zones.length === 0) return
    setDispatchPrefill('')
    setDispatchModalOpen(true)
  }, [zones.length])

  const buildAssistantContext = useCallback((
    mode: AssistantMode,
    currentNodes: CanvasNode[],
    currentEdges: Edge[],
  ) => {
    const zoneList = currentNodes.filter((n): n is ZoneNodeType => n.type === 'zone')
    const compList = currentNodes.filter((n): n is ComponentNodeType => n.type === 'component')
    const paletteJson = buildPaletteContext()

    const componentZones = new Map<string, string | null>()
    for (const c of compList) {
      const center = {
        x: c.position.x + COMPONENT_APPROX_W / 2,
        y: c.position.y + COMPONENT_APPROX_H / 2,
      }
      const containing = zonesContainingPoint(zoneList, center)
      componentZones.set(c.id, containing[0]?.id ?? null)
    }

    const canvasJson = JSON.stringify({
      zones: zoneList.map(z => ({
        id: z.id,
        label: z.data.label,
        description: z.data.description,
        color: z.data.color,
        systemPrompt: z.data.systemPrompt,
        position: z.position,
        width: z.width ?? ZONE_DEFAULT_WIDTH,
        height: z.height ?? ZONE_DEFAULT_HEIGHT,
      })),
      components: compList.map(c => ({
        id: c.id,
        label: c.data.label,
        description: c.data.description,
        specs: c.data.specs,
        category: c.data.category,
        iconName: c.data.iconName,
        color: c.data.color,
        tag: c.data.tag,
        position: c.position,
        overlayedBy: componentZones.get(c.id),
      })),
      edges: currentEdges.map(e => ({ id: e.id, source: e.source, target: e.target })),
    }, null, 2)

    const canvasBlock = zoneList.length === 0 && compList.length === 0
      ? '(empty canvas)'
      : `\`\`\`json\n${canvasJson}\n\`\`\``

    if (mode === 'general') {
      return `You are a general-purpose coding assistant working inside this project directory. Help the user with any coding, debugging, refactoring, research, or shell task they ask about.

The JSON block below is a read-only snapshot of the project's architecture canvas, provided only as reference so you understand the system being built — do not treat it as something to edit. Do NOT modify \`architect-canvas.json\` under any circumstances, and do not emit \`ARCHITECT_CANVAS_UPDATE\` blocks. If the user asks to change the canvas, tell them to switch the assistant to Architecture mode.

## Canvas reference
${canvasBlock}`
    }

    return `You are an architecture assistant embedded in Architect — a tool for visually composing multi-agent systems.

## Model
- **components** are first-class design artifacts on a flat canvas. Each carries its own context: label, description, and long-form specs (API contracts, schemas, responsibilities, notes). Components do NOT own agent behavior.
- **zones** are translucent overlays drawn on top of a group of components. Each zone is an agent (one CLI session per zone). Zones own their *systemPrompt* (role/behavior customization, passed to Claude as --append-system-prompt on first spawn), runtime, model, tools, skills, permissions.
- The canvas is **reference context** describing the system, not a build manifest. At Dispatch time the user selects which zones to involve and supplies a task prompt; the Architect coordinator routes that task to the chosen zones. Zones act ONLY on the task they receive — they do not automatically rebuild the components they own.

Zone membership is determined purely by geometry: if a component's center falls inside a zone's bounding box, that zone owns it (meaning the zone-agent is the one responsible when a dispatched task touches that component). A component outside all zones is a design artifact only — no agent owns it.

Edges connect any nodes (zones or components) and denote dependencies/data flow.

## Current Canvas
${canvasBlock}

## Component Palette
Use these as the preferred component presets when creating architectures. Match their \`category\`, \`iconName\`, \`color\`, and default \`tag\` unless the user clearly wants a custom component.
~~~json
${paletteJson}
~~~

## JSON Example
Write the canvas directly to \`architect-canvas.json\` using the modern Architect format:
~~~json
{"nodes":[{"id":"frontend-zone","type":"zone","position":{"x":80,"y":80},"width":620,"height":360,"zIndex":0,"data":{"label":"Frontend Agent","description":"Owns the user-facing app shell","color":"#58A6FF","status":"idle","systemPrompt":"You are a senior frontend engineer. Build clean, idiomatic React UIs with proper state management and accessibility.","agentRuntime":"codex","providerModels":{"codex":"gpt-5.2-codex"},"openSections":[],"skills":[],"tools":{"webSearch":false,"codeExec":false,"fileRead":false,"fileWrite":false,"apiCalls":false,"shell":false},"behavior":{"mode":"sequential","retries":0,"onFailure":"stop","timeoutMs":30000},"permissions":{"readFiles":false,"writeFiles":false,"network":false,"shell":false},"envVars":[]}},{"id":"web-ui","type":"component","position":{"x":120,"y":170},"zIndex":1,"data":{"label":"Frontend","description":"Browser client","specs":"React app with auth, dashboard, and settings screens.","category":"infrastructure","iconName":"Monitor","color":"#f472b6","tag":"UI"}}],"edges":[{"id":"zone-to-component","source":"frontend-zone","target":"web-ui"}],"settings":{"dispatchRuntime":"codex"}}
~~~

## Your Role
Help the user design, refine, and reason about their architecture. You can:
- Discuss design decisions and tradeoffs
- Suggest zones/components to add, remove, or restructure
- When the user asks you to build, create, generate, update, or change the diagram, directly edit \`architect-canvas.json\` in the project root. Do not wrap the diagram in chat markers and do not print large JSON blocks to the terminal unless the user explicitly asks for them.
- Replace the full canvas document when making a diagram change. Always write a complete valid top-level object with \`nodes\`, \`edges\`, and \`settings\`.
- Preserve existing ids, positions, and \`settings\` whenever possible so the user's layout and runtime defaults are not lost.
- Use \`type: "zone"\` for agent zones and \`type: "component"\` for design components.
- For zones, include: \`id\`, \`type\`, \`position\`, \`width\`, \`height\`, \`zIndex\`, and \`data\` with \`label\`, \`description\`, \`color\`, \`status\`, \`systemPrompt\`, \`agentRuntime\`, \`providerModels\`, \`openSections\`, \`skills\`, \`tools\`, \`behavior\`, \`permissions\`, \`envVars\`. \`systemPrompt\` defines the zone agent's durable role/style (e.g. "Senior backend engineer — write idiomatic Go, prefer stdlib, always add tests"). Do NOT phrase it as "build components X, Y, Z" or otherwise encode a build list — the canvas is context, and the user supplies the task at Dispatch time.
- For components, include: \`id\`, \`type\`, \`position\`, \`zIndex\`, and \`data\` with \`label\`, \`description\`, \`specs\`, \`category\`, \`iconName\`, \`color\`, \`tag\`.
- To place a component inside a zone, give it a position that falls within the zone's bounding box. Zones should be sized large enough to visually cover their components with margin.

Available categories: infrastructure | services | storage | custom
Available iconNames: Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench

The app live-reloads \`architect-canvas.json\`, so saving the file is how you update the visible canvas.
Only discuss and advise without editing the file when the user is asking for critique or brainstorming rather than asking for a diagram change.`
  }, [])

  const applyCanvasUpdate = useCallback((update: CanvasUpdate) => {
    snapshotHistory()
    const rawNodePayload = Array.isArray(update.nodes) ? update.nodes : null
    if (rawNodePayload && !Array.isArray(update.zones) && !Array.isArray(update.components)) {
      const migrated = migrateCanvasData({
        nodes: rawNodePayload,
        edges: Array.isArray(update.edges) ? update.edges : [],
        settings: settingsRef.current,
      })
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
      const rawCanvas = serializeCanvasData(migrated.nodes, migrated.edges, migrated.settings)
      setNodes(migrated.nodes)
      setEdges(migrated.edges)
      setProjectSettings(migrated.settings)
      setIsDirty(false)
      setDispatchedGraph(null)
      setPendingExternalCanvasRaw(null)
      setActiveTab('Canvas')
      queueFitView()
      void persistCanvasRaw(rawCanvas, true)
      return
    }

    const rawZones = Array.isArray(update.zones) ? (update.zones as Array<Record<string, unknown>>) : []
    const rawComponents = Array.isArray(update.components) ? (update.components as Array<Record<string, unknown>>) : []
    const rawEdges = (update.edges ?? []) as Array<{ id?: string; source: string; target: string }>

    const existingZones = nodesRef.current.filter((n): n is ZoneNodeType => n.type === 'zone')
    const existingComps = nodesRef.current.filter((n): n is ComponentNodeType => n.type === 'component')
    const existingZoneById = new Map(existingZones.map(z => [z.id, z]))
    const existingCompById = new Map(existingComps.map(c => [c.id, c]))

    const readPosition = (raw: Record<string, unknown>): XYPosition | null => {
      const p = raw.position
      if (p && typeof p === 'object') {
        const obj = p as Record<string, unknown>
        if (typeof obj.x === 'number' && typeof obj.y === 'number') return { x: obj.x, y: obj.y }
      }
      return null
    }

    const readDim = (raw: Record<string, unknown>, key: 'width' | 'height', fallback: number): number => {
      const v = raw[key]
      return typeof v === 'number' && v > 0 ? v : fallback
    }

    const activeSettings = settingsRef.current
    // Seed dedup set with the participantIds of zones that survive this
    // patch (same id in rawZones). Zones being removed don't reserve theirs.
    const survivingIds = new Set(rawZones.map(r => String(r.id ?? '')).filter(Boolean))
    const participantIdsInUse = new Set<string>()
    for (const z of existingZones) {
      if (survivingIds.has(z.id)) participantIdsInUse.add((z.data as ZoneNodeData).participantId)
    }
    const newZones: ZoneNodeType[] = rawZones.map((raw, i) => {
      const id = String(raw.id ?? `gen-zone-${Date.now()}-${i}`)
      const existing = existingZoneById.get(id)
      const position = readPosition(raw) ?? existing?.position ?? {
        x: 120 + (i % 2) * 480,
        y: 120 + Math.floor(i / 2) * 340,
      }
      const width = readDim(raw, 'width', existing?.width ?? ZONE_DEFAULT_WIDTH)
      const height = readDim(raw, 'height', existing?.height ?? ZONE_DEFAULT_HEIGHT)
      const label = String(raw.label ?? 'Zone')
      // Preserve the existing zone's participantId across assistant patches
      // so live dispatches / on-disk activity logs stay addressable; mint a
      // fresh one for brand-new zones the assistant is introducing.
      let participantId = existing?.data.participantId ?? ''
      if (!participantId) {
        participantId = mintParticipantId(label, participantIdsInUse)
        participantIdsInUse.add(participantId)
      }
      return {
        id,
        type: 'zone',
        position,
        width,
        height,
        zIndex: 0,
        data: {
          participantId,
          label,
          description: String(raw.description ?? ''),
          color: String(raw.color ?? '#58A6FF'),
          status: 'idle',
          systemPrompt: String(raw.systemPrompt ?? raw.prompt ?? ''),
          ...createDefaultZoneAgentConfig(activeSettings),
        },
      }
    })

    const zoneById = new Map(newZones.map(z => [z.id, z]))

    const newComps: ComponentNodeType[] = rawComponents.map((raw, i) => {
      const id = String(raw.id ?? `gen-comp-${Date.now()}-${i}`)
      const existing = existingCompById.get(id)
      const explicitPos = readPosition(raw)

      let position: XYPosition
      if (explicitPos) {
        position = explicitPos
      } else if (existing) {
        position = existing.position
      } else {
        const hintZoneId = String(raw.overlayZoneId ?? raw.zoneId ?? '')
        const hintZone = hintZoneId ? zoneById.get(hintZoneId) : undefined
        if (hintZone) {
          const siblings = rawComponents.filter(other =>
            other !== raw && String(other.overlayZoneId ?? other.zoneId ?? '') === hintZoneId
          ).length
          const cols = Math.max(1, Math.floor((hintZone.width ?? ZONE_DEFAULT_WIDTH) / (COMPONENT_APPROX_W + 20)))
          const col = i % cols
          const row = Math.floor(siblings / cols)
          position = {
            x: hintZone.position.x + 24 + col * (COMPONENT_APPROX_W + 20),
            y: hintZone.position.y + 64 + row * (COMPONENT_APPROX_H + 28),
          }
        } else {
          position = {
            x: 120 + (i % 4) * (COMPONENT_APPROX_W + 40),
            y: 520 + Math.floor(i / 4) * (COMPONENT_APPROX_H + 40),
          }
        }
      }

      return {
        id,
        type: 'component',
        position,
        zIndex: 1,
        data: {
          label: String(raw.label ?? 'Component'),
          description: String(raw.description ?? ''),
          specs: typeof raw.specs === 'string' ? raw.specs : '',
          category: (raw.category as ComponentNodeType['data']['category']) ?? 'services',
          iconName: String(raw.iconName ?? 'Settings2'),
          color: String(raw.color ?? '#60a5fa'),
          tag: String(raw.tag ?? 'NODE'),
        },
      }
    })

    const newEdges: Edge[] = rawEdges.map((raw, i) => ({
      id: raw.id ?? `gen-edge-${Date.now()}-${i}`,
      source: raw.source,
      target: raw.target,
    }))

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }

    const rawCanvas = serializeCanvasData([...newZones, ...newComps], newEdges, settingsRef.current)
    setNodes([...newZones, ...newComps])
    setEdges(newEdges)
    setIsDirty(false)
    setDispatchedGraph(null)
    setPendingExternalCanvasRaw(null)
    setActiveTab('Canvas')
    queueFitView()
    void persistCanvasRaw(rawCanvas, true)
  }, [persistCanvasRaw, queueFitView, setEdges, setNodes, snapshotHistory])

  // Per-mode effective CLI for the side-panel assistant. Architecture and
  // General maintain independent runtime choices, fully decoupled from the
  // dispatch/zone runtime: if a mode has no entry we fall back to the
  // hardcoded DEFAULT_AGENT_RUNTIME — NEVER to projectSettings.dispatchRuntime.
  // Changing Dispatch CLI in Settings must not retarget the assistant.
  const effectiveAssistantRuntime = useCallback((mode: AssistantMode): AgentRuntime => (
    projectSettings.assistantRuntimeByMode?.[mode] ?? DEFAULT_AGENT_RUNTIME
  ), [projectSettings.assistantRuntimeByMode])

  // When a prior run for this mode was recorded, resume exactly that session
  // under its recorded runtime + model. Overrides both effectiveRuntime and
  // main's latestReachable fallback, so explicit resumes the user made via
  // the launcher aren't clobbered by later fresh captures or model picks.
  const startOptsForImplicitOpen = useCallback((mode: AssistantMode): {
    runtime: AgentRuntime
    opts?: { model?: string; session: { mode: 'resume'; sessionId: string } }
  } => {
    const last = projectSettings.assistantLastSessionByMode?.[mode]
    if (last) {
      return {
        runtime: last.runtime,
        opts: {
          session: { mode: 'resume', sessionId: last.sessionId },
          ...(last.model ? { model: last.model } : {}),
        },
      }
    }
    return { runtime: effectiveAssistantRuntime(mode) }
  }, [projectSettings.assistantLastSessionByMode, effectiveAssistantRuntime])

  const handleAssistantToggle = useCallback(async () => {
    if (assistantOpen) {
      // Close = hide only. Both mode PTYs keep running; their xterm buffers
      // stay mounted so reopening resumes with full scrollback intact.
      setAssistantOpen(false)
      return
    }
    const mode = projectSettings.assistantMode
    const { runtime, opts } = startOptsForImplicitOpen(mode)
    const contextMd = buildAssistantContext(mode, nodes, edges)
    const session = await window.electron.assistant.start(
      projectDir, contextMd, runtime, mode, opts,
    )
    const sessionRuntime = session?.runtime
    setAssistantRuntime(sessionRuntime && sessionRuntime !== 'shell' ? sessionRuntime : runtime)
    setAssistantOpen(true)
  }, [assistantOpen, nodes, edges, projectDir, startOptsForImplicitOpen, projectSettings.assistantMode, buildAssistantContext])

  const handleAssistantClose = useCallback(() => {
    // Hide only — do not tear down PTYs. See handleAssistantToggle.
    setAssistantOpen(false)
  }, [])

  const handleAssistantModeChange = useCallback(async (next: AssistantMode) => {
    if (next === projectSettings.assistantMode) return
    setProjectSettings(s => ({ ...s, assistantMode: next }))
    setIsDirty(true)
    if (assistantOpen) {
      // Spawn the other mode's PTY on first use under ITS last-session or,
      // failing that, its effective runtime. Idempotent thereafter (main
      // returns the existing session instead of respawning).
      const { runtime, opts } = startOptsForImplicitOpen(next)
      const contextMd = buildAssistantContext(next, nodes, edges)
      const session = await window.electron.assistant.start(
        projectDir, contextMd, runtime, next, opts,
      )
      const sessionRuntime = session?.runtime
      setAssistantRuntime(sessionRuntime && sessionRuntime !== 'shell' ? sessionRuntime : runtime)
    }
  }, [assistantOpen, nodes, edges, projectDir, startOptsForImplicitOpen, projectSettings.assistantMode, buildAssistantContext])

  const handleAssistantOrientationChange = useCallback((next: AssistantOrientation) => {
    setAssistantOrientation(next)
    try { localStorage.setItem('architect:assistant-orientation', next) } catch {}
  }, [])

  const handleAssistantRelaunch = useCallback(async (targetMode: AssistantMode, opts: AssistantRelaunchOpts) => {
    const runtime = opts.runtime
    const contextMd = buildAssistantContext(targetMode, nodes, edges)
    const ipcOpts = {
      model: opts.model,
      session: opts.session.mode === 'resume'
        ? { mode: 'resume' as const, sessionId: opts.session.sessionId }
        : { mode: 'new' as const },
      // Launcher submissions always mean "replace the live session with
      // this config" — force a respawn even if the PTY is alive.
      force: true as const,
    }
    const session = await window.electron.assistant.start(
      projectDir, contextMd, runtime, targetMode, ipcOpts,
    )
    const sessionRuntime = session?.runtime
    setAssistantRuntime(sessionRuntime && sessionRuntime !== 'shell' ? sessionRuntime : runtime)
    // Persist the per-mode CLI choice + picked model so the launcher pre-fills
    // them next time.
    //
    // NOTE: we store the runtime verbatim. Previously we deleted the entry
    // when it matched the old `defaultRuntime`, but the assistant is now
    // Previously we deleted the per-mode entry to avoid redundancy, but that
    // coupled the assistant to Settings-page changes: user picks claude for
    // the assistant while Dispatch=claude → no override → later Dispatch
    // flips to codex → assistant silently retargets to codex. Once the user
    // explicitly picks an assistant CLI via the modal, it's sticky.
    //
    // For an explicit resume, stamp assistantLastSessionByMode now — resumes
    // don't trigger a capture event so the zone:session-captured listener
    // won't fire. For "new", the capture listener stamps the new sessionId
    // once it lands; we clear the stale entry here so a crash between respawn
    // and capture doesn't auto-resume the defunct session.
    const resumedSessionId = opts.session.mode === 'resume' ? opts.session.sessionId : null
    const current = settingsRef.current
    const nextByMode = {
      ...(current.assistantRuntimeByMode ?? {}),
      [targetMode]: runtime,
    }
    const nextLastSession = { ...(current.assistantLastSessionByMode ?? {}) }
    if (resumedSessionId) {
      nextLastSession[targetMode] = { runtime, sessionId: resumedSessionId, model: opts.model }
    } else {
      delete nextLastSession[targetMode]
    }
    const cleanedLastSession = Object.keys(nextLastSession).length > 0 ? nextLastSession : undefined
    const nextSettings: ProjectSettings = {
      ...current,
      assistantRuntimeByMode: nextByMode,
      assistantLastSessionByMode: cleanedLastSession,
      assistantModels: { ...(current.assistantModels ?? {}), [runtime]: opts.model },
    }
    setProjectSettings(nextSettings)
    const rawCanvas = serializeCanvasData(nodesRef.current, edgesRef.current, nextSettings)
    void persistCanvasRaw(rawCanvas, false)
  }, [buildAssistantContext, edges, nodes, projectDir, persistCanvasRaw])

  // Project-dir change = real teardown: old PTYs are pinned to old cwd.
  useEffect(() => {
    return () => {
      window.electron.assistant.stop()
    }
  }, [projectDir])

  const handleLoadIncomingCanvas = useCallback(() => {
    if (!pendingExternalCanvasRaw) return
    applyRawCanvas(pendingExternalCanvasRaw, true)
  }, [applyRawCanvas, pendingExternalCanvasRaw])

  const handleKeepLocalCanvas = useCallback(() => {
    if (!pendingExternalCanvasRaw) return
    dismissedExternalCanvasRef.current = pendingExternalCanvasRaw
    setPendingExternalCanvasRaw(null)
  }, [pendingExternalCanvasRaw])

  // Canvas undo/redo keyboard shortcuts — Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z
  // (or Cmd/Ctrl+Y) redo. Ignored while the user is typing in an input so
  // modals/text fields keep their native undo behavior.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (activeTab !== 'Canvas') return
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const target = e.target as HTMLElement | null
      const inField = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
      if (inField) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoCanvas()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redoCanvas()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeTab, undoCanvas, redoCanvas])

  const isCanvas = activeTab === 'Canvas'
  const isFiles = activeTab === 'Files'
  const isTerminal = activeTab === 'Terminal'
  const isSettings = activeTab === 'Settings'

  const handleSettingsChange = useCallback((partial: Partial<ProjectSettings>) => {
    setProjectSettings(current => ({ ...current, ...partial }))
    setIsDirty(true)
    // Picking a new canvas-default CLI bulk-applies it to every zone. Zones
    // can still be manually overridden afterwards; divergence is then
    // surfaced as "Custom" in the Settings panel.
    if ('dispatchRuntime' in partial && partial.dispatchRuntime) {
      const runtime = partial.dispatchRuntime
      setNodes(prev => prev.map(node =>
        node.type === 'zone'
          ? { ...node, data: { ...(node.data as ZoneNodeData), agentRuntime: runtime } }
          : node
      ))
      setDispatchedGraph(null)
    }
  }, [setNodes])

  return (
    <ProjectSettingsProvider value={projectSettings}>
      <ProjectDirProvider value={projectDir}>
      <div className="flex flex-col h-screen bg-canvas text-white overflow-hidden">
        <TopNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onClear={onClear}
          onLoadDemo={onLoadDemo}
          onDispatch={onDispatch}
          dispatching={dispatching}
          nodeCount={zones.length}
          projectDir={projectDir}
          onChangeDir={onChangeDir}
          onSave={onSave}
          isDirty={isDirty}
          onAssistantToggle={handleAssistantToggle}
          assistantOpen={assistantOpen}
          isRedispatch={dispatchedGraph !== null}
          changedCount={changedZoneLabels.length}
          onUndo={undoCanvas}
          onRedo={redoCanvas}
          canUndo={canUndo}
          canRedo={canRedo}
        />
        <div className="flex flex-1 overflow-hidden">
          <ResizablePanel side="left" defaultSize={180}>
            <Sidebar />
          </ResizablePanel>

          <div
            className="flex-1 flex overflow-hidden"
            style={{ flexDirection: assistantOrientation === 'bottom' ? 'column' : 'row' }}
          >
            <div className="flex-1 flex overflow-hidden">

          <div className={`flex-1 relative ${isCanvas ? '' : 'hidden'}`}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onDrop={onDrop}
              onDragOver={onDragOver}
              nodeTypes={nodeTypes}
              defaultEdgeOptions={{ style: { stroke: '#3a3a3a', strokeWidth: 1.5 } }}
              proOptions={{ hideAttribution: true }}
              fitView
            >
              <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="#2a2a2a" />
              <Controls />
            </ReactFlow>

            {pendingExternalCanvasRaw && (
              <CanvasConflictModal
                onLoadIncoming={handleLoadIncomingCanvas}
                onKeepLocal={handleKeepLocalCanvas}
              />
            )}

            {dispatchModalOpen && (
              <DispatchModal
                zones={zones.map(z => ({
                  id: z.id,
                  label: (z.data.label as string) ?? 'Zone',
                  color: (z.data.color as string) ?? '#58A6FF',
                }))}
                prefillPrompt={dispatchPrefill}
                onClose={() => setDispatchModalOpen(false)}
                onSubmit={handleDispatchSubmit}
              />
            )}
          </div>

          {isFiles && (
            <div className="flex-1 overflow-hidden">
              <FilesPanel rootDir={projectDir} />
            </div>
          )}

          <div className={`flex-1 overflow-hidden ${isTerminal ? '' : 'hidden'}`}>
            <TerminalPanel
              sessions={terminalSessions}
              isVisible={isTerminal}
              projectDir={projectDir}
              layout={terminalLayout}
              onLayoutChange={handleTerminalLayoutChange}
              onRemoveSession={(id) =>
                setTerminalSessions(prev => prev.filter(s => s.id !== id))
              }
              getCanvasSnapshot={() => ({
                nodes: nodesRef.current,
                edges: edgesRef.current,
                settings: settingsRef.current,
              })}
            />
          </div>

          {isSettings && (
            <div className="flex-1 overflow-hidden">
              <SettingsPanel
                settings={projectSettings}
                zones={zones}
                onChange={handleSettingsChange}
                assistantOrientation={assistantOrientation}
                onAssistantOrientationChange={handleAssistantOrientationChange}
              />
            </div>
          )}

            </div>

            {/* Assistant panel — always mounted once opened, then kept in
                the tree so both mode PTYs + xterm scrollback survive close
                and mode/orientation changes. `visible` toggles display. */}
            <div style={{ display: assistantOpen ? 'contents' : 'none' }}>
              <ResizablePanel
                key={assistantOrientation}
                side={assistantOrientation === 'bottom' ? 'bottom' : 'right'}
                defaultSize={assistantOrientation === 'bottom' ? 320 : 420}
                minSize={160}
                maxSize={900}
              >
                <AssistantPanel
                  visible={assistantOpen}
                  orientation={assistantOrientation}
                  onClose={handleAssistantClose}
                  onCanvasUpdate={applyCanvasUpdate}
                  runtime={assistantRuntime ?? effectiveAssistantRuntime(projectSettings.assistantMode)}
                  mode={projectSettings.assistantMode}
                  onModeChange={handleAssistantModeChange}
                  onRelaunch={handleAssistantRelaunch}
                />
              </ResizablePanel>
            </div>
          </div>
        </div>
      </div>
      </ProjectDirProvider>
    </ProjectSettingsProvider>
  )
}

function MainApp() {
  const [projectDir, setProjectDir] = useState<string | null>(null)

  if (!projectDir) {
    return <DirectoryGate onOpen={setProjectDir} />
  }

  return (
    <ReactFlowProvider>
      <ArchitectFlow projectDir={projectDir} onChangeDir={() => setProjectDir(null)} />
    </ReactFlowProvider>
  )
}

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const popoutId = params.get('popout')
  if (popoutId) {
    return <PopoutTerminalApp id={popoutId} label={params.get('label') ?? popoutId} />
  }
  return <MainApp />
}
