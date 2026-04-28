import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join, basename } from 'path'
import fs from 'fs'
import { execFileSync, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { DEFAULT_COLS, DEFAULT_ROWS } from '../shared/terminalDims'
import {
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  isAgentRuntime,
  isAssistantMode,
  isEffortLevel,
  type AgentRuntime,
  type AssistantMode,
  type EffortLevel,
} from '../shared/agentRuntimes'
import {
  appendZoneSession,
  deleteZoneSession,
  ensureClaudeProjectTrusted,
  getZoneSessionRecord,
  listZoneSessions,
  updateZoneSessionSummary,
  type ZoneSessionRecord,
} from './sessionCapture'
import { getRuntimeAdapter } from './runtimes'
import {
  saveDispatch,
  summarizeFromPrompt,
  upsertDispatchZoneSession,
  type DispatchRecord,
} from './dispatchCapture'
import { buildComponentEdgeSpecs } from './orchestrator/componentEdges'
import { buildSoloZonePrompt } from './orchestrator/prompts/solo'
import type { ComponentEdgeDirection } from './orchestrator/prompts/componentEdges'

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

// v5 harness knobs. v4's deliveryWarningMs + taskTimeoutMs are gone — the
// mailbox transport those served doesn't exist any more.
//   idleThresholdMs     — when the scheduler flips a participant to 'stale'
//                         (both PTY and activity log quiet past threshold).
//   staleEscalationMs   — how long a stale streak must persist before the
//                         scheduler invokes the conductor for recovery.
interface HarnessTimeouts {
  idleThresholdMs: number
  staleEscalationMs: number
}

// Main-side settings shape. Only fields that affect dispatch/zone execution
// live here — the side-panel assistant intentionally bypasses this path:
// `startAssistant` takes runtime + model directly from the renderer and never
// reads ProjectSettings. Adding an `assistant*` field to this interface
// would re-couple the two and is a code smell.
interface ProjectSettings {
  dispatchRuntime: AgentRuntime
  dispatchEffort: EffortLevel
  harnessTimeouts: HarnessTimeouts
}

const DEFAULT_HARNESS_TIMEOUTS: HarnessTimeouts = {
  idleThresholdMs: 3 * 60_000,
  staleEscalationMs: 10 * 60_000,
}

function normalizeHarnessTimeouts(raw: unknown): HarnessTimeouts {
  const base = { ...DEFAULT_HARNESS_TIMEOUTS }
  if (!raw || typeof raw !== 'object') return base
  const rec = raw as Record<string, unknown>
  for (const key of Object.keys(base) as (keyof HarnessTimeouts)[]) {
    const v = rec[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) base[key] = v
  }
  return base
}

export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  const settings = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  // Accept both the new `dispatch*` and legacy `default*` keys so older
  // canvas payloads passing through IPC resolve correctly.
  const rawRuntime = settings.dispatchRuntime ?? settings.defaultRuntime
  const rawEffort = settings.dispatchEffort ?? settings.defaultEffort
  return {
    dispatchRuntime: isAgentRuntime(rawRuntime) ? rawRuntime : DEFAULT_AGENT_RUNTIME,
    dispatchEffort: isEffortLevel(rawEffort) ? rawEffort : 'medium',
    harnessTimeouts: normalizeHarnessTimeouts(settings.harnessTimeouts),
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
  return getRuntimeAdapter(rec.runtime).revalidateSession(projectDir, rec.sessionId)
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
  // True when this terminal is part of a scheduler-driven dispatch (any zone
  // OR the Conductor). The renderer uses it to lock user input by default so
  // accidental typing doesn't interleave with scheduler-delivered prompts —
  // the scheduler's two-step submit (text → 120ms → \r) races with concurrent
  // user keystrokes and corrupts whichever turn is mid-flight. The user can
  // click "Take manual control" to type (e.g. to send GO in plan mode or chat
  // with the Conductor mid-dispatch). Never set on solo-zone launches, the
  // assistant, or shell sessions.
  coordinatedMode?: boolean
  // True when this terminal is the Conductor of a dispatch the user has
  // requested in plan mode. The renderer renders a "plan mode — waiting
  // for GO" pill in the terminal's header until the user types GO. The
  // conductor's prompt teaches it to discuss the plan with the user
  // before emitting any {type:"assign"} decisions.
  planMode?: boolean
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
    participantId?: string
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
  data?: {
    label?: string
    direction?: ComponentEdgeDirection
    [key: string]: unknown
  }
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
// Per-task state is tracked by the v5 scheduler (src/main/orchestrator/
// scheduler.ts) via activity-log events — the 'finished' state is not used
// here because a zone's PTY stays alive across tasks.
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
  // Fired after the PTY has exited. Receives the CLI's exit code (may be
  // null if the PTY died abnormally). Consumers use this to mark a zone as
  // exited in scheduler state.
  onExit?: (exitCode: number | null) => void
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
  // Unified reasoning-effort setting; mapped per CLI by effortArgsFor().
  effort?: EffortLevel
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
  // See TerminalInfo.coordinatedMode. Set true for zones AND the Conductor
  // spawned inside a multi-zone dispatch/resume; omitted everywhere else.
  coordinatedMode?: boolean
  // See TerminalInfo.planMode. Set true when this spawn is the Conductor of
  // a dispatch the user opened in plan mode, so the renderer can show the
  // "plan mode — waiting for GO" pill. Distinct from the spawn-level
  // `planMode` flag above (which controls Claude's --permission-mode plan
  // CLI arg); this one is purely a renderer hint.
  planModeBadge?: boolean
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
  effort?: EffortLevel,
): string[] {
  const adapter = getRuntimeAdapter(runtime)
  const common = {
    userPrompt: prompt,
    model,
    effort,
    planMode,
    skipPermissions,
    // Only claude honors appendSystemPrompt as a CLI flag; other adapters
    // ignore it (callers inline the prompt via composeSystemAndUser).
    appendSystemPrompt: adapter.supportsSystemPromptFlag ? appendSystemPrompt : undefined,
  }
  return resumeSessionId
    ? adapter.buildResumeArgs({ ...common, sessionId: resumeSessionId })
    : adapter.buildSpawnArgs(common)
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
  onExit?: (exitCode: number | null) => void,
  opts?: { kind?: 'agent' | 'shell'; runtime?: AgentRuntime | 'shell' },
): void {
  const kind = opts?.kind ?? 'agent'
  const runtime = opts?.runtime ?? 'shell'
  const term = new HeadlessTerminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
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
      clearCoordinationState(id)
    }
    onExit?.(exitCode ?? null)
  })
}

function spawnErrorSession(
  win: BrowserWindow,
  id: string,
  label: string,
  runtime: AgentRuntime,
  cwd: string,
  message: string,
  onExit?: (exitCode: number | null) => void
): TerminalInfo {
  const shell = process.env.SHELL || '/bin/zsh'
  const ptyProcess = pty.spawn(shell, ['-lc', `echo ${JSON.stringify(message)}; exit 127`], {
    name: 'xterm-256color',
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
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

export function spawnAgentSession({
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
  effort,
  appendSystemPrompt,
  onSessionCaptured,
  onCaptureSettled,
  coordinatedMode,
  planModeBadge,
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
  const captureRuntime: AgentRuntime | null =
    capture && !resumeSessionId ? runtime : null
  const captureAdapter = captureRuntime ? getRuntimeAdapter(captureRuntime) : null
  // Adapter snapshots may be sync (filesystem reads) or async (opencode's
  // CLI subprocess). Normalize to Promise so the capture branch is uniform.
  const snapshotPromise: Promise<Set<string>> | null = captureAdapter
    ? Promise.resolve(captureAdapter.snapshotSessions(cwd))
    : null

  const spawnArgs = buildRuntimeArgs(runtime, initialPrompt, model, resumeSessionId, skipPermissions, planMode, appendSystemPrompt, effort)
  // Skip the "trust this folder?" TUI prompt on first launch in a new cwd.
  // That dialog blocks claude from writing its session jsonl, which in turn
  // makes captureNewClaudeSession poll to timeout and freezes fresh spawns
  // (e.g. first assistant load in a brand-new project dir).
  if (runtime === 'claude') ensureClaudeProjectTrusted(cwd)
  console.log(`[spawn] ${runtime} (zone=${id}) cwd=${cwd} cmd=${bin} args=${JSON.stringify(spawnArgs)}${resumeSessionId ? ' [RESUME]' : ''}`)
  const ptyProcess = pty.spawn(bin, spawnArgs, {
    name: 'xterm-256color',
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
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
          model,
          dispatchId: capture.dispatchId,
        })
        console.log(`[session-capture] ${capture.zoneKey}: appended ${captureRuntime} session ${sessionId}`)
        broadcast('zone:session-captured', {
          zoneKey: capture.zoneKey,
          zoneId: id,
          sessionId,
          runtime: captureRuntime,
          summary: capture.summary,
          model,
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

    if (snapshotPromise && captureAdapter) {
      void snapshotPromise.then(snapshot => {
        console.log(`[session-capture] ${capture.zoneKey}: ${captureAdapter.id} snapshot ${snapshot.size} existing, polling…`)
        return captureAdapter.captureNewSession(cwd, snapshot)
      }).then(sessionId => {
        if (!sessionId) {
          console.warn(`[session-capture] ${capture.zoneKey}: timed out without capturing a new ${captureAdapter.id} session`)
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

  return {
    id,
    label,
    runtime,
    ...(coordinatedMode ? { coordinatedMode: true } : {}),
    ...(planModeBadge ? { planMode: true } : {}),
  }
}

export function spawnShellSession(
  win: BrowserWindow,
  cwd: string,
  opts?: { force?: boolean },
): TerminalInfo {
  const cwdSuffix = `-${hashCwd(cwd)}`
  const existingForCwd = Array.from(sessions.keys()).filter(
    k => k.startsWith(SHELL_ID_PREFIX) && k.endsWith(cwdSuffix),
  )
  if (!opts?.force && existingForCwd.length > 0) {
    const id = existingForCwd[0]
    return { id, label: 'Shell', runtime: 'shell' }
  }

  const id = `${SHELL_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 6)}${cwdSuffix}`
  const shell = process.env.SHELL || '/bin/zsh'
  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd,
    env: process.env as Record<string, string>,
  })

  createSession(win, id, ptyProcess, undefined, { kind: 'shell', runtime: 'shell' })
  const label = existingForCwd.length > 0 ? `Shell ${existingForCwd.length + 1}` : 'Shell'
  return { id, label, runtime: 'shell' }
}

function hashCwd(cwd: string): string {
  let h = 0
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

export function writeToTerminal(id: string, data: string) {
  sessions.get(id)?.pty.write(data)
}

// Per-PTY coordination state for the scheduler↔user write race. The Conductor
// (and any zone the user opted into manual control on) is shared between two
// writers: the scheduler's `submitTurnToTerminal` and the user's keystrokes via
// `terminal:input`. While the user holds manual control, scheduler turns are
// queued instead of interleaving. On release, the queue drains sequentially
// with a gap between turns so paste-detection doesn't coalesce them.
const userControlState = new Map<string, boolean>()
const turnQueue = new Map<string, string[]>()
const draining = new Set<string>()

const SUBMIT_BODY_TO_CR_MS = 120  // body→\r gap (Claude paste-detection)
const INTER_TURN_GAP_MS = 1500    // \r→next-body gap (let TUI commit the turn)

// Submit one full turn (body + Enter) to a PTY. Use this instead of two
// separate writeToTerminal calls — the two-step pattern (body, 120ms, CR) is
// load-bearing because Claude's TUI treats a single burst as paste content
// and won't interpret an embedded \r as Enter. While `userControlState[id]`
// is true (user has manual control), turns are queued and replayed on release.
export function submitTurnToTerminal(id: string, text: string): void {
  if (userControlState.get(id) === true) {
    const q = turnQueue.get(id) ?? []
    q.push(text)
    turnQueue.set(id, q)
    return
  }
  performSubmit(id, text)
}

function performSubmit(id: string, text: string): void {
  const sess = sessions.get(id)
  if (!sess) return
  sess.pty.write(text)
  setTimeout(() => {
    // If the user took control during the 120ms gap, skip the CR — the body
    // has already landed in the TUI input line, and submitting it now would
    // race with whatever the user has started typing. The body sits there as
    // pre-filled text the user can backspace or accept. Subsequent queued
    // turns will drain after release.
    if (userControlState.get(id) === true) return
    sessions.get(id)?.pty.write('\r')
  }, SUBMIT_BODY_TO_CR_MS)
}

// User toggles manual control. Releasing (hasControl=false) drains the queue.
export function setUserControl(id: string, hasControl: boolean): void {
  userControlState.set(id, hasControl)
  if (!hasControl) drainTurnQueue(id)
}

function drainTurnQueue(id: string): void {
  if (draining.has(id)) return
  draining.add(id)
  const next = (): void => {
    if (userControlState.get(id) === true) { draining.delete(id); return }
    const q = turnQueue.get(id)
    if (!q || q.length === 0) { draining.delete(id); return }
    if (!sessions.has(id)) { draining.delete(id); turnQueue.delete(id); return }
    const text = q.shift()!
    const sess = sessions.get(id)!
    sess.pty.write(text)
    setTimeout(() => {
      if (userControlState.get(id) === true) { draining.delete(id); return }
      sessions.get(id)?.pty.write('\r')
      setTimeout(next, INTER_TURN_GAP_MS)
    }, SUBMIT_BODY_TO_CR_MS)
  }
  // Same gap on the boundary between the user's release-Enter and the first
  // queued turn — without it, the user's just-submitted \r and the queued
  // body land back-to-back and Claude's TUI splices them into one input.
  setTimeout(next, INTER_TURN_GAP_MS)
}

// Clear all coordination state for a PTY id. Called when a session ends so a
// later dispatch reusing the same id (e.g. CONDUCTOR_PTY_ID) starts clean.
function clearCoordinationState(id: string): void {
  userControlState.delete(id)
  turnQueue.delete(id)
  draining.delete(id)
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const session = sessions.get(id)
  if (!session) return
  // Clamp at the pty boundary: node-pty (especially winpty on Windows) throws
  // on 0 / NaN / negative sizes. Mirrors VS Code's TerminalProcess.resize.
  const safeCols = Math.max(Math.floor(cols) || 1, 1)
  const safeRows = Math.max(Math.floor(rows) || 1, 1)
  try { session.pty.resize(safeCols, safeRows) } catch {}
  try { session.term.resize(safeCols, safeRows) } catch {}
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
    clearCoordinationState(id)
  }
}

// Kills every session including user shells. Used at the auth boundary on
// sign-out so a prior account's shell history/process state cannot leak to
// the next signed-in user.
export function killAllIncludingShells() {
  activeDispatchCoordinator?.stop()
  activeDispatchCoordinator = null
  for (const [id, session] of sessions) {
    try { session.pty.kill() } catch {}
    try { session.term.dispose() } catch {}
    sessions.delete(id)
    captureStates.delete(id)
    clearCoordinationState(id)
  }
}

// Registers a dispatch-level stop hook so killAll tears down the scheduler's
// watchers + status tick. Called by orchestrator/dispatch.ts after it builds
// a Scheduler; passing null unregisters.
export function setActiveDispatchCoordinator(coord: { stop: () => void } | null): void {
  activeDispatchCoordinator = coord
}

// Returns the most recent PTY-output timestamp for a live agent session, or
// null if no session with that id is alive. Used by the scheduler's status
// tick to detect staleness (quiet PTY + quiet activity log = stale).
export function getSessionLastActivityMs(id: string): number | null {
  const session = sessions.get(id)
  if (!session) return null
  return session.lastActivityMs
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
    clearCoordinationState(id)
  }
  // Only clear capture bookkeeping if capture already settled. While still
  // 'pending', leave the entries so the in-flight poll's persistAndBroadcast
  // / markReady callbacks remain valid.
  if (state !== 'pending') {
    captureStates.delete(id)
  }
  return { ok: true }
}

export function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9-_]/g, '-')
}

export function readSkillContent(skillPath: string): string {
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

export function getZoneRuntime(zone: ZoneGraphNode, settings: ProjectSettings): AgentRuntime {
  // Flat runtime: the zone's stored agentRuntime is the single source of truth.
  // (Legacy `agentRuntimeMode` is normalized away in the renderer's
  // normalizeZoneData, so it never reaches here on a modern load. Falling back
  // to dispatchRuntime covers zones that somehow arrive without a runtime.)
  return isAgentRuntime(zone.data.agentRuntime) ? zone.data.agentRuntime : settings.dispatchRuntime
}

export function getZoneModel(zone: ZoneGraphNode, runtime: AgentRuntime): string {
  return zone.data.providerModels?.[runtime] || zone.data.model || DEFAULT_MODEL_BY_RUNTIME[runtime]
}

interface ZoneIndex {
  zones: ZoneGraphNode[]
  componentsByZone: Map<string, ComponentGraphNode[]>
  unassignedComponents: ComponentGraphNode[]
}

// Overlay semantics: a component belongs to the smallest zone whose bbox contains its center.
// Smallest = lowest area — resolves ambiguity when zones overlap (inner-most wins).
export function indexGraph(nodes: GraphNode[]): ZoneIndex {
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

// Per-zone hard ceiling on serialized session capture during runZone. Session
// files typically land within 1–3s of PTY spawn; the cap exists so a
// misconfigured CLI can't wedge the rest of the flow. Set well below each
// runtime's own poll timeout (30 s claude / 90 s codex/gemini/opencode) so a
// late capture can still fire its onSessionCaptured upsert in the background
// after we've moved on. Dispatch uses its own copy in orchestrator/dispatch.ts.
const CAPTURE_SERIAL_TIMEOUT_MS = 20_000

export interface StartDispatchOptions {
  userPrompt: string
  model?: string
  planMode?: boolean
  onlyZoneIds?: string[]
}

// startDispatch / resumeDispatch are thin forwarders to the v5 orchestrator.
// The dynamic `await import` dodges a module-load cycle (dispatch.ts imports
// spawnAgentSession and other helpers from this file).
export async function startDispatch(
  win: BrowserWindow,
  nodes: GraphNode[],
  edges: GraphEdge[],
  projectDir: string,
  rawSettings: unknown,
  dispatch: StartDispatchOptions,
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] },
): Promise<TerminalInfo[]> {
  const { startDispatchV5 } = await import('./orchestrator/dispatch')
  return startDispatchV5({ win, nodes, edges, projectDir, rawSettings, dispatch, dispatchContext })
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

export interface StartAssistantOpts {
  // User's explicit model pick. Falls back to DEFAULT_MODEL_BY_RUNTIME.
  model?: string
  // Which session to use when spawning this mode's PTY. Read only when main
  // actually spawns — a live PTY is reused (ignoring this) unless `force`.
  session?: { mode: 'new' } | { mode: 'resume'; sessionId: string }
  // Optional seed prompt for a fresh session. When omitted, defaults to
  // "Read ARCHITECT/.assistant-context.<mode>.md" — each mode has its own
  // context file so prompts don't trample each other.
  initialPrompt?: string
  // Force kill-and-respawn even if this mode's PTY is already alive. Set
  // by the launcher modal (Start new / Resume specific / model change);
  // NOT set by implicit open / mode-switch flows, which should reuse the
  // existing PTY and ignore the opts.
  force?: boolean
}

// Spawns or reuses a side-panel assistant session.
//
// Design invariant: this function does NOT receive a ProjectSettings argument
// and intentionally reads nothing from the project's dispatch/zone config.
// All behavior (runtime, model, seed prompt, session intent) comes from the
// caller's explicit args. Keeps the assistant fully decoupled from the
// Settings-page `dispatch*` state — changing dispatch runtime, effort, tools,
// or timeout must never silently retarget or reconfigure the assistant.
// If you ever need the assistant to honor a new knob, add an `assistant*`
// field in AssistantSettings and thread it through as an explicit arg here.
// Global serializer for any fresh CLI spawn that arms session capture.
// Dispatch zones, single-zone launches (runZone), and both assistant modes
// all write new session files into the same per-runtime CLI directories
// (~/.claude/projects/<cwd>, ~/.codex/sessions/..., etc.). Two concurrent
// captures run diff-based attribution against those dirs and can cross-
// attribute IDs when their "before" snapshots overlap. Routing every
// fresh spawn through this single queue guarantees each spawn's snapshot
// already contains all prior spawns' new IDs — same invariant startDispatch
// enforces internally per zone, now extended across flows.
//
// Resumes do NOT need queueing: they don't create a new session file, so
// no diff is computed. Shell spawns also don't capture.
let globalAgentSpawnQueue: Promise<unknown> = Promise.resolve()

export function serializeAgentSpawn<T>(task: () => Promise<T>): Promise<T> {
  const p = globalAgentSpawnQueue.then(task)
  // Keep the chain alive on rejection — one failure shouldn't poison
  // subsequent spawns.
  globalAgentSpawnQueue = p.then(() => undefined, () => undefined)
  return p
}

// Same queue semantics as serializeAgentSpawn, but resolves the returned
// promise as soon as the PTY is up ({info}) rather than waiting for capture
// to settle. The queue itself still waits on captureSettled before releasing
// the next spawn — that's what prevents two concurrent capture polls from
// racing on the shared ~/.claude/projects/<cwd> directory.
//
// Use this for user-facing entry points (startAssistant, runZone) so the
// renderer unfreezes the instant the terminal exists. Capture continues in
// the background and upserts the session record when the file lands.
export function serializeAgentSpawnEarlyRelease<T>(
  task: () => Promise<{ info: T; captureSettled: Promise<unknown> }>,
): Promise<T> {
  return new Promise<T>((resolveOuter, rejectOuter) => {
    const run = globalAgentSpawnQueue.then(async () => {
      let handed = false
      try {
        const { info, captureSettled } = await task()
        resolveOuter(info)
        handed = true
        await captureSettled.catch(() => undefined)
      } catch (err) {
        if (!handed) rejectOuter(err)
        // swallow — keep queue chain alive
      }
    })
    globalAgentSpawnQueue = run.then(() => undefined, () => undefined)
  })
}

export function startAssistant(
  win: BrowserWindow,
  projectDir: string,
  contextMd: string,
  runtime: AgentRuntime,
  mode: AssistantMode,
  opts?: StartAssistantOpts,
): Promise<TerminalInfo> {
  return serializeAgentSpawnEarlyRelease(
    () => doStartAssistant(win, projectDir, contextMd, runtime, mode, opts),
  )
}

async function doStartAssistant(
  win: BrowserWindow,
  projectDir: string,
  contextMd: string,
  runtime: AgentRuntime,
  mode: AssistantMode,
  opts?: StartAssistantOpts,
): Promise<{ info: TerminalInfo; captureSettled: Promise<unknown> }> {
  const safeMode: AssistantMode = isAssistantMode(mode) ? mode : 'architecture'
  const sessionId = ASSISTANT_SESSION_IDS[safeMode]
  const zoneKey = ASSISTANT_ZONES[safeMode]

  const safeRuntime = isAgentRuntime(runtime) ? runtime : DEFAULT_AGENT_RUNTIME
  const architectDir = join(projectDir, 'ARCHITECT')
  fs.mkdirSync(architectDir, { recursive: true })
  // Per-mode context files so Architecture and General don't trample each
  // other's system prompt. A shared path caused the wrong mode's content to
  // be loaded if the user told a still-running assistant to "re-read the
  // context file" after the other mode had written to it.
  const contextFilename = `.assistant-context.${safeMode}.md`
  const contextFile = join(architectDir, contextFilename)
  fs.writeFileSync(contextFile, contextMd)

  // Reuse vs. respawn: the launcher modal sets `opts.force` when the user
  // explicitly asks for a new/different session or model. Everything else
  // (implicit open, mode toggle) reuses the live PTY and ignores `opts` —
  // the renderer eagerly passes the last-session pair, but a matching PTY
  // is already the right answer.
  const existing = sessions.get(sessionId)
  if (existing && !opts?.force) {
    return {
      info: {
        id: sessionId,
        label: ASSISTANT_LABELS[safeMode],
        runtime: existing.runtime,
      },
      captureSettled: Promise.resolve(),
    }
  }
  if (existing) {
    stopAssistantMode(safeMode)
  }

  // Resolve resumeSessionId:
  //   - opts.session?.mode === 'resume' → honor it verbatim
  //   - opts.session?.mode === 'new'    → force fresh (no resume)
  //   - no opts                         → auto-resume latest reachable (legacy)
  let resumeSessionId: string | undefined
  if (opts?.session?.mode === 'resume') {
    resumeSessionId = opts.session.sessionId
  } else if (opts?.session?.mode === 'new') {
    resumeSessionId = undefined
  } else {
    const saved = latestReachableSession(projectDir, zoneKey, safeRuntime)
    resumeSessionId = saved?.sessionId
  }

  const model = opts?.model ?? DEFAULT_MODEL_BY_RUNTIME[safeRuntime]
  const initialPrompt = resumeSessionId
    ? undefined
    : opts?.initialPrompt ?? `Read ARCHITECT/${contextFilename}`

  console.log(
    `[assistant] mode=${safeMode} runtime=${safeRuntime} model=${model} ` +
    `${resumeSessionId ? `resume=${resumeSessionId}` : 'fresh'}` +
    `${opts ? ' (explicit)' : ''}`,
  )

  // Resumes don't arm capture — return info immediately, no settle to wait on.
  if (resumeSessionId) {
    const info = spawnAgentSession({
      win,
      id: sessionId,
      label: ASSISTANT_LABELS[safeMode],
      runtime: safeRuntime,
      env: {},
      cwd: projectDir,
      initialPrompt,
      resumeSessionId,
      model,
      capture: { projectDir, zoneKey, summary: `${ASSISTANT_LABELS[safeMode]}` },
      skipPermissions: false,
    })
    return { info, captureSettled: Promise.resolve() }
  }

  // Fresh spawn: hand `info` back as soon as the PTY is up; the queue still
  // holds for captureSettled so concurrent starts don't race on the shared
  // ~/.claude/projects/<cwd> dir. Renderer unblocks immediately.
  let settleResolve!: () => void
  const captureSettled = new Promise<void>(r => { settleResolve = r })
  const timer = setTimeout(() => {
    console.warn(
      `[assistant] capture for mode=${safeMode} did not settle in ${CAPTURE_SERIAL_TIMEOUT_MS}ms — moving on; late capture will still upsert if it arrives`,
    )
    settleResolve()
  }, CAPTURE_SERIAL_TIMEOUT_MS)

  const info = spawnAgentSession({
    win,
    id: sessionId,
    label: ASSISTANT_LABELS[safeMode],
    runtime: safeRuntime,
    env: {},
    cwd: projectDir,
    initialPrompt,
    model,
    capture: { projectDir, zoneKey, summary: `${ASSISTANT_LABELS[safeMode]}` },
    skipPermissions: false,
    onCaptureSettled: () => {
      clearTimeout(timer)
      settleResolve()
    },
  })
  return { info, captureSettled }
}

// Tears down a single assistant mode's PTY. Used by the launcher modal when
// the user picks "Start new", "Resume <session>", or changes model. The OTHER
// mode's session is untouched.
export function stopAssistantMode(mode: AssistantMode) {
  const safeMode: AssistantMode = isAssistantMode(mode) ? mode : 'architecture'
  const sessionId = ASSISTANT_SESSION_IDS[safeMode]
  const session = sessions.get(sessionId)
  if (!session) return
  try { session.pty.kill() } catch {}
  try { session.term.dispose() } catch {}
  sessions.delete(sessionId)
}

// Tears down both assistant PTYs. Intended for true teardown (project dir
// change, app quit); NOT called when the panel is closed or the mode toggle
// flips — those paths keep the sessions alive.
export function stopAllAssistants() {
  for (const sessionId of Object.values(ASSISTANT_SESSION_IDS)) {
    const session = sessions.get(sessionId)
    if (session) {
      try { session.pty.kill() } catch {}
      try { session.term.dispose() } catch {}
      sessions.delete(sessionId)
    }
  }
}

// Per-assistant-mode wrappers around the zone session store. The assistant
// already writes capture records keyed by ASSISTANT_ZONES[mode], so we just
// expose the same read/delete/rename helpers under an "assistant.*" facade
// so the renderer doesn't leak "zone" terminology.
export function listAssistantSessions(
  projectDir: string,
  mode: AssistantMode,
): ZoneSessionRecord[] {
  const safeMode: AssistantMode = isAssistantMode(mode) ? mode : 'architecture'
  return listZoneSessions(projectDir, ASSISTANT_ZONES[safeMode])
}

export function deleteAssistantSession(
  projectDir: string,
  mode: AssistantMode,
  sessionId: string,
): boolean {
  const safeMode: AssistantMode = isAssistantMode(mode) ? mode : 'architecture'
  return deleteZoneSession(projectDir, ASSISTANT_ZONES[safeMode], sessionId)
}

export function updateAssistantSessionSummary(
  projectDir: string,
  mode: AssistantMode,
  sessionId: string,
  summary: string,
): boolean {
  const safeMode: AssistantMode = isAssistantMode(mode) ? mode : 'architecture'
  return updateZoneSessionSummary(projectDir, ASSISTANT_ZONES[safeMode], sessionId, summary)
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
// session" and "continue previous session" from the ZoneLaunchModal. Also
// used by startDispatch's single-zone branch so the two paths can't drift.
export async function runZone(win: BrowserWindow, opts: RunZoneOptions): Promise<RunZoneResult> {
  const settings = normalizeProjectSettings(opts.settings)
  const { zones, componentsByZone } = indexGraph(opts.nodes)
  const zone = zones.find(z => z.id === opts.zoneId)
  if (!zone) return { ok: false, reason: 'zone-not-found' }

  // Prefer the canvas-minted stable id; fall back to a label-derived key
  // when the caller hasn't been upgraded yet (e.g. hand-crafted graph in a
  // test). The fallback is not dedup-aware because solo runZone only
  // touches one zone.
  const safe = (zone.data.participantId && zone.data.participantId.trim())
    || sanitize(zone.data.label)
  const base = join(opts.projectDir, 'ARCHITECT')
  for (const dir of ['outputs', 'prompts', 'sessions', 'dispatches'].map(n => join(base, n))) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Solo launch — no Conductor, no scheduler, no activity log. Compact
  // prompt that just tells the agent its role and wiring; the agent talks
  // directly with the user.
  const comps = componentsByZone.get(zone.id) ?? []
  const compIds = new Set(comps.map(c => c.id))
  const componentEdges = buildComponentEdgeSpecs(opts.nodes, opts.edges)
    .filter(edge => compIds.has(edge.sourceId) || compIds.has(edge.targetId))
  const enabledTools = Object.entries(zone.data.tools ?? {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
  const skills = (zone.data.skills ?? [])
    .map(skill => ({ name: skill.name, content: readSkillContent(skill.path) }))
    .filter(s => !!s.content)
  const systemPrompt = buildSoloZonePrompt({
    projectDir: opts.projectDir,
    participantId: safe,
    label: zone.data.label,
    description: zone.data.description,
    components: comps.map(c => ({
      id: c.id,
      label: c.data.label,
      tag: c.data.tag,
      category: c.data.category,
      description: c.data.description,
      specs: c.data.specs,
    })),
    componentEdges,
    toolNames: enabledTools,
    skills,
    userSystemPrompt: (zone.data.systemPrompt ?? '').trim(),
  })
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
    clearCoordinationState(zone.id)
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

  // Role-prompt delivery varies by runtime: Claude gets it via
  // --append-system-prompt, others fold it into the first-turn payload. The
  // adapter's composeSystemAndUser returns exactly one of the two fields set.
  const composed = getRuntimeAdapter(runtime).composeSystemAndUser(systemPrompt, userPrompt)
  const initialPrompt = composed.firstUserPrompt
  const appendForRuntime = composed.appendSystemPromptFlag

  const info = await serializeAgentSpawnEarlyRelease(async () => {
    let settleResolve!: () => void
    const captureSettled = new Promise<void>(r => { settleResolve = r })
    const timer = setTimeout(() => {
      console.warn(`[runZone] "${zone.data.label}" capture did not settle in ${CAPTURE_SERIAL_TIMEOUT_MS}ms — moving on; late capture will still upsert if it arrives`)
      settleResolve()
    }, CAPTURE_SERIAL_TIMEOUT_MS)

    const returned = spawnAgentSession({
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
      effort: settings.dispatchEffort,
      skipPermissions: false,
      capture: {
        projectDir: opts.projectDir,
        zoneKey: zone.id,
        legacyKey: safe,
        summary,
      },
      onCaptureSettled: () => {
        clearTimeout(timer)
        settleResolve()
      },
    })
    return { info: returned, captureSettled }
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

export async function resumeDispatch(
  win: BrowserWindow,
  opts: ResumeDispatchOptions,
): Promise<ResumeDispatchResult> {
  const { resumeDispatchV5 } = await import('./orchestrator/dispatch')
  return resumeDispatchV5({
    win,
    projectDir: opts.projectDir,
    dispatchId: opts.dispatchId,
    nodes: opts.nodes,
    edges: opts.edges,
    rawSettings: opts.settings,
  })
}
