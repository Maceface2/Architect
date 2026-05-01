import { execFile } from 'child_process'
import { effortArgsFor, type AgentRuntime } from '../../shared/agentRuntimes'
import {
  captureNewOpencodeSession,
  snapshotOpencodeSessions,
} from '../sessionCapture'
import { foldComposeSystemAndUser } from './fold'
import type { ResumeArgs, RuntimeAdapter, SpawnArgs } from './types'

// `opencode models` prints one slug per line. Most are `provider/model`
// (e.g. opencode/big-pickle) but some providers emit multi-segment paths
// (e.g. nvidia/deepseek-ai/deepseek-r1). Drop lines without a slash, with
// whitespace, or starting with non-slug chars to filter banners/blanks.
const MODEL_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]+$/

function probeOpencodeModels(opts: { binaryPath: string; signal: AbortSignal }): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(opts.binaryPath, ['models'], { signal: opts.signal, timeout: 3000 }, (err, stdout) => {
      if (err) return reject(err)
      const models = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.includes('/') && MODEL_SLUG_RE.test(line))
      resolve(models)
    })
  })
}

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

export const opencodeAdapter: RuntimeAdapter = {
  id,
  supportsSystemPromptFlag: false,
  buildSpawnArgs,
  buildResumeArgs,
  composeSystemAndUser: foldComposeSystemAndUser,
  // opencode's snapshot path does not need the cwd — it lists all sessions
  // globally via the CLI. Keep the signature uniform with the interface.
  snapshotSessions: () => snapshotOpencodeSessions(),
  captureNewSession: (_cwd, before, timeoutMs) =>
    captureNewOpencodeSession(before, timeoutMs),
  revalidateSession: () => true,
  probeModels: probeOpencodeModels,
}
