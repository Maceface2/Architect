import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join } from 'path'
import fs from 'fs'

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
}

const sessions = new Map<string, Session>()

// ── PTY management ─────────────────────────────────────────────────────────

function spawnClaude(
  win: BrowserWindow,
  id: string,
  label: string,
  env: Record<string, string>,
  cwd: string,
): TerminalInfo {
  const ptyProcess = pty.spawn('claude', ['--dangerously-skip-permissions'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
  })

  const session: Session = { pty: ptyProcess, buffer: '', ready: false, callbacks: [] }
  sessions.set(id, session)

  ptyProcess.onData(data => {
    session.buffer += data
    // Claude Code's interactive prompt ends with > or ❯
    if (!session.ready && /[>❯]\s*$/.test(session.buffer)) {
      session.ready = true
      session.callbacks.splice(0).forEach(cb => cb())
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

export function killAll() {
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

function buildOverseerPrompt(nodes: GraphNode[], edges: GraphEdge[]): string {
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

  return `You are the Overseer agent coordinating a multi-agent system. The other agents are already running as interactive Claude Code sessions. Each agent is waiting and will automatically read its task file the moment you write it — you do not need to contact them directly.

DO NOT use the Task tool or spawn sub-agents. Coordinate exclusively through the filesystem.

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

3. After writing all task files, write your coordination log to ARCHITECT/outputs/Overseer.md
4. Monitor ARCHITECT/outputs/ — when agents complete, coordinate handoffs by updating downstream task files with actual upstream output details

Start immediately. Write the task files now.`
}

function buildNodePrompt(node: GraphNode, edges: GraphEdge[], nodes: GraphNode[]): string {
  const safe       = sanitize(node.data.label)
  const taskFile   = `ARCHITECT/tasks/${safe}.md`
  const outputFile = `ARCHITECT/outputs/${safe}.md`

  const upstream   = edges.filter(e => e.target === node.id).map(e => nodes.find(x => x.id === e.source)?.data.label).filter(Boolean)
  const downstream = edges.filter(e => e.source === node.id).map(e => nodes.find(x => x.id === e.target)?.data.label).filter(Boolean)
  const tools      = Object.entries(node.data.tools ?? {}).filter(([, v]) => v).map(([k]) => k)
  const skills     = (node.data.skills ?? []).map(s => { const c = readSkillContent(s.path); return c ? `### ${s.name}\n${c}` : '' }).filter(Boolean).join('\n\n')

  return `You are the ${node.data.label} agent [${node.data.tag}] — ${node.data.description}.
${node.data.prompt ? `\nUser goal: ${node.data.prompt}\n` : ''}
${upstream.length   ? `Upstream agents (read their output files): ${upstream.map(u => `ARCHITECT/outputs/${sanitize(u as string)}.md`).join(', ')}\n` : ''}
${downstream.length ? `Downstream agents depending on you: ${downstream.join(', ')}\n` : ''}
${tools.length ? `Enabled tools: ${tools.join(', ')}\n` : ''}
${skills ? `${skills}\n` : ''}
## Your task

Your task file is: ${taskFile}
The Overseer is writing this file right now. You MUST wait for it before doing anything else.

Poll for it using the Bash tool in a loop — do not stop until the file exists:

\`\`\`
while true; do
  if [ -f "${taskFile}" ]; then
    echo "READY"
    break
  else
    echo "WAITING..."
    sleep 10
  fi
done
\`\`\`

Run that exact bash command now. It will block until the file appears. Do NOT proceed until you see "READY".

Once READY:
1. Read the task file with the Bash tool: cat "${taskFile}"
2. Execute every instruction in it — create files, write code, implement everything concretely
3. Write your progress and final output to: ${outputFile}
4. If you have downstream agents, clearly document your interfaces in your output file

Start the polling loop now. Work fully autonomously — do not stop or ask for clarification.`
}

// ── Workspace setup ────────────────────────────────────────────────────────

function setupWorkspace(projectDir: string, nodes: GraphNode[], edges: GraphEdge[]) {
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
  fs.writeFileSync(join(base, 'prompts', 'overseer.md'), buildOverseerPrompt(nodes, edges))
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
): Promise<TerminalInfo[]> {
  killAll()

  setupWorkspace(projectDir, nodes, edges)

  const sorted  = topoSort(nodes, edges)
  const created: TerminalInfo[] = []

  // Spawn all sessions (they all start loading claude simultaneously)
  created.push(spawnClaude(win, 'overseer', 'Overseer', {}, projectDir))
  for (const node of sorted) {
    const env: Record<string, string> = {}
    for (const { key, value } of node.data.envVars ?? []) { if (key) env[key] = value }
    created.push(spawnClaude(win, node.id, node.data.label, env, projectDir))
  }

  // Wire up prompts after ready — don't block the IPC return
  ;(async () => {
    // Wait for all sessions to show the > prompt
    await Promise.all(created.map(c => waitForReady(c.id, 30_000)))

    // Overseer: auto-submit with \r — fully hands-off like node agents
    writeToTerminal('overseer',
      'Read the file ARCHITECT/prompts/overseer.md and follow every instruction in it exactly.\r'
    )

    // Node agents: same pattern but WITH \r — fully automatic, no human input needed
    for (let i = 0; i < sorted.length; i++) {
      await sleep(600)
      const node = sorted[i]
      const safe = sanitize(node.data.label)
      writeToTerminal(node.id,
        `Read the file ARCHITECT/prompts/${safe}.md and follow every instruction in it exactly.\r`
      )
    }
  })().catch(err => console.error('[Architect] orchestration error:', err))

  return created
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}
