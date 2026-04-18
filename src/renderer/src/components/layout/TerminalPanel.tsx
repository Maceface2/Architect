import { useEffect, useRef, useState } from 'react'
import { RotateCcw, Terminal as TerminalIcon } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getAgentRuntime, type AgentRuntime } from '../../../../shared/agentRuntimes'

interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime | 'shell'
}

interface Props {
  sessions: TerminalInfo[]
  isVisible: boolean
  projectDir: string
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

export default function TerminalPanel({ sessions, isVisible, projectDir }: Props) {
  const [shellSession, setShellSession] = useState<TerminalInfo | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  // id → exited state. id → sessionId presence (string when a saved session exists).
  const [exitedIds, setExitedIds] = useState<Set<string>>(new Set())
  const [resumableIds, setResumableIds] = useState<Map<string, string>>(new Map())
  const [resumingIds, setResumingIds] = useState<Set<string>>(new Set())

  // Track which tabs have exited so we can offer Resume.
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

  // Listen for newly captured sessions so the Resume button lights up
  // as soon as Claude writes its session file.
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

  // Backfill saved sessions for any agent tab on mount / when sessions change.
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
        // Same id → same xterm tab; clear it before resumed output streams in.
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

  // Spawn a persistent shell session on mount / when projectDir changes
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    window.electron.terminal.spawnShell(projectDir).then(info => {
      if (cancelled || !info) return
      setShellSession(info)
    })
    return () => { cancelled = true }
  }, [projectDir])

  // Combine shell (pinned first) with agent sessions
  const allSessions: TerminalInfo[] = shellSession ? [shellSession, ...sessions] : sessions

  // Default active tab: shell if present, else first agent
  useEffect(() => {
    if (allSessions.length === 0) return
    if (!activeId || !allSessions.find(s => s.id === activeId)) {
      setActiveId(allSessions[0].id)
    }
  }, [allSessions.map(s => s.id).join('|')])

  // Re-fit the active terminal whenever this panel becomes visible.
  // The outer container uses display:none while on another tab, so xterm's
  // ResizeObserver sees 0×0. We must refit after the next paint.
  useEffect(() => {
    if (!isVisible || !activeId) return
    const instance = termInstances.get(activeId)
    if (!instance) return
    const raf = requestAnimationFrame(() => {
      try {
        instance.fit.fit()
        window.electron.terminal.resize(activeId, instance.term.cols, instance.term.rows)
      } catch {}
    })
    return () => cancelAnimationFrame(raf)
  }, [isVisible, activeId])

  // Clean up terminal instances that are no longer in allSessions
  useEffect(() => {
    return () => {
      termInstances.forEach((instance, id) => {
        if (!allSessions.find(s => s.id === id)) {
          instance.term.dispose()
          termInstances.delete(id)
        }
      })
    }
  }, [allSessions.map(s => s.id).join('|')])

  return (
    <div className="flex flex-col h-full bg-[#0d0d0d]">
      {/* Tab strip */}
      <div className="flex items-center gap-0 border-b border-white/[0.06] flex-shrink-0 overflow-x-auto">
        {allSessions.map(s => {
          const isShell = s.runtime === 'shell'
          const isArchitect = s.id === 'architect-agent'
          const isActive = s.id === activeId
          const runtime = isShell ? null : getAgentRuntime(s.runtime as AgentRuntime)
          const canResume =
            !isShell &&
            s.runtime === 'claude' &&
            exitedIds.has(s.id) &&
            resumableIds.has(s.id)
          const isResuming = resumingIds.has(s.id)
          return (
            <div
              key={s.id}
              className={`flex items-center border-b-2 transition-colors flex-shrink-0 ${
                isActive
                  ? 'border-[#58A6FF] bg-white/[0.04]'
                  : 'border-transparent hover:bg-white/[0.02]'
              }`}
            >
              <button
                onClick={() => setActiveId(s.id)}
                className={`flex items-center gap-2 pl-4 pr-2 py-2 text-xs whitespace-nowrap ${
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
                  onClick={() => handleResume(s)}
                  disabled={isResuming}
                  className={`flex items-center justify-center w-6 h-6 mr-2 rounded text-[10px] transition-colors ${
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
            </div>
          )
        })}
      </div>

      {/* Terminal views — all mounted, only active one visible */}
      <div className="flex-1 relative overflow-hidden p-1">
        {allSessions.map(s => (
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
