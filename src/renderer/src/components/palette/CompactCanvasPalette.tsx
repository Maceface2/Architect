import { useEffect, useState } from 'react'
import { Box, GitBranch, Layers, MousePointer2, X } from 'lucide-react'
import { AGENT_RUNTIMES, DEFAULT_MODEL_BY_RUNTIME, getAgentRuntime, type AgentRuntime } from '../../../../shared/agentRuntimes'
import type { ComponentEdgeDirection } from '../../types'

export type CanvasPaletteTool = 'edge' | 'zone' | 'component'

export interface ComponentCreateConfig {
  label: string
  specs: string
  tag: string
  color: string
}

export interface ZoneCreateConfig {
  label: string
  systemPrompt: string
  runtime: AgentRuntime
  model: string
  color: string
}

export interface EdgeCreateConfig {
  label: string
  direction: ComponentEdgeDirection
}

interface CompactCanvasPaletteProps {
  activeTool: CanvasPaletteTool | null
  placementHint: string | null
  defaultZoneRuntime: AgentRuntime
  defaultZoneModel: string
  onCreateComponent: (config: ComponentCreateConfig) => void
  onCreateZone: (config: ZoneCreateConfig) => void
  onCreateEdge: (config: EdgeCreateConfig) => void
  onCancel: () => void
}

const directions: Array<{ value: ComponentEdgeDirection; label: string }> = [
  { value: 'source-to-target', label: 'One-way' },
  { value: 'bidirectional', label: 'Two-way' },
  { value: 'none', label: 'None' },
]

export default function CompactCanvasPalette({
  activeTool,
  placementHint,
  defaultZoneRuntime,
  defaultZoneModel,
  onCreateComponent,
  onCreateZone,
  onCreateEdge,
  onCancel,
}: CompactCanvasPaletteProps) {
  const [dialog, setDialog] = useState<CanvasPaletteTool | null>(null)

  useEffect(() => {
    if (!activeTool) return
    setDialog(null)
  }, [activeTool])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setDialog(null)
      onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const openTool = (tool: CanvasPaletteTool) => {
    onCancel()
    setDialog(tool)
  }

  return (
    <div className="pointer-events-none absolute left-4 top-4 z-30 flex items-start gap-3">
      <div className="pointer-events-auto flex flex-col gap-1 rounded-lg border border-white/10 bg-[#171717]/95 p-1 shadow-2xl backdrop-blur">
        <ToolButton
          label="Edges"
          active={activeTool === 'edge' || dialog === 'edge'}
          icon={<GitBranch size={16} />}
          onClick={() => openTool('edge')}
        />
        <ToolButton
          label="Zones"
          active={activeTool === 'zone' || dialog === 'zone'}
          icon={<Layers size={16} />}
          onClick={() => openTool('zone')}
        />
        <ToolButton
          label="Components"
          active={activeTool === 'component' || dialog === 'component'}
          icon={<Box size={16} />}
          onClick={() => openTool('component')}
        />
        {activeTool && (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-9 w-9 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-white/10 hover:text-fg"
            aria-label="Cancel tool"
            title="Cancel"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {placementHint && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-white/10 bg-[#171717]/95 px-3 py-2 text-xs text-fg-muted shadow-2xl backdrop-blur">
          <MousePointer2 size={14} className="text-accent" />
          {placementHint}
        </div>
      )}

      {dialog === 'component' && (
        <ComponentCreateDialog
          onSubmit={config => {
            onCreateComponent(config)
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'zone' && (
        <ZoneCreateDialog
          defaultRuntime={defaultZoneRuntime}
          defaultModel={defaultZoneModel}
          onSubmit={config => {
            onCreateZone(config)
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'edge' && (
        <EdgeCreateDialog
          onSubmit={config => {
            onCreateEdge(config)
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

function ToolButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded transition-colors ${
        active ? 'bg-accent text-fg' : 'text-fg-muted hover:bg-white/10 hover:text-fg'
      }`}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  )
}

function ComponentCreateDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (config: ComponentCreateConfig) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState('Component')
  const [specs, setSpecs] = useState('')
  const [tag, setTag] = useState('NODE')
  const [color, setColor] = useState('#60a5fa')

  return (
    <PaletteDialog title="New Component" onClose={onClose}>
      <TextField label="Label" value={label} onChange={setLabel} autoFocus />
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Tag" value={tag} onChange={value => setTag(value.toUpperCase().slice(0, 8))} />
        <ColorField label="Color" value={color} onChange={setColor} />
      </div>
      <TextAreaField
        label="Specs & notes"
        value={specs}
        onChange={setSpecs}
        placeholder="Responsibilities, APIs, schemas, requirements, or implementation notes"
        rows={5}
      />
      <DialogActions
        submitLabel="Place component"
        onCancel={onClose}
        onSubmit={() => onSubmit({
          label: label.trim() || 'Component',
          specs: specs.trim(),
          tag: (tag.trim() || 'NODE').toUpperCase().slice(0, 8),
          color,
        })}
      />
    </PaletteDialog>
  )
}

function ZoneCreateDialog({
  defaultRuntime,
  defaultModel,
  onSubmit,
  onClose,
}: {
  defaultRuntime: AgentRuntime
  defaultModel: string
  onSubmit: (config: ZoneCreateConfig) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState('New Zone')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [runtime, setRuntime] = useState<AgentRuntime>(defaultRuntime)
  const [model, setModel] = useState(defaultModel || DEFAULT_MODEL_BY_RUNTIME[defaultRuntime])
  const [color, setColor] = useState('#58A6FF')
  const runtimeDef = getAgentRuntime(runtime)

  return (
    <PaletteDialog title="New Zone" onClose={onClose}>
      <TextField label="Label" value={label} onChange={setLabel} autoFocus />
      <TextAreaField
        label="Optional system prompt"
        value={systemPrompt}
        onChange={setSystemPrompt}
        placeholder="Role, style, constraints, or durable behavior for this zone agent"
        rows={4}
      />
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">Runtime</p>
        <div className="grid grid-cols-2 gap-1">
          {AGENT_RUNTIMES.map(option => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                setRuntime(option.id)
                setModel(DEFAULT_MODEL_BY_RUNTIME[option.id])
              }}
              className={`rounded px-2 py-1.5 text-xs transition-colors ${
                runtime === option.id ? 'bg-accent text-fg' : 'bg-black/30 text-fg-muted hover:bg-white/10 hover:text-fg'
              }`}
            >
              {option.shortLabel}
            </button>
          ))}
        </div>
      </div>
      <TextField label="Model" value={model} onChange={setModel} />
      <div className="flex flex-wrap gap-1">
        {runtimeDef.suggestedModels.map(option => (
          <button
            key={option}
            type="button"
            onClick={() => setModel(option)}
            className={`rounded border px-2 py-1 text-[10px] transition-colors ${
              model === option
                ? 'border-accent bg-accent/15 text-fg'
                : 'border-white/10 bg-black/20 text-fg-subtle hover:border-white/20 hover:text-fg-muted'
            }`}
          >
            {option}
          </button>
        ))}
      </div>
      <ColorField label="Color" value={color} onChange={setColor} />
      <DialogActions
        submitLabel="Place zone"
        onCancel={onClose}
        onSubmit={() => onSubmit({
          label: label.trim() || 'New Zone',
          systemPrompt: systemPrompt.trim(),
          runtime,
          model: model.trim() || DEFAULT_MODEL_BY_RUNTIME[runtime],
          color,
        })}
      />
    </PaletteDialog>
  )
}

function EdgeCreateDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (config: EdgeCreateConfig) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const [direction, setDirection] = useState<ComponentEdgeDirection>('source-to-target')

  return (
    <PaletteDialog title="New Edge" onClose={onClose}>
      <TextField label="Label" value={label} onChange={setLabel} autoFocus />
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">Direction</p>
        <div className="grid grid-cols-3 gap-1">
          {directions.map(option => (
            <button
              key={option.value}
              type="button"
              onClick={() => setDirection(option.value)}
              className={`rounded px-2 py-1.5 text-xs transition-colors ${
                direction === option.value ? 'bg-accent text-fg' : 'bg-black/30 text-fg-muted hover:bg-white/10 hover:text-fg'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <DialogActions
        submitLabel="Connect edge"
        onCancel={onClose}
        onSubmit={() => onSubmit({ label: label.trim(), direction })}
      />
    </PaletteDialog>
  )
}

function PaletteDialog({
  title,
  children,
  onClose,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="pointer-events-auto w-[300px] rounded-lg border border-white/10 bg-[#171717]/95 p-4 shadow-2xl backdrop-blur">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded text-fg-subtle hover:bg-white/10 hover:text-fg"
          aria-label="Close"
        >
          <X size={15} />
        </button>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">{label}</span>
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        autoFocus={autoFocus}
        className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
      />
    </label>
  )
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">{label}</span>
      <textarea
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full resize-none rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
      />
    </label>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">{label}</span>
      <input
        type="color"
        value={value}
        onChange={event => onChange(event.target.value)}
        className="h-[38px] w-full cursor-pointer rounded border border-white/10 bg-black/30 p-1"
      />
    </label>
  )
}

function DialogActions({
  submitLabel,
  onCancel,
  onSubmit,
}: {
  submitLabel: string
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <div className="flex items-center justify-end gap-2 pt-1">
      <button
        type="button"
        onClick={onCancel}
        className="rounded px-3 py-2 text-xs font-medium text-fg-muted hover:bg-white/10 hover:text-fg"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onSubmit}
        className="rounded bg-accent px-3 py-2 text-xs font-semibold text-fg hover:bg-[#4a4ad0]"
      >
        {submitLabel}
      </button>
    </div>
  )
}
