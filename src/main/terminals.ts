import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join, basename } from 'path'
import fs from 'fs'
import { execFileSync, spawn } from 'child_process'
import { randomBytes, createHash } from 'crypto'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import {
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  isAgentRuntime,
  isAgentRuntimeMode,
  isAssistantMode,
  type AgentRuntime,
  type AssistantMode,
} from '../shared/agentRuntimes'
import {
  appendZoneSession,
  captureNewClaudeSession,
  captureNewCodexSession,
  captureNewGeminiSession,
  captureNewOpencodeSession,
  deleteZoneSession,
  getZoneSessionRecord,
  isCodexSessionIdForCwd,
  isGeminiSessionIdForCwd,
  listZoneSessions,
  snapshotClaudeSessions,
  snapshotCodexSessions,
  snapshotGeminiSessions,
  snapshotOpencodeSessions,
  updateZoneSessionSummary,
  type ZoneSessionRecord,
} from './sessionCapture'
import {
  saveDispatch,
  summarizeFromPrompt,
  upsertDispatchZoneSession,
  type DispatchRecord,
} from './dispatchCapture'

let shellEnvPromise: Promise<NodeJS.ProcessEnv> | undefined

function resolveUnixShellEnv(): Promise<NodeJS.ProcessEnv> {
  const runAsNode = process.env['ELECTRON_RUN_AS_NODE']
  const noAttach = process.env['ELECTRON_NO_ATTACH_CONSOLE']

  const mark = randomBytes(6).toString('hex')
  const regex = new RegExp(mark + '({.*})' + mark)

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    VSCODE_RESOLVING_ENVIRONMENT: '1',
  }

  const shell = process.env.SHELL || '/bin/zsh'
  const name = basename(shell)
  const shellArgs = (name === 'tcsh' || name === 'csh') ? ['-ic'] : ['-i', '-l', '-c']
  const command = `'${process.execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...shellArgs, command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })

    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Shell environment resolution timed out after 10s'))
    }, 10000)

    child.on('error', err => { clearTimeout(timeout); reject(err) })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => stdout.push(b))
    child.stderr.on('data', (b: Buffer) => stderr.push(b))

    child.on('close', (code, signal) => {
      clearTimeout(timeout)

      if (code || signal) {
        const errText = Buffer.concat(stderr).toString('utf8').trim()
        reject(new Error(`Shell env spawn exited with code ${code}, signal ${signal}${errText ? `: ${errText}` : ''}`))
        return
      }

      const raw = Buffer.concat(stdout).toString('utf8')
      const match = regex.exec(raw)
      if (!match) {
        reject(new Error('Could not find environment marker in shell output'))
        return
      }

      try {
        const resolved = JSON.parse(match[1]) as NodeJS.ProcessEnv
        if (runAsNode) resolved['ELECTRON_RUN_AS_NODE'] = runAsNode
        else delete resolved['ELECTRON_RUN_AS_NODE']
        if (noAttach) resolved['ELECTRON_NO_ATTACH_CONSOLE'] = noAttach
        else delete resolved['ELECTRON_NO_ATTACH_CONSOLE']
        delete resolved['VSCODE_RESOLVING_ENVIRONMENT']
        resolve(resolved)
      } catch (err) {
        reject(err)
      }
    })
  })
}

export async function initShellEnv(): Promise<void> {
  if (!shellEnvPromise) shellEnvPromise = resolveUnixShellEnv()
  try {
    const resolved = await shellEnvPromise
    Object.assign(process.env, resolved)
    console.log('[shell-env] PATH:', process.env.PATH)
  } catch (err) {
    console.warn('[shell-env] resolution failed, using fallback:', err)
    const fallback = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin']
    process.env.PATH = [...fallback, ...(process.env.PATH || '').split(':')].join(':')
  }
}

interface ProjectSettings {
  defaultRuntime: AgentRuntime
}

function normalizeProjectSettings(raw: unknown): ProjectSettings {
  const settings = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    defaultRuntime: isAgentRuntime(settings.defaultRuntime) ? settings.defaultRuntime : DEFAULT_AGENT_RUNTIME,
  }
}

function resolveBinary(runtime: AgentRuntime): string | null {
  const { binary } = getAgentRuntime(runtime)

  for (const dir of (process.env.PATH || '').split(':')) {
    const candidate = join(dir, binary)
    if (fs.existsSync(candidate)) return candidate
  }

  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const resolved = execFileSync(shell, ['-l', '-c', `which ${binary}`], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    return resolved || null
  } catch {
    return null
  }
}

function isRecordReachable(projectDir: string, rec: ZoneSessionRecord): boolean {
  if (rec.runtime === 'codex' && !isCodexSessionIdForCwd(projectDir, rec.sessionId)) return false
  if (rec.runtime === 'gemini' && !isGeminiSessionIdForCwd(projectDir, rec.sessionId)) return false
  return true
}

// Returns the most recent record matching the runtime whose backing CLI state
// is still on disk. Used for implicit-resume paths (assistant re-open) where
// no explicit user pick is available.
function latestReachableSession(
  projectDir: string,
  zoneKey: string,
  runtime: AgentRuntime,
  legacyKey?: string,
): ZoneSessionRecord | null {
  for (const rec of listZoneSessions(projectDir, zoneKey, legacyKey)) {
    if (rec.runtime !== runtime) continue
    if (!isRecordReachable(projectDir, rec)) continue
    return rec
  }
  return null
}

function pickSession(
  projectDir: string,
  zoneKey: string,
  sessionId: string,
  legacyKey?: string,
): ZoneSessionRecord | null {
  const rec = getZoneSessionRecord(projectDir, zoneKey, sessionId, legacyKey)
  if (!rec) return null
  if (!isRecordReachable(projectDir, rec)) {
    console.warn(`[session-capture] ${zoneKey}: requested session ${sessionId} no longer reachable on disk`)
    return null
  }
  return rec
}

export interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime | 'shell'
}

// Position + dimensions come straight from React Flow nodes.
export interface NodePosition { x: number; y: number }

// A zone node — the agent. Holds all agent config; overlays components spatially.
export interface ZoneGraphNode {
  id: string
  type: 'zone'
  position: NodePosition
  width?: number
  height?: number
  data: {
    label: string
    description: string
    color?: string
    systemPrompt: string
    agentRuntimeMode?: 'inherit' | 'override'
    agentRuntime?: AgentRuntime
    providerModels?: Partial<Record<AgentRuntime, string>>
    model?: string
    skills: Array<{ name: string; path: string; builtin: boolean }>
    tools: Record<string, boolean>
    behavior: { mode: string; retries: number; onFailure: string; timeoutMs: number }
    permissions: Record<string, boolean>
    envVars: Array<{ key: string; value: string }>
  }
}

// A component node — first-class design artifact; may or may not be overlaid by a zone.
export interface ComponentGraphNode {
  id: string
  type: 'component'
  position: NodePosition
  data: {
    label: string
    description?: string
    specs?: string
    category?: string
    tag?: string
  }
}

export type GraphNode = ZoneGraphNode | ComponentGraphNode

// Matches the renderer's COMPONENT_APPROX_W / COMPONENT_APPROX_H — used for bbox math.
const COMPONENT_APPROX_W = 180
const COMPONENT_APPROX_H = 78
const ZONE_DEFAULT_WIDTH = 420
const ZONE_DEFAULT_HEIGHT = 280

export interface GraphEdge {
  id: string
  source: string
  target: string
}

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle state machine (ported from claw-code `WorkerStatus`).
//
//   spawning → ready → running → finished
//                              ↘ failed
//
// Transitions:
//   - spawning → ready:   observe() sees the CLI prompt cue (/[>❯]\s*$/)
//   - ready|finished → running:   sendPrompt() delivers a poke
//   - running → finished: observe() sees ARCHITECT_COMPLETE sentinel
//   - * → failed:         PTY exits before ready / startup timeout fires /
//                         misdelivery retry budget exhausted
// ──────────────────────────────────────────────────────────────────────────

export type ZoneLifecycleState = 'spawning' | 'ready' | 'running' | 'finished' | 'failed'

export type ZoneFailureKind = 'binary-missing' | 'prompt-delivery' | 'startup-timeout' | 'pty-exit'

export interface ZoneFailure {
  kind: ZoneFailureKind
  message: string
  ts: number
}

export interface ZoneEvent {
  seq: number
  kind: string            // 'spawn' | 'ready' | 'send-prompt' | 'complete' | 'fail' | …
  state: ZoneLifecycleState
  message?: string
  ts: number
}

interface Session {
  pty: pty.IPty
  // Rendered-screen emulator. Every PTY chunk is fed into it so cue
  // detection operates on the visible screen grid (ANSI already interpreted),
  // not raw bytes. The renderer still gets the raw stream over
  // `terminal:data`.
  term: HeadlessTerminal
  lifecycle: ZoneLifecycleState
  events: ZoneEvent[]
  eventSeq: number
  // 'agent' sessions run the full observe/startup-timeout pipeline; 'shell'
  // sessions are plain and bypass it (no sentinel, no cue detection).
  kind: 'agent' | 'shell'
  runtime: AgentRuntime | 'shell'
  // Round-aware state for the current poke.
  lastPoke?: string
  currentTaskId: string | null
  promptAttempts: number
  misdeliveryReplayed: boolean
  createdAt: number
  lastError?: ZoneFailure
  doneCallbacks: (() => void)[]
  readyCallbacks: (() => void)[]
  ackCallbacks: Array<(taskId: string) => void>
  startupTimer?: NodeJS.Timeout
}

const STARTUP_TIMEOUT_MS = 30_000
// Ported from claw-code's detect_ready_for_prompt (worker_boot.rs:830). TUI
// CLIs render their prompt inside a bordered box (Claude Code, Codex, Gemini,
// opencode), so the bottom non-empty line is typically the box border, not the
// prompt glyph itself. Matching has to look for box-enclosed prompts + common
// "ready for input" strings, and must reject bare shell prompts.
const READY_TEXT_NEEDLES = [
  'ready for input',
  'ready for your input',
  'ready for prompt',
  'send a message',
  'type a message',
]

function generateTaskId(): string {
  return randomBytes(8).toString('hex')
}

// Walks the active buffer (scrollback + viewport) and returns the rendered
// screen as plain text — ANSI escapes already interpreted by the emulator.
function renderScreenText(term: HeadlessTerminal): string {
  const buf = term.buffer.active
  const lines: string[] = []
  const top = Math.max(0, buf.baseY - 200) // keep a reasonable window
  const bottom = buf.baseY + term.rows
  for (let y = top; y < bottom; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    lines.push(line.translateToString(true))
  }
  return lines.join('\n')
}

function lastNonEmptyLine(rendered: string): string {
  const lines = rendered.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed) return trimmed
  }
  return ''
}

function isShellPrompt(trimmed: string): boolean {
  return (
    trimmed.endsWith('$') ||
    trimmed.endsWith('%') ||
    trimmed.endsWith('#') ||
    trimmed.startsWith('$ ') ||
    trimmed.startsWith('% ') ||
    trimmed.startsWith('# ')
  )
}

function looksLikePromptReady(rendered: string): boolean {
  const lowered = rendered.toLowerCase()
  for (const needle of READY_TEXT_NEEDLES) {
    if (lowered.includes(needle)) return true
  }

  // Scan the last ~10 non-empty lines — TUI CLIs render footer hints /
  // status bars below the input row, so the input cue is rarely the very
  // bottom line.
  const lines = rendered.split('\n')
  let scanned = 0
  for (let i = lines.length - 1; i >= 0 && scanned < 10; i--) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    scanned += 1
    if (isShellPrompt(trimmed)) continue

    if (
      trimmed === '>' ||
      trimmed === '›' ||
      trimmed === '❯' ||
      trimmed.startsWith('> ') ||
      trimmed.startsWith('› ') ||
      trimmed.startsWith('❯ ') ||
      trimmed.startsWith('>>>') ||
      // Box-drawn TUI prompts (Claude Code, Codex, Gemini). The input row
      // looks like `│ > ` or `│ › ` inside a bordered rectangle.
      trimmed.includes('│ >') ||
      trimmed.includes('│ ›') ||
      trimmed.includes('│ ❯')
    ) {
      return true
    }
  }
  return false
}

interface SpawnAgentOptions {
  win: BrowserWindow
  id: string
  label: string
  runtime: AgentRuntime
  env: Record<string, string>
  cwd: string
  initialPrompt?: string
  model?: string
  onExit?: () => void
  resumeSessionId?: string
  // When set, capture the new session ID after spawn and append it to the
  // zone's history. Every fresh spawn becomes a distinct record; user picks
  // which one to resume from the zone launcher. summary is the one-liner
  // shown in that list; dispatchId links zones spawned by a dispatch to the
  // orchestrating Architect session.
  capture?: {
    projectDir: string
    zoneKey: string
    legacyKey?: string
    summary: string
    dispatchId?: string
  }
  // Defaults to true (preserves zone-agent autonomy). Set false for the
  // interactive assistant so the user gets normal permission prompts.
  skipPermissions?: boolean
  // When set, Claude will start with `--permission-mode plan` instead of
  // `--dangerously-skip-permissions`.
  planMode?: boolean
  // When set and spawning a fresh Claude session (no resume), pass as
  // `--append-system-prompt` so the zone's behavior prompt is baked in.
  appendSystemPrompt?: string
  // When set and resuming, write this prompt into the PTY ~1.5s after spawn
  // so Claude takes it as the next user turn.
  resumeUserPrompt?: string
  // Optional callback fired once a session ID is captured.
  onSessionCaptured?: (sessionId: string) => void
}

const sessions = new Map<string, Session>()
let activeWatcher: fs.FSWatcher | null = null
let activeDispatchCoordinator: { stop: () => void } | null = null

// Per-session capture readiness. 'pending' means a fresh spawn is still polling
// for its new CLI session id; 'ready' means capture settled (resolved or timed
// out). Used by the renderer's close-terminal flow to block close until the
// id has been persisted. Shell and resumed sessions are never added here —
// absence means "no capture in flight, close is safe."
type CaptureState = 'pending' | 'ready'
const captureStates = new Map<string, CaptureState>()
const captureWaiters = new Map<string, (() => void)[]>()

function setCaptureReady(id: string): void {
  captureStates.set(id, 'ready')
  const waiters = captureWaiters.get(id)
  if (waiters) {
    captureWaiters.delete(id)
    for (const fn of waiters) fn()
  }
}

export function getCaptureState(id: string): CaptureState | null {
  return captureStates.get(id) ?? null
}

const SHELL_ID_PREFIX = 'shell-'

// Send to every live BrowserWindow so popout windows receive the same stream.
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function buildRuntimeArgs(
  runtime: AgentRuntime,
  prompt?: string,
  model?: string,
  resumeSessionId?: string,
  skipPermissions = true,
  planMode = false,
  appendSystemPrompt?: string,
): string[] {
  switch (runtime) {
    case 'claude': {
      const args: string[] = []
      if (planMode) args.push('--permission-mode', 'plan')
      else if (skipPermissions) args.push('--dangerously-skip-permissions')
      if (resumeSessionId) args.push('--resume', resumeSessionId)
      if (model) args.push('--model', model)
      if (appendSystemPrompt && !resumeSessionId) args.push('--append-system-prompt', appendSystemPrompt)
      // On resume, history already contains the prompt — don't replay it.
      if (prompt && !resumeSessionId) args.push(prompt)
      return args
    }
    case 'codex': {
      // `codex resume <UUID>` is a subcommand, not a flag. The standard
      // operating flags (--no-alt-screen, -a, -s, -m) are also accepted
      // under `resume`, so we keep them for both modes. On resume the prior
      // conversation is replayed, so don't push the prompt as a positional.
      const args: string[] = []
      if (resumeSessionId) args.push('resume', resumeSessionId)
      args.push('--no-alt-screen', '-a', 'never', '-s', 'workspace-write')
      if (model) args.push('--model', model)
      if (prompt && !resumeSessionId) args.push(prompt)
      return args
    }
    case 'gemini': {
      const args: string[] = ['--approval-mode', 'yolo']
      if (resumeSessionId) args.push('--resume', resumeSessionId)
      if (model) args.push('--model', model)
      if (prompt && !resumeSessionId) args.push('--prompt-interactive', prompt)
      return args
    }
    case 'opencode': {
      // Per upstream docs / issue #11680, the documented session-resume
      // syntax pairs `--continue --session <id>`. `--session` alone is
      // unreliable in TUI mode in current versions.
      const args: string[] = []
      if (resumeSessionId) args.push('--continue', '--session', resumeSessionId)
      if (prompt && !resumeSessionId) args.push('--prompt', prompt)
      if (model) args.push('--model', model)
      return args
    }
  }
}

function pushEvent(
  session: Session,
  kind: string,
  message?: string,
): void {
  session.eventSeq += 1
  session.events.push({
    seq: session.eventSeq,
    kind,
    state: session.lifecycle,
    message,
    ts: Date.now(),
  })
  // Cap the log; state-timeline UI only needs recent history.
  if (session.events.length > 200) session.events.splice(0, session.events.length - 200)
}

function setLifecycle(
  id: string,
  session: Session,
  next: ZoneLifecycleState,
  kind: string,
  message?: string,
): void {
  if (session.lifecycle === next) return
  session.lifecycle = next
  pushEvent(session, kind, message)
  broadcast('terminal:status', {
    id,
    status: next,
    lastError: session.lastError ?? null,
  })
}

function failSession(
  id: string,
  session: Session,
  kind: ZoneFailureKind,
  message: string,
): void {
  if (session.lifecycle === 'failed') return
  session.lastError = { kind, message, ts: Date.now() }
  setLifecycle(id, session, 'failed', 'fail', `${kind}: ${message}`)
  if (session.startupTimer) {
    clearTimeout(session.startupTimer)
    session.startupTimer = undefined
  }
  // Unblock any awaiters so they don't hang forever.
  session.readyCallbacks.splice(0).forEach(cb => cb())
}

// Observe-on-every-chunk dispatcher. Runs after each PTY chunk has been
// written into the headless Terminal, so cue detection operates on the
// rendered screen grid (ANSI already interpreted) rather than raw bytes.
function observeZoneOutput(id: string): void {
  const session = sessions.get(id)
  if (!session || session.kind !== 'agent') return

  const rendered = renderScreenText(session.term)

  // spawning → ready: bottom non-empty line looks like a CLI prompt.
  if (session.lifecycle === 'spawning' && looksLikePromptReady(rendered)) {
    if (session.startupTimer) {
      clearTimeout(session.startupTimer)
      session.startupTimer = undefined
    }
    setLifecycle(id, session, 'ready', 'ready', 'CLI prompt detected')
    session.readyCallbacks.splice(0).forEach(cb => cb())
    return
  }

  // running → ack: zone echoed ARCHITECT_TASK_ACK <task_id>.
  if (session.lifecycle === 'running' && session.currentTaskId) {
    const ackRe = new RegExp(
      `ARCHITECT_TASK_ACK\\s+${session.currentTaskId}\\b`,
    )
    if (ackRe.test(rendered)) {
      const taskId = session.currentTaskId
      // Stay in 'running' at the PTY-lifecycle layer; the ack only flips
      // status.json to state='ack'. Completion still fires on the receipt
      // file or ARCHITECT_COMPLETE.
      pushEvent(session, 'ack', `ARCHITECT_TASK_ACK ${taskId}`)
      const cbs = session.ackCallbacks.splice(0)
      for (const cb of cbs) cb(taskId)
    }
  }

  // running → finished: ARCHITECT_COMPLETE seen. Prefer the tagged form
  // (`ARCHITECT_COMPLETE <task_id>`) but fall back to the bare sentinel so
  // older zone conversations still reach the done signal.
  if (session.lifecycle === 'running') {
    const tagged = session.currentTaskId
      ? new RegExp(`ARCHITECT_COMPLETE\\s+${session.currentTaskId}\\b`)
      : null
    if ((tagged && tagged.test(rendered)) || rendered.includes('ARCHITECT_COMPLETE')) {
      setLifecycle(id, session, 'finished', 'complete', 'ARCHITECT_COMPLETE observed')
      session.doneCallbacks.splice(0).forEach(cb => cb())
      return
    }
  }
}

function createSession(
  win: BrowserWindow,
  id: string,
  ptyProcess: pty.IPty,
  onExit?: () => void,
  opts?: { kind?: 'agent' | 'shell'; runtime?: AgentRuntime | 'shell' },
): void {
  const kind = opts?.kind ?? 'agent'
  const runtime = opts?.runtime ?? 'shell'
  const term = new HeadlessTerminal({
    cols: 220,
    rows: 50,
    allowProposedApi: true,
    scrollback: 500,
  })
  const session: Session = {
    pty: ptyProcess,
    term,
    lifecycle: 'spawning',
    events: [],
    eventSeq: 0,
    kind,
    runtime,
    currentTaskId: null,
    promptAttempts: 0,
    misdeliveryReplayed: false,
    createdAt: Date.now(),
    doneCallbacks: [],
    readyCallbacks: [],
    ackCallbacks: [],
  }
  sessions.set(id, session)
  pushEvent(session, 'spawn', `pty spawned (${runtime})`)

  // Agent sessions get a startup-timeout safety net. If the CLI is still in
  // `spawning` after STARTUP_TIMEOUT_MS, optimistically transition to `ready`
  // so unknown TUIs (whose prompt cues we haven't characterized) don't
  // hard-fail. The coordinator will still surface real failures — if the
  // poke doesn't land, `delivery-failed` fires via the ack timeout; if the
  // PTY actually died, `onExit` fires and marks `pty-exit`.
  if (kind === 'agent') {
    session.startupTimer = setTimeout(() => {
      const live = sessions.get(id)
      if (!live || live !== session) return
      if (live.lifecycle !== 'spawning') return
      console.warn(
        `[registry] ${id}: no prompt cue seen within ${STARTUP_TIMEOUT_MS}ms — marking ready optimistically`,
      )
      setLifecycle(id, live, 'ready', 'ready', 'startup-timeout fallback (cue not matched)')
      live.readyCallbacks.splice(0).forEach(cb => cb())
    }, STARTUP_TIMEOUT_MS)
  }

  ptyProcess.onData(data => {
    // Always broadcast the raw stream so the renderer's xterm instance
    // sees the exact same bytes. Agent sessions additionally feed the
    // headless emulator so cue detection can run on the rendered grid.
    broadcast('terminal:data', { id, data })
    if (kind === 'agent') {
      try {
        term.write(data, () => observeZoneOutput(id))
      } catch (err) {
        console.error(`[registry] term.write failed on ${id}`, err)
      }
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    broadcast('terminal:exit', { id, exitCode })
    // Identity-check: a resume may have already replaced this entry.
    if (sessions.get(id) === session) {
      // If we exited before ever reaching ready (typical for a missing binary
      // or immediate crash), classify. Non-zero exit on an agent session also
      // counts as a failure. Skip if already failed / finished.
      if (kind === 'agent' && session.lifecycle !== 'finished' && session.lifecycle !== 'failed') {
        const kindCode: ZoneFailureKind = session.lifecycle === 'spawning'
          ? 'pty-exit'
          : 'pty-exit'
        failSession(id, session, kindCode, `PTY exited with code ${exitCode ?? 0}`)
      }
      if (session.startupTimer) {
        clearTimeout(session.startupTimer)
        session.startupTimer = undefined
      }
      try { session.term.dispose() } catch {}
      sessions.delete(id)
    }
    onExit?.()
  })
}

// Registry facade: body-then-CR split write (preserves bracketed-paste
// semantics for Ink CLIs — see memory/feedback_pty_paste_submit.md). Transitions
// the session to 'running' and records the poke. Idempotent-safe: callers can
// call this on a 'finished' session to kick off a new round.
function sendPrompt(id: string, body: string): boolean {
  const session = sessions.get(id)
  if (!session) {
    console.warn(`[registry] no live session ${id}; cannot send prompt`)
    return false
  }
  if (session.kind !== 'agent') {
    console.warn(`[registry] session ${id} is not an agent; cannot send prompt`)
    return false
  }
  if (session.lifecycle === 'failed') {
    console.warn(`[registry] session ${id} is failed; cannot send prompt`)
    return false
  }
  session.lastPoke = body
  session.promptAttempts += 1
  session.misdeliveryReplayed = false
  // Reset emulator so stale `ARCHITECT_TASK_ACK` / `ARCHITECT_COMPLETE`
  // text from the previous round can't re-trigger the current round.
  try { session.term.clear() } catch {}
  setLifecycle(id, session, 'running', 'send-prompt', `attempt ${session.promptAttempts}`)
  try {
    session.pty.write(body)
  } catch (err) {
    console.error(`[registry] failed to write poke body to ${id}`, err)
    failSession(id, session, 'prompt-delivery', `pty.write body failed: ${String(err)}`)
    return false
  }
  // Separate CR write, delayed to sidestep bracketed-paste detection where
  // body+CR in one chunk is absorbed into a paste buffer instead of submitted.
  setTimeout(() => {
    const live = sessions.get(id)
    if (!live || live !== session) return
    try { live.pty.write('\r') } catch (err) {
      console.error(`[registry] failed to send CR to ${id}`, err)
    }
  }, 250)
  return true
}

// Resolves when the session is `ready`, or rejects on timeout / failure.
// Coordinator `await_ready` gate — blocks first-round poke until the CLI
// actually shows its prompt.
function awaitReady(id: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const session = sessions.get(id)
    if (!session) return reject(new Error(`no session ${id}`))
    if (session.lifecycle === 'ready' || session.lifecycle === 'running' || session.lifecycle === 'finished') {
      return resolve()
    }
    if (session.lifecycle === 'failed') {
      return reject(new Error(`session ${id} failed: ${session.lastError?.message ?? 'unknown'}`))
    }
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`awaitReady timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    session.readyCallbacks.push(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      const live = sessions.get(id)
      if (!live || live.lifecycle === 'failed') {
        reject(new Error(`session ${id} failed while awaiting ready`))
      } else {
        resolve()
      }
    })
  })
}

// Resolves with the task id when the zone echoes ARCHITECT_TASK_ACK <task_id>,
// or rejects on timeout / session failure. The ack must carry the current
// task id — stale acks from a prior round can't satisfy a fresh wait.
function awaitAck(id: string, taskId: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const session = sessions.get(id)
    if (!session) return reject(new Error(`no session ${id}`))
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`awaitAck timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    session.ackCallbacks.push(observedTaskId => {
      if (done) return
      if (observedTaskId !== taskId) return
      done = true
      clearTimeout(timer)
      resolve(observedTaskId)
    })
  })
}

function setCurrentTaskId(id: string, taskId: string | null): void {
  const session = sessions.get(id)
  if (session) session.currentTaskId = taskId
}

function spawnErrorSession(
  win: BrowserWindow,
  id: string,
  label: string,
  runtime: AgentRuntime,
  cwd: string,
  message: string,
  onExit?: () => void
): TerminalInfo {
  const shell = process.env.SHELL || '/bin/zsh'
  const ptyProcess = pty.spawn(shell, ['-lc', `echo ${JSON.stringify(message)}; exit 127`], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd,
    env: process.env as Record<string, string>,
  })

  createSession(win, id, ptyProcess, onExit, { kind: 'agent', runtime })
  // Immediately classify — the shell will exit 127 before observe can fire
  // the ready cue. Surfaces as `binary-missing` in the UI instead of the
  // generic `pty-exit`.
  const session = sessions.get(id)
  if (session) failSession(id, session, 'binary-missing', message)
  return { id, label, runtime }
}

function spawnAgentSession({
  win,
  id,
  label,
  runtime,
  env,
  cwd,
  initialPrompt,
  model,
  onExit,
  resumeSessionId,
  capture,
  skipPermissions = true,
  planMode = false,
  appendSystemPrompt,
  resumeUserPrompt,
  onSessionCaptured,
}: SpawnAgentOptions): TerminalInfo {
  // Reset any capture state from a prior spawn at this id (e.g. resume replacing
  // a fresh session). captureRuntime below will re-mark 'pending' if needed.
  captureStates.delete(id)
  captureWaiters.delete(id)

  const bin = resolveBinary(runtime)
  if (!bin) {
    return spawnErrorSession(
      win,
      id,
      label,
      runtime,
      cwd,
      `Architect could not find the ${getAgentRuntime(runtime).label} binary (${getAgentRuntime(runtime).binary}) on PATH.`,
      onExit,
    )
  }

  // Decide whether to capture a session ID for this spawn. Every fresh spawn
  // appends a new entry to the zone's session history — users pick which to
  // resume from the launcher. Resumes don't capture (they're continuing the
  // existing conversation, not starting a new one). Snapshot must happen
  // BEFORE spawn so the new session can be identified.
  const captureRuntime: 'claude' | 'codex' | 'gemini' | 'opencode' | null =
    capture && !resumeSessionId && (runtime === 'claude' || runtime === 'codex' || runtime === 'gemini' || runtime === 'opencode')
      ? runtime
      : null

  let claudeSnapshot: Set<string> | null = null
  let codexSnapshot: Set<string> | null = null
  let geminiSnapshot: Set<string> | null = null
  let opencodeSnapshotPromise: Promise<Set<string>> | null = null

  if (captureRuntime) {
    if (captureRuntime === 'claude') claudeSnapshot = snapshotClaudeSessions(cwd)
    else if (captureRuntime === 'codex') codexSnapshot = snapshotCodexSessions(cwd)
    else if (captureRuntime === 'gemini') geminiSnapshot = snapshotGeminiSessions(cwd)
    else if (captureRuntime === 'opencode') opencodeSnapshotPromise = snapshotOpencodeSessions()
  }

  const spawnArgs = buildRuntimeArgs(runtime, initialPrompt, model, resumeSessionId, skipPermissions, planMode, appendSystemPrompt)
  console.log(`[spawn] ${runtime} (zone=${id}) cwd=${cwd} cmd=${bin} args=${JSON.stringify(spawnArgs)}${resumeSessionId ? ' [RESUME]' : ''}`)
  const ptyProcess = pty.spawn(bin, spawnArgs, {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
  })

  createSession(win, id, ptyProcess, onExit, { kind: 'agent', runtime })

  if (resumeUserPrompt && resumeSessionId) {
    setTimeout(() => {
      try { ptyProcess.write(resumeUserPrompt + '\r') } catch {}
    }, 1500)
  }

  if (captureRuntime && capture) {
    captureStates.set(id, 'pending')
    broadcast('terminal:capture-state', { id, state: 'pending' })

    const persistAndBroadcast = (sessionId: string): void => {
      try {
        appendZoneSession(capture.projectDir, capture.zoneKey, {
          runtime: captureRuntime,
          sessionId,
          capturedAt: new Date().toISOString(),
          summary: capture.summary,
          dispatchId: capture.dispatchId,
        })
        console.log(`[session-capture] ${capture.zoneKey}: appended ${captureRuntime} session ${sessionId}`)
        broadcast('zone:session-captured', {
          zoneKey: capture.zoneKey,
          zoneId: id,
          sessionId,
          runtime: captureRuntime,
          summary: capture.summary,
          dispatchId: capture.dispatchId,
        })
        onSessionCaptured?.(sessionId)
      } catch (err) {
        console.error(`[session-capture] ${capture.zoneKey}: failed to save`, err)
      }
    }

    const markReady = (): void => {
      setCaptureReady(id)
      broadcast('terminal:capture-state', { id, state: 'ready' })
    }

    if (claudeSnapshot) {
      console.log(`[session-capture] ${capture.zoneKey}: claude snapshot ${claudeSnapshot.size} existing, polling…`)
      void captureNewClaudeSession(cwd, claudeSnapshot).then(sessionId => {
        if (!sessionId) {
          console.warn(`[session-capture] ${capture.zoneKey}: timed out without seeing a new .jsonl in ~/.claude/projects/${cwd.replace(/[^A-Za-z0-9_-]/g, '-')}/`)
        } else {
          persistAndBroadcast(sessionId)
        }
        markReady()
      })
    } else if (codexSnapshot) {
      console.log(`[session-capture] ${capture.zoneKey}: codex snapshot ${codexSnapshot.size} existing, polling…`)
      void captureNewCodexSession(cwd, codexSnapshot).then(sessionId => {
        if (!sessionId) {
          console.warn(`[session-capture] ${capture.zoneKey}: timed out without seeing a new codex rollout for cwd ${cwd}`)
        } else {
          persistAndBroadcast(sessionId)
        }
        markReady()
      })
    } else if (geminiSnapshot) {
      console.log(`[session-capture] ${capture.zoneKey}: gemini snapshot ${geminiSnapshot.size} existing, polling…`)
      void captureNewGeminiSession(cwd, geminiSnapshot).then(sessionId => {
        if (!sessionId) {
          console.warn(`[session-capture] ${capture.zoneKey}: timed out without seeing a new gemini session for cwd ${cwd}`)
        } else {
          persistAndBroadcast(sessionId)
        }
        markReady()
      })
    } else if (opencodeSnapshotPromise) {
      void opencodeSnapshotPromise.then(snapshot => {
        console.log(`[session-capture] ${capture.zoneKey}: opencode snapshot ${snapshot.size} existing, polling…`)
        return captureNewOpencodeSession(snapshot)
      }).then(sessionId => {
        if (!sessionId) {
          console.warn(`[session-capture] ${capture.zoneKey}: timed out without seeing a new opencode session`)
        } else {
          persistAndBroadcast(sessionId)
        }
        markReady()
      })
    } else {
      // No snapshot path fired — nothing to capture.
      markReady()
    }
  }

  return { id, label, runtime }
}

export function spawnShellSession(win: BrowserWindow, cwd: string): TerminalInfo {
  const existing = Array.from(sessions.keys()).find(k => k.startsWith(SHELL_ID_PREFIX) && k.endsWith(`-${hashCwd(cwd)}`))
  if (existing) {
    return { id: existing, label: 'Shell', runtime: 'shell' }
  }

  const id = `${SHELL_ID_PREFIX}${Date.now()}-${hashCwd(cwd)}`
  const shell = process.env.SHELL || '/bin/zsh'
  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd,
    env: process.env as Record<string, string>,
  })

  createSession(win, id, ptyProcess, undefined, { kind: 'shell', runtime: 'shell' })
  return { id, label: 'Shell', runtime: 'shell' }
}

function hashCwd(cwd: string): string {
  let h = 0
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

export function writeToTerminal(id: string, data: string) {
  sessions.get(id)?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const session = sessions.get(id)
  if (!session) return
  try { session.pty.resize(cols, rows) } catch {}
  try { session.term.resize(cols, rows) } catch {}
}

function onSessionDone(id: string, cb: () => void) {
  const session = sessions.get(id)
  if (!session) return
  if (session.lifecycle === 'finished') {
    cb()
    return
  }
  session.doneCallbacks.push(cb)
}

// Kills agent and assistant sessions; preserves user shell sessions.
export function killAll() {
  activeWatcher?.close()
  activeWatcher = null
  activeDispatchCoordinator?.stop()
  activeDispatchCoordinator = null
  for (const [id, session] of sessions) {
    if (id.startsWith(SHELL_ID_PREFIX)) continue
    if (session.startupTimer) {
      clearTimeout(session.startupTimer)
      session.startupTimer = undefined
    }
    try { session.pty.kill() } catch {}
    try { session.term.dispose() } catch {}
    sessions.delete(id)
    captureStates.delete(id)
    captureWaiters.delete(id)
  }
}

// Closes a single terminal. Close is always immediate — the PTY is killed
// even if session-id capture is still in flight. The background poll keeps
// running; if the CLI already wrote a session file (i.e. the user sent at
// least one prompt), persistence still happens. If nothing was prompted,
// polling times out quietly and no history entry is written.
export function closeTerminal(id: string): { ok: boolean; reason?: string } {
  const session = sessions.get(id)
  const state = captureStates.get(id)

  if (session) {
    try { session.pty.kill() } catch {}
    try { session.term.dispose() } catch {}
    sessions.delete(id)
  }
  // Only clear capture bookkeeping if capture already settled. While still
  // 'pending', leave the entries so the in-flight poll's persistAndBroadcast
  // / markReady callbacks remain valid.
  if (state !== 'pending') {
    captureStates.delete(id)
    captureWaiters.delete(id)
  }
  return { ok: true }
}

function sanitize(label: string) {
  return label.replace(/[^a-zA-Z0-9-_]/g, '-')
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatch protocol v3: per-zone status.json in ARCHITECT/status/<safe>.json
//
//   { round, state, taskId, lastTaskHash,
//     startedAt, acknowledgedAt, lastActivityAt, completedAt,
//     blocker: { kind, message, since } | null,
//     receipt: { result, summary, durationMs } | null }
//
// Ownership:
//   - main process writes status/<safe>.json on every state transition
//   - Architect READS status/ to know a zone's current state (jq recipe)
//   - Architect WRITES tasks/<safe>.md to dispatch work; main watches that
//     directory and pokes the zone's PTY when content changes
//   - Zones WRITE outputs/<safe>.receipt.json with the round's result,
//     which the main process watches to flip state → done/blocked
// ──────────────────────────────────────────────────────────────────────────

type ZoneRunState = 'idle' | 'running' | 'ack' | 'done' | 'blocked' | 'failed'

type BlockerKind =
  | 'delivery-failed'
  | 'idle-stuck'
  | 'task-timeout'
  | 'pty-exit'
  | 'malformed-completion'
  | 'zone-reported'

interface ZoneBlocker {
  kind: BlockerKind
  message: string
  since: string
}

interface ZoneReceipt {
  result: 'success' | 'blocked' | 'failed'
  summary: string
  durationMs: number
}

interface ZoneStatus {
  round: number
  state: ZoneRunState
  taskId: string | null
  lastTaskHash: string | null
  startedAt: string | null
  acknowledgedAt: string | null
  lastActivityAt: string | null
  completedAt: string | null
  blocker: ZoneBlocker | null
  receipt: ZoneReceipt | null
}

function statusFilePath(projectDir: string, safe: string): string {
  return join(projectDir, 'ARCHITECT', 'status', `${safe}.json`)
}

function isZoneRunState(value: unknown): value is ZoneRunState {
  return value === 'idle' || value === 'running' || value === 'ack' ||
    value === 'done' || value === 'blocked' || value === 'failed'
}

function readStatus(projectDir: string, safe: string): ZoneStatus | null {
  try {
    const raw = fs.readFileSync(statusFilePath(projectDir, safe), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ZoneStatus>
    return {
      round: typeof parsed.round === 'number' ? parsed.round : 0,
      state: isZoneRunState(parsed.state) ? parsed.state : 'idle',
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
      lastTaskHash: typeof parsed.lastTaskHash === 'string' ? parsed.lastTaskHash : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      acknowledgedAt: typeof parsed.acknowledgedAt === 'string' ? parsed.acknowledgedAt : null,
      lastActivityAt: typeof parsed.lastActivityAt === 'string' ? parsed.lastActivityAt : null,
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : null,
      blocker: parsed.blocker && typeof parsed.blocker === 'object' ? parsed.blocker as ZoneBlocker : null,
      receipt: parsed.receipt && typeof parsed.receipt === 'object' ? parsed.receipt as ZoneReceipt : null,
    }
  } catch { return null }
}

function writeStatus(projectDir: string, safe: string, status: ZoneStatus): void {
  try {
    const file = statusFilePath(projectDir, safe)
    fs.mkdirSync(join(projectDir, 'ARCHITECT', 'status'), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(status, null, 2))
  } catch (err) {
    console.error(`[status] failed to write for ${safe}`, err)
  }
}

function initStatus(projectDir: string, safe: string): void {
  writeStatus(projectDir, safe, {
    round: 0,
    state: 'idle',
    taskId: null,
    lastTaskHash: null,
    startedAt: null,
    acknowledgedAt: null,
    lastActivityAt: null,
    completedAt: null,
    blocker: null,
    receipt: null,
  })
}

function markRunning(projectDir: string, safe: string, hash: string, taskId: string): void {
  const prev = readStatus(projectDir, safe)
  writeStatus(projectDir, safe, {
    round: (prev?.round ?? 0) + 1,
    state: 'running',
    taskId,
    lastTaskHash: hash,
    startedAt: new Date().toISOString(),
    acknowledgedAt: null,
    lastActivityAt: null,
    completedAt: null,
    blocker: null,
    receipt: null,
  })
}

function markAck(projectDir: string, safe: string): void {
  const prev = readStatus(projectDir, safe)
  if (!prev) return
  writeStatus(projectDir, safe, {
    ...prev,
    state: 'ack',
    acknowledgedAt: prev.acknowledgedAt ?? new Date().toISOString(),
  })
}

function markActivity(projectDir: string, safe: string, iso: string): void {
  const prev = readStatus(projectDir, safe)
  if (!prev) return
  if (prev.lastActivityAt === iso) return
  writeStatus(projectDir, safe, { ...prev, lastActivityAt: iso })
}

function markDoneWithReceipt(projectDir: string, safe: string, receipt: ZoneReceipt): void {
  const prev = readStatus(projectDir, safe)
  if (!prev) return
  writeStatus(projectDir, safe, {
    ...prev,
    state: receipt.result === 'success' ? 'done' : 'blocked',
    completedAt: new Date().toISOString(),
    receipt,
    blocker: receipt.result === 'success' ? null : {
      kind: 'zone-reported',
      message: receipt.summary,
      since: new Date().toISOString(),
    },
  })
}

function markBlocked(projectDir: string, safe: string, blocker: ZoneBlocker): void {
  const prev = readStatus(projectDir, safe)
  if (!prev) return
  writeStatus(projectDir, safe, { ...prev, blocker })
}

function markFailed(projectDir: string, safe: string, blocker: ZoneBlocker): void {
  const prev = readStatus(projectDir, safe)
  if (!prev) return
  writeStatus(projectDir, safe, {
    ...prev,
    state: 'failed',
    completedAt: new Date().toISOString(),
    blocker,
  })
}

function readSkillContent(skillPath: string): string {
  try {
    if (skillPath.startsWith('builtin:')) {
      return fs.readFileSync(join(__dirname, '../../skills', skillPath.replace('builtin:', ''), 'SKILL.md'), 'utf-8').trim()
    }
    if (skillPath.startsWith('custom:')) {
      return fs.readFileSync(skillPath.replace('custom:', ''), 'utf-8').trim()
    }
  } catch {}
  return ''
}

function topoSort(nodes: ZoneGraphNode[], edges: GraphEdge[]): ZoneGraphNode[] {
  const ids = new Set(nodes.map(n => n.id))
  const zoneEdges = edges.filter(e => ids.has(e.source) && ids.has(e.target))
  const inDegree = new Map(nodes.map(node => [node.id, 0]))
  const adj = new Map(nodes.map(node => [node.id, [] as string[]]))

  zoneEdges.forEach(edge => {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    adj.get(edge.source)?.push(edge.target)
  })

  const queue = nodes.filter(node => inDegree.get(node.id) === 0)
  const result: ZoneGraphNode[] = []

  while (queue.length) {
    const node = queue.shift()!
    result.push(node)

    for (const nextId of adj.get(node.id) ?? []) {
      const degree = (inDegree.get(nextId) ?? 1) - 1
      inDegree.set(nextId, degree)
      if (degree === 0) queue.push(nodes.find(candidate => candidate.id === nextId)!)
    }
  }

  nodes.forEach(node => {
    if (!result.find(candidate => candidate.id === node.id)) result.push(node)
  })

  return result
}

function getZoneRuntime(zone: ZoneGraphNode, settings: ProjectSettings): AgentRuntime {
  return isAgentRuntimeMode(zone.data.agentRuntimeMode)
    && zone.data.agentRuntimeMode === 'override'
    && isAgentRuntime(zone.data.agentRuntime)
    ? zone.data.agentRuntime
    : settings.defaultRuntime
}

function getZoneModel(zone: ZoneGraphNode, runtime: AgentRuntime): string {
  return zone.data.providerModels?.[runtime] || zone.data.model || DEFAULT_MODEL_BY_RUNTIME[runtime]
}

interface ZoneIndex {
  zones: ZoneGraphNode[]
  componentsByZone: Map<string, ComponentGraphNode[]>
  unassignedComponents: ComponentGraphNode[]
}

// Overlay semantics: a component belongs to the smallest zone whose bbox contains its center.
// Smallest = lowest area — resolves ambiguity when zones overlap (inner-most wins).
function indexGraph(nodes: GraphNode[]): ZoneIndex {
  const zones: ZoneGraphNode[] = []
  const components: ComponentGraphNode[] = []
  const componentsByZone = new Map<string, ComponentGraphNode[]>()
  const unassignedComponents: ComponentGraphNode[] = []

  for (const node of nodes) {
    if (node.type === 'zone') {
      zones.push(node)
      componentsByZone.set(node.id, [])
    } else {
      components.push(node)
    }
  }

  for (const comp of components) {
    const cx = comp.position.x + COMPONENT_APPROX_W / 2
    const cy = comp.position.y + COMPONENT_APPROX_H / 2
    let best: ZoneGraphNode | null = null
    let bestArea = Infinity
    for (const zone of zones) {
      const w = zone.width ?? ZONE_DEFAULT_WIDTH
      const h = zone.height ?? ZONE_DEFAULT_HEIGHT
      const x0 = zone.position.x
      const y0 = zone.position.y
      const inside = cx >= x0 && cx <= x0 + w && cy >= y0 && cy <= y0 + h
      if (!inside) continue
      const area = w * h
      if (area < bestArea) { best = zone; bestArea = area }
    }
    if (best) componentsByZone.get(best.id)!.push(comp)
    else unassignedComponents.push(comp)
  }

  return { zones, componentsByZone, unassignedComponents }
}

function buildMermaidDiagram(zones: ZoneGraphNode[], componentsByZone: Map<string, ComponentGraphNode[]>, zoneEdges: GraphEdge[]): string {
  const lines: string[] = ['```mermaid', 'graph TD']
  for (const zone of zones) {
    lines.push(`  subgraph ${zone.id}["${zone.data.label}"]`)
    const comps = componentsByZone.get(zone.id) ?? []
    for (const comp of comps) {
      lines.push(`    ${comp.id}["${comp.data.label}${comp.data.tag ? ` [${comp.data.tag}]` : ''}"]`)
    }
    lines.push('  end')
  }
  for (const edge of zoneEdges) {
    lines.push(`  ${edge.source} --> ${edge.target}`)
  }
  lines.push('```')
  return lines.join('\n')
}

function buildArchitectureContextBlock(
  allZones: ZoneGraphNode[],
  componentsByZone: Map<string, ComponentGraphNode[]>,
  edges: GraphEdge[],
  currentZoneId: string,
): string {
  const others = allZones.filter(z => z.id !== currentZoneId)
  if (others.length === 0) return ''
  const zoneIds = new Set(allZones.map(z => z.id))
  const zoneEdges = edges.filter(e => zoneIds.has(e.source) && zoneIds.has(e.target))

  const otherLines = others.map(z => {
    const comps = (componentsByZone.get(z.id) ?? [])
      .map(c => c.data.label + (c.data.tag ? ` [${c.data.tag}]` : ''))
    const compPart = comps.length ? ` — components: ${comps.join(', ')}` : ''
    return `- **${z.data.label}**${z.data.description ? `: ${z.data.description}` : ''}${compPart}`
  }).join('\n')

  return `\n\n## Architecture Context (reference)\nThe user's canvas contains other zones beyond yours. They are NOT part of this task — do not touch their files. Listed here only so you understand the surrounding system.\n\n${buildMermaidDiagram(allZones, componentsByZone, zoneEdges)}\n\nOther zones on the canvas:\n${otherLines}\n`
}

function buildArchitectPrompt(
  zones: ZoneGraphNode[],
  componentsByZone: Map<string, ComponentGraphNode[]>,
  unassignedComponents: ComponentGraphNode[],
  edges: GraphEdge[],
  settings: ProjectSettings,
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] },
  userPrompt?: string,
): string {
  const zoneIds = new Set(zones.map(z => z.id))
  const zoneEdges = edges.filter(e => zoneIds.has(e.source) && zoneIds.has(e.target))

  const agentList = zones.map(zone => {
    const upstream = zoneEdges.filter(edge => edge.target === zone.id).map(edge => zones.find(z => z.id === edge.source)?.data.label).filter(Boolean)
    const downstream = zoneEdges.filter(edge => edge.source === zone.id).map(edge => zones.find(z => z.id === edge.target)?.data.label).filter(Boolean)
    const runtime = getZoneRuntime(zone, settings)
    const model = getZoneModel(zone, runtime)
    const comps = componentsByZone.get(zone.id) ?? []
    const componentLines = comps.length
      ? comps.map(c => {
          const head = `  - ${c.data.label}${c.data.tag ? ` [${c.data.tag}]` : ''}${c.data.description ? ` — ${c.data.description}` : ''}`
          const specs = (c.data.specs ?? '').trim()
          return specs ? `${head}\n${specs.split('\n').map(line => `      ${line}`).join('\n')}` : head
        }).join('\n')
      : '  (no components defined — agent works from prompt alone)'

    return [
      `### ${zone.data.label}`,
      zone.data.description ? `Zone description: ${zone.data.description}` : '',
      `Runtime: ${getAgentRuntime(runtime).label}`,
      `Model: ${model}`,
      `Components owned by this zone (reference — do not assume all must change):\n${componentLines}`,
      upstream.length ? `Upstream zones: ${upstream.join(', ')}` : '',
      downstream.length ? `Downstream zones: ${downstream.join(', ')}` : '',
      `Task file (you write): ARCHITECT/tasks/${sanitize(zone.data.label)}.md`,
      `Status file (harness writes): ARCHITECT/status/${sanitize(zone.data.label)}.json`,
      `Output log (zone writes): ARCHITECT/outputs/${sanitize(zone.data.label)}.md`,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  const flowLines = zoneEdges.length
    ? zoneEdges.map(edge => `  ${zones.find(z => z.id === edge.source)?.data.label} → ${zones.find(z => z.id === edge.target)?.data.label}`).join('\n')
    : '  (zones run independently)'

  const unassignedSection = unassignedComponents.length
    ? `\n\n## Unassigned Components (reference only)\nThese components appear on the canvas but are not owned by any zone. They are design-only artifacts; no agent is assigned to them. Mention them only if the user's task directly involves them.\n${unassignedComponents.map(c => `- ${c.data.label}${c.data.tag ? ` [${c.data.tag}]` : ''}${c.data.description ? ` — ${c.data.description}` : ''}`).join('\n')}`
    : ''

  const taskSection = userPrompt && userPrompt.trim()
    ? `## Task (from user)\n${userPrompt.trim()}`
    : `## Task (from user)\n(No task provided. Ask the user for one before writing any task files.)`

  return `You are the Architect agent coordinating a multi-agent system. Every zone below is already running — a separate interactive CLI session sitting idle at its prompt. You dispatch work to a zone by **writing its task file**; the harness watches ARCHITECT/tasks/ and pokes the matching zone's CLI with a pointer to the file as soon as you save it. That is the only dispatch mechanism.

DO NOT use the Task tool or spawn sub-agents. Coordinate exclusively through the filesystem. You are the orchestrator — never hand control back to the user asking them to trigger the zones. You trigger them.

${taskSection}

## Architecture Context (reference)
The user has designed the following system. Use it ONLY to understand where responsibilities live and how zones relate. This is NOT a build list. Do NOT rebuild components that already exist. Do NOT assume every zone needs work — only engage the zones required by the user's task above.

${buildMermaidDiagram(zones, componentsByZone, zoneEdges)}

## Zones available to you
${agentList}

## Inter-zone data flow
${flowLines}${unassignedSection}

## The protocol (one channel, four directories)

- **ARCHITECT/tasks/<safe>.md** — you own. Write a task file to dispatch work. Overwrite to kick off another round on the same zone.
- **ARCHITECT/status/<safe>.json** — the harness owns. The authoritative view of a zone. Shape:
  \`\`\`
  {
    "round": <N>,
    "state": "idle" | "running" | "ack" | "done" | "blocked" | "failed",
    "taskId": <string or null>,
    "lastTaskHash": <sha1>,
    "startedAt": <iso>,          // harness sent the poke
    "acknowledgedAt": <iso>,     // zone echoed ARCHITECT_TASK_ACK
    "lastActivityAt": <iso>,     // most recent mtime on outputs/<safe>.md
    "completedAt": <iso>,
    "blocker": null | {
      "kind": "delivery-failed" | "idle-stuck" | "task-timeout"
            | "pty-exit" | "malformed-completion" | "zone-reported",
      "message": <string>,
      "since": <iso>
    },
    "receipt": null | { "result": "success"|"blocked"|"failed", "summary": <string>, "durationMs": <N> }
  }
  \`\`\`
  A round is fully complete when \`round >= target\` AND \`state == "done"\` AND \`blocker == null\`.
- **ARCHITECT/outputs/<safe>.md** — zones own. Read after a round completes for the zone's narrative summary.
- **ARCHITECT/outputs/<safe>.receipt.<round>.json** — zones wrote, harness archived. Contains the structured result; read it for \`summary\` / \`result\`.

## Your job

1. Read ARCHITECT/manifest.json if you need more detail about any zone.
2. Decompose the user's task into zone-scoped sub-tasks. Write a task file ONLY for zones that actually need to act. Zones without a task file stay idle — that is the correct outcome when the task doesn't touch them.
3. Each task file you write must:
   - Restate the user's goal in terms specific to this zone
   - Name the concrete components, files, or endpoints the zone should touch (reuse existing ones where possible; only create new ones the task demands)
   - Spell out API contracts, schemas, or ports the zone must produce or consume at the seams with other zones
   - Point to upstream output logs the zone should read first (if any)
   - State clear acceptance criteria
4. Write task files in dependency order (upstream first) so downstream zones have concrete interfaces when they start.
5. Write your coordination log to ARCHITECT/outputs/Architect.md summarizing which zones you engaged and why the others were skipped.
6. **Supervise until every engaged zone finishes the current round or reaches a terminal failure.** Note each zone's \`round\` before you overwrite the task file; the harness bumps \`round\` by 1 on each new poke. Poll recipe:

\`\`\`bash
# Fill "engaged" with sanitized labels you dispatched; "target" with the
# round number you're waiting for (1 on first poke; increment on re-poke).
engaged="Zone-A Zone-B"
declare -A target
target[Zone-A]=1
target[Zone-B]=1
while :; do
  missing=""
  for z in $engaged; do
    f="ARCHITECT/status/$z.json"
    r=$(jq -r '.round // 0' "$f" 2>/dev/null)
    s=$(jq -r '.state // "idle"' "$f" 2>/dev/null)
    b=$(jq -r '.blocker.kind // "none"' "$f" 2>/dev/null)
    # Terminal states — stop waiting on this zone this turn.
    if [ "$s" = "done" ] && [ "$r" -ge "\${target[$z]}" ]; then continue; fi
    if [ "$s" = "blocked" ] || [ "$s" = "failed" ] || [ "$b" != "none" ]; then continue; fi
    missing="$missing $z"
  done
  [ -z "$missing" ] && break
  sleep 5
done
# After the loop, inspect every engaged zone's blocker before drawing conclusions.
\`\`\`

## Blocker handling (important)

Any non-null \`.blocker\` is a stall the zone can't resolve by itself. Do NOT just keep polling — act:

- \`delivery-failed\` (no ack within 45s): the poke never reached the zone's agent loop. **Action**: overwrite the task file. The harness bumps \`round\` and sends a fresh poke with a new task id.
- \`idle-stuck\` (no output activity for 90s+): the zone is stalled mid-task. **Action**: read \`outputs/<safe>.md\` for the last progress note, then overwrite the task file with a nudge ("you appear to be blocked on X; try Y") or surface the problem to the user.
- \`task-timeout\` (exceeded zone's timeout): same as idle-stuck but harder — zone has been working too long. **Action**: inspect \`outputs/<safe>.md\`; consider narrowing the task or escalating to the user.
- \`pty-exit\` / \`malformed-completion\`: the zone's process died or reported completion without a receipt. **Action**: the zone cannot recover on its own. Read \`outputs/<safe>.md\` for partial results and surface to the user.
- \`zone-reported\` (state is \`blocked\`, receipt present with \`result != success\`): the zone explicitly reported it couldn't finish. **Action**: read \`receipt.summary\` and the output log; either resolve the blocker and re-poke, or surface to the user.

## Iteration

To give a zone another round of work within the same dispatch, **overwrite its task file**. The harness detects the change, bumps \`round\`, assigns a new \`taskId\`, and pokes the zone's live CLI. Don't launch anything new; the zone is already running. Then wait for the new \`round\` with the poll recipe above.

After all engaged zones reach \`state == "done"\` at the target round with no blocker, read each zone's ARCHITECT/outputs/<safe>.md and the archived \`outputs/<safe>.receipt.<round>.json\` to collect results. If a downstream zone needs interfaces the upstream zone produced, rewrite the downstream task file with those interfaces and poll again. Then report back to the user.

IMPORTANT: Zones create all real project files (source code, configs, etc.) directly in the project root, NOT inside ARCHITECT/. The ARCHITECT/ folder is only for coordination (manifests, prompts, tasks, status, outputs). Do not create project files yourself.

Start by writing the task files for the zones the user's task requires, then enter the supervision loop.${dispatchContext?.isRedispatch
    ? `\n\n## Execution Mode\nREDISPATCH — existing outputs may be present in ARCHITECT/outputs/. Status files have been reset to round 0 for this dispatch.\n${dispatchContext.changedNodeLabels.length > 0
        ? `The following zones have changed since the last dispatch and likely need attention: ${dispatchContext.changedNodeLabels.join(', ')}.\nStill, only engage zones the user's task actually requires.`
        : `No zone configurations changed. Only engage zones the user's task requires.`}`
    : ''}`
}

function buildZoneSystemPrompt(
  zone: ZoneGraphNode,
  componentsByZone: Map<string, ComponentGraphNode[]>,
  zoneEdges: GraphEdge[],
  intraEdges: GraphEdge[],
  zones: ZoneGraphNode[]
): string {
  const safe = sanitize(zone.data.label)
  const statusLog = `ARCHITECT/outputs/${safe}.md`

  const upstream = zoneEdges.filter(edge => edge.target === zone.id).map(edge => zones.find(z => z.id === edge.source)?.data.label).filter(Boolean)
  const downstream = zoneEdges.filter(edge => edge.source === zone.id).map(edge => zones.find(z => z.id === edge.target)?.data.label).filter(Boolean)
  const tools = Object.entries(zone.data.tools ?? {}).filter(([, enabled]) => enabled).map(([key]) => key)
  const skills = (zone.data.skills ?? [])
    .map(skill => {
      const content = readSkillContent(skill.path)
      return content ? `### ${skill.name}\n${content}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

  const comps = componentsByZone.get(zone.id) ?? []
  const compList = comps.length
    ? comps.map(c => {
        const head = `- **${c.data.label}**${c.data.tag ? ` [${c.data.tag}]` : ''}${c.data.category ? ` (${c.data.category})` : ''}${c.data.description ? ` — ${c.data.description}` : ''}`
        const specs = (c.data.specs ?? '').trim()
        return specs ? `${head}\n\n  ${specs.split('\n').join('\n  ')}` : head
      }).join('\n\n')
    : '_(no components were drawn — work from the user goal alone)_'

  const compIds = new Set(comps.map(c => c.id))
  const relevantIntra = intraEdges.filter(e => compIds.has(e.source) && compIds.has(e.target))
  const archLines = relevantIntra.length
    ? relevantIntra.map(e => {
        const s = comps.find(c => c.id === e.source)?.data.label ?? e.source
        const t = comps.find(c => c.id === e.target)?.data.label ?? e.target
        return `- ${s} → ${t}`
      }).join('\n')
    : '_(no internal wiring specified)_'

  const userSystem = (zone.data.systemPrompt ?? '').trim()

  return `You are the **${zone.data.label}** zone-agent.
${zone.data.description ? `Zone description: ${zone.data.description}\n` : ''}
${upstream.length ? `Upstream zones (read their status logs first): ${upstream.map(label => `ARCHITECT/outputs/${sanitize(label as string)}.md`).join(', ')}\n` : ''}${downstream.length ? `Downstream zones depending on you: ${downstream.join(', ')}\n` : ''}${tools.length ? `Enabled tools: ${tools.join(', ')}\n` : ''}
## What you own (reference)

These components live in your zone on the architecture canvas. This is context about the parts of the system you are responsible for — NOT a build list. The current dispatch may touch none, some, or all of them. The Architect's task file tells you what to actually do; treat anything outside that file as existing context you should leave alone.

${compList}

## Internal wiring (reference)

${archLines}

${skills ? `## Skills\n\n${skills}\n\n` : ''}${userSystem ? `## Behavior\n\n${userSystem}\n\n` : ''}## Instructions

The Architect dispatches work to you by writing ARCHITECT/tasks/${safe}.md. The harness delivers each new or updated version directly into this CLI session as a message — you will receive a poke that carries a \`task_id\` and a \`round\` number. When a poke arrives, open the file, execute exactly what it says — nothing more. Do NOT expand scope by building unrequested components, rewriting files the task does not mention, or assuming the whole zone needs to be (re)built.

You may be re-poked multiple times within a single conversation (iteration). Every poke starts a fresh round with a new \`task_id\`. Use the task_id from the CURRENT poke in all of the steps below — never reuse an old one.

**WHERE TO CREATE FILES:**
- All project files (source code, configs, scripts, etc.) go directly in the project root (current working directory). Do NOT put them inside ARCHITECT/.
- ARCHITECT/ is only for coordination: tasks, prompts, status, and outputs.
- ${statusLog} is your output log — append brief progress notes (the harness polls its mtime as a heartbeat, so actually writing to it during work matters).

If you have downstream zones, document any interfaces you produce (ports, schemas, file paths) in your output log so the Architect can relay them.

Work fully autonomously — do not stop or ask for clarification.

## Round protocol (do these in order, every round)

1. **Acknowledge immediately, before anything else.** As the very first shell command of the round, run exactly:
   \`echo ARCHITECT_TASK_ACK <task_id>\`
   where \`<task_id>\` is the id in the poke you just received. The harness watches for this echo; without it the task is considered undelivered after 45 seconds and the Architect will re-poke.

2. **Read and execute** \`ARCHITECT/tasks/${safe}.md\` exactly as written.

3. **Log progress** to \`${statusLog}\` as you go — one line per significant step. The harness watches this file's mtime; long silences trigger an \`idle-stuck\` blocker.

4. **Write a receipt** when the round finishes, success OR blocked. Write valid JSON to \`ARCHITECT/outputs/${safe}.receipt.json\`:
   \`\`\`json
   {"task_id":"<the same id>","result":"success","summary":"<one-line>","durationMs":<integer>}
   \`\`\`
   - \`result\`: \`"success"\` when the task is done; \`"blocked"\` when a hard dependency prevents completion (missing file, contradictory requirement, permission denial); \`"failed"\` on an unrecoverable internal error.
   - \`summary\`: a single line the Architect will read. For blockers, state the blocker concretely ("file X referenced in task does not exist"). For success, say what you produced (ports, endpoints, files).
   - Always include the correct \`task_id\` from the current poke — receipts with a stale id are ignored.

5. **Signal done.** After the receipt is written, run exactly:
   \`echo ARCHITECT_COMPLETE <task_id>\`

The harness promotes \`state\` on your status.json at each of these steps: \`running\` → \`ack\` on step 1, \`done\` / \`blocked\` on step 4. Missing step 1 or 4 causes the Architect to see a blocker and intervene.`
}

function setupWorkspace(
  projectDir: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  settings: ProjectSettings,
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] },
  userPrompt?: string,
) {
  const base = join(projectDir, 'ARCHITECT')
  for (const dir of ['tasks', 'outputs', 'prompts', 'status', 'sessions', 'dispatches'].map(name => join(base, name))) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const { zones, componentsByZone, unassignedComponents } = indexGraph(nodes)
  const zoneIdSet = new Set(zones.map(z => z.id))
  const zoneEdges = edges.filter(e => zoneIdSet.has(e.source) && zoneIdSet.has(e.target))
  const intraEdges = edges.filter(e => !zoneIdSet.has(e.source) && !zoneIdSet.has(e.target))

  fs.writeFileSync(join(base, 'manifest.json'), JSON.stringify({
    generated: new Date().toISOString(),
    defaultRuntime: settings.defaultRuntime,
    unassignedComponents: unassignedComponents.map(c => ({
      id: c.id,
      label: c.data.label,
      category: c.data.category ?? null,
      tag: c.data.tag ?? null,
      description: c.data.description ?? '',
      specs: c.data.specs ?? '',
    })),
    zones: zones.map(zone => {
      const runtime = getZoneRuntime(zone, settings)
      return {
        id: zone.id,
        label: zone.data.label,
        description: zone.data.description,
        runtime,
        runtimeLabel: getAgentRuntime(runtime).label,
        model: getZoneModel(zone, runtime),
        systemPrompt: zone.data.systemPrompt || null,
        taskFile: `ARCHITECT/tasks/${sanitize(zone.data.label)}.md`,
        outputFile: `ARCHITECT/outputs/${sanitize(zone.data.label)}.md`,
        enabledTools: Object.entries(zone.data.tools ?? {}).filter(([, enabled]) => enabled).map(([key]) => key),
        upstream: zoneEdges.filter(e => e.target === zone.id).map(e => zones.find(z => z.id === e.source)?.data.label).filter(Boolean),
        downstream: zoneEdges.filter(e => e.source === zone.id).map(e => zones.find(z => z.id === e.target)?.data.label).filter(Boolean),
        components: (componentsByZone.get(zone.id) ?? []).map(c => ({
          id: c.id,
          label: c.data.label,
          category: c.data.category ?? null,
          tag: c.data.tag ?? null,
          description: c.data.description ?? '',
          specs: c.data.specs ?? '',
        })),
      }
    }),
  }, null, 2))

  fs.writeFileSync(join(base, 'diagram.md'), buildMermaidDiagram(zones, componentsByZone, zoneEdges))
  fs.writeFileSync(join(base, 'prompts', 'architect.md'), buildArchitectPrompt(zones, componentsByZone, unassignedComponents, edges, settings, dispatchContext, userPrompt))
  for (const zone of zones) {
    fs.writeFileSync(join(base, 'prompts', `${sanitize(zone.data.label)}.md`), buildZoneSystemPrompt(zone, componentsByZone, zoneEdges, intraEdges, zones))
  }
}

// Per-task timeouts. `DEFAULT_TASK_TIMEOUT_MS` can be overridden per zone via
// `zone.data.behavior.timeoutMs`. `ACK_TIMEOUT_MS` is the deadline for the
// zone to echo `ARCHITECT_TASK_ACK <task_id>`; misses flip status.json to
// `blocker.kind = 'delivery-failed'`. `IDLE_THRESHOLD_MS` is the heartbeat
// threshold against `outputs/<safe>.md` mtime.
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000
const ACK_TIMEOUT_MS = 45_000
const IDLE_THRESHOLD_MS = 90_000
const HEARTBEAT_POLL_MS = 15_000
// Soft gate on first-round delivery. On timeout the coordinator logs and
// pokes anyway — we'd rather risk a slightly early poke than refuse delivery
// when the xterm-headless cue misses.
const AWAIT_READY_SOFT_MS = 10_000

// Single-watcher coordinator for a multi-zone dispatch. All zones must already
// be pre-spawned before this is called. It watches ARCHITECT/tasks/, pokes
// the corresponding zone with a task id, and watches outputs/<safe>.receipt.json
// for structured completion. Heartbeat / ack / task timers drive the blocker
// field on status.json so the Architect can recover from stalls.
function startDispatchCoordinator(
  projectDir: string,
  zones: ZoneGraphNode[],
): { stop: () => void } {
  const zoneBySafe = new Map(zones.map(z => [sanitize(z.data.label), z]))
  const tasksDir = join(projectDir, 'ARCHITECT', 'tasks')
  const outputsDir = join(projectDir, 'ARCHITECT', 'outputs')
  fs.mkdirSync(outputsDir, { recursive: true })

  const debounceTimers = new Map<string, NodeJS.Timeout>()
  // Guards concurrent deliverTask runs on the same zone (watcher + initial
  // sweep can both fire).
  const inFlight = new Set<string>()

  // Per-zone timers for the in-flight round. All cleared on completion or
  // coordinator teardown. Keyed by safe label.
  const ackTimers = new Map<string, NodeJS.Timeout>()
  const taskTimers = new Map<string, NodeJS.Timeout>()
  const heartbeatTimer = setInterval(() => {
    for (const safe of zoneBySafe.keys()) checkHeartbeat(safe)
  }, HEARTBEAT_POLL_MS)

  // File watchers for receipts (one per outputs dir entry we care about).
  let receiptWatcher: fs.FSWatcher | null = null
  let tasksWatcher: fs.FSWatcher | null = null

  for (const safe of zoneBySafe.keys()) initStatus(projectDir, safe)

  function clearRoundTimers(safe: string): void {
    const ackT = ackTimers.get(safe)
    if (ackT) { clearTimeout(ackT); ackTimers.delete(safe) }
    const taskT = taskTimers.get(safe)
    if (taskT) { clearTimeout(taskT); taskTimers.delete(safe) }
  }

  function checkHeartbeat(safe: string): void {
    const status = readStatus(projectDir, safe)
    if (!status) return
    if (status.state !== 'running' && status.state !== 'ack') return
    // Poll mtime of outputs/<safe>.md — zones append progress notes there, so
    // mtime advancing means the zone is alive. Absence of the file is fine
    // for an early-round zone that hasn't written yet.
    const outPath = join(outputsDir, `${safe}.md`)
    try {
      const stat = fs.statSync(outPath)
      const iso = stat.mtime.toISOString()
      markActivity(projectDir, safe, iso)
    } catch { /* no output yet */ }

    // Re-read after activity update.
    const now = Date.now()
    const fresh = readStatus(projectDir, safe)
    if (!fresh) return
    const anchor = fresh.lastActivityAt ?? fresh.acknowledgedAt ?? fresh.startedAt
    if (!anchor) return
    const age = now - Date.parse(anchor)
    if (age < IDLE_THRESHOLD_MS) return
    // Don't clobber a more specific blocker (delivery-failed, task-timeout).
    if (fresh.blocker && fresh.blocker.kind !== 'idle-stuck') return
    markBlocked(projectDir, safe, {
      kind: 'idle-stuck',
      message: `No activity for ${Math.round(age / 1000)}s (last at ${anchor})`,
      since: fresh.blocker?.since ?? new Date().toISOString(),
    })
  }

  // Processes a dropped `<safe>.receipt.json` file. If the receipt's task_id
  // matches the round in flight, flip status.json to done/blocked and cancel
  // round timers. Malformed JSON → blocker.kind='malformed-completion'.
  function ingestReceipt(safe: string): void {
    const zone = zoneBySafe.get(safe)
    if (!zone) return
    const receiptPath = join(outputsDir, `${safe}.receipt.json`)
    let raw: string
    try { raw = fs.readFileSync(receiptPath, 'utf-8') } catch { return }
    let parsed: Partial<ZoneReceipt & { task_id: string; taskId: string }>
    try {
      parsed = JSON.parse(raw)
    } catch {
      markBlocked(projectDir, safe, {
        kind: 'malformed-completion',
        message: `Receipt at ${safe}.receipt.json is not valid JSON`,
        since: new Date().toISOString(),
      })
      return
    }
    const status = readStatus(projectDir, safe)
    if (!status || !status.taskId) return
    const receiptTaskId = parsed.task_id ?? parsed.taskId
    if (receiptTaskId !== status.taskId) {
      // Stale receipt (from a previous round). Ignore silently — the current
      // round is still in flight.
      return
    }
    const result = parsed.result === 'blocked' || parsed.result === 'failed'
      ? parsed.result
      : 'success'
    const durationMs = typeof parsed.durationMs === 'number'
      ? parsed.durationMs
      : status.startedAt ? Date.now() - Date.parse(status.startedAt) : 0
    const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
    markDoneWithReceipt(projectDir, safe, { result, summary, durationMs })
    clearRoundTimers(safe)
    // Archive the receipt under the round number so iteration rounds get a
    // clean slate.
    try {
      const archivePath = join(outputsDir, `${safe}.receipt.${status.round}.json`)
      fs.renameSync(receiptPath, archivePath)
    } catch { /* best effort */ }
  }

  function hookDoneOnce(zone: ZoneGraphNode): void {
    const safe = sanitize(zone.data.label)
    onSessionDone(zone.id, () => {
      // ARCHITECT_COMPLETE was seen on the rendered screen. This is
      // secondary to the receipt file. If the receipt already landed, the
      // timers are cleared and status is done — nothing to do. If it hasn't
      // landed within a short grace window, flag malformed-completion so the
      // Architect can fall back to reading outputs/<safe>.md.
      setTimeout(() => {
        const fresh = readStatus(projectDir, safe)
        if (!fresh) return
        if (fresh.state === 'done' || fresh.state === 'blocked' || fresh.state === 'failed') return
        markBlocked(projectDir, safe, {
          kind: 'malformed-completion',
          message: 'ARCHITECT_COMPLETE observed without a matching receipt.json',
          since: new Date().toISOString(),
        })
      }, 2_000)
    })
  }
  for (const zone of zones) hookDoneOnce(zone)

  async function deliverTask(safe: string): Promise<void> {
    if (inFlight.has(safe)) return
    const filePath = join(tasksDir, `${safe}.md`)
    let content: string
    try { content = fs.readFileSync(filePath, 'utf-8') } catch { return }
    if (!content.trim()) return
    const hash = createHash('sha1').update(content).digest('hex')

    const prev = readStatus(projectDir, safe)
    // Same task already delivered AND still in flight → skip. If the zone
    // finished the task and the Architect overwrites with new content, hash
    // differs; if same hash but we're idle / done / blocked, we redeliver.
    if (prev?.lastTaskHash === hash && (prev.state === 'running' || prev.state === 'ack')) return

    const zone = zoneBySafe.get(safe)
    if (!zone) return
    const session = sessions.get(zone.id)
    if (!session) {
      console.warn(`[coordinator] no live PTY for zone ${safe}; cannot deliver task`)
      return
    }
    if (session.lifecycle === 'failed') {
      console.warn(`[coordinator] zone ${safe} in failed state; skipping`)
      markFailed(projectDir, safe, {
        kind: 'pty-exit',
        message: session.lastError?.message ?? 'PTY is in failed state',
        since: new Date().toISOString(),
      })
      return
    }

    inFlight.add(safe)
    try {
      try {
        await awaitReady(zone.id, AWAIT_READY_SOFT_MS)
      } catch (err) {
        // Soft gate — log and proceed anyway. Either the ready cue missed
        // under xterm emulation (false negative) or the CLI is genuinely
        // unhealthy; the ack timer will catch the latter.
        console.warn(`[coordinator] ${safe} not visibly ready, poking anyway: ${String(err)}`)
      }

      // Re-arm completion hook (observe splices doneCallbacks when the
      // sentinel fires).
      hookDoneOnce(zone)

      const taskId = generateTaskId()
      const round = (prev?.round ?? 0) + 1
      setCurrentTaskId(zone.id, taskId)
      clearRoundTimers(safe)
      markRunning(projectDir, safe, hash, taskId)

      const body = buildPokeBody({ safe, taskId, round })
      const ok = sendPrompt(zone.id, body)
      if (!ok) {
        console.error(`[coordinator] sendPrompt failed for ${safe}`)
        markFailed(projectDir, safe, {
          kind: 'pty-exit',
          message: 'sendPrompt failed; PTY may be dead',
          since: new Date().toISOString(),
        })
        return
      }

      // Ack watcher. The observe() path resolves `awaitAck(taskId)` when the
      // zone echoes ARCHITECT_TASK_ACK. On success, flip status → 'ack'. On
      // timeout, set blocker.
      void awaitAck(zone.id, taskId, ACK_TIMEOUT_MS).then(
        () => { markAck(projectDir, safe) },
        () => {
          const status = readStatus(projectDir, safe)
          if (!status || status.taskId !== taskId) return
          if (status.state === 'done' || status.state === 'blocked' || status.state === 'failed') return
          markBlocked(projectDir, safe, {
            kind: 'delivery-failed',
            message: `Zone did not ack within ${ACK_TIMEOUT_MS / 1000}s`,
            since: new Date().toISOString(),
          })
        },
      )

      const timeoutMs = Math.max(
        60_000,
        zone.data?.behavior?.timeoutMs || DEFAULT_TASK_TIMEOUT_MS,
      )
      const taskT = setTimeout(() => {
        taskTimers.delete(safe)
        const status = readStatus(projectDir, safe)
        if (!status || status.taskId !== taskId) return
        if (status.state === 'done' || status.state === 'blocked' || status.state === 'failed') return
        markBlocked(projectDir, safe, {
          kind: 'task-timeout',
          message: `Task exceeded ${Math.round(timeoutMs / 1000)}s without a receipt`,
          since: new Date().toISOString(),
        })
      }, timeoutMs)
      taskTimers.set(safe, taskT)
    } finally {
      inFlight.delete(safe)
    }
  }

  tasksWatcher = fs.watch(tasksDir, (_event, filename) => {
    if (!filename?.endsWith('.md')) return
    const safe = filename.slice(0, -3)
    if (!zoneBySafe.has(safe)) return
    const existing = debounceTimers.get(safe)
    if (existing) clearTimeout(existing)
    debounceTimers.set(safe, setTimeout(() => {
      debounceTimers.delete(safe)
      void deliverTask(safe)
    }, 500))
  })

  // Outputs watcher: receipts (`<safe>.receipt.json`) flip completion, and
  // markdown (`<safe>.md`) writes advance lastActivityAt.
  receiptWatcher = fs.watch(outputsDir, (_event, filename) => {
    if (!filename) return
    const name = String(filename)
    if (name.endsWith('.receipt.json')) {
      const safe = name.slice(0, -'.receipt.json'.length)
      if (zoneBySafe.has(safe)) ingestReceipt(safe)
    } else if (name.endsWith('.md')) {
      const safe = name.slice(0, -3)
      if (zoneBySafe.has(safe)) {
        try {
          const stat = fs.statSync(join(outputsDir, name))
          markActivity(projectDir, safe, stat.mtime.toISOString())
        } catch { /* file may have been removed */ }
      }
    }
  })

  // Initial-write catch: fs.watch on macOS can miss the very first write to
  // a freshly-created file. One short sweep catches any tasks written before
  // the watcher was armed.
  setTimeout(() => {
    try {
      for (const name of fs.readdirSync(tasksDir)) {
        if (!name.endsWith('.md')) continue
        const safe = name.slice(0, -3)
        if (zoneBySafe.has(safe)) void deliverTask(safe)
      }
    } catch {}
  }, 200)

  const coord = {
    stop: () => {
      for (const timer of debounceTimers.values()) clearTimeout(timer)
      debounceTimers.clear()
      for (const timer of ackTimers.values()) clearTimeout(timer)
      ackTimers.clear()
      for (const timer of taskTimers.values()) clearTimeout(timer)
      taskTimers.clear()
      clearInterval(heartbeatTimer)
      try { tasksWatcher?.close() } catch {}
      try { receiptWatcher?.close() } catch {}
      tasksWatcher = null
      receiptWatcher = null
      if (activeDispatchCoordinator === coord) activeDispatchCoordinator = null
      // activeWatcher is a legacy slot the assistant watcher also uses; leave
      // it alone so other watchers aren't accidentally closed here.
    },
  }
  activeDispatchCoordinator = coord
  return coord
}

function buildPokeBody(opts: { safe: string; taskId: string; round: number }): string {
  const { safe, taskId, round } = opts
  return [
    `New task from the Architect — round ${round}, task_id ${taskId}.`,
    ``,
    `Follow these steps in order:`,
    `1. First, before anything else: echo ARCHITECT_TASK_ACK ${taskId}`,
    `2. Read ARCHITECT/tasks/${safe}.md and execute it.`,
    `3. Throughout, append brief progress notes to ARCHITECT/outputs/${safe}.md.`,
    `4. When finished (success or blocked), write ARCHITECT/outputs/${safe}.receipt.json with:`,
    `   {"task_id":"${taskId}","result":"success"|"blocked"|"failed","summary":"<one-line>","durationMs":<number>}`,
    `5. Finally, echo ARCHITECT_COMPLETE ${taskId}`,
  ].join('\n')
}

export interface RunGraphDispatch {
  userPrompt: string
  model?: string
  planMode?: boolean
  onlyZoneIds?: string[]
}

export async function runGraph(
  win: BrowserWindow,
  nodes: GraphNode[],
  edges: GraphEdge[],
  projectDir: string,
  rawSettings: unknown,
  dispatch: RunGraphDispatch,
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] },
): Promise<TerminalInfo[]> {
  killAll()
  const settings = normalizeProjectSettings(rawSettings)
  const userPrompt = (dispatch.userPrompt ?? '').trim()
  const dispatchSummary = summarizeFromPrompt(userPrompt)

  // Filter to the subset of zones requested, if any.
  const { zones: allZones } = indexGraph(nodes)
  const onlyIds = dispatch.onlyZoneIds && dispatch.onlyZoneIds.length > 0
    ? new Set(dispatch.onlyZoneIds)
    : null
  const selectedZones = onlyIds
    ? allZones.filter(z => onlyIds.has(z.id))
    : allZones
  const selectedZoneIds = new Set(selectedZones.map(z => z.id))
  const filteredNodes = nodes.filter(n => n.type !== 'zone' || selectedZoneIds.has(n.id))

  setupWorkspace(projectDir, filteredNodes, edges, settings, dispatchContext, userPrompt)

  const zoneEdges = edges.filter(e => selectedZoneIds.has(e.source) && selectedZoneIds.has(e.target))
  const sorted = topoSort(selectedZones, zoneEdges)
  const promptsDir = join(projectDir, 'ARCHITECT', 'prompts')

  // Single-zone path: skip the Architect coordinator entirely. Always fresh —
  // explicit resume goes through runZone / the zone launcher modal.
  if (sorted.length === 1) {
    const zone = sorted[0]
    const runtime = getZoneRuntime(zone, settings)
    const model = dispatch.model || getZoneModel(zone, runtime)
    const env: Record<string, string> = {}
    for (const { key, value } of zone.data.envVars ?? []) {
      if (key) env[key] = value
    }
    const baseSystemPrompt = fs.readFileSync(join(promptsDir, `${sanitize(zone.data.label)}.md`), 'utf-8')
    const { zones: canvasZones, componentsByZone: canvasComps } = indexGraph(nodes)
    const contextBlock = buildArchitectureContextBlock(canvasZones, canvasComps, edges, zone.id)
    const systemPrompt = baseSystemPrompt + contextBlock

    spawnAgentSession({
      win,
      id: zone.id,
      label: zone.data.label,
      runtime,
      env,
      cwd: projectDir,
      initialPrompt: userPrompt || undefined,
      model,
      planMode: dispatch.planMode === true,
      appendSystemPrompt: systemPrompt,
      skipPermissions: false,
      capture: {
        projectDir,
        zoneKey: zone.id,
        legacyKey: sanitize(zone.data.label),
        summary: dispatchSummary,
      },
    })

    return [{ id: zone.id, label: zone.data.label, runtime }]
  }

  const allInfo: TerminalInfo[] = [
    { id: 'architect-agent', label: 'Architect', runtime: settings.defaultRuntime },
    ...sorted.map(zone => ({ id: zone.id, label: zone.data.label, runtime: getZoneRuntime(zone, settings) })),
  ]

  // Architect session id is captured first; zones that race ahead queue their
  // upsert until it's available so every DispatchRecord keeps a full zone map.
  let architectSessionId: string | null = null
  const pendingZoneUpserts: Array<() => void> = []

  // Pre-spawn every zone up front. Each zone's CLI boots with its system
  // prompt, sits idle at its prompt, and waits for the coordinator to deliver
  // a task-file poke. Dependency ordering lives in the Architect's prompt —
  // not in spawn order.
  for (const zone of sorted) {
    const safe = sanitize(zone.data.label)
    const env: Record<string, string> = {}
    for (const { key, value } of zone.data.envVars ?? []) {
      if (key) env[key] = value
    }
    const runtime = getZoneRuntime(zone, settings)
    const model = getZoneModel(zone, runtime)
    const systemPrompt = fs.readFileSync(join(promptsDir, `${safe}.md`), 'utf-8')

    spawnAgentSession({
      win,
      id: zone.id,
      label: zone.data.label,
      runtime,
      env,
      cwd: projectDir,
      // No initialPrompt: the zone sits idle until the coordinator pokes it.
      appendSystemPrompt: systemPrompt,
      model,
      capture: {
        projectDir,
        zoneKey: zone.id,
        legacyKey: safe,
        summary: dispatchSummary,
      },
      onSessionCaptured: zoneSessionId => {
        const upsert = () => {
          if (!architectSessionId) return
          try {
            upsertDispatchZoneSession(projectDir, architectSessionId, {
              zoneId: zone.id,
              label: zone.data.label,
              runtime,
              sessionId: zoneSessionId,
            })
          } catch (err) {
            console.error('[dispatch-capture] failed to upsert zone session', err)
          }
          try {
            const rec = getZoneSessionRecord(projectDir, zone.id, zoneSessionId, safe)
            if (rec && !rec.dispatchId) {
              appendZoneSession(projectDir, zone.id, { ...rec, dispatchId: architectSessionId })
            }
          } catch {}
        }
        if (architectSessionId) upsert()
        else pendingZoneUpserts.push(upsert)
      },
    })
  }

  startDispatchCoordinator(projectDir, sorted)

  const architectPrompt = fs.readFileSync(join(promptsDir, 'architect.md'), 'utf-8')
  spawnAgentSession({
    win,
    id: 'architect-agent',
    label: 'Architect',
    runtime: settings.defaultRuntime,
    env: {},
    cwd: projectDir,
    initialPrompt: architectPrompt,
    model: dispatch.model || DEFAULT_MODEL_BY_RUNTIME[settings.defaultRuntime],
    planMode: dispatch.planMode === true,
    capture: {
      projectDir,
      zoneKey: 'architect-agent',
      legacyKey: 'Architect',
      summary: dispatchSummary,
    },
    onSessionCaptured: sessionId => {
      architectSessionId = sessionId
      const record: DispatchRecord = {
        architectSessionId: sessionId,
        architectRuntime: settings.defaultRuntime,
        zoneIds: sorted.map(z => z.id),
        zoneLabels: sorted.map(z => z.data.label),
        zoneSessions: [],
        userPrompt,
        summary: dispatchSummary,
        model: dispatch.model || DEFAULT_MODEL_BY_RUNTIME[settings.defaultRuntime],
        planMode: dispatch.planMode === true,
        timestamp: new Date().toISOString(),
      }
      try { saveDispatch(projectDir, record) } catch (err) {
        console.error('[dispatch-capture] failed to save', err)
      }
      // Flush any zone captures that landed before Architect's id was known.
      for (const fn of pendingZoneUpserts.splice(0)) fn()
    },
  })

  return allInfo
}

const ASSISTANT_ZONES: Record<AssistantMode, string> = {
  architecture: sanitize('Architecture Assistant Design'),
  general:      sanitize('Architecture Assistant General'),
}
const ASSISTANT_SESSION_IDS: Record<AssistantMode, string> = {
  architecture: 'architect-assistant-architecture',
  general:      'architect-assistant-general',
}
const ASSISTANT_LABELS: Record<AssistantMode, string> = {
  architecture: 'Architecture Assistant',
  general:      'General Assistant',
}

export function startAssistant(
  win: BrowserWindow,
  projectDir: string,
  contextMd: string,
  runtime: AgentRuntime,
  mode: AssistantMode,
): TerminalInfo {
  const safeMode: AssistantMode = isAssistantMode(mode) ? mode : 'architecture'
  const sessionId = ASSISTANT_SESSION_IDS[safeMode]
  const zoneKey = ASSISTANT_ZONES[safeMode]

  const existing = sessions.get(sessionId)
  if (existing) {
    try { existing.pty.kill() } catch {}
    try { existing.term.dispose() } catch {}
    sessions.delete(sessionId)
  }

  const safeRuntime = isAgentRuntime(runtime) ? runtime : DEFAULT_AGENT_RUNTIME
  const architectDir = join(projectDir, 'ARCHITECT')
  fs.mkdirSync(architectDir, { recursive: true })
  // Always keep the context file fresh so the assistant can re-read on demand
  // ("re-read ARCHITECT/.assistant-context.md"), but don't auto-inject it.
  const contextFile = join(architectDir, '.assistant-context.md')
  fs.writeFileSync(contextFile, contextMd)

  // Assistant has no per-session picker UI — resume the most recent record
  // for this runtime if one is reachable, otherwise start fresh.
  const saved = latestReachableSession(projectDir, zoneKey, safeRuntime)
  const canResume = !!saved
  console.log(
    `[assistant] mode=${safeMode} runtime=${safeRuntime} saved=${saved ? saved.sessionId : 'none'} → ${canResume ? 'RESUMING' : 'fresh start'}`,
  )

  return spawnAgentSession({
    win,
    id: sessionId,
    label: ASSISTANT_LABELS[safeMode],
    runtime: safeRuntime,
    env: {},
    cwd: projectDir,
    initialPrompt: canResume ? undefined : 'Read ARCHITECT/.assistant-context.md',
    resumeSessionId: canResume ? saved!.sessionId : undefined,
    model: DEFAULT_MODEL_BY_RUNTIME[safeRuntime],
    capture: { projectDir, zoneKey, summary: `${ASSISTANT_LABELS[safeMode]}` },
    // Interactive: keep normal permission prompts. The user is sitting here.
    skipPermissions: false,
  })
}

export function stopAssistant() {
  for (const sessionId of Object.values(ASSISTANT_SESSION_IDS)) {
    const session = sessions.get(sessionId)
    if (session) {
      try { session.pty.kill() } catch {}
      try { session.term.dispose() } catch {}
      sessions.delete(sessionId)
    }
  }
}

export interface RunZoneOptions {
  projectDir: string
  zoneId: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  mode: 'new' | 'resume'
  // When mode === 'new', optional one-line label for the history entry.
  summary?: string
  // When mode === 'resume', the specific history sessionId to resume.
  sessionId?: string
  userPrompt?: string
  model?: string
  planMode?: boolean
  settings: unknown
}

export interface RunZoneResult {
  ok: boolean
  reason?: string
  info?: TerminalInfo
}

// Unified entry point for launching a single zone — handles both "start new
// session" and "continue previous session" from the ZoneLaunchModal.
export async function runZone(win: BrowserWindow, opts: RunZoneOptions): Promise<RunZoneResult> {
  const settings = normalizeProjectSettings(opts.settings)
  const { zones, componentsByZone } = indexGraph(opts.nodes)
  const zone = zones.find(z => z.id === opts.zoneId)
  if (!zone) return { ok: false, reason: 'zone-not-found' }

  const safe = sanitize(zone.data.label)
  const base = join(opts.projectDir, 'ARCHITECT')
  for (const dir of ['tasks', 'outputs', 'prompts', 'status', 'sessions', 'dispatches'].map(n => join(base, n))) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const zoneIdSet = new Set(zones.map(z => z.id))
  const zoneEdges = opts.edges.filter(e => zoneIdSet.has(e.source) && zoneIdSet.has(e.target))
  const intraEdges = opts.edges.filter(e => !zoneIdSet.has(e.source) && !zoneIdSet.has(e.target))
  const systemPrompt = buildZoneSystemPrompt(zone, componentsByZone, zoneEdges, intraEdges, zones)
  fs.writeFileSync(join(base, 'prompts', `${safe}.md`), systemPrompt)

  const runtime = getZoneRuntime(zone, settings)
  const model = opts.model || getZoneModel(zone, runtime)
  const env: Record<string, string> = {}
  for (const { key, value } of zone.data.envVars ?? []) {
    if (key) env[key] = value
  }

  const userPrompt = (opts.userPrompt ?? '').trim()

  // Replace any existing PTY for this zone so the same renderer tab gets reused.
  const existing = sessions.get(zone.id)
  if (existing) {
    try { existing.pty.kill() } catch {}
    try { existing.term.dispose() } catch {}
    sessions.delete(zone.id)
  }

  if (opts.mode === 'resume') {
    if (!opts.sessionId) return { ok: false, reason: 'missing-session-id' }
    const rec = pickSession(opts.projectDir, zone.id, opts.sessionId, safe)
    if (!rec) return { ok: false, reason: 'session-not-found' }
    if (rec.runtime !== runtime) return { ok: false, reason: `session-runtime-mismatch:${rec.runtime}` }

    const info = spawnAgentSession({
      win,
      id: zone.id,
      label: zone.data.label,
      runtime,
      env,
      cwd: opts.projectDir,
      model,
      resumeSessionId: rec.sessionId,
      resumeUserPrompt: userPrompt || undefined,
      skipPermissions: false,
    })
    broadcast('terminal:spawned', info)
    return { ok: true, info }
  }

  // mode === 'new' — fresh spawn, append a history entry once the runtime
  // assigns a new session id.
  const summary = (opts.summary ?? '').trim() ||
    `${zone.data.label} · ${new Date().toLocaleString()}`

  const info = spawnAgentSession({
    win,
    id: zone.id,
    label: zone.data.label,
    runtime,
    env,
    cwd: opts.projectDir,
    initialPrompt: userPrompt || undefined,
    appendSystemPrompt: systemPrompt,
    model,
    planMode: opts.planMode === true,
    skipPermissions: false,
    capture: {
      projectDir: opts.projectDir,
      zoneKey: zone.id,
      legacyKey: safe,
      summary,
    },
  })
  broadcast('terminal:spawned', info)
  return { ok: true, info }
}

export function listZoneSessionsForZone(
  projectDir: string,
  zoneId: string,
  label?: string,
): ZoneSessionRecord[] {
  return listZoneSessions(projectDir, zoneId, label ? sanitize(label) : undefined)
}

export function deleteZoneSessionEntry(
  projectDir: string,
  zoneId: string,
  sessionId: string,
  label?: string,
): boolean {
  return deleteZoneSession(projectDir, zoneId, sessionId, label ? sanitize(label) : undefined)
}

export function renameZoneSessionEntry(
  projectDir: string,
  zoneId: string,
  sessionId: string,
  summary: string,
  label?: string,
): boolean {
  return updateZoneSessionSummary(projectDir, zoneId, sessionId, summary, label ? sanitize(label) : undefined)
}

export function resetZoneSession(projectDir: string, zoneId: string, label?: string): boolean {
  return deleteZoneSession(projectDir, zoneId, undefined, label ? sanitize(label) : undefined)
}

export interface ResumeDispatchOptions {
  projectDir: string
  dispatchId: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  settings: unknown
}

export type ResumeDispatchResult =
  | { ok: true; info: TerminalInfo[] }
  | { ok: false; error: 'not-found' | 'legacy-protocol' }

// Replays a previous multi-zone dispatch by resuming the Architect's session
// and every zone session listed in the DispatchRecord. The canvas is used to
// refresh manifest/prompts — resumed sessions ignore appendSystemPrompt, so
// it's safe to regenerate prompts without breaking the conversation.
export async function resumeDispatch(
  win: BrowserWindow,
  opts: ResumeDispatchOptions,
): Promise<ResumeDispatchResult> {
  killAll()
  const settings = normalizeProjectSettings(opts.settings)

  // Pulled in lazily to avoid a cycle at module top.
  const { getDispatch, DISPATCH_PROTOCOL_VERSION } = await import('./dispatchCapture')
  const record = getDispatch(opts.projectDir, opts.dispatchId)
  if (!record) return { ok: false, error: 'not-found' }

  // Legacy protocol gate: old dispatches were coordinated via .done markers
  // and a different Architect prompt. They can't be resumed under the v2
  // protocol without breaking the resumed Architect's conversation.
  if ((record.protocolVersion ?? 0) < DISPATCH_PROTOCOL_VERSION) {
    return { ok: false, error: 'legacy-protocol' }
  }

  const { zones: allZones } = indexGraph(opts.nodes)
  const zoneById = new Map(allZones.map(z => [z.id, z]))
  const dispatchZones = record.zoneIds
    .map(id => zoneById.get(id))
    .filter((z): z is ZoneGraphNode => !!z)

  const zoneIds = new Set(dispatchZones.map(z => z.id))
  const filteredNodes = opts.nodes.filter(n => n.type !== 'zone' || zoneIds.has(n.id))
  setupWorkspace(opts.projectDir, filteredNodes, opts.edges, settings)

  const info: TerminalInfo[] = [
    { id: 'architect-agent', label: 'Architect', runtime: record.architectRuntime },
  ]

  // Resume each zone with the session pinned in the dispatch record. No
  // initialPrompt / resumeUserPrompt — the zone comes back idle at its
  // prompt. The coordinator pokes it via pty.write on the next task-file
  // update from the Architect.
  for (const zone of dispatchZones) {
    const entry = record.zoneSessions.find(z => z.zoneId === zone.id)
    const runtime = entry?.runtime ?? getZoneRuntime(zone, settings)
    info.push({ id: zone.id, label: zone.data.label, runtime })

    if (!entry) {
      console.warn(`[resume-dispatch] no session id stored for zone ${zone.data.label}, skipping`)
      continue
    }

    const env: Record<string, string> = {}
    for (const { key, value } of zone.data.envVars ?? []) {
      if (key) env[key] = value
    }

    spawnAgentSession({
      win,
      id: zone.id,
      label: zone.data.label,
      runtime,
      env,
      cwd: opts.projectDir,
      model: getZoneModel(zone, runtime),
      resumeSessionId: entry.sessionId,
    })
  }

  startDispatchCoordinator(opts.projectDir, dispatchZones)

  // No resumeUserPrompt — the Architect comes back idle at its prompt, ready
  // for the user's next message. Launch/supervise rules are already in the
  // Architect's conversation history from the original dispatch's system
  // prompt (buildArchitectPrompt), which resumed sessions preserve.
  spawnAgentSession({
    win,
    id: 'architect-agent',
    label: 'Architect',
    runtime: record.architectRuntime,
    env: {},
    cwd: opts.projectDir,
    model: record.model || DEFAULT_MODEL_BY_RUNTIME[record.architectRuntime],
    resumeSessionId: record.architectSessionId,
    planMode: record.planMode === true,
  })

  return { ok: true, info }
}
