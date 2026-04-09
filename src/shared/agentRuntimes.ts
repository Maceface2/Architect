export type AgentRuntime = 'claude' | 'codex' | 'gemini' | 'opencode'
export type AgentRuntimeMode = 'inherit' | 'override'

export interface AgentRuntimeDefinition {
  id: AgentRuntime
  label: string
  shortLabel: string
  binary: string
  accentColor: string
  defaultModel: string
  suggestedModels: string[]
}

export const DEFAULT_AGENT_RUNTIME: AgentRuntime = 'claude'

export const AGENT_RUNTIMES: AgentRuntimeDefinition[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'claude',
    binary: 'claude',
    accentColor: '#f59e0b',
    defaultModel: 'claude-sonnet-4-6',
    suggestedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    shortLabel: 'codex',
    binary: 'codex',
    accentColor: '#10b981',
    defaultModel: 'gpt-5-codex',
    suggestedModels: ['gpt-5-codex', 'gpt-5', 'o4-mini'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    shortLabel: 'gemini',
    binary: 'gemini',
    accentColor: '#60a5fa',
    defaultModel: 'gemini-2.5-pro',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    shortLabel: 'open',
    binary: 'opencode',
    accentColor: '#f472b6',
    defaultModel: 'openai/gpt-5',
    suggestedModels: ['openai/gpt-5', 'anthropic/claude-sonnet-4-6', 'google/gemini-2.5-pro'],
  },
]

export const AGENT_RUNTIME_MAP = Object.fromEntries(
  AGENT_RUNTIMES.map(runtime => [runtime.id, runtime])
) as Record<AgentRuntime, AgentRuntimeDefinition>

export const DEFAULT_MODEL_BY_RUNTIME = Object.fromEntries(
  AGENT_RUNTIMES.map(runtime => [runtime.id, runtime.defaultModel])
) as Record<AgentRuntime, string>

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === 'string' && value in AGENT_RUNTIME_MAP
}

export function isAgentRuntimeMode(value: unknown): value is AgentRuntimeMode {
  return value === 'inherit' || value === 'override'
}

export function getAgentRuntime(runtime: AgentRuntime): AgentRuntimeDefinition {
  return AGENT_RUNTIME_MAP[runtime]
}
