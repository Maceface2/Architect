import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const TERM_THEME = {
  background:  '#14110e',
  foreground:  '#e2e8f0',
  cursor:      '#58A6FF',
  cursorAccent:'#14110e',
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

interface Props {
  id: string
  label: string
}

export default function PopoutTerminalApp({ id, label }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.title = label
  }, [label])

  useEffect(() => {
    if (!containerRef.current) return
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
    term.open(containerRef.current)
    try { fit.fit() } catch {}
    window.electron.terminal.resize(id, term.cols, term.rows)

    const onInput = term.onData(data => window.electron.terminal.input(id, data))
    const unsubData = window.electron.terminal.onData(({ id: tid, data }) => {
      if (tid === id) term.write(data)
    })
    const unsubExit = window.electron.terminal.onExit(({ id: tid }) => {
      if (tid === id) term.write('\r\n\x1b[33m[process exited]\x1b[0m\r\n')
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        window.electron.terminal.resize(id, term.cols, term.rows)
      } catch {}
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      onInput.dispose()
      unsubData()
      unsubExit()
      term.dispose()
    }
  }, [id])

  // Popout windows are their own React tree with no InterfaceSettingsProvider,
  // so the document's data-theme attribute stays unset and CSS variables
  // resolve to the dark defaults. `bg-terminal` here will follow that — if we
  // ever wire theme through the popout IPC, just setting documentElement
  // dataset.theme on this side will flip both the wrapper and the xterm.
  return (
    <div className="h-screen w-screen bg-terminal flex flex-col">
      <div className="flex-shrink-0 px-3 py-2 border-b border-white/[0.06] text-xs text-fg-muted font-medium">
        {label}
      </div>
      <div ref={containerRef} className="flex-1 p-1 overflow-hidden" />
    </div>
  )
}
