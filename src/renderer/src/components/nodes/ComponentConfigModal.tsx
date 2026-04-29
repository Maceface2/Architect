import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { getIcon } from '../../lib/icons'
import type { ComponentNodeData } from '../../types'

interface Props {
  label: string
  tag: string
  color: string
  iconName: string
  description: string
  specs: string
  patch: (partial: Partial<ComponentNodeData>) => void
  onClose: () => void
}

export default function ComponentConfigModal({
  label,
  tag,
  color,
  iconName,
  description,
  specs,
  patch,
  onClose,
}: Props) {
  const [labelDraft, setLabelDraft] = useState(label)
  const [tagDraft, setTagDraft] = useState(tag)
  const labelInputRef = useRef<HTMLInputElement>(null)
  const Icon = getIcon(iconName)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const saveLabel = () => {
    const trimmed = labelDraft.trim()
    if (trimmed && trimmed !== label) patch({ label: trimmed })
  }

  const saveTag = () => {
    const trimmed = tagDraft.trim().toUpperCase().slice(0, 8)
    if (trimmed && trimmed !== tag) patch({ tag: trimmed })
    else setTagDraft(tag)
  }

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        className="bg-[#161616] rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '90vw', height: '85vh', maxWidth: 1000 }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-4 px-6 py-4 border-b border-white/[0.07] flex-shrink-0"
          style={{ borderLeftColor: color, borderLeftWidth: 4 }}
        >
          <div className="flex items-center gap-2 flex-shrink-0">
            <Icon size={14} style={{ color }} />
            <span className="text-[11px] font-bold tracking-widest uppercase" style={{ color }}>Component</span>
          </div>
          <input
            ref={labelInputRef}
            value={labelDraft}
            onChange={event => setLabelDraft(event.target.value)}
            onBlur={saveLabel}
            onKeyDown={event => { if (event.key === 'Enter') { saveLabel(); labelInputRef.current?.blur() } }}
            className="text-lg font-semibold text-fg bg-transparent border-b border-transparent hover:border-white/20 focus:border-white/40 focus:outline-none transition-colors flex-1 min-w-0"
            placeholder="Component name"
          />
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors flex-shrink-0 p-1">
            <X size={18} />
          </button>
        </div>

        {/* Body: 2-column — specs on left, metadata on right */}
        <div className="flex flex-1 min-h-0 divide-x divide-white/[0.06]">
          {/* Specs pane */}
          <div className="flex flex-col flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-fg-subtle px-6 pt-5 pb-2 flex-shrink-0">Specs & notes</p>
            <textarea
              value={specs}
              onChange={event => patch({ specs: event.target.value })}
              placeholder="Describe this component in detail — its responsibilities, API contracts, schemas, ports, interfaces, invariants, anything the zone's agent needs to know when building it."
              autoFocus
              className="flex-1 bg-transparent text-fg text-sm leading-relaxed px-6 pb-6 resize-none focus:outline-none placeholder-fg-subtle font-mono"
            />
          </div>

          {/* Metadata sidebar */}
          <div className="w-[320px] flex-shrink-0 overflow-y-auto">
            <div className="p-6 space-y-6">
              <Section title="Tagline">
                <textarea
                  value={description}
                  onChange={event => patch({ description: event.target.value })}
                  placeholder="One-line summary shown on the node"
                  rows={2}
                  className="w-full bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-fg-muted placeholder-fg-subtle focus:outline-none focus:border-white/20 resize-none"
                />
              </Section>

              <Section title="Tag">
                <input
                  value={tagDraft}
                  onChange={event => setTagDraft(event.target.value)}
                  onBlur={saveTag}
                  onKeyDown={event => { if (event.key === 'Enter') saveTag() }}
                  maxLength={8}
                  className="w-full bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-fg font-mono tracking-widest placeholder-fg-subtle focus:outline-none focus:border-white/20 uppercase"
                  placeholder="TAG"
                />
                <p className="text-[10px] text-fg-subtle mt-1.5">Up to 8 chars — shown in the corner of the node.</p>
              </Section>

              <Section title="Accent color">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={color}
                    onChange={event => patch({ color: event.target.value })}
                    className="w-10 h-9 rounded bg-transparent cursor-pointer border border-white/10"
                  />
                  <input
                    value={color}
                    onChange={event => patch({ color: event.target.value })}
                    className="flex-1 bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-fg-muted font-mono focus:outline-none focus:border-white/20"
                  />
                </div>
              </Section>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-fg-subtle mb-2">{title}</p>
      {children}
    </div>
  )
}
