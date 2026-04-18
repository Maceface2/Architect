import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { X, Bot } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { getAgentRuntime, type AgentRuntime } from '../../../../shared/agentRuntimes'

const ASSISTANT_ID = 'architect-assistant'

// Strip ANSI escape codes so we can search for plain-text markers
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

const TERM_THEME = {
  background:   '#0d0d0d',
  foreground:   '#e2e8f0',
  cursor:       '#c084fc',
  cursorAccent: '#0d0d0d',
  black:        '#1e1e1e',
  red:          '#f87171',
  green:        '#4ade80',
  yellow:       '#fbbf24',
  blue:         '#58A6FF',
  magenta:      '#c084fc',
  cyan:         '#38bdf8',
  white:        '#e2e8f0',
  brightBlack:  '#3a3a3a',
  brightWhite:  '#ffffff',
}

interface CanvasUpdate {
  zones?: unknown[]
  components?: unknown[]
  nodes?: unknown[]
  edges: unknown[]
}

interface Props {
  onClose: () => void
  onCanvasUpdate: (update: CanvasUpdate) => void
  runtime: AgentRuntime
}

export default function AssistantPanel({ onClose, onCanvasUpdate, runtime }: Props) {
  const containerRef  = useRef<HTMLDivElement>(null)
  const termRef       = useRef<Terminal | null>(null)
  const fitRef        = useRef<FitAddon | null>(null)
  const parseBufferRef = useRef<string>('')
  const runtimeMeta = getAgentRuntime(runtime)

  // Parse the ANSI-stripped data stream for ARCHITECT_CANVAS_UPDATE blocks
  const parseForUpdates = useCallback((raw: string) => {
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
  }, [onCanvasUpdate])

  // Mount xterm once
  useEffect(() => {
    if (!containerRef.current || termRef.current) return

    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 8000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    fitRef.current  = fit

    term.onData(data => window.electron.terminal.input(ASSISTANT_ID, data))
    term.open(containerRef.current)

    const doFit = () => {
      try {
        fit.fit()
        window.electron.terminal.resize(ASSISTANT_ID, term.cols, term.rows)
      } catch {}
    }

    requestAnimationFrame(doFit)
    const ro = new ResizeObserver(doFit)
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current  = null
    }
  }, [])

  // Stream terminal data
  useEffect(() => {
    return window.electron.terminal.onData(({ id, data }) => {
      if (id !== ASSISTANT_ID) return
      termRef.current?.write(data)
      parseForUpdates(data)
    })
  }, [parseForUpdates])

  // Handle session exit
  useEffect(() => {
    return window.electron.terminal.onExit(({ id }) => {
      if (id !== ASSISTANT_ID) return
      termRef.current?.write('\r\n\x1b[35m[assistant session ended]\x1b[0m\r\n')
    })
  }, [])

  return (
    <div className="flex flex-col h-full bg-[#0d0d0d] border-l border-white/[0.06]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.06] flex-shrink-0 bg-[#111111]">
        <div className="flex items-center gap-2">
          <Bot size={13} className="text-[#c084fc]" />
          <span className="text-xs font-medium text-slate-300">Architecture Assistant</span>
          <span
            className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider"
            style={{ color: runtimeMeta.accentColor, backgroundColor: `${runtimeMeta.accentColor}20` }}
          >
            {runtimeMeta.shortLabel}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-slate-600 hover:text-slate-300 transition-colors"
          title="Close assistant"
        >
          <X size={13} />
        </button>
      </div>

      {/* Terminal */}
      <div ref={containerRef} className="flex-1 overflow-hidden p-1" />
    </div>
  )
}
