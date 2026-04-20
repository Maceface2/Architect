import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Rocket, History } from 'lucide-react'
import {
  AGENT_RUNTIMES,
  DEFAULT_MODEL_BY_RUNTIME,
  type AgentRuntime,
} from '../../../../shared/agentRuntimes'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import { useProjectDir } from '../../context/ProjectDirContext'
import type { DispatchRecord, DispatchRequest } from '../../types'

interface Props {
  zoneCount: number
  onClose: () => void
  onSubmit: (req: DispatchRequest) => void
  onSelectPrior: (zoneIds: string[]) => void
}

export default function DispatchModal({ zoneCount, onClose, onSubmit, onSelectPrior }: Props) {
  const projectDir = useProjectDir()
  const projectSettings = useProjectSettings()
  const defaultRuntime: AgentRuntime = projectSettings.defaultRuntime
  const runtimeMeta = AGENT_RUNTIMES.find(r => r.id === defaultRuntime) ?? AGENT_RUNTIMES[0]

  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<string>(DEFAULT_MODEL_BY_RUNTIME[defaultRuntime])
  const [planMode, setPlanMode] = useState(false)
  const [priorSessions, setPriorSessions] = useState<DispatchRecord[]>([])
  const [selectedPriorId, setSelectedPriorId] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    promptRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    window.electron.listDispatches(projectDir).then(records => {
      if (!cancelled) setPriorSessions(records ?? [])
    })
    return () => { cancelled = true }
  }, [projectDir])

  const selectedPrior = useMemo(
    () => priorSessions.find(r => r.architectSessionId === selectedPriorId) ?? null,
    [priorSessions, selectedPriorId],
  )

  const handleSelectPrior = (record: DispatchRecord) => {
    if (selectedPriorId === record.architectSessionId) {
      setSelectedPriorId(null)
      onSelectPrior([])
      return
    }
    setSelectedPriorId(record.architectSessionId)
    setModel(record.model || DEFAULT_MODEL_BY_RUNTIME[defaultRuntime])
    setPlanMode(record.planMode === true)
    onSelectPrior(record.zoneIds)
  }

  const canSubmit = prompt.trim().length > 0 && zoneCount > 0

  const handleSubmit = () => {
    if (!canSubmit) return
    onSubmit({
      userPrompt: prompt.trim(),
      model,
      planMode,
      onlyZoneIds: selectedPrior ? selectedPrior.zoneIds : undefined,
    })
  }

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-white/10 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-white/10">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Rocket size={18} /> Dispatch
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              {zoneCount >= 2
                ? `Architect coordinator will run across ${zoneCount} zones.`
                : zoneCount === 1
                  ? 'Single zone — will run directly without coordinator.'
                  : 'No zones on the canvas.'}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors flex-shrink-0 p-1">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">User prompt</label>
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
              placeholder="Describe what this dispatch should do…"
              rows={5}
              className="w-full bg-canvas border border-white/10 rounded-md px-3 py-2 text-sm text-white resize-y focus:outline-none focus:border-accent"
            />
            <p className="text-[11px] text-slate-500 mt-1">Cmd/Ctrl+Enter to dispatch.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Model ({runtimeMeta.label})</label>
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full bg-canvas border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-accent"
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
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Permissions</label>
              <label className="flex items-center gap-2 bg-canvas border border-white/10 rounded-md px-3 py-2 text-sm text-white cursor-pointer">
                <input
                  type="checkbox"
                  checked={planMode}
                  onChange={e => setPlanMode(e.target.checked)}
                />
                <span>Plan mode</span>
              </label>
              <p className="text-[11px] text-slate-500 mt-1">
                {zoneCount >= 2
                  ? 'Applied to the Architect coordinator only — zones still execute autonomously.'
                  : 'Claude will plan before making changes.'}
              </p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                <History size={13} /> Prior Architect sessions
              </label>
              <span className="text-[11px] text-slate-500">{priorSessions.length} saved</span>
            </div>
            {priorSessions.length === 0 ? (
              <p className="text-xs text-slate-500 bg-canvas border border-white/5 rounded-md px-3 py-3">
                No prior dispatches. Run a multi-zone dispatch to build history.
              </p>
            ) : (
              <ul className="max-h-48 overflow-y-auto space-y-1 pr-1">
                {priorSessions.map(record => {
                  const selected = selectedPriorId === record.architectSessionId
                  const when = new Date(record.timestamp).toLocaleString()
                  return (
                    <li key={record.architectSessionId}>
                      <button
                        onClick={() => handleSelectPrior(record)}
                        className={`w-full text-left bg-canvas border rounded-md px-3 py-2 text-xs transition-colors ${
                          selected ? 'border-accent' : 'border-white/10 hover:border-white/30'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-slate-200 font-medium truncate">
                            {record.userPrompt || '(no prompt)'}
                          </span>
                          <span className="text-slate-500 flex-shrink-0">{when}</span>
                        </div>
                        <div className="text-slate-500 mt-0.5 truncate">
                          {record.zoneLabels.join(' · ')} — {record.model}{record.planMode ? ' · plan' : ''}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {selectedPrior && (
              <p className="text-[11px] text-accent mt-2">
                Dispatch will target the same {selectedPrior.zoneIds.length} zone{selectedPrior.zoneIds.length === 1 ? '' : 's'} as the selected session.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-slate-300 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-1.5 text-sm font-medium rounded-md bg-accent text-white hover:bg-accent/90 disabled:bg-white/5 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
          >
            <Rocket size={14} /> Dispatch
          </button>
        </div>
      </div>
    </div>
  )
}
