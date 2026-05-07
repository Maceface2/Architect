import { useEffect, useRef, useState } from 'react'
import { Plus, X, FileText, RotateCcw } from 'lucide-react'
import {
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  type AgentRuntime,
} from '../../../../shared/agentRuntimes'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import { useProjectDir } from '../../context/ProjectDirContext'
import { pickerRuntimes, useRuntimeDetection } from '../../context/RuntimeDetectionContext'
import { RuntimeEmptyState } from '../runtime/RuntimeEmptyState'
import { resolveZoneModelSuggestions } from '../../lib/canvas'
import type {
  ZoneNodeData,
  NodeSkillFile,
  NodeTools,
  NodeBehavior,
  NodePermissions,
  NodeEnvVar,
  RunMode,
  OnFailure,
  RuntimeModelMap,
} from '../../types'

const BUILTIN_SKILLS: Omit<NodeSkillFile, 'id'>[] = [
  { name: 'researcher.md', path: 'builtin:researcher', builtin: true },
  { name: 'planner.md', path: 'builtin:planner', builtin: true },
  { name: 'code-reviewer.md', path: 'builtin:code-reviewer', builtin: true },
  { name: 'debugger.md', path: 'builtin:debugger', builtin: true },
  { name: 'writer.md', path: 'builtin:writer', builtin: true },
  { name: 'analyst.md', path: 'builtin:analyst', builtin: true },
]

interface Props {
  zoneColor: string
  zoneId: string
  label: string
  systemPrompt: string
  configuredRuntime: AgentRuntime
  effectiveRuntime: AgentRuntime
  effectiveModel: string
  providerModels: RuntimeModelMap
  skills: NodeSkillFile[]
  tools: NodeTools
  behavior: NodeBehavior
  permissions: NodePermissions
  envVars: NodeEnvVar[]
  patch: (partial: Partial<ZoneNodeData>) => void
  onClose: () => void
}

export default function AgentConfigModal({
  zoneColor,
  zoneId,
  label,
  systemPrompt,
  configuredRuntime,
  effectiveRuntime,
  effectiveModel,
  providerModels,
  skills,
  tools,
  behavior,
  permissions,
  envVars,
  patch,
  onClose,
}: Props) {
  const [labelDraft, setLabelDraft] = useState(label)
  const [customSkillInput, setCustomSkillInput] = useState('')
  const [resetState, setResetState] = useState<'idle' | 'confirm' | 'pending' | 'done' | 'error'>('idle')
  const labelInputRef = useRef<HTMLInputElement>(null)
  const projectSettings = useProjectSettings()
  const projectDir = useProjectDir()
  const detection = useRuntimeDetection()
  const effectiveRuntimeMeta = getAgentRuntime(effectiveRuntime)
  const effectiveDetected = detection.byId[effectiveRuntime]
  const runtimeOptions = pickerRuntimes(detection.byId)
  // Zone configs only ever show ≤5 quick-pick chips. The user picks which
  // models those are in Settings → Models → "Pinned for zones"; without
  // pins we fall back to the first 5 of the detected/probed list.
  const effectiveModelSuggestions = resolveZoneModelSuggestions({
    runtime: effectiveRuntime,
    settings: projectSettings,
    detectedModels: effectiveDetected.models ?? [],
    fallbackSuggested: effectiveRuntimeMeta.suggestedModels ?? [],
  })
  const supportsModel = effectiveRuntimeMeta.supportsModelSelection
  const effectiveDetectedModels = effectiveDetected.models ?? []
  // True when the zone has explicitly diverged from the canvas default.
  // Drives the "Use default" button visibility — clicking it sets
  // agentRuntime back to the canvas default so isOverride flips false.
  const isOverride = configuredRuntime !== projectSettings.dispatchRuntime
  const canvasDefaultInstalled = detection.byId[projectSettings.dispatchRuntime].installed
  const configuredRuntimeInstalled = detection.byId[configuredRuntime].installed

  const handleReset = async () => {
    if (!projectDir) return
    setResetState('pending')
    try {
      await window.electron.zone.resetSession({ projectDir, zoneId })
      setResetState('done')
    } catch {
      setResetState('error')
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const hasSkill = (path: string) => skills.some(skill => skill.path === path)
  const toggleBuiltinSkill = (preset: Omit<NodeSkillFile, 'id'>) => {
    if (hasSkill(preset.path)) patch({ skills: skills.filter(skill => skill.path !== preset.path) })
    else patch({ skills: [...skills, { ...preset, id: preset.path }] })
  }

  const addCustomSkill = () => {
    const raw = customSkillInput.trim()
    if (!raw) return
    const name = raw.endsWith('.md') ? raw : `${raw}.md`
    const path = `custom:${name}`
    if (!hasSkill(path)) patch({ skills: [...skills, { id: path, name, path, builtin: false }] })
    setCustomSkillInput('')
  }

  const removeSkill = (path: string) => patch({ skills: skills.filter(skill => skill.path !== path) })
  const toggleTool = (key: keyof NodeTools) => patch({ tools: { ...tools, [key]: !tools[key] } })
  const setBehavior = (partial: Partial<NodeBehavior>) => patch({ behavior: { ...behavior, ...partial } })
  const togglePerm = (key: keyof NodePermissions) => patch({ permissions: { ...permissions, [key]: !permissions[key] } })
  const addEnvVar = () => patch({ envVars: [...envVars, { key: '', value: '' }] })
  const removeEnvVar = (index: number) => patch({ envVars: envVars.filter((_, idx) => idx !== index) })
  const updateEnvVar = (index: number, field: keyof NodeEnvVar, value: string) =>
    patch({ envVars: envVars.map((envVar, idx) => idx === index ? { ...envVar, [field]: value } : envVar) })

  const setConfiguredRuntime = (runtime: AgentRuntime) => {
    patch({ agentRuntime: runtime })
  }

  const setRuntimeModel = (runtime: AgentRuntime, model: string) => {
    patch({
      providerModels: {
        ...providerModels,
        [runtime]: model,
      },
    })
  }

  const saveLabel = () => {
    const trimmed = labelDraft.trim()
    if (trimmed && trimmed !== label) patch({ label: trimmed })
  }

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        className="bg-[#161616] rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '90vw', height: '85vh', maxWidth: 1100 }}
      >
        <div className="flex items-center gap-4 px-6 py-4 border-b border-white/[0.07] flex-shrink-0" style={{ borderLeftColor: zoneColor, borderLeftWidth: 4 }}>
          <span className="text-[11px] font-bold tracking-widest flex-shrink-0 uppercase" style={{ color: zoneColor }}>Zone</span>
          <input
            ref={labelInputRef}
            value={labelDraft}
            onChange={event => setLabelDraft(event.target.value)}
            onBlur={saveLabel}
            onKeyDown={event => { if (event.key === 'Enter') { saveLabel(); labelInputRef.current?.blur() } }}
            className="text-lg font-semibold text-fg bg-transparent border-b border-transparent hover:border-white/20 focus:border-white/40 focus:outline-none transition-colors flex-1 min-w-0"
            placeholder="Agent name"
          />
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors flex-shrink-0 p-1">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0 divide-x divide-white/[0.06]">
          <div className="flex flex-col flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-2 flex-shrink-0">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-fg-subtle">System prompt</p>
                <p className="text-[11px] text-fg-subtle mt-1 leading-relaxed max-w-md">
                  Customizes this zone agent&apos;s behavior. Passed as <span className="font-mono text-fg-subtle">--append-system-prompt</span> on the first spawn. Edits take effect only after <span className="text-fg-muted">Reset conversation</span>.
                </p>
              </div>
              {resetState === 'confirm' ? (
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[11px] text-amber-400">Erase conversation?</span>
                  <button
                    onClick={handleReset}
                    className="px-2 py-1 text-[11px] text-fg bg-red-600/80 hover:bg-red-600 rounded transition-colors"
                  >
                    Reset
                  </button>
                  <button
                    onClick={() => setResetState('idle')}
                    className="px-2 py-1 text-[11px] text-fg-muted border border-white/[0.08] rounded hover:bg-white/[0.05] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setResetState('confirm')}
                  disabled={resetState === 'pending'}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-fg-muted border border-white/[0.08] rounded hover:text-fg hover:border-white/20 transition-colors flex-shrink-0 disabled:opacity-50"
                  title="Delete the saved session so the next dispatch starts fresh"
                >
                  <RotateCcw size={11} />
                  {resetState === 'pending'
                    ? 'Resetting…'
                    : resetState === 'done'
                      ? 'Conversation reset'
                      : resetState === 'error'
                        ? 'Reset failed. Retry.'
                        : 'Reset conversation'}
                </button>
              )}
            </div>
            <textarea
              value={systemPrompt}
              onChange={event => patch({ systemPrompt: event.target.value })}
              placeholder="Define this zone agent's role, expertise, tone, and constraints. E.g. 'You are a senior backend engineer. Write idiomatic, well-tested code. Prefer pure functions. Never introduce new frameworks without justification.'"
              autoFocus
              className="flex-1 bg-transparent text-fg text-sm leading-relaxed px-6 pb-6 resize-none focus:outline-none placeholder-fg-subtle font-mono"
            />
          </div>

          <div className="w-[340px] flex-shrink-0 overflow-y-auto">
            <div className="p-6 space-y-6">
              <Section title="Runtime">
                <div className="space-y-3">
                  <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Canvas default</p>
                      <p className="text-[12px] text-fg-muted mt-0.5 truncate">
                        {getAgentRuntime(projectSettings.dispatchRuntime).label}
                      </p>
                    </div>
                    {isOverride && canvasDefaultInstalled && (
                      <button
                        onClick={() => setConfiguredRuntime(projectSettings.dispatchRuntime)}
                        className="flex-shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-white/10 text-fg-subtle hover:text-fg hover:border-white/30"
                        title="Drop the per-zone CLI override and inherit the canvas default."
                      >
                        Use default
                      </button>
                    )}
                  </div>
                  {!configuredRuntimeInstalled && (
                    <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
                      This zone is configured for <span className="font-mono">{effectiveRuntimeMeta.label}</span>, which isn&apos;t installed on this machine. Pick another CLI below or run <span className="font-mono">Rescan CLIs</span> in Settings.
                    </div>
                  )}
                  {detection.installed.length === 0 ? (
                    <RuntimeEmptyState compact />
                  ) : (
                    <div className="grid grid-cols-2 gap-1.5">
                      {runtimeOptions.map(detected => {
                        const def = getAgentRuntime(detected.id)
                        const selected = configuredRuntime === detected.id
                        return (
                          <button
                            key={detected.id}
                            onClick={() => setConfiguredRuntime(detected.id)}
                            className={`flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-colors ${
                              selected
                                ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-fg'
                                : 'border-white/[0.08] text-fg-subtle hover:text-fg-muted hover:border-white/20'
                            }`}
                          >
                            <span className="text-[12px] font-medium">{def.label}</span>
                            <span className="text-[10px] uppercase tracking-wider" style={{ color: def.accentColor }}>
                              {def.shortLabel}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </Section>

              {supportsModel ? (
                <Section title="Model">
                  <div className="space-y-2">
                    <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Effective runtime</p>
                      <p className="text-[12px] text-fg mt-1">{effectiveRuntimeMeta.label}</p>
                    </div>
                    <input
                      value={effectiveModel}
                      onChange={event => setRuntimeModel(effectiveRuntime, event.target.value)}
                      placeholder={DEFAULT_MODEL_BY_RUNTIME[effectiveRuntime]}
                      className="w-full bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-fg-muted placeholder-fg-subtle focus:outline-none focus:border-white/20 font-mono"
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {effectiveModelSuggestions.map(model => (
                        <button
                          key={model}
                          onClick={() => setRuntimeModel(effectiveRuntime, model)}
                          className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                            effectiveModel === model
                              ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-[#58A6FF]'
                              : 'border-white/[0.08] text-fg-subtle hover:text-fg-muted hover:border-white/20'
                          }`}
                        >
                          {shortModelLabel(model)}
                        </button>
                      ))}
                    </div>
                    {effectiveDetectedModels.length > effectiveModelSuggestions.length && (
                      <ZoneModelBrowse
                        available={effectiveDetectedModels}
                        current={effectiveModel}
                        onPick={id => setRuntimeModel(effectiveRuntime, id)}
                      />
                    )}
                  </div>
                </Section>
              ) : (
                <Section title="Model">
                  <p className="text-[11px] text-fg-subtle leading-relaxed">
                    {effectiveRuntimeMeta.label} manages its own model. No model selection here.
                  </p>
                </Section>
              )}

              <Section title="Skills">
                <p className="text-[10px] text-fg-subtle uppercase tracking-wider mb-2">Presets</p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {BUILTIN_SKILLS.map(preset => {
                    const active = hasSkill(preset.path)
                    return (
                      <button
                        key={preset.path}
                        onClick={() => toggleBuiltinSkill(preset)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] border transition-colors ${
                          active
                            ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-[#58A6FF]'
                            : 'border-white/[0.08] text-fg-subtle hover:text-fg-muted hover:border-white/20'
                        }`}
                      >
                        <FileText size={10} />
                        {preset.name}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[10px] text-fg-subtle uppercase tracking-wider mb-2">Custom</p>
                <div className="flex gap-2 mb-2">
                  <input
                    value={customSkillInput}
                    onChange={event => setCustomSkillInput(event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && addCustomSkill()}
                    placeholder="path/to/skill.md"
                    className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-fg-muted placeholder-fg-subtle focus:outline-none focus:border-white/20 font-mono"
                  />
                  <button onClick={addCustomSkill} className="text-fg-subtle hover:text-fg transition-colors">
                    <Plus size={14} />
                  </button>
                </div>
                {skills.length > 0 && (
                  <div className="space-y-1">
                    {skills.map(skill => (
                      <div key={skill.path} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <FileText size={10} className="text-[#58A6FF] flex-shrink-0" />
                          <span className="text-[11px] text-fg-muted truncate font-mono">{skill.name}</span>
                        </div>
                        <button onClick={() => removeSkill(skill.path)} className="text-fg-subtle hover:text-fg-muted flex-shrink-0">
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Tools">
                <div className="space-y-2">
                  {([
                    ['webSearch', 'Web Search'],
                    ['codeExec', 'Code Exec'],
                    ['fileRead', 'File Read'],
                    ['fileWrite', 'File Write'],
                    ['apiCalls', 'API Calls'],
                    ['shell', 'Shell'],
                  ] as [keyof NodeTools, string][]).map(([key, tLabel]) => (
                    <Toggle key={key} label={tLabel} value={tools[key]} onChange={() => toggleTool(key)} />
                  ))}
                </div>
              </Section>

              <Section title="Behavior">
                <div className="space-y-3">
                  <Field label="Mode">
                    <Seg
                      options={['sequential', 'parallel', 'loop'] as RunMode[]}
                      value={behavior.mode}
                      onChange={value => setBehavior({ mode: value })}
                    />
                  </Field>
                  <Field label="On failure">
                    <Seg
                      options={['stop', 'retry', 'skip'] as OnFailure[]}
                      value={behavior.onFailure}
                      onChange={value => setBehavior({ onFailure: value })}
                    />
                  </Field>
                  <Field label="Retries">
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={behavior.retries}
                      onChange={event => setBehavior({ retries: Number(event.target.value) })}
                      className="w-16 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-xs text-fg-muted focus:outline-none focus:border-white/20"
                    />
                  </Field>
                  <Field label="Timeout (ms)">
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={behavior.timeoutMs}
                      onChange={event => setBehavior({ timeoutMs: Number(event.target.value) })}
                      className="w-24 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-xs text-fg-muted focus:outline-none focus:border-white/20"
                    />
                  </Field>
                </div>
              </Section>

              <Section title="Permissions">
                <div className="space-y-2">
                  {([
                    ['readFiles', 'Read files'],
                    ['writeFiles', 'Write files'],
                    ['network', 'Network'],
                    ['shell', 'Shell'],
                  ] as [keyof NodePermissions, string][]).map(([key, pLabel]) => (
                    <Toggle key={key} label={pLabel} value={permissions[key]} onChange={() => togglePerm(key)} />
                  ))}
                </div>
              </Section>

              <Section title="Environment">
                <div className="space-y-2">
                  {envVars.map((envVar, index) => (
                    <div key={index} className="flex gap-2 items-center">
                      <input
                        value={envVar.key}
                        onChange={event => updateEnvVar(index, 'key', event.target.value)}
                        placeholder="KEY"
                        className="w-24 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-fg-muted placeholder-fg-subtle focus:outline-none focus:border-white/20 font-mono"
                      />
                      <input
                        value={envVar.value}
                        onChange={event => updateEnvVar(index, 'value', event.target.value)}
                        placeholder="value"
                        className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-fg-muted placeholder-fg-subtle focus:outline-none focus:border-white/20 font-mono"
                      />
                      <button onClick={() => removeEnvVar(index)} className="text-fg-subtle hover:text-fg-muted flex-shrink-0">
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addEnvVar}
                    className="flex items-center gap-1 text-[11px] text-fg-subtle hover:text-fg-muted transition-colors"
                  >
                    <Plus size={12} /> Add variable
                  </button>
                </div>
              </Section>
            </div>
          </div>
        </div>

        <div className="flex justify-end px-6 py-3 border-t border-white/[0.07] flex-shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-1.5 bg-[#3d3dbf] hover:bg-[#4f4fcf] text-fg text-sm rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-fg-subtle mb-3">{title}</p>
      {children}
    </div>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="flex items-center justify-between w-full group">
      <span className="text-[12px] text-fg-subtle group-hover:text-fg-muted transition-colors">{label}</span>
      <div className={`relative w-7 h-4 rounded-full transition-colors ${value ? 'bg-[#58A6FF]' : 'bg-white/10'}`}>
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${value ? 'left-[14px]' : 'left-0.5'}`} />
      </div>
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-fg-subtle flex-shrink-0">{label}</span>
      {children}
    </div>
  )
}

function Seg<T extends string>({ options, value, onChange }: { options: T[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex rounded overflow-hidden border border-white/[0.08]">
      {options.map(option => (
        <button
          key={option}
          onClick={() => onChange(option)}
          className={`px-2 py-0.5 text-[11px] capitalize transition-colors ${
            value === option ? 'bg-[#58A6FF]/20 text-[#58A6FF]' : 'text-fg-subtle hover:text-fg-muted'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function shortModelLabel(model: string): string {
  return model.includes('/') ? model.split('/').pop() || model : model
}

// Search dropdown for picking from the full available model list. Shown
// in the zone modal under the ≤5 quick-pick chips when the runtime exposes
// more than 5 models (opencode etc.). Click a result to set this zone's
// model. The free-text input above still wins for typing arbitrary IDs.
function ZoneModelBrowse({
  available,
  current,
  onPick,
}: {
  available: string[]
  current: string
  onPick: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed
    ? available.filter(m => m.toLowerCase().includes(trimmed)).slice(0, 8)
    : available.slice(0, 8)

  const choose = (id: string) => {
    onPick(id)
    setQuery('')
  }

  return (
    <div className="relative">
      <input
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder={`Browse all ${available.length} models…`}
        className="w-full bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-fg-muted placeholder-fg-subtle focus:outline-none focus:border-white/20 font-mono"
      />
      {filtered.length > 0 && (
        <div className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded border border-white/10 bg-[#161616] shadow-lg">
          {filtered.map(id => (
            <button
              key={id}
              onClick={() => choose(id)}
              className={`block w-full text-left px-2 py-1 text-[11px] font-mono ${
                current === id
                  ? 'text-[#58A6FF] bg-[#58A6FF]/10'
                  : 'text-fg-subtle hover:bg-white/[0.05] hover:text-fg'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
