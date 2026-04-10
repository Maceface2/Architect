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
} from '@xyflow/react'

import TopNav from './components/layout/TopNav'
import AssistantPanel from './components/layout/AssistantPanel'
import Sidebar from './components/layout/Sidebar'
import AgentLog from './components/layout/AgentLog'
import FilesPanel from './components/layout/FilesPanel'
import TerminalPanel from './components/layout/TerminalPanel'
import ResizablePanel from './components/layout/ResizablePanel'
import { nodeTypes } from './components/nodes/nodeTypes'
import { DispatchActionsProvider } from './context/DispatchActionsContext'
import { ProjectDirectoryProvider } from './context/ProjectDirectoryContext'
import type { ArchitectNodeType, ProjectSettings } from './types'
import { palette, type PaletteItemConfig } from './data/componentPalette'
import { createDefaultNodeConfig, createDefaultProjectSettings, migrateCanvasData } from './lib/canvas'
import { ProjectSettingsProvider } from './context/ProjectSettingsContext'
import type { AgentRuntime } from '../../shared/agentRuntimes'
import type { GraphPreflightSummary, LaunchScopeMode, RunGraphOptions } from '../../shared/graphDispatch'
import type { ProjectBootstrapResult } from '../../shared/projectBootstrap'

interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime
}

const DEMO_NODES: ArchitectNodeType[] = [
  {
    id: 'demo-1', type: 'architectNode', position: { x: 160, y: 160 },
    data: { label: 'React App', description: 'Client UI layer', category: 'infrastructure', iconName: 'Monitor', color: '#f472b6', tag: 'UI', status: 'idle', prompt: '', ...createDefaultNodeConfig() }
  },
  {
    id: 'demo-2', type: 'architectNode', position: { x: 480, y: 80 },
    data: { label: 'API Gateway', description: 'Request routing', category: 'infrastructure', iconName: 'Shield', color: '#fb923c', tag: 'API', status: 'idle', prompt: '', ...createDefaultNodeConfig() }
  },
  {
    id: 'demo-3', type: 'architectNode', position: { x: 160, y: 320 },
    data: { label: 'PostgreSQL', description: 'Persistent storage', category: 'storage', iconName: 'Database', color: '#60a5fa', tag: 'DB', status: 'idle', prompt: '', ...createDefaultNodeConfig() }
  },
]
const DEMO_EDGES: Edge[] = [
  { id: 'demo-e1', source: 'demo-1', target: 'demo-2' },
  { id: 'demo-e2', source: 'demo-1', target: 'demo-3' },
]

// ── Directory gate ─────────────────────────────────────────────────────────

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
      {/* Logo */}
      <div className="flex flex-col items-center gap-4">
        <svg width="52" height="52" viewBox="0 0 400 400" fill="none">
          <line x1="40"  y1="360" x2="360" y2="40"  stroke="#58A6FF" strokeWidth="14" strokeLinecap="round"/>
          <line x1="40"  y1="360" x2="200" y2="360" stroke="#58A6FF" strokeWidth="14" strokeLinecap="round"/>
          <line x1="200" y1="360" x2="360" y2="40"  stroke="#58A6FF" strokeWidth="14" strokeLinecap="round"/>
          <circle cx="40"  cy="360" r="14" fill="#58A6FF"/>
          <circle cx="200" cy="360" r="14" fill="#58A6FF"/>
          <circle cx="360" cy="40"  r="14" fill="#58A6FF"/>
        </svg>
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-white tracking-tight">Architect</h1>
          <p className="text-sm text-slate-500 mt-1">Open a project folder to import existing code or continue where you left off</p>
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

// ── Helpers ────────────────────────────────────────────────────────────────

function nodeHash(n: ArchitectNodeType): string {
  const { data: { status: _s, ...data } } = n
  return JSON.stringify(data)
}

function computeLayoutPositions(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>
): Record<string, { x: number; y: number }> {
  const depths = new Map<string, number>()
  const incoming = new Map<string, number>()
  for (const id of nodeIds) incoming.set(id, 0)
  for (const e of edges) incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1)

  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source)!.push(e.target)
  }

  const queue = nodeIds.filter(id => (incoming.get(id) ?? 0) === 0)
  for (const id of queue) depths.set(id, 0)

  const bfs = [...queue]
  while (bfs.length > 0) {
    const id = bfs.shift()!
    const d = depths.get(id) ?? 0
    for (const child of (adj.get(id) ?? [])) {
      if ((depths.get(child) ?? -1) < d + 1) {
        depths.set(child, d + 1)
        bfs.push(child)
      }
    }
  }

  const maxDepth = Math.max(0, ...depths.values())
  for (const id of nodeIds) {
    if (!depths.has(id)) depths.set(id, maxDepth + 1)
  }

  const byDepth = new Map<number, string[]>()
  for (const [id, d] of depths) {
    if (!byDepth.has(d)) byDepth.set(d, [])
    byDepth.get(d)!.push(id)
  }

  const positions: Record<string, { x: number; y: number }> = {}
  for (const [depth, ids] of byDepth) {
    ids.forEach((id, i) => {
      positions[id] = { x: 100 + depth * 320, y: 80 + i * 160 }
    })
  }
  return positions
}

function buildImportedNodes(
  bootstrap: ProjectBootstrapResult,
  defaultRuntime: AgentRuntime,
): ArchitectNodeType[] {
  const positions = computeLayoutPositions(
    bootstrap.nodes.map(node => node.id),
    bootstrap.edges
  )

  return bootstrap.nodes.map((node, index) => ({
    id: node.id,
    type: 'architectNode',
    position: positions[node.id] ?? { x: 80 + (index % 3) * 320, y: 80 + Math.floor(index / 3) * 160 },
    data: {
      label: node.label,
      description: node.description,
      category: node.category,
      iconName: node.iconName,
      color: node.color,
      tag: node.tag,
      status: 'idle',
      prompt: node.prompt,
      ...createDefaultNodeConfig(defaultRuntime),
      ownedPaths: node.ownedPaths,
      expectedFiles: node.expectedFiles,
      contracts: node.contracts,
      reviewHints: node.reviewHints,
    },
  }))
}

function serializeCanvasData(
  nodes: ArchitectNodeType[],
  edges: Edge[],
  settings: ProjectSettings,
) {
  return JSON.stringify({
    nodes,
    edges,
    settings,
    savedAt: new Date().toISOString(),
  })
}

// ── Main flow ──────────────────────────────────────────────────────────────

function ArchitectFlow({ projectDir, onChangeDir }: { projectDir: string; onChangeDir: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ArchitectNodeType>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>(createDefaultProjectSettings())
  const [activeTab, setActiveTab] = useState('Canvas')
  const [terminalSessions, setTerminalSessions] = useState<TerminalInfo[]>([])
  const [dispatching, setDispatching] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [dispatchedGraph, setDispatchedGraph] = useState<Record<string, string> | null>(null)
  const [initializingProject, setInitializingProject] = useState(true)
  const [bootstrapSummary, setBootstrapSummary] = useState<string | null>(null)
  const [bootstrapStatus, setBootstrapStatus] = useState('Analyzing existing project structure…')
  const [lastPreflight, setLastPreflight] = useState<GraphPreflightSummary | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantRuntime, setAssistantRuntime] = useState<AgentRuntime | null>(null)
  const [launchRevision, setLaunchRevision] = useState(0)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSyncedCanvasRef = useRef<string | null>(null)
  const { screenToFlowPosition } = useReactFlow()

  // Cleanup auto-save timer on unmount
  useEffect(() => () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current) }, [])

  // Save Claude session IDs back to node data when agents complete
  useEffect(() => {
    return window.electron.terminal.onNodeSessionSaved(({ nodeId, sessionId }) => {
      setNodes(prev => {
        const updated = prev.map(n =>
          n.id === nodeId ? { ...n, data: { ...n.data, claudeSessionId: sessionId } } : n
        )
        const serialized = serializeCanvasData(updated, edges, projectSettings)
        lastSyncedCanvasRef.current = serialized
        void window.electron.saveCanvas(projectDir, serialized)
        return updated
      })
    })
  }, [setNodes, projectDir, edges, projectSettings])

  // Auto-load canvas on mount
  useEffect(() => {
    let cancelled = false
    setInitializingProject(true)
    setBootstrapSummary(null)
    setBootstrapStatus('Analyzing existing project structure…')
    setLastPreflight(null)
    lastSyncedCanvasRef.current = null

    const loadProject = async () => {
      try {
        const raw = await window.electron.loadCanvas(projectDir)
        if (cancelled) return

        if (raw) {
          try {
            const migrated = migrateCanvasData(JSON.parse(raw))
            if (cancelled) return
            setNodes(migrated.nodes)
            setEdges(migrated.edges)
            setProjectSettings(migrated.settings)
            lastSyncedCanvasRef.current = raw
          } catch {}
          return
        }

        setBootstrapStatus('Synthesizing architecture from the repo structure…')
        const bootstrap = await window.electron.bootstrapProject(projectDir, projectSettings.defaultRuntime)
        if (cancelled) return

        const importedNodes = buildImportedNodes(bootstrap, projectSettings.defaultRuntime)
        const importedEdges: Edge[] = bootstrap.edges.map(edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        }))

        setNodes(importedNodes)
        setEdges(importedEdges)
        setBootstrapSummary(bootstrap.summary)
        const serialized = serializeCanvasData(importedNodes, importedEdges, projectSettings)
        lastSyncedCanvasRef.current = serialized
        await window.electron.saveCanvas(projectDir, serialized)
        if (cancelled) return
        setIsDirty(false)
        setDispatchedGraph(null)
      } finally {
        if (!cancelled) setInitializingProject(false)
      }
    }

    void loadProject()

    return () => {
      cancelled = true
    }
  }, [projectDir])

  const onConnect = useCallback(
    (connection: Connection) => { setEdges(eds => addEdge(connection, eds)); setIsDirty(true) },
    [setEdges]
  )

  const onSave = useCallback(async () => {
    const serialized = serializeCanvasData(nodes, edges, projectSettings)
    lastSyncedCanvasRef.current = serialized
    await window.electron.saveCanvas(projectDir, serialized)
    setIsDirty(false)
  }, [projectDir, nodes, edges, projectSettings])

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
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const newNode: ArchitectNodeType = {
        id: `${item.id}-${Date.now()}`,
        type: 'architectNode',
        position,
        data: {
          label: item.label,
          description: item.description,
          category: item.category,
          iconName: item.iconName,
          color: item.color,
          tag: item.tag,
          status: 'idle',
          prompt: '',
          ...createDefaultNodeConfig(projectSettings.defaultRuntime),
        }
      }
      setNodes(nds => [...nds, newNode])
    },
    [projectSettings.defaultRuntime, screenToFlowPosition, setNodes]
  )

  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    onNodesChange(changes)
    const hasSubstantive = changes.some(c => c.type !== 'position' && c.type !== 'select' && c.type !== 'dimensions')
    if (hasSubstantive) {
      setIsDirty(true)
    } else {
      // Position/layout changes: auto-save silently after debounce (no dirty indicator)
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = setTimeout(() => {
        const serialized = serializeCanvasData(nodes, edges, projectSettings)
        lastSyncedCanvasRef.current = serialized
        window.electron.saveCanvas(projectDir, serialized)
      }, 1000)
    }
  }, [onNodesChange, projectDir, nodes, edges, projectSettings])

  const handleEdgesChange = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    onEdgesChange(changes)
    setIsDirty(true)
  }, [onEdgesChange])

  const onClear    = useCallback(() => {
    setNodes([])
    setEdges([])
    setBootstrapSummary(null)
    setIsDirty(true)
  }, [setNodes, setEdges])
  const onLoadDemo = useCallback(() => {
    setNodes(DEMO_NODES.map(node => ({
      ...node,
      data: {
        ...node.data,
        ...createDefaultNodeConfig(projectSettings.defaultRuntime),
      },
    })))
    setEdges(DEMO_EDGES)
    setBootstrapSummary(null)
    setIsDirty(true)
  }, [projectSettings.defaultRuntime, setNodes, setEdges])

  const changedNodes = dispatchedGraph
    ? nodes.filter(n => nodeHash(n) !== dispatchedGraph[n.id])
    : []
  const changedNodeIds = changedNodes.map(node => node.id)
  const changedNodeLabels = changedNodes.map(node => node.data.label)
  const selectedNodeIds = nodes.filter(node => node.selected).map(node => node.id)

  const dispatchGraph = useCallback(async (mode: LaunchScopeMode, nodeIds: string[] = []) => {
    if (nodes.length === 0) return
    const scopedNodeIds = [...new Set(nodeIds)].filter(nodeId => nodes.some(node => node.id === nodeId))
    if (mode !== 'all' && scopedNodeIds.length === 0) return

    const isFullLaunch = mode === 'all'
    const options: RunGraphOptions = {}
    if (!isFullLaunch) {
      options.launchScope = { mode, nodeIds: scopedNodeIds }
    }

    setDispatching(true)
    if (isFullLaunch && dispatchedGraph !== null) {
      options.dispatchContext = { isRedispatch: true, changedNodeIds, changedNodeLabels }
    }

    try {
      const result = await window.electron.runGraph(
        nodes,
        edges,
        projectDir,
        projectSettings,
        Object.keys(options).length > 0 ? options : undefined,
      )
      setTerminalSessions(result.sessions as TerminalInfo[])
      setLastPreflight(result.preflight)
      if (result.sessions.length > 0) setActiveTab('Terminal')
      setLaunchRevision(current => current + 1)
      if (isFullLaunch) {
        // Snapshot the dispatched graph for incremental re-dispatch detection
        const snapshot: Record<string, string> = {}
        for (const n of nodes) snapshot[n.id] = nodeHash(n)
        setDispatchedGraph(snapshot)
      } else {
        setDispatchedGraph(null)
      }
    } finally {
      setDispatching(false)
    }
  }, [nodes, edges, projectDir, projectSettings, dispatchedGraph, changedNodeIds, changedNodeLabels])

  const onDispatch = useCallback(() => {
    void dispatchGraph('all')
  }, [dispatchGraph])

  const onDispatchSelected = useCallback(() => {
    void dispatchGraph('selected', selectedNodeIds)
  }, [dispatchGraph, selectedNodeIds])

  const launchNodes = useCallback(async (nodeIds: string[], mode: Exclude<LaunchScopeMode, 'all'>) => {
    await dispatchGraph(mode, nodeIds)
  }, [dispatchGraph])

  useEffect(() => {
    if (initializingProject) return

    const interval = window.setInterval(() => {
      if (isDirty) return

      void window.electron.loadCanvas(projectDir).then(raw => {
        if (!raw || raw === lastSyncedCanvasRef.current) return
        try {
          const migrated = migrateCanvasData(JSON.parse(raw))
          setNodes(migrated.nodes)
          setEdges(migrated.edges)
          setProjectSettings(migrated.settings)
          setBootstrapSummary(null)
          setDispatchedGraph(null)
          lastSyncedCanvasRef.current = raw
        } catch {}
      })
    }, 1200)

    return () => window.clearInterval(interval)
  }, [initializingProject, isDirty, projectDir, setNodes, setEdges])

  const buildAssistantContext = useCallback((currentNodes: ArchitectNodeType[], currentEdges: Edge[]) => {
    const canvasJson = JSON.stringify({
      nodes: currentNodes.map(n => ({
        id: n.id,
        label: n.data.label,
        description: n.data.description,
        category: n.data.category,
        iconName: n.data.iconName,
        color: n.data.color,
        tag: n.data.tag,
        prompt: n.data.prompt,
        ownedPaths: n.data.ownedPaths,
        expectedFiles: n.data.expectedFiles,
        contracts: n.data.contracts,
        reviewHints: n.data.reviewHints,
      })),
      edges: currentEdges.map(e => ({ id: e.id, source: e.source, target: e.target })),
    }, null, 2)
    const paletteJson = JSON.stringify(palette.map(item => ({
      label: item.label,
      category: item.category,
      iconName: item.iconName,
      color: item.color,
      tag: item.tag,
    })), null, 2)

    return `You are an architecture assistant embedded in Architect — a tool for visually composing multi-agent and software systems.

## Current Canvas
${currentNodes.length === 0 ? '(empty canvas — no nodes yet)' : `\`\`\`json\n${canvasJson}\n\`\`\``}

## Your Role
Help the user design, refine, and reason about their architecture. You can:
- Discuss design decisions, tradeoffs, and patterns
- Suggest components to add, remove, or restructure
- When the user asks to change the diagram, output the complete updated canvas in this exact format (no markdown fences around the block):

ARCHITECT_CANVAS_UPDATE
{"nodes": [...], "edges": [...]}
END_ARCHITECT_CANVAS_UPDATE

The canvas replaces everything on each update, so always include ALL nodes and edges.
Preserve existing node ids whenever possible so the user's layout is not lost.

## Canvas Node Schema
Each node requires: id (kebab-case), label, description (one sentence), category, iconName, color (hex), tag (≤6 chars uppercase), prompt (agent instructions), ownedPaths (string[]), expectedFiles (string[]), contracts (string), reviewHints (string)

Available categories: infrastructure | services | storage | custom

Available iconNames: Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench

## Palette Reference
\`\`\`json
${paletteJson}
\`\`\`

## Valid Example
\`\`\`json
{"nodes":[{"id":"frontend","label":"Frontend","description":"Owns the web UI.","category":"infrastructure","iconName":"Monitor","color":"#f472b6","tag":"UI","prompt":"Continue from the existing frontend implementation. Inspect routes and state boundaries before making changes.","ownedPaths":["frontend"],"expectedFiles":["frontend/src/main.tsx"],"contracts":"Routes, UI state boundaries, and integration points.","reviewHints":"Inspect the app entrypoint and API integration points before editing."},{"id":"api-gateway","label":"API Gateway","description":"Owns the API surface.","category":"infrastructure","iconName":"Shield","color":"#fb923c","tag":"API","prompt":"Continue from the existing API implementation. Preserve contracts and only make the next required delta.","ownedPaths":["server"],"expectedFiles":["server/app.ts"],"contracts":"Request/response contracts and public endpoints.","reviewHints":"Inspect route registration and public interfaces before editing."}],"edges":[{"id":"frontend-to-api","source":"frontend","target":"api-gateway"}]}
\`\`\`

Each edge requires: id, source (node id), target (node id)

Only output ARCHITECT_CANVAS_UPDATE when the user explicitly confirms a change. Otherwise just discuss and advise.`
  }, [])

  const applyCanvasUpdate = useCallback((update: { nodes: unknown[]; edges: unknown[] }) => {
    const rawNodes = (update.nodes ?? []) as Array<Record<string, unknown>>
    const rawEdges = (update.edges ?? []) as Array<{ id?: string; source: string; target: string }>
    const existingNodes = new Map(nodes.map(node => [node.id, node]))
    const existingPositions = new Map(nodes.map(n => [n.id, n.position]))
    const positions = computeLayoutPositions(rawNodes.map(n => String(n.id)), rawEdges)
    const newNodes: ArchitectNodeType[] = rawNodes.map((raw, i) => {
      const id = String(raw.id ?? `gen-${Date.now()}-${i}`)
      const existing = existingNodes.get(id)
      return {
        id,
        type: 'architectNode' as const,
        position: existingPositions.get(id) ?? positions[id] ?? { x: 80 + (i % 3) * 320, y: 80 + Math.floor(i / 3) * 160 },
        data: {
          ...createDefaultNodeConfig(projectSettings.defaultRuntime),
          ...existing?.data,
          label:       String(raw.label       ?? 'Node'),
          description: String(raw.description ?? ''),
          category:    (raw.category as ArchitectNodeType['data']['category']) ?? 'services',
          iconName:    String(raw.iconName ?? 'Settings2'),
          color:       String(raw.color   ?? '#60a5fa'),
          tag:         String(raw.tag     ?? 'NODE'),
          status:      'idle' as const,
          prompt:      String(raw.prompt  ?? ''),
          ownedPaths: Array.isArray(raw.ownedPaths) ? raw.ownedPaths.filter((value): value is string => typeof value === 'string') : (existing?.data.ownedPaths ?? []),
          expectedFiles: Array.isArray(raw.expectedFiles) ? raw.expectedFiles.filter((value): value is string => typeof value === 'string') : (existing?.data.expectedFiles ?? []),
          contracts:   String(raw.contracts   ?? existing?.data.contracts   ?? ''),
          reviewHints: String(raw.reviewHints ?? existing?.data.reviewHints ?? ''),
        },
      }
    })
    const newEdges: Edge[] = rawEdges.map((raw, i) => ({
      id: raw.id ?? `gen-edge-${Date.now()}-${i}`,
      source: raw.source,
      target: raw.target,
    }))
    setNodes(newNodes)
    setEdges(newEdges)
    setBootstrapSummary(null)
    setIsDirty(true)
    setDispatchedGraph(null)
  }, [nodes, projectSettings.defaultRuntime, setNodes, setEdges])

  const handleAssistantToggle = useCallback(async () => {
    if (assistantOpen) {
      window.electron.assistant.stop()
      setAssistantOpen(false)
      setAssistantRuntime(null)
    } else {
      const contextMd = buildAssistantContext(nodes, edges)
      const session = await window.electron.assistant.start(projectDir, contextMd, projectSettings.defaultRuntime)
      setAssistantRuntime(session?.runtime ?? projectSettings.defaultRuntime)
      setAssistantOpen(true)
    }
  }, [assistantOpen, nodes, edges, projectDir, projectSettings.defaultRuntime, buildAssistantContext])

  const handleAssistantClose = useCallback(() => {
    window.electron.assistant.stop()
    setAssistantOpen(false)
    setAssistantRuntime(null)
  }, [])

  const preflightSummaryText = lastPreflight
    ? `${lastPreflight.counts.missing} missing / ${lastPreflight.counts.adopted} adopt / ${lastPreflight.counts.needs_delta} delta / ${lastPreflight.counts.blocked_by_upstream} upstream / ${lastPreflight.counts.unchanged} unchanged`
    : bootstrapSummary

  const isCanvas   = activeTab === 'Canvas'
  const isFiles    = activeTab === 'Files'
  const isTerminal = activeTab === 'Terminal'

  return (
    <ProjectDirectoryProvider value={projectDir}>
      <ProjectSettingsProvider value={projectSettings}>
        <DispatchActionsProvider value={{ dispatching, launchRevision, launchNodes }}>
          <div className="flex flex-col h-screen bg-canvas text-white overflow-hidden">
            <TopNav
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onClear={onClear}
              onLoadDemo={onLoadDemo}
              onDispatch={onDispatch}
              onDispatchSelected={onDispatchSelected}
              dispatching={dispatching}
              nodeCount={nodes.length}
              selectedCount={selectedNodeIds.length}
              projectDir={projectDir}
              onChangeDir={onChangeDir}
              onSave={onSave}
              isDirty={isDirty}
              onAssistantToggle={handleAssistantToggle}
              assistantOpen={assistantOpen}
              isRedispatch={dispatchedGraph !== null}
              changedCount={changedNodeLabels.length}
              preflightSummary={preflightSummaryText}
              projectSettings={projectSettings}
              onDefaultRuntimeChange={(defaultRuntime) => {
                setProjectSettings(current => ({ ...current, defaultRuntime }))
                setIsDirty(true)
                setDispatchedGraph(null)
              }}
            />
            <div className="flex flex-1 overflow-hidden">
              <ResizablePanel side="left" defaultWidth={160}>
                <Sidebar />
              </ResizablePanel>

              <div className={`flex-1 relative ${isCanvas ? '' : 'hidden'}`}>
                {initializingProject ? (
                  <div className="absolute inset-0 flex items-center justify-center text-center px-6">
                    <div>
                      <p className="text-sm text-slate-300">{bootstrapStatus}</p>
                      <p className="text-xs text-slate-600 mt-2">Architect is building a draft canvas from the repo so relaunches can continue from current code instead of starting from zero.</p>
                    </div>
                  </div>
                ) : (
                  <ReactFlow
                    nodes={nodes} edges={edges}
                    onNodesChange={handleNodesChange} onEdgesChange={handleEdgesChange}
                    onConnect={onConnect} onDrop={onDrop} onDragOver={onDragOver}
                    nodeTypes={nodeTypes}
                    defaultEdgeOptions={{ style: { stroke: '#3a3a3a', strokeWidth: 1.5 } }}
                    proOptions={{ hideAttribution: true }}
                    fitView
                  >
                    <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="#2a2a2a" />
                    <Controls />
                  </ReactFlow>
                )}
              </div>

              {isFiles && (
                <div className="flex-1 overflow-hidden">
                  <FilesPanel rootDir={projectDir} />
                </div>
              )}

              <div className={`flex-1 overflow-hidden ${isTerminal ? '' : 'hidden'}`}>
                <TerminalPanel sessions={terminalSessions} isVisible={isTerminal} />
              </div>

              {!isCanvas && !isFiles && !isTerminal && (
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-slate-600 text-sm">{activeTab} — coming soon</span>
                </div>
              )}

              <ResizablePanel key={assistantOpen ? 'assistant' : 'agentlog'} side="right" defaultWidth={assistantOpen ? 420 : 256}>
                {assistantOpen ? (
                  <AssistantPanel
                    onClose={handleAssistantClose}
                    onCanvasUpdate={applyCanvasUpdate}
                    runtime={assistantRuntime ?? projectSettings.defaultRuntime}
                  />
                ) : (
                  <AgentLog projectDir={projectDir} preflight={lastPreflight} />
                )}
              </ResizablePanel>
            </div>
          </div>
        </DispatchActionsProvider>
      </ProjectSettingsProvider>
    </ProjectDirectoryProvider>
  )
}

// ── Root — gates on directory selection ───────────────────────────────────

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
