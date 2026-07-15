import type { CSSProperties } from 'react'
import { Zap, Loader2, MessageSquare, Undo2, Redo2, RefreshCw, Files } from 'lucide-react'
import CliqueLogo from '../branding/CliqueLogo'

interface TopNavProps {
  onDispatch: () => void
  dispatching: boolean
  nodeCount: number
  projectDir: string
  onChangeDir: () => void
  onAssistantToggle: () => void
  assistantOpen: boolean
  onFilesToggle: () => void
  filesPanelOpen: boolean
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
  onAssistantToggle, assistantOpen, onFilesToggle, filesPanelOpen, isRedispatch, changedCount,
  onUndo, onRedo, canUndo, canRedo,
  updateReady, onUpdateInstall,
}: TopNavProps) {
  const dirName = projectDir.split('/').filter(Boolean).pop() ?? projectDir

  const pad2 = (n: number) => String(n).padStart(2, '0')

  return (
    <div className="flex flex-shrink-0 border-b border-node-border bg-topbar">
      {/* Header strip: Obsidian-quiet title bar. Drag region with traffic-
          light inset on the left, a flat action row on the right. Buttons are
          borderless and reveal a subtle surface on hover; the system UI font
          carries sentence-case labels (no tracked-uppercase mono chrome). */}
      <div
        className="flex items-center h-11 pr-3 w-full"
        style={{ WebkitAppRegion: 'drag', paddingLeft: 88 } as CSSProperties}
      >
        {/* Left: logo + vault-style path chip */}
        <div className="flex items-center gap-2.5" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
          <CliqueLogo size={22} className="flex-shrink-0 text-fg" />
          <button
            onClick={onChangeDir}
            className="flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-fg-muted transition-colors hover:bg-node hover:text-fg"
            title={projectDir}
          >
            <span className="text-fg-subtle flex-shrink-0">/</span>
            <span className="truncate">{dirName}</span>
          </button>
        </div>

        <div className="flex-1" />

        {/* Right: flat action row. Hairline dividers separate groups. */}
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="flex items-center justify-center w-7 h-7 rounded-md text-fg-muted hover:bg-node hover:text-fg transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Undo (⌘Z)"
            aria-label="Undo"
          >
            <Undo2 size={14} />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="flex items-center justify-center w-7 h-7 rounded-md text-fg-muted hover:bg-node hover:text-fg transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
          >
            <Redo2 size={14} />
          </button>

          <span className="w-px h-4 bg-node-border mx-1.5" aria-hidden />

          <button
            onClick={onFilesToggle}
            className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors ${
              filesPanelOpen
                ? 'text-accent bg-accent/10 hover:bg-accent/15'
                : 'text-fg-muted hover:bg-node hover:text-fg'
            }`}
            title="Toggle file browser"
            aria-pressed={filesPanelOpen}
          >
            <Files size={14} />
            Files
          </button>

          <button
            onClick={onAssistantToggle}
            className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors ${
              assistantOpen
                ? 'text-accent bg-accent/10 hover:bg-accent/15'
                : 'text-fg-muted hover:bg-node hover:text-fg'
            }`}
            title="Architecture assistant"
          >
            <MessageSquare size={14} />
            Assistant
          </button>

          {updateReady && (
            <button
              onClick={onUpdateInstall}
              className="flex items-center gap-1.5 h-7 px-2.5 text-[12px] text-emerald-200 bg-emerald-400/10 rounded-md hover:bg-emerald-400/20 transition-colors"
              title="A new version of Clique was downloaded. Click to restart and install."
            >
              <RefreshCw size={14} />
              Update / Restart
            </button>
          )}

          <span className="w-px h-4 bg-node-border mx-1.5" aria-hidden />

          <button
            onClick={onDispatch}
            disabled={dispatching || nodeCount === 0}
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-fg transition-colors hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-40"
          >
            {dispatching ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
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
