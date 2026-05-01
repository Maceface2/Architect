import {
  AGENT_RUNTIMES,
  DEFAULT_AGENT_RUNTIME,
  getAgentRuntime,
  type AgentRuntime,
  type EffortLevel,
} from '../../../../shared/agentRuntimes'
import type {
  HarnessTimeouts,
  InterfaceSettings,
  NodeTools,
  ProjectSettings,
  ZoneNodeType,
} from '../../types'
import type { AssistantOrientation } from '../layout/AssistantPanel'
import { pickerRuntimes, useRuntimeDetection } from '../../context/RuntimeDetectionContext'
import { RuntimeEmptyState } from '../runtime/RuntimeEmptyState'

interface Props {
  settings: ProjectSettings
  // Zones are read only to detect divergence from the canvas default, so we
  // can surface a "Custom" pill. The bulk-apply of `dispatchRuntime` → every
  // zone happens in App.tsx's onChange handler.
  zones: ZoneNodeType[]
  onChange: (partial: Partial<ProjectSettings>) => void
  assistantOrientation: AssistantOrientation
  onAssistantOrientationChange: (next: AssistantOrientation) => void
  onGenerateCanvasFromCodebase: () => void
  generatingCanvasFromCodebase?: boolean
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
  zones,
  onChange,
  assistantOrientation,
  onAssistantOrientationChange,
  onGenerateCanvasFromCodebase,
  generatingCanvasFromCodebase = false,
}: Props) {
  // When zones disagree on runtime, highlight a "Custom" pill instead of any
  // concrete CLI — the canvas default still exists (seeds new zones) but no
  // longer describes current canvas state.
  const zoneRuntimes = zones.map(z => z.data.agentRuntime).filter((r): r is AgentRuntime => !!r)
  const uniqueZoneRuntimes = new Set(zoneRuntimes)
  const zonesAreCustom = uniqueZoneRuntimes.size > 1
  const activeZoneRuntime: AgentRuntime | null = zonesAreCustom
    ? null
    : (zoneRuntimes[0] ?? settings.dispatchRuntime)

  const detection = useRuntimeDetection()
  const runtimeOptions = pickerRuntimes(detection.byId, activeZoneRuntime ?? settings.dispatchRuntime)
  const lastScanned = detection.result.scannedAt
    ? new Date(detection.result.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  const setModel = (runtime: AgentRuntime, model: string) => {
    onChange({ dispatchModels: { ...settings.dispatchModels, [runtime]: model } })
  }

  const toggleTool = (key: keyof NodeTools) => {
    onChange({ dispatchTools: { ...settings.dispatchTools, [key]: !settings.dispatchTools[key] } })
  }

  const setHarness = (key: keyof HarnessTimeouts, value: number) => {
    onChange({ harnessTimeouts: { ...settings.harnessTimeouts, [key]: Math.max(0, value) } })
  }

  const setInterface = (partial: Partial<InterfaceSettings>) => {
    onChange({ interface: { ...settings.interface, ...partial } })
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-10">
        <header>
          <h1 className="text-xl font-semibold text-fg tracking-tight">Project Settings</h1>
          <p className="text-xs text-fg-subtle mt-1 leading-relaxed">
            These settings persist in <span className="font-mono text-fg-muted">architect-canvas.json</span> and apply to every new zone and dispatch in this project.
          </p>
        </header>

        <Section title="Interface" hint="Pure UI preferences — these only affect how the renderer paints. Saved with the canvas so the next session starts with the same look.">
          <div className="space-y-3">
            <Field label="Zone style">
              <Seg
                options={['default', 'architectural'] as const}
                value={settings.interface.zoneTreatment}
                onChange={value => setInterface({ zoneTreatment: value })}
              />
            </Field>
            <Field label="Theme">
              <Seg
                options={['dark', 'light'] as const}
                value={settings.interface.theme}
                onChange={value => setInterface({ theme: value })}
              />
            </Field>
            <Field label="Canvas background">
              <Seg
                options={['dots', 'grid'] as const}
                value={settings.interface.canvasBackground}
                onChange={value => setInterface({ canvasBackground: value })}
              />
            </Field>
          </div>
          <p className="text-[11px] text-fg-subtle leading-relaxed mt-3">
            <span className="text-fg-muted">Architectural</span> turns zones into outlined boxes with corner ticks and a floating label, like a blueprint. <span className="text-fg-muted">Default</span> keeps the current card look.
          </p>
        </Section>

        <Section title="Canvas Zone CLI" hint="Picking a CLI here bulk-applies it to every zone on the canvas and seeds newly dragged zones. Individual zones may still override via the zone config. The Orchestrator (Conductor) CLI is picked separately at dispatch time.">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
              {lastScanned ? `Scanned ${lastScanned}` : 'Scanning…'}
            </span>
            <button
              onClick={() => void detection.rescan()}
              disabled={detection.rescanning}
              className="px-2 py-0.5 rounded border border-white/10 text-[10px] uppercase tracking-wider text-fg-subtle hover:text-fg hover:border-white/30 disabled:opacity-50"
            >
              {detection.rescanning ? 'Rescanning…' : 'Rescan CLIs'}
            </button>
          </div>
          {detection.installed.length === 0 ? (
            <RuntimeEmptyState />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {runtimeOptions.map(detected => {
                const def = getAgentRuntime(detected.id)
                const selected = activeZoneRuntime === detected.id
                const notInstalled = !detected.installed
                return (
                  <button
                    key={detected.id}
                    onClick={() => onChange({ dispatchRuntime: detected.id })}
                    title={notInstalled ? 'Selected but not installed on this machine' : undefined}
                    className={`flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-colors ${
                      selected
                        ? notInstalled
                          ? 'border-amber-400/50 bg-amber-400/10 text-amber-100'
                          : 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-fg'
                        : 'border-white/[0.08] text-fg-subtle hover:text-fg-muted hover:border-white/20'
                    }`}
                  >
                    <span className="text-sm font-medium">
                      {def.label}
                      {notInstalled && <span className="ml-1.5 text-[10px] text-amber-300">(not installed)</span>}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: def.accentColor }}>
                      {def.shortLabel}
                    </span>
                  </button>
                )
              })}
              <div
                className={`flex items-center justify-between px-3 py-2.5 rounded-lg border text-left col-span-2 ${
                  zonesAreCustom
                    ? 'border-amber-400/40 bg-amber-400/10 text-amber-100'
                    : 'border-white/[0.04] text-fg-subtle'
                }`}
                title={
                  zonesAreCustom
                    ? 'Zones on the canvas use different CLIs. Pick a CLI above to bulk-apply it everywhere.'
                    : 'Highlights when zones diverge from the canvas default.'
                }
              >
                <span className="text-sm font-medium">Custom</span>
                <span className="text-[10px] uppercase tracking-wider">
                  {zonesAreCustom ? `${uniqueZoneRuntimes.size} clis in use` : '—'}
                </span>
              </div>
            </div>
          )}
        </Section>

        <Section
          title="Models"
          hint="Per-CLI default model. Seeds new zones and pre-fills the Dispatch model picker."
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
              Refresh asks each CLI for its current model list (LLM round-trip, ~10–60s).
            </span>
            <button
              onClick={() => void detection.refreshModels()}
              disabled={detection.refreshing || detection.installed.length === 0}
              className="px-2 py-0.5 rounded border border-white/10 text-[10px] uppercase tracking-wider text-fg-subtle hover:text-fg hover:border-white/30 disabled:opacity-50"
              title="Invokes claude -p / codex exec / gemini -p with a JSON-list prompt and caches the result."
            >
              {detection.refreshing ? 'Refreshing…' : 'Refresh models'}
            </button>
          </div>
          {detection.lastRefreshReports && detection.lastRefreshReports.length > 0 && (
            <div className="mb-3 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 space-y-1">
              {detection.lastRefreshReports.map(report => {
                const def = getAgentRuntime(report.runtime)
                return (
                  <div key={report.runtime} className="flex items-center justify-between text-[11px]">
                    <span className="text-fg-muted">{def.label}</span>
                    {report.ok ? (
                      <span className="text-emerald-400">✓ {report.count} models</span>
                    ) : (
                      <span className="text-amber-400 truncate max-w-[60%]" title={report.error}>
                        failed{report.error ? ` — ${report.error.split('\n')[0]}` : ''}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <div className="space-y-3">
            {AGENT_RUNTIMES.filter(r => detection.byId[r.id].installed).map(runtime => {
              const detected = detection.byId[runtime.id]
              const current = settings.dispatchModels[runtime.id] ?? runtime.defaultModel
              const suggestions = detected.models.length > 0 ? detected.models : runtime.suggestedModels
              const probedAtLabel = detected.probedAt
                ? new Date(detected.probedAt).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : null
              return (
                <div key={runtime.id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-fg-muted">
                      {runtime.label}
                      {detected.modelsSource === 'probed' && (
                        <span
                          className="ml-1.5 text-[10px] text-emerald-400/80"
                          title={probedAtLabel ? `Models probed at ${probedAtLabel}` : 'Models probed live from the CLI'}
                        >
                          probed{probedAtLabel ? ` · ${probedAtLabel}` : ''}
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: runtime.accentColor }}>
                      {runtime.shortLabel}
                    </span>
                  </div>
                  <input
                    value={current}
                    onChange={event => setModel(runtime.id, event.target.value)}
                    placeholder={runtime.defaultModel}
                    className="w-full bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-fg-muted placeholder-fg-subtle focus:outline-none focus:border-white/20 font-mono"
                  />
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {suggestions.map(model => (
                      <button
                        key={model}
                        onClick={() => setModel(runtime.id, model)}
                        className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                          current === model
                            ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-[#58A6FF]'
                            : 'border-white/[0.08] text-fg-subtle hover:text-fg-muted hover:border-white/20'
                        }`}
                      >
                        {shortModelLabel(model)}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
            {detection.installed.length === 0 && (
              <p className="text-[11px] text-fg-subtle leading-relaxed">
                Install a CLI to configure its default model.
              </p>
            )}
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
            <p className="text-[11px] text-fg-subtle leading-relaxed">
              Per-CLI behavior at spawn:
            </p>
            <ul className="text-[11px] text-fg-subtle leading-relaxed list-disc list-inside space-y-0.5">
              <li>Claude — <span className="font-mono text-fg-subtle">--effort &lt;level&gt;</span> (also supports xhigh, max).</li>
              <li>Codex — <span className="font-mono text-fg-subtle">-c model_reasoning_effort="&lt;level&gt;"</span>.</li>
              <li>Gemini — no spawn flag; set a preset in <span className="font-mono text-fg-subtle">~/.gemini/config.json</span>.</li>
              <li>OpenCode — no spawn flag on the tui; press <span className="font-mono text-fg-subtle">Ctrl+T</span> inside the session to cycle variants.</li>
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
              <p className="text-[10px] uppercase tracking-wider text-fg-subtle">New-zone timeout seed</p>
              <NumberField
                label="Zone timeout (ms)"
                value={settings.dispatchTimeoutMs}
                min={0}
                step={1000}
                onChange={value => onChange({ dispatchTimeoutMs: Math.max(0, value) })}
              />
            </div>

            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Scheduler staleness</p>
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
          title="ARCHITECT assistant"
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
          <p className="text-[11px] text-fg-subtle leading-relaxed mt-2">
            Architecture and General assistants each pick their own CLI + model from the gear icon on the assistant panel — those choices are independent of the Dispatch/Zone CLI above. Dock position is saved per machine; both mode terminals keep running when you close the panel or switch modes.
          </p>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-black/20 px-3 py-3">
            <div>
              <p className="text-[12px] font-medium text-fg-muted">Generate Canvas From Codebase</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-fg-subtle">
                Starts a fresh Architecture Assistant session to inspect this project and write an architecture canvas.
              </p>
            </div>
            <button
              onClick={onGenerateCanvasFromCodebase}
              disabled={generatingCanvasFromCodebase}
              className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-fg bg-accent rounded hover:bg-[#4a4ad0] disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              {generatingCanvasFromCodebase ? 'Opening assistant...' : 'Generate Canvas From Codebase'}
            </button>
          </div>
          <div className="mt-3 space-y-1 text-[11px] text-fg-subtle">
            <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Current per-mode CLI</p>
            {(['architecture', 'general'] as const).map(mode => {
              const rt = settings.assistantRuntimeByMode?.[mode]
              const effective = rt ?? DEFAULT_AGENT_RUNTIME
              const explicit = !!rt
              return (
                <p key={mode}>
                  <span className="capitalize text-fg-muted">{mode}</span>
                  {' → '}
                  <span className="text-fg-muted">{getAgentRuntime(effective).label}</span>
                  {!explicit && <span className="text-fg-subtle"> (baseline — pick via assistant gear to make it sticky)</span>}
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
        <h2 className="text-[10px] uppercase tracking-widest text-fg-subtle">{title}</h2>
        {hint && <p className="text-[11px] text-fg-subtle mt-1 leading-relaxed">{hint}</p>}
      </div>
      <div className="rounded-xl border border-node-border bg-panel p-5">
        {children}
      </div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-fg-muted">{label}</span>
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
            value === option ? 'bg-[#58A6FF]/20 text-[#58A6FF]' : 'text-fg-subtle hover:text-fg-muted'
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
      <span className="text-[12px] text-fg-muted group-hover:text-fg transition-colors">{label}</span>
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
        <span className="text-[12px] text-fg-muted">{label}</span>
        <input
          type="number"
          value={value}
          min={min}
          step={step}
          onChange={event => onChange(Number(event.target.value))}
          className="w-32 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[12px] text-fg-muted focus:outline-none focus:border-white/20 font-mono text-right"
        />
      </div>
      {hint && <p className="text-[11px] text-fg-subtle mt-1 leading-relaxed">{hint}</p>}
    </div>
  )
}

function shortModelLabel(model: string): string {
  return model.includes('/') ? model.split('/').pop() || model : model
}
