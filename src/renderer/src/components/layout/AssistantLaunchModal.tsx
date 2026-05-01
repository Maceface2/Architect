import { useCallback, useEffect, useState } from 'react'
import { Check, History, Pencil, Rocket, Settings2, Trash2, X } from 'lucide-react'
import { getAgentRuntime, type AgentRuntime, type AssistantMode } from '../../../../shared/agentRuntimes'
import { pickerRuntimes, useRuntimeDetection } from '../../context/RuntimeDetectionContext'
import { RuntimeEmptyState } from '../runtime/RuntimeEmptyState'
import type { ProjectSettings, ZoneSessionRecord } from '../../types'

export interface AssistantRelaunchOpts {
  runtime: AgentRuntime
  model: string
  session: { mode: 'new' } | { mode: 'resume'; sessionId: string }
}

interface Props {
  projectDir: string
  mode: AssistantMode
  runtime: AgentRuntime
  projectSettings: ProjectSettings
  // True when a PTY is currently alive for this mode. Drives the mid-turn
  // confirmation dialog on "Start new" (never on resume — transcript is safe).
  hasRunningSession: boolean
  onClose: () => void
  onRelaunch: (opts: AssistantRelaunchOpts) => Promise<void>
}

export default function AssistantLaunchModal({
  projectDir,
  mode,
  runtime,
  projectSettings,
  hasRunningSession,
  onClose,
  onRelaunch,
}: Props) {
  const [selectedRuntime, setSelectedRuntime] = useState<AgentRuntime>(runtime)
  const runtimeMeta = getAgentRuntime(selectedRuntime)
  const detection = useRuntimeDetection()
  const runtimeOptions = pickerRuntimes(detection.byId, selectedRuntime)
  const runtimeDetected = detection.byId[selectedRuntime]
  const modelSuggestions = runtimeDetected.models.length > 0
    ? runtimeDetected.models
    : runtimeMeta.suggestedModels
  const runtimeNotInstalled = !runtimeDetected.installed

  const resolveDefaultModel = useCallback((rt: AgentRuntime): string => {
    const meta = getAgentRuntime(rt)
    // Fully decoupled from projectSettings.dispatchModels (which is the
    // zone/dispatch per-CLI default). Fall back to the CLI's hardcoded
    // default so changing Settings-page model presets can't retarget
    // the assistant's model.
    return projectSettings.assistantModels?.[rt] ?? meta.defaultModel
  }, [projectSettings.assistantModels])

  const [model, setModel] = useState<string>(() => resolveDefaultModel(runtime))
  const [sessions, setSessions] = useState<ZoneSessionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ sessionId: string; draft: string } | null>(null)
  const [pendingNewConfirm, setPendingNewConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const recs = await window.electron.assistant.listSessions(projectDir, mode)
      setSessions(recs ?? [])
    } finally {
      setLoading(false)
    }
  }, [projectDir, mode])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // When the user picks a different runtime, reset the model to that runtime's
  // preferred default — the prior model string is meaningless under the new CLI.
  const handleRuntimeChange = useCallback((next: AgentRuntime) => {
    if (next === selectedRuntime) return
    setSelectedRuntime(next)
    setModel(resolveDefaultModel(next))
  }, [selectedRuntime, resolveDefaultModel])

  const runtimeChanged = selectedRuntime !== runtime

  const fireNew = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onRelaunch({ runtime: selectedRuntime, model, session: { mode: 'new' } })
      onClose()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const onClickStartNew = () => {
    if (hasRunningSession || runtimeChanged) {
      setPendingNewConfirm(true)
      return
    }
    void fireNew()
  }

  const resume = async (record: ZoneSessionRecord) => {
    if (busy) return
    if (record.runtime !== selectedRuntime) return // disabled row — defensive
    setBusy(true)
    setError(null)
    try {
      // Resume the session under its ORIGINAL (runtime, model). The modal's
      // CLI + model pickers only affect "Start new" — a resume should replay
      // the exact config the session was spawned with, otherwise the user's
      // current pickers would silently rewrite their history.
      await onRelaunch({
        runtime: record.runtime,
        model: record.model ?? resolveDefaultModel(record.runtime),
        session: { mode: 'resume', sessionId: record.sessionId },
      })
      onClose()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (record: ZoneSessionRecord) => {
    await window.electron.assistant.deleteSession(projectDir, mode, record.sessionId)
    void reload()
  }

  const commitRename = async () => {
    if (!editing) return
    const trimmed = editing.draft.trim()
    if (!trimmed) { setEditing(null); return }
    await window.electron.assistant.updateSessionSummary(projectDir, mode, editing.sessionId, trimmed)
    setEditing(null)
    void reload()
  }

  const modeLabel = mode === 'architecture' ? 'Architecture' : 'General'

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
            <h2 className="text-lg font-semibold text-fg flex items-center gap-2">
              <Settings2 size={16} className="text-[#c084fc]" /> Assistant · {modeLabel}
            </h2>
            <p className="text-xs text-fg-muted mt-1">
              Pick a model, start fresh, or resume a prior session.
              <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider"
                style={{ color: runtimeMeta.accentColor, backgroundColor: `${runtimeMeta.accentColor}20` }}
              >
                {runtimeMeta.shortLabel}
              </span>
            </p>
          </div>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors flex-shrink-0 p-1">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <section>
            <label className="block text-xs font-medium text-fg-muted mb-1.5">CLI</label>
            {detection.installed.length === 0 ? (
              <RuntimeEmptyState />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {runtimeOptions.map(detected => {
                  const rt = getAgentRuntime(detected.id)
                  const selected = selectedRuntime === detected.id
                  const notInstalled = !detected.installed
                  return (
                    <button
                      key={rt.id}
                      onClick={() => handleRuntimeChange(rt.id)}
                      title={notInstalled ? 'Selected but not installed on this machine' : undefined}
                      className={`flex items-center justify-between px-3 py-2 rounded-md border text-left transition-colors ${
                        selected
                          ? notInstalled
                            ? 'border-amber-400/50 bg-amber-400/10 text-amber-100'
                            : 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-fg'
                          : 'border-white/[0.08] text-fg-subtle hover:text-fg-muted hover:border-white/20'
                      }`}
                    >
                      <span className="text-sm font-medium">
                        {rt.label}
                        {notInstalled && <span className="ml-1.5 text-[10px] text-amber-300">(missing)</span>}
                      </span>
                      <span className="text-[10px] uppercase tracking-wider" style={{ color: rt.accentColor }}>
                        {rt.shortLabel}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {runtimeNotInstalled && detection.installed.length > 0 && (
              <p className="text-[11px] text-amber-300 mt-2">
                {runtimeMeta.label} is not installed on this machine — launching it will fail.
              </p>
            )}
            {runtimeChanged && (
              <p className="text-[11px] text-amber-400/90 mt-2">
                Changing the CLI will kill the current {modeLabel.toLowerCase()} assistant session and spawn a new one.
              </p>
            )}
          </section>

          <section>
            <label className="block text-xs font-medium text-fg-muted mb-1.5">Model ({runtimeMeta.label})</label>
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              className="w-full bg-canvas border border-white/10 rounded-md px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent"
            >
              {modelSuggestions.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
              {!modelSuggestions.includes(model) && (
                <option value={model}>{model}</option>
              )}
            </select>
            <p className="text-[11px] text-fg-subtle mt-1">
              Selecting a model does nothing until you Start new or Resume — the change applies to whichever session you launch.
            </p>
          </section>

          <section className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-fg-subtle">
              Start fresh with the picked model, or resume one below.
            </p>
            <button
              onClick={onClickStartNew}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium rounded-md bg-accent text-fg hover:bg-accent/90 disabled:bg-white/5 disabled:text-fg-subtle disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 flex-shrink-0"
            >
              <Rocket size={14} /> Start new
            </button>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-fg-muted flex items-center gap-1.5">
                <History size={13} /> Previous sessions
              </label>
              <span className="text-[11px] text-fg-subtle">{sessions.length} saved</span>
            </div>

            {loading ? (
              <p className="text-xs text-fg-subtle bg-canvas border border-white/5 rounded-md px-3 py-3">Loading…</p>
            ) : sessions.length === 0 ? (
              <p className="text-xs text-fg-subtle bg-canvas border border-white/5 rounded-md px-3 py-3">
                No previous sessions. Your first Start new will appear here.
              </p>
            ) : (
              <ul className="space-y-1 max-h-80 overflow-y-auto pr-1">
                {sessions.map(record => {
                  const when = new Date(record.capturedAt).toLocaleString()
                  const isEditing = editing?.sessionId === record.sessionId
                  const mismatch = record.runtime !== selectedRuntime
                  const mismatchTip = `Recorded under ${record.runtime} — switch the CLI above to resume.`
                  return (
                    <li
                      key={record.sessionId}
                      className={`bg-canvas border rounded-md px-3 py-2 text-xs transition-colors ${
                        mismatch ? 'border-white/5 opacity-50' : 'border-white/10 hover:border-white/30'
                      }`}
                      title={mismatch ? mismatchTip : undefined}
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
                              onClick={() => resume(record)}
                              disabled={busy || mismatch}
                              className="flex-1 text-left min-w-0 disabled:cursor-not-allowed"
                              title={mismatch ? mismatchTip : 'Resume this session'}
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-fg font-medium truncate">{record.summary}</span>
                                {record.dispatchId && (
                                  <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider bg-[#c084fc]/20 text-[#c084fc] flex-shrink-0">
                                    from dispatch
                                  </span>
                                )}
                              </div>
                              <div className="text-fg-subtle mt-0.5 flex items-center gap-2">
                                <span>{when}</span>
                                <span>·</span>
                                <span className="uppercase tracking-wider text-[10px]">{record.runtime}</span>
                                {record.model && (
                                  <>
                                    <span>·</span>
                                    <span className="font-mono text-[10px] text-fg-subtle">{record.model}</span>
                                  </>
                                )}
                              </div>
                            </button>
                            <button
                              onClick={() => setEditing({ sessionId: record.sessionId, draft: record.summary })}
                              className="w-6 h-6 flex items-center justify-center rounded text-fg-subtle hover:text-fg hover:bg-white/10"
                              title="Rename"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              onClick={() => remove(record)}
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
          </section>

          {error && (
            <p className="text-[11px] text-red-400">Error: {error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
          >
            Close
          </button>
        </div>

        {pendingNewConfirm && (
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setPendingNewConfirm(false)}
          >
            <div
              className="bg-surface border border-white/10 rounded-lg shadow-2xl max-w-sm p-5"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="text-sm font-semibold text-fg">Interrupt current session?</h3>
              <p className="text-xs text-fg-muted mt-2 leading-relaxed">
                The active {modeLabel} assistant session will be killed. In-flight tool calls will be cancelled. The transcript is saved — you can resume it later from Previous sessions.
              </p>
              <div className="flex items-center justify-end gap-2 mt-4">
                <button
                  onClick={() => setPendingNewConfirm(false)}
                  className="px-3 py-1.5 text-xs text-fg-muted hover:text-fg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setPendingNewConfirm(false); void fireNew() }}
                  className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-fg hover:bg-accent/90 transition-colors"
                >
                  Start new
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
