import { useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { ExternalLink, RotateCcw, Terminal as TerminalIcon, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getAgentRuntime, type AgentRuntime } from '../../../../shared/agentRuntimes'
import type { LayoutNode, PaneNode, TerminalLayout, DropEdge } from './terminalLayoutTypes'
import {
  emptyLayout,
  migrateLayout,
  moveTabToPane,
  reorderTabs,
  setActiveTab,
  setPoppedOut,
  setSplitSizes,
  splitPaneWithTab,
} from './terminalLayoutOps'

interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime | 'shell'
}

interface Props {
  sessions: TerminalInfo[]
  isVisible: boolean
  projectDir: string
  layout: TerminalLayout | null
  onLayoutChange: (next: TerminalLayout) => void
}

const TERM_THEME = {
  background:  '#0d0d0d',
  foreground:  '#e2e8f0',
  cursor:      '#58A6FF',
  cursorAccent:'#0d0d0d',
  black:       '#1e1e1e',
  red:         '#f87171',
  green:       '#4ade80',
  yellow:      '#fbbf24',
  blue:        '#58A6FF',
  magenta:     '#c084fc',
  cyan:        '#38bdf8',
  white:       '#e2e8f0',
  brightBlack: '#3a3a3a',
  brightWhite: '#ffffff',
}

const TAB_DRAG_MIME = 'application/architect-terminal-tab'

// One xterm instance per terminal id, persisted across pane moves & tab switches.
const termInstances = new Map<string, { term: Terminal; fit: FitAddon }>()

function TermTab({ info, active }: { info: TerminalInfo; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    let instance = termInstances.get(info.id)
    if (!instance) {
      const term = new Terminal({
        theme: TERM_THEME,
        fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        allowTransparency: false,
        scrollback: 5000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      instance = { term, fit }
      termInstances.set(info.id, instance)

      term.onData(data => {
        window.electron.terminal.input(info.id, data)
      })
    }

    const { term, fit } = instance

    // First mount: open the terminal here. Subsequent mounts (different pane):
    // physically move the existing element so we don't double-init xterm.
    if (!term.element) {
      try { term.open(containerRef.current) } catch {}
    } else if (term.element.parentElement !== containerRef.current) {
      containerRef.current.appendChild(term.element)
    }

    const doFit = () => {
      try {
        fit.fit()
        window.electron.terminal.resize(info.id, term.cols, term.rows)
      } catch {}
    }

    if (active) {
      doFit()
      const ro = new ResizeObserver(doFit)
      ro.observe(containerRef.current)
      return () => ro.disconnect()
    }
  }, [info.id, active])

  // Stream data → term (subscribed once per id, regardless of mount).
  useEffect(() => {
    const unsub = window.electron.terminal.onData(({ id, data }) => {
      if (id === info.id) termInstances.get(info.id)?.term.write(data)
    })
    return unsub
  }, [info.id])

  useEffect(() => {
    const unsub = window.electron.terminal.onExit(({ id }) => {
      if (id === info.id) {
        termInstances.get(info.id)?.term.write('\r\n\x1b[33m[process exited]\x1b[0m\r\n')
      }
    })
    return unsub
  }, [info.id])

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ display: active ? 'block' : 'none' }}
    />
  )
}

function detectDropEdge(rect: DOMRect, x: number, y: number): DropEdge {
  const px = (x - rect.left) / rect.width
  const py = (y - rect.top) / rect.height
  // Center 50% → tab move; outer ring → directional split.
  if (px >= 0.25 && px <= 0.75 && py >= 0.25 && py <= 0.75) return 'center'
  // Pick the edge with the largest distance from center.
  const left = px
  const right = 1 - px
  const top = py
  const bottom = 1 - py
  const min = Math.min(left, right, top, bottom)
  if (min === left) return 'left'
  if (min === right) return 'right'
  if (min === top) return 'top'
  return 'bottom'
}

function PaneView({
  pane,
  sessionsById,
  exitedIds,
  resumableIds,
  resumingIds,
  onActivate,
  onMoveTab,
  onReorder,
  onSplitDrop,
  onPopout,
  onClose,
  onResume,
  paneCount,
}: {
  pane: PaneNode
  sessionsById: Map<string, TerminalInfo>
  exitedIds: Set<string>
  resumableIds: Map<string, string>
  resumingIds: Set<string>
  onActivate: (paneId: string, tabId: string) => void
  onMoveTab: (tabId: string, targetPaneId: string, idx?: number) => void
  onReorder: (paneId: string, fromIdx: number, toIdx: number) => void
  onSplitDrop: (paneId: string, tabId: string, edge: DropEdge) => void
  onPopout: (info: TerminalInfo) => void
  onClose: (tabId: string) => void
  onResume: (info: TerminalInfo) => void
  paneCount: number
}) {
  const [dropHint, setDropHint] = useState<DropEdge | null>(null)
  const [tabDropIdx, setTabDropIdx] = useState<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const handleStripDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const strip = e.currentTarget as HTMLElement
    const tabs = Array.from(strip.querySelectorAll('[data-tab-id]')) as HTMLElement[]
    let idx = tabs.length
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect()
      if (e.clientX < r.left + r.width / 2) { idx = i; break }
    }
    setTabDropIdx(idx)
  }

  const handleStripDrop = (e: React.DragEvent) => {
    const tabId = e.dataTransfer.getData(TAB_DRAG_MIME)
    if (!tabId) return
    e.preventDefault()
    const idx = tabDropIdx ?? pane.tabs.length
    setTabDropIdx(null)
    if (pane.tabs.includes(tabId)) {
      const from = pane.tabs.indexOf(tabId)
      const insertIdx = from < idx ? idx - 1 : idx
      onReorder(pane.id, from, insertIdx)
    } else {
      onMoveTab(tabId, pane.id, idx)
    }
  }

  const handleBodyDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!bodyRef.current) return
    const rect = bodyRef.current.getBoundingClientRect()
    setDropHint(detectDropEdge(rect, e.clientX, e.clientY))
  }

  const handleBodyDrop = (e: React.DragEvent) => {
    const tabId = e.dataTransfer.getData(TAB_DRAG_MIME)
    if (!tabId) return
    e.preventDefault()
    const edge = dropHint ?? 'center'
    setDropHint(null)
    onSplitDrop(pane.id, tabId, edge)
  }

  return (
    <div className="flex flex-col h-full bg-[#0d0d0d] min-w-0 min-h-0">
      <div
        className="flex items-center gap-0 border-b border-white/[0.06] flex-shrink-0 overflow-x-auto relative"
        onDragOver={handleStripDragOver}
        onDragLeave={() => setTabDropIdx(null)}
        onDrop={handleStripDrop}
      >
        {pane.tabs.map((tabId, i) => {
          const s = sessionsById.get(tabId)
          if (!s) return null
          const isShell = s.runtime === 'shell'
          const isArchitect = s.id === 'architect-agent'
          const isActive = tabId === pane.activeTab
          const runtime = isShell ? null : getAgentRuntime(s.runtime as AgentRuntime)
          const canResume = !isShell && s.runtime === 'claude' && exitedIds.has(s.id) && resumableIds.has(s.id)
          const isResuming = resumingIds.has(s.id)
          return (
            <Fragment key={tabId}>
              {tabDropIdx === i && (
                <div className="w-0.5 self-stretch bg-[#58A6FF]" />
              )}
              <div
                data-tab-id={tabId}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TAB_DRAG_MIME, tabId)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                className={`flex items-center border-b-2 transition-colors flex-shrink-0 ${
                  isActive
                    ? 'border-[#58A6FF] bg-white/[0.04]'
                    : 'border-transparent hover:bg-white/[0.02]'
                }`}
              >
                <button
                  onClick={() => onActivate(pane.id, tabId)}
                  className={`flex items-center gap-2 pl-3 pr-2 py-2 text-xs whitespace-nowrap ${
                    isActive ? 'text-white' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {isShell ? (
                    <TerminalIcon size={12} className="text-emerald-400 flex-shrink-0" />
                  ) : (
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        isArchitect ? 'bg-[#c084fc]' : 'bg-[#58A6FF]'
                      } ${exitedIds.has(s.id) ? 'opacity-30' : ''}`}
                    />
                  )}
                  <span className={exitedIds.has(s.id) && !isShell ? 'opacity-60' : ''}>
                    {isShell ? 'Shell' : isArchitect ? '⬡ Architect' : s.label}
                  </span>
                  {runtime && (
                    <span
                      className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider"
                      style={{ color: runtime.accentColor, backgroundColor: `${runtime.accentColor}20` }}
                    >
                      {runtime.shortLabel}
                    </span>
                  )}
                </button>
                {canResume && (
                  <button
                    onClick={() => onResume(s)}
                    disabled={isResuming}
                    className={`flex items-center justify-center w-6 h-6 rounded text-[10px] transition-colors ${
                      isResuming
                        ? 'text-slate-600 cursor-wait'
                        : 'text-emerald-400/70 hover:text-emerald-300 hover:bg-emerald-400/10'
                    }`}
                    title={isResuming ? 'Resuming…' : 'Resume saved Claude session'}
                    aria-label="Resume saved Claude session"
                  >
                    <RotateCcw size={11} className={isResuming ? 'animate-spin' : ''} />
                  </button>
                )}
                <button
                  onClick={() => onPopout(s)}
                  className="flex items-center justify-center w-6 h-6 rounded text-slate-500 hover:text-slate-200 hover:bg-white/[0.06] transition-colors"
                  title="Pop out terminal to new window"
                  aria-label="Pop out terminal"
                >
                  <ExternalLink size={11} />
                </button>
                {paneCount > 1 && (
                  <button
                    onClick={() => onClose(tabId)}
                    className="flex items-center justify-center w-6 h-6 mr-1 rounded text-slate-500 hover:text-slate-200 hover:bg-white/[0.06] transition-colors"
                    title="Close tab in this pane"
                    aria-label="Close tab"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </Fragment>
          )
        })}
        {tabDropIdx === pane.tabs.length && (
          <div className="w-0.5 self-stretch bg-[#58A6FF]" />
        )}
      </div>

      <div
        ref={bodyRef}
        className="flex-1 relative overflow-hidden p-1"
        onDragOver={handleBodyDragOver}
        onDragLeave={() => setDropHint(null)}
        onDrop={handleBodyDrop}
      >
        {pane.tabs.map(tabId => {
          const s = sessionsById.get(tabId)
          if (!s) return null
          const active = tabId === pane.activeTab
          return (
            <div
              key={tabId}
              className="absolute inset-1"
              style={{ display: active ? 'block' : 'none' }}
            >
              <TermTab info={s} active={active} />
            </div>
          )
        })}
        {dropHint && <DropHintOverlay edge={dropHint} />}
      </div>
    </div>
  )
}

function DropHintOverlay({ edge }: { edge: DropEdge }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    pointerEvents: 'none',
    background: 'rgba(88, 166, 255, 0.15)',
    border: '1px solid rgba(88, 166, 255, 0.5)',
  }
  switch (edge) {
    case 'left':   Object.assign(style, { top: 0, bottom: 0, left: 0, width: '50%' }); break
    case 'right':  Object.assign(style, { top: 0, bottom: 0, right: 0, width: '50%' }); break
    case 'top':    Object.assign(style, { top: 0, left: 0, right: 0, height: '50%' }); break
    case 'bottom': Object.assign(style, { bottom: 0, left: 0, right: 0, height: '50%' }); break
    case 'center': Object.assign(style, { inset: 0 }); break
  }
  return <div style={style} />
}

function LayoutRenderer({
  node,
  paneProps,
  paneCount,
  onResize,
}: {
  node: LayoutNode
  paneProps: Omit<React.ComponentProps<typeof PaneView>, 'pane' | 'paneCount'>
  paneCount: number
  onResize: (splitId: string, sizes: number[]) => void
}) {
  if (node.kind === 'pane') {
    return <PaneView pane={node} paneCount={paneCount} {...paneProps} />
  }
  return (
    <PanelGroup
      direction={node.direction === 'row' ? 'horizontal' : 'vertical'}
      onLayout={(sizes) => onResize(node.id, sizes)}
      autoSaveId={undefined}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <PanelResizeHandle
              className={
                node.direction === 'row'
                  ? 'w-1 bg-white/[0.04] hover:bg-[#58A6FF]/40 transition-colors'
                  : 'h-1 bg-white/[0.04] hover:bg-[#58A6FF]/40 transition-colors'
              }
            />
          )}
          <Panel defaultSize={node.sizes[i] ?? 100 / node.children.length} minSize={10}>
            <LayoutRenderer
              node={child}
              paneProps={paneProps}
              paneCount={paneCount}
              onResize={onResize}
            />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  )
}

export default function TerminalPanel({ sessions, isVisible, projectDir, layout, onLayoutChange }: Props) {
  const [shellSession, setShellSession] = useState<TerminalInfo | null>(null)
  const [exitedIds, setExitedIds] = useState<Set<string>>(new Set())
  const [resumableIds, setResumableIds] = useState<Map<string, string>>(new Map())
  const [resumingIds, setResumingIds] = useState<Set<string>>(new Set())

  // Track exits.
  useEffect(() => {
    const unsub = window.electron.terminal.onExit(({ id }) => {
      setExitedIds(prev => {
        if (prev.has(id)) return prev
        const next = new Set(prev)
        next.add(id)
        return next
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.electron.zone.onSessionCaptured(({ zoneId, sessionId }) => {
      setResumableIds(prev => {
        if (prev.get(zoneId) === sessionId) return prev
        const next = new Map(prev)
        next.set(zoneId, sessionId)
        return next
      })
    })
    return unsub
  }, [])

  // Spawn shell once per project.
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    window.electron.terminal.spawnShell(projectDir).then(info => {
      if (cancelled || !info) return
      setShellSession(info)
    })
    return () => { cancelled = true }
  }, [projectDir])

  const allSessions: TerminalInfo[] = useMemo(
    () => (shellSession ? [shellSession, ...sessions] : sessions),
    [shellSession, sessions],
  )

  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalInfo>()
    for (const s of allSessions) map.set(s.id, s)
    return map
  }, [allSessions])

  // Backfill saved Claude sessions for tabs whenever the session list changes.
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    Promise.all(
      sessions
        .filter(s => s.runtime !== 'shell')
        .map(s =>
          window.electron.zone.getSession(projectDir, s.label).then(saved => ({
            id: s.id,
            sessionId: saved?.sessionId ?? null,
          })),
        ),
    ).then(results => {
      if (cancelled) return
      setResumableIds(prev => {
        const next = new Map(prev)
        for (const { id, sessionId } of results) {
          if (sessionId) next.set(id, sessionId)
        }
        return next
      })
    })
    return () => { cancelled = true }
  }, [projectDir, sessions.map(s => s.id).join('|')])

  // Sync layout with the live session list.
  useEffect(() => {
    const ids = allSessions.map(s => s.id)
    const base = layout ?? emptyLayout()
    const migrated = migrateLayout(base, ids)
    if (JSON.stringify(migrated) !== JSON.stringify(base)) {
      onLayoutChange(migrated)
    }
  }, [allSessions.map(s => s.id).join('|'), layout, onLayoutChange])

  // Listen for popout-window-closed → put the terminal back into a pane.
  useEffect(() => {
    const unsub = window.electron.terminal.onPopoutClosed(({ id }) => {
      if (!layout) return
      let next = setPoppedOut(layout, id, false)
      // migrateLayout will append it to first pane on next session-sync tick;
      // do it now too in case sessions haven't changed.
      next = migrateLayout(next, allSessions.map(s => s.id))
      onLayoutChange(next)
    })
    return unsub
  }, [layout, allSessions, onLayoutChange])

  // Re-fit terminals when this panel becomes visible.
  useEffect(() => {
    if (!isVisible) return
    const raf = requestAnimationFrame(() => {
      termInstances.forEach((instance, id) => {
        try {
          instance.fit.fit()
          window.electron.terminal.resize(id, instance.term.cols, instance.term.rows)
        } catch {}
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [isVisible, layout])

  // Dispose xterm instances whose sessions no longer exist.
  useEffect(() => {
    return () => {
      termInstances.forEach((instance, id) => {
        if (!sessionsById.has(id)) {
          instance.term.dispose()
          termInstances.delete(id)
        }
      })
    }
  }, [allSessions.map(s => s.id).join('|')])

  const handleResume = async (info: TerminalInfo) => {
    if (info.runtime === 'shell' || resumingIds.has(info.id)) return
    setResumingIds(prev => {
      const next = new Set(prev)
      next.add(info.id)
      return next
    })
    try {
      const result = await window.electron.zone.resume({
        projectDir,
        zoneId: info.id,
        label: info.label,
        runtime: info.runtime as AgentRuntime,
      })
      if (result?.ok) {
        termInstances.get(info.id)?.term.clear()
        setExitedIds(prev => {
          if (!prev.has(info.id)) return prev
          const next = new Set(prev)
          next.delete(info.id)
          return next
        })
      }
    } finally {
      setResumingIds(prev => {
        const next = new Set(prev)
        next.delete(info.id)
        return next
      })
    }
  }

  const handlePopout = async (info: TerminalInfo) => {
    if (!layout) return
    onLayoutChange(setPoppedOut(layout, info.id, true))
    // Dispose the in-window xterm so the popout can mount its own; PTY keeps running.
    const inst = termInstances.get(info.id)
    if (inst) {
      try { inst.term.dispose() } catch {}
      termInstances.delete(info.id)
    }
    await window.electron.terminal.popout({ id: info.id, label: info.label, runtime: info.runtime })
  }

  const handleCloseTab = (tabId: string) => {
    if (!layout) return
    // "Close" here only removes the tab from layout; PTY stays alive (user can re-add via reorder/popout-back).
    // Practically: empty pane collapses → the tab gets re-added to first pane on next migration tick.
    // To actually hide, we treat close as popped-out=false, but pull from the visible tree by removing.
    // Simpler: skip wiring close for now since migrateLayout will re-add it. Leaving this as a no-op move-to-first.
    // We instead use it to move to first pane (i.e., consolidate).
    const firstId = (function findFirst(node: LayoutNode): string | null {
      if (node.kind === 'pane') return node.id
      for (const c of node.children) {
        const r = findFirst(c)
        if (r) return r
      }
      return null
    })(layout.root)
    if (firstId) onLayoutChange(moveTabToPane(layout, tabId, firstId))
  }

  if (!layout) {
    return <div className="h-full bg-[#0d0d0d]" />
  }

  const paneCount = (function count(n: LayoutNode): number {
    if (n.kind === 'pane') return 1
    return n.children.reduce((s, c) => s + count(c), 0)
  })(layout.root)

  const paneProps = {
    sessionsById,
    exitedIds,
    resumableIds,
    resumingIds,
    onActivate: (paneId: string, tabId: string) => onLayoutChange(setActiveTab(layout, paneId, tabId)),
    onMoveTab: (tabId: string, targetPaneId: string, idx?: number) =>
      onLayoutChange(moveTabToPane(layout, tabId, targetPaneId, idx)),
    onReorder: (paneId: string, fromIdx: number, toIdx: number) =>
      onLayoutChange(reorderTabs(layout, paneId, fromIdx, toIdx)),
    onSplitDrop: (paneId: string, tabId: string, edge: DropEdge) =>
      onLayoutChange(splitPaneWithTab(layout, paneId, tabId, edge)),
    onPopout: handlePopout,
    onClose: handleCloseTab,
    onResume: handleResume,
  }

  return (
    <div className="h-full bg-[#0d0d0d]">
      <LayoutRenderer
        node={layout.root}
        paneProps={paneProps}
        paneCount={paneCount}
        onResize={(splitId, sizes) => onLayoutChange(setSplitSizes(layout, splitId, sizes))}
      />
    </div>
  )
}
