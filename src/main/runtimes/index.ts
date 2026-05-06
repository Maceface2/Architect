import type { AgentRuntime } from '../../shared/agentRuntimes'
import { bobAdapter } from './bob'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { geminiAdapter } from './gemini'
import { opencodeAdapter } from './opencode'
import type { RuntimeAdapter } from './types'

const adapters: Record<AgentRuntime, RuntimeAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
  bob: bobAdapter,
}

export function getRuntimeAdapter(runtime: AgentRuntime): RuntimeAdapter {
  return adapters[runtime]
}

export type { RuntimeAdapter, SpawnArgs, ResumeArgs, ComposedPrompt } from './types'
