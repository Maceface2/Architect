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
import ResizablePanel from './components/layout/ResizablePanel'
import { nodeTypes } from './components/nodes/nodeTypes'
import type { ArchitectNodeType } from './types'
import type { PaletteItemConfig } from './data/componentPalette'

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
    id: 'demo-1',
    type: 'architectNode',
    position: { x: 160, y: 160 },
    data: { label: 'React App', description: 'Client UI layer', category: 'infrastructure', iconName: 'Monitor', color: '#f472b6', tag: 'UI', status: 'idle', prompt: '', ...DEFAULT_NODE_CONFIG }
  },
  {
    id: 'demo-2',
    type: 'architectNode',
    position: { x: 480, y: 80 },
    data: { label: 'API Gateway', description: 'Request routing', category: 'infrastructure', iconName: 'Shield', color: '#fb923c', tag: 'API', status: 'idle', prompt: '', ...DEFAULT_NODE_CONFIG }
  },
  {
    id: 'demo-3',
    type: 'architectNode',
    position: { x: 160, y: 320 },
    data: { label: 'PostgreSQL', description: 'Persistent storage', category: 'storage', iconName: 'Database', color: '#60a5fa', tag: 'DB', status: 'idle', prompt: '', ...DEFAULT_NODE_CONFIG }
  },
]

const DEMO_EDGES: Edge[] = [
  { id: 'demo-e1', source: 'demo-1', target: 'demo-2' },
  { id: 'demo-e2', source: 'demo-1', target: 'demo-3' },
]

function ArchitectFlow() {
  const [nodes, setNodes, onNodesChange] = useNodesState<ArchitectNodeType>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [activeTab, setActiveTab] = useState('Canvas')
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
        data: {
          label: item.label,
          description: item.description,
          category: item.category,
          iconName: item.iconName,
          color: item.color,
          tag: item.tag,
          status: 'idle',
          prompt: '',
          ...DEFAULT_NODE_CONFIG,
        }
      }
      setNodes(nds => [...nds, newNode])
    },
    [screenToFlowPosition, setNodes]
  )

  const onClear = useCallback(() => {
    setNodes([])
    setEdges([])
  }, [setNodes, setEdges])

  const onLoadDemo = useCallback(() => {
    setNodes(DEMO_NODES)
    setEdges(DEMO_EDGES)
  }, [setNodes, setEdges])

  const isCanvas = activeTab === 'Canvas'
  const isFiles = activeTab === 'Files'

  return (
    <div className="flex flex-col h-screen bg-canvas text-white overflow-hidden">
      <TopNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClear={onClear}
        onLoadDemo={onLoadDemo}
      />
      <div className="flex flex-1 overflow-hidden">
        <ResizablePanel side="left" defaultWidth={160}>
          <Sidebar />
        </ResizablePanel>

        {/* Canvas — always mounted, hidden when not active to preserve state */}
        <div className={`flex-1 relative ${isCanvas ? '' : 'hidden'}`}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={{
              style: { stroke: '#3a3a3a', strokeWidth: 1.5 },
            }}
            proOptions={{ hideAttribution: true }}
            fitView
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={28}
              size={1.5}
              color="#2a2a2a"
            />
            <Controls />
          </ReactFlow>
        </div>

        {/* Files panel */}
        {isFiles && (
          <div className="flex-1 overflow-hidden">
            <FilesPanel />
          </div>
        )}

        {/* Placeholder for Terminal / Preview */}
        {!isCanvas && !isFiles && (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-slate-600 text-sm">{activeTab} — coming soon</span>
          </div>
        )}

        <ResizablePanel side="right" defaultWidth={256}>
          <AgentLog />
        </ResizablePanel>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <ReactFlowProvider>
      <ArchitectFlow />
    </ReactFlowProvider>
  )
}
