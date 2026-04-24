import { effortArgsFor, type AgentRuntime } from '../../shared/agentRuntimes'
import { captureNewClaudeSession, snapshotClaudeSessions } from '../sessionCapture'
import type { ComposedPrompt, ResumeArgs, RuntimeAdapter, SpawnArgs } from './types'

const id: AgentRuntime = 'claude'

function buildCommonArgs(opts: SpawnArgs): string[] {
  const args: string[] = []
  if (opts.planMode) args.push('--permission-mode', 'plan')
  else if (opts.skipPermissions ?? true) args.push('--dangerously-skip-permissions')
  return args
}

function buildSpawnArgs(opts: SpawnArgs): string[] {
  const args = buildCommonArgs(opts)
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  // --append-system-prompt is only meaningful on fresh spawns; resumed
  // conversations already carry the original system prompt in their history.
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt)
  // claude accepts a positional prompt as the first user turn.
  if (opts.userPrompt) args.push(opts.userPrompt)
  return args
}

function buildResumeArgs(opts: ResumeArgs): string[] {
  const args = buildCommonArgs(opts)
  args.push('--resume', opts.sessionId)
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  // Intentionally ignore appendSystemPrompt on resume — claude drops the
  // flag silently when --resume is set.
  if (opts.userPrompt) args.push(opts.userPrompt)
  return args
}

function composeSystemAndUser(systemPrompt: string, userPrompt: string): ComposedPrompt {
  return {
    appendSystemPromptFlag: systemPrompt || undefined,
    firstUserPrompt: userPrompt || undefined,
  }
}

export const claudeAdapter: RuntimeAdapter = {
  id,
  supportsSystemPromptFlag: true,
  buildSpawnArgs,
  buildResumeArgs,
  composeSystemAndUser,
  snapshotSessions: (cwd) => snapshotClaudeSessions(cwd),
  captureNewSession: (cwd, before, timeoutMs) =>
    captureNewClaudeSession(cwd, before, timeoutMs),
  // Claude doesn't expose a cheap "does this session id exist" check, and
  // stale ids fail visibly at resume time anyway.
  revalidateSession: () => true,
}
