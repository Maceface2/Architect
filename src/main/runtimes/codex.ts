import { effortArgsFor, type AgentRuntime } from '../../shared/agentRuntimes'
import {
  captureNewCodexSession,
  isCodexSessionIdForCwd,
  snapshotCodexSessions,
} from '../sessionCapture'
import { foldComposeSystemAndUser } from './fold'
import type { ResumeArgs, RuntimeAdapter, SpawnArgs } from './types'

const id: AgentRuntime = 'codex'

// Shared operating flags. Applied on both fresh spawn and resume —
// `codex resume <UUID>` is a subcommand, not a flag, and accepts the same
// standard operating flags.
const BASE_OP_FLAGS = ['--no-alt-screen', '-a', 'never', '-s', 'workspace-write']

function buildSpawnArgs(opts: SpawnArgs): string[] {
  const args: string[] = []
  args.push(...BASE_OP_FLAGS)
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  if (opts.userPrompt) args.push(opts.userPrompt)
  return args
}

function buildResumeArgs(opts: ResumeArgs): string[] {
  const args: string[] = ['resume', opts.sessionId, ...BASE_OP_FLAGS]
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  if (opts.userPrompt) args.push(opts.userPrompt)
  return args
}

export const codexAdapter: RuntimeAdapter = {
  id,
  supportsSystemPromptFlag: false,
  buildSpawnArgs,
  buildResumeArgs,
  composeSystemAndUser: foldComposeSystemAndUser,
  snapshotSessions: (cwd) => snapshotCodexSessions(cwd),
  captureNewSession: (cwd, before, timeoutMs) =>
    captureNewCodexSession(cwd, before, timeoutMs),
  revalidateSession: (cwd, sessionId) => isCodexSessionIdForCwd(cwd, sessionId),
}
