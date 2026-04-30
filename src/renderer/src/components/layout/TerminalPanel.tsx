import { useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { AlertTriangle, ExternalLink, Lock, Plus, RotateCcw, Terminal as TerminalIcon, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getAgentRuntime, type AgentRuntime } from '../../../../shared/agentRuntimes'
import { DEFAULT_COLS, DEFAULT_ROWS } from '../../../../shared/terminalDims'
import { useInterfaceSettings } from '../../context/InterfaceSettingsContext'
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
  coordinatedMode?: boolean
  planMode?: boolean
}

interface Props {
  sessions: TerminalInfo[]
  isVisible: boolean
  projectDir: string
  layout: TerminalLayout | null
  onLayoutChange: (next: TerminalLayout) => void
  onRemoveSession: (id: string) => void
  getCanvasSnapshot: () => { nodes: unknown[]; edges: unknown[]; settings: unknown }
  // Optional popout handler — when set, the panel renders a corner button
  // that pops the entire panel into a detached window. The popout itself
  // doesn't render this button (no point popping the popout out again).
  onPanelPopout?: () => void
  // True when this TerminalPanel is rendered inside a detached BrowserWindow
  // with `titleBarStyle: 'hiddenInset'`. The top-left pane's tab strip then
  // becomes the macOS title bar: left-padded so tabs sit clear of the
  // traffic lights, and tagged as a drag region so empty space lets the
  // user grab the bar to move the window.
  popoutMode?: boolean
}

// xterm themes for the two app themes. ANSI palette mostly stable across
// modes; only the surface + foreground swap. Light-mode greens/yellows are
// darkened so they remain readable on a white background (the dark-mode
// values wash out).
const TERM_THEME_DARK = {
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

const TERM_THEME_LIGHT = {
  background:  '#ffffff',
  foreground:  '#1e293b',  // slate-800
  cursor:      '#2563eb',  // blue-600
  cursorAccent:'#ffffff',
  black:       '#1e293b',
  red:         '#dc2626',
  green:       '#16a34a',
  yellow:      '#ca8a04',
  blue:        '#2563eb',
  magenta:     '#9333ea',
  cyan:        '#0891b2',
  white:       '#475569',
  brightBlack: '#94a3b8',
  brightWhite: '#0f172a',
}

const TAB_DRAG_MIME = 'application/architect-terminal-tab'

const RESUMABLE_RUNTIMES: ReadonlySet<AgentRuntime> = new Set<AgentRuntime>(['claude', 'codex', 'gemini', 'opencode'])

// One xterm instance per terminal id, persisted across pane moves & tab switches.
const termInstances = new Map<string, { term: Terminal; fit: FitAddon }>()

function TermTab({ info, active }: { info: TerminalInfo; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isCoordinated = !!info.coordinatedMode
  const { theme } = useInterfaceSettings()
  const xtermTheme = theme === 'light' ? TERM_THEME_LIGHT : TERM_THEME_DARK
  // Plan-mode pill state. The conductor's prompt instructs it to wait for
  // the user to type `GO` on its own line before emitting any assignments.
  // We mirror that locally: while the user hasn't typed GO yet, render a
  // small badge in the header. The detector uses a per-instance line
  // buffer to recognize a clean `GO\n` and ignores anything else.
  const [planAcknowledged, setPlanAcknowledged] = useState(false)
  const showPlanPill = !!info.planMode && !planAcknowledged

  // Auto-acquired write lock. Coordinated terminals default to unlocked: the
  // user types freely. Any non-Enter keystroke flips lockHeld → true (which
  // tells main to queue scheduler writes instead of interleaving). Pressing
  // Enter (\r) flips it back, draining whatever the scheduler queued. The
  // ref is read synchronously in the stable onData closure to dedupe IPC.
  const lockHeldRef = useRef(false)
  const [lockHeld, setLockHeld] = useState(false)
  // One-shot picker guard. A `/` keypress or any arrow key arms this flag so
  // the very next Enter is absorbed rather than releasing the lock. One event
  // → one blocked Enter, no accumulation. Pressing Enter twice is the
  // accepted cost; no line buffer needed.
  const pendingPickerEnterRef = useRef(false)

  useEffect(() => {
    if (!containerRef.current) return

    let instance = termInstances.get(info.id)
    if (!instance) {
      const term = new Terminal({
        theme: xtermTheme,
        fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        allowTransparency: false,
        scrollback: 5000,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      instance = { term, fit }
      termInstances.set(info.id, instance)

      // Forward EVERYTHING xterm wants to send to the PTY — keystrokes, paste
      // content, focus reports, mouse reports, DSR/OSC responses. The CLI
      // depends on those replies; we only stay out of the way here.
      term.onData(data => {
        window.electron.terminal.input(info.id, data)
      })

      // Lock detection runs on onKey, NOT onData. onKey fires only for real
      // keyboard events (DOM keydown), so it ignores all the protocol chatter
      // (focus tracking, cursor-position replies, mouse motion) that some
      // CLIs — Codex in particular — emit through onData. Deduped via
      // lockHeldRef so we only emit IPC + setState on transitions.
      // Enter releases the lock — except while a slash-command picker looks
      // active (recent arrow keys, or Enter on a `/<word>` line). See the
      // picker-activity refs above for the guard logic.
      term.onKey(({ key, domEvent }) => {
        if (!info.coordinatedMode) return
        const isEnter = domEvent.key === 'Enter'
        const isArrow =
          domEvent.key === 'ArrowUp' ||
          domEvent.key === 'ArrowDown' ||
          domEvent.key === 'ArrowLeft' ||
          domEvent.key === 'ArrowRight'
        if (isArrow || key === '/') pendingPickerEnterRef.current = true

        if (isEnter) {
          if (pendingPickerEnterRef.current) {
            pendingPickerEnterRef.current = false
          } else if (lockHeldRef.current) {
            lockHeldRef.current = false
            window.electron.terminal.setUserControl(info.id, false)
            setLockHeld(false)
          }
        } else {
          if (!lockHeldRef.current) {
            lockHeldRef.current = true
            window.electron.terminal.setUserControl(info.id, true)
            setLockHeld(true)
          }
        }
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

  // Push theme updates into the cached xterm instance whenever the app
  // theme flips. Setting `term.options.theme` re-renders the buffer with
  // the new palette without losing scrollback or PTY state.
  useEffect(() => {
    const instance = termInstances.get(info.id)
    if (!instance) return
    instance.term.options.theme = xtermTheme
  }, [info.id, xtermTheme])

  // Stream data → term (subscribed once per id, regardless of mount).
  useEffect(() => {
    const unsub = window.electron.terminal.onData(({ id, data }) => {
      if (id === info.id) termInstances.get(info.id)?.term.write(data)
    })
    return unsub
  }, [info.id])

  useEffect(() => {
    const unsub = window.electron.terminal.onExit(({ id }) => {
      if (id !== info.id) return
      termInstances.get(info.id)?.term.write('\r\n\x1b[33m[process exited]\x1b[0m\r\n')
      // Main wipes coordination state on exit (clearCoordinationState); keep
      // the renderer in sync so a re-spawn under the same id starts unlocked.
      lockHeldRef.current = false
      setLockHeld(false)
      pendingPickerEnterRef.current = false
    })
    return unsub
  }, [info.id])

  // GO-detection: while the dispatch is in plan mode and not yet
  // acknowledged, watch for the user typing `GO` (case-insensitive) on its
  // own line. Registers as a SECOND `term.onData` listener (xterm allows
  // multiple); this one's only job is to dismiss the pill.
  useEffect(() => {
    if (!info.planMode || planAcknowledged) return
    const instance = termInstances.get(info.id)
    if (!instance) return
    let line = ''
    const dispose = instance.term.onData(data => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          if (/^\s*go\s*$/i.test(line)) setPlanAcknowledged(true)
          line = ''
        } else if (ch === '\x7f' || ch === '\b') {
          line = line.slice(0, -1)
        } else if (ch >= ' ') {
          line += ch
        }
      }
    })
    return () => dispose.dispose()
  }, [info.id, info.planMode, planAcknowledged])

  return (
    <div
      className="w-full h-full flex flex-col"
      style={{ visibility: active ? 'visible' : 'hidden' }}
    >
      {showPlanPill && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-amber-500/15 border-b border-amber-500/40 flex-shrink-0">
          <span className="text-[11px] text-amber-200 flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded bg-amber-500/30 border border-amber-500/50 font-medium tracking-wide">PLAN MODE</span>
            waiting for <span className="font-mono font-semibold">GO</span> — discuss the plan with the conductor, then type <span className="font-mono font-semibold">GO</span> to dispatch
          </span>
        </div>
      )}
      {isCoordinated && lockHeld && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/15 border-b border-yellow-500/50 flex-shrink-0">
          <AlertTriangle size={12} className="text-yellow-300 flex-shrink-0" />
          <span className="text-[11px] text-yellow-100">
            All communication to the CLI is blocked and will be queued. Press <span className="font-mono font-semibold">Enter</span> to unblock.
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
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
  closingIds,
  onActivate,
  onMoveTab,
  onReorder,
  onSplitDrop,
  onPopout,
  onClose,
  onResume,
  onNewShell,
  topLeft,
  popoutMode,
}: {
  pane: PaneNode
  sessionsById: Map<string, TerminalInfo>
  exitedIds: Set<string>
  resumableIds: Map<string, string>
  resumingIds: Set<string>
  closingIds: Set<string>
  onActivate: (paneId: string, tabId: string) => void
  onMoveTab: (tabId: string, targetPaneId: string, idx?: number) => void
  onReorder: (paneId: string, fromIdx: number, toIdx: number) => void
  onSplitDrop: (paneId: string, tabId: string, edge: DropEdge) => void
  onPopout: (info: TerminalInfo) => void
  onClose: (tabId: string) => void
  onResume: (info: TerminalInfo) => void
  onNewShell: () => void
  topLeft?: boolean
  popoutMode?: boolean
}) {
  // Only the leftmost-topmost pane in the layout absorbs the traffic-light
  // inset. Other panes (right of a vertical split, below a horizontal one)
  // render their tab strip flush as usual.
  const isTitleBar = !!(popoutMode && topLeft)
  const titleBarItemStyle = isTitleBar
    ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties)
    : undefined
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

  // Tab strip content shared between the two outer wrappers (title-bar
  // mode vs. regular). Defined as JSX rather than a separate component so
  // it captures the surrounding handlers and styles without prop drilling.
  const tabsContent = (
    <>
      {pane.tabs.map((tabId, i) => {
        const s = sessionsById.get(tabId)
        if (!s) return null
        const isShell = s.runtime === 'shell'
        const isConductor = s.id === 'conductor-agent'
        const isActive = tabId === pane.activeTab
        const runtime = isShell ? null : getAgentRuntime(s.runtime as AgentRuntime)
        const canResume = !isShell && RESUMABLE_RUNTIMES.has(s.runtime as AgentRuntime) && exitedIds.has(s.id) && resumableIds.has(s.id)
        const isResuming = resumingIds.has(s.id)
        const resumeLabel = canResume && runtime ? `Resume saved ${runtime.label} session` : 'Resume saved session'
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
              style={titleBarItemStyle}
              className={`flex items-center border-b-2 transition-colors flex-shrink-0 ${
                isActive
                  ? 'border-[#58A6FF] bg-white/[0.04]'
                  : 'border-transparent hover:bg-white/[0.02]'
              }`}
            >
              <button
                onClick={() => onActivate(pane.id, tabId)}
                className={`flex items-center gap-2 pl-3 pr-2 py-2 text-xs whitespace-nowrap ${
                  isActive ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
                }`}
              >
                {isShell ? (
                  <TerminalIcon size={12} className="text-emerald-400 flex-shrink-0" />
                ) : (
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      isConductor ? 'bg-[#c084fc]' : 'bg-[#58A6FF]'
                    } ${exitedIds.has(s.id) ? 'opacity-30' : ''}`}
                  />
                )}
                {s.coordinatedMode && !isShell && (
                  <Lock size={10} className="text-fg-subtle flex-shrink-0" aria-label="Scheduler-coordinated" />
                )}
                <span className={exitedIds.has(s.id) && !isShell ? 'opacity-60' : ''}>
                  {isShell ? (s.label || 'Shell') : isConductor ? '⬡ Conductor' : s.label}
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
                      ? 'text-fg-subtle cursor-wait'
                      : 'text-emerald-400/70 hover:text-emerald-300 hover:bg-emerald-400/10'
                  }`}
                  title={isResuming ? 'Resuming…' : resumeLabel}
                  aria-label={resumeLabel}
                >
                  <RotateCcw size={11} className={isResuming ? 'animate-spin' : ''} />
                </button>
              )}
              <button
                onClick={() => onPopout(s)}
                className="flex items-center justify-center w-6 h-6 rounded text-fg-subtle hover:text-fg hover:bg-white/[0.06] transition-colors"
                title="Pop out terminal to new window"
                aria-label="Pop out terminal"
              >
                <ExternalLink size={11} />
              </button>
              {(() => {
                const isClosing = closingIds.has(s.id)
                const disabled = isClosing
                const title = isClosing ? 'Closing…' : 'Close terminal'
                return (
                  <button
                    onClick={() => !disabled && onClose(tabId)}
                    disabled={disabled}
                    className={`flex items-center justify-center w-6 h-6 mr-1 rounded transition-colors ${
                      disabled
                        ? 'text-fg-subtle cursor-not-allowed'
                        : 'text-fg-subtle hover:text-fg hover:bg-white/[0.06]'
                    }`}
                    title={title}
                    aria-label="Close terminal"
                  >
                    <X size={11} />
                  </button>
                )
              })()}
            </div>
          </Fragment>
        )
      })}
      {tabDropIdx === pane.tabs.length && (
        <div className="w-0.5 self-stretch bg-[#58A6FF]" />
      )}
      <button
        onClick={onNewShell}
        style={titleBarItemStyle}
        className="flex items-center justify-center w-7 h-7 ml-1 rounded text-fg-subtle hover:text-emerald-300 hover:bg-emerald-400/10 transition-colors flex-shrink-0"
        title="New shell"
        aria-label="New shell"
      >
        <Plus size={13} />
      </button>
    </>
  )

  return (
    <div className="flex flex-col h-full bg-terminal min-w-0 min-h-0">
      {isTitleBar ? (
        // Title-bar mode is a two-row flex column:
        //   Row A: tall drag-only strip on top, separated by a hairline —
        //          gives the user a comfortable area to grab the window
        //          without their pointer landing on a tab (which would
        //          tear it out instead). Traffic lights sit inside this
        //          row (y=8 in main config), centered vertically.
        //   Row B: traffic-light reservation + Architect mark + bounded
        //          scroll zone for the tabs (same three zones as before,
        //          ensures tabs can't scroll under the lights).
        <div
          className="flex flex-col h-16 border-b border-white/[0.06] flex-shrink-0"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="h-7 flex-shrink-0 border-b border-white/[0.06]" aria-hidden />
          <div className="flex items-stretch flex-1 min-h-0">
            <div
              className="flex items-center justify-center pl-3 pr-2.5 flex-shrink-0"
              style={titleBarItemStyle}
              aria-label="Architect"
            >
              <svg width="14" height="14" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg">
                <line x1="40" y1="360" x2="360" y2="40" stroke="#58A6FF" strokeWidth="32" strokeLinecap="round" />
                <line x1="40" y1="360" x2="200" y2="360" stroke="#58A6FF" strokeWidth="32" strokeLinecap="round" />
                <line x1="200" y1="360" x2="360" y2="40" stroke="#58A6FF" strokeWidth="32" strokeLinecap="round" />
                <circle cx="40" cy="360" r="28" fill="#58A6FF" />
                <circle cx="200" cy="360" r="28" fill="#58A6FF" />
                <circle cx="360" cy="40" r="28" fill="#58A6FF" />
              </svg>
            </div>
            <div
              className="flex items-center gap-0 overflow-x-auto scrollbar-hide flex-1 min-w-0 relative"
              style={titleBarItemStyle}
              onDragOver={handleStripDragOver}
              onDragLeave={() => setTabDropIdx(null)}
              onDrop={handleStripDrop}
            >
              {tabsContent}
            </div>
          </div>
        </div>
      ) : (
        <div
          className="flex items-center gap-0 border-b border-white/[0.06] flex-shrink-0 overflow-x-auto relative"
          onDragOver={handleStripDragOver}
          onDragLeave={() => setTabDropIdx(null)}
          onDrop={handleStripDrop}
        >
          {tabsContent}
        </div>
      )}

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
              style={{ visibility: active ? 'visible' : 'hidden' }}
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
  onResize,
  // True when this subtree contains the top-left pane of the layout. Only
  // that pane needs the macOS traffic-light padding when popoutMode is on.
  isTopLeft = true,
}: {
  node: LayoutNode
  paneProps: Omit<React.ComponentProps<typeof PaneView>, 'pane'>
  onResize: (splitId: string, sizes: number[]) => void
  isTopLeft?: boolean
}) {
  if (node.kind === 'pane') {
    return <PaneView pane={node} topLeft={isTopLeft} {...paneProps} />
  }
  return (
    <PanelGroup
      direction={node.direction === 'row' ? 'horizontal' : 'vertical'}
      onLayout={(sizes) => onResize(node.id, sizes)}
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
              onResize={onResize}
              // Only the first child stays a top-left candidate. Works for
              // both horizontal (row) and vertical splits — the recursion
              // narrows down to the leftmost-topmost descendant pane.
              isTopLeft={isTopLeft && i === 0}
            />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  )
}

export default function TerminalPanel({ sessions, isVisible, projectDir, layout, onLayoutChange, onRemoveSession, getCanvasSnapshot, onPanelPopout, popoutMode }: Props) {
  const [shellSessions, setShellSessions] = useState<TerminalInfo[]>([])
  const [exitedIds, setExitedIds] = useState<Set<string>>(new Set())
  const [resumableIds, setResumableIds] = useState<Map<string, string>>(new Map())
  const [resumingIds, setResumingIds] = useState<Set<string>>(new Set())
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set())

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

  // Spawn a default shell once per project. Dedup on the main side keeps this
  // idempotent across re-renders; user-initiated "+" presses use force:true.
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    window.electron.terminal.spawnShell(projectDir).then(info => {
      if (cancelled || !info) return
      setShellSessions(prev => (prev.some(s => s.id === info.id) ? prev : [...prev, info]))
    })
    return () => { cancelled = true }
  }, [projectDir])

  // Reset shell list when switching projects so stale ids don't linger.
  useEffect(() => {
    setShellSessions([])
  }, [projectDir])

  const handleNewShell = async () => {
    if (!projectDir) return
    const info = await window.electron.terminal.spawnShell(projectDir, { force: true })
    if (!info) return
    setShellSessions(prev => (prev.some(s => s.id === info.id) ? prev : [...prev, info]))
  }

  const allSessions: TerminalInfo[] = useMemo(
    () => [...shellSessions, ...sessions],
    [shellSessions, sessions],
  )

  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalInfo>()
    for (const s of allSessions) map.set(s.id, s)
    return map
  }, [allSessions])

  // Backfill saved sessions for tabs whenever the session list changes.
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    Promise.all(
      sessions
        .filter(s => s.runtime !== 'shell')
        .map(s =>
          window.electron.zone.listSessions(projectDir, s.id, s.label).then(records => ({
            id: s.id,
            sessionId: records?.[0]?.sessionId ?? null,
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
    const sessionId = resumableIds.get(info.id)
    if (!sessionId) return
    setResumingIds(prev => {
      const next = new Set(prev)
      next.add(info.id)
      return next
    })
    try {
      const snap = getCanvasSnapshot()
      const result = await window.electron.zone.launch({
        projectDir,
        zoneId: info.id,
        nodes: snap.nodes,
        edges: snap.edges,
        mode: 'resume',
        sessionId,
        settings: snap.settings as import('../../types').ProjectSettings,
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

  const handleCloseTab = async (tabId: string) => {
    if (closingIds.has(tabId)) return

    setClosingIds(prev => {
      const next = new Set(prev)
      next.add(tabId)
      return next
    })

    try {
      const result = await window.electron.terminal.close(tabId)
      if (!result?.ok) return
    } finally {
      setClosingIds(prev => {
        if (!prev.has(tabId)) return prev
        const next = new Set(prev)
        next.delete(tabId)
        return next
      })
    }

    // Clean up renderer-side state; the session-sync effect will rebuild
    // the layout once terminalSessions drops this id.
    const inst = termInstances.get(tabId)
    if (inst) {
      try { inst.term.dispose() } catch {}
      termInstances.delete(tabId)
    }
    setExitedIds(prev => {
      if (!prev.has(tabId)) return prev
      const next = new Set(prev)
      next.delete(tabId)
      return next
    })
    setResumableIds(prev => {
      if (!prev.has(tabId)) return prev
      const next = new Map(prev)
      next.delete(tabId)
      return next
    })

    if (shellSessions.some(s => s.id === tabId)) {
      setShellSessions(prev => prev.filter(s => s.id !== tabId))
    } else {
      onRemoveSession(tabId)
    }
  }

  if (!layout) {
    return <div className="h-full bg-terminal" />
  }

  const paneProps = {
    sessionsById,
    exitedIds,
    resumableIds,
    resumingIds,
    closingIds,
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
    onNewShell: handleNewShell,
    popoutMode,
  }

  return (
    <div className="h-full bg-terminal relative">
      <LayoutRenderer
        node={layout.root}
        paneProps={paneProps}
        onResize={(splitId, sizes) => onLayoutChange(setSplitSizes(layout, splitId, sizes))}
      />
      {onPanelPopout && (
        // Sits over the right edge of the tab strip. Pointer-events: auto on
        // the button itself so it can be clicked through the otherwise-empty
        // overlay zone; the wrapping span is just a positioning anchor.
        <button
          onClick={onPanelPopout}
          className="absolute top-1.5 right-2 z-20 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-fg-muted hover:text-fg bg-node/70 hover:bg-node border border-node-border transition-colors"
          title="Pop the entire terminal page into its own window"
          aria-label="Pop out terminal page"
        >
          <ExternalLink size={11} />
          Popout
        </button>
      )}
    </div>
  )
}
