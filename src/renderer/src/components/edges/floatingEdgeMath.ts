import { Position, type InternalNode } from '@xyflow/react'

// Floating-edge anchor math (the documented @xyflow pattern): edges have no
// fixed ports — each render computes where the center-to-center line exits
// the source card and enters the target card, so the edge re-anchors to the
// nearest side as cards move.

// Cards render measured; these fallbacks only cover the first frame before
// measurement. Kept near the card's real footprint (min-w 210px).
const FALLBACK_W = 210
const FALLBACK_H = 64

function nodeRect(node: InternalNode): { x: number; y: number; w: number; h: number } {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? FALLBACK_W,
    h: node.measured.height ?? FALLBACK_H,
  }
}

// Point where the line from `node`'s center toward `other`'s center crosses
// `node`'s border rect.
function getNodeIntersection(node: InternalNode, other: InternalNode): { x: number; y: number } {
  const a = nodeRect(node)
  const b = nodeRect(other)

  const w = a.w / 2
  const h = a.h / 2
  const x2 = a.x + w
  const y2 = a.y + h
  const x1 = b.x + b.w / 2
  const y1 = b.y + b.h / 2

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h)
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h)
  const denom = Math.abs(xx1) + Math.abs(yy1)
  if (denom === 0) return { x: x2, y: y2 }
  const xx3 = (1 / denom) * xx1
  const yy3 = (1 / denom) * yy1

  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 }
}

// Which side of the node the intersection point sits on — feeds the bezier
// control-point direction.
function getEdgePosition(node: InternalNode, point: { x: number; y: number }): Position {
  const r = nodeRect(node)
  const nx = Math.round(r.x)
  const ny = Math.round(r.y)
  const px = Math.round(point.x)
  const py = Math.round(point.y)

  if (px <= nx + 1) return Position.Left
  if (px >= nx + r.w - 1) return Position.Right
  if (py <= ny + 1) return Position.Top
  if (py >= ny + r.h - 1) return Position.Bottom
  return Position.Top
}

export function getEdgeParams(
  source: InternalNode,
  target: InternalNode,
): { sx: number; sy: number; tx: number; ty: number; sourcePos: Position; targetPos: Position } {
  const sourcePoint = getNodeIntersection(source, target)
  const targetPoint = getNodeIntersection(target, source)
  return {
    sx: sourcePoint.x,
    sy: sourcePoint.y,
    tx: targetPoint.x,
    ty: targetPoint.y,
    sourcePos: getEdgePosition(source, sourcePoint),
    targetPos: getEdgePosition(target, targetPoint),
  }
}
