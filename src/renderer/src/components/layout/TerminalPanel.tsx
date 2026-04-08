import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalInfo {
  id: string
  label: string
}

interface Props {
  sessions: TerminalInfo[]
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

// One xterm instance per terminal id, persisted across tab switches
const termInstances = new Map<string, { term: Terminal; fit: FitAddon }>()

function TermTab({
  info,
  active,
  exited,
}: {
  info: TerminalInfo
  active: boolean
  exited: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Reuse existing instance or create new one
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

    // Attach to DOM if not already attached
    if (containerRef.current.children.length === 0) {
      term.open(containerRef.current)
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

  // Write incoming data to the correct terminal instance
  useEffect(() => {
    const unsub = window.electron.terminal.onData(({ id, data }) => {
      if (id === info.id) {
        termInstances.get(info.id)?.term.write(data)
      }
    })
    return unsub
  }, [info.id])

  // Mark exited terminals
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

export default function TerminalPanel({ sessions }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)

  // When sessions change, default to first (overseer)
  useEffect(() => {
    if (sessions.length > 0 && !sessions.find(s => s.id === activeId)) {
      setActiveId(sessions[0].id)
    }
  }, [sessions])

  // Clean up terminal instances that are no longer in sessions
  useEffect(() => {
    return () => {
      termInstances.forEach((instance, id) => {
        if (!sessions.find(s => s.id === id)) {
          instance.term.dispose()
          termInstances.delete(id)
        }
      })
    }
  }, [sessions])

  if (sessions.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-[#0d0d0d]">
        <p className="text-xs text-slate-600">No agents running.</p>
        <p className="text-xs text-slate-700">Build a graph and click Dispatch agents.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[#0d0d0d]">
      {/* Tab strip */}
      <div className="flex items-center gap-0 border-b border-white/[0.06] flex-shrink-0 overflow-x-auto">
        {sessions.map(s => {
          const isOverseer = s.id === 'overseer'
          const isActive = s.id === activeId
          return (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className={`flex items-center gap-2 px-4 py-2 text-xs whitespace-nowrap border-b-2 transition-colors flex-shrink-0 ${
                isActive
                  ? 'border-[#58A6FF] text-white bg-white/[0.04]'
                  : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-white/[0.02]'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  isOverseer ? 'bg-[#c084fc]' : 'bg-[#58A6FF]'
                }`}
              />
              {isOverseer ? '⬡ Overseer' : s.label}
            </button>
          )
        })}
      </div>

      {/* Terminal views — all mounted, only active one visible */}
      <div className="flex-1 relative overflow-hidden p-1">
        {sessions.map(s => (
          <div
            key={s.id}
            className="absolute inset-1"
            style={{ display: s.id === activeId ? 'block' : 'none' }}
          >
            <TermTab
              info={s}
              active={s.id === activeId}
              exited={false}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
