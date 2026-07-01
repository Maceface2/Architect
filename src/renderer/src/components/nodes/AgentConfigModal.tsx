import { useRef, useState } from 'react'
import { Plus, X, FileText, RotateCcw, ChevronRight } from 'lucide-react'
import {
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  type AgentRuntime,
} from '../../../../shared/agentRuntimes'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import { useProjectDir } from '../../context/ProjectDirContext'
import { useWorkspaceOptional } from '../../context/WorkspaceContext'
import { pickerRuntimes, useRuntimeDetection } from '../../context/RuntimeDetectionContext'
import { RuntimeEmptyState } from '../runtime/RuntimeEmptyState'
import DocPane from '../docpane/DocPane'
import MarkdownEditor, { MarkdownModeToggle, type MarkdownMode } from '../docpane/MarkdownEditor'
import { resolveZoneModelSuggestions } from '../../lib/canvas'
import type {
  ZoneNodeData,
  NodeSkillFile,
  NodeTools,
  NodeBehavior,
  NodeEnvVar,
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
  envVars,
  patch,
  onClose,
}: Props) {
  void zoneColor
  const [labelDraft, setLabelDraft] = useState(label)
  const [customSkillInput, setCustomSkillInput] = useState('')
  const [resetState, setResetState] = useState<'idle' | 'confirm' | 'pending' | 'done' | 'error'>('idle')
  const [mode, setMode] = useState<MarkdownMode>('edit')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const labelInputRef = useRef<HTMLInputElement>(null)
  const toggleMode = () => setMode(prev => (prev === 'edit' ? 'preview' : 'edit'))
  const projectSettings = useProjectSettings()
  const projectDir = useProjectDir()
  const workspace = useWorkspaceOptional()
  const pageId = workspace?.ready ? workspace.activePageId : undefined
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
      await window.electron.zone.resetSession({ projectDir, zoneId, pageId })
      setResetState('done')
    } catch {
      setResetState('error')
    }
  }

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

  // Custom skills aren't represented by the preset chips, so they get an
  // explicit removable row; builtins are toggled via their chip.
  const customSkills = skills.filter(skill => !BUILTIN_SKILLS.some(preset => preset.path === skill.path))

  return (
    <DocPane
      title={labelDraft.trim() || label || 'Agent'}
      kindLabel="Agent"
      onClose={onClose}
      headerActions={<MarkdownModeToggle mode={mode} onToggle={toggleMode} />}
    >
      <div className="space-y-6">
        {/* Title — the note's H1; renames the zone */}
        <input
          ref={labelInputRef}
          value={labelDraft}
          onChange={event => setLabelDraft(event.target.value)}
          onBlur={saveLabel}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              saveLabel()
              labelInputRef.current?.blur()
            }
          }}
          className="w-full border-0 bg-transparent p-0 text-[26px] font-semibold tracking-[-0.02em] text-fg outline-none placeholder:text-fg-subtle"
          placeholder="Agent name"
        />

        {/* Frontmatter: the few addons that aren't markdown — runtime, model,
            skills. Styled like an Obsidian properties block above the note. */}
        <div className="overflow-hidden rounded-lg border border-node-border bg-node/30">
          <PropRow label="Runtime">
            {detection.installed.length === 0 ? (
              <RuntimeEmptyState compact />
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {runtimeOptions.map(detected => {
                    const def = getAgentRuntime(detected.id)
                    const selected = configuredRuntime === detected.id
                    return (
                      <button
                        key={detected.id}
                        onClick={() => setConfiguredRuntime(detected.id)}
                        className={chipClass(selected)}
                      >
                        {def.label}
                      </button>
                    )
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
                  <span>Canvas default: {getAgentRuntime(projectSettings.dispatchRuntime).label}</span>
                  {isOverride && canvasDefaultInstalled && (
                    <button
                      onClick={() => setConfiguredRuntime(projectSettings.dispatchRuntime)}
                      className="rounded border border-node-border px-1.5 py-0.5 uppercase tracking-wider text-fg-subtle transition-colors hover:border-accent hover:text-fg"
                      title="Drop the per-agent CLI override and inherit the canvas default."
                    >
                      Use default
                    </button>
                  )}
                </div>
                {!configuredRuntimeInstalled && (
                  <div className="rounded border border-amber-400/40 bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-200">
                    Configured for <span className="font-mono">{effectiveRuntimeMeta.label}</span>, which isn&apos;t installed. Pick another CLI or run <span className="font-mono">Rescan CLIs</span> in Settings.
                  </div>
                )}
              </div>
            )}
          </PropRow>

          <PropRow label="Model">
            {supportsModel ? (
              <div className="space-y-2">
                <input
                  value={effectiveModel}
                  onChange={event => setRuntimeModel(effectiveRuntime, event.target.value)}
                  placeholder={DEFAULT_MODEL_BY_RUNTIME[effectiveRuntime]}
                  className="w-full rounded border border-node-border bg-node/80 px-2.5 py-1.5 font-mono text-[12px] text-fg-muted outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
                />
                <div className="flex flex-wrap gap-1.5">
                  {effectiveModelSuggestions.map(model => (
                    <button
                      key={model}
                      onClick={() => setRuntimeModel(effectiveRuntime, model)}
                      className={chipClass(effectiveModel === model)}
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
            ) : (
              <p className="text-[12px] leading-relaxed text-fg-subtle">
                {effectiveRuntimeMeta.label} manages its own model.
              </p>
            )}
          </PropRow>

          <PropRow label="Skills">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {BUILTIN_SKILLS.map(preset => (
                  <button
                    key={preset.path}
                    onClick={() => toggleBuiltinSkill(preset)}
                    className={chipClass(hasSkill(preset.path))}
                  >
                    <FileText size={10} />
                    {preset.name}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={customSkillInput}
                  onChange={event => setCustomSkillInput(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && addCustomSkill()}
                  placeholder="path/to/skill.md"
                  className="min-w-0 flex-1 rounded border border-node-border bg-node/80 px-2 py-1 font-mono text-[11px] text-fg-muted outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
                />
                <button onClick={addCustomSkill} className="text-fg-subtle transition-colors hover:text-fg" aria-label="Add skill">
                  <Plus size={14} />
                </button>
              </div>
              {customSkills.length > 0 && (
                <div className="space-y-1">
                  {customSkills.map(skill => (
                    <div key={skill.path} className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <FileText size={10} className="flex-shrink-0 text-accent" />
                        <span className="truncate font-mono text-[11px] text-fg-muted">{skill.name}</span>
                      </div>
                      <button onClick={() => removeSkill(skill.path)} className="flex-shrink-0 text-fg-subtle transition-colors hover:text-fg-muted" aria-label="Remove skill">
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </PropRow>
        </div>

        <p className="text-[12px] leading-5 text-fg-subtle">
          This note is the agent&apos;s role. Sent as <span className="font-mono text-fg-muted">--append-system-prompt</span> on first spawn; edits apply after a reset.
        </p>

        {/* Body: the role note */}
        <MarkdownEditor
          value={systemPrompt}
          onChange={value => patch({ systemPrompt: value })}
          mode={mode}
          onToggleMode={toggleMode}
          autoFocus
          placeholder={'You are a senior backend engineer.\n\n# Responsibilities\n- Write idiomatic, well-tested code\n\n# Constraints\n- Prefer pure functions\n- Never introduce a new framework without justification'}
        />

        {/* Advanced: tools, behavior, permissions, environment, session.
            Demoted out of the main flow but fully functional — behavior.retries
            here feeds the orchestrator's retry budget. */}
        <div className="border-t border-node-border/70 pt-4">
          <button
            onClick={() => setAdvancedOpen(open => !open)}
            className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle transition-colors hover:text-fg"
            aria-expanded={advancedOpen}
          >
            <ChevronRight size={13} className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`} />
            Advanced
          </button>

          {advancedOpen && (
            <div className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2">
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
                <Field label="Retries">
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={behavior.retries}
                    onChange={event => setBehavior({ retries: Number(event.target.value) })}
                    className="w-16 rounded border border-node-border bg-node/80 px-2 py-1 text-xs text-fg-muted outline-none transition-colors focus:border-accent"
                  />
                </Field>
              </Section>

              <Section title="Environment">
                <div className="space-y-2">
                  {envVars.map((envVar, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <input
                        value={envVar.key}
                        onChange={event => updateEnvVar(index, 'key', event.target.value)}
                        placeholder="KEY"
                        className="w-24 rounded border border-node-border bg-node/80 px-2 py-1 font-mono text-[11px] text-fg-muted outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
                      />
                      <input
                        value={envVar.value}
                        onChange={event => updateEnvVar(index, 'value', event.target.value)}
                        placeholder="value"
                        className="min-w-0 flex-1 rounded border border-node-border bg-node/80 px-2 py-1 font-mono text-[11px] text-fg-muted outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
                      />
                      <button onClick={() => removeEnvVar(index)} className="flex-shrink-0 text-fg-subtle transition-colors hover:text-fg-muted" aria-label="Remove variable">
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addEnvVar}
                    className="flex items-center gap-1 text-[11px] text-fg-subtle transition-colors hover:text-fg-muted"
                  >
                    <Plus size={12} /> Add variable
                  </button>
                </div>
              </Section>

              <Section title="Session">
                {resetState === 'confirm' ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-amber-400">Erase conversation?</span>
                    <button
                      onClick={handleReset}
                      className="rounded bg-red-600/80 px-2 py-1 text-[11px] text-fg transition-colors hover:bg-red-600"
                    >
                      Reset
                    </button>
                    <button
                      onClick={() => setResetState('idle')}
                      className="rounded border border-node-border px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-node hover:text-fg"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setResetState('confirm')}
                    disabled={resetState === 'pending'}
                    className="flex items-center gap-1.5 rounded border border-node-border px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:border-accent hover:text-fg disabled:opacity-50"
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
              </Section>
            </div>
          )}
        </div>
      </div>
    </DocPane>
  )
}

// Shared chip styling for the runtime / model / skill pickers in the
// frontmatter block. Active picks read in accent; idle picks are quiet.
function chipClass(active: boolean): string {
  return `flex items-center gap-1 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
    active
      ? 'border-accent/50 bg-accent/10 text-accent'
      : 'border-node-border bg-node text-fg-subtle hover:border-node-border-active hover:text-fg'
  }`
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-node-border/60 px-3.5 py-3 last:border-b-0">
      <div className="w-16 flex-shrink-0 pt-1 text-[11px] uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.22em] text-fg-subtle">{title}</p>
      {children}
    </section>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="flex items-center justify-between w-full group">
      <span className="text-[12px] text-fg-subtle group-hover:text-fg-muted transition-colors">{label}</span>
      <div className={`relative w-7 h-4 rounded-full transition-colors ${value ? 'bg-accent' : 'bg-node'}`}>
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-fg shadow transition-all ${value ? 'left-[14px]' : 'left-0.5'}`} />
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
        className="w-full bg-node border border-node-border rounded px-2 py-1 text-[11px] text-fg-muted placeholder:text-fg-subtle focus:outline-none focus:border-accent font-mono"
      />
      {filtered.length > 0 && (
        <div className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded border border-node-border bg-panel shadow-lg">
          {filtered.map(id => (
            <button
              key={id}
              onClick={() => choose(id)}
              className={`block w-full text-left px-2 py-1 text-[11px] font-mono ${
                current === id
                  ? 'text-accent bg-accent/10'
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
