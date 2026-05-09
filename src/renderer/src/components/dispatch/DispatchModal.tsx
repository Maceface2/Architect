import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, History, Pencil, Rocket, Trash2, X } from 'lucide-react'
import {
  AGENT_RUNTIMES,
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  type AgentRuntime,
} from '../../../../shared/agentRuntimes'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import { useProjectDir } from '../../context/ProjectDirContext'
import { useWorkspace } from '../../context/WorkspaceContext'
import { pickerRuntimes, useRuntimeDetection } from '../../context/RuntimeDetectionContext'
import { RuntimeEmptyState } from '../runtime/RuntimeEmptyState'
import type { DispatchRecord, DispatchRequest } from '../../types'

export interface ZoneOption {
  id: string
  label: string
  color: string
  // Workspace folder this zone belongs to. Set when the workspace has more
  // than one folder loaded and the zone has been tagged via merge or drop
  // targeting. Single-folder workspaces leave this undefined.
  folderPath?: string
}

interface Props {
  zones: ZoneOption[]
  prefillPrompt?: string
  onClose: () => void
  onSubmit: (req: DispatchRequest) => void
}

type Tab = 'new' | 'resume'

// Computes which folder anchors a multi-folder dispatch — the runtime/
// prompts/conductor live under this folder's ARCHITECT/ tree. Picks the
// folder that contributes the most selected zones; the workspace primary
// breaks ties so single-folder workflows stay anchored at the canonical
// project. Returns null when no zones are selected.
function computePrimaryForDispatch(opts: {
  zones: ZoneOption[]
  selectedIds: Set<string>
  primaryPath: string
}): string | null {
  const counts = new Map<string, number>()
  for (const zone of opts.zones) {
    if (!opts.selectedIds.has(zone.id)) continue
    const folderPath = zone.folderPath ?? opts.primaryPath
    counts.set(folderPath, (counts.get(folderPath) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  // First pass: find the highest contribution count.
  let bestCount = -1
  for (const count of counts.values()) {
    if (count > bestCount) bestCount = count
  }
  // Second pass: among folders tied at bestCount, prefer the workspace
  // primary; otherwise return the first one we see (Map iteration order
  // matches insertion order, which mirrors zone declaration order).
  if ((counts.get(opts.primaryPath) ?? -1) === bestCount) return opts.primaryPath
  for (const [folderPath, count] of counts) {
    if (count === bestCount) return folderPath
  }
  return null
}

export default function DispatchModal({ zones, prefillPrompt, onClose, onSubmit }: Props) {
  const zoneCount = zones.length
  const projectDir = useProjectDir()
  const projectSettings = useProjectSettings()
  const { loadedFolders, primaryFolder } = useWorkspace()

  const [tab, setTab] = useState<Tab>('new')
  const [prompt, setPrompt] = useState(prefillPrompt ?? '')
  // Orchestrator (Conductor) CLI: defaults to last-used (persisted) or the
  // canvas default on first run. Local state so the user can re-pick per
  // dispatch without mutating settings until submit.
  const detection = useRuntimeDetection()
  const [conductorRuntime, setConductorRuntime] = useState<AgentRuntime>(
    projectSettings.conductorRuntime ?? projectSettings.dispatchRuntime
  )
  const runtimeMeta = AGENT_RUNTIMES.find(r => r.id === conductorRuntime) ?? AGENT_RUNTIMES[0]
  const conductorDetected = detection.byId[conductorRuntime]
  const runtimeOptions = pickerRuntimes(detection.byId)
  const supportsModel = runtimeMeta.supportsModelSelection
  const detectedModels = conductorDetected.models ?? []
  const modelSuggestions = detectedModels.length > 0
    ? detectedModels
    : (runtimeMeta.suggestedModels ?? [])
  const conductorNotInstalled = !conductorDetected.installed
  const [model, setModel] = useState<string>(
    projectSettings.dispatchModels[conductorRuntime] ?? DEFAULT_MODEL_BY_RUNTIME[conductorRuntime] ?? ''
  )
  const [planMode, setPlanMode] = useState(projectSettings.dispatchPlanMode)
  const [selectedZoneIds, setSelectedZoneIds] = useState<Set<string>>(() => new Set(zones.map(z => z.id)))
  const [priorSessions, setPriorSessions] = useState<DispatchRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (tab === 'new') promptRef.current?.focus()
  }, [tab])

  // Keep the model picker coherent with the Orchestrator CLI: when the user
  // swaps runtimes, reset `model` to that runtime's configured default so
  // stale Codex-model strings don't leak into a Claude dispatch.
  useEffect(() => {
    setModel(projectSettings.dispatchModels[conductorRuntime] ?? DEFAULT_MODEL_BY_RUNTIME[conductorRuntime] ?? '')
  }, [conductorRuntime, projectSettings.dispatchModels])

  const reload = useCallback(async () => {
    if (!projectDir) return
    setLoading(true)
    try {
      const records = await window.electron.dispatches.list(projectDir)
      setPriorSessions(records ?? [])
    } finally {
      setLoading(false)
    }
  }, [projectDir])

  useEffect(() => { void reload() }, [reload])

  const selectedCount = selectedZoneIds.size
  const canSubmitNew = prompt.trim().length > 0 && selectedCount > 0

  // Group zones by folder so the picker reads as one column per folder.
  // Single-folder workspaces collapse back to the flat layout (no header
  // chrome) by short-circuiting on loadedFolders.length < 2.
  const zonesByFolder = useMemo(() => {
    const groups = new Map<string, ZoneOption[]>()
    for (const folder of loadedFolders) groups.set(folder.path, [])
    for (const zone of zones) {
      const target = zone.folderPath && groups.has(zone.folderPath)
        ? zone.folderPath
        : primaryFolder.path
      const bucket = groups.get(target) ?? groups.get(primaryFolder.path)
      bucket?.push(zone)
    }
    return groups
  }, [zones, loadedFolders, primaryFolder.path])

  const primaryForDispatch = useMemo(
    () => computePrimaryForDispatch({
      zones,
      selectedIds: selectedZoneIds,
      primaryPath: primaryFolder.path,
    }),
    [zones, selectedZoneIds, primaryFolder.path],
  )

  const involvedFolderCount = useMemo(() => {
    const seen = new Set<string>()
    for (const zone of zones) {
      if (!selectedZoneIds.has(zone.id)) continue
      seen.add(zone.folderPath ?? primaryFolder.path)
    }
    return seen.size
  }, [zones, selectedZoneIds, primaryFolder.path])

  const toggleZone = (id: string) => {
    setSelectedZoneIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllZones = () => setSelectedZoneIds(new Set(zones.map(z => z.id)))
  const selectNoZones = () => setSelectedZoneIds(new Set())

  const handleSubmitNew = () => {
    if (!canSubmitNew) return
    onSubmit({
      mode: 'new',
      userPrompt: prompt.trim(),
      model,
      planMode,
      onlyZoneIds: Array.from(selectedZoneIds),
      conductorRuntime,
    })
  }

  const handleResume = (record: DispatchRecord) => {
    onSubmit({ mode: 'resume', dispatchId: record.architectSessionId })
  }

  const handleDelete = async (record: DispatchRecord) => {
    if (!projectDir) return
    await window.electron.dispatches.delete(projectDir, record.architectSessionId)
    void reload()
  }

  const commitRename = async () => {
    if (!projectDir || !editing) return
    const trimmed = editing.draft.trim()
    if (!trimmed) { setEditing(null); return }
    await window.electron.dispatches.updateSummary(projectDir, editing.id, trimmed)
    setEditing(null)
    void reload()
  }

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-white/10 rounded-md shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-white/10">
          <div>
            <h2 className="text-lg font-semibold text-fg flex items-center gap-2">
              <Rocket size={18} /> Dispatch
            </h2>
            <p className="text-xs text-fg-muted mt-1">
              {zoneCount === 0
                ? 'No zones on the canvas.'
                : selectedCount >= 2
                  ? `Architect coordinator will run across ${selectedCount} selected zones.`
                  : selectedCount === 1
                    ? 'Single zone selected. Runs directly without a coordinator.'
                    : 'Select at least one zone below.'}
            </p>
          </div>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors flex-shrink-0 p-1">
            <X size={20} />
          </button>
        </div>

        <div className="flex items-center gap-1 px-6 pt-3 border-b border-white/10">
          <TabButton active={tab === 'new'} onClick={() => setTab('new')}>New dispatch</TabButton>
          <TabButton active={tab === 'resume'} onClick={() => setTab('resume')}>
            Resume previous{priorSessions.length ? ` · ${priorSessions.length}` : ''}
          </TabButton>
        </div>

        {tab === 'new' ? (
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            {zoneCount > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-fg-muted">
                    Zones to involve <span className="text-fg-subtle">· {selectedCount}/{zoneCount}</span>
                  </label>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button type="button" onClick={selectAllZones} className="text-fg-muted hover:text-fg transition-colors">Select all</button>
                    <span className="text-fg-subtle">·</span>
                    <button type="button" onClick={selectNoZones} className="text-fg-muted hover:text-fg transition-colors">Select none</button>
                  </div>
                </div>
                {loadedFolders.length < 2 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {zones.map(z => (
                      <ZonePill key={z.id} zone={z} selected={selectedZoneIds.has(z.id)} onToggle={toggleZone} />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {loadedFolders.map(folder => {
                      const groupZones = zonesByFolder.get(folder.path) ?? []
                      if (groupZones.length === 0) return null
                      const isDispatchPrimary = folder.path === primaryForDispatch
                      return (
                        <div key={folder.path}>
                          <div className="flex items-center gap-1.5 mb-1.5 text-[10px] uppercase tracking-wider text-fg-subtle font-mono">
                            <span
                              className="inline-block w-2 h-2 rounded-sm flex-shrink-0"
                              style={{ background: folder.color }}
                              aria-hidden
                            />
                            <span className="text-fg-muted">{folder.label}</span>
                            {folder.isPrimary && (
                              <span className="text-fg-subtle">primary</span>
                            )}
                            {isDispatchPrimary && involvedFolderCount > 1 && (
                              <span
                                className="ml-1 text-[9px] px-1 py-0.5 rounded border border-accent/40 text-accent"
                                title="Runtime/prompts will live under this folder's ARCHITECT/ for the dispatch"
                              >
                                anchor
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {groupZones.map(z => (
                              <ZonePill
                                key={z.id}
                                zone={z}
                                selected={selectedZoneIds.has(z.id)}
                                onToggle={toggleZone}
                              />
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                <p className="text-[11px] text-fg-subtle mt-1.5">
                  Only the selected zones will receive task files. Others remain idle for this dispatch.
                  {involvedFolderCount > 1 && (
                    <>
                      {' '}Spans <strong className="text-fg-muted">{involvedFolderCount}</strong> folders;
                      runtime + prompts anchor at the marked folder.
                    </>
                  )}
                </p>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1.5">User prompt <span className="text-red-400/70">*</span></label>
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleSubmitNew()
                  }
                }}
                placeholder="Describe what this dispatch should do…"
                rows={5}
                className="w-full bg-canvas border border-white/10 rounded-md px-3 py-2 text-sm text-fg resize-y focus:outline-none focus:border-accent"
              />
              <p className="text-[11px] text-fg-subtle mt-1">Cmd/Ctrl+Enter to dispatch.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1.5">
                Orchestrator CLI
                <span className="ml-1 text-[10px] text-fg-subtle uppercase tracking-wider">Conductor</span>
              </label>
              {detection.installed.length === 0 ? (
                <RuntimeEmptyState compact />
              ) : (
                <>
                  <select
                    value={conductorRuntime}
                    onChange={e => setConductorRuntime(e.target.value as AgentRuntime)}
                    className={`w-full bg-canvas border rounded-md px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent ${
                      conductorNotInstalled ? 'border-amber-400/40' : 'border-white/10'
                    }`}
                  >
                    {runtimeOptions.map(r => {
                      const def = getAgentRuntime(r.id)
                      return (
                        <option key={r.id} value={r.id}>
                          {def.label}{!r.installed ? ' (not installed)' : ''}
                        </option>
                      )
                    })}
                  </select>
                  {conductorNotInstalled && (
                    <p className="text-[11px] text-amber-300 mt-1">
                      {runtimeMeta.label} is selected but not installed. Install it or pick another CLI.
                    </p>
                  )}
                </>
              )}
              <p className="text-[11px] text-fg-subtle mt-1">
                Runs the multi-zone Conductor. Zones keep their individually configured CLIs.
              </p>
            </div>

            <div className={supportsModel ? 'grid grid-cols-2 gap-4' : ''}>
              {supportsModel && (
                <div>
                  <label className="block text-xs font-medium text-fg-muted mb-1.5">Model ({runtimeMeta.label})</label>
                  <select
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    className="w-full bg-canvas border border-white/10 rounded-md px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent"
                  >
                    {modelSuggestions.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                    {!modelSuggestions.includes(model) && model && (
                      <option value={model}>{model}</option>
                    )}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-fg-muted mb-1.5">Permissions</label>
                <label className="flex items-center gap-2 bg-canvas border border-white/10 rounded-md px-3 py-2 text-sm text-fg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={planMode}
                    onChange={e => setPlanMode(e.target.checked)}
                  />
                  <span>Plan mode</span>
                </label>
                <p className="text-[11px] text-fg-subtle mt-1">
                  {selectedCount >= 2
                    ? 'Applied to the Architect coordinator only. Zones still execute autonomously.'
                    : 'Claude will plan before making changes.'}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-fg-muted flex items-center gap-1.5">
                <History size={13} /> Previous dispatches
              </label>
              <span className="text-[11px] text-fg-subtle">{priorSessions.length} saved</span>
            </div>

            {loading ? (
              <p className="text-xs text-fg-subtle bg-canvas border border-white/5 rounded-md px-3 py-3">Loading…</p>
            ) : priorSessions.length === 0 ? (
              <p className="text-xs text-fg-subtle bg-canvas border border-white/5 rounded-md px-3 py-3">
                No prior dispatches. Run a new dispatch to build history.
              </p>
            ) : (
              <ul className="space-y-1 max-h-[50vh] overflow-y-auto pr-1">
                {priorSessions.map(record => {
                  const when = new Date(record.timestamp).toLocaleString()
                  const isEditing = editing?.id === record.architectSessionId
                  return (
                    <li
                      key={record.architectSessionId}
                      className="bg-canvas border border-white/10 hover:border-white/30 rounded-md px-3 py-2 text-xs transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {isEditing ? (
                          <>
                            <input
                              autoFocus
                              value={editing.draft}
                              onChange={e => setEditing({ ...editing, draft: e.target.value })}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
                                if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
                              }}
                              className="flex-1 bg-surface border border-white/20 rounded px-2 py-1 text-xs text-fg focus:outline-none focus:border-accent"
                            />
                            <button
                              onClick={commitRename}
                              className="w-6 h-6 flex items-center justify-center rounded text-emerald-400 hover:bg-emerald-400/10"
                              title="Save name"
                            >
                              <Check size={12} />
                            </button>
                            <button
                              onClick={() => setEditing(null)}
                              className="w-6 h-6 flex items-center justify-center rounded text-fg-muted hover:bg-white/10"
                              title="Cancel"
                            >
                              <X size={12} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => handleResume(record)}
                              className="flex-1 text-left min-w-0"
                              title="Resume this dispatch (coordinator + all zones)"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-fg font-medium truncate">
                                  {record.summary || record.userPrompt || '(no prompt)'}
                                </span>
                              </div>
                              <div className="text-fg-subtle mt-0.5 truncate">
                                {when} · {record.zoneLabels.join(' · ') || `${record.zoneIds.length} zones`} · {record.model}{record.planMode ? ' · plan' : ''}
                              </div>
                            </button>
                            <button
                              onClick={() => setEditing({ id: record.architectSessionId, draft: record.summary || record.userPrompt || '' })}
                              className="w-6 h-6 flex items-center justify-center rounded text-fg-subtle hover:text-fg hover:bg-white/10"
                              title="Rename"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              onClick={() => handleDelete(record)}
                              className="w-6 h-6 flex items-center justify-center rounded text-fg-subtle hover:text-red-400 hover:bg-red-400/10"
                              title="Delete"
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
          >
            Cancel
          </button>
          {tab === 'new' && (
            <button
              onClick={handleSubmitNew}
              disabled={!canSubmitNew}
              className="px-4 py-1.5 text-sm font-medium rounded-md bg-accent text-fg hover:bg-accent/90 disabled:bg-white/5 disabled:text-fg-subtle disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
            >
              <Rocket size={14} /> Dispatch
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
        active
          ? 'text-fg border-accent'
          : 'text-fg-muted border-transparent hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

function ZonePill({
  zone,
  selected,
  onToggle,
}: {
  zone: ZoneOption
  selected: boolean
  onToggle: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(zone.id)}
      className={`px-2.5 py-1 text-xs rounded-md border transition-colors flex items-center gap-1.5 ${
        selected
          ? 'bg-white/10 border-white/20 text-fg'
          : 'bg-canvas border-white/10 text-fg-subtle hover:text-fg-muted'
      }`}
    >
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: selected ? zone.color : 'transparent', border: `1px solid ${zone.color}` }}
      />
      {zone.label}
    </button>
  )
}
