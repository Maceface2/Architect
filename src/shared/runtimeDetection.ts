import type { AgentRuntime } from './agentRuntimes'

// Per-runtime snapshot of "is this CLI installed and what models can it run?"
// Populated by main/runtimeDetection.ts and shipped to the renderer through
// the runtime:get-detected IPC channel. Pickers consume this to filter their
// runtime grids and surface the empty state.
export interface DetectedRuntime {
  id: AgentRuntime
  installed: boolean
  binaryPath?: string
  // models the user can pick. When modelsSource === 'probed' these came from
  // a live CLI invocation; otherwise they're the curated suggestedModels list
  // from agentRuntimes.ts.
  models: string[]
  modelsSource: 'probed' | 'suggested'
  // Only set when modelsSource === 'probed'. For opencode this is the time
  // of the live `opencode models` shell-out; for claude/codex/gemini it's
  // the time the user last clicked "Refresh models" (a CLI-prompt probe).
  probedAt?: number
  defaultModel: string
}

export interface RuntimeDetectionResult {
  runtimes: DetectedRuntime[]
  scannedAt: number
}

// Install commands per CLI. Used by RuntimeEmptyState in pickers when zero
// CLIs are detected. Keep these in sync with the CLI vendors' docs.
export const INSTALL_COMMANDS: Record<AgentRuntime, { brew?: string; npm?: string; url: string }> = {
  claude: {
    npm: 'npm install -g @anthropic-ai/claude-code',
    url: 'https://docs.claude.com/en/docs/claude-code/quickstart',
  },
  codex: {
    npm: 'npm install -g @openai/codex',
    url: 'https://github.com/openai/codex',
  },
  gemini: {
    npm: 'npm install -g @google/gemini-cli',
    url: 'https://github.com/google-gemini/gemini-cli',
  },
  opencode: {
    brew: 'brew install sst/tap/opencode',
    npm: 'npm install -g opencode-ai',
    url: 'https://opencode.ai',
  },
}
