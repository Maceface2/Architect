import { useEffect, useRef, useState } from 'react'
import { Plus, X, FileText, RotateCcw } from 'lucide-react'
import {
  AGENT_RUNTIMES,
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  type AgentRuntime,
} from '../../../../shared/agentRuntimes'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import { useProjectDir } from '../../context/ProjectDirContext'
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
  const effectiveRuntimeMeta = getAgentRuntime(effectiveRuntime)

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
            className="text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-white/20 focus:border-white/40 focus:outline-none transition-colors flex-1 min-w-0"
            placeholder="Agent name"
          />
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors flex-shrink-0 p-1">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0 divide-x divide-white/[0.06]">
          <div className="flex flex-col flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-2 flex-shrink-0">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-slate-600">System prompt</p>
                <p className="text-[11px] text-slate-600 mt-1 leading-relaxed max-w-md">
                  Customizes this zone agent&apos;s behavior. Passed as <span className="font-mono text-slate-500">--append-system-prompt</span> on the first spawn. Edits take effect only after <span className="text-slate-400">Reset conversation</span>.
                </p>
              </div>
              {resetState === 'confirm' ? (
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[11px] text-amber-400">Erase conversation?</span>
                  <button
                    onClick={handleReset}
                    className="px-2 py-1 text-[11px] text-white bg-red-600/80 hover:bg-red-600 rounded transition-colors"
                  >
                    Reset
                  </button>
                  <button
                    onClick={() => setResetState('idle')}
                    className="px-2 py-1 text-[11px] text-slate-400 border border-white/[0.08] rounded hover:bg-white/[0.05] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setResetState('confirm')}
                  disabled={resetState === 'pending'}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-slate-400 border border-white/[0.08] rounded hover:text-slate-200 hover:border-white/20 transition-colors flex-shrink-0 disabled:opacity-50"
                  title="Delete the saved session so the next dispatch starts fresh"
                >
                  <RotateCcw size={11} />
                  {resetState === 'pending'
                    ? 'Resetting…'
                    : resetState === 'done'
                      ? 'Conversation reset'
                      : resetState === 'error'
                        ? 'Reset failed — retry'
                        : 'Reset conversation'}
                </button>
              )}
            </div>
            <textarea
              value={systemPrompt}
              onChange={event => patch({ systemPrompt: event.target.value })}
              placeholder="Define this zone agent's role, expertise, tone, and constraints. E.g. 'You are a senior backend engineer. Write idiomatic, well-tested code. Prefer pure functions. Never introduce new frameworks without justification.'"
              autoFocus
              className="flex-1 bg-transparent text-slate-200 text-sm leading-relaxed px-6 pb-6 resize-none focus:outline-none placeholder-slate-700 font-mono"
            />
          </div>

          <div className="w-[340px] flex-shrink-0 overflow-y-auto">
            <div className="p-6 space-y-6">
              <Section title="Runtime">
                <div className="space-y-3">
                  <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2 text-[11px] text-slate-400">
                    Canvas default: {getAgentRuntime(projectSettings.dispatchRuntime).label}. Pick a different CLI to override this zone only.
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {AGENT_RUNTIMES.map(runtime => {
                      const selected = configuredRuntime === runtime.id
                      return (
                        <button
                          key={runtime.id}
                          onClick={() => setConfiguredRuntime(runtime.id)}
                          className={`flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-colors ${
                            selected
                              ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-white'
                              : 'border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20'
                          }`}
                        >
                          <span className="text-[12px] font-medium">{runtime.label}</span>
                          <span className="text-[10px] uppercase tracking-wider" style={{ color: runtime.accentColor }}>
                            {runtime.shortLabel}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </Section>

              <Section title="Model">
                <div className="space-y-2">
                  <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-slate-600">Effective runtime</p>
                    <p className="text-[12px] text-white mt-1">{effectiveRuntimeMeta.label}</p>
                  </div>
                  <input
                    value={effectiveModel}
                    onChange={event => setRuntimeModel(effectiveRuntime, event.target.value)}
                    placeholder={DEFAULT_MODEL_BY_RUNTIME[effectiveRuntime]}
                    className="w-full bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {effectiveRuntimeMeta.suggestedModels.map(model => (
                      <button
                        key={model}
                        onClick={() => setRuntimeModel(effectiveRuntime, model)}
                        className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                          effectiveModel === model
                            ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-[#58A6FF]'
                            : 'border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20'
                        }`}
                      >
                        {shortModelLabel(model)}
                      </button>
                    ))}
                  </div>
                </div>
              </Section>

              <Section title="Skills">
                <p className="text-[10px] text-slate-700 uppercase tracking-wider mb-2">Presets</p>
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
                            : 'border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20'
                        }`}
                      >
                        <FileText size={10} />
                        {preset.name}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[10px] text-slate-700 uppercase tracking-wider mb-2">Custom</p>
                <div className="flex gap-2 mb-2">
                  <input
                    value={customSkillInput}
                    onChange={event => setCustomSkillInput(event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && addCustomSkill()}
                    placeholder="path/to/skill.md"
                    className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                  />
                  <button onClick={addCustomSkill} className="text-slate-500 hover:text-slate-200 transition-colors">
                    <Plus size={14} />
                  </button>
                </div>
                {skills.length > 0 && (
                  <div className="space-y-1">
                    {skills.map(skill => (
                      <div key={skill.path} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <FileText size={10} className="text-[#58A6FF] flex-shrink-0" />
                          <span className="text-[11px] text-slate-400 truncate font-mono">{skill.name}</span>
                        </div>
                        <button onClick={() => removeSkill(skill.path)} className="text-slate-700 hover:text-slate-400 flex-shrink-0">
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
                      className="w-16 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-white/20"
                    />
                  </Field>
                  <Field label="Timeout (ms)">
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={behavior.timeoutMs}
                      onChange={event => setBehavior({ timeoutMs: Number(event.target.value) })}
                      className="w-24 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-white/20"
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
                        className="w-24 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                      />
                      <input
                        value={envVar.value}
                        onChange={event => updateEnvVar(index, 'value', event.target.value)}
                        placeholder="value"
                        className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                      />
                      <button onClick={() => removeEnvVar(index)} className="text-slate-700 hover:text-slate-400 flex-shrink-0">
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addEnvVar}
                    className="flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-400 transition-colors"
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
            className="px-5 py-1.5 bg-[#3d3dbf] hover:bg-[#4f4fcf] text-white text-sm rounded-lg transition-colors"
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
      <p className="text-[10px] uppercase tracking-widest text-slate-600 mb-3">{title}</p>
      {children}
    </div>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="flex items-center justify-between w-full group">
      <span className="text-[12px] text-slate-500 group-hover:text-slate-300 transition-colors">{label}</span>
      <div className={`relative w-7 h-4 rounded-full transition-colors ${value ? 'bg-[#58A6FF]' : 'bg-white/10'}`}>
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${value ? 'left-[14px]' : 'left-0.5'}`} />
      </div>
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-slate-500 flex-shrink-0">{label}</span>
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
            value === option ? 'bg-[#58A6FF]/20 text-[#58A6FF]' : 'text-slate-600 hover:text-slate-400'
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
