import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join } from 'path'
import os from 'os'
import fs from 'fs'
import { randomUUID } from 'crypto'
import {
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  isAgentRuntime,
  isAgentRuntimeMode,
  type AgentRuntime,
} from '../shared/agentRuntimes'
import type {
  DispatchContext,
  GraphPreflightSummary,
  LaunchIntent,
  LaunchScope,
  PreflightNodeResult,
  PreflightNodeStatus,
  RunGraphOptions,
  RunGraphResult,
} from '../shared/graphDispatch'
import {
  buildRuntimeArgs,
  hasStandaloneToken,
  resolveBinary,
  stripAnsi,
} from './agentCli'

interface ProjectSettings {
  defaultRuntime: AgentRuntime
}

interface LaunchMetadata {
  mode: LaunchScope['mode']
  activeNodeIds: Set<string>
  activeNodeLabels: string[]
  omittedConnectedNodeLabels: string[]
}

interface NodeLaunchPlan {
  node: GraphNode
  preflight: PreflightNodeResult
}

function normalizeProjectSettings(raw: unknown): ProjectSettings {
  const settings = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    defaultRuntime: isAgentRuntime(settings.defaultRuntime) ? settings.defaultRuntime : DEFAULT_AGENT_RUNTIME,
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
    additionalChanges?: string
    claudeSessionId?: string
    ownedPaths?: string[]
    expectedFiles?: string[]
    contracts?: string
    reviewHints?: string
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
  completedAt?: number
  completionToken: string
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
  projectDir?: string
  nodeId?: string
  resumeSessionId?: string
  completionToken?: string
}

const sessions = new Map<string, Session>()
let activeWatcher: fs.FSWatcher | null = null

function hasCompletionToken(buffer: string, token: string) {
  return hasStandaloneToken(buffer, token)
}

function resolveClaudeSessionId(projectDir: string): string | null {
  try {
    const encoded = projectDir.replace(/\//g, '-')
    const sessionsDir = join(os.homedir(), '.claude', 'projects', encoded)
    const entries = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ sessionId: f.slice(0, -6), mtime: fs.statSync(join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return entries.length > 0 ? entries[0].sessionId : null
  } catch { return null }
}

function createSession(
  win: BrowserWindow,
  id: string,
  label: string,
  runtime: AgentRuntime,
  ptyProcess: pty.IPty,
  onExit?: () => void,
  projectDir?: string,
  nodeId?: string,
  completionToken?: string,
): TerminalInfo {
  const token = completionToken ?? 'ARCHITECT_COMPLETE'
  const session: Session = { pty: ptyProcess, buffer: '', done: false, doneCallbacks: [], completionToken: token }
  sessions.set(id, session)

  ptyProcess.onData(data => {
    session.buffer += data
    if (!session.done && hasCompletionToken(session.buffer, session.completionToken)) {
      session.done = true
      session.completedAt = Date.now()
      session.doneCallbacks.splice(0).forEach(cb => cb())
      // Kill the PTY now that the agent has signalled completion
      try { session.pty.kill() } catch {}
    }
    if (session.buffer.length > 12000) {
      session.buffer = session.buffer.slice(-12000)
    }
    if (!win.isDestroyed()) win.webContents.send('terminal:data', { id, data })
  })

  ptyProcess.onExit(({ exitCode }) => {
    if (!win.isDestroyed()) win.webContents.send('terminal:exit', { id, exitCode })
    sessions.delete(id)
    onExit?.()
    // After a completed Claude agent exits, find and emit its session ID
    if (session.done && runtime === 'claude' && projectDir && nodeId && !win.isDestroyed()) {
      const sessionId = resolveClaudeSessionId(projectDir)
      if (sessionId) win.webContents.send('node:session-saved', { nodeId, sessionId })
    }
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
  projectDir,
  nodeId,
  resumeSessionId,
  completionToken,
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

  const ptyProcess = pty.spawn(bin, buildRuntimeArgs(runtime, initialPrompt, model, resumeSessionId), {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
  })

  return createSession(win, id, label, runtime, ptyProcess, onExit, projectDir, nodeId, completionToken)
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

function getNodeFileStem(node: Pick<GraphNode, 'id'> | string) {
  return sanitize(typeof node === 'string' ? node : node.id)
}

function getTaskFilePathForNode(node: Pick<GraphNode, 'id'> | string) {
  return `ARCHITECT/tasks/${getNodeFileStem(node)}.md`
}

function getLegacyTaskFilePathForLabel(label: string) {
  return `ARCHITECT/tasks/${sanitize(label)}.md`
}

function getOutputFilePathForNode(node: Pick<GraphNode, 'id'> | string) {
  return `ARCHITECT/outputs/${getNodeFileStem(node)}.md`
}

function getPromptFilePathForNode(node: Pick<GraphNode, 'id'> | string) {
  return `ARCHITECT/prompts/${getNodeFileStem(node)}.md`
}

function normalizeRelativePaths(values: string[] | undefined) {
  return [...new Set((values ?? [])
    .map(value => value.trim().replace(/^\.?\//, '').replace(/\/+$/, ''))
    .filter(Boolean))]
}

function pathExists(projectDir: string, relPath: string) {
  return fs.existsSync(relPath ? join(projectDir, relPath) : projectDir)
}

function outputExists(projectDir: string, node: GraphNode) {
  return fs.existsSync(join(projectDir, getOutputFilePathForNode(node)))
}

function createEmptyPreflightCounts(): GraphPreflightSummary['counts'] {
  return {
    missing: 0,
    adopted: 0,
    needs_delta: 0,
    blocked_by_upstream: 0,
    unchanged: 0,
  }
}

function hasUniqueNodeLabel(label: string, nodes: GraphNode[]) {
  return nodes.filter(node => node.data.label === label).length === 1
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

function resolveLaunchScope(nodes: GraphNode[], edges: GraphEdge[], launchScope?: LaunchScope) {
  if (!launchScope || launchScope.mode === 'all') {
    return {
      nodes,
      edges,
      metadata: {
        mode: 'all' as const,
        activeNodeIds: new Set(nodes.map(node => node.id)),
        activeNodeLabels: nodes.map(node => node.data.label),
        omittedConnectedNodeLabels: [],
      },
    }
  }

  const selectedIds = new Set(
    launchScope.nodeIds.filter(nodeId => nodes.some(node => node.id === nodeId))
  )

  if (selectedIds.size === 0) {
    return {
      nodes,
      edges,
      metadata: {
        mode: 'all' as const,
        activeNodeIds: new Set(nodes.map(node => node.id)),
        activeNodeLabels: nodes.map(node => node.data.label),
        omittedConnectedNodeLabels: [],
      },
    }
  }

  const scopedNodes = nodes.filter(node => selectedIds.has(node.id))
  const scopedEdges = edges.filter(edge => selectedIds.has(edge.source) && selectedIds.has(edge.target))
  const connectedExternalLabels = new Set<string>()

  for (const edge of edges) {
    const sourceInScope = selectedIds.has(edge.source)
    const targetInScope = selectedIds.has(edge.target)
    if (sourceInScope === targetInScope) continue

    const externalNodeId = sourceInScope ? edge.target : edge.source
    const externalNode = nodes.find(node => node.id === externalNodeId)
    if (externalNode) connectedExternalLabels.add(externalNode.data.label)
  }

  return {
    nodes: scopedNodes,
    edges: scopedEdges,
    metadata: {
      mode: launchScope.mode,
      activeNodeIds: selectedIds,
      activeNodeLabels: scopedNodes.map(node => node.data.label),
      omittedConnectedNodeLabels: [...connectedExternalLabels].sort((a, b) => a.localeCompare(b)),
    },
  }
}

function getRelationshipLabels(
  nodeId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  activeNodeIds: Set<string>,
) {
  const labelById = new Map(nodes.map(node => [node.id, node.data.label]))
  const upstreamInScope: string[] = []
  const downstreamInScope: string[] = []
  const upstreamExternal: string[] = []
  const downstreamExternal: string[] = []

  for (const edge of edges) {
    if (edge.target === nodeId) {
      const label = labelById.get(edge.source)
      if (!label) continue
      if (activeNodeIds.has(edge.source)) upstreamInScope.push(label)
      else upstreamExternal.push(label)
    }

    if (edge.source === nodeId) {
      const label = labelById.get(edge.target)
      if (!label) continue
      if (activeNodeIds.has(edge.target)) downstreamInScope.push(label)
      else downstreamExternal.push(label)
    }
  }

  return {
    upstreamInScope,
    downstreamInScope,
    upstreamExternal,
    downstreamExternal,
  }
}

function getNodeRuntime(node: GraphNode, settings: ProjectSettings): AgentRuntime {
  return isAgentRuntimeMode(node.data.agentRuntimeMode) && node.data.agentRuntimeMode === 'override' && isAgentRuntime(node.data.agentRuntime)
    ? node.data.agentRuntime
    : settings.defaultRuntime
}

function getNodeModel(node: GraphNode, runtime: AgentRuntime): string {
  return node.data.providerModels?.[runtime] || node.data.model || DEFAULT_MODEL_BY_RUNTIME[runtime]
}

function buildPreflightSummary(
  projectDir: string,
  scopedNodes: GraphNode[],
  scopedEdges: GraphEdge[],
  dispatchContext?: DispatchContext,
): GraphPreflightSummary {
  const changedNodeIds = new Set(dispatchContext?.changedNodeIds ?? [])
  const counts = createEmptyPreflightCounts()
  const upstreamById = new Map<string, string[]>()

  for (const node of scopedNodes) {
    upstreamById.set(
      node.id,
      scopedEdges.filter(edge => edge.target === node.id).map(edge => edge.source)
    )
  }

  const byId = new Map<string, PreflightNodeResult>()
  const remaining = new Set(scopedNodes.map(node => node.id))

  while (remaining.size > 0) {
    let progressed = false

    for (const node of scopedNodes) {
      if (!remaining.has(node.id)) continue

      const upstreamIds = upstreamById.get(node.id) ?? []
      if (upstreamIds.some(upstreamId => remaining.has(upstreamId))) continue

      const ownedPaths = normalizeRelativePaths(node.data.ownedPaths)
      const expectedFiles = normalizeRelativePaths(node.data.expectedFiles)
      const existingOwnedPaths = ownedPaths.filter(relPath => pathExists(projectDir, relPath))
      const missingOwnedPaths = ownedPaths.filter(relPath => !pathExists(projectDir, relPath))
      const existingExpectedFiles = expectedFiles.filter(relPath => pathExists(projectDir, relPath))
      const missingExpectedFiles = expectedFiles.filter(relPath => !pathExists(projectDir, relPath))
      const trackedPathCount = ownedPaths.length + expectedFiles.length
      const totalExisting = existingOwnedPaths.length + existingExpectedFiles.length
      const hasExistingOutput = outputExists(projectDir, node)
      const explicitDeltaRequested = Boolean(node.data.additionalChanges?.trim())
      const upstreamChanged = upstreamIds.some(upstreamId => {
        const upstream = byId.get(upstreamId)
        return upstream ? upstream.status !== 'unchanged' : false
      })

      let status: PreflightNodeStatus
      let launchIntent: LaunchIntent
      let reason: string

      if (trackedPathCount === 0) {
        status = 'adopted'
        launchIntent = 'plan_delta'
        reason = 'No ownership metadata is defined yet, so this node will inspect the existing project area and document the next delta before editing.'
      } else if (totalExisting === 0) {
        status = 'missing'
        launchIntent = 'build'
        reason = 'None of the owned paths or expected files were found in the workspace.'
      } else if (dispatchContext?.isRedispatch && changedNodeIds.has(node.id)) {
        status = 'needs_delta'
        launchIntent = 'plan_delta'
        reason = 'This node changed since the last full dispatch and should plan the next delta against the current code.'
      } else if (explicitDeltaRequested) {
        status = 'needs_delta'
        launchIntent = 'plan_delta'
        reason = 'Additional changes are queued for this node, so it should inspect current code and apply only the requested delta.'
      } else if (upstreamChanged) {
        status = 'blocked_by_upstream'
        launchIntent = 'plan_delta'
        reason = 'An upstream node is changing in this launch, so this node should review downstream impact before editing.'
      } else if (!hasExistingOutput) {
        status = 'adopted'
        launchIntent = 'plan_delta'
        reason = 'This code already exists in the repo, but Architect has not documented or coordinated it yet.'
      } else {
        status = 'unchanged'
        launchIntent = 'skip'
        reason = 'The owned implementation already exists and no new delta was detected for this launch.'
      }

      const result: PreflightNodeResult = {
        nodeId: node.id,
        label: node.data.label,
        status,
        launchIntent,
        reason,
        ownedPaths,
        existingOwnedPaths,
        missingOwnedPaths,
        expectedFiles,
        existingExpectedFiles,
        missingExpectedFiles,
        upstreamChanged,
        hasExistingOutput,
      }

      byId.set(node.id, result)
      counts[status] += 1
      remaining.delete(node.id)
      progressed = true
    }

    if (!progressed) {
      const nodeId = remaining.values().next().value as string
      const node = scopedNodes.find(candidate => candidate.id === nodeId)!
      const ownedPaths = normalizeRelativePaths(node.data.ownedPaths)
      const expectedFiles = normalizeRelativePaths(node.data.expectedFiles)
      const existingOwnedPaths = ownedPaths.filter(relPath => pathExists(projectDir, relPath))
      const existingExpectedFiles = expectedFiles.filter(relPath => pathExists(projectDir, relPath))
      const result: PreflightNodeResult = {
        nodeId: node.id,
        label: node.data.label,
        status: 'adopted',
        launchIntent: 'plan_delta',
        reason: 'Dependency relationships are cyclic or unresolved, so this node will default to a review-first delta plan.',
        ownedPaths,
        existingOwnedPaths,
        missingOwnedPaths: ownedPaths.filter(relPath => !pathExists(projectDir, relPath)),
        expectedFiles,
        existingExpectedFiles,
        missingExpectedFiles: expectedFiles.filter(relPath => !pathExists(projectDir, relPath)),
        upstreamChanged: true,
        hasExistingOutput: outputExists(projectDir, node),
      }
      byId.set(node.id, result)
      counts.adopted += 1
      remaining.delete(node.id)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    counts,
    nodes: scopedNodes.map(node => byId.get(node.id)!),
  }
}

function formatPreflightNodeSummary(preflight: PreflightNodeResult) {
  const evidence = [
    preflight.existingOwnedPaths.length ? `owned paths present: ${preflight.existingOwnedPaths.join(', ')}` : '',
    preflight.missingOwnedPaths.length ? `owned paths missing: ${preflight.missingOwnedPaths.join(', ')}` : '',
    preflight.existingExpectedFiles.length ? `expected files present: ${preflight.existingExpectedFiles.join(', ')}` : '',
    preflight.missingExpectedFiles.length ? `expected files missing: ${preflight.missingExpectedFiles.join(', ')}` : '',
  ].filter(Boolean)

  return [
    `Status: ${preflight.status}`,
    `Launch intent: ${preflight.launchIntent}`,
    `Reason: ${preflight.reason}`,
    ...evidence,
  ].join('\n')
}

function buildMermaidDiagram(nodes: GraphNode[], edges: GraphEdge[]): string {
  const nodeLines = nodes.map(node => `  ${node.id}["${node.data.label} [${node.data.tag}]"]`)
  const edgeLines = edges.map(edge => `  ${edge.source} --> ${edge.target}`)
  return ['```mermaid', 'graph TD', ...nodeLines, ...edgeLines, '```'].join('\n')
}

function ensureArchitectWorkspace(projectDir: string) {
  const base = join(projectDir, 'ARCHITECT')
  for (const dir of ['tasks', 'outputs', 'prompts'].map(name => join(base, name))) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function buildResumePrompt(node: GraphNode, completionToken: string): string {
  const statusLog = getOutputFilePathForNode(node)
  const additionalChanges = node.data.additionalChanges?.trim()

  return `Resume your existing session for ${node.data.label}.

First, read ${getTaskFilePathForNode(node)} and align your next actions to the current task file for this launch.
Review your previous work logged in ${statusLog} before making changes.
${additionalChanges ? `\nAdditional requested changes:\n${additionalChanges}\n` : ''}
Preserve working code and apply only the next required delta.

When you have finished ALL work, run this exact shell command as your last action:
\`\`\`
echo ${completionToken}
\`\`\``
}

function buildDirectTaskLaunchPrompt(node: GraphNode, taskMarkdown: string): string {
  const statusLog = getOutputFilePathForNode(node)
  const additionalChanges = node.data.additionalChanges?.trim()

  return `You are resuming work for the ${node.data.label} component.

## Existing Task Markdown
\`\`\`md
${taskMarkdown.trim()}
\`\`\`

${additionalChanges
    ? `## Additional Requested Changes
${additionalChanges}

Apply these changes on top of the existing task markdown above.
`
    : ''}
Execute the task markdown immediately.

Write progress notes and your final summary to ${statusLog}.
Create real code and project files in the project root, not inside ARCHITECT/.

When you have finished ALL work, run this exact shell command as your last action:
\`\`\`
echo ARCHITECT_COMPLETE
\`\`\``
}

function buildPreflightOverview(preflight: GraphPreflightSummary) {
  return preflight.nodes.map(node => [
    `### ${node.label}`,
    formatPreflightNodeSummary(node),
  ].join('\n')).join('\n\n')
}

function buildArchitectPrompt(
  scopedNodes: GraphNode[],
  scopedEdges: GraphEdge[],
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  settings: ProjectSettings,
  launchMetadata: LaunchMetadata,
  preflight: GraphPreflightSummary,
  launchPlans: NodeLaunchPlan[],
  dispatchContext?: DispatchContext,
): string {
  const agentList = launchPlans.map(({ node, preflight: nodePreflight }) => {
    const relationships = getRelationshipLabels(node.id, allNodes, allEdges, launchMetadata.activeNodeIds)
    const runtime = getNodeRuntime(node, settings)
    const model = getNodeModel(node, runtime)

    return [
      `### ${node.data.label} [${node.data.tag}]`,
      `Description: ${node.data.description}`,
      `Runtime: ${getAgentRuntime(runtime).label}`,
      `Model: ${model}`,
      node.data.prompt ? `User goal: ${node.data.prompt}` : '',
      `Workspace status: ${nodePreflight.status}`,
      `Launch intent: ${nodePreflight.launchIntent}`,
      `Reason: ${nodePreflight.reason}`,
      node.data.ownedPaths?.length ? `Owned paths: ${node.data.ownedPaths.join(', ')}` : '',
      node.data.expectedFiles?.length ? `Expected files: ${node.data.expectedFiles.join(', ')}` : '',
      node.data.contracts?.trim() ? `Current contracts: ${node.data.contracts.trim()}` : '',
      relationships.upstreamInScope.length ? `Upstream in this launch: ${relationships.upstreamInScope.join(', ')}` : '',
      relationships.downstreamInScope.length ? `Downstream in this launch: ${relationships.downstreamInScope.join(', ')}` : '',
      relationships.upstreamExternal.length ? `Upstream outside this launch: ${relationships.upstreamExternal.join(', ')}` : '',
      relationships.downstreamExternal.length ? `Downstream outside this launch: ${relationships.downstreamExternal.join(', ')}` : '',
      `Task file: ${getTaskFilePathForNode(node)}`,
      `Status log: ${getOutputFilePathForNode(node)} (progress notes only — actual code goes in the project root)`,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  const flowLines = scopedEdges.length
    ? scopedEdges.map(edge => `  ${scopedNodes.find(node => node.id === edge.source)?.data.label} → ${scopedNodes.find(node => node.id === edge.target)?.data.label}`).join('\n')
    : '  (agents run independently)'

  const scopeSummary = launchMetadata.mode === 'all'
    ? 'This launch includes every node on the current canvas.'
    : `This launch only includes the following nodes: ${launchMetadata.activeNodeLabels.join(', ')}. Do not create or coordinate tasks for any other canvas nodes.`

  const omittedSummary = launchMetadata.omittedConnectedNodeLabels.length > 0
    ? `Connected nodes that are NOT launching right now: ${launchMetadata.omittedConnectedNodeLabels.join(', ')}. Treat them as external context only.`
    : 'No connected out-of-scope nodes were detected for this launch.'

  return `You are the Architect agent coordinating a multi-agent system. The other agents are already running as interactive coding CLI sessions. Each agent is waiting and will automatically read its task file the moment you write it — you do not need to contact them directly.

DO NOT use the Task tool or spawn sub-agents. Coordinate exclusively through the filesystem.

## Launch Scope
${scopeSummary}
${omittedSummary}

## Architecture Diagram
${buildMermaidDiagram(scopedNodes, scopedEdges)}

## Workspace Preflight
${buildPreflightOverview(preflight)}

## Agents
${agentList}

## Data Flow
${flowLines}

## Your job

1. Read ARCHITECT/manifest.json for full details
2. Respect the workspace preflight. Preserve existing code by default.
3. Write a task file for EVERY agent listed above and only for those agents. Write them in dependency order (upstream first).
   Each task file must contain:
   - The exact launch mode for that node: build from scratch or plan delta against existing code
   - Specific files to create or modify, scoped to owned paths whenever possible
   - API contracts, ports, endpoints, schemas
   - What to read from upstream agents' output files
   - Clear acceptance criteria

4. For nodes whose launch intent is plan_delta, instruct them to inspect existing code first, summarize current behavior, and then make only the smallest necessary delta. Do NOT recreate working implementations from scratch.
5. After writing all task files, write your coordination log to ARCHITECT/outputs/Architect.md
6. Monitor ARCHITECT/outputs/ — when agents complete (they write their status log there), coordinate handoffs by updating downstream task files with actual details

IMPORTANT: Agents must create all real project files (source code, configs, etc.) directly in the project root working directory, NOT inside ARCHITECT/. The ARCHITECT/ folder is only for coordination files (manifests, prompts, tasks, status logs).

Start immediately. Write the task files now.${dispatchContext?.isRedispatch
    ? `\n\n## Execution Mode\nREDISPATCH — existing outputs may be present in ARCHITECT/outputs/.\n${dispatchContext.changedNodeLabels.length > 0
        ? `Only the following agents have changed and MUST be re-run: ${dispatchContext.changedNodeLabels.join(', ')}.\nDo NOT re-run unchanged agents unless their upstream inputs changed.`
        : 'No agent configurations changed. Only re-run agents that previously failed or need updating.'}`
    : ''}`
}

function buildNodePrompt(
  node: GraphNode,
  scopedNodes: GraphNode[],
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  launchMetadata: LaunchMetadata,
  preflight: PreflightNodeResult,
): string {
  const statusLog = getOutputFilePathForNode(node)

  const relationships = getRelationshipLabels(node.id, allNodes, allEdges, launchMetadata.activeNodeIds)
  const tools = Object.entries(node.data.tools ?? {}).filter(([, enabled]) => enabled).map(([key]) => key)
  const skills = (node.data.skills ?? [])
    .map(skill => {
      const content = readSkillContent(skill.path)
      return content ? `### ${skill.name}\n${content}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

  const ownedPaths = normalizeRelativePaths(node.data.ownedPaths)
  const expectedFiles = normalizeRelativePaths(node.data.expectedFiles)
  const launchModeInstructions = preflight.launchIntent === 'build'
    ? `This node is missing in the workspace. Treat the task as greenfield work inside the owned paths, but still inspect the repo first so you integrate with existing code around it.`
    : `This node already has implementation in the repo. Inspect owned paths and expected files first, document the current behavior in ${statusLog}, and then make only the smallest concrete delta needed by the task. Do NOT recreate working files from scratch.`

  return `You are the ${node.data.label} agent [${node.data.tag}] — ${node.data.description}.
${node.data.prompt ? `\nUser goal: ${node.data.prompt}\n` : ''}
${launchMetadata.mode === 'all' ? 'This launch includes the full canvas.\n' : `This launch only includes: ${scopedNodes.map(candidate => candidate.data.label).join(', ')}.\n`}
${relationships.upstreamInScope.length ? `Upstream agents in this launch are available in ARCHITECT/outputs/ for their respective node ids.\n` : ''}
${relationships.downstreamInScope.length ? `Downstream agents in this launch depending on you: ${relationships.downstreamInScope.join(', ')}\n` : ''}
${relationships.upstreamExternal.length ? `Upstream agents outside this launch: ${relationships.upstreamExternal.join(', ')}\n` : ''}
${relationships.downstreamExternal.length ? `Downstream agents outside this launch: ${relationships.downstreamExternal.join(', ')}\n` : ''}
${tools.length ? `Enabled tools: ${tools.join(', ')}\n` : ''}
${skills ? `${skills}\n` : ''}
## Workspace State

${formatPreflightNodeSummary(preflight)}
${ownedPaths.length ? `\nOwned paths: ${ownedPaths.join(', ')}` : '\nOwned paths: (not defined yet)'}
${expectedFiles.length ? `\nExpected files: ${expectedFiles.join(', ')}` : '\nExpected files: (none specified)'}
${node.data.contracts?.trim() ? `\nKnown contracts: ${node.data.contracts.trim()}` : ''}
${node.data.reviewHints?.trim() ? `\nReview hints: ${node.data.reviewHints.trim()}` : ''}

## Instructions

Read ${getTaskFilePathForNode(node)} and execute every instruction in it immediately and concretely.
${launchModeInstructions}

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
  scopedNodes: GraphNode[],
  scopedEdges: GraphEdge[],
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  settings: ProjectSettings,
  launchMetadata: LaunchMetadata,
  preflight: GraphPreflightSummary,
  launchPlans: NodeLaunchPlan[],
  dispatchContext?: DispatchContext,
) {
  ensureArchitectWorkspace(projectDir)
  const base = join(projectDir, 'ARCHITECT')

  fs.writeFileSync(join(base, 'manifest.json'), JSON.stringify({
    generated: new Date().toISOString(),
    defaultRuntime: settings.defaultRuntime,
    launchScope: {
      mode: launchMetadata.mode,
      activeAgents: launchMetadata.activeNodeLabels,
      omittedConnectedAgents: launchMetadata.omittedConnectedNodeLabels,
    },
    preflight,
    agents: scopedNodes.map(node => {
      const runtime = getNodeRuntime(node, settings)
      const relationships = getRelationshipLabels(node.id, allNodes, allEdges, launchMetadata.activeNodeIds)
      const nodePreflight = preflight.nodes.find(candidate => candidate.nodeId === node.id)
      return {
        label: node.data.label,
        tag: node.data.tag,
        description: node.data.description,
        runtime,
        runtimeLabel: getAgentRuntime(runtime).label,
        model: getNodeModel(node, runtime),
        userPrompt: node.data.prompt || null,
        ownedPaths: normalizeRelativePaths(node.data.ownedPaths),
        expectedFiles: normalizeRelativePaths(node.data.expectedFiles),
        contracts: node.data.contracts?.trim() || null,
        reviewHints: node.data.reviewHints?.trim() || null,
        preflight: nodePreflight ?? null,
        taskFile: getTaskFilePathForNode(node),
        outputFile: getOutputFilePathForNode(node),
        enabledTools: Object.entries(node.data.tools ?? {}).filter(([, enabled]) => enabled).map(([key]) => key),
        upstream: relationships.upstreamInScope,
        downstream: relationships.downstreamInScope,
        upstreamOutsideLaunch: relationships.upstreamExternal,
        downstreamOutsideLaunch: relationships.downstreamExternal,
      }
    }),
  }, null, 2))

  fs.writeFileSync(join(base, 'preflight.json'), JSON.stringify(preflight, null, 2))
  fs.writeFileSync(join(base, 'diagram.md'), buildMermaidDiagram(scopedNodes, scopedEdges))
  fs.writeFileSync(join(base, 'outputs', 'Architect.md'), [
    `Preflight generated: ${preflight.generatedAt}`,
    `Missing: ${preflight.counts.missing}`,
    `Adopted: ${preflight.counts.adopted}`,
    `Needs delta: ${preflight.counts.needs_delta}`,
    `Blocked by upstream: ${preflight.counts.blocked_by_upstream}`,
    `Unchanged: ${preflight.counts.unchanged}`,
    '',
    ...preflight.nodes.map(node => `## ${node.label}\n${formatPreflightNodeSummary(node)}`),
  ].join('\n'))
  if (launchPlans.length > 0) {
    fs.writeFileSync(join(base, 'prompts', 'architect.md'), buildArchitectPrompt(scopedNodes, scopedEdges, allNodes, allEdges, settings, launchMetadata, preflight, launchPlans, dispatchContext))
  }
  for (const { node, preflight: nodePreflight } of launchPlans) {
    fs.writeFileSync(join(base, 'prompts', `${getNodeFileStem(node)}.md`), buildNodePrompt(node, scopedNodes, allNodes, allEdges, launchMetadata, nodePreflight))
  }
}

export async function runGraph(
  win: BrowserWindow,
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  projectDir: string,
  rawSettings: unknown,
  options?: RunGraphOptions,
): Promise<RunGraphResult> {
  killAll()
  const settings = normalizeProjectSettings(rawSettings)

  const { nodes, edges, metadata } = resolveLaunchScope(allNodes, allEdges, options?.launchScope)
  const preflight = buildPreflightSummary(projectDir, nodes, edges, options?.dispatchContext)
  const actionablePlans = topoSort(
    nodes.filter(node => preflight.nodes.find(candidate => candidate.nodeId === node.id)?.launchIntent !== 'skip'),
    edges.filter(edge =>
      preflight.nodes.find(candidate => candidate.nodeId === edge.source)?.launchIntent !== 'skip'
      && preflight.nodes.find(candidate => candidate.nodeId === edge.target)?.launchIntent !== 'skip'
    )
  ).map(node => ({
    node,
    preflight: preflight.nodes.find(candidate => candidate.nodeId === node.id)!,
  }))

  setupWorkspace(projectDir, nodes, edges, allNodes, allEdges, settings, metadata, preflight, actionablePlans, options?.dispatchContext)

  if (actionablePlans.length === 0) {
    return {
      sessions: [],
      preflight,
    }
  }

  const promptsDir = join(projectDir, 'ARCHITECT', 'prompts')
  const tasksDir = join(projectDir, 'ARCHITECT', 'tasks')

  const allInfo: TerminalInfo[] = [
    { id: 'architect-agent', label: 'Architect', runtime: settings.defaultRuntime },
    ...actionablePlans.map(({ node }) => ({ id: node.id, label: node.data.label, runtime: getNodeRuntime(node, settings) })),
  ]

  const nodeMap = new Map(actionablePlans.map(plan => [getNodeFileStem(plan.node), plan]))
  const triggered = new Set<string>()
  const taskReady = new Set<string>()
  const agentDone = new Set<string>()

  const upstreamMap = new Map<string, string[]>()
  const downstreamMap = new Map<string, string[]>()
  for (const { node } of actionablePlans) {
    const safe = getNodeFileStem(node)
    upstreamMap.set(safe, edges
      .filter(edge => edge.target === node.id && nodeMap.has(getNodeFileStem(edge.source)))
      .map(edge => nodes.find(candidate => candidate.id === edge.source))
      .filter(Boolean)
      .map(candidate => getNodeFileStem(candidate!)))
    downstreamMap.set(safe, edges
      .filter(edge => edge.source === node.id && nodeMap.has(getNodeFileStem(edge.target)))
      .map(edge => nodes.find(candidate => candidate.id === edge.target))
      .filter(Boolean)
      .map(candidate => getNodeFileStem(candidate!)))
  }

  function trySpawnNode(safe: string) {
    if (triggered.has(safe) || !taskReady.has(safe)) return
    if ((upstreamMap.get(safe) ?? []).some(upstream => !agentDone.has(upstream))) return

    triggered.add(safe)
    const plan = nodeMap.get(safe)!
    const { node, preflight: nodePreflight } = plan
    const env: Record<string, string> = {}
    for (const { key, value } of node.data.envVars ?? []) {
      if (key) env[key] = value
    }

    const runtime = getNodeRuntime(node, settings)
    const model = getNodeModel(node, runtime)
    const prompt = fs.readFileSync(join(promptsDir, `${safe}.md`), 'utf-8')
    const savedSessionId = runtime === 'claude' && nodePreflight.launchIntent === 'plan_delta'
      ? (node.data.claudeSessionId?.trim() || null)
      : null

    if (savedSessionId) {
      const completionToken = `ARCHITECT_COMPLETE_${randomUUID().slice(0, 8)}`
      spawnAgentSession({
        win,
        id: node.id,
        label: node.data.label,
        runtime,
        env,
        cwd: projectDir,
        initialPrompt: buildResumePrompt(node, completionToken),
        model,
        projectDir,
        nodeId: node.id,
        resumeSessionId: savedSessionId,
        completionToken,
      })
    } else {
      spawnAgentSession({
        win,
        id: node.id,
        label: node.data.label,
        runtime,
        env,
        cwd: projectDir,
        initialPrompt: prompt,
        model,
        projectDir,
        nodeId: node.id,
      })
    }

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

  return {
    sessions: allInfo,
    preflight,
  }
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
