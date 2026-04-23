import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Bot, Settings2, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { getAgentRuntime, type AgentRuntime, type AssistantMode } from '../../../../shared/agentRuntimes'
import { DEFAULT_COLS, DEFAULT_ROWS } from '../../../../shared/terminalDims'
import { useProjectDir } from '../../context/ProjectDirContext'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import type { ProjectSettings } from '../../types'
import AssistantLaunchModal, { type AssistantRelaunchOpts } from './AssistantLaunchModal'

const ASSISTANT_IDS: Record<AssistantMode, string> = {
  architecture: 'architect-assistant-architecture',
  general:      'architect-assistant-general',
}

// Cols is reflow-expensive; rows is cheap. VS Code's terminalResizeDebouncer
// uses this same split: broadcast row changes immediately, coalesce column
// changes on a short tail so splitter drags don't hammer the PTY.
const COLS_DEBOUNCE_MS = 100

export type AssistantOrientation = 'right' | 'bottom'

// Strip ANSI escape codes so we can search for plain-text markers
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const TERM_THEME = {
  background: "#0d0d0d",
  foreground: "#e2e8f0",
  cursor: "#c084fc",
  cursorAccent: "#0d0d0d",
  black: "#1e1e1e",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#58A6FF",
  magenta: "#c084fc",
  cyan: "#38bdf8",
  white: "#e2e8f0",
  brightBlack: "#3a3a3a",
  brightWhite: "#ffffff",
};

interface CanvasUpdate {
  zones?: unknown[]
  components?: unknown[]
  nodes?: unknown[]
  edges: unknown[]
}

interface Props {
  visible: boolean
  orientation: AssistantOrientation
  onClose: () => void
  onCanvasUpdate: (update: CanvasUpdate) => void
  runtime: AgentRuntime
  mode: AssistantMode
  onModeChange: (next: AssistantMode) => void
  // Called when the user commits a choice from the launcher modal. The panel
  // clears the terminal before delegating to the parent so the new session
  // boots on a fresh screen.
  onRelaunch: (mode: AssistantMode, opts: AssistantRelaunchOpts) => Promise<void>
}

interface AssistantTerminalProps {
  mode: AssistantMode
  visible: boolean
  onCanvasUpdate: (update: CanvasUpdate) => void
}

export interface AssistantTerminalHandle {
  clear: () => void
}

// One xterm instance per mode. Mounted once on first render of AssistantPanel
// and kept alive for the app lifetime — closing the panel or switching modes
// only toggles its container visibility. Lifecycle:
//
// - `visible` drives display + gates all resize broadcasts (VS Code pattern:
//   TerminalInstance.layout() bails when dimensions <= 0; resizes while hidden
//   are parked and flushed on setVisible(true)).
// - `lastKnownDimsRef` caches the last good fit so a visibility return never
//   measures from 0; mirrors VS Code's _lastKnownGridDimensions.
// - `requestResize` is the single entry point for all resize decisions:
//   rows broadcast immediately, cols debounced COLS_DEBOUNCE_MS.
const AssistantTerminal = forwardRef<AssistantTerminalHandle, AssistantTerminalProps>(
  function AssistantTerminal({ mode, visible, onCanvasUpdate }, ref) {
    const containerRef   = useRef<HTMLDivElement>(null)
    const termRef        = useRef<Terminal | null>(null)
    const fitRef         = useRef<FitAddon | null>(null)
    const parseBufferRef = useRef<string>('')
    const assistantId = ASSISTANT_IDS[mode]

    // Mirrored synchronously into a ref so callbacks (RO, debounce tail) can
    // read the current visibility without needing stale-closure gymnastics.
    const visibleRef = useRef(visible)

    const lastKnownDimsRef = useRef<{ cols: number; rows: number }>({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    })
    // Parked size requested while hidden. Flushed on visibility false→true.
    const pendingHiddenRef = useRef<{ cols: number; rows: number } | null>(null)
    // Tail-side debounce for cols changes; coalesces splitter-drag storms.
    const pendingColsRef = useRef<{ cols: number; rows: number; timer: ReturnType<typeof setTimeout> } | null>(null)

    // Send a resize to main + xterm. Assumes caller has already gated on
    // visibility and sanity — this is the raw commit point.
    const commitResize = useCallback((cols: number, rows: number) => {
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
      if (cols <= 0 || rows <= 0) return
      lastKnownDimsRef.current = { cols, rows }
      try { termRef.current?.resize(cols, rows) } catch {}
      window.electron.terminal.resize(assistantId, cols, rows)
    }, [assistantId])

    // Single entry point for requesting a resize. While hidden, park; while
    // visible, rows go immediately and cols are debounced.
    const requestResize = useCallback((cols: number, rows: number) => {
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
      if (!visibleRef.current) {
        pendingHiddenRef.current = { cols, rows }
        return
      }
      const last = lastKnownDimsRef.current
      const colsChanged = cols !== last.cols
      const rowsChanged = rows !== last.rows
      if (!colsChanged && !rowsChanged) return

      if (colsChanged) {
        // Stash latest cols + rows; rows portion of the commit will use the
        // current row target (so if rows also changed, we fire rows below
        // and the debounced commit catches cols at the new rows anyway).
        if (pendingColsRef.current) clearTimeout(pendingColsRef.current.timer)
        const timer = setTimeout(() => {
          if (!visibleRef.current) return
          const p = pendingColsRef.current
          pendingColsRef.current = null
          if (!p) return
          commitResize(p.cols, p.rows)
        }, COLS_DEBOUNCE_MS)
        pendingColsRef.current = { cols, rows, timer }
      }
      if (rowsChanged && !colsChanged) {
        // Cheap vertical-only resize: fire synchronously.
        commitResize(last.cols, rows)
      } else if (rowsChanged && colsChanged) {
        // Rows can apply right now at the OLD cols; the debounced cols commit
        // will overwrite with the new cols + rows pair shortly.
        commitResize(last.cols, rows)
      }
    }, [commitResize])

    // Measure the container + xterm via FitAddon. Returns the computed dims,
    // or null if the container isn't laid out yet (display:none, 0×0, etc.).
    // Mirrors VS Code's `TerminalInstance.layout()` early-return on invalid
    // dimensions: we refuse to propagate a measurement from a hidden container.
    const measure = useCallback((): { cols: number; rows: number } | null => {
      const el = containerRef.current
      if (!el) return null
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return null
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (!term) return null
        return { cols: term.cols, rows: term.rows }
      } catch {
        return null
      }
    }, [])

    useImperativeHandle(ref, () => ({
      clear: () => {
        // reset() wipes viewport + scrollback + cursor + ANSI modes. clear()
        // only clears scrollback above the cursor, which collides with Ink
        // CLIs that reposition the cursor on startup.
        try { termRef.current?.reset() } catch {}
        parseBufferRef.current = ''
        // Route through the gated path. clear() is only ever invoked for the
        // currently-visible mode, so requestResize will take the fast path.
        const m = measure()
        if (m) requestResize(m.cols, m.rows)
      },
    }), [measure, requestResize])

    // Parse the ANSI-stripped data stream for ARCHITECT_CANVAS_UPDATE blocks.
    // Only active in architecture mode — general mode must never modify the canvas.
    const parseForUpdates = useCallback((raw: string) => {
      if (mode !== 'architecture') return
      parseBufferRef.current += stripAnsi(raw)

      const START = 'ARCHITECT_CANVAS_UPDATE'
      const END   = 'END_ARCHITECT_CANVAS_UPDATE'

      let startIdx: number
      while ((startIdx = parseBufferRef.current.indexOf(START)) !== -1) {
        const endIdx = parseBufferRef.current.indexOf(END, startIdx + START.length)
        if (endIdx === -1) break

        const jsonStr = parseBufferRef.current.slice(startIdx + START.length, endIdx).trim()
        parseBufferRef.current = parseBufferRef.current.slice(endIdx + END.length)

        try {
          const update = JSON.parse(jsonStr)
          if ((update?.zones || update?.nodes) && update?.edges) {
            onCanvasUpdate(update as CanvasUpdate)
          }
        } catch { /* malformed — skip */ }
      }

      // Prevent unbounded growth
      if (parseBufferRef.current.length > 50_000) {
        parseBufferRef.current = parseBufferRef.current.slice(-10_000)
      }
    }, [onCanvasUpdate, mode])

    // Mount xterm once — never unmount across close/mode/orientation changes.
    useEffect(() => {
      if (!containerRef.current) return

      const term = new Terminal({
        theme: TERM_THEME,
        fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        scrollback: 8000,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      termRef.current = term
      fitRef.current  = fit
      parseBufferRef.current = ''

      term.onData(data => window.electron.terminal.input(assistantId, data))
      term.open(containerRef.current)

      // ResizeObserver stays installed always — modern Chromium skips RO
      // callbacks for display:none subtrees, so this harmlessly sleeps while
      // hidden and resumes when the container is re-laid-out. The gate
      // inside requestResize catches any edge-case 0×0 firing.
      const ro = new ResizeObserver(() => {
        const m = measure()
        if (m) requestResize(m.cols, m.rows)
      })
      ro.observe(containerRef.current)

      return () => {
        ro.disconnect()
        if (pendingColsRef.current) {
          clearTimeout(pendingColsRef.current.timer)
          pendingColsRef.current = null
        }
        term.dispose()
        termRef.current = null
        fitRef.current  = null
      }
    }, [assistantId, measure, requestResize])

    // Visibility gate + flush. useLayoutEffect so the measure happens after
    // React commits the display flip but before the browser paints — matches
    // VS Code's synchronous setVisible(true) → flush debouncer → _resize().
    useLayoutEffect(() => {
      visibleRef.current = visible
      if (!visible) return

      // Flush any parked hidden-time request first so we don't keep a stale
      // size around after visibility returns.
      const parked = pendingHiddenRef.current
      pendingHiddenRef.current = null
      if (parked) commitResize(parked.cols, parked.rows)

      // Flush any pending cols debounce — the user just made the panel
      // visible, they want the size to be correct NOW, not in 100ms.
      if (pendingColsRef.current) {
        clearTimeout(pendingColsRef.current.timer)
        const p = pendingColsRef.current
        pendingColsRef.current = null
        commitResize(p.cols, p.rows)
      }

      // Measure against the live container. If layout hasn't settled yet
      // (measure returns null), fall back to the last-known-good dims so
      // the PTY is pinned to a sane size; the RO will pick up the real size
      // on its next firing.
      const m = measure()
      if (m) {
        commitResize(m.cols, m.rows)
      } else {
        const last = lastKnownDimsRef.current
        commitResize(last.cols, last.rows)
      }
    }, [visible, commitResize, measure])

    // Stream terminal data
    useEffect(() => {
      return window.electron.terminal.onData(({ id, data }) => {
        if (id !== assistantId) return
        termRef.current?.write(data)
        parseForUpdates(data)
      })
    }, [parseForUpdates, assistantId])

    // Handle session exit
    useEffect(() => {
      return window.electron.terminal.onExit(({ id }) => {
        if (id !== assistantId) return
        termRef.current?.write('\r\n\x1b[35m[assistant session ended]\x1b[0m\r\n')
      })
    }, [assistantId])

    return (
      <div
        ref={containerRef}
        className="w-full h-full overflow-hidden p-1"
        style={{ display: visible ? 'block' : 'none' }}
      />
    )
  },
)

export default function AssistantPanel({
  visible,
  orientation,
  onClose,
  onCanvasUpdate,
  runtime,
  mode,
  onModeChange,
  onRelaunch,
}: Props) {
  const runtimeMeta = getAgentRuntime(runtime)
  const projectDir = useProjectDir()
  const projectSettings = useProjectSettings() as ProjectSettings
  const [modalOpen, setModalOpen] = useState(false)
  const archRef = useRef<AssistantTerminalHandle>(null)
  const generalRef = useRef<AssistantTerminalHandle>(null)

  const headerLabel = mode === 'architecture' ? 'Architecture Assistant' : 'General Assistant'
  const borderClass = orientation === 'bottom'
    ? 'border-t border-white/[0.06]'
    : 'border-l border-white/[0.06]'

  const handleRelaunch = useCallback(async (opts: AssistantRelaunchOpts) => {
    // Clear the current mode's xterm before we ask main to respawn. Prevents
    // two unrelated sessions from sharing a visible scrollback.
    const handle = mode === 'architecture' ? archRef.current : generalRef.current
    handle?.clear()
    await onRelaunch(mode, opts)
  }, [mode, onRelaunch])

  return (
    <div
      className={`flex flex-col h-full w-full bg-[#0d0d0d] ${borderClass}`}
      style={{ display: visible ? 'flex' : 'none' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.06] flex-shrink-0 bg-[#111111]">
        <div className="flex items-center gap-2 min-w-0">
          <Bot size={13} className="text-[#c084fc] flex-shrink-0" />
          <span className="text-xs font-medium text-slate-300 truncate">{headerLabel}</span>
          <span
            className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider flex-shrink-0"
            style={{ color: runtimeMeta.accentColor, backgroundColor: `${runtimeMeta.accentColor}20` }}
          >
            {runtimeMeta.shortLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Settings — model picker + new/resume for the current mode */}
          <button
            onClick={() => setModalOpen(true)}
            className="text-slate-600 hover:text-slate-300 transition-colors"
            title="Model + session"
          >
            <Settings2 size={13} />
          </button>
          {/* Mode toggle — segmented control */}
          <div className="flex items-center rounded border border-white/[0.08] bg-[#0d0d0d] overflow-hidden">
            <button
              onClick={() => onModeChange('architecture')}
              className={
                mode === 'architecture'
                  ? 'px-2 py-0.5 text-[10px] font-medium bg-[#3d3dbf] text-white'
                  : 'px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
              }
              title="Architecture mode — edit the canvas"
            >
              Architecture
            </button>
            <button
              onClick={() => onModeChange('general')}
              className={
                mode === 'general'
                  ? 'px-2 py-0.5 text-[10px] font-medium bg-[#3d3dbf] text-white'
                  : 'px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
              }
              title="General mode — generic coding assistant"
            >
              General
            </button>
          </div>
          <button
            onClick={onClose}
            className="text-slate-600 hover:text-slate-300 transition-colors"
            title="Close assistant"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Terminals — both mounted, only the active mode's is displayed.
          Keeps PTY state + xterm scrollback alive across close/mode/orientation. */}
      <div className="flex-1 relative overflow-hidden">
        <AssistantTerminal ref={archRef}    mode="architecture" visible={visible && mode === 'architecture'} onCanvasUpdate={onCanvasUpdate} />
        <AssistantTerminal ref={generalRef} mode="general"      visible={visible && mode === 'general'}      onCanvasUpdate={onCanvasUpdate} />
      </div>

      {modalOpen && projectDir && (
        <AssistantLaunchModal
          projectDir={projectDir}
          mode={mode}
          runtime={runtime}
          projectSettings={projectSettings}
          hasRunningSession={visible}
          onClose={() => setModalOpen(false)}
          onRelaunch={handleRelaunch}
        />
      )}
    </div>
  );
}
