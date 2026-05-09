import { useMemo } from 'react'
import { ViewportPortal, getNodesBounds } from '@xyflow/react'
import type { CanvasNode } from '../../types'
import type { LoadedFolder } from '../../context/WorkspaceContext'
import { useWorkspace } from '../../context/WorkspaceContext'
import { getNodeFolderPath } from '../../lib/canvas'

const REGION_PADDING = 36

export interface FolderRegion {
  folderPath: string
  label: string
  color: string
  isPrimary: boolean
  x: number
  y: number
  width: number
  height: number
}

// Compute one bounding rectangle per loaded folder using the nodes tagged
// with that folder. Empty folders (no nodes) are skipped — a zero-size
// frame would be visual noise. The hook variant just memoizes the helper.
export function computeFolderRegions(
  nodes: CanvasNode[],
  loadedFolders: LoadedFolder[],
): FolderRegion[] {
  if (loadedFolders.length === 0) return []
  const byFolder = new Map<string, CanvasNode[]>()
  for (const folder of loadedFolders) byFolder.set(folder.path, [])
  for (const node of nodes) {
    const tagged = getNodeFolderPath(node)
    const target = tagged && byFolder.has(tagged) ? tagged : loadedFolders[0]?.path
    if (!target) continue
    byFolder.get(target)!.push(node)
  }
  const regions: FolderRegion[] = []
  for (const folder of loadedFolders) {
    const members = byFolder.get(folder.path) ?? []
    if (members.length === 0) continue
    const bounds = getNodesBounds(members)
    regions.push({
      folderPath: folder.path,
      label: folder.label,
      color: folder.color,
      isPrimary: folder.isPrimary,
      x: bounds.x - REGION_PADDING,
      y: bounds.y - REGION_PADDING,
      width: bounds.width + REGION_PADDING * 2,
      height: bounds.height + REGION_PADDING * 2,
    })
  }
  return regions
}

// Geometric drop targeting: which folder's region contains a given canvas
// point? Walks regions in load order so the primary wins ties (it's at
// index 0). Returns null when the point sits outside every region — caller
// is expected to fall back to the primary folder path.
export function folderForPoint(
  regions: FolderRegion[],
  point: { x: number; y: number },
): FolderRegion | null {
  for (const region of regions) {
    if (
      point.x >= region.x &&
      point.x <= region.x + region.width &&
      point.y >= region.y &&
      point.y <= region.y + region.height
    ) {
      return region
    }
  }
  return null
}

export function useFolderRegions(nodes: CanvasNode[]): FolderRegion[] {
  const { loadedFolders } = useWorkspace()
  return useMemo(() => computeFolderRegions(nodes, loadedFolders), [nodes, loadedFolders])
}

// Visual chrome layer rendered behind the React Flow node graph. The portal
// wraps content in the transformed viewport so the frames pan and zoom in
// lockstep with the canvas. Single-folder workspaces render nothing — the
// extra frame would just clutter the existing single-project UX.
export default function FolderRegions({ nodes }: { nodes: CanvasNode[] }) {
  const { loadedFolders } = useWorkspace()
  const regions = useFolderRegions(nodes)
  if (loadedFolders.length < 2) return null
  if (regions.length === 0) return null
  return (
    <ViewportPortal>
      {regions.map(region => (
        <div
          key={region.folderPath}
          style={{
            position: 'absolute',
            left: region.x,
            top: region.y,
            width: region.width,
            height: region.height,
            pointerEvents: 'none',
            border: `1.5px dashed ${region.color}`,
            borderRadius: 12,
            // Keep the chrome subtly washed-out so it sits behind nodes without
            // dominating the canvas.
            background: `${region.color}0A`,
            zIndex: 0,
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: -22,
              left: 8,
              padding: '2px 8px',
              fontSize: 11,
              fontFamily: 'monospace',
              color: region.color,
              background: '#111111',
              border: `1px solid ${region.color}`,
              borderRadius: 4,
              letterSpacing: 0.5,
              whiteSpace: 'nowrap',
            }}
          >
            {region.label}
            {region.isPrimary ? ' · primary' : ''}
          </div>
        </div>
      ))}
    </ViewportPortal>
  )
}
