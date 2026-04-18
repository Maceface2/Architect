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
import AssistantPanel from './components/layout/AssistantPanel'
import Sidebar from './components/layout/Sidebar'
import FilesPanel from './components/layout/FilesPanel'
import TerminalPanel from './components/layout/TerminalPanel'
import PreviewPanel from './components/layout/PreviewPanel'
import ResizablePanel from './components/layout/ResizablePanel'
import { palette, ZONE_PALETTE_ITEM } from './data/componentPalette'
import { nodeTypes } from './components/nodes/nodeTypes'
import type {
  CanvasNode,
  ComponentNodeType,
  ProjectSettings,
  ZoneNodeType,
} from './types'
import type { PaletteItemConfig } from './data/componentPalette'
import {
  createDefaultZoneAgentConfig,
  createDefaultProjectSettings,
  migrateCanvasData,
} from './lib/canvas'
import { ProjectSettingsProvider } from './context/ProjectSettingsContext'
import type { AgentRuntime } from '../../shared/agentRuntimes'

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

const ZONE_DEFAULT_WIDTH = 420
const ZONE_DEFAULT_HEIGHT = 280
const COMPONENT_APPROX_W = 180
const COMPONENT_APPROX_H = 78
const FIT_VIEW_OPTIONS = { padding: 0.18, duration: 280 }

function buildDemoGraph(defaultRuntime: AgentRuntime): { nodes: CanvasNode[]; edges: Edge[] } {
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
      label: 'Backend Platform',
      description: 'API + auth + storage',
      color: '#58A6FF',
      status: 'idle',
      prompt: 'Build a small Express API backed by Postgres with JWT auth. Keep it minimal and runnable.',
      ...createDefaultZoneAgentConfig(defaultRuntime),
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
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantRuntime, setAssistantRuntime] = useState<AgentRuntime | null>(null)
  const [pendingExternalCanvasRaw, setPendingExternalCanvasRaw] = useState<string | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nodesRef = useRef<CanvasNode[]>([])
  const edgesRef = useRef<Edge[]>([])
  const settingsRef = useRef<ProjectSettings>(projectSettings)
  const isDirtyRef = useRef(false)
  const lastAppliedCanvasRef = useRef('')
  const dismissedExternalCanvasRef = useRef<string | null>(null)
  const { screenToFlowPosition, fitView } = useReactFlow()

  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])
  useEffect(() => { settingsRef.current = projectSettings }, [projectSettings])
  useEffect(() => { isDirtyRef.current = isDirty }, [isDirty])

  useEffect(() => () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
  }, [])

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
      queueFitView()
      return true
    } catch {
      return false
    }
  }, [queueFitView, setEdges, setNodes])

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
      setEdges(eds => addEdge(connection, eds))
      setIsDirty(true)
    },
    [setEdges]
  )

  const onSave = useCallback(async () => {
    const raw = serializeCanvasData(nodesRef.current, edgesRef.current, settingsRef.current)
    await persistCanvasRaw(raw, true)
  }, [persistCanvasRaw])

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

      if (item.kind === 'zone') {
        const newZone: ZoneNodeType = {
          id: `zone-${Date.now()}`,
          type: 'zone',
          position: { x: flowPoint.x - ZONE_DEFAULT_WIDTH / 2, y: flowPoint.y - ZONE_DEFAULT_HEIGHT / 2 },
          width: ZONE_DEFAULT_WIDTH,
          height: ZONE_DEFAULT_HEIGHT,
          zIndex: 0,
          data: {
            label: 'New Zone',
            description: '',
            color: '#58A6FF',
            status: 'idle',
            prompt: '',
            ...createDefaultZoneAgentConfig(projectSettings.defaultRuntime),
          },
        }
        setNodes(nds => [...nds, newZone])
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
    [projectSettings.defaultRuntime, screenToFlowPosition, setNodes]
  )

  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    onNodesChange(changes)
    const hasSubstantive = changes.some(c => c.type !== 'position' && c.type !== 'select' && c.type !== 'dimensions')
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
  }, [onNodesChange, persistCanvasRaw])

  const handleEdgesChange = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    onEdgesChange(changes)
    setIsDirty(true)
  }, [onEdgesChange])

  const onClear = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    setPendingExternalCanvasRaw(null)
    dismissedExternalCanvasRef.current = null
    setNodes([])
    setEdges([])
    setIsDirty(true)
  }, [setEdges, setNodes])

  const onLoadDemo = useCallback(() => {
    const demo = buildDemoGraph(projectSettings.defaultRuntime)
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    setPendingExternalCanvasRaw(null)
    dismissedExternalCanvasRef.current = null
    setNodes(demo.nodes)
    setEdges(demo.edges)
    setIsDirty(true)
  }, [projectSettings.defaultRuntime, setEdges, setNodes])

  const zones = nodes.filter((n): n is ZoneNodeType => n.type === 'zone')

  const changedZoneLabels = dispatchedGraph
    ? zones.filter(n => zoneHash(n) !== dispatchedGraph[n.id]).map(n => n.data.label)
    : []

  const onDispatch = useCallback(async () => {
    if (zones.length === 0) return
    setDispatching(true)
    const isRedispatch = dispatchedGraph !== null
    const dispatchContext = isRedispatch
      ? { isRedispatch: true, changedNodeLabels: changedZoneLabels }
      : undefined
    try {
      const sessions = await window.electron.runGraph(nodes, edges, projectDir, projectSettings, dispatchContext)
      setTerminalSessions(sessions)
      setActiveTab('Terminal')
      const snapshot: Record<string, string> = {}
      for (const n of zones) snapshot[n.id] = zoneHash(n)
      setDispatchedGraph(snapshot)
    } finally {
      setDispatching(false)
    }
  }, [zones, nodes, edges, projectDir, projectSettings, dispatchedGraph, changedZoneLabels])

  const buildAssistantContext = useCallback((currentNodes: CanvasNode[], currentEdges: Edge[]) => {
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
        prompt: z.data.prompt,
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

    return `You are an architecture assistant embedded in Architect — a tool for visually composing multi-agent systems.

## Model
- **components** are first-class design artifacts on a flat canvas. Each carries its own context: label, description, and long-form specs (API contracts, schemas, responsibilities, notes). Components do NOT own agent behavior.
- **zones** are translucent overlays drawn on top of a group of components. Each zone is an agent (one CLI session per zone) that builds whatever components it overlays. Zones own the prompt, runtime, model, tools, skills, permissions.

Zone membership is determined purely by geometry at dispatch time: if a component's center falls inside a zone's bounding box, that zone's agent is responsible for building it. A component outside all zones is a design artifact only — no agent builds it.

Edges connect any nodes (zones or components) and denote dependencies/data flow.

## Current Canvas
${zoneList.length === 0 && compList.length === 0 ? '(empty canvas)' : `\`\`\`json\n${canvasJson}\n\`\`\``}

## Component Palette
Use these as the preferred component presets when creating architectures. Match their \`category\`, \`iconName\`, \`color\`, and default \`tag\` unless the user clearly wants a custom component.
~~~json
${paletteJson}
~~~

## JSON Example
Write the canvas directly to \`architect-canvas.json\` using the modern Architect format:
~~~json
{"nodes":[{"id":"frontend-zone","type":"zone","position":{"x":80,"y":80},"width":620,"height":360,"zIndex":0,"data":{"label":"Frontend Agent","description":"Owns the user-facing app shell","color":"#58A6FF","status":"idle","prompt":"Build the React frontend and integrate APIs.","agentRuntimeMode":"inherit","agentRuntime":"codex","providerModels":{"codex":"gpt-5.2-codex"},"openSections":[],"skills":[],"tools":{"webSearch":false,"codeExec":false,"fileRead":false,"fileWrite":false,"apiCalls":false,"shell":false},"behavior":{"mode":"sequential","retries":0,"onFailure":"stop","timeoutMs":30000},"permissions":{"readFiles":false,"writeFiles":false,"network":false,"shell":false},"envVars":[]}},{"id":"web-ui","type":"component","position":{"x":120,"y":170},"zIndex":1,"data":{"label":"Frontend","description":"Browser client","specs":"React app with auth, dashboard, and settings screens.","category":"infrastructure","iconName":"Monitor","color":"#f472b6","tag":"UI"}}],"edges":[{"id":"zone-to-component","source":"frontend-zone","target":"web-ui"}],"settings":{"defaultRuntime":"codex"}}
~~~

## Your Role
Help the user design, refine, and reason about their architecture. You can:
- Discuss design decisions and tradeoffs
- Suggest zones/components to add, remove, or restructure
- When the user asks you to build, create, generate, update, or change the diagram, directly edit \`architect-canvas.json\` in the project root. Do not wrap the diagram in chat markers and do not print large JSON blocks to the terminal unless the user explicitly asks for them.
- Replace the full canvas document when making a diagram change. Always write a complete valid top-level object with \`nodes\`, \`edges\`, and \`settings\`.
- Preserve existing ids, positions, and \`settings\` whenever possible so the user's layout and runtime defaults are not lost.
- Use \`type: "zone"\` for agent zones and \`type: "component"\` for design components.
- For zones, include: \`id\`, \`type\`, \`position\`, \`width\`, \`height\`, \`zIndex\`, and \`data\` with \`label\`, \`description\`, \`color\`, \`status\`, \`prompt\`, \`agentRuntimeMode\`, \`agentRuntime\`, \`providerModels\`, \`openSections\`, \`skills\`, \`tools\`, \`behavior\`, \`permissions\`, \`envVars\`.
- For components, include: \`id\`, \`type\`, \`position\`, \`zIndex\`, and \`data\` with \`label\`, \`description\`, \`specs\`, \`category\`, \`iconName\`, \`color\`, \`tag\`.
- To place a component inside a zone, give it a position that falls within the zone's bounding box. Zones should be sized large enough to visually cover their components with margin.

Available categories: infrastructure | services | storage | custom
Available iconNames: Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench

The app live-reloads \`architect-canvas.json\`, so saving the file is how you update the visible canvas.
Only discuss and advise without editing the file when the user is asking for critique or brainstorming rather than asking for a diagram change.`
  }, [])

  const applyCanvasUpdate = useCallback((update: CanvasUpdate) => {
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

    const defaultRuntime = settingsRef.current.defaultRuntime
    const newZones: ZoneNodeType[] = rawZones.map((raw, i) => {
      const id = String(raw.id ?? `gen-zone-${Date.now()}-${i}`)
      const existing = existingZoneById.get(id)
      const position = readPosition(raw) ?? existing?.position ?? {
        x: 120 + (i % 2) * 480,
        y: 120 + Math.floor(i / 2) * 340,
      }
      const width = readDim(raw, 'width', existing?.width ?? ZONE_DEFAULT_WIDTH)
      const height = readDim(raw, 'height', existing?.height ?? ZONE_DEFAULT_HEIGHT)
      return {
        id,
        type: 'zone',
        position,
        width,
        height,
        zIndex: 0,
        data: {
          label: String(raw.label ?? 'Zone'),
          description: String(raw.description ?? ''),
          color: String(raw.color ?? '#58A6FF'),
          status: 'idle',
          prompt: String(raw.prompt ?? ''),
          ...createDefaultZoneAgentConfig(defaultRuntime),
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
  }, [persistCanvasRaw, queueFitView, setEdges, setNodes])

  const handleAssistantToggle = useCallback(async () => {
    if (assistantOpen) {
      window.electron.assistant.stop()
      setAssistantOpen(false)
      setAssistantRuntime(null)
    } else {
      const contextMd = buildAssistantContext(nodes, edges)
      const session = await window.electron.assistant.start(projectDir, contextMd, projectSettings.defaultRuntime)
      const sessionRuntime = session?.runtime
      setAssistantRuntime(sessionRuntime && sessionRuntime !== 'shell' ? sessionRuntime : projectSettings.defaultRuntime)
      setAssistantOpen(true)
    }
  }, [assistantOpen, nodes, edges, projectDir, projectSettings.defaultRuntime, buildAssistantContext])

  const handleAssistantClose = useCallback(() => {
    window.electron.assistant.stop()
    setAssistantOpen(false)
    setAssistantRuntime(null)
  }, [])

  const handleLoadIncomingCanvas = useCallback(() => {
    if (!pendingExternalCanvasRaw) return
    applyRawCanvas(pendingExternalCanvasRaw, true)
  }, [applyRawCanvas, pendingExternalCanvasRaw])

  const handleKeepLocalCanvas = useCallback(() => {
    if (!pendingExternalCanvasRaw) return
    dismissedExternalCanvasRef.current = pendingExternalCanvasRaw
    setPendingExternalCanvasRaw(null)
  }, [pendingExternalCanvasRaw])

  const isCanvas = activeTab === 'Canvas'
  const isFiles = activeTab === 'Files'
  const isTerminal = activeTab === 'Terminal'
  const isPreview = activeTab === 'Preview'

  return (
    <ProjectSettingsProvider value={projectSettings}>
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
          projectSettings={projectSettings}
          onDefaultRuntimeChange={(defaultRuntime) => {
            setProjectSettings(current => ({ ...current, defaultRuntime }))
            setIsDirty(true)
            setDispatchedGraph(null)
          }}
        />
        <div className="flex flex-1 overflow-hidden">
          <ResizablePanel side="left" defaultWidth={180}>
            <Sidebar />
          </ResizablePanel>

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
          </div>

          {isFiles && (
            <div className="flex-1 overflow-hidden">
              <FilesPanel rootDir={projectDir} />
            </div>
          )}

          <div className={`flex-1 overflow-hidden ${isTerminal ? '' : 'hidden'}`}>
            <TerminalPanel sessions={terminalSessions} isVisible={isTerminal} projectDir={projectDir} />
          </div>

          {isPreview && (
            <div className="flex-1 overflow-hidden">
              <PreviewPanel zones={zones} projectDir={projectDir} />
            </div>
          )}

          {assistantOpen && (
            <ResizablePanel side="right" defaultWidth={420}>
              <AssistantPanel
                onClose={handleAssistantClose}
                onCanvasUpdate={applyCanvasUpdate}
                runtime={assistantRuntime ?? projectSettings.defaultRuntime}
              />
            </ResizablePanel>
          )}
        </div>
      </div>
    </ProjectSettingsProvider>
  )
}

export default function App() {
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
