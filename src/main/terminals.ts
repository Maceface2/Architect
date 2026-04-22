import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join, basename } from 'path'
import fs from 'fs'
import { execFileSync, spawn } from 'child_process'
import { randomBytes } from 'crypto'
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
import {
  writeMailboxScripts,
  createParticipant,
  writeInboxMessage,
  readInbox,
  readOutbox,
  readParticipantManifest,
  listParticipantIds,
  writeIndex,
  wipeMailboxTree,
  mailboxRoot,
  inboxDir,
  outboxDir,
  scriptsDir,
  MAILBOX_HARNESS_ID,
  MAILBOX_OVERSEER_ID,
  MAILBOX_PROTOCOL_VERSION,
  type MailboxIndex,
  type MailboxMessage,
  type MailboxMessageType,
  type MailboxStructured,
  type ParticipantIndexEntry,
  type ParticipantLifecycle,
} from './mailbox'

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
// PTY lifecycle state machine.
//
//   spawning → running → failed
//
// Transitions:
//   - spawning → running: first PTY output is observed from the spawned CLI
//   - * → failed:         PTY exits while the session is still live
//
// Under v4 (mailbox protocol) the 'finished' state is unused — agents live
// in a continuous listen loop and only exit via pty-close. Per-task state
// lives in ARCHITECT/mailbox/_index.json.participants[*].state, not here.
// ──────────────────────────────────────────────────────────────────────────

export type ZoneLifecycleState = 'spawning' | 'running' | 'failed'

export type ZoneFailureKind = 'binary-missing' | 'pty-exit'

export interface ZoneFailure {
  kind: ZoneFailureKind
  message: string
  ts: number
}

export interface ZoneEvent {
  seq: number
  kind: string            // 'spawn' | 'running' | 'fail' | …
  state: ZoneLifecycleState
  message?: string
  ts: number
}

interface Session {
  pty: pty.IPty
  term: HeadlessTerminal
  lifecycle: ZoneLifecycleState
  events: ZoneEvent[]
  eventSeq: number
  kind: 'agent' | 'shell'
  runtime: AgentRuntime | 'shell'
  createdAt: number
  lastError?: ZoneFailure
  // Recent PTY output tail — fed to `_index.json.tail` for debugger views.
  tail: string
  lastActivityMs: number
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
  // Optional callback fired once a session ID is captured.
  onSessionCaptured?: (sessionId: string) => void
  // Optional callback fired exactly once when capture polling has settled —
  // on success, on timeout, or immediately for spawns that don't capture
  // (resumes, non-capturing runtimes). Passes the captured id or null.
  // Callers use this to serialize spawn ordering: wait for one zone's
  // session file to land on disk before snapshotting the next zone.
  onCaptureSettled?: (sessionId: string | null) => void
}

const sessions = new Map<string, Session>()
let activeDispatchCoordinator: { stop: () => void } | null = null

// Per-session capture readiness. 'pending' means a fresh spawn is still polling
// for its new CLI session id; 'ready' means capture settled (resolved or timed
// out). Used by the renderer's close-terminal flow to block close until the
// id has been persisted. Shell and resumed sessions are never added here —
// absence means "no capture in flight, close is safe."
type CaptureState = 'pending' | 'ready'
const captureStates = new Map<string, CaptureState>()

function setCaptureReady(id: string): void {
  captureStates.set(id, 'ready')
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
      // `--continue` alone means "continue THE LAST session" (boolean, no id).
      // `--session <id>` is the explicit form — "continue THIS session".
      // Passing both is contradictory; opencode's order-/version-dependent
      // resolution in that case would often pick "last" and ignore the id,
      // silently loading the wrong conversation (e.g. every resumed zone
      // ended up on the Architect's session because Architect was the
      // most-recently-spawned opencode instance). Use the explicit flag.
      const args: string[] = []
      if (resumeSessionId) args.push('--session', resumeSessionId)
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
}

const TAIL_MAX_BYTES = 4_000

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
    createdAt: Date.now(),
    tail: '',
    lastActivityMs: Date.now(),
  }
  sessions.set(id, session)
  pushEvent(session, 'spawn', `pty spawned (${runtime})`)

  ptyProcess.onData(data => {
    // Always broadcast the raw stream so the renderer's xterm instance
    // sees the exact same bytes.
    if (kind === 'agent' && session.lifecycle === 'spawning') {
      setLifecycle(id, session, 'running', 'running', 'PTY output observed')
    }
    broadcast('terminal:data', { id, data })
    session.lastActivityMs = Date.now()
    session.tail = (session.tail + data).slice(-TAIL_MAX_BYTES)
  })

  ptyProcess.onExit(({ exitCode }) => {
    broadcast('terminal:exit', { id, exitCode })
    // Identity-check: a resume may have already replaced this entry.
    if (sessions.get(id) === session) {
      if (kind === 'agent' && session.lifecycle !== 'failed') {
        failSession(id, session, 'pty-exit', `PTY exited with code ${exitCode ?? 0}`)
      }
      try { session.term.dispose() } catch {}
      sessions.delete(id)
    }
    onExit?.()
  })
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
  onSessionCaptured,
  onCaptureSettled,
}: SpawnAgentOptions): TerminalInfo {
  // Reset any capture state from a prior spawn at this id (e.g. resume replacing
  // a fresh session). captureRuntime below will re-mark 'pending' if needed.
  captureStates.delete(id)

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

  if (captureRuntime && capture) {
    captureStates.set(id, 'pending')
    broadcast('terminal:capture-state', { id, state: 'pending' })

    let capturedId: string | null = null
    let settled = false

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
        capturedId = sessionId
        onSessionCaptured?.(sessionId)
      } catch (err) {
        console.error(`[session-capture] ${capture.zoneKey}: failed to save`, err)
      }
    }

    const markReady = (): void => {
      setCaptureReady(id)
      broadcast('terminal:capture-state', { id, state: 'ready' })
      if (!settled) {
        settled = true
        try { onCaptureSettled?.(capturedId) } catch (err) {
          console.error(`[session-capture] ${capture.zoneKey}: onCaptureSettled threw`, err)
        }
      }
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
  } else {
    // Not capturing (resume or non-capturing runtime). Still signal settled
    // so callers that await onCaptureSettled don't hang.
    try { onCaptureSettled?.(null) } catch (err) {
      console.error(`[session-capture] ${id}: onCaptureSettled threw`, err)
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

// Kills agent and assistant sessions; preserves user shell sessions.
export function killAll() {
  activeDispatchCoordinator?.stop()
  activeDispatchCoordinator = null
  for (const [id, session] of sessions) {
    if (id.startsWith(SHELL_ID_PREFIX)) continue
    try { session.pty.kill() } catch {}
    try { session.term.dispose() } catch {}
    sessions.delete(id)
    captureStates.delete(id)
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
  }
  return { ok: true }
}

function sanitize(label: string) {
  return label.replace(/[^a-zA-Z0-9-_]/g, '-')
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
  dispatchContext: { isRedispatch: boolean; changedNodeLabels: string[] } | undefined,
  userPrompt: string | undefined,
  projectDir: string,
): string {
  const architectDir = join(projectDir, 'ARCHITECT')
  const outputsDir = join(architectDir, 'outputs')
  const scriptsPath = join(architectDir, 'scripts')
  const mailboxPath = join(architectDir, 'mailbox')
  const indexJson = join(mailboxPath, '_index.json')
  const manifestPath = join(architectDir, 'manifest.json')
  const architectLog = join(outputsDir, 'Architect.md')
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
      `Participant ID: \`${sanitize(zone.data.label)}\``,
      zone.data.description ? `Zone description: ${zone.data.description}` : '',
      `Runtime: ${getAgentRuntime(runtime).label}`,
      `Model: ${model}`,
      `Components owned by this zone (reference — do not assume all must change):\n${componentLines}`,
      upstream.length ? `Upstream zones: ${upstream.join(', ')}` : '',
      downstream.length ? `Downstream zones: ${downstream.join(', ')}` : '',
      `Output log (zone writes): ${join(outputsDir, `${sanitize(zone.data.label)}.md`)}`,
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
    : `## Task (from user)\n(No task provided. Ask the user for one before dispatching any tasks.)`

  return `You are the **Architect** (Overseer) agent coordinating a multi-agent system. Your participant ID is \`overseer\`. Every zone below is already running — a separate interactive CLI session sitting in a listen loop, waiting for task messages from you. You dispatch work by sending messages to each zone's inbox through the mailbox scripts; the zones respond with result messages in your inbox. This is the only dispatch mechanism.

DO NOT use the Task tool or spawn sub-agents. Do NOT write files under \`${architectDir}/tasks/\` (that directory is gone). Do NOT poll \`${architectDir}/zones/*/status.json\` (gone). Coordinate exclusively through the mailbox. You are the orchestrator — never hand control back to the user asking them to trigger the zones. You trigger them.

**PATHS:** Every path in this prompt is ABSOLUTE. Use them verbatim when reading or writing. Your working directory is ${projectDir}.

${taskSection}

## Architecture Context (reference)
The user has designed the following system. Use it ONLY to understand where responsibilities live and how zones relate. This is NOT a build list. Do NOT rebuild components that already exist. Do NOT assume every zone needs work — only engage the zones required by the user's task above.

${buildMermaidDiagram(zones, componentsByZone, zoneEdges)}

## Zones available to you
${agentList}

## Inter-zone data flow
${flowLines}${unassignedSection}

## The mailbox protocol

All coordination flows through \`${mailboxPath}/\` as JSON messages. Every participant owns a mailbox directory:

- \`${mailboxPath}/overseer/\` — YOUR mailbox. Inbox holds messages from zones + synthetic events from the harness. Outbox is your audit log.
- \`${mailboxPath}/<participant-id>/\` — one per zone, using the \`<safe>\` id in the zone list above.
- \`${indexJson}\` — harness-owned live snapshot of every participant's state. Read it to check liveness without polling scripts.

### Helper scripts (already executable)

Three scripts are in \`${scriptsPath}/\`:

- \`mailbox-drain.sh overseer\` — Returns every \`pending\` message in your inbox as a FIFO JSON array, marks them all \`read\`. **Use this to pull work.**
- \`mailbox-send.sh <to> <type> <content-file> [inReplyTo]\` — Sends a message. Body is passed as a file path (not argv) to dodge ARG_MAX.
- \`mailbox-status.sh\` — JSON summary of every participant's inbox/outbox counts.

All scripts need these environment variables (already set for your session):
\`MBX_ROOT\`, \`MBX_SELF\` (= \`overseer\`), \`MBX_SELF_LABEL\`, \`MBX_DISPATCH_ID\`.

### Message types

When you \`mailbox-drain.sh\` your inbox, each element is one of:

| From | Type | Meaning |
|---|---|---|
| zone | \`result\` | A zone finished a task. \`structured.result\` is \`success\` / \`blocked\` / \`failed\`; \`structured.summary\` is a one-liner. \`inReplyTo\` points to the \`task\` message you sent. |
| zone | \`question\` | A zone needs more info to finish its task. Reply with an \`answer\` message. |
| \`__harness__\` | \`harness.pty-exit\` | A zone's CLI exited. You won't get more messages from it this dispatch — surface to the user. |
| \`__harness__\` | \`harness.delivery-warning\` | A task message has been sitting \`pending\` in a zone's inbox for >45s — the zone may have broken its listen loop. A \`harness.wake\` nudge has already been sent to the zone. Give it another ~30s before reacting. |
| \`__harness__\` | \`harness.heartbeat-missed\` | A zone has an in-flight task but hasn't touched \`outputs/<safe>.md\` in 90s+. It may be stuck on a long tool call — give it time, but consider surfacing if it persists. |
| \`__harness__\` | \`harness.timeout\` | A zone exceeded its 30-min per-task timeout without sending a \`result\`. Inspect outputs, then decide whether to re-task, narrow scope, or escalate to user. |

Messages from \`__harness__\` are ground truth, not peer claims — trust them.

### Sending a task

\`\`\`bash
# Write the task body to a tmpfile
TASK="\$(mktemp -t task.XXXXXX)"
cat > "\$TASK" <<'EOF'
Restate user's goal for this zone.
Name concrete files/endpoints to touch.
Spell out API contracts at seams with other zones.
Point to upstream outputs if relevant.
Acceptance criteria.
EOF

# Send it — capture the msg id for later correlation
MSG_ID="\$(bash \${MBX_SCRIPTS}/mailbox-send.sh <zone-participant-id> task "\$TASK")"
rm -f "\$TASK"
# Remember MSG_ID → zone so you can match the zone's result (it'll come back with inReplyTo = MSG_ID).
\`\`\`

(Or: just craft each \`mailbox-send.sh\` call directly in one Bash tool use — \`<heredoc>\` into a temp file, send, remove.)

### Sending an answer, cancel, or follow-up

Same pattern; pass the original message id as the last argument to set \`inReplyTo\`:

\`\`\`bash
bash \${MBX_SCRIPTS}/mailbox-send.sh <zone> answer "\$TMPFILE" "\$ORIG_MSG_ID"
\`\`\`

### Your main loop

You MUST live in a drain-and-plan loop. Never stop. The only way out is the user ending the session.

1. **Initialize**: Read \`${manifestPath}\` and the Mermaid diagram above. Decide which zones the user's task actually needs. Zones you don't dispatch stay idle — that is correct when the task doesn't touch them.

2. **Dispatch first round**: For each zone you're engaging, send a \`task\` message (upstream first, so downstream zones get concrete interfaces to consume). Record each outgoing \`task\` msg id → zone mapping.

3. **Wait for events**:
   \`\`\`bash
   bash \${MBX_SCRIPTS}/mailbox-listen.sh overseer 30
   \`\`\`
   This blocks up to 30s. It returns when any message lands in your inbox; timeout (exit 1) is fine — just means the zones are still working quietly.

4. **Drain**:
   \`\`\`bash
   bash \${MBX_SCRIPTS}/mailbox-drain.sh overseer
   \`\`\`
   Parse the JSON array. For each message, apply the dispositions above.

5. **Plan next step**. Based on the results you've collected: if a downstream zone now has the interface it was waiting on, dispatch its task. If all engaged zones returned \`success\`, summarize and report back to the user. If a zone returned \`blocked\` or \`failed\`, read its \`outputs/<safe>.md\` for partial progress, then decide: re-task (new \`task\` message) or escalate to user. Handle \`harness.*\` events per the table above.

6. **GO BACK TO STEP 3**. Always listen again. Do not stop to ask "should I continue?" — the loop is the job.

### Reading a zone's narrative

\`${outputsDir}/<safe>.md\` is a zone's free-form progress scratchpad — read it for context when a result summary isn't enough, and definitely read it on any blocker/failure.

### Write your own log

Append a line to \`${architectLog}\` whenever you dispatch a task or receive a notable result. Keep it terse — future-you (on resume) will skim it.

IMPORTANT: Zones create all real project files (source code, configs, etc.) directly in the project root (${projectDir}), NOT inside ${architectDir}/. The ${architectDir}/ folder is only for coordination (manifests, prompts, mailbox, outputs, scripts). Do not create project files yourself.

Start by dispatching the first round of tasks for the zones the user's task requires, then enter the drain-and-plan loop.${dispatchContext?.isRedispatch
    ? `\n\n## Execution Mode\nREDISPATCH — existing outputs may be present in ${outputsDir}/. Mailbox state is fresh for this dispatch.\n${dispatchContext.changedNodeLabels.length > 0
        ? `The following zones have changed since the last dispatch and likely need attention: ${dispatchContext.changedNodeLabels.join(', ')}.\nStill, only engage zones the user's task actually requires.`
        : `No zone configurations changed. Only engage zones the user's task requires.`}`
    : ''}`
}

// Zone prompt has two shapes:
//   - 'dispatch' — the zone is part of a multi-zone dispatch with an Overseer.
//     Teaches the mailbox listen-and-respond loop; the agent lives in that loop.
//   - 'solo' — the zone was launched standalone (ZoneLaunchModal Play button, or
//     a single-zone startDispatch). No Overseer is running and MBX_* env vars are NOT
//     set, so the prompt must not reference mailbox scripts. The agent works
//     directly with the user.
// The identity / components / skills / behavior header is shared; only the
// Instructions suffix differs.
function buildZoneSystemPrompt(
  zone: ZoneGraphNode,
  componentsByZone: Map<string, ComponentGraphNode[]>,
  zoneEdges: GraphEdge[],
  intraEdges: GraphEdge[],
  zones: ZoneGraphNode[],
  projectDir: string,
  mode: 'dispatch' | 'solo',
): string {
  const safe = sanitize(zone.data.label)
  const architectDir = join(projectDir, 'ARCHITECT')
  const scriptsPath = join(architectDir, 'scripts')
  const statusLog = join(architectDir, 'outputs', `${safe}.md`)

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

  const header = `You are the **${zone.data.label}** zone-agent. Your participant ID is \`${safe}\`.
${zone.data.description ? `Zone description: ${zone.data.description}\n` : ''}
${upstream.length ? `Upstream zones (read their output logs when referenced): ${upstream.map(label => join(architectDir, 'outputs', `${sanitize(label as string)}.md`)).join(', ')}\n` : ''}${downstream.length ? `Downstream zones depending on you: ${downstream.join(', ')}\n` : ''}${tools.length ? `Enabled tools: ${tools.join(', ')}\n` : ''}
## What you own (reference)

These components live in your zone on the architecture canvas. This is context about the parts of the system you are responsible for — NOT a build list. The current task may touch none, some, or all of them. Treat anything outside what you're asked to do as existing context you should leave alone.

${compList}

## Internal wiring (reference)

${archLines}

${skills ? `## Skills\n\n${skills}\n\n` : ''}${userSystem ? `## Behavior\n\n${userSystem}\n\n` : ''}`

  if (mode === 'solo') {
    return header + `## Instructions

This zone was launched **standalone** — no Architect/Overseer is coordinating you and no mailbox is wired up. You work **directly with the user**: they prompt you, you respond, you do the work.

**PATHS:** Your working directory is ${projectDir}. All paths referenced in this prompt are absolute.

**WHERE TO CREATE FILES:**
- All project files (source, configs, scripts, etc.) go directly in the project root (${projectDir}). Do NOT put them inside ${architectDir}/.
- ${architectDir}/ is reserved for coordination state (prompts, outputs, mailbox, scripts) — it's fine to append to ${statusLog} as a progress scratchpad, but don't create new artifacts there.

**Progress log:** append a line per significant step to \`${statusLog}\` so later dispatches (or the user reading after the fact) can see what you did.

Do NOT try to run \`mailbox-listen.sh\`, \`mailbox-send.sh\`, or reference a participant inbox — those scripts are for multi-zone dispatches and won't work here (the \`MBX_*\` env vars aren't set). Just respond to the user's prompt directly.

Work fully autonomously — do not stop to ask for clarification unless the user's request is genuinely ambiguous.`
  }

  return header + `## Instructions — Mailbox protocol

The Architect (participant id \`overseer\`) dispatches work to you as messages in your inbox at \`${architectDir}/mailbox/${safe}/inbox/\`. You receive work by running a blocking listen script; you respond by running a send script. Helper scripts live in \`${scriptsPath}/\` with \`MBX_ROOT\`, \`MBX_SELF\` (= \`${safe}\`), \`MBX_SELF_LABEL\`, \`MBX_DISPATCH_ID\` already exported in your shell.

**PATHS:** Every path in this prompt is ABSOLUTE. Use them verbatim. Your working directory is ${projectDir}.

**WHERE TO CREATE FILES:**
- All project files (source, configs, scripts, etc.) go directly in the project root (${projectDir}). Do NOT put them inside ${architectDir}/.
- ${architectDir}/ is only for coordination (mailbox, prompts, outputs, scripts).
- ${statusLog} is your progress scratchpad — append a line per significant step. The harness polls its mtime as a heartbeat; long silences trigger a \`harness.heartbeat-missed\` event.

Work fully autonomously — do not stop to ask for clarification.

## Your listen-and-respond loop

You MUST live in the loop below. Never stop calling \`mailbox-listen.sh\`. The only way out is the PTY being killed by the user.

1. **Listen** (blocks until a message arrives):
   \`\`\`bash
   bash ${scriptsPath}/mailbox-listen.sh ${safe}
   \`\`\`
   Stdout on return: lines like \`MESSAGE_ID=...\`, \`FROM=...\`, \`TO=...\`, \`FROM_LABEL=...\`, \`TYPE=...\`, \`IN_REPLY_TO=...\`, optionally \`STRUCTURED=<json>\`, then a \`---\` separator, then the content body. Parse these.

2. **Dispatch on TYPE**:

   - \`task\` — the Architect has work for you. Read the content body; it describes what to build or change. Do the work using your normal tools (Read, Edit, Bash, etc). As you work, append one-liner progress notes to \`${statusLog}\`. When done (success, blocked, or failed), go to step 3 with a \`result\` message.

   - \`answer\` — the Architect is replying to a \`question\` you asked. Use the new info to continue the task you were mid-way through. Then eventually reply with \`result\`.

   - \`cancel\` — the Architect wants you to abort. Stop the current task cleanly if you can, then send a \`result\` with \`structured.result = "blocked"\` and \`structured.blocker.kind = "cancelled"\`. (After 60s of not responding, the harness will hard-cancel via SIGINT.)

   - \`harness.wake\` — a liveness nudge from the harness. No-op; just loop back to step 1.

   - Any \`session-ended\` or unknown type — note it and loop back.

3. **Respond with a \`result\`** when you finish a task:
   \`\`\`bash
   BODY="\$(mktemp -t result.XXXXXX)"
   cat > "\$BODY" <<'EOF'
   One-line human-readable summary, then optional longer detail.
   For success: what you produced (files, endpoints, interfaces).
   For blocked/failed: concrete blocker (e.g. "file X does not exist").
   EOF

   STRUCT="\$(mktemp -t result.struct.XXXXXX)"
   cat > "\$STRUCT" <<EOF
   {
     "taskId": "<task_id-if-structured-had-one>",
     "result": "success",
     "durationMs": 12345
   }
   EOF
   # For blocked/failed:
   # "result": "blocked", "blocker": { "kind": "missing-file", "message": "…" }

   MBX_STRUCTURED_FILE="\$STRUCT" \\
     bash ${scriptsPath}/mailbox-send.sh overseer result "\$BODY" "\$MESSAGE_ID"
   rm -f "\$BODY" "\$STRUCT"
   \`\`\`
   The \`inReplyTo\` (last positional arg, = the task's \`MESSAGE_ID\`) lets the Architect correlate your result with its outbound task.

4. **If you need more info to finish the task**, send a \`question\` instead of a \`result\`, also with \`inReplyTo = MESSAGE_ID\`:
   \`\`\`bash
   bash ${scriptsPath}/mailbox-send.sh overseer question "\$BODY" "\$MESSAGE_ID"
   \`\`\`
   The Architect will drain it, respond with an \`answer\` (which you'll pick up on the next \`mailbox-listen.sh\` call), and you continue.

5. **IMMEDIATELY loop back to step 1.** After every response — even a non-op — run \`mailbox-listen.sh\` again. Never stop to ask the user what to do next. The loop is the job.

## Including real code in responses

When the Architect asks "what interfaces did you produce?", don't just describe — include actual file contents, type definitions, function signatures in your \`result\` body. Read the relevant files and paste the important parts. Downstream zones will consume your result to write their own code; prose alone is not enough.

## Rules

- **Never break the loop.** After every action, call \`mailbox-listen.sh\` again.
- **Use \`FROM\` from the message as the recipient** when replying — don't hardcode \`overseer\` (though it's almost always \`overseer\`).
- **Use \`MESSAGE_ID\` from the task as \`inReplyTo\`** on your result/question — this is how the Architect correlates.
- **Append to \`${statusLog}\`** during work. The harness mtime-watches this file.
- **Never write to \`${architectDir}/tasks/\` or \`${architectDir}/zones/\`** — those directories are gone in this protocol version.`
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
  for (const dir of ['outputs', 'prompts', 'sessions', 'dispatches'].map(name => join(base, name))) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const { zones, componentsByZone, unassignedComponents } = indexGraph(nodes)
  const zoneIdSet = new Set(zones.map(z => z.id))
  const zoneEdges = edges.filter(e => zoneIdSet.has(e.source) && zoneIdSet.has(e.target))
  const intraEdges = edges.filter(e => !zoneIdSet.has(e.source) && !zoneIdSet.has(e.target))

  fs.writeFileSync(join(base, 'manifest.json'), JSON.stringify({
    generated: new Date().toISOString(),
    defaultRuntime: settings.defaultRuntime,
    protocolVersion: MAILBOX_PROTOCOL_VERSION,
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
      const safe = sanitize(zone.data.label)
      return {
        id: zone.id,
        label: zone.data.label,
        participantId: safe,
        description: zone.data.description,
        runtime,
        runtimeLabel: getAgentRuntime(runtime).label,
        model: getZoneModel(zone, runtime),
        systemPrompt: zone.data.systemPrompt || null,
        inboxDir: `ARCHITECT/mailbox/${safe}/inbox`,
        outboxDir: `ARCHITECT/mailbox/${safe}/outbox`,
        outputFile: `ARCHITECT/outputs/${safe}.md`,
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
  fs.writeFileSync(join(base, 'prompts', 'architect.md'), buildArchitectPrompt(zones, componentsByZone, unassignedComponents, edges, settings, dispatchContext, userPrompt, projectDir))
  for (const zone of zones) {
    fs.writeFileSync(join(base, 'prompts', `${sanitize(zone.data.label)}.md`), buildZoneSystemPrompt(zone, componentsByZone, zoneEdges, intraEdges, zones, projectDir, 'dispatch'))
  }

  // Mailbox scaffold — scripts + per-participant dirs. Idempotent: overwrites
  // scripts (so script fixes land on every dispatch) and only creates
  // participant dirs that don't already exist (so resumes preserve prior
  // messages in inboxes/outboxes).
  writeMailboxScripts(projectDir)
  const existing = new Set(listParticipantIds(projectDir))
  const ensure = (id: string, role: 'overseer' | 'zone', label: string) => {
    if (!existing.has(id)) createParticipant(projectDir, { id, role, label })
  }
  ensure(MAILBOX_OVERSEER_ID, 'overseer', 'Architect')
  for (const zone of zones) {
    ensure(sanitize(zone.data.label), 'zone', zone.data.label)
  }
}

// Mailbox observer timing knobs (v4).
//   DEFAULT_TASK_TIMEOUT_MS — per-task 30-min cap; zone config can only extend it.
//   DELIVERY_WARNING_MS    — how long a `task` msg may sit `pending` in a zone inbox before we
//                            emit `harness.delivery-warning` to the Overseer + `harness.wake` to the zone.
//   IDLE_THRESHOLD_MS      — staleness threshold on BOTH outputs/<safe>.md mtime AND PTY
//                            lastActivityMs for heartbeat checks. A zone is considered idle
//                            only when BOTH signals go quiet; either one advancing keeps it live.
//                            Set to 2 min: the PTY byte stream covers long tool calls (spinner,
//                            reasoning, Bash output), so genuine silence across both channels
//                            for 2 min is a reasonable early warning. Hard failure is still
//                            DEFAULT_TASK_TIMEOUT_MS (30 min) via harness.timeout.
//   HEARTBEAT_POLL_MS      — how often the heartbeat scan fires.
//   HARD_CANCEL_MS         — after this long with an unconsumed `cancel` msg, SIGINT the zone PTY.
//   AWAIT_READY_SOFT_MS    — soft gate on the one-shot bootstrap poke; on miss we poke anyway.
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000
const DELIVERY_WARNING_MS = 45_000
const IDLE_THRESHOLD_MS = 2 * 60_000
const HEARTBEAT_POLL_MS = 15_000
const HARD_CANCEL_MS = 60_000
const AWAIT_READY_SOFT_MS = 10_000
// Per-zone hard ceiling on serialized session capture during startDispatch.
// Session files typically land within 1–3 s of PTY spawn; this cap exists so
// a misconfigured CLI can't wedge the rest of the dispatch. Set well below
// each runtime's own poll timeout (30 s claude / 90 s codex/gemini/opencode)
// so a late capture can still fire its onSessionCaptured upsert in the
// background after we've moved on.
const CAPTURE_SERIAL_TIMEOUT_MS = 20_000

// The Architect session's terminal id (unchanged from v3).
const ARCHITECT_SESSION_ID = 'architect-agent'

// Observer for a multi-zone dispatch. All participants (Overseer + zones)
// must already have mailboxes scaffolded by setupWorkspace. The observer:
//   - watches every participant's inbox/outbox for IPC broadcasts and _index.json
//     refreshes (renderer observability)
//   - watches zone inboxes for new `task` / `cancel` msgs and sets timers:
//       task → DELIVERY_WARNING_MS → if still `pending`, inject harness.delivery-warning
//                                    + harness.wake; also DEFAULT_TASK_TIMEOUT_MS → harness.timeout
//       cancel → HARD_CANCEL_MS → if still `pending`, SIGINT the zone PTY
//   - watches zone outboxes for `result` msgs that resolve in-flight tasks
//   - runs a heartbeat loop that checks outputs/<safe>.md mtime against
//     IDLE_THRESHOLD_MS for zones with in-flight tasks
//   - hooks PTY exit to inject harness.pty-exit + flip participant to 'exited'
//     in _index.json (tombstone: the participant dir is NOT removed)
function startMailboxObserver(
  projectDir: string,
  zones: ZoneGraphNode[],
  dispatchId: string,
): { stop: () => void } {
  const zoneBySafe = new Map(zones.map(z => [sanitize(z.data.label), z]))
  const outputsDir = join(projectDir, 'ARCHITECT', 'outputs')
  fs.mkdirSync(outputsDir, { recursive: true })

  // In-flight tasks keyed by the task msgId. The harness learns about outgoing
  // tasks by watching each zone's inbox — we don't trust outgoing msgIds from
  // the overseer's outbox (same content, but inbox is the authoritative place
  // the zone will pick from). `startedAt` anchors the heartbeat check so
  // leftover outputs/<safe>.md from prior dispatches don't trigger a false
  // harness.heartbeat-missed the instant a new task arrives.
  interface TaskTracker {
    zone: string
    filename: string
    startedAt: number
    deliveryTimer: NodeJS.Timeout
    timeoutTimer: NodeJS.Timeout
  }
  const taskTrackers = new Map<string, TaskTracker>()
  const cancelTimers = new Map<string, NodeJS.Timeout>()
  const resolvedTaskIds = new Set<string>()
  const heartbeatEmittedFor = new Set<string>() // dedupe heartbeat-missed per task

  const watchers: fs.FSWatcher[] = []
  const ptyUnsubs: Array<() => void> = []

  function sessionIdForParticipant(pid: string): string | null {
    if (pid === MAILBOX_OVERSEER_ID) return ARCHITECT_SESSION_ID
    const zone = zoneBySafe.get(pid)
    return zone?.id ?? null
  }

  function broadcastActivity(participantId: string, direction: 'inbox' | 'outbox', filename: string, msg?: MailboxMessage): void {
    broadcast('mailbox:activity', {
      dispatchId,
      participantId,
      direction,
      filename,
      msgId: msg?.id,
      type: msg?.type,
      from: msg?.from,
      to: msg?.to,
    })
  }

  function injectHarnessMessage(
    to: string,
    type: MailboxMessageType,
    content: string,
    structured?: MailboxStructured,
  ): void {
    const result = writeInboxMessage({
      projectDir,
      from: MAILBOX_HARNESS_ID,
      fromLabel: 'Harness',
      to,
      type,
      content,
      structured: structured ?? null,
      dispatchId,
    })
    if (!result.ok) {
      console.warn(`[mailbox-observer] failed to inject ${type} to ${to}: ${result.error}`)
    }
  }

  function readMessageFile(path: string): MailboxMessage | null {
    try { return JSON.parse(fs.readFileSync(path, 'utf-8')) as MailboxMessage } catch { return null }
  }

  function scheduleTaskTimers(zone: ZoneGraphNode, safe: string, msg: MailboxMessage, filename: string): void {
    // Dedupe: fs.watch on macOS fires multiple events per atomic rename
    // (rename + change), which would otherwise arm a second pair of timers
    // and produce duplicate harness.* messages. Identity-keyed by msg.id.
    if (taskTrackers.has(msg.id)) return

    // v4 task timeout is for zone liveness, not for zone configuration. The
    // UI's `behavior.timeoutMs` default (30s) was a v3 step-level concept
    // with different semantics; respecting it here makes every real task
    // time out after ~60s. Take the MAX of the default + any user override,
    // so configuration can only extend the timeout, never shorten it.
    const zoneOverride = zone.data?.behavior?.timeoutMs ?? 0
    const timeoutMs = Math.max(DEFAULT_TASK_TIMEOUT_MS, zoneOverride)
    const deliveryTimer = setTimeout(() => {
      // Re-read the message file. If the zone consumed it (`read`), we're fine.
      const full = join(inboxDir(projectDir, safe), filename)
      const live = readMessageFile(full)
      if (!live || live.status !== 'pending') return
      injectHarnessMessage(
        MAILBOX_OVERSEER_ID,
        'harness.delivery-warning',
        `Zone ${safe} has not consumed task ${msg.id} within ${DELIVERY_WARNING_MS / 1000}s. A harness.wake nudge has been sent to the zone.`,
        { taskId: msg.id },
      )
      injectHarnessMessage(
        safe,
        'harness.wake',
        `Still listening? Task ${msg.id} is waiting in your inbox.`,
        { taskId: msg.id },
      )
    }, DELIVERY_WARNING_MS)

    const timeoutTimer = setTimeout(() => {
      if (resolvedTaskIds.has(msg.id)) return
      injectHarnessMessage(
        MAILBOX_OVERSEER_ID,
        'harness.timeout',
        `Zone ${safe} has not returned a result for task ${msg.id} within ${Math.round(timeoutMs / 1000)}s.`,
        { taskId: msg.id, durationMs: timeoutMs },
      )
    }, timeoutMs)

    taskTrackers.set(msg.id, { zone: safe, filename, startedAt: Date.now(), deliveryTimer, timeoutTimer })
  }

  function scheduleHardCancel(safe: string): void {
    const prev = cancelTimers.get(safe)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => {
      cancelTimers.delete(safe)
      const sessionId = sessionIdForParticipant(safe)
      if (!sessionId) return
      const session = sessions.get(sessionId)
      if (!session) return
      console.log(`[mailbox-observer] hard-cancel SIGINT to ${safe}`)
      try { session.pty.kill('SIGINT') } catch {}
    }, HARD_CANCEL_MS)
    cancelTimers.set(safe, timer)
  }

  function clearTaskTracker(msgId: string): void {
    const tracker = taskTrackers.get(msgId)
    if (!tracker) return
    clearTimeout(tracker.deliveryTimer)
    clearTimeout(tracker.timeoutTimer)
    taskTrackers.delete(msgId)
    resolvedTaskIds.add(msgId)
    heartbeatEmittedFor.delete(msgId)
  }

  function onZoneInboxWrite(safe: string, name: string): void {
    const full = join(inboxDir(projectDir, safe), name)
    const msg = readMessageFile(full)
    if (!msg) return
    broadcastActivity(safe, 'inbox', name, msg)
    refreshIndex()
    // Skip our own synthetic writes (they shouldn't schedule new timers).
    if (msg.from === MAILBOX_HARNESS_ID) return
    const zone = zoneBySafe.get(safe)
    if (!zone) return
    if (msg.type === 'task') {
      scheduleTaskTimers(zone, safe, msg, name)
    } else if (msg.type === 'cancel') {
      scheduleHardCancel(safe)
    }
  }

  function onZoneOutboxWrite(safe: string, name: string): void {
    const full = join(outboxDir(projectDir, safe), name)
    const msg = readMessageFile(full)
    if (!msg) return
    broadcastActivity(safe, 'outbox', name, msg)
    // A zone's `result` (with inReplyTo) closes the loop on a tracked task.
    if (msg.type === 'result' && msg.inReplyTo) {
      clearTaskTracker(msg.inReplyTo)
    }
    refreshIndex()
  }

  function onOverseerInboxWrite(name: string): void {
    const full = join(inboxDir(projectDir, MAILBOX_OVERSEER_ID), name)
    const msg = readMessageFile(full)
    broadcastActivity(MAILBOX_OVERSEER_ID, 'inbox', name, msg ?? undefined)
    refreshIndex()
  }

  function onOverseerOutboxWrite(name: string): void {
    const full = join(outboxDir(projectDir, MAILBOX_OVERSEER_ID), name)
    const msg = readMessageFile(full)
    broadcastActivity(MAILBOX_OVERSEER_ID, 'outbox', name, msg ?? undefined)
    refreshIndex()
  }

  function watchDir(dir: string, handler: (name: string) => void): void {
    fs.mkdirSync(dir, { recursive: true })
    const w = fs.watch(dir, (_event, filename) => {
      if (!filename) return
      const name = String(filename)
      if (!name.endsWith('.json')) return
      // Small debounce: let atomic rename settle.
      setTimeout(() => handler(name), 30)
    })
    watchers.push(w)
  }

  function checkHeartbeats(): void {
    const now = Date.now()
    for (const [msgId, tracker] of taskTrackers.entries()) {
      if (heartbeatEmittedFor.has(msgId)) continue
      const outPath = join(outputsDir, `${tracker.zone}.md`)
      let mtime: number | null = null
      try { mtime = fs.statSync(outPath).mtimeMs } catch { mtime = null }

      // Liveness is the MAX of three signals:
      //   (a) outputs/<safe>.md mtime — if agent is writing progress notes
      //   (b) PTY lastActivityMs     — if CLI is streaming ANY bytes (tool
      //       output, reasoning traces, UI redraws). This catches long Edit
      //       or Bash calls where the agent is clearly alive but not
      //       appending to the scratchpad.
      //   (c) tracker.startedAt      — floor that prevents stale pre-task
      //       mtime from tripping an immediate false positive at task start.
      // We fire heartbeat-missed only when ALL three have been quiet long
      // enough, i.e. the zone is genuinely silent on every observable
      // channel.
      const sessionId = sessionIdForParticipant(tracker.zone)
      const session = sessionId ? sessions.get(sessionId) : undefined
      const ptyActivity = session?.lastActivityMs ?? 0
      const activityFloor = Math.max(
        mtime ?? 0,
        ptyActivity,
        tracker.startedAt,
      )
      const age = now - activityFloor
      if (age < IDLE_THRESHOLD_MS) continue
      injectHarnessMessage(
        MAILBOX_OVERSEER_ID,
        'harness.heartbeat-missed',
        `Zone ${tracker.zone} has produced no output (no outputs/${tracker.zone}.md write, no PTY activity) in ${Math.round(age / 1000)}s while task ${msgId} is in flight.`,
        { taskId: msgId },
      )
      heartbeatEmittedFor.add(msgId)
    }
    refreshIndex()
  }

  const heartbeatTimer = setInterval(checkHeartbeats, HEARTBEAT_POLL_MS)

  function computeParticipantState(participantId: string): { state: ParticipantLifecycle; exitCode?: number } {
    const sessionId = sessionIdForParticipant(participantId)
    if (!sessionId) return { state: 'unknown' }
    const session = sessions.get(sessionId)
    if (!session) return { state: 'exited' }
    if (session.lifecycle === 'failed') return { state: 'exited' }
    if (session.lifecycle === 'spawning') return { state: 'starting' }
    const hasInFlight = Array.from(taskTrackers.values()).some(t => t.zone === participantId)
    if (hasInFlight) return { state: 'running' }
    const idleMs = Date.now() - session.lastActivityMs
    if (idleMs > IDLE_THRESHOLD_MS) return { state: 'unknown' }
    return { state: 'idle' }
  }

  function refreshIndex(): void {
    try {
      const participants: Record<string, ParticipantIndexEntry> = {}
      for (const pid of listParticipantIds(projectDir)) {
        if (pid.startsWith('.')) continue
        const manifest = readParticipantManifest(projectDir, pid)
        const role = manifest?.role ?? (pid === MAILBOX_OVERSEER_ID ? 'overseer' : 'zone')
        const label = manifest?.label ?? pid
        const inbox = readInbox(projectDir, pid)
        const outbox = readOutbox(projectDir, pid)
        const pendingCount = inbox.filter(m => m.status === 'pending').length
        const pendingTaskIds = Array.from(taskTrackers.entries())
          .filter(([, t]) => t.zone === pid)
          .map(([msgId]) => msgId)
        const { state, exitCode } = computeParticipantState(pid)
        const session = (() => {
          const sid = sessionIdForParticipant(pid)
          return sid ? sessions.get(sid) : undefined
        })()
        participants[pid] = {
          role,
          label,
          state,
          lastActivityMs: session?.lastActivityMs ?? 0,
          exitCode,
          pendingTaskIds,
          inboxPending: pendingCount,
          outboxCount: outbox.length,
          tail: session?.tail ?? '',
        }
      }
      const index: MailboxIndex = {
        dispatchId,
        protocolVersion: MAILBOX_PROTOCOL_VERSION,
        updatedAt: new Date().toISOString(),
        participants,
      }
      writeIndex(projectDir, index)
    } catch (err) {
      console.error('[mailbox-observer] refreshIndex failed', err)
    }
  }

  function hookPtyExit(participantId: string, sessionId: string): void {
    const session = sessions.get(sessionId)
    if (!session) return
    const handle = session.pty.onExit(({ exitCode }) => {
      // Inject once. Subsequent invocations of this same dispatch wouldn't
      // create a new handle since the session is gone — we hook pre-exit.
      injectHarnessMessage(
        MAILBOX_OVERSEER_ID,
        'harness.pty-exit',
        `Participant ${participantId} PTY exited with code ${exitCode ?? 0}. No more messages will arrive from this participant in this dispatch. Its mailbox dir is kept as a tombstone.`,
      )
      refreshIndex()
    })
    ptyUnsubs.push(() => { try { handle.dispose() } catch {} })
  }

  // Wire every participant's watchers + PTY-exit hooks.
  for (const safe of zoneBySafe.keys()) {
    watchDir(inboxDir(projectDir, safe), name => onZoneInboxWrite(safe, name))
    watchDir(outboxDir(projectDir, safe), name => onZoneOutboxWrite(safe, name))
    const zone = zoneBySafe.get(safe)
    if (zone) hookPtyExit(safe, zone.id)
  }
  watchDir(inboxDir(projectDir, MAILBOX_OVERSEER_ID), name => onOverseerInboxWrite(name))
  watchDir(outboxDir(projectDir, MAILBOX_OVERSEER_ID), name => onOverseerOutboxWrite(name))
  hookPtyExit(MAILBOX_OVERSEER_ID, ARCHITECT_SESSION_ID)

  // Initial index emission so the renderer has a snapshot to render even
  // before any activity.
  refreshIndex()

  const coord = {
    stop: () => {
      for (const t of taskTrackers.values()) {
        clearTimeout(t.deliveryTimer)
        clearTimeout(t.timeoutTimer)
      }
      taskTrackers.clear()
      for (const t of cancelTimers.values()) clearTimeout(t)
      cancelTimers.clear()
      clearInterval(heartbeatTimer)
      for (const w of watchers) {
        try { w.close() } catch {}
      }
      for (const unsub of ptyUnsubs) {
        try { unsub() } catch {}
      }
      watchers.length = 0
      ptyUnsubs.length = 0
      if (activeDispatchCoordinator === coord) activeDispatchCoordinator = null
    },
  }
  activeDispatchCoordinator = coord
  return coord
}

// Body for the one-shot bootstrap poke. v4 uses this once per session, at
// first-ready, to tell the agent to read its prompt file and enter its loop.
// Per-task delivery goes through the mailbox, never the PTY.
function buildBootstrapBody(role: 'overseer' | 'zone', participantId: string, projectDir: string): string {
  const promptFile = role === 'overseer'
    ? join(projectDir, 'ARCHITECT', 'prompts', 'architect.md')
    : join(projectDir, 'ARCHITECT', 'prompts', `${participantId}.md`)
  if (role === 'overseer') {
    return `Read ${promptFile} and follow its instructions. Begin your drain-and-plan loop now.`
  }
  return `Read ${promptFile} and follow its instructions. Your participant ID is "${participantId}". Begin your listen-and-respond loop now by running bash ARCHITECT/scripts/mailbox-listen.sh ${participantId}.`
}

export interface StartDispatchOptions {
  userPrompt: string
  model?: string
  planMode?: boolean
  onlyZoneIds?: string[]
}

// Harness-owned env vars every agent needs to talk to the mailbox. Shell scripts
// read these; node-pty merges them into the spawned CLI's environment.
function mailboxEnv(projectDir: string, participantId: string, label: string, dispatchId: string): Record<string, string> {
  return {
    MBX_ROOT: mailboxRoot(projectDir),
    MBX_SELF: participantId,
    MBX_SELF_LABEL: label,
    MBX_DISPATCH_ID: dispatchId,
    MBX_SCRIPTS: scriptsDir(projectDir),
  }
}

// Entry point for fresh multi-zone (and single-zone fast path) dispatches.
// Replaces v3's runGraph name — the "graph" in that name implied dependency-
// gated topological spawning, which v4 doesn't do (all zones pre-spawn
// concurrently; the Overseer decides task order via mailbox, not spawn order).
// Companion is resumeDispatch for replaying a prior DispatchRecord.
export async function startDispatch(
  win: BrowserWindow,
  nodes: GraphNode[],
  edges: GraphEdge[],
  projectDir: string,
  rawSettings: unknown,
  dispatch: StartDispatchOptions,
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

  // Fresh dispatch: wipe the prior mailbox tree before rebuilding. Leaving
  // stale messages in inboxes/outboxes would confuse the new Overseer (it'd
  // drain old harness events + results from a previous run). Resume takes a
  // different path (see `resumeDispatch`) and preserves the mailbox so
  // pending-at-suspension messages survive.
  wipeMailboxTree(projectDir)
  setupWorkspace(projectDir, filteredNodes, edges, settings, dispatchContext, userPrompt)

  const zoneEdges = edges.filter(e => selectedZoneIds.has(e.source) && selectedZoneIds.has(e.target))
  const sorted = topoSort(selectedZones, zoneEdges)
  const promptsDir = join(projectDir, 'ARCHITECT', 'prompts')

  // Single-zone path: no Overseer, no mailbox orchestration. Delegate to
  // runZone so the Play-button flow and the dispatch-with-one-zone flow
  // share one code path for system-prompt assembly, prompt delivery, and
  // session capture. (Mailbox scaffold was still written by setupWorkspace
  // above but nothing watches it — harmless.)
  if (sorted.length === 1) {
    const zone = sorted[0]
    const runtime = getZoneRuntime(zone, settings)
    const result = await runZone(win, {
      projectDir,
      zoneId: zone.id,
      nodes,
      edges,
      mode: 'new',
      summary: dispatchSummary,
      userPrompt,
      model: dispatch.model,
      planMode: dispatch.planMode === true,
      settings: rawSettings,
    })
    if (!result.ok) {
      throw new Error(`runZone failed: ${result.reason ?? 'unknown'}`)
    }
    return [{ id: zone.id, label: zone.data.label, runtime }]
  }

  // Generate a fresh dispatchId for this run. Stamped on every mailbox
  // message's metadata; persisted on the DispatchRecord so resume passes
  // the same id back to the resumed agents.
  const dispatchId = randomBytes(8).toString('hex')

  const allInfo: TerminalInfo[] = [
    { id: ARCHITECT_SESSION_ID, label: 'Architect', runtime: settings.defaultRuntime },
    ...sorted.map(zone => ({ id: zone.id, label: zone.data.label, runtime: getZoneRuntime(zone, settings) })),
  ]

  // Architect session id is captured first; zones that race ahead queue their
  // upsert until it's available so every DispatchRecord keeps a full zone map.
  let architectSessionId: string | null = null
  const pendingZoneUpserts: Array<() => void> = []

  // Spawn every zone serially. Concurrent spawns + a shared session directory
  // lets multiple zones' "first new session id" polls converge on the
  // earliest-written file (see plans/melodic-orbiting-lemon.md). Awaiting
  // each zone's onCaptureSettled before snapshotting the next guarantees the
  // next zone's "before" set already contains all prior zones' ids.
  // Dependency ordering still lives in the Overseer's prompt — we just
  // serialize the boot sequence.
  for (const zone of sorted) {
    const safe = sanitize(zone.data.label)
    const env: Record<string, string> = {
      ...mailboxEnv(projectDir, safe, zone.data.label, dispatchId),
    }
    for (const { key, value } of zone.data.envVars ?? []) {
      if (key) env[key] = value
    }
    const runtime = getZoneRuntime(zone, settings)
    const model = getZoneModel(zone, runtime)
    const systemPrompt = fs.readFileSync(join(promptsDir, `${safe}.md`), 'utf-8')
    const bootstrap = buildBootstrapBody('zone', safe, projectDir)

    await new Promise<void>(resolve => {
      let settled = false
      const done = (): void => { if (!settled) { settled = true; resolve() } }
      const timer = setTimeout(() => {
        console.warn(`[dispatch] zone "${zone.data.label}" capture did not settle in ${CAPTURE_SERIAL_TIMEOUT_MS}ms — moving on; late capture will still upsert if it arrives`)
        done()
      }, CAPTURE_SERIAL_TIMEOUT_MS)

      const zoneInfo = spawnAgentSession({
        win,
        id: zone.id,
        label: zone.data.label,
        runtime,
        env,
        cwd: projectDir,
        initialPrompt: bootstrap,
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
        onCaptureSettled: () => {
          clearTimeout(timer)
          done()
        },
      })
      // Broadcast each tab as its PTY spawns so the renderer can reveal
      // terminal tabs incrementally during the serialized-capture await.
      // Without this the whole loop awaits silently and the UI only gets
      // the list when startDispatch returns.
      broadcast('terminal:spawned', zoneInfo)
    })
  }

  startMailboxObserver(projectDir, sorted, dispatchId)

  const architectPrompt = fs.readFileSync(join(promptsDir, 'architect.md'), 'utf-8')
  const architectEnv: Record<string, string> = mailboxEnv(projectDir, MAILBOX_OVERSEER_ID, 'Architect', dispatchId)
  const architectInfo = spawnAgentSession({
    win,
    id: ARCHITECT_SESSION_ID,
    label: 'Architect',
    runtime: settings.defaultRuntime,
    env: architectEnv,
    cwd: projectDir,
    initialPrompt: architectPrompt,
    model: dispatch.model || DEFAULT_MODEL_BY_RUNTIME[settings.defaultRuntime],
    planMode: dispatch.planMode === true,
    capture: {
      projectDir,
      zoneKey: ARCHITECT_SESSION_ID,
      legacyKey: 'Architect',
      summary: dispatchSummary,
    },
    onSessionCaptured: sessionId => {
      architectSessionId = sessionId
      const record: DispatchRecord = {
        architectSessionId: sessionId,
        architectRuntime: settings.defaultRuntime,
        dispatchId,
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
      for (const fn of pendingZoneUpserts.splice(0)) fn()
    },
  })
  broadcast('terminal:spawned', architectInfo)

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

// Only claude supports `--append-system-prompt`; codex/gemini/opencode drop
// the flag silently. For solo launches on those runtimes we prepend the role
// prompt into the first turn so the agent actually sees it.
function buildSoloInitialPrompt(systemPrompt: string, userPrompt: string): string {
  const user = userPrompt.trim() || "(waiting for user's first message — acknowledge the role above and ask what to work on)"
  return `<<SYSTEM PROMPT — read this first, then respond to the user request at the bottom>>
${systemPrompt}
<<END SYSTEM PROMPT>>

User request:
${user}`
}

// Unified entry point for launching a single zone — handles both "start new
// session" and "continue previous session" from the ZoneLaunchModal. Also
// used by startDispatch's single-zone branch so the two paths can't drift.
export async function runZone(win: BrowserWindow, opts: RunZoneOptions): Promise<RunZoneResult> {
  const settings = normalizeProjectSettings(opts.settings)
  const { zones, componentsByZone } = indexGraph(opts.nodes)
  const zone = zones.find(z => z.id === opts.zoneId)
  if (!zone) return { ok: false, reason: 'zone-not-found' }

  const safe = sanitize(zone.data.label)
  const base = join(opts.projectDir, 'ARCHITECT')
  for (const dir of ['outputs', 'prompts', 'sessions', 'dispatches'].map(n => join(base, n))) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const zoneIdSet = new Set(zones.map(z => z.id))
  const zoneEdges = opts.edges.filter(e => zoneIdSet.has(e.source) && zoneIdSet.has(e.target))
  const intraEdges = opts.edges.filter(e => !zoneIdSet.has(e.source) && !zoneIdSet.has(e.target))
  // Solo launch — no Overseer, no mailbox observer, no MBX_* env vars. The
  // prompt must not reference mailbox scripts or the agent will try to run
  // mailbox-listen.sh and fail. The architecture context block adds sibling
  // zones as reference so the agent understands the surrounding system.
  const systemPrompt =
    buildZoneSystemPrompt(zone, componentsByZone, zoneEdges, intraEdges, zones, opts.projectDir, 'solo')
    + buildArchitectureContextBlock(zones, componentsByZone, opts.edges, zone.id)
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

    // Resume uses CLI-native conversation replay via resumeSessionId alone.
    // We do not inject `userPrompt` into the PTY post-spawn — the user drives
    // the first turn after resume (same philosophy as resumeDispatch).
    const info = spawnAgentSession({
      win,
      id: zone.id,
      label: zone.data.label,
      runtime,
      env,
      cwd: opts.projectDir,
      model,
      resumeSessionId: rec.sessionId,
      skipPermissions: false,
    })
    broadcast('terminal:spawned', info)
    return { ok: true, info }
  }

  // mode === 'new' — fresh spawn, append a history entry once the runtime
  // assigns a new session id.
  const summary = (opts.summary ?? '').trim() ||
    `${zone.data.label} · ${new Date().toLocaleString()}`

  // Claude gets the role prompt via --append-system-prompt; other runtimes
  // have no such flag, so fold it into the first-turn payload.
  const initialPrompt = runtime === 'claude'
    ? (userPrompt || undefined)
    : buildSoloInitialPrompt(systemPrompt, userPrompt)
  const appendForRuntime = runtime === 'claude' ? systemPrompt : undefined

  const info = spawnAgentSession({
    win,
    id: zone.id,
    label: zone.data.label,
    runtime,
    env,
    cwd: opts.projectDir,
    initialPrompt,
    appendSystemPrompt: appendForRuntime,
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

  // Clean-cut v3 → v4 gate. v3 dispatches used tasks/ files + status.json;
  // their conversation history tells the agents to echo ARCHITECT_TASK_ACK
  // and write receipts. Resuming them under v4 would put the agents and
  // the harness into different protocols. Reject.
  if ((record.protocolVersion ?? 0) < DISPATCH_PROTOCOL_VERSION) {
    return { ok: false, error: 'legacy-protocol' }
  }

  // Use the pinned dispatchId if present; otherwise mint one. Pre-v4 records
  // won't have it; that path is already blocked above, but defense in depth.
  const dispatchId = record.dispatchId ?? randomBytes(8).toString('hex')

  const { zones: allZones } = indexGraph(opts.nodes)
  const zoneById = new Map(allZones.map(z => [z.id, z]))
  const dispatchZones = record.zoneIds
    .map(id => zoneById.get(id))
    .filter((z): z is ZoneGraphNode => !!z)

  const zoneIds = new Set(dispatchZones.map(z => z.id))
  const filteredNodes = opts.nodes.filter(n => n.type !== 'zone' || zoneIds.has(n.id))
  // Resume wipes the mailbox too. The resume picker lets the user pick ANY
  // historical dispatch, not just the most recent, so whatever's currently
  // in ARCHITECT/mailbox/ is almost certainly from a later run (or was
  // wiped by one) — keeping it would only confuse the resumed Overseer with
  // stale messages from an unrelated dispatch. Agents coming back via
  // resumeSessionId reload their full conversation from the CLI's own
  // session store; the mailbox was only ever the transport, not durable
  // state, so wiping costs nothing.
  wipeMailboxTree(opts.projectDir)
  setupWorkspace(opts.projectDir, filteredNodes, opts.edges, settings)

  const info: TerminalInfo[] = [
    { id: ARCHITECT_SESSION_ID, label: 'Architect', runtime: record.architectRuntime },
  ]

  // Resume each zone with the session pinned in the dispatch record. No
  // initialPrompt — per memory/feedback_resume_user_prompt.md the user wants
  // to drive the first turn on resume. The resumed conversation already has
  // the listen-loop context baked in from the original dispatch's system
  // prompt.
  for (const zone of dispatchZones) {
    const entry = record.zoneSessions.find(z => z.zoneId === zone.id)
    const runtime = entry?.runtime ?? getZoneRuntime(zone, settings)
    info.push({ id: zone.id, label: zone.data.label, runtime })

    if (!entry) {
      console.warn(`[resume-dispatch] no session id stored for zone ${zone.data.label}, skipping`)
      continue
    }

    const safe = sanitize(zone.data.label)
    const env: Record<string, string> = {
      ...mailboxEnv(opts.projectDir, safe, zone.data.label, dispatchId),
    }
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

  startMailboxObserver(opts.projectDir, dispatchZones, dispatchId)

  spawnAgentSession({
    win,
    id: ARCHITECT_SESSION_ID,
    label: 'Architect',
    runtime: record.architectRuntime,
    env: mailboxEnv(opts.projectDir, MAILBOX_OVERSEER_ID, 'Architect', dispatchId),
    cwd: opts.projectDir,
    model: record.model || DEFAULT_MODEL_BY_RUNTIME[record.architectRuntime],
    resumeSessionId: record.architectSessionId,
    planMode: record.planMode === true,
  })

  return { ok: true, info }
}
