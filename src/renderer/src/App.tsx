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
import type { ArchitectNodeType, ProjectSettings } from './types'
import type { PaletteItemConfig } from './data/componentPalette'
import { createDefaultNodeConfig, createDefaultProjectSettings, migrateCanvasData } from './lib/canvas'
import { ProjectSettingsProvider } from './context/ProjectSettingsContext'
import type { AgentRuntime } from '../../shared/agentRuntimes'

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
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantRuntime, setAssistantRuntime] = useState<AgentRuntime | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { screenToFlowPosition } = useReactFlow()

  // Cleanup auto-save timer on unmount
  useEffect(() => () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current) }, [])

  // Auto-load canvas on mount
  useEffect(() => {
    window.electron.loadCanvas(projectDir).then((raw: string | null) => {
      if (!raw) return
      try {
        const migrated = migrateCanvasData(JSON.parse(raw))
        setNodes(migrated.nodes)
        setEdges(migrated.edges)
        setProjectSettings(migrated.settings)
      } catch {}
    })
  }, [projectDir])

  const onConnect = useCallback(
    (connection: Connection) => { setEdges(eds => addEdge(connection, eds)); setIsDirty(true) },
    [setEdges]
  )

  const onSave = useCallback(async () => {
    await window.electron.saveCanvas(projectDir, JSON.stringify({
      nodes,
      edges,
      settings: projectSettings,
      savedAt: new Date().toISOString(),
    }))
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
        window.electron.saveCanvas(projectDir, JSON.stringify({
          nodes,
          edges,
          settings: projectSettings,
          savedAt: new Date().toISOString(),
        }))
      }, 1000)
    }
  }, [onNodesChange, projectDir, nodes, edges, projectSettings])

  const handleEdgesChange = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    onEdgesChange(changes)
    setIsDirty(true)
  }, [onEdgesChange])

  const onClear    = useCallback(() => { setNodes([]); setEdges([]); setIsDirty(true) }, [setNodes, setEdges])
  const onLoadDemo = useCallback(() => {
    setNodes(DEMO_NODES.map(node => ({
      ...node,
      data: {
        ...node.data,
        ...createDefaultNodeConfig(projectSettings.defaultRuntime),
      },
    })))
    setEdges(DEMO_EDGES)
    setIsDirty(true)
  }, [projectSettings.defaultRuntime, setNodes, setEdges])

  const changedNodeLabels = dispatchedGraph
    ? nodes.filter(n => nodeHash(n) !== dispatchedGraph[n.id]).map(n => n.data.label)
    : []

  const onDispatch = useCallback(async () => {
    if (nodes.length === 0) return
    setDispatching(true)
    const isRedispatch = dispatchedGraph !== null
    const dispatchContext = isRedispatch
      ? { isRedispatch: true, changedNodeLabels }
      : undefined
    try {
      const sessions = await window.electron.runGraph(nodes, edges, projectDir, projectSettings, dispatchContext)
      setTerminalSessions(sessions)
      setActiveTab('Terminal')
      // Snapshot the dispatched graph for incremental re-dispatch detection
      const snapshot: Record<string, string> = {}
      for (const n of nodes) snapshot[n.id] = nodeHash(n)
      setDispatchedGraph(snapshot)
    } finally {
      setDispatching(false)
    }
  }, [nodes, edges, projectDir, projectSettings, dispatchedGraph, changedNodeLabels])

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
      })),
      edges: currentEdges.map(e => ({ id: e.id, source: e.source, target: e.target })),
    }, null, 2)

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
Each node requires: id (kebab-case), label, description (one sentence), category, iconName, color (hex), tag (≤6 chars uppercase), prompt (agent instructions, may be empty)

Available categories: infrastructure | services | storage | custom

Available iconNames: Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench

Each edge requires: id, source (node id), target (node id)

Only output ARCHITECT_CANVAS_UPDATE when the user explicitly confirms a change. Otherwise just discuss and advise.`
  }, [])

  const applyCanvasUpdate = useCallback((update: { nodes: unknown[]; edges: unknown[] }) => {
    const rawNodes = (update.nodes ?? []) as Array<Record<string, unknown>>
    const rawEdges = (update.edges ?? []) as Array<{ id?: string; source: string; target: string }>
    const existingPositions = new Map(nodes.map(n => [n.id, n.position]))
    const positions = computeLayoutPositions(rawNodes.map(n => String(n.id)), rawEdges)
    const newNodes: ArchitectNodeType[] = rawNodes.map((raw, i) => {
      const id = String(raw.id ?? `gen-${Date.now()}-${i}`)
      return {
        id,
        type: 'architectNode' as const,
        position: existingPositions.get(id) ?? positions[id] ?? { x: 80 + (i % 3) * 320, y: 80 + Math.floor(i / 3) * 160 },
        data: {
          label:       String(raw.label       ?? 'Node'),
          description: String(raw.description ?? ''),
          category:    (raw.category as ArchitectNodeType['data']['category']) ?? 'services',
          iconName:    String(raw.iconName ?? 'Settings2'),
          color:       String(raw.color   ?? '#60a5fa'),
          tag:         String(raw.tag     ?? 'NODE'),
          status:      'idle' as const,
          prompt:      String(raw.prompt  ?? ''),
          ...createDefaultNodeConfig(projectSettings.defaultRuntime),
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

  const isCanvas   = activeTab === 'Canvas'
  const isFiles    = activeTab === 'Files'
  const isTerminal = activeTab === 'Terminal'

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
          nodeCount={nodes.length}
          projectDir={projectDir}
          onChangeDir={onChangeDir}
          onSave={onSave}
          isDirty={isDirty}
          onAssistantToggle={handleAssistantToggle}
          assistantOpen={assistantOpen}
          isRedispatch={dispatchedGraph !== null}
          changedCount={changedNodeLabels.length}
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
              <AgentLog projectDir={projectDir} />
            )}
          </ResizablePanel>
        </div>
      </div>
    </ProjectSettingsProvider>
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
