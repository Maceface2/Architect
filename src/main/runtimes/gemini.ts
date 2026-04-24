import { effortArgsFor, type AgentRuntime } from '../../shared/agentRuntimes'
import {
  captureNewGeminiSession,
  isGeminiSessionIdForCwd,
  snapshotGeminiSessions,
} from '../sessionCapture'
import { foldSystemIntoUser } from './fold'
import type { ComposedPrompt, ResumeArgs, RuntimeAdapter, SpawnArgs } from './types'

const id: AgentRuntime = 'gemini'

function buildCommonArgs(opts: SpawnArgs): string[] {
  const args: string[] = ['--approval-mode', 'yolo']
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  return args
}

function buildSpawnArgs(opts: SpawnArgs): string[] {
  const args = buildCommonArgs(opts)
  if (opts.userPrompt) args.push('--prompt-interactive', opts.userPrompt)
  return args
}

function buildResumeArgs(opts: ResumeArgs): string[] {
  const args: string[] = ['--approval-mode', 'yolo', '--resume', opts.sessionId]
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  if (opts.userPrompt) args.push('--prompt-interactive', opts.userPrompt)
  return args
}

function composeSystemAndUser(systemPrompt: string, userPrompt: string): ComposedPrompt {
  if (!systemPrompt) return { firstUserPrompt: userPrompt || undefined }
  return { firstUserPrompt: foldSystemIntoUser(systemPrompt, userPrompt) }
}

export const geminiAdapter: RuntimeAdapter = {
  id,
  supportsSystemPromptFlag: false,
  buildSpawnArgs,
  buildResumeArgs,
  composeSystemAndUser,
  snapshotSessions: (cwd) => snapshotGeminiSessions(cwd),
  captureNewSession: (cwd, before, timeoutMs) =>
    captureNewGeminiSession(cwd, before, timeoutMs),
  revalidateSession: (cwd, sessionId) => isGeminiSessionIdForCwd(cwd, sessionId),
}
