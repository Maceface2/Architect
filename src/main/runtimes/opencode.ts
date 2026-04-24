import { effortArgsFor, type AgentRuntime } from '../../shared/agentRuntimes'
import {
  captureNewOpencodeSession,
  snapshotOpencodeSessions,
} from '../sessionCapture'
import { foldSystemIntoUser } from './fold'
import type { ComposedPrompt, ResumeArgs, RuntimeAdapter, SpawnArgs } from './types'

const id: AgentRuntime = 'opencode'

function buildSpawnArgs(opts: SpawnArgs): string[] {
  const args: string[] = []
  if (opts.userPrompt) args.push('--prompt', opts.userPrompt)
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  return args
}

function buildResumeArgs(opts: ResumeArgs): string[] {
  // `--continue` alone means "continue THE LAST session" (boolean, no id).
  // `--session <id>` is the explicit form; passing both is contradictory and
  // the tool's resolution of the ambiguity historically picked the wrong one,
  // silently loading unrelated conversations. Always use the explicit flag.
  const args: string[] = ['--session', opts.sessionId]
  if (opts.userPrompt) args.push('--prompt', opts.userPrompt)
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  return args
}

function composeSystemAndUser(systemPrompt: string, userPrompt: string): ComposedPrompt {
  if (!systemPrompt) return { firstUserPrompt: userPrompt || undefined }
  return { firstUserPrompt: foldSystemIntoUser(systemPrompt, userPrompt) }
}

export const opencodeAdapter: RuntimeAdapter = {
  id,
  supportsSystemPromptFlag: false,
  buildSpawnArgs,
  buildResumeArgs,
  composeSystemAndUser,
  // opencode's snapshot path does not need the cwd — it lists all sessions
  // globally via the CLI. Keep the signature uniform with the interface.
  snapshotSessions: () => snapshotOpencodeSessions(),
  captureNewSession: (_cwd, before, timeoutMs) =>
    captureNewOpencodeSession(before, timeoutMs),
  revalidateSession: () => true,
}
