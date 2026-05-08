import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { getIcon } from '../../lib/icons'
import { fieldTypeColor, mintFieldId } from '../../lib/fieldTypes'
import type { ComponentField, ComponentNodeData } from '../../types'

interface Props {
  label: string
  tag: string
  color: string
  iconName: string
  description: string
  specs: string
  fields: ComponentField[]
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
  fields,
  patch,
  onClose,
}: Props) {
  const [labelDraft, setLabelDraft] = useState(label)
  const [tagDraft, setTagDraft] = useState(tag)
  const labelInputRef = useRef<HTMLInputElement>(null)
  const Icon = getIcon(iconName)

  const updateField = (id: string, partial: Partial<ComponentField>) => {
    patch({ fields: fields.map(f => (f.id === id ? { ...f, ...partial } : f)) })
  }
  const addField = () => {
    patch({ fields: [...fields, { id: mintFieldId(), key: '', value: '' }] })
  }
  const removeField = (id: string) => {
    patch({ fields: fields.filter(f => f.id !== id) })
  }

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
        className="bg-[#1c1916] rounded-md border border-white/10 shadow-2xl flex flex-col overflow-hidden"
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
              placeholder="Describe this component in detail: responsibilities, API contracts, schemas, ports, interfaces, invariants, anything the zone's agent needs to know when building it."
              autoFocus
              className="flex-1 bg-transparent text-fg text-sm leading-relaxed px-6 pb-6 resize-none focus:outline-none placeholder-fg-subtle font-mono"
            />
          </div>

          {/* Metadata sidebar */}
          <div className="w-[320px] flex-shrink-0 overflow-y-auto">
            <div className="p-6 space-y-6">
              <Section title="Properties">
                <div className="space-y-1.5">
                  {fields.length === 0 && (
                    <p className="text-[11px] text-fg-subtle leading-relaxed">
                      Add structured spec rows. Any key, any value. Schema-type values
                      (<span className="font-medium" style={{ color: fieldTypeColor('uuid') }}>uuid</span>,{' '}
                      <span className="font-medium" style={{ color: fieldTypeColor('string') }}>string</span>,{' '}
                      <span className="font-medium" style={{ color: fieldTypeColor('int') }}>int</span>…) get colored automatically; everything else renders neutral.
                    </p>
                  )}
                  {fields.map(field => (
                    <div key={field.id} className="flex items-center gap-1.5">
                      <input
                        value={field.key}
                        onChange={event => updateField(field.id, { key: event.target.value })}
                        placeholder="key"
                        className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded-[2px] px-2 py-1 text-[12px] text-fg placeholder-fg-subtle focus:outline-none focus:border-white/20"
                      />
                      <input
                        value={field.value}
                        onChange={event => updateField(field.id, { value: event.target.value })}
                        placeholder="value"
                        list={`field-values-${field.id}`}
                        className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded-[2px] px-2 py-1 text-[12px] placeholder-fg-subtle focus:outline-none focus:border-white/20"
                        style={{ color: fieldTypeColor(field.value) }}
                      />
                      <datalist id={`field-values-${field.id}`}>
                        <option value="string" />
                        <option value="int" />
                        <option value="float" />
                        <option value="bool" />
                        <option value="enum" />
                        <option value="uuid" />
                        <option value="date" />
                        <option value="json" />
                        <option value="array" />
                        <option value="ref" />
                      </datalist>
                      <button
                        onClick={() => removeField(field.id)}
                        className="w-6 h-6 flex items-center justify-center rounded-[2px] text-fg-subtle hover:text-red-300 hover:bg-red-500/15 transition-colors flex-shrink-0"
                        title="Remove property"
                        aria-label="Remove property"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addField}
                    className="flex items-center gap-1.5 mt-1 px-2 py-1 text-[10px] uppercase tracking-[0.18em] font-medium text-fg-muted border border-white/[0.08] rounded-[2px] hover:bg-white/5 hover:text-fg transition-colors"
                  >
                    <Plus size={10} />
                    Add property
                  </button>
                </div>
              </Section>

              {fields.length > 0 && (
                <Section title="Preview">
                  <div className="rounded-[3px] border border-white/[0.06] bg-component overflow-hidden">
                    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-canvas border-b border-white/[0.06]">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon size={13} strokeWidth={1.7} className="text-fg-muted flex-shrink-0" />
                        <span className="text-[13px] font-semibold text-fg truncate">
                          {labelDraft || label || 'Component'}
                        </span>
                      </div>
                      {tagDraft && (
                        <span className="text-[11px] italic text-fg-subtle flex-shrink-0">
                          «{tagDraft.toLowerCase()}»
                        </span>
                      )}
                    </div>
                    <div className="px-3 py-2 space-y-0.5">
                      {fields.map(field => (
                        <div
                          key={field.id}
                          className="flex items-baseline justify-between gap-3 text-[12px] leading-relaxed"
                        >
                          <span className="text-fg truncate">
                            {field.key || <span className="text-fg-subtle italic">unkeyed</span>}
                          </span>
                          <span
                            className="flex-shrink-0 truncate text-right max-w-[60%]"
                            style={{ color: fieldTypeColor(field.value) }}
                          >
                            {field.value || '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Section>
              )}

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
                <p className="text-[10px] text-fg-subtle mt-1.5">Up to 8 chars. Shown in the corner of the node.</p>
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
