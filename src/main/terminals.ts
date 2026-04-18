import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join, basename } from 'path'
import fs from 'fs'
import { execFileSync, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import {
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  isAgentRuntime,
  isAgentRuntimeMode,
  type AgentRuntime,
} from '../shared/agentRuntimes'
import {
  captureNewClaudeSession,
  loadZoneSession,
  saveZoneSession,
  snapshotClaudeSessions,
  type ZoneSession,
} from './sessionCapture'

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
    prompt: string
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

interface Session {
  pty: pty.IPty
  buffer: string
  done: boolean
  doneCallbacks: (() => void)[]
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
  // When set and runtime is claude, capture the new session ID and persist it.
  capture?: { projectDir: string; zoneSafe: string }
  // Defaults to true (preserves zone-agent autonomy). Set false for the
  // interactive assistant so the user gets normal permission prompts.
  skipPermissions?: boolean
}

const sessions = new Map<string, Session>()
let activeWatcher: fs.FSWatcher | null = null

const SHELL_ID_PREFIX = 'shell-'

function buildRuntimeArgs(
  runtime: AgentRuntime,
  prompt?: string,
  model?: string,
  resumeSessionId?: string,
  skipPermissions = true,
): string[] {
  switch (runtime) {
    case 'claude': {
      const args: string[] = []
      if (skipPermissions) args.push('--dangerously-skip-permissions')
      if (resumeSessionId) args.push('--resume', resumeSessionId)
      if (model) args.push('--model', model)
      // On resume, history already contains the prompt — don't replay it.
      if (prompt && !resumeSessionId) args.push(prompt)
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

function createSession(
  win: BrowserWindow,
  id: string,
  ptyProcess: pty.IPty,
  onExit?: () => void
): void {
  const session: Session = { pty: ptyProcess, buffer: '', done: false, doneCallbacks: [] }
  sessions.set(id, session)

  ptyProcess.onData(data => {
    session.buffer += data
    if (!session.done && session.buffer.includes('ARCHITECT_COMPLETE')) {
      session.done = true
      session.doneCallbacks.splice(0).forEach(cb => cb())
    }
    if (!win.isDestroyed()) win.webContents.send('terminal:data', { id, data })
  })

  ptyProcess.onExit(({ exitCode }) => {
    if (!win.isDestroyed()) win.webContents.send('terminal:exit', { id, exitCode })
    // Identity-check: a resume may have already replaced this entry.
    if (sessions.get(id) === session) sessions.delete(id)
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

  createSession(win, id, ptyProcess, onExit)
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
}: SpawnAgentOptions): TerminalInfo {
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

  // Snapshot existing claude sessions BEFORE spawn so capture can identify the new one.
  const claudeSnapshot =
    runtime === 'claude' && capture && !resumeSessionId
      ? snapshotClaudeSessions(cwd)
      : null

  const ptyProcess = pty.spawn(bin, buildRuntimeArgs(runtime, initialPrompt, model, resumeSessionId, skipPermissions), {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
  })

  createSession(win, id, ptyProcess, onExit)

  if (claudeSnapshot && capture) {
    console.log(`[session-capture] ${capture.zoneSafe}: snapshot ${claudeSnapshot.size} existing, polling…`)
    void captureNewClaudeSession(cwd, claudeSnapshot).then(sessionId => {
      if (!sessionId) {
        console.warn(`[session-capture] ${capture.zoneSafe}: timed out without seeing a new .jsonl in ~/.claude/projects/${cwd.replace(/[^A-Za-z0-9_-]/g, '-')}/`)
        return
      }
      try {
        saveZoneSession(capture.projectDir, capture.zoneSafe, {
          runtime: 'claude',
          sessionId,
          capturedAt: new Date().toISOString(),
        })
        console.log(`[session-capture] ${capture.zoneSafe}: saved session ${sessionId}`)
        if (!win.isDestroyed()) {
          win.webContents.send('zone:session-captured', {
            zoneSafe: capture.zoneSafe,
            zoneId: id,
            sessionId,
            runtime: 'claude',
          })
        }
      } catch (err) {
        console.error(`[session-capture] ${capture.zoneSafe}: failed to save`, err)
      }
    })
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

  createSession(win, id, ptyProcess)
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
  try { sessions.get(id)?.pty.resize(cols, rows) } catch {}
}

function onSessionDone(id: string, cb: () => void) {
  const session = sessions.get(id)
  if (!session) return
  if (session.done) {
    cb()
    return
  }
  session.doneCallbacks.push(cb)
}

// Kills agent and assistant sessions; preserves user shell sessions.
export function killAll() {
  activeWatcher?.close()
  activeWatcher = null
  for (const [id, session] of sessions) {
    if (id.startsWith(SHELL_ID_PREFIX)) continue
    try { session.pty.kill() } catch {}
    sessions.delete(id)
  }
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

function buildArchitectPrompt(
  zones: ZoneGraphNode[],
  componentsByZone: Map<string, ComponentGraphNode[]>,
  unassignedComponents: ComponentGraphNode[],
  edges: GraphEdge[],
  settings: ProjectSettings,
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] }
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
      zone.data.prompt ? `User goal: ${zone.data.prompt}` : '',
      `Components the agent must build:\n${componentLines}`,
      upstream.length ? `Upstream zones: ${upstream.join(', ')}` : '',
      downstream.length ? `Downstream zones: ${downstream.join(', ')}` : '',
      `Task file: ARCHITECT/tasks/${sanitize(zone.data.label)}.md`,
      `Status log: ARCHITECT/outputs/${sanitize(zone.data.label)}.md (progress notes only — actual code goes in the project root)`,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  const flowLines = zoneEdges.length
    ? zoneEdges.map(edge => `  ${zones.find(z => z.id === edge.source)?.data.label} → ${zones.find(z => z.id === edge.target)?.data.label}`).join('\n')
    : '  (zones run independently)'

  const unassignedSection = unassignedComponents.length
    ? `\n\n## Unassigned Components (no zone overlay)\nThese components exist on the canvas but are not covered by any zone. They are design-only artifacts; no agent has been spawned to build them. Decide whether to fold their responsibilities into an existing zone's task file or surface them back to the user.\n${unassignedComponents.map(c => `- ${c.data.label}${c.data.tag ? ` [${c.data.tag}]` : ''}${c.data.description ? ` — ${c.data.description}` : ''}`).join('\n')}`
    : ''

  return `You are the Architect agent coordinating a multi-agent system. Each "zone" below is a separate agent running as an interactive coding CLI session. Every agent is waiting and will automatically read its task file the moment you write it — you do not need to contact them directly.

DO NOT use the Task tool or spawn sub-agents. Coordinate exclusively through the filesystem.

## Architecture Diagram
${buildMermaidDiagram(zones, componentsByZone, zoneEdges)}

## Zones (agents)
${agentList}

## Inter-zone Data Flow
${flowLines}${unassignedSection}

## Your job

1. Read ARCHITECT/manifest.json for full details (including per-zone components)
2. Write a task file for EVERY zone listed above. Write them in dependency order (upstream first).
   Each task file must contain:
   - The concrete components the zone's agent must build (names, files, responsibilities)
   - API contracts, ports, endpoints, schemas between zones
   - What to read from upstream zones' output files
   - Clear acceptance criteria

3. After writing all task files, write your coordination log to ARCHITECT/outputs/Architect.md
4. Monitor ARCHITECT/outputs/ — when a zone-agent completes it writes its status log there; coordinate handoffs by updating downstream task files with actual details

IMPORTANT: Agents must create all real project files (source code, configs, etc.) directly in the project root working directory, NOT inside ARCHITECT/. The ARCHITECT/ folder is only for coordination files (manifests, prompts, tasks, status logs).

Start immediately. Write the task files now.${dispatchContext?.isRedispatch
    ? `\n\n## Execution Mode\nREDISPATCH — existing outputs may be present in ARCHITECT/outputs/.\n${dispatchContext.changedNodeLabels.length > 0
        ? `Only the following zones have changed and MUST be re-run: ${dispatchContext.changedNodeLabels.join(', ')}.\nDo NOT re-run unchanged zones unless their upstream inputs changed.`
        : 'No zone configurations changed. Only re-run zones that previously failed or need updating.'}`
    : ''}`
}

function buildZonePrompt(
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

  return `You are the **${zone.data.label}** zone-agent.
${zone.data.description ? `Zone description: ${zone.data.description}\n` : ''}${zone.data.prompt ? `\nUser goal: ${zone.data.prompt}\n` : ''}
${upstream.length ? `Upstream zones (read their status logs first): ${upstream.map(label => `ARCHITECT/outputs/${sanitize(label as string)}.md`).join(', ')}\n` : ''}${downstream.length ? `Downstream zones depending on you: ${downstream.join(', ')}\n` : ''}${tools.length ? `Enabled tools: ${tools.join(', ')}\n` : ''}
## Components you must build

${compList}

## Internal architecture (component-to-component wiring)

${archLines}

${skills ? `## Skills\n\n${skills}\n\n` : ''}## Instructions

Read ARCHITECT/tasks/${safe}.md and execute every instruction in it immediately and concretely. You are responsible for **all** components listed above.

**WHERE TO CREATE FILES:**
- All project files (source code, configs, scripts, etc.) go directly in the project root (current working directory). Do NOT put them inside ARCHITECT/.
- ARCHITECT/ is only for coordination: tasks, prompts, and status logs.
- ${statusLog} is your status log — write brief progress notes and a final summary there (include any URLs/ports you open), not your actual code.

If you have downstream zones, document your interfaces (ports, schemas, file paths) in your status log so they can read it.

Work fully autonomously — do not stop or ask for clarification.

When you have finished ALL work, run this exact shell command as your last action:
\`\`\`
echo ARCHITECT_COMPLETE
\`\`\``
}

function setupWorkspace(
  projectDir: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  settings: ProjectSettings,
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] }
) {
  const base = join(projectDir, 'ARCHITECT')
  for (const dir of ['tasks', 'outputs', 'prompts', 'sessions'].map(name => join(base, name))) {
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
        userPrompt: zone.data.prompt || null,
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
  fs.writeFileSync(join(base, 'prompts', 'architect.md'), buildArchitectPrompt(zones, componentsByZone, unassignedComponents, edges, settings, dispatchContext))
  for (const zone of zones) {
    fs.writeFileSync(join(base, 'prompts', `${sanitize(zone.data.label)}.md`), buildZonePrompt(zone, componentsByZone, zoneEdges, intraEdges, zones))
  }
}

export async function runGraph(
  win: BrowserWindow,
  nodes: GraphNode[],
  edges: GraphEdge[],
  projectDir: string,
  rawSettings: unknown,
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] },
): Promise<TerminalInfo[]> {
  killAll()
  const settings = normalizeProjectSettings(rawSettings)
  setupWorkspace(projectDir, nodes, edges, settings, dispatchContext)

  const { zones } = indexGraph(nodes)
  const zoneIdSet = new Set(zones.map(z => z.id))
  const zoneEdges = edges.filter(e => zoneIdSet.has(e.source) && zoneIdSet.has(e.target))

  const sorted = topoSort(zones, zoneEdges)
  const promptsDir = join(projectDir, 'ARCHITECT', 'prompts')
  const tasksDir = join(projectDir, 'ARCHITECT', 'tasks')

  const allInfo: TerminalInfo[] = [
    { id: 'architect-agent', label: 'Architect', runtime: settings.defaultRuntime },
    ...sorted.map(zone => ({ id: zone.id, label: zone.data.label, runtime: getZoneRuntime(zone, settings) })),
  ]

  const zoneBySafe = new Map(sorted.map(zone => [sanitize(zone.data.label), zone]))
  const triggered = new Set<string>()
  const taskReady = new Set<string>()
  const agentDone = new Set<string>()

  const upstreamMap = new Map<string, string[]>()
  const downstreamMap = new Map<string, string[]>()
  for (const zone of sorted) {
    const safe = sanitize(zone.data.label)
    upstreamMap.set(safe, zoneEdges
      .filter(edge => edge.target === zone.id)
      .map(edge => sorted.find(z => z.id === edge.source))
      .filter(Boolean)
      .map(z => sanitize(z!.data.label)))
    downstreamMap.set(safe, zoneEdges
      .filter(edge => edge.source === zone.id)
      .map(edge => sorted.find(z => z.id === edge.target))
      .filter(Boolean)
      .map(z => sanitize(z!.data.label)))
  }

  function trySpawnZone(safe: string) {
    if (triggered.has(safe) || !taskReady.has(safe)) return
    if ((upstreamMap.get(safe) ?? []).some(upstream => !agentDone.has(upstream))) return

    triggered.add(safe)
    const zone = zoneBySafe.get(safe)!
    const env: Record<string, string> = {}
    for (const { key, value } of zone.data.envVars ?? []) {
      if (key) env[key] = value
    }

    const runtime = getZoneRuntime(zone, settings)
    const model = getZoneModel(zone, runtime)
    const prompt = fs.readFileSync(join(promptsDir, `${safe}.md`), 'utf-8')

    spawnAgentSession({
      win,
      id: zone.id,
      label: zone.data.label,
      runtime,
      env,
      cwd: projectDir,
      initialPrompt: prompt,
      model,
      capture: { projectDir, zoneSafe: safe },
    })

    onSessionDone(zone.id, () => {
      agentDone.add(safe)
      for (const downstream of downstreamMap.get(safe) ?? []) trySpawnZone(downstream)
      if (triggered.size === zoneBySafe.size) {
        activeWatcher?.close()
        activeWatcher = null
      }
    })
  }

  activeWatcher?.close()
  activeWatcher = fs.watch(tasksDir, (_event, filename) => {
    if (!filename?.endsWith('.md')) return
    const safe = filename.slice(0, -3)
    if (!zoneBySafe.has(safe) || taskReady.has(safe)) return
    try {
      if (fs.statSync(join(tasksDir, filename)).size > 0) {
        taskReady.add(safe)
        trySpawnZone(safe)
      }
    } catch {}
  })

  const architectPrompt = fs.readFileSync(join(promptsDir, 'architect.md'), 'utf-8')
  spawnAgentSession({
    win,
    id: 'architect-agent',
    label: 'Architect',
    runtime: settings.defaultRuntime,
    env: {},
    cwd: projectDir,
    initialPrompt: architectPrompt,
    model: DEFAULT_MODEL_BY_RUNTIME[settings.defaultRuntime],
    capture: { projectDir, zoneSafe: 'Architect' },
  })

  return allInfo
}

const ASSISTANT_ZONE_SAFE = sanitize('Architecture Assistant')

export function startAssistant(
  win: BrowserWindow,
  projectDir: string,
  contextMd: string,
  runtime: AgentRuntime,
): TerminalInfo {
  const existing = sessions.get('architect-assistant')
  if (existing) {
    try { existing.pty.kill() } catch {}
    sessions.delete('architect-assistant')
  }

  const safeRuntime = isAgentRuntime(runtime) ? runtime : DEFAULT_AGENT_RUNTIME
  const architectDir = join(projectDir, 'ARCHITECT')
  fs.mkdirSync(architectDir, { recursive: true })
  // Always keep the context file fresh so the assistant can re-read on demand
  // ("re-read ARCHITECT/.assistant-context.md"), but don't auto-inject it.
  const contextFile = join(architectDir, '.assistant-context.md')
  fs.writeFileSync(contextFile, contextMd)

  // Resume the prior Claude session if one exists for this assistant on this
  // project — avoids re-injecting the context file on every reopen.
  const saved = loadZoneSession(projectDir, ASSISTANT_ZONE_SAFE)
  const canResume =
    saved && saved.runtime === 'claude' && safeRuntime === 'claude'
  console.log(
    `[assistant] runtime=${safeRuntime} saved=${saved ? saved.sessionId : 'none'} → ${canResume ? 'RESUMING' : 'fresh start'}`,
  )

  return spawnAgentSession({
    win,
    id: 'architect-assistant',
    label: 'Architecture Assistant',
    runtime: safeRuntime,
    env: {},
    cwd: projectDir,
    initialPrompt: canResume ? undefined : 'Read ARCHITECT/.assistant-context.md',
    resumeSessionId: canResume ? saved!.sessionId : undefined,
    model: DEFAULT_MODEL_BY_RUNTIME[safeRuntime],
    capture: { projectDir, zoneSafe: ASSISTANT_ZONE_SAFE },
    // Interactive: keep normal permission prompts. The user is sitting here.
    skipPermissions: false,
  })
}

export function stopAssistant() {
  const session = sessions.get('architect-assistant')
  if (session) {
    try { session.pty.kill() } catch {}
    sessions.delete('architect-assistant')
  }
}

export interface ResumeZoneOptions {
  projectDir: string
  zoneId: string
  label: string
  runtime: AgentRuntime
  model?: string
  envVars?: Array<{ key: string; value: string }>
}

export interface ResumeResult {
  ok: boolean
  reason?: string
  info?: TerminalInfo
  sessionId?: string
}

// Re-spawns a zone agent using its persisted session ID, replacing any
// existing PTY for that zone (same id keeps the same renderer tab).
export function resumeZone(win: BrowserWindow, opts: ResumeZoneOptions): ResumeResult {
  const zoneSafe = sanitize(opts.label)
  const saved: ZoneSession | null = loadZoneSession(opts.projectDir, zoneSafe)
  if (!saved) return { ok: false, reason: 'no-saved-session' }
  if (saved.runtime !== opts.runtime) {
    return { ok: false, reason: `session-runtime-mismatch:${saved.runtime}` }
  }
  if (opts.runtime !== 'claude') {
    return { ok: false, reason: `resume-not-supported:${opts.runtime}` }
  }

  const existing = sessions.get(opts.zoneId)
  if (existing) {
    try { existing.pty.kill() } catch {}
    sessions.delete(opts.zoneId)
  }

  const env: Record<string, string> = {}
  for (const { key, value } of opts.envVars ?? []) {
    if (key) env[key] = value
  }

  const info = spawnAgentSession({
    win,
    id: opts.zoneId,
    label: opts.label,
    runtime: opts.runtime,
    env,
    cwd: opts.projectDir,
    model: opts.model,
    resumeSessionId: saved.sessionId,
  })

  return { ok: true, info, sessionId: saved.sessionId }
}

export function getZoneSession(projectDir: string, label: string): ZoneSession | null {
  return loadZoneSession(projectDir, sanitize(label))
}
