import { useState, useCallback } from 'react'
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

// ── Main flow ──────────────────────────────────────────────────────────────

function ArchitectFlow({ projectDir, onChangeDir }: { projectDir: string; onChangeDir: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ArchitectNodeType>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [activeTab, setActiveTab] = useState('Canvas')
  const [terminalSessions, setTerminalSessions] = useState<TerminalInfo[]>([])
  const [dispatching, setDispatching] = useState(false)
  const { screenToFlowPosition } = useReactFlow()

  const onConnect = useCallback(
    (connection: Connection) => setEdges(eds => addEdge(connection, eds)),
    [setEdges]
  )

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

  const onClear    = useCallback(() => { setNodes([]); setEdges([]) }, [setNodes, setEdges])
  const onLoadDemo = useCallback(() => { setNodes(DEMO_NODES); setEdges(DEMO_EDGES) }, [setNodes, setEdges])

  const onDispatch = useCallback(async () => {
    if (nodes.length === 0) return
    setDispatching(true)
    try {
      const sessions = await window.electron.runGraph(nodes, edges, projectDir)
      setTerminalSessions(sessions)
      setActiveTab('Terminal')
    } finally {
      setDispatching(false)
    }
  }, [nodes, edges, projectDir])

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
      />
      <div className="flex flex-1 overflow-hidden">
        <ResizablePanel side="left" defaultWidth={160}>
          <Sidebar />
        </ResizablePanel>

        <div className={`flex-1 relative ${isCanvas ? '' : 'hidden'}`}>
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
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
          <TerminalPanel sessions={terminalSessions} />
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
