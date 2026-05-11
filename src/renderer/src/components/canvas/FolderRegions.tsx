import { useMemo } from 'react'
import { ViewportPortal, getNodesBounds } from '@xyflow/react'
import type { CanvasNode } from '../../types'
import type { LoadedFolder } from '../../context/WorkspaceContext'
import { useWorkspace } from '../../context/WorkspaceContext'
import { getNodeFolderPath } from '../../lib/canvas'

const REGION_PADDING = 36
const PLACEHOLDER_WIDTH = 520
const PLACEHOLDER_HEIGHT = 360
const PLACEHOLDER_GAP = 80

export interface FolderRegion {
  folderPath: string
  label: string
  color: string
  isPrimary: boolean
  isEmpty: boolean
  x: number
  y: number
  width: number
  height: number
}

// Compute one bounding rectangle per loaded folder using the nodes tagged
// with that folder. Empty folders get a placeholder rect so the user has
// (a) a visible drop target and (b) a region that `folderForPoint` can
// resolve to — without it, dropping into a freshly-added folder always
// falls back to the primary folder. Placeholders stack horizontally to the
// right of the rightmost filled region (or at the canvas origin if every
// folder is empty).
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

  const filledRects = new Map<string, { x: number; y: number; width: number; height: number }>()
  let maxRight = 0
  let minTop = 0
  let hasFilled = false
  for (const folder of loadedFolders) {
    const members = byFolder.get(folder.path) ?? []
    if (members.length === 0) continue
    const bounds = getNodesBounds(members)
    const rect = {
      x: bounds.x - REGION_PADDING,
      y: bounds.y - REGION_PADDING,
      width: bounds.width + REGION_PADDING * 2,
      height: bounds.height + REGION_PADDING * 2,
    }
    filledRects.set(folder.path, rect)
    const right = rect.x + rect.width
    if (!hasFilled) {
      maxRight = right
      minTop = rect.y
      hasFilled = true
    } else {
      if (right > maxRight) maxRight = right
      if (rect.y < minTop) minTop = rect.y
    }
  }

  let cursorX = hasFilled ? maxRight + PLACEHOLDER_GAP : 0
  const cursorY = hasFilled ? minTop : 0

  const regions: FolderRegion[] = []
  for (const folder of loadedFolders) {
    const filled = filledRects.get(folder.path)
    if (filled) {
      regions.push({
        folderPath: folder.path,
        label: folder.label,
        color: folder.color,
        isPrimary: folder.isPrimary,
        isEmpty: false,
        ...filled,
      })
    } else {
      regions.push({
        folderPath: folder.path,
        label: folder.label,
        color: folder.color,
        isPrimary: folder.isPrimary,
        isEmpty: true,
        x: cursorX,
        y: cursorY,
        width: PLACEHOLDER_WIDTH,
        height: PLACEHOLDER_HEIGHT,
      })
      cursorX += PLACEHOLDER_WIDTH + PLACEHOLDER_GAP
    }
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
          {region.isEmpty ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontFamily: 'monospace',
                color: `${region.color}99`,
                letterSpacing: 0.4,
                textAlign: 'center',
                padding: 24,
              }}
            >
              empty · drop a zone or component here
            </div>
          ) : null}
        </div>
      ))}
    </ViewportPortal>
  )
}
