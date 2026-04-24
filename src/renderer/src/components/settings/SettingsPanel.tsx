import {
  AGENT_RUNTIMES,
  DEFAULT_AGENT_RUNTIME,
  getAgentRuntime,
  type AgentRuntime,
  type EffortLevel,
} from '../../../../shared/agentRuntimes'
import type {
  HarnessTimeouts,
  NodeTools,
  ProjectSettings,
} from '../../types'
import type { AssistantOrientation } from '../layout/AssistantPanel'

interface Props {
  settings: ProjectSettings
  onChange: (partial: Partial<ProjectSettings>) => void
  assistantOrientation: AssistantOrientation
  onAssistantOrientationChange: (next: AssistantOrientation) => void
}

const TOOL_ROWS: [keyof NodeTools, string][] = [
  ['webSearch', 'Web Search'],
  ['codeExec', 'Code Exec'],
  ['fileRead', 'File Read'],
  ['fileWrite', 'File Write'],
  ['apiCalls', 'API Calls'],
  ['shell', 'Shell'],
]

const EFFORT_OPTIONS: EffortLevel[] = ['low', 'medium', 'high']

export default function SettingsPanel({
  settings,
  onChange,
  assistantOrientation,
  onAssistantOrientationChange,
}: Props) {
  const setModel = (runtime: AgentRuntime, model: string) => {
    onChange({ dispatchModels: { ...settings.dispatchModels, [runtime]: model } })
  }

  const toggleTool = (key: keyof NodeTools) => {
    onChange({ dispatchTools: { ...settings.dispatchTools, [key]: !settings.dispatchTools[key] } })
  }

  const setHarness = (key: keyof HarnessTimeouts, value: number) => {
    onChange({ harnessTimeouts: { ...settings.harnessTimeouts, [key]: Math.max(0, value) } })
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-10">
        <header>
          <h1 className="text-xl font-semibold text-white tracking-tight">Project Settings</h1>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            These settings persist in <span className="font-mono text-slate-400">architect-canvas.json</span> and apply to every new zone and dispatch in this project.
          </p>
        </header>

        <Section title="CLI (Dispatch / Zones)" hint="The CLI used for multi-zone dispatches and single-zone launches. The Architecture and General assistants each have their own CLI — pick them from the gear icon on the assistant panel.">
          <div className="grid grid-cols-2 gap-2">
            {AGENT_RUNTIMES.map(runtime => {
              const selected = settings.dispatchRuntime === runtime.id
              return (
                <button
                  key={runtime.id}
                  onClick={() => onChange({ dispatchRuntime: runtime.id })}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-colors ${
                    selected
                      ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-white'
                      : 'border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20'
                  }`}
                >
                  <span className="text-sm font-medium">{runtime.label}</span>
                  <span className="text-[10px] uppercase tracking-wider" style={{ color: runtime.accentColor }}>
                    {runtime.shortLabel}
                  </span>
                </button>
              )
            })}
          </div>
        </Section>

        <Section
          title="Models"
          hint="Per-CLI default model. Seeds new zones and pre-fills the Dispatch model picker."
        >
          <div className="space-y-3">
            {AGENT_RUNTIMES.map(runtime => {
              const current = settings.dispatchModels[runtime.id] ?? runtime.defaultModel
              return (
                <div key={runtime.id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-slate-400">{runtime.label}</span>
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: runtime.accentColor }}>
                      {runtime.shortLabel}
                    </span>
                  </div>
                  <input
                    value={current}
                    onChange={event => setModel(runtime.id, event.target.value)}
                    placeholder={runtime.defaultModel}
                    className="w-full bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                  />
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {runtime.suggestedModels.map(model => (
                      <button
                        key={model}
                        onClick={() => setModel(runtime.id, model)}
                        className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                          current === model
                            ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-[#58A6FF]'
                            : 'border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20'
                        }`}
                      >
                        {shortModelLabel(model)}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>

        <Section
          title="Dispatch effort"
          hint="Reasoning effort applied to zones and multi-zone dispatches at spawn. Mapped to each CLI's native flag; CLIs without an effort flag ignore this. Does NOT affect the side-panel assistant."
        >
          <div className="space-y-3">
            <Field label="Reasoning effort">
              <Seg
                options={EFFORT_OPTIONS}
                value={settings.dispatchEffort}
                onChange={value => onChange({ dispatchEffort: value })}
              />
            </Field>
            <Toggle
              label="Claude plan-mode default (Dispatch)"
              value={settings.dispatchPlanMode}
              onChange={() => onChange({ dispatchPlanMode: !settings.dispatchPlanMode })}
            />
            <p className="text-[11px] text-slate-600 leading-relaxed">
              Per-CLI behavior at spawn:
            </p>
            <ul className="text-[11px] text-slate-600 leading-relaxed list-disc list-inside space-y-0.5">
              <li>Claude — <span className="font-mono text-slate-500">--effort &lt;level&gt;</span> (also supports xhigh, max).</li>
              <li>Codex — <span className="font-mono text-slate-500">-c model_reasoning_effort="&lt;level&gt;"</span>.</li>
              <li>Gemini — no spawn flag; set a preset in <span className="font-mono text-slate-500">~/.gemini/config.json</span>.</li>
              <li>OpenCode — no spawn flag on the tui; press <span className="font-mono text-slate-500">Ctrl+T</span> inside the session to cycle variants.</li>
            </ul>
          </div>
        </Section>

        <Section
          title="New-zone tool seed"
          hint="Tool toggles copied into new zones when dragged onto the canvas. Existing zones keep their own config. The side-panel assistant is unaffected."
        >
          <div className="space-y-2">
            {TOOL_ROWS.map(([key, tLabel]) => (
              <Toggle
                key={key}
                label={tLabel}
                value={settings.dispatchTools[key]}
                onChange={() => toggleTool(key)}
              />
            ))}
          </div>
        </Section>

        <Section
          title="Timeouts (Dispatch / Zones)"
          hint="Zone timeout seeds new zones. Scheduler knobs govern how the conductor responds to stalled zones. The side-panel assistant has no timeout."
        >
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-slate-600">New-zone timeout seed</p>
              <NumberField
                label="Zone timeout (ms)"
                value={settings.dispatchTimeoutMs}
                min={0}
                step={1000}
                onChange={value => onChange({ dispatchTimeoutMs: Math.max(0, value) })}
              />
            </div>

            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-slate-600">Scheduler staleness</p>
              <NumberField
                label="Idle threshold (ms)"
                value={settings.harnessTimeouts.idleThresholdMs}
                min={0}
                step={1000}
                onChange={value => setHarness('idleThresholdMs', value)}
                hint="When both the PTY and the activity log go quiet past this threshold, the participant is marked stale."
              />
              <NumberField
                label="Stale escalation (ms)"
                value={settings.harnessTimeouts.staleEscalationMs}
                min={0}
                step={1000}
                onChange={value => setHarness('staleEscalationMs', value)}
                hint="How long a stale streak must persist before the scheduler invokes the conductor for recovery."
              />
            </div>
          </div>
        </Section>

        <Section
          title="Architect assistant"
          hint="The side-panel assistant that drafts or edits this project's architecture."
        >
          <div className="space-y-3">
            <Field label="Mode">
              <Seg
                options={['architecture', 'general'] as const}
                value={settings.assistantMode}
                onChange={value => onChange({ assistantMode: value })}
              />
            </Field>
            <Field label="Dock">
              <Seg
                options={['right', 'bottom'] as const}
                value={assistantOrientation}
                onChange={onAssistantOrientationChange}
              />
            </Field>
          </div>
          <p className="text-[11px] text-slate-600 leading-relaxed mt-2">
            Architecture and General assistants each pick their own CLI + model from the gear icon on the assistant panel — those choices are independent of the Dispatch/Zone CLI above. Dock position is saved per machine; both mode terminals keep running when you close the panel or switch modes.
          </p>
          <div className="mt-3 space-y-1 text-[11px] text-slate-500">
            <p className="text-[10px] uppercase tracking-wider text-slate-600">Current per-mode CLI</p>
            {(['architecture', 'general'] as const).map(mode => {
              const rt = settings.assistantRuntimeByMode?.[mode]
              const effective = rt ?? DEFAULT_AGENT_RUNTIME
              const explicit = !!rt
              return (
                <p key={mode}>
                  <span className="capitalize text-slate-400">{mode}</span>
                  {' → '}
                  <span className="text-slate-300">{getAgentRuntime(effective).label}</span>
                  {!explicit && <span className="text-slate-600"> (baseline — pick via assistant gear to make it sticky)</span>}
                </p>
              )
            })}
          </div>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-[10px] uppercase tracking-widest text-slate-500">{title}</h2>
        {hint && <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">{hint}</p>}
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-[#141414] p-5">
        {children}
      </div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-slate-400">{label}</span>
      {children}
    </div>
  )
}

function Seg<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex rounded overflow-hidden border border-white/[0.08]">
      {options.map(option => (
        <button
          key={option}
          onClick={() => onChange(option)}
          className={`px-2.5 py-1 text-[11px] capitalize transition-colors ${
            value === option ? 'bg-[#58A6FF]/20 text-[#58A6FF]' : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="flex items-center justify-between w-full group py-0.5">
      <span className="text-[12px] text-slate-400 group-hover:text-slate-200 transition-colors">{label}</span>
      <div className={`relative w-8 h-4 rounded-full transition-colors ${value ? 'bg-[#58A6FF]' : 'bg-white/10'}`}>
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${value ? 'left-[18px]' : 'left-0.5'}`} />
      </div>
    </button>
  )
}

function NumberField({
  label,
  value,
  onChange,
  min,
  step,
  hint,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  step?: number
  hint?: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-slate-400">{label}</span>
        <input
          type="number"
          value={value}
          min={min}
          step={step}
          onChange={event => onChange(Number(event.target.value))}
          className="w-32 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[12px] text-slate-300 focus:outline-none focus:border-white/20 font-mono text-right"
        />
      </div>
      {hint && <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">{hint}</p>}
    </div>
  )
}

function shortModelLabel(model: string): string {
  return model.includes('/') ? model.split('/').pop() || model : model
}
