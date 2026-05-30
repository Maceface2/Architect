import { useRef, useState } from 'react'
import type { ComponentNodeData } from '../../types'
import DocPane from '../docpane/DocPane'
import MarkdownEditor, { MarkdownModeToggle, type MarkdownMode } from '../docpane/MarkdownEditor'

interface Props {
  label: string
  specs: string
  patch: (partial: Partial<ComponentNodeData>) => void
  onClose: () => void
}

// A component is now a pure markdown note: a title plus a free-form body
// (`specs`). The former structured editors (typed fields, tag, icon, accent
// color) are gone — that data still rides along in the canvas JSON for
// back-compat, it just isn't surfaced here anymore. The canvas card renders a
// preview derived from this note.
export default function ComponentConfigModal({ label, specs, patch, onClose }: Props) {
  const [labelDraft, setLabelDraft] = useState(label)
  const [mode, setMode] = useState<MarkdownMode>('edit')
  const labelInputRef = useRef<HTMLInputElement>(null)
  const toggleMode = () => setMode(prev => (prev === 'edit' ? 'preview' : 'edit'))

  const saveLabel = () => {
    const trimmed = labelDraft.trim()
    if (trimmed && trimmed !== label) patch({ label: trimmed })
  }

  return (
    <DocPane
      title={labelDraft.trim() || label || 'Component'}
      kindLabel="Component"
      onClose={onClose}
      headerActions={<MarkdownModeToggle mode={mode} onToggle={toggleMode} />}
    >
      <div className="space-y-5">
        {/* Title — the note's H1; renames the component */}
        <input
          ref={labelInputRef}
          value={labelDraft}
          onChange={event => setLabelDraft(event.target.value)}
          onBlur={saveLabel}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              saveLabel()
              labelInputRef.current?.blur()
            }
          }}
          className="w-full border-0 bg-transparent p-0 text-[26px] font-semibold tracking-[-0.02em] text-fg outline-none placeholder:text-fg-subtle"
          placeholder="Component name"
        />

        {/* Body: the component spec note */}
        <MarkdownEditor
          value={specs}
          onChange={value => patch({ specs: value })}
          mode={mode}
          onToggleMode={toggleMode}
          autoFocus
          minHeight={520}
          placeholder={'Describe this component: responsibilities, API contracts, schemas, interfaces, invariants — anything the zone’s agent needs to build it.\n\n# Responsibilities\n- ...\n\n# API\n- ...'}
        />
      </div>
    </DocPane>
  )
}
