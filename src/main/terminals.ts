import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join } from 'path'
import fs from 'fs'
import { execFileSync, execFile } from 'child_process'

// Augment PATH with common locations so node-pty can find binaries
const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]
process.env.PATH = [...EXTRA_PATHS, ...(process.env.PATH || '').split(':')].join(':')

// Resolve claude binary — try shell first, fall back to known locations
function resolveClaude(): string {
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    return execFileSync(shell, ['-l', '-c', 'which claude'], { encoding: 'utf-8' }).trim()
  } catch {
    return 'claude'
  }
}

const CLAUDE_BIN = resolveClaude()

export interface TerminalInfo {
  id: string
  label: string
}

export interface GraphNode {
  id: string
  data: {
    label: string
    tag: string
    description: string
    prompt: string
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
  ready: boolean
  callbacks: (() => void)[]
  done: boolean
  doneCallbacks: (() => void)[]
}

const sessions = new Map<string, Session>()
let activeWatcher: fs.FSWatcher | null = null

// ── PTY management ─────────────────────────────────────────────────────────

function spawnClaude(
  win: BrowserWindow,
  id: string,
  label: string,
  env: Record<string, string>,
  cwd: string,
): TerminalInfo {
  const ptyProcess = pty.spawn(CLAUDE_BIN, ['--dangerously-skip-permissions'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
  })

  const session: Session = { pty: ptyProcess, buffer: '', ready: false, callbacks: [], done: false, doneCallbacks: [] }
  sessions.set(id, session)

  ptyProcess.onData(data => {
    session.buffer += data
    // Claude Code's interactive prompt ends with > or ❯
    if (!session.ready && /[>❯]\s*$/.test(session.buffer)) {
      session.ready = true
      session.callbacks.splice(0).forEach(cb => cb())
    }
    if (!session.done && session.buffer.includes('ARCHITECT_COMPLETE')) {
      session.done = true
      session.doneCallbacks.splice(0).forEach(cb => cb())
    }
    if (!win.isDestroyed()) win.webContents.send('terminal:data', { id, data })
  })

  ptyProcess.onExit(({ exitCode }) => {
    if (!win.isDestroyed()) win.webContents.send('terminal:exit', { id, exitCode })
    sessions.delete(id)
  })

  return { id, label }
}

function waitForReady(id: string, timeout = 30_000): Promise<void> {
  return new Promise(resolve => {
    const s = sessions.get(id)
    if (!s || s.ready) { resolve(); return }
    s.callbacks.push(resolve)
    setTimeout(() => {
      const s2 = sessions.get(id)
      if (s2 && !s2.ready) { s2.ready = true; s2.callbacks.splice(0).forEach(cb => cb()) }
      resolve()
    }, timeout)
  })
}

export function writeToTerminal(id: string, data: string) {
  sessions.get(id)?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  try { sessions.get(id)?.pty.resize(cols, rows) } catch {}
}

function onSessionDone(id: string, cb: () => void) {
  const s = sessions.get(id)
  if (!s) return
  if (s.done) { cb(); return }
  s.doneCallbacks.push(cb)
}

export function killAll() {
  activeWatcher?.close()
  activeWatcher = null
  sessions.forEach(s => { try { s.pty.kill() } catch {} })
  sessions.clear()
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
  const inDegree = new Map(nodes.map(n => [n.id, 0]))
  const adj      = new Map(nodes.map(n => [n.id, [] as string[]]))
  edges.forEach(e => {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
    adj.get(e.source)?.push(e.target)
  })
  const queue  = nodes.filter(n => inDegree.get(n.id) === 0)
  const result: GraphNode[] = []
  while (queue.length) {
    const node = queue.shift()!
    result.push(node)
    for (const nid of adj.get(node.id) ?? []) {
      const d = (inDegree.get(nid) ?? 1) - 1
      inDegree.set(nid, d)
      if (d === 0) queue.push(nodes.find(n => n.id === nid)!)
    }
  }
  nodes.forEach(n => { if (!result.find(r => r.id === n.id)) result.push(n) })
  return result
}

// ── Prompt builders ────────────────────────────────────────────────────────

function buildMermaidDiagram(nodes: GraphNode[], edges: GraphEdge[]): string {
  const nodeLines = nodes.map(n => `  ${n.id}["${n.data.label} [${n.data.tag}]"]`)
  const edgeLines = edges.map(e => `  ${e.source} --> ${e.target}`)
  return ['```mermaid', 'graph TD', ...nodeLines, ...edgeLines, '```'].join('\n')
}

function buildArchitectPrompt(
  nodes: GraphNode[],
  edges: GraphEdge[],
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] }
): string {
  const agentList = nodes.map(n => {
    const up   = edges.filter(e => e.target === n.id).map(e => nodes.find(x => x.id === e.source)?.data.label).filter(Boolean)
    const down = edges.filter(e => e.source === n.id).map(e => nodes.find(x => x.id === e.target)?.data.label).filter(Boolean)
    return [
      `### ${n.data.label} [${n.data.tag}]`,
      `Description: ${n.data.description}`,
      n.data.prompt ? `User goal: ${n.data.prompt}` : '',
      up.length   ? `Upstream: ${up.join(', ')}`   : '',
      down.length ? `Downstream: ${down.join(', ')}` : '',
      `Task file: ARCHITECT/tasks/${sanitize(n.data.label)}.md`,
      `Output file: ARCHITECT/outputs/${sanitize(n.data.label)}.md`,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  const flowLines = edges.length
    ? edges.map(e => `  ${nodes.find(n => n.id === e.source)?.data.label} → ${nodes.find(n => n.id === e.target)?.data.label}`).join('\n')
    : '  (agents run independently)'

  return `You are the Architect agent coordinating a multi-agent system. The other agents are already running as interactive Claude Code sessions. Each agent is waiting and will automatically read its task file the moment you write it — you do not need to contact them directly.

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
4. Monitor ARCHITECT/outputs/ — when agents complete, coordinate handoffs by updating downstream task files with actual upstream output details

Start immediately. Write the task files now.${
    dispatchContext?.isRedispatch
      ? `\n\n## Execution Mode\nREDISPATCH — existing outputs may be present in ARCHITECT/outputs/.\n${
          dispatchContext.changedNodeLabels.length > 0
            ? `Only the following agents have changed and MUST be re-run: ${dispatchContext.changedNodeLabels.join(', ')}.\nDo NOT re-run unchanged agents unless their upstream inputs changed.`
            : 'No agent configurations changed. Only re-run agents that previously failed or need updating.'
        }`
      : ''
  }`
}

function buildNodePrompt(node: GraphNode, edges: GraphEdge[], nodes: GraphNode[]): string {
  const safe       = sanitize(node.data.label)
  const outputFile = `ARCHITECT/outputs/${safe}.md`

  const upstream   = edges.filter(e => e.target === node.id).map(e => nodes.find(x => x.id === e.source)?.data.label).filter(Boolean)
  const downstream = edges.filter(e => e.source === node.id).map(e => nodes.find(x => x.id === e.target)?.data.label).filter(Boolean)
  const tools      = Object.entries(node.data.tools ?? {}).filter(([, v]) => v).map(([k]) => k)
  const skills     = (node.data.skills ?? []).map(s => { const c = readSkillContent(s.path); return c ? `### ${s.name}\n${c}` : '' }).filter(Boolean).join('\n\n')

  return `You are the ${node.data.label} agent [${node.data.tag}] — ${node.data.description}.
${node.data.prompt ? `\nUser goal: ${node.data.prompt}\n` : ''}
${upstream.length   ? `Upstream agents (read their output files first): ${upstream.map(u => `ARCHITECT/outputs/${sanitize(u as string)}.md`).join(', ')}\n` : ''}
${downstream.length ? `Downstream agents depending on you: ${downstream.join(', ')}\n` : ''}
${tools.length ? `Enabled tools: ${tools.join(', ')}\n` : ''}
${skills ? `${skills}\n` : ''}
## Instructions

Your task file has already been written and is ready to read. Execute every instruction in it immediately and concretely — create files, write code, implement everything specified.

Write your progress and final output to: ${outputFile}

If you have downstream agents, clearly document your interfaces (ports, schemas, file paths) in your output file.

Work fully autonomously — do not stop or ask for clarification.

When you have finished ALL work and written your final output to ${outputFile}, run this exact shell command as your last action:
\`\`\`
echo ARCHITECT_COMPLETE
\`\`\``
}

// ── Workspace setup ────────────────────────────────────────────────────────

function setupWorkspace(
  projectDir: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] }
) {
  const base = join(projectDir, 'ARCHITECT')
  for (const d of ['tasks', 'outputs', 'prompts'].map(s => join(base, s))) {
    fs.mkdirSync(d, { recursive: true })
  }

  // Manifest
  fs.writeFileSync(join(base, 'manifest.json'), JSON.stringify({
    generated: new Date().toISOString(),
    agents: nodes.map(n => ({
      label: n.data.label, tag: n.data.tag, description: n.data.description,
      userPrompt: n.data.prompt || null,
      taskFile:   `ARCHITECT/tasks/${sanitize(n.data.label)}.md`,
      outputFile: `ARCHITECT/outputs/${sanitize(n.data.label)}.md`,
      enabledTools: Object.entries(n.data.tools ?? {}).filter(([, v]) => v).map(([k]) => k),
      upstream:   edges.filter(e => e.target === n.id).map(e => nodes.find(x => x.id === e.source)?.data.label).filter(Boolean),
      downstream: edges.filter(e => e.source === n.id).map(e => nodes.find(x => x.id === e.target)?.data.label).filter(Boolean),
    })),
  }, null, 2))

  // Prompt files — one per agent so we never paste multi-line text into the terminal
  fs.writeFileSync(join(base, 'diagram.md'), buildMermaidDiagram(nodes, edges))
  fs.writeFileSync(join(base, 'prompts', 'architect.md'), buildArchitectPrompt(nodes, edges, dispatchContext))
  for (const node of nodes) {
    fs.writeFileSync(join(base, 'prompts', `${sanitize(node.data.label)}.md`), buildNodePrompt(node, edges, nodes))
  }
}

// ── Main entry point ───────────────────────────────────────────────────────
// We write prompts to files and send each terminal a short single-line command.
// Single-line = no multi-line paste issues. \r = carriage return = Enter in PTY.
// Overseer gets no \r — user reads the short message and presses Enter once.
// Node agents get \r — auto-submit, fully hands-off.

export async function runGraph(
  win: BrowserWindow,
  nodes: GraphNode[],
  edges: GraphEdge[],
  projectDir: string,
  dispatchContext?: { isRedispatch: boolean; changedNodeLabels: string[] },
): Promise<TerminalInfo[]> {
  killAll()

  setupWorkspace(projectDir, nodes, edges, dispatchContext)

  const sorted  = topoSort(nodes, edges)
  const created: TerminalInfo[] = []

  // Spawn all sessions (they all start loading claude simultaneously)
  created.push(spawnClaude(win, 'architect-agent', 'Architect', {}, projectDir))
  for (const node of sorted) {
    const env: Record<string, string> = {}
    for (const { key, value } of node.data.envVars ?? []) { if (key) env[key] = value }
    created.push(spawnClaude(win, node.id, node.data.label, env, projectDir))
  }

  // Wire up prompts — each session fires as soon as IT is ready, not when all are ready.
  const tasksDir   = join(projectDir, 'ARCHITECT', 'tasks')
  const nodeMap    = new Map(sorted.map(n => [sanitize(n.data.label), n]))
  const triggered  = new Set<string>()
  const taskReady  = new Set<string>()

  // Build downstream adjacency so completion tokens can immediately unblock dependents.
  const downstreamMap = new Map<string, string[]>()
  for (const node of sorted) {
    const safe = sanitize(node.data.label)
    const downSafes = edges
      .filter(e => e.source === node.id)
      .map(e => nodes.find(n => n.id === e.target))
      .filter(Boolean)
      .map(n => sanitize(n!.data.label))
    downstreamMap.set(safe, downSafes)
  }

  // Fires only when BOTH the session is ready AND its task file has content.
  function tryTrigger(safe: string) {
    if (triggered.has(safe)) return
    const node = nodeMap.get(safe)
    if (!node) return
    const session = sessions.get(node.id)
    if (!session?.ready) return
    if (!taskReady.has(safe)) return
    triggered.add(safe)
    writeToTerminal(node.id,
      `Read ARCHITECT/prompts/${safe}.md to understand your role, then read ARCHITECT/tasks/${safe}.md and execute every instruction. Write all output to ARCHITECT/outputs/${safe}.md.\r`
    )
    if (triggered.size === nodeMap.size) {
      activeWatcher?.close()
      activeWatcher = null
    }
  }

  // fs.watch fires the instant Architect writes a task file — no polling delay.
  activeWatcher?.close()
  activeWatcher = fs.watch(tasksDir, (_event, filename) => {
    if (!filename?.endsWith('.md')) return
    const safe = filename.slice(0, -3)
    if (!nodeMap.has(safe) || taskReady.has(safe)) return
    try {
      if (fs.statSync(join(tasksDir, filename)).size > 0) {
        taskReady.add(safe)
        tryTrigger(safe)
      }
    } catch { /* race: file briefly absent */ }
  })

  // Architect gets its prompt the moment it reaches the > prompt.
  waitForReady('architect-agent', 30_000).then(() => {
    writeToTerminal('architect-agent',
      'Read the file ARCHITECT/prompts/architect.md and follow every instruction in it exactly.\r'
    )
  })

  // Each node agent: trigger as soon as it is ready (task file may already be there).
  for (const node of sorted) {
    const safe = sanitize(node.data.label)

    waitForReady(node.id, 30_000).then(() => tryTrigger(safe))

    // Completion token: when this agent emits ARCHITECT_COMPLETE, immediately unblock
    // any downstream agents whose task files are already written.
    onSessionDone(node.id, () => {
      for (const downSafe of downstreamMap.get(safe) ?? []) {
        tryTrigger(downSafe)
      }
    })
  }

  return created
}

// ── AI diagram generation ──────────────────────────────────────────────────

export function generateDiagramWithClaude(
  description: string
): Promise<{ nodes: unknown[]; edges: unknown[] }> {
  const prompt = `You are generating a multi-agent pipeline diagram for an app called Architect.
Return ONLY valid JSON — no markdown fences, no explanation, nothing else. Use this exact structure:
{
  "nodes": [
    {
      "id": "kebab-case-id",
      "label": "Human Readable Name",
      "description": "One sentence of what this agent does",
      "category": "infrastructure",
      "iconName": "Settings2",
      "color": "#60a5fa",
      "tag": "SHORT",
      "prompt": "Detailed specific instructions for this agent..."
    }
  ],
  "edges": [
    { "id": "e1", "source": "node-id-a", "target": "node-id-b" }
  ]
}

Available categories: infrastructure, services, storage
Available iconNames: Monitor, Shield, Lock, Settings2, Brain, Layers, Database, Zap, Wrench, BookOpen, Search, Terminal, RefreshCw, GitBranch, Users, ScanLine, Gauge, ClipboardList
Use 3–7 nodes. Assign each node a distinct hex color. Keep tags under 6 chars.

System to model: ${description}`

  return new Promise((resolve, reject) => {
    execFile(CLAUDE_BIN, ['-p', prompt], { timeout: 60_000 }, (err, stdout) => {
      if (err) { reject(err.message); return }
      try {
        const match = stdout.match(/\{[\s\S]*\}/)
        if (!match) { reject('No JSON found in Claude response'); return }
        resolve(JSON.parse(match[0]))
      } catch {
        reject('Failed to parse JSON from Claude response')
      }
    })
  })
}
