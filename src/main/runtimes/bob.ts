import type { AgentRuntime } from '../../shared/agentRuntimes'
import {
  captureNewBobSession,
  isBobSessionIdForCwd,
  snapshotBobSessions,
} from '../sessionCapture'
import { foldComposeSystemAndUser } from './fold'
import type { ResumeArgs, RuntimeAdapter, SpawnArgs } from './types'

const id: AgentRuntime = 'bob'

// bob picks its own model — we never emit --model regardless of opts.model.
// --yolo bypasses approvals; --accept-license is idempotent and defends
// against fresh installs where the license hasn't been accepted yet.
function buildCommonArgs(opts: SpawnArgs): string[] {
  const args: string[] = ['--yolo', '--accept-license']
  if (opts.planMode) args.push('--chat-mode', 'plan')
  return args
}

function buildSpawnArgs(opts: SpawnArgs): string[] {
  const args = buildCommonArgs(opts)
  if (opts.userPrompt) args.push('--prompt-interactive', opts.userPrompt)
  return args
}

function buildResumeArgs(opts: ResumeArgs): string[] {
  const args = buildCommonArgs(opts)
  args.push('--resume', opts.sessionId)
  if (opts.userPrompt) args.push('--prompt-interactive', opts.userPrompt)
  return args
}

export const bobAdapter: RuntimeAdapter = {
  id,
  supportsSystemPromptFlag: false,
  buildSpawnArgs,
  buildResumeArgs,
  composeSystemAndUser: foldComposeSystemAndUser,
  snapshotSessions: (cwd) => snapshotBobSessions(cwd),
  captureNewSession: (cwd, before, timeoutMs) =>
    captureNewBobSession(cwd, before, timeoutMs),
  revalidateSession: (cwd, sessionId) => isBobSessionIdForCwd(cwd, sessionId),
}
