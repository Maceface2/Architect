import type { CSSProperties } from 'react'
import { Zap, Loader2, FolderOpen, Save, Bot, Undo2, Redo2, RefreshCw, Bug } from 'lucide-react'

interface TopNavProps {
  activeTab: string
  onTabChange: (tab: string) => void
  onClear: () => void
  onDispatch: () => void
  dispatching: boolean
  nodeCount: number
  projectDir: string
  onChangeDir: () => void
  onSave: () => void
  isDirty: boolean
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
  onOpenBugReport: () => void
}

const TABS = ['Canvas', 'Files', 'Terminal', 'Logs', 'Settings']

export default function TopNav({
  activeTab, onTabChange, onClear,
  onDispatch, dispatching, nodeCount,
  projectDir, onChangeDir, onSave, isDirty,
  onAssistantToggle, assistantOpen, isRedispatch, changedCount,
  onUndo, onRedo, canUndo, canRedo,
  updateReady, onUpdateInstall,
  onOpenBugReport,
}: TopNavProps) {
  const dirName = projectDir.split('/').filter(Boolean).pop() ?? projectDir

  return (
    <div className="flex flex-col bg-panel border-b border-node-border flex-shrink-0">
      {/* Row 1 — drag region (so the user can move the window from this bar)
          with the traffic lights inset over the left padding by hiddenInset.
          Buttons inside opt out via no-drag so clicks aren't swallowed. */}
      <div
        className="flex items-center justify-between h-11 pr-4"
        style={{ WebkitAppRegion: 'drag', paddingLeft: 88 } as CSSProperties}
      >
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
            <FolderOpen size={11} className="text-amber-400 flex-shrink-0" />
            <span className="truncate font-mono">{dirName}</span>
          </button>
        </div>

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
            onClick={onSave}
            className="relative flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-muted border border-node-border rounded hover:bg-node transition-colors"
            title="Save canvas"
          >
            <Save size={12} />
            Save
            {isDirty && (
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400" />
            )}
          </button>
          <button
            onClick={onAssistantToggle}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${
              assistantOpen
                ? 'text-[#c084fc] border-[#c084fc]/40 bg-[#c084fc]/10 hover:bg-[#c084fc]/20'
                : 'text-fg-muted border-node-border hover:bg-node'
            }`}
            title="Architecture assistant"
          >
            <Bot size={12} />
            Assistant
          </button>
          <button onClick={onClear} className="px-3 py-1.5 text-xs text-fg-muted border border-node-border rounded hover:bg-node transition-colors">
            Clear
          </button>
          <button
            onClick={onOpenBugReport}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-muted border border-node-border rounded hover:bg-node transition-colors"
            title="Report a bug"
          >
            <Bug size={12} />
            Report a bug
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

      {/* Row 2 — primary tabs. */}
      <div className="flex items-center gap-0.5 h-9 px-4 border-t border-node-border/50">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              activeTab === tab
                ? 'text-fg bg-node'
                : 'text-fg-muted hover:text-fg hover:bg-node/50'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
    </div>
  )
}
