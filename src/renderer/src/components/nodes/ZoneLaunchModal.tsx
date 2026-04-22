import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, History, Pencil, Play, Rocket, Trash2, X } from 'lucide-react'
import { getAgentRuntime, type AgentRuntime } from '../../../../shared/agentRuntimes'
import { useProjectDir } from '../../context/ProjectDirContext'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import type { ProjectSettings, ZoneSessionRecord } from '../../types'

interface Props {
  zoneId: string
  zoneLabel: string
  zoneColor: string
  effectiveRuntime: AgentRuntime
  nodes: unknown[]
  edges: unknown[]
  onClose: () => void
  onLaunched: () => void
}

export default function ZoneLaunchModal({
  zoneId,
  zoneLabel,
  zoneColor,
  effectiveRuntime,
  nodes,
  edges,
  onClose,
  onLaunched,
}: Props) {
  const projectDir = useProjectDir()
  const projectSettings = useProjectSettings() as ProjectSettings
  const runtimeMeta = getAgentRuntime(effectiveRuntime)

  const [sessions, setSessions] = useState<ZoneSessionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [editing, setEditing] = useState<{ sessionId: string; draft: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const promptInputRef = useRef<HTMLTextAreaElement>(null)

  const reload = useCallback(async () => {
    if (!projectDir) return
    setLoading(true)
    try {
      const recs = await window.electron.zone.listSessions(projectDir, zoneId, zoneLabel)
      setSessions(recs ?? [])
    } finally {
      setLoading(false)
    }
  }, [projectDir, zoneId, zoneLabel])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    promptInputRef.current?.focus()
  }, [])

  const latestBySession = useMemo(() => {
    // sessions arrive sorted newest-first from main — keep that order.
    return sessions
  }, [sessions])

  const trimmedPrompt = prompt.trim()
  const canLaunch = trimmedPrompt.length > 0 && !launching

  const launchNew = async () => {
    if (!projectDir || !canLaunch) return
    setLaunching(true)
    setError(null)
    try {
      const derivedSummary = trimmedPrompt.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 120) || undefined
      const result = await window.electron.zone.launch({
        projectDir,
        zoneId,
        nodes,
        edges,
        mode: 'new',
        userPrompt: trimmedPrompt,
        summary: derivedSummary,
        settings: projectSettings,
      })
      if (!result?.ok) {
        setError(result?.reason ?? 'Failed to launch')
        return
      }
      onLaunched()
      onClose()
    } finally {
      setLaunching(false)
    }
  }

  const resume = async (record: ZoneSessionRecord) => {
    if (!projectDir || launching) return
    setLaunching(true)
    setError(null)
    try {
      const result = await window.electron.zone.launch({
        projectDir,
        zoneId,
        nodes,
        edges,
        mode: 'resume',
        sessionId: record.sessionId,
        settings: projectSettings,
      })
      if (!result?.ok) {
        setError(result?.reason ?? 'Failed to resume')
        return
      }
      onLaunched()
      onClose()
    } finally {
      setLaunching(false)
    }
  }

  const remove = async (record: ZoneSessionRecord) => {
    if (!projectDir) return
    await window.electron.zone.deleteSession(projectDir, zoneId, record.sessionId, zoneLabel)
    void reload()
  }

  const commitRename = async () => {
    if (!projectDir || !editing) return
    const trimmed = editing.draft.trim()
    if (!trimmed) { setEditing(null); return }
    await window.electron.zone.updateSessionSummary(projectDir, zoneId, editing.sessionId, trimmed, zoneLabel)
    setEditing(null)
    void reload()
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
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Play size={16} style={{ color: zoneColor }} /> Launch zone · {zoneLabel}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Start a new session or continue a previous one.
              <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider"
                style={{ color: runtimeMeta.accentColor, backgroundColor: `${runtimeMeta.accentColor}20` }}
              >
                {runtimeMeta.shortLabel}
              </span>
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors flex-shrink-0 p-1">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <section>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              User prompt <span className="text-red-400/70">*</span>
            </label>
            <textarea
              ref={promptInputRef}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void launchNew()
                }
              }}
              placeholder="What should this zone do on this run?"
              rows={5}
              className="w-full bg-canvas border border-white/10 rounded-md px-3 py-2 text-sm text-white resize-y focus:outline-none focus:border-accent"
            />
            <div className="flex items-center justify-between gap-2 mt-2">
              <p className="text-[11px] text-slate-500">Cmd/Ctrl+Enter to launch. The zone's role + architecture context is loaded automatically.</p>
              <button
                onClick={launchNew}
                disabled={!canLaunch}
                className="px-4 py-2 text-sm font-medium rounded-md bg-accent text-white hover:bg-accent/90 disabled:bg-white/5 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 flex-shrink-0"
              >
                <Rocket size={14} /> Launch
              </button>
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                <History size={13} /> Previous sessions
              </label>
              <span className="text-[11px] text-slate-500">{sessions.length} saved</span>
            </div>

            {loading ? (
              <p className="text-xs text-slate-500 bg-canvas border border-white/5 rounded-md px-3 py-3">Loading…</p>
            ) : latestBySession.length === 0 ? (
              <p className="text-xs text-slate-500 bg-canvas border border-white/5 rounded-md px-3 py-3">
                No previous sessions. Your first launch will appear here.
              </p>
            ) : (
              <ul className="space-y-1 max-h-80 overflow-y-auto pr-1">
                {latestBySession.map(record => {
                  const when = new Date(record.capturedAt).toLocaleString()
                  const isEditing = editing?.sessionId === record.sessionId
                  return (
                    <li
                      key={record.sessionId}
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
                              className="flex-1 bg-surface border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-accent"
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
                              className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:bg-white/10"
                              title="Cancel"
                            >
                              <X size={12} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => resume(record)}
                              disabled={launching}
                              className="flex-1 text-left min-w-0 disabled:opacity-50"
                              title="Resume this session"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-slate-200 font-medium truncate">{record.summary}</span>
                                {record.dispatchId && (
                                  <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider bg-[#c084fc]/20 text-[#c084fc] flex-shrink-0">
                                    from dispatch
                                  </span>
                                )}
                              </div>
                              <div className="text-slate-500 mt-0.5 flex items-center gap-2">
                                <span>{when}</span>
                                <span>·</span>
                                <span className="uppercase tracking-wider text-[10px]">{record.runtime}</span>
                              </div>
                            </button>
                            <button
                              onClick={() => setEditing({ sessionId: record.sessionId, draft: record.summary })}
                              className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-white hover:bg-white/10"
                              title="Rename"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              onClick={() => remove(record)}
                              className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-red-400 hover:bg-red-400/10"
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
          </section>

          {error && (
            <p className="text-[11px] text-red-400">Error: {error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-slate-300 hover:text-white transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
