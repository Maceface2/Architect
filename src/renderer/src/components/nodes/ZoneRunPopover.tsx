import { useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { Play, X } from 'lucide-react'
import {
  AGENT_RUNTIMES,
  type AgentRuntime,
} from '../../../../shared/agentRuntimes'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import { useProjectDir } from '../../context/ProjectDirContext'

interface Props {
  zoneId: string
  label: string
  effectiveRuntime: AgentRuntime
  effectiveModel: string
  onClose: () => void
}

export default function ZoneRunPopover({
  zoneId,
  label,
  effectiveRuntime,
  effectiveModel,
  onClose,
}: Props) {
  const projectDir = useProjectDir()
  const projectSettings = useProjectSettings()
  const { getNodes, getEdges } = useReactFlow()

  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(effectiveModel)
  const [planMode, setPlanMode] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const runtimeMeta = AGENT_RUNTIMES.find(r => r.id === effectiveRuntime) ?? AGENT_RUNTIMES[0]

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => { promptRef.current?.focus() }, [])

  const handleSubmit = async () => {
    if (!prompt.trim() || !projectDir || submitting) return
    setSubmitting(true)
    try {
      await window.electron.zone.run({
        projectDir,
        zoneId,
        nodes: getNodes(),
        edges: getEdges(),
        userPrompt: prompt.trim(),
        model,
        planMode,
        settings: projectSettings,
      })
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-white/10 rounded-xl shadow-2xl w-full max-w-md flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-3 border-b border-white/10">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Play size={14} /> Run {label}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Continues this zone's conversation.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white p-1">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Prompt</label>
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              rows={4}
              placeholder="What should this zone do?"
              className="w-full bg-canvas border border-white/10 rounded-md px-3 py-2 text-sm text-white resize-y focus:outline-none focus:border-accent"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Model</label>
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full bg-canvas border border-white/10 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:border-accent"
              >
                {runtimeMeta.suggestedModels.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
                {!runtimeMeta.suggestedModels.includes(model) && (
                  <option value={model}>{model}</option>
                )}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Permissions</label>
              <label className="flex items-center gap-2 bg-canvas border border-white/10 rounded-md px-2 py-1.5 text-xs text-white cursor-pointer">
                <input
                  type="checkbox"
                  checked={planMode}
                  onChange={e => setPlanMode(e.target.checked)}
                />
                <span>Plan mode</span>
              </label>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-slate-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!prompt.trim() || submitting}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 disabled:bg-white/5 disabled:text-slate-500 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <Play size={12} /> {submitting ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  )
}
