import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join } from 'path'
import fs from 'fs'
import { execFileSync } from 'child_process'
import {
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  isAgentRuntime,
  isAgentRuntimeMode,
  type AgentRuntime,
} from '../shared/agentRuntimes'

// Augment PATH with common locations so node-pty can find binaries
const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]
process.env.PATH = [...EXTRA_PATHS, ...(process.env.PATH || '').split(':')].join(':')

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

export interface TerminalInfo {
  id: string
  label: string
  runtime: AgentRuntime
}

export interface GraphNode {
  id: string
  data: {
    label: string
    tag: string
    description: string
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

interface SpawnSessionOptions {
  win: BrowserWindow
  id: string
  label: string
  runtime: AgentRuntime
  env: Record<string, string>
  cwd: string
  initialPrompt?: string
  model?: string
  onExit?: () => void
}

const sessions = new Map<string, Session>()
let activeWatcher: fs.FSWatcher | null = null

function buildRuntimeArgs(runtime: AgentRuntime, prompt?: string, model?: string): string[] {
  switch (runtime) {
    case 'claude': {
      const args: string[] = ['--dangerously-skip-permissions']
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

function createSession(
  win: BrowserWindow,
  id: string,
  label: string,
  runtime: AgentRuntime,
  ptyProcess: pty.IPty,
  onExit?: () => void
): TerminalInfo {
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
    sessions.delete(id)
    onExit?.()
  })

  return { id, label, runtime }
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

  return createSession(win, id, label, runtime, ptyProcess, onExit)
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
}: SpawnSessionOptions): TerminalInfo {
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

  const ptyProcess = pty.spawn(bin, buildRuntimeArgs(runtime, initialPrompt, model), {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
  })

  return createSession(win, id, label, runtime, ptyProcess, onExit)
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

export function killAll() {
  activeWatcher?.close()
  activeWatcher = null
  sessions.forEach(session => { try { session.pty.kill() } catch {} })
  sessions.clear()
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

function topoSort(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const inDegree = new Map(nodes.map(node => [node.id, 0]))
  const adj = new Map(nodes.map(node => [node.id, [] as string[]]))

  edges.forEach(edge => {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    adj.get(edge.source)?.push(edge.target)
  })

  const queue = nodes.filter(node => inDegree.get(node.id) === 0)
  const result: GraphNode[] = []

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

function getNodeRuntime(node: GraphNode, settings: ProjectSettings): AgentRuntime {
  return isAgentRuntimeMode(node.data.agentRuntimeMode) && node.data.agentRuntimeMode === 'override' && isAgentRuntime(node.data.agentRuntime)
    ? node.data.agentRuntime
    : settings.defaultRuntime
}

function getNodeModel(node: GraphNode, runtime: AgentRuntime): string {
  return node.data.providerModels?.[runtime] || node.data.model || DEFAULT_MODEL_BY_RUNTIME[runtime]
}

function buildMermaidDiagram(nodes: GraphNode[], edges: GraphEdge[]): string {
  const nodeLines = nodes.map(node => `  ${node.id}["${node.data.label} [${node.data.tag}]"]`)
  const edgeLines = edges.map(edge => `  ${edge.source} --> ${edge.target}`)
  return ['```mermaid', 'graph TD', ...nodeLines, ...edgeLines, '```'].join('\n')
}

function buildArchitectPrompt(
  nodes: GraphNode[],
  edges: GraphEdge[],
  settings: ProjectSettings,
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] }
): string {
  const agentList = nodes.map(node => {
    const upstream = edges.filter(edge => edge.target === node.id).map(edge => nodes.find(candidate => candidate.id === edge.source)?.data.label).filter(Boolean)
    const downstream = edges.filter(edge => edge.source === node.id).map(edge => nodes.find(candidate => candidate.id === edge.target)?.data.label).filter(Boolean)
    const runtime = getNodeRuntime(node, settings)
    const model = getNodeModel(node, runtime)

    return [
      `### ${node.data.label} [${node.data.tag}]`,
      `Description: ${node.data.description}`,
      `Runtime: ${getAgentRuntime(runtime).label}`,
      `Model: ${model}`,
      node.data.prompt ? `User goal: ${node.data.prompt}` : '',
      upstream.length ? `Upstream: ${upstream.join(', ')}` : '',
      downstream.length ? `Downstream: ${downstream.join(', ')}` : '',
      `Task file: ARCHITECT/tasks/${sanitize(node.data.label)}.md`,
      `Status log: ARCHITECT/outputs/${sanitize(node.data.label)}.md (progress notes only — actual code goes in the project root)`,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  const flowLines = edges.length
    ? edges.map(edge => `  ${nodes.find(node => node.id === edge.source)?.data.label} → ${nodes.find(node => node.id === edge.target)?.data.label}`).join('\n')
    : '  (agents run independently)'

  return `You are the Architect agent coordinating a multi-agent system. The other agents are already running as interactive coding CLI sessions. Each agent is waiting and will automatically read its task file the moment you write it — you do not need to contact them directly.

DO NOT use the Task tool or spawn sub-agents. Coordinate exclusively through the filesystem.

## Architecture Diagram
${buildMermaidDiagram(nodes, edges)}

## Agents
${agentList}

## Data Flow
${flowLines}

## Your job

1. Read ARCHITECT/manifest.json for full details
2. Write a task file for EVERY agent listed above. Write them in dependency order (upstream first).
   Each task file must contain:
   - Specific files to create and their exact content/structure
   - API contracts, ports, endpoints, schemas
   - What to read from upstream agents' output files
   - Clear acceptance criteria

3. After writing all task files, write your coordination log to ARCHITECT/outputs/Architect.md
4. Monitor ARCHITECT/outputs/ — when agents complete (they write their status log there), coordinate handoffs by updating downstream task files with actual details

IMPORTANT: Agents must create all real project files (source code, configs, etc.) directly in the project root working directory, NOT inside ARCHITECT/. The ARCHITECT/ folder is only for coordination files (manifests, prompts, tasks, status logs).

Start immediately. Write the task files now.${dispatchContext?.isRedispatch
    ? `\n\n## Execution Mode\nREDISPATCH — existing outputs may be present in ARCHITECT/outputs/.\n${dispatchContext.changedNodeLabels.length > 0
        ? `Only the following agents have changed and MUST be re-run: ${dispatchContext.changedNodeLabels.join(', ')}.\nDo NOT re-run unchanged agents unless their upstream inputs changed.`
        : 'No agent configurations changed. Only re-run agents that previously failed or need updating.'}`
    : ''}`
}

function buildNodePrompt(node: GraphNode, edges: GraphEdge[], nodes: GraphNode[]): string {
  const safe = sanitize(node.data.label)
  const statusLog = `ARCHITECT/outputs/${safe}.md`

  const upstream = edges.filter(edge => edge.target === node.id).map(edge => nodes.find(candidate => candidate.id === edge.source)?.data.label).filter(Boolean)
  const downstream = edges.filter(edge => edge.source === node.id).map(edge => nodes.find(candidate => candidate.id === edge.target)?.data.label).filter(Boolean)
  const tools = Object.entries(node.data.tools ?? {}).filter(([, enabled]) => enabled).map(([key]) => key)
  const skills = (node.data.skills ?? [])
    .map(skill => {
      const content = readSkillContent(skill.path)
      return content ? `### ${skill.name}\n${content}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

  return `You are the ${node.data.label} agent [${node.data.tag}] — ${node.data.description}.
${node.data.prompt ? `\nUser goal: ${node.data.prompt}\n` : ''}
${upstream.length ? `Upstream agents (read their status logs first): ${upstream.map(label => `ARCHITECT/outputs/${sanitize(label as string)}.md`).join(', ')}\n` : ''}
${downstream.length ? `Downstream agents depending on you: ${downstream.join(', ')}\n` : ''}
${tools.length ? `Enabled tools: ${tools.join(', ')}\n` : ''}
${skills ? `${skills}\n` : ''}
## Instructions

Read ARCHITECT/tasks/${safe}.md and execute every instruction in it immediately and concretely.

**WHERE TO CREATE FILES:**
- All project files (source code, configs, scripts, etc.) go directly in the project root (current working directory). Do NOT put them inside ARCHITECT/.
- ARCHITECT/ is only for coordination: tasks, prompts, and status logs.
- ${statusLog} is your status log — write brief progress notes and a final summary there, not your actual code.

If you have downstream agents, document your interfaces (ports, schemas, file paths) in your status log so they can read it.

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
  for (const dir of ['tasks', 'outputs', 'prompts'].map(name => join(base, name))) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(join(base, 'manifest.json'), JSON.stringify({
    generated: new Date().toISOString(),
    defaultRuntime: settings.defaultRuntime,
    agents: nodes.map(node => {
      const runtime = getNodeRuntime(node, settings)
      return {
        label: node.data.label,
        tag: node.data.tag,
        description: node.data.description,
        runtime,
        runtimeLabel: getAgentRuntime(runtime).label,
        model: getNodeModel(node, runtime),
        userPrompt: node.data.prompt || null,
        taskFile: `ARCHITECT/tasks/${sanitize(node.data.label)}.md`,
        outputFile: `ARCHITECT/outputs/${sanitize(node.data.label)}.md`,
        enabledTools: Object.entries(node.data.tools ?? {}).filter(([, enabled]) => enabled).map(([key]) => key),
        upstream: edges.filter(edge => edge.target === node.id).map(edge => nodes.find(candidate => candidate.id === edge.source)?.data.label).filter(Boolean),
        downstream: edges.filter(edge => edge.source === node.id).map(edge => nodes.find(candidate => candidate.id === edge.target)?.data.label).filter(Boolean),
      }
    }),
  }, null, 2))

  fs.writeFileSync(join(base, 'diagram.md'), buildMermaidDiagram(nodes, edges))
  fs.writeFileSync(join(base, 'prompts', 'architect.md'), buildArchitectPrompt(nodes, edges, settings, dispatchContext))
  for (const node of nodes) {
    fs.writeFileSync(join(base, 'prompts', `${sanitize(node.data.label)}.md`), buildNodePrompt(node, edges, nodes))
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

  const sorted = topoSort(nodes, edges)
  const promptsDir = join(projectDir, 'ARCHITECT', 'prompts')
  const tasksDir = join(projectDir, 'ARCHITECT', 'tasks')

  const allInfo: TerminalInfo[] = [
    { id: 'architect-agent', label: 'Architect', runtime: settings.defaultRuntime },
    ...sorted.map(node => ({ id: node.id, label: node.data.label, runtime: getNodeRuntime(node, settings) })),
  ]

  const nodeMap = new Map(sorted.map(node => [sanitize(node.data.label), node]))
  const triggered = new Set<string>()
  const taskReady = new Set<string>()
  const agentDone = new Set<string>()

  const upstreamMap = new Map<string, string[]>()
  const downstreamMap = new Map<string, string[]>()
  for (const node of sorted) {
    const safe = sanitize(node.data.label)
    upstreamMap.set(safe, edges
      .filter(edge => edge.target === node.id)
      .map(edge => nodes.find(candidate => candidate.id === edge.source))
      .filter(Boolean)
      .map(candidate => sanitize(candidate!.data.label)))
    downstreamMap.set(safe, edges
      .filter(edge => edge.source === node.id)
      .map(edge => nodes.find(candidate => candidate.id === edge.target))
      .filter(Boolean)
      .map(candidate => sanitize(candidate!.data.label)))
  }

  function trySpawnNode(safe: string) {
    if (triggered.has(safe) || !taskReady.has(safe)) return
    if ((upstreamMap.get(safe) ?? []).some(upstream => !agentDone.has(upstream))) return

    triggered.add(safe)
    const node = nodeMap.get(safe)!
    const env: Record<string, string> = {}
    for (const { key, value } of node.data.envVars ?? []) {
      if (key) env[key] = value
    }

    const runtime = getNodeRuntime(node, settings)
    const model = getNodeModel(node, runtime)
    const prompt = fs.readFileSync(join(promptsDir, `${safe}.md`), 'utf-8')

    spawnAgentSession({
      win,
      id: node.id,
      label: node.data.label,
      runtime,
      env,
      cwd: projectDir,
      initialPrompt: prompt,
      model,
    })

    onSessionDone(node.id, () => {
      agentDone.add(safe)
      for (const downstream of downstreamMap.get(safe) ?? []) trySpawnNode(downstream)
      if (triggered.size === nodeMap.size) {
        activeWatcher?.close()
        activeWatcher = null
      }
    })
  }

  activeWatcher?.close()
  activeWatcher = fs.watch(tasksDir, (_event, filename) => {
    if (!filename?.endsWith('.md')) return
    const safe = filename.slice(0, -3)
    if (!nodeMap.has(safe) || taskReady.has(safe)) return
    try {
      if (fs.statSync(join(tasksDir, filename)).size > 0) {
        taskReady.add(safe)
        trySpawnNode(safe)
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
  })

  return allInfo
}

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
  const contextFile = join(architectDir, '.assistant-context.md')
  fs.writeFileSync(contextFile, contextMd)

  return spawnAgentSession({
    win,
    id: 'architect-assistant',
    label: 'Architecture Assistant',
    runtime: safeRuntime,
    env: {},
    cwd: projectDir,
    initialPrompt: 'Read ARCHITECT/.assistant-context.md',
    model: DEFAULT_MODEL_BY_RUNTIME[safeRuntime],
    onExit: () => { try { fs.unlinkSync(contextFile) } catch {} },
  })
}

export function stopAssistant() {
  const session = sessions.get('architect-assistant')
  if (session) {
    try { session.pty.kill() } catch {}
    sessions.delete('architect-assistant')
  }
}
