import { useEffect } from 'react'
import { Eye, Pencil } from 'lucide-react'
import Markdown from './Markdown'

export type MarkdownMode = 'edit' | 'preview'

/**
 * Header control that flips a note between edit and reading mode. Mounted by
 * the host (AgentConfigModal / ComponentConfigModal) into the DocPane header
 * so it reads like Obsidian's per-note view switch. The label names the mode
 * it switches TO.
 */
export function MarkdownModeToggle({
  mode,
  onToggle,
}: {
  mode: MarkdownMode
  onToggle: () => void
}) {
  const toPreview = mode === 'edit'
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-fg-muted transition-colors hover:bg-node hover:text-fg"
      title={`${toPreview ? 'Preview' : 'Edit'} (⌘E)`}
      aria-label={`Switch to ${toPreview ? 'reading' : 'edit'} mode`}
    >
      {toPreview ? <Eye size={14} /> : <Pencil size={14} />}
      {toPreview ? 'Preview' : 'Edit'}
    </button>
  )
}

interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  mode: MarkdownMode
  onToggleMode: () => void
  placeholder?: string
  autoFocus?: boolean
  /** Min editor/preview height so a short note still feels like a full page. */
  minHeight?: number
}

/**
 * Obsidian-style note body. Edit mode is a system-font textarea showing raw
 * markdown; preview mode renders it via <Markdown>. ⌘E (Ctrl+E) toggles the
 * two, matching Obsidian's keybinding. The mode itself is owned by the host so
 * the toggle can live in the DocPane header (see MarkdownModeToggle).
 */
export default function MarkdownEditor({
  value,
  onChange,
  mode,
  onToggleMode,
  placeholder,
  autoFocus,
  minHeight = 460,
}: MarkdownEditorProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        onToggleMode()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onToggleMode])

  if (mode === 'preview') {
    return (
      <div style={{ minHeight }}>
        {value.trim() ? (
          <Markdown>{value}</Markdown>
        ) : (
          <p className="text-[13px] italic text-fg-subtle">Nothing to preview yet.</p>
        )}
      </div>
    )
  }

  return (
    <textarea
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      style={{ minHeight }}
      className="w-full resize-none border-0 bg-transparent text-[15px] leading-7 text-fg outline-none placeholder:text-fg-subtle"
    />
  )
}
