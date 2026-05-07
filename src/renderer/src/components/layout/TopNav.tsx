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

  return (
    <div className="flex bg-panel border-b border-node-border flex-shrink-0">
      {/* Row 1 — drag region (so the user can move the window from this bar)
          with the traffic lights inset over the left padding by hiddenInset.
          Buttons inside opt out via no-drag so clicks aren't swallowed. */}
      <div
        className="flex items-center h-11 pr-4 w-full"
        style={{ WebkitAppRegion: 'drag', paddingLeft: 88 } as CSSProperties}
      >
        {/* Left: logo + dir picker */}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
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
            className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-fg-muted hover:text-fg hover:bg-node border border-node-border transition-colors max-w-[200px]"
            title={projectDir}
          >
            <span className="truncate font-mono">{dirName}</span>
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right: controls + dispatch */}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
          <div className="flex items-center">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              className="flex items-center justify-center w-8 h-7 text-fg-muted border border-node-border rounded-l hover:bg-node transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Undo (⌘Z)"
              aria-label="Undo"
            >
              <Undo2 size={13} />
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              className="flex items-center justify-center w-8 h-7 text-fg-muted border border-l-0 border-node-border rounded-r hover:bg-node transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Redo (⇧⌘Z)"
              aria-label="Redo"
            >
              <Redo2 size={13} />
            </button>
          </div>
          <button
            onClick={onAssistantToggle}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${
              assistantOpen
                ? 'text-[#c084fc] border-[#c084fc]/40 bg-[#c084fc]/10 hover:bg-[#c084fc]/20'
                : 'text-fg-muted border-node-border hover:bg-node'
            }`}
            title="Architecture assistant"
          >
            <MessageSquare size={12} />
            Assistant
          </button>
          {updateReady && (
            <button
              onClick={onUpdateInstall}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-200 border border-emerald-400/40 bg-emerald-400/10 rounded hover:bg-emerald-400/20 transition-colors"
              title="A new version of Architect was downloaded. Click to restart and install."
            >
              <RefreshCw size={12} />
              Update ready — Restart
            </button>
          )}
          <button
            onClick={onDispatch}
            disabled={dispatching || nodeCount === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg bg-accent rounded hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            {dispatching ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            {dispatching
              ? 'Launching…'
              : isRedispatch
                ? `Redispatch${changedCount > 0 ? ` (${changedCount} changed)` : ''}`
                : `Dispatch${nodeCount > 0 ? ` (${nodeCount})` : ''}`
            }
          </button>
        </div>
      </div>

    </div>
  )
}
