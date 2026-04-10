import * as pty from 'node-pty'
import { execFileSync } from 'child_process'
import fs from 'fs'
import {
  getAgentRuntime,
  type AgentRuntime,
} from '../shared/agentRuntimes'

const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

process.env.PATH = [...EXTRA_PATHS, ...(process.env.PATH || '').split(':')].join(':')

export interface OneShotAgentResult {
  ok: boolean
  output: string
  error?: string
  timedOut?: boolean
}

export function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

export function hasStandaloneToken(buffer: string, token: string) {
  const normalized = stripAnsi(buffer).replace(/\r/g, '\n')
  return normalized
    .split('\n')
    .some(line => line.trim() === token)
}

export function resolveBinary(runtime: AgentRuntime): string | null {
  const { binary } = getAgentRuntime(runtime)
  const candidates = [
    `/opt/homebrew/bin/${binary}`,
    `/usr/local/bin/${binary}`,
    `/usr/bin/${binary}`,
    `/bin/${binary}`,
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const resolved = execFileSync(shell, ['-l', '-c', `which ${binary}`], { encoding: 'utf-8' }).trim()
    return resolved || null
  } catch {
    return null
  }
}

export function buildRuntimeArgs(runtime: AgentRuntime, prompt?: string, model?: string, resumeSessionId?: string): string[] {
  switch (runtime) {
    case 'claude': {
      const args: string[] = ['--dangerously-skip-permissions']
      if (resumeSessionId) args.push('--resume', resumeSessionId)
      if (model) args.push('--model', model)
      if (prompt) args.push(prompt)
      return args
    }
    case 'codex': {
      const args: string[] = ['--no-alt-screen', '-a', 'never', '-s', 'workspace-write']
      if (model) args.push('--model', model)
      if (prompt) args.push(prompt)
      return args
    }
    case 'gemini': {
      const args: string[] = ['--approval-mode', 'yolo']
      if (model) args.push('--model', model)
      if (prompt) args.push('--prompt-interactive', prompt)
      return args
    }
    case 'opencode': {
      const args: string[] = []
      if (prompt) args.push('--prompt', prompt)
      if (model) args.push('--model', model)
      return args
    }
  }
}

export function runOneShotAgentPrompt({
  runtime,
  cwd,
  prompt,
  model,
  completionToken,
  timeoutMs = 90_000,
}: {
  runtime: AgentRuntime
  cwd: string
  prompt: string
  model?: string
  completionToken: string
  timeoutMs?: number
}): Promise<OneShotAgentResult> {
  const bin = resolveBinary(runtime)
  if (!bin) {
    return Promise.resolve({
      ok: false,
      output: '',
      error: `Architect could not find the ${getAgentRuntime(runtime).label} binary (${getAgentRuntime(runtime).binary}) on PATH.`,
    })
  }

  return new Promise(resolve => {
    let settled = false
    let output = ''

    const finish = (result: OneShotAgentResult, kill = true) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (kill) {
        try { ptyProcess.kill() } catch {}
      }
      resolve(result)
    }

    const ptyProcess = pty.spawn(bin, buildRuntimeArgs(runtime, prompt, model), {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd,
      env: process.env as Record<string, string>,
    })

    const timer = setTimeout(() => {
      finish({
        ok: false,
        output,
        error: `Timed out waiting for ${getAgentRuntime(runtime).label} to finish architecture import.`,
        timedOut: true,
      })
    }, timeoutMs)

    ptyProcess.onData(data => {
      output += data
      if (output.length > 200_000) output = output.slice(-200_000)
      if (hasStandaloneToken(output, completionToken)) {
        finish({ ok: true, output })
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      if (settled) return
      finish({
        ok: exitCode === 0 || hasStandaloneToken(output, completionToken),
        output,
        error: exitCode === 0 ? undefined : `${getAgentRuntime(runtime).label} exited before completing architecture import (exit ${exitCode}).`,
      }, false)
    })
  })
}
