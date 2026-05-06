export type AgentRuntime = 'claude' | 'codex' | 'gemini' | 'opencode' | 'bob'
export type AgentRuntimeMode = 'inherit' | 'override'
export type AssistantMode = 'architecture' | 'general'
export type EffortLevel = 'low' | 'medium' | 'high'

export function isAssistantMode(value: unknown): value is AssistantMode {
  return value === 'architecture' || value === 'general'
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return value === 'low' || value === 'medium' || value === 'high'
}

export interface AgentRuntimeDefinition {
  id: AgentRuntime
  label: string
  shortLabel: string
  binary: string
  accentColor: string
  // Whether the user can pick the model for this runtime. False for runtimes
  // whose CLI manages the model itself (bob); true for the rest. UI pickers
  // hide the model dropdown when false; the adapter's buildSpawnArgs MUST NOT
  // emit a `--model` flag for runtimes where this is false.
  supportsModelSelection: boolean
  defaultModel?: string
  suggestedModels?: string[]
}

export const DEFAULT_AGENT_RUNTIME: AgentRuntime = 'claude'

export const AGENT_RUNTIMES: AgentRuntimeDefinition[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'claude',
    binary: 'claude',
    accentColor: '#f59e0b',
    supportsModelSelection: true,
    defaultModel: 'claude-sonnet-4-6',
    suggestedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    shortLabel: 'codex',
    binary: 'codex',
    accentColor: '#10b981',
    supportsModelSelection: true,
    defaultModel: 'gpt-5.4-mini',
    suggestedModels: ['gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.4'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    shortLabel: 'gemini',
    binary: 'gemini',
    accentColor: '#60a5fa',
    supportsModelSelection: true,
    defaultModel: 'gemini-2.5-pro',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    shortLabel: 'open',
    binary: 'opencode',
    accentColor: '#f472b6',
    supportsModelSelection: true,
    // Models that `opencode models` returns with zero credentials
    // configured — i.e. the user does NOT need to plug in any provider API
    // key to use them. (Billing may still happen via OpenCode's own
    // credits/subscription, but nothing on the user's machine needs to be
    // authenticated.) Keep this list aligned with that CLI output.
    defaultModel: 'opencode/big-pickle',
    suggestedModels: [
      'opencode/big-pickle',
      'opencode/gpt-5-nano',
      'opencode/ling-2.6-flash-free',
      'opencode/minimax-m2.5-free',
      'opencode/nemotron-3-super-free',
    ],
  },
  {
    id: 'bob',
    label: 'Bob Shell',
    shortLabel: 'bob',
    binary: 'bob',
    accentColor: '#0f62fe',
    // bob picks its own model — there is no user-relevant --model flag, and
    // the adapter MUST NOT emit one. UI pickers gate on this field.
    supportsModelSelection: false,
  },
]

export const AGENT_RUNTIME_MAP = Object.fromEntries(
  AGENT_RUNTIMES.map(runtime => [runtime.id, runtime])
) as Record<AgentRuntime, AgentRuntimeDefinition>

// Values are undefined for runtimes whose CLI manages its own model
// (supportsModelSelection=false, e.g. bob). Callers must guard.
export const DEFAULT_MODEL_BY_RUNTIME = Object.fromEntries(
  AGENT_RUNTIMES.map(runtime => [runtime.id, runtime.defaultModel])
) as Record<AgentRuntime, string | undefined>

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === 'string' && value in AGENT_RUNTIME_MAP
}

export function isAgentRuntimeMode(value: unknown): value is AgentRuntimeMode {
  return value === 'inherit' || value === 'override'
}

export function getAgentRuntime(runtime: AgentRuntime): AgentRuntimeDefinition {
  return AGENT_RUNTIME_MAP[runtime]
}

// Map the unified effort enum into the flag shape each CLI expects. Claude
// and Codex accept an effort flag on their root/interactive invocation;
// Gemini and OpenCode currently don't surface one on the tui we spawn.
//
//   claude:   --effort <low|medium|high|xhigh|max>        (documented on root)
//   codex:    -c model_reasoning_effort="<low|medium|high>"   (also works on `codex resume`)
//   gemini:   no root flag — requires config.json preset + interactive /model
//   opencode: --variant only works on `opencode run`; the interactive tui
//             (what Architect spawns) rejects it. Ctrl+T cycles variants
//             in-session. No spawn-time flag available.
export function effortArgsFor(runtime: AgentRuntime, effort: EffortLevel): string[] {
  switch (runtime) {
    case 'claude':
      return ['--effort', effort]
    case 'codex':
      return ['-c', `model_reasoning_effort="${effort}"`]
    case 'gemini':
      return []
    case 'opencode':
      return []
    case 'bob':
      return []
  }
}

// Whether a runtime honors `effortArgsFor` at spawn time. Used by the
// Settings page to dim / annotate runtimes that can't pick up the setting.
export function runtimeSupportsEffortFlag(runtime: AgentRuntime): boolean {
  return runtime === 'claude' || runtime === 'codex'
}
