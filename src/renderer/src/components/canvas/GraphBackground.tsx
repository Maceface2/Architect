import { useEffect, useRef } from 'react'
import { useViewport } from '@xyflow/react'

interface Props {
  theme: 'dark' | 'light'
}

// Jittered grid network. Nodes sit on a lattice underneath, but heavy jitter
// + per-node + per-edge dropouts mask the lattice so it reads as an irregular
// connected graph rather than a perturbed mesh.
const WORLD_GAP = 62
// Per-node jitter as a fraction of WORLD_GAP. ~0.36 is the upper useful
// bound — past this, neighbors collide into each other.
const JITTER = 0.34
// Probability a given grid slot has a node at all.
const NODE_PROB = 0.92
// Per-direction edge probabilities. Each cell owns its outgoing E / S / SE /
// SW edges; an edge renders only if its hash says yes AND both endpoints
// exist.
const EDGE_PROB_ORTHO = 0.58
const EDGE_PROB_DIAG = 0.28
// Screen-space radius of the cursor spotlight, in CSS px.
const SPOTLIGHT_R = 150

const ACCENT = { r: 226, g: 178, b: 55 } // #E2B237

function dimRgb(theme: 'dark' | 'light', alpha: number): string {
  if (theme === 'light') return `rgba(71, 85, 105, ${alpha})` // slate-600
  return `rgba(120, 108, 96, ${alpha})`                       // warm graphite mid
}

function hash2(ix: number, iy: number): number {
  let h = ((ix | 0) * 73856093) ^ ((iy | 0) * 19349663)
  h = (h ^ (h >>> 13)) * 1274126177
  return (h ^ (h >>> 16)) >>> 0
}

function hash3(ix: number, iy: number, k: number): number {
  let h = ((ix | 0) * 73856093) ^ ((iy | 0) * 19349663) ^ ((k | 0) * 83492791)
  h = (h ^ (h >>> 13)) * 1274126177
  return (h ^ (h >>> 16)) >>> 0
}

function jitterFor(ix: number, iy: number): [number, number] {
  const sx = hash3(ix, iy, 11)
  const sy = hash3(ix, iy, 17)
  const jx = ((sx & 0xffff) / 0xffff - 0.5) * WORLD_GAP * JITTER
  const jy = ((sy & 0xffff) / 0xffff - 0.5) * WORLD_GAP * JITTER
  return [jx, jy]
}

function nodeExistsAt(ix: number, iy: number): boolean {
  return (hash2(ix, iy) % 1000) / 1000 < NODE_PROB
}

// edgeId: 0=E, 1=S, 2=SE, 3=SW. Each cell owns these four outgoing edges so
// there's no double-rendering.
function edgeExistsAt(ix: number, iy: number, edgeId: number): boolean {
  const p = edgeId < 2 ? EDGE_PROB_ORTHO : EDGE_PROB_DIAG
  return (hash3(ix, iy, edgeId + 31) % 1000) / 1000 < p
}

export default function GraphBackground({ theme }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { x: vx, y: vy, zoom } = useViewport()

  const viewportRef = useRef({ vx, vy, zoom })
  viewportRef.current = { vx, vy, zoom }
  const themeRef = useRef(theme)
  themeRef.current = theme
  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({ x: -9999, y: -9999, active: false })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    let rafId = 0
    let cssW = 0
    let cssH = 0

    const fitCanvas = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      cssW = rect.width
      cssH = rect.height
      canvas.width = Math.max(1, Math.round(cssW * dpr))
      canvas.height = Math.max(1, Math.round(cssH * dpr))
    }

    const draw = () => {
      if (!cssW || !cssH) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      const { vx, vy, zoom } = viewportRef.current
      const t = themeRef.current
      const mouse = mouseRef.current

      const gapScreen = WORLD_GAP * zoom
      if (gapScreen < 16) return  // too small to read; skip

      const nodeR = Math.max(1.1, Math.min(2.6, 1.6 * Math.sqrt(zoom)))
      const edgeW = Math.max(0.5, Math.min(1.4, 0.8 * Math.sqrt(zoom)))

      const wx0 = (0 - vx) / zoom
      const wy0 = (0 - vy) / zoom
      const wx1 = (cssW - vx) / zoom
      const wy1 = (cssH - vy) / zoom
      const ix0 = Math.floor(wx0 / WORLD_GAP) - 1
      const iy0 = Math.floor(wy0 / WORLD_GAP) - 1
      const ix1 = Math.ceil(wx1 / WORLD_GAP) + 1
      const iy1 = Math.ceil(wy1 / WORLD_GAP) + 1

      const cols = ix1 - ix0 + 1
      const rows = iy1 - iy0 + 1
      const posX = new Float32Array(cols * rows)
      const posY = new Float32Array(cols * rows)
      const exists = new Uint8Array(cols * rows)
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const [jx, jy] = jitterFor(ix, iy)
          const wx = ix * WORLD_GAP + jx
          const wy = iy * WORLD_GAP + jy
          const k = (iy - iy0) * cols + (ix - ix0)
          posX[k] = wx * zoom + vx
          posY[k] = wy * zoom + vy
          exists[k] = nodeExistsAt(ix, iy) ? 1 : 0
        }
      }

      // Edge bit-mask per cell: 0=E, 1=S, 2=SE, 3=SW. AND'd against both
      // endpoints' existence so dropped nodes never have visible stubs.
      const edgeMask = new Uint8Array(cols * rows)
      for (let iy = iy0; iy < iy1; iy++) {
        for (let ix = ix0; ix < ix1; ix++) {
          const k = (iy - iy0) * cols + (ix - ix0)
          if (!exists[k]) continue
          let m = 0
          if (exists[k + 1] && edgeExistsAt(ix, iy, 0)) m |= 1
          if (exists[k + cols] && edgeExistsAt(ix, iy, 1)) m |= 2
          if (exists[k + cols + 1] && edgeExistsAt(ix, iy, 2)) m |= 4
          if (ix > ix0 && exists[k + cols - 1] && edgeExistsAt(ix, iy, 3)) m |= 8
          edgeMask[k] = m
        }
      }

      const dimEdge = dimRgb(t, 0.22)
      const dimNode = dimRgb(t, 0.55)

      // Dim edges first (under nodes).
      ctx.lineWidth = edgeW
      ctx.strokeStyle = dimEdge
      ctx.beginPath()
      for (let iy = iy0; iy < iy1; iy++) {
        for (let ix = ix0; ix < ix1; ix++) {
          const k = (iy - iy0) * cols + (ix - ix0)
          const m = edgeMask[k]
          if (!m) continue
          const px = posX[k]
          const py = posY[k]
          if (m & 1) { ctx.moveTo(px, py); ctx.lineTo(posX[k + 1], posY[k + 1]) }
          if (m & 2) { ctx.moveTo(px, py); ctx.lineTo(posX[k + cols], posY[k + cols]) }
          if (m & 4) { ctx.moveTo(px, py); ctx.lineTo(posX[k + cols + 1], posY[k + cols + 1]) }
          if (m & 8) { ctx.moveTo(px, py); ctx.lineTo(posX[k + cols - 1], posY[k + cols - 1]) }
        }
      }
      ctx.stroke()

      // Cursor spotlight: re-stroke nearby edges in accent, with alpha falling
      // off with distance from the cursor.
      if (mouse.active) {
        const mx = mouse.x
        const my = mouse.y
        const R = SPOTLIGHT_R
        const R2 = R * R

        const drawHotSegment = (x0: number, y0: number, x1: number, y1: number) => {
          const cx = (x0 + x1) * 0.5
          const cy = (y0 + y1) * 0.5
          const dx = cx - mx
          const dy = cy - my
          const d2 = dx * dx + dy * dy
          if (d2 >= R2) return
          const b = 1 - Math.sqrt(d2) / R
          if (b < 0.05) return
          ctx.strokeStyle = `rgba(${ACCENT.r}, ${ACCENT.g}, ${ACCENT.b}, ${b * 0.42})`
          ctx.lineWidth = edgeW + b * 0.25
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          ctx.stroke()
        }

        for (let iy = iy0; iy < iy1; iy++) {
          for (let ix = ix0; ix < ix1; ix++) {
            const k = (iy - iy0) * cols + (ix - ix0)
            const m = edgeMask[k]
            if (!m) continue
            const px = posX[k]
            const py = posY[k]
            const ndx = px - mx
            const ndy = py - my
            if (ndx * ndx + ndy * ndy > (R + gapScreen * 1.5) * (R + gapScreen * 1.5)) continue
            if (m & 1) drawHotSegment(px, py, posX[k + 1], posY[k + 1])
            if (m & 2) drawHotSegment(px, py, posX[k + cols], posY[k + cols])
            if (m & 4) drawHotSegment(px, py, posX[k + cols + 1], posY[k + cols + 1])
            if (m & 8) drawHotSegment(px, py, posX[k + cols - 1], posY[k + cols - 1])
          }
        }
      }

      // Dim nodes.
      ctx.fillStyle = dimNode
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const k = (iy - iy0) * cols + (ix - ix0)
          if (!exists[k]) continue
          const px = posX[k]
          const py = posY[k]
          if (px < -nodeR || px > cssW + nodeR || py < -nodeR || py > cssH + nodeR) continue
          ctx.beginPath()
          ctx.arc(px, py, nodeR, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Gold spotlight on nodes near the cursor.
      if (mouse.active) {
        const mx = mouse.x
        const my = mouse.y
        const R = SPOTLIGHT_R
        for (let iy = iy0; iy <= iy1; iy++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const k = (iy - iy0) * cols + (ix - ix0)
            if (!exists[k]) continue
            const px = posX[k]
            const py = posY[k]
            if (px < -16 || px > cssW + 16 || py < -16 || py > cssH + 16) continue
            const dx = px - mx
            const dy = py - my
            const d = Math.sqrt(dx * dx + dy * dy)
            if (d >= R) continue
            const b = 1 - d / R
            if (b < 0.05) continue
            const gr = nodeR + 6 * b
            const grad = ctx.createRadialGradient(px, py, 0, px, py, gr)
            grad.addColorStop(0, `rgba(${ACCENT.r}, ${ACCENT.g}, ${ACCENT.b}, ${b * 0.28})`)
            grad.addColorStop(1, `rgba(${ACCENT.r}, ${ACCENT.g}, ${ACCENT.b}, 0)`)
            ctx.fillStyle = grad
            ctx.beginPath()
            ctx.arc(px, py, gr, 0, Math.PI * 2)
            ctx.fill()
            ctx.fillStyle = `rgba(${ACCENT.r}, ${ACCENT.g}, ${ACCENT.b}, ${Math.min(0.7, b * 0.7)})`
            ctx.beginPath()
            ctx.arc(px, py, nodeR + 0.3 * b, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
    }

    const loop = () => {
      draw()
      rafId = requestAnimationFrame(loop)
    }

    fitCanvas()
    const ro = new ResizeObserver(() => {
      fitCanvas()
    })
    if (canvas.parentElement) ro.observe(canvas.parentElement)

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        mouseRef.current = { x: -9999, y: -9999, active: false }
      } else {
        mouseRef.current = { x, y, active: true }
      }
    }
    const onLeave = () => {
      mouseRef.current = { x: -9999, y: -9999, active: false }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerleave', onLeave)

    rafId = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ pointerEvents: 'none' }}
      aria-hidden
    />
  )
}
