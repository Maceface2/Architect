import type { CSSProperties } from 'react'
import { Zap, Loader2, MessageSquare, Undo2, Redo2, RefreshCw } from 'lucide-react'

interface TopNavProps {
  onDispatch: () => void
  dispatching: boolean
  nodeCount: number
  projectDir: string
  onChangeDir: () => void
  onAssistantToggle: () => void
  assistantOpen: boolean
  isRedispatch: boolean
  changedCount: number
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  updateReady: boolean
  onUpdateInstall: () => void
}

export default function TopNav({
  onDispatch, dispatching, nodeCount,
  projectDir, onChangeDir,
  onAssistantToggle, assistantOpen, isRedispatch, changedCount,
  onUndo, onRedo, canUndo, canRedo,
  updateReady, onUpdateInstall,
}: TopNavProps) {
  const dirName = projectDir.split('/').filter(Boolean).pop() ?? projectDir

  const pad2 = (n: number) => String(n).padStart(2, '0')

  return (
    <div className="flex bg-panel border-b border-node-border flex-shrink-0">
      {/* Header strip: drag region with traffic-light inset on the left and
          a drafted action row on the right. All action chrome uses tracked
          uppercase mono labels and rounded-[2px] for an instrument-panel
          feel rather than the usual rounded-button vocabulary. */}
      <div
        className="flex items-center h-11 pr-3 w-full"
        style={{ WebkitAppRegion: 'drag', paddingLeft: 88 } as CSSProperties}
      >
        {/* Left: logo + path chip */}
        <div className="flex items-center gap-2.5" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 400 400"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-label="Architect"
            className="flex-shrink-0"
          >
            <line x1="40"  y1="360" x2="360" y2="40"  stroke="#58A6FF" strokeWidth="32" strokeLinecap="round" />
            <line x1="40"  y1="360" x2="200" y2="360" stroke="#58A6FF" strokeWidth="32" strokeLinecap="round" />
            <line x1="200" y1="360" x2="360" y2="40"  stroke="#58A6FF" strokeWidth="32" strokeLinecap="round" />
            <circle cx="40"  cy="360" r="28" fill="#58A6FF" />
            <circle cx="200" cy="360" r="28" fill="#58A6FF" />
            <circle cx="360" cy="40"  r="28" fill="#58A6FF" />
          </svg>
          <button
            onClick={onChangeDir}
            className="flex items-center gap-1.5 px-2 py-1 rounded-[2px] text-[11px] text-fg-muted hover:text-fg hover:bg-node border border-white/[0.08] transition-colors max-w-[220px]"
            title={projectDir}
          >
            <span className="text-fg-subtle flex-shrink-0">/</span>
            <span className="truncate">{dirName}</span>
          </button>
        </div>

        <div className="flex-1" />

        {/* Right: drafted action row. Hairline divider between groups. */}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
          <div className="flex items-center">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              className="flex items-center justify-center w-7 h-7 text-fg-muted border border-white/[0.08] rounded-l-[2px] hover:bg-node hover:text-fg transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Undo (⌘Z)"
              aria-label="Undo"
            >
              <Undo2 size={12} />
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              className="flex items-center justify-center w-7 h-7 text-fg-muted border border-l-0 border-white/[0.08] rounded-r-[2px] hover:bg-node hover:text-fg transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Redo (⇧⌘Z)"
              aria-label="Redo"
            >
              <Redo2 size={12} />
            </button>
          </div>

          <span className="w-px h-4 bg-white/[0.08]" aria-hidden />

          <button
            onClick={onAssistantToggle}
            className={`flex items-center gap-1.5 h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] rounded-[2px] border transition-colors ${
              assistantOpen
                ? 'text-[#c084fc] border-[#c084fc]/40 bg-[#c084fc]/10 hover:bg-[#c084fc]/20'
                : 'text-fg-muted border-white/[0.08] hover:bg-node hover:text-fg'
            }`}
            title="Architecture assistant"
          >
            <MessageSquare size={11} />
            Assistant
          </button>

          {updateReady && (
            <button
              onClick={onUpdateInstall}
              className="flex items-center gap-1.5 h-7 px-2.5 text-[10px] font-medium uppercase tracking-[0.18em] text-emerald-200 border border-emerald-400/40 bg-emerald-400/10 rounded-[2px] hover:bg-emerald-400/20 transition-colors"
              title="A new version of Architect was downloaded. Click to restart and install."
            >
              <RefreshCw size={11} />
              Update / Restart
            </button>
          )}

          <span className="w-px h-4 bg-white/[0.08]" aria-hidden />

          <button
            onClick={onDispatch}
            disabled={dispatching || nodeCount === 0}
            className="flex items-center gap-1.5 h-7 px-3 text-[10px] font-medium uppercase tracking-[0.18em] text-fg bg-accent rounded-[2px] hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            {dispatching ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
            {dispatching
              ? 'Launching…'
              : isRedispatch
                ? `Redispatch${changedCount > 0 ? ` · ${pad2(changedCount)}` : ''}`
                : `Dispatch${nodeCount > 0 ? ` · ${pad2(nodeCount)}` : ''}`
            }
          </button>
        </div>
      </div>

    </div>
  )
}
