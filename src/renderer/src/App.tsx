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
import GenerateDiagramModal from './components/layout/GenerateDiagramModal'
import Sidebar from './components/layout/Sidebar'
import AgentLog from './components/layout/AgentLog'
import FilesPanel from './components/layout/FilesPanel'
import TerminalPanel from './components/layout/TerminalPanel'
import ResizablePanel from './components/layout/ResizablePanel'
import { nodeTypes } from './components/nodes/nodeTypes'
import type { ArchitectNodeType } from './types'
import type { PaletteItemConfig } from './data/componentPalette'

interface TerminalInfo { id: string; label: string }

const DEFAULT_NODE_CONFIG = {
  openSections: [],
  skills: [],
  tools: { webSearch: false, codeExec: false, fileRead: false, fileWrite: false, apiCalls: false, shell: false },
  behavior: { mode: 'sequential' as const, retries: 0, onFailure: 'stop' as const, timeoutMs: 30000 },
  permissions: { readFiles: false, writeFiles: false, network: false, shell: false },
  envVars: [],
}

const DEMO_NODES: ArchitectNodeType[] = [
  {
    id: 'demo-1', type: 'architectNode', position: { x: 160, y: 160 },
    data: { label: 'React App', description: 'Client UI layer', category: 'infrastructure', iconName: 'Monitor', color: '#f472b6', tag: 'UI', status: 'idle', prompt: '', ...DEFAULT_NODE_CONFIG }
  },
  {
    id: 'demo-2', type: 'architectNode', position: { x: 480, y: 80 },
    data: { label: 'API Gateway', description: 'Request routing', category: 'infrastructure', iconName: 'Shield', color: '#fb923c', tag: 'API', status: 'idle', prompt: '', ...DEFAULT_NODE_CONFIG }
  },
  {
    id: 'demo-3', type: 'architectNode', position: { x: 160, y: 320 },
    data: { label: 'PostgreSQL', description: 'Persistent storage', category: 'storage', iconName: 'Database', color: '#60a5fa', tag: 'DB', status: 'idle', prompt: '', ...DEFAULT_NODE_CONFIG }
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
  const [activeTab, setActiveTab] = useState('Canvas')
  const [terminalSessions, setTerminalSessions] = useState<TerminalInfo[]>([])
  const [dispatching, setDispatching] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [dispatchedGraph, setDispatchedGraph] = useState<Record<string, string> | null>(null)
  const [showGenerateModal, setShowGenerateModal] = useState(false)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { screenToFlowPosition } = useReactFlow()

  // Cleanup auto-save timer on unmount
  useEffect(() => () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current) }, [])

  // Auto-load canvas on mount
  useEffect(() => {
    window.electron.loadCanvas(projectDir).then((raw: string | null) => {
      if (!raw) return
      try {
        const { nodes: savedNodes, edges: savedEdges } = JSON.parse(raw)
        setNodes(savedNodes ?? [])
        setEdges(savedEdges ?? [])
      } catch {}
    })
  }, [projectDir])

  const onConnect = useCallback(
    (connection: Connection) => { setEdges(eds => addEdge(connection, eds)); setIsDirty(true) },
    [setEdges]
  )

  const onSave = useCallback(async () => {
    await window.electron.saveCanvas(projectDir, JSON.stringify({ nodes, edges, savedAt: new Date().toISOString() }))
    setIsDirty(false)
  }, [projectDir, nodes, edges])

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
        data: { label: item.label, description: item.description, category: item.category, iconName: item.iconName, color: item.color, tag: item.tag, status: 'idle', prompt: '', ...DEFAULT_NODE_CONFIG }
      }
      setNodes(nds => [...nds, newNode])
    },
    [screenToFlowPosition, setNodes]
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
        window.electron.saveCanvas(projectDir, JSON.stringify({ nodes, edges, savedAt: new Date().toISOString() }))
      }, 1000)
    }
  }, [onNodesChange, projectDir, nodes, edges])

  const handleEdgesChange = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    onEdgesChange(changes)
    setIsDirty(true)
  }, [onEdgesChange])

  const onClear    = useCallback(() => { setNodes([]); setEdges([]); setIsDirty(true) }, [setNodes, setEdges])
  const onLoadDemo = useCallback(() => { setNodes(DEMO_NODES); setEdges(DEMO_EDGES); setIsDirty(true) }, [setNodes, setEdges])

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
      const sessions = await window.electron.runGraph(nodes, edges, projectDir, dispatchContext)
      setTerminalSessions(sessions)
      setActiveTab('Terminal')
      // Snapshot the dispatched graph for incremental re-dispatch detection
      const snapshot: Record<string, string> = {}
      for (const n of nodes) snapshot[n.id] = nodeHash(n)
      setDispatchedGraph(snapshot)
    } finally {
      setDispatching(false)
    }
  }, [nodes, edges, projectDir, dispatchedGraph, changedNodeLabels])

  const onGenerate = useCallback(async (description: string) => {
    const result = await window.electron.generateDiagram(description)
    if (!result || typeof result !== 'object') throw new Error('Invalid response from diagram generator')
    const rawNodes = (result.nodes ?? []) as Array<Record<string, unknown>>
    const rawEdges = (result.edges ?? []) as Array<{ id?: string; source: string; target: string }>
    const positions = computeLayoutPositions(rawNodes.map(n => String(n.id)), rawEdges)
    const newNodes: ArchitectNodeType[] = rawNodes.map((raw, i) => {
      const id = String(raw.id ?? `gen-${Date.now()}-${i}`)
      return {
        id,
        type: 'architectNode' as const,
        position: positions[id] ?? { x: 80 + (i % 3) * 320, y: 80 + Math.floor(i / 3) * 160 },
        data: {
          label:       String(raw.label       ?? 'Agent'),
          description: String(raw.description ?? ''),
          category:    (raw.category as ArchitectNodeType['data']['category']) ?? 'services',
          iconName:    String(raw.iconName ?? 'Settings2'),
          color:       String(raw.color   ?? '#60a5fa'),
          tag:         String(raw.tag     ?? 'AGENT'),
          status:      'idle' as const,
          prompt:      String(raw.prompt  ?? ''),
          ...DEFAULT_NODE_CONFIG,
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
  }, [setNodes, setEdges])

  const isCanvas   = activeTab === 'Canvas'
  const isFiles    = activeTab === 'Files'
  const isTerminal = activeTab === 'Terminal'

  return (
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
        onGenerateClick={() => setShowGenerateModal(true)}
        isRedispatch={dispatchedGraph !== null}
        changedCount={changedNodeLabels.length}
      />
      {showGenerateModal && (
        <GenerateDiagramModal
          onClose={() => setShowGenerateModal(false)}
          onGenerate={onGenerate}
        />
      )}
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

        <ResizablePanel side="right" defaultWidth={256}>
          <AgentLog projectDir={projectDir} />
        </ResizablePanel>
      </div>
    </div>
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
