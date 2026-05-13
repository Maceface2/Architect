import { useEffect, useState } from 'react'
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant } from '@xyflow/react'
import { nodeTypes } from '../nodes/nodeTypes'
import { edgeTypes } from '../edges/edgeTypes'
import { loadMergedCanvas } from '../../lib/canvas'
import { useWorkspace } from '../../context/WorkspaceContext'
import type { CanvasNode, CanvasEdge } from '../../types'

interface CachedPage {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

const cache = new Map<string, CachedPage>()

export function invalidatePagePreview(pageId: string): void {
  // The cache key embeds the pageId alongside each linked folder's pageId.
  // A single edit could touch any of those, so drop every entry that mentions
  // the changed pageId rather than trying to reconstruct the exact key.
  for (const key of cache.keys()) {
    if (key.includes(pageId)) cache.delete(key)
  }
}

interface Props {
  pageId: string
}

export default function PagePreview({ pageId }: Props) {
  const { primaryFolder } = useWorkspace()
  const cacheKey = `${primaryFolder.path}|${pageId}`
  const [data, setData] = useState<CachedPage | null>(() => cache.get(cacheKey) ?? null)

  // Preview only ever shows the primary (host) project's canvas for the
  // requested page. In multi-directory canvases this intentionally excludes
  // every linked folder's contribution so the thumbnail stays focused on the
  // main project the user is browsing pages of.
  useEffect(() => {
    const cached = cache.get(cacheKey)
    if (cached) {
      setData(cached)
      return
    }
    let cancelled = false
    setData(null)
    void window.electron
      .loadCanvas(primaryFolder.path, pageId)
      .then((raw: string | null) => {
        if (cancelled) return
        const merged = loadMergedCanvas([
          { folderPath: primaryFolder.path, isPrimary: true, raw },
        ])
        const entry: CachedPage = { nodes: merged.nodes, edges: merged.edges }
        cache.set(cacheKey, entry)
        setData(entry)
      })
      .catch(() => {
        if (!cancelled) setData({ nodes: [], edges: [] })
      })
    return () => {
      cancelled = true
    }
  }, [cacheKey, pageId, primaryFolder.path])

  if (!data) {
    return (
      <div className="w-full h-full flex items-center justify-center text-[10px] text-fg-subtle font-mono">
        loading…
      </div>
    )
  }

  if (data.nodes.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-[10px] text-fg-subtle font-mono">
        empty page
      </div>
    )
  }

  return (
    <div className="w-full h-full pointer-events-none">
      <ReactFlowProvider>
      <ReactFlow
        nodes={data.nodes}
        edges={data.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{
          type: 'component-edge',
          style: { stroke: '#3a3a3a', strokeWidth: 1.5 },
        }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.01}
        maxZoom={3}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.4} color="#515151" />
      </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
