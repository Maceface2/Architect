import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ViewportPortal, getNodesBounds, useReactFlow } from '@xyflow/react'
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
// is expected to use `nearestFolderForPoint` or fall back to the primary.
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

// Squared distance from a point to a region's nearest edge. Returns 0 when
// the point is inside the region. Squared so callers can compare without
// taking a square root.
function squaredDistanceToRegion(
  region: FolderRegion,
  point: { x: number; y: number },
): number {
  const dx = Math.max(region.x - point.x, 0, point.x - (region.x + region.width))
  const dy = Math.max(region.y - point.y, 0, point.y - (region.y + region.height))
  return dx * dx + dy * dy
}

// Closest folder region to a point. Inside hits return distance 0 and
// short-circuit the comparison loop, so this is a drop-in replacement for
// the contains-only `folderForPoint` when callers want a "snap to nearest"
// fallback for clicks outside every region.
export function nearestFolderForPoint(
  regions: FolderRegion[],
  point: { x: number; y: number },
): FolderRegion | null {
  let best: FolderRegion | null = null
  let bestDist = Infinity
  for (const region of regions) {
    const d = squaredDistanceToRegion(region, point)
    if (d < bestDist) {
      best = region
      bestDist = d
      if (d === 0) break
    }
  }
  return best
}

export function useFolderRegions(nodes: CanvasNode[]): FolderRegion[] {
  const { loadedFolders } = useWorkspace()
  return useMemo(() => computeFolderRegions(nodes, loadedFolders), [nodes, loadedFolders])
}

// Visual chrome layer rendered behind the React Flow node graph. The portal
// wraps content in the transformed viewport so the frames pan and zoom in
// lockstep with the canvas. Single-folder workspaces render nothing — the
// extra frame would just clutter the existing single-project UX.
export interface EmptyOffset { dx: number; dy: number }
export interface EmptyBase { x: number; y: number }

export interface FolderRegionsProps {
  nodes: CanvasNode[]
  emptyOffsets: Record<string, EmptyOffset>
  setEmptyOffsets: React.Dispatch<React.SetStateAction<Record<string, EmptyOffset>>>
  emptyBasesRef: React.MutableRefObject<Record<string, EmptyBase>>
}

// Apply the lifted empty-region offsets + pinned base positions to the raw
// regions produced by computeFolderRegions. App.tsx uses the same helper
// before geometric drop targeting so a moved placeholder is hittable in
// its visual location.
export function applyEmptyAdjustments(
  regions: FolderRegion[],
  emptyOffsets: Record<string, EmptyOffset>,
  emptyBases: Record<string, EmptyBase>,
): FolderRegion[] {
  return regions.map(r => {
    if (!r.isEmpty) return r
    const base = emptyBases[r.folderPath]
    const off = emptyOffsets[r.folderPath]
    if (!base && !off) return r
    return {
      ...r,
      x: (base?.x ?? r.x) + (off?.dx ?? 0),
      y: (base?.y ?? r.y) + (off?.dy ?? 0),
    }
  })
}

export default function FolderRegions({ nodes, emptyOffsets, setEmptyOffsets, emptyBasesRef }: FolderRegionsProps) {
  const { loadedFolders, activePage } = useWorkspace()
  const regions = useFolderRegions(nodes)
  const { setNodes, getViewport } = useReactFlow<CanvasNode>()
  const hostPath = loadedFolders[0]?.path

  useEffect(() => {
    const currentEmptyPaths = new Set(regions.filter(r => r.isEmpty).map(r => r.folderPath))

    // Seed bases for newly-empty folders and forget bases that filled or
    // were unloaded.
    for (const r of regions) {
      if (r.isEmpty && !(r.folderPath in emptyBasesRef.current)) {
        emptyBasesRef.current[r.folderPath] = { x: r.x, y: r.y }
      }
    }
    for (const k of Object.keys(emptyBasesRef.current)) {
      if (!currentEmptyPaths.has(k)) {
        delete emptyBasesRef.current[k]
      }
    }

    setEmptyOffsets(prev => {
      let changed = false
      const next: typeof prev = {}
      for (const r of regions) {
        if (r.isEmpty && prev[r.folderPath]) {
          next[r.folderPath] = prev[r.folderPath]
        } else if (!r.isEmpty && prev[r.folderPath]) {
          changed = true
        }
      }
      for (const k of Object.keys(prev)) {
        if (!(k in next)) changed = true
      }
      return changed ? next : prev
    })
  }, [regions, setEmptyOffsets, emptyBasesRef])

  // Drag the folder chip to move every node tagged with that folder by the
  // same canvas-space delta. Region rectangles are derived from node bounds,
  // so they follow automatically. Empty regions ride along too — their
  // placeholder origin shifts because the next render recomputes from the
  // (still-empty) set, so we ALSO bump every other folder's stack cursor by
  // letting react re-derive; for now empty regions stay where they are
  // since they own no nodes to translate.
  const beginDragRegion = useCallback(
    (e: React.MouseEvent, folderPath: string, isEmpty: boolean) => {
      e.preventDefault()
      e.stopPropagation()
      let lastX = e.clientX
      let lastY = e.clientY
      const onMove = (ev: MouseEvent) => {
        const { zoom } = getViewport()
        const dx = (ev.clientX - lastX) / zoom
        const dy = (ev.clientY - lastY) / zoom
        lastX = ev.clientX
        lastY = ev.clientY
        if (isEmpty) {
          setEmptyOffsets(prev => {
            const cur = prev[folderPath] ?? { dx: 0, dy: 0 }
            return { ...prev, [folderPath]: { dx: cur.dx + dx, dy: cur.dy + dy } }
          })
          return
        }
        setNodes(prev =>
          prev.map(n => {
            const tag = getNodeFolderPath(n) ?? hostPath
            if (tag !== folderPath) return n
            return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
          }),
        )
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'grabbing'
    },
    [setNodes, getViewport, hostPath, setEmptyOffsets],
  )

  // pageId -> name for every linked folder. Fetched once per active-page
  // change so the region chrome can show "<folder> · <linked page name>"
  // without baking the name into the PageLink schema.
  const [linkedPageNameByFolder, setLinkedPageNameByFolder] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const links = activePage.links
    if (links.length === 0) {
      setLinkedPageNameByFolder({})
      return
    }
    void Promise.all(
      links.map(async link => {
        const res = await window.electron.workspace.listPagesInFolder(link.folderPath)
        const name = res.ok ? res.pages.find(p => p.id === link.pageId)?.name : undefined
        return { folderPath: link.folderPath, name: name ?? '' }
      }),
    ).then(results => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const r of results) if (r.name) next[r.folderPath] = r.name
      setLinkedPageNameByFolder(next)
    })
    return () => { cancelled = true }
  }, [activePage])

  if (loadedFolders.length < 2) return null
  return (
    <ViewportPortal>
      {regions.map(region => {
        const pageName = region.isPrimary
          ? activePage.name
          : linkedPageNameByFolder[region.folderPath]
        const offset = region.isEmpty ? emptyOffsets[region.folderPath] : undefined
        // For empty regions, anchor to the first-observed base so the host's
        // movement doesn't carry the placeholder along. For filled regions
        // the bounds already track their own nodes.
        const baseX = region.isEmpty
          ? emptyBasesRef.current[region.folderPath]?.x ?? region.x
          : region.x
        const baseY = region.isEmpty
          ? emptyBasesRef.current[region.folderPath]?.y ?? region.y
          : region.y
        const renderX = baseX + (offset?.dx ?? 0)
        const renderY = baseY + (offset?.dy ?? 0)
        return (
          <div
            key={region.folderPath}
            style={{
              position: 'absolute',
              left: renderX,
              top: renderY,
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
              onMouseDown={e => beginDragRegion(e, region.folderPath, region.isEmpty)}
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
                pointerEvents: 'auto',
                cursor: 'grab',
                userSelect: 'none',
              }}
              title="Drag to move every node tagged with this folder"
            >
              {region.label}
              {region.isPrimary ? ' · primary' : ''}
              {pageName ? (
                <span style={{ marginLeft: 6, opacity: 0.7 }}>
                  · /{pageName}
                </span>
              ) : null}
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
        )
      })}
    </ViewportPortal>
  )
}
