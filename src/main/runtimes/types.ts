import type { AgentRuntime, EffortLevel } from '../../shared/agentRuntimes'

// Canonical spawn options — runtime adapters translate this into CLI-specific
// argv. Each adapter owns its own flag quirks (--resume vs resume subcommand,
// positional vs flag-based prompt, --append-system-prompt vs inline fold).
export interface SpawnArgs {
  userPrompt?: string
  model?: string
  effort?: EffortLevel
  planMode?: boolean
  skipPermissions?: boolean
  // Role / system prompt. Only honored as a CLI flag when the adapter reports
  // supportsSystemPromptFlag=true (Claude's --append-system-prompt). Every
  // other adapter folds it into the first-turn user prompt via
  // composeSystemAndUser.
  appendSystemPrompt?: string
}

export interface ResumeArgs extends SpawnArgs {
  sessionId: string
}

// Output of composeSystemAndUser. Callers that want to deliver a system
// prompt at spawn use this to decide whether the prompt goes in the argv
// (`appendSystemPromptFlag`) or inline (`firstUserPrompt`). Exactly one of
// the two will be set for any non-empty system prompt; both may be undefined
// if no system prompt was provided.
export interface ComposedPrompt {
  // If set, the adapter wants to pass the system prompt as a CLI flag
  // (Claude's --append-system-prompt). The caller should set
  // SpawnArgs.appendSystemPrompt to this value and pass a separate userPrompt.
  appendSystemPromptFlag?: string
  // If set, the adapter has folded the system prompt into a combined user
  // prompt. The caller should pass this as SpawnArgs.userPrompt with no
  // appendSystemPrompt.
  firstUserPrompt?: string
}

export interface RuntimeAdapter {
  readonly id: AgentRuntime
  // Whether this runtime supports a CLI flag for injecting a system prompt
  // at spawn time. Only claude's --append-system-prompt qualifies today.
  readonly supportsSystemPromptFlag: boolean

  // Build argv for a fresh spawn.
  buildSpawnArgs(opts: SpawnArgs): string[]
  // Build argv for resuming an existing session. Adapter owns the resume
  // verb ('--resume', 'resume', '--session') and prompt-delivery shape.
  buildResumeArgs(opts: ResumeArgs): string[]

  // Compose a system prompt + optional user prompt for delivery at spawn.
  // See ComposedPrompt. Claude returns {appendSystemPromptFlag, firstUserPrompt};
  // runtimes without a system-prompt flag return {firstUserPrompt} with the
  // role prompt inlined via a <<SYSTEM>>…<<END>> wrapper.
  composeSystemAndUser(systemPrompt: string, userPrompt: string): ComposedPrompt

  // Pre-spawn: snapshot existing session IDs on disk for this runtime. Used
  // to diff against the post-spawn state to identify the newly-created session.
  // Some adapters are async (opencode spawns a subprocess).
  snapshotSessions(cwd: string): Promise<Set<string>> | Set<string>

  // Post-spawn: poll until a new session ID appears, or timeout.
  captureNewSession(
    cwd: string,
    before: Set<string>,
    timeoutMs?: number,
  ): Promise<string | null>

  // Cheap existence/reachability check against on-disk session store.
  // Called before resume to fail fast on stale ids (user cleared session
  // dir, etc). Runtimes without a stable check just return true.
  revalidateSession(cwd: string, sessionId: string): boolean
}
