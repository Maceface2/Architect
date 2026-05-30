import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Activity, FileStack, FolderOpen, Loader2, Save, SquareTerminal } from 'lucide-react'
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  ConnectionMode,
  MiniMap,
  type Connection,
  type XYPosition,
} from '@xyflow/react'

import LoginScreen from './components/auth/LoginScreen'
import UserMenu from './components/auth/UserMenu'
import TopNav from './components/layout/TopNav'
import AssistantPanel, { type AssistantOrientation } from './components/layout/AssistantPanel'
import type { AssistantRelaunchOpts } from './components/layout/AssistantLaunchModal'
import FilesPanel from './components/layout/FilesPanel'
import TerminalPanel from './components/layout/TerminalPanel'
import PopoutTerminalApp from './components/layout/PopoutTerminalApp'
import TerminalPagePopoutApp from './components/layout/TerminalPagePopoutApp'
import ResizablePanel from './components/layout/ResizablePanel'
import { DocPaneProvider, type DocPaneTarget } from './context/DocPaneContext'
import SettingsPanel from './components/settings/SettingsPanel'
import CliqueLogo from './components/branding/CliqueLogo'
import type { TerminalLayout } from './components/layout/terminalLayoutTypes'
import { emptyLayout } from './components/layout/terminalLayoutOps'
import { nodeTypes } from './components/nodes/nodeTypes'
import { edgeTypes } from './components/edges/edgeTypes'
import CompactCanvasPalette, {
  type CanvasPaletteTool,
  type ComponentCreateConfig,
  type EdgeCreateConfig,
  type ZoneCreateConfig,
} from './components/palette/CompactCanvasPalette'
import type {
  AssistantMode,
  CanvasEdge,
  CanvasNode,
  ComponentEdgeData,
  ComponentEdgeDirection,
  ComponentNodeData,
  ComponentNodeType,
  ProjectSettings,
  ZoneNodeData,
  ZoneNodeType,
} from './types'
import {
  createDefaultZoneAgentConfig,
  createDefaultProjectSettings,
  applyDetectionToProjectSettings,
  migrateCanvasData,
  getEffectiveModel,
  getEffectiveRuntime,
  mintParticipantId,
  normalizeEdgeData,
  loadMergedCanvas,
  splitMergedForSave,
  type FolderCanvasInput,
  type FolderIdAlias,
  type FolderOffset,
} from './lib/canvas'
import { buildCanvasProjection } from '../../shared/canvas/projection'
import { renderProjectionMarkdown } from '../../shared/canvas/render'
import { ProjectSettingsProvider } from './context/ProjectSettingsContext'
import { InterfaceSettingsProvider } from './context/InterfaceSettingsContext'
import { ProjectDirProvider } from './context/ProjectDirContext'
import { WorkspaceProvider, useWorkspace } from './context/WorkspaceContext'
import PagesPanel from './components/canvas/PagesPanel'
import FolderRegions, { computeFolderRegions, nearestFolderForPoint, applyEmptyAdjustments, type EmptyOffset, type EmptyBase } from './components/canvas/FolderRegions'
import { RuntimeDetectionProvider, useRuntimeDetection } from './context/RuntimeDetectionContext'
import DispatchModal from './components/dispatch/DispatchModal'
import DispatchView from './components/dispatch/DispatchView'
import BugReportModal from './components/layout/BugReportModal'
import AgentConfigModal from './components/nodes/AgentConfigModal'
import ComponentConfigModal from './components/nodes/ComponentConfigModal'
import { ErrorBoundary } from './components/ErrorBoundary'
import { getActivityStoreSnapshot, seedDispatch, seedDispatchCombined, subscribeActivityStore } from './lib/activityStore'
import type { DispatchRequest } from './types'
import { DEFAULT_AGENT_RUNTIME, DEFAULT_MODEL_BY_RUNTIME, isAgentRuntime, type AgentRuntime } from '../../shared/agentRuntimes'
import type { SessionInfo, TerminalInfo } from '../../shared/electronTypes'

/** Custom rail icon for the Canvas tab: a 3-node graph — one node fanning
    out to two others (no edge between the pair), nodes drawn hollow. Sized +
    colored like the sibling lucide tab icons so active/inactive coloring
    (currentColor) carries through unchanged. */
function CanvasGraphIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* rotated 90° counter-clockwise so the hub node points left */}
      <g transform="rotate(-90 12 12)">
        <line x1="12" y1="4" x2="5" y2="18" />
        <line x1="12" y1="4" x2="19" y2="18" />
        <circle cx="12" cy="4" r="2.4" fill="none" />
        <circle cx="5" cy="18" r="2.4" fill="none" />
        <circle cx="19" cy="18" r="2.4" fill="none" />
      </g>
    </svg>
  )
}

interface CanvasUpdate {
  zones?: unknown[]
  components?: unknown[]
  nodes?: unknown[]
  edges: unknown[]
}

type RawCanvasEdge = {
  id?: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  label?: string
  direction?: ComponentEdgeDirection
  data?: unknown
}

type PendingCreate =
  | { kind: 'component'; config: ComponentCreateConfig }
  | { kind: 'zone'; config: ZoneCreateConfig }

// Must match the main-process ASSISTANT_ZONES keys (terminals.ts) — those
// are sanitize('Architecture Assistant Design'|'General') with non-alnum
// chars replaced by '-'. Used here to route zone:session-captured events
// for the two assistant modes back into the per-mode last-session store.
const ASSISTANT_ZONE_KEYS: Record<AssistantMode, string> = {
  architecture: 'Architecture-Assistant-Design',
  general:      'Architecture-Assistant-General',
}

const ZONE_DEFAULT_WIDTH = 420
const ZONE_DEFAULT_HEIGHT = 280
const COMPONENT_APPROX_W = 180
const COMPONENT_APPROX_H = 78
const FIT_VIEW_OPTIONS = { padding: 0.18, duration: 280 }
const AUTO_CANVAS_DISMISS_PREFIX = 'architect:auto-canvas-dismissed:'
const AUTO_CANVAS_INITIAL_PROMPT = `# Task

Do a deep architecture discovery pass over this existing codebase and generate an Architect canvas.

# Workflow

1. Explore before writing:
   - Inspect the repository structure.
   - Identify package/build files, app entry points, backend services, frontend apps, data/storage layers, integrations, config, tests, and deployment files.
   - Prefer fast targeted commands such as \`rg --files\`, \`find\`, and reading manifests before opening large files.
   - Manage context carefully: summarize discoveries as you go instead of dumping large files.

2. Build an architecture model:
   - Identify 5-12 meaningful components. A component should be a real subsystem, package, service, module, UI surface, data store, external integration, or workflow boundary.
   - Identify 2-5 zones representing useful future agent ownership areas, not just folders.
   - Add component edges for important dependencies, calls, data flow, auth flow, event flow, or build/deploy relationships.
   - Use uncertainty honestly. If a relationship is inferred from filenames or config rather than confirmed code, say that in the component specs.

3. Write the canvas:
   - Create or replace \`architect-canvas.json\` at the project root.
   - Use the modern Architect JSON format from your context file.
   - Pretty-print with 2-space indentation.
   - Preserve any existing \`settings\` if present.
   - Give zones durable role-style \`systemPrompt\` values. Do not turn zone prompts into build checklists.
   - Place components inside their owning zone by geometry.
   - Keep labels concise and specs specific.

4. Verify:
   - Re-read \`architect-canvas.json\`.
   - Confirm it is valid JSON with top-level \`nodes\`, \`edges\`, and \`settings\`.
   - Confirm every edge references existing component ids.
   - Give a brief final summary of the discovered architecture and any uncertain areas.

# Scope

Do not modify source code. Only write \`architect-canvas.json\`.`
function createEdgeId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `edge-${uuid}` : `edge-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createNodeId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// Re-mint colliding ids on an assistant-supplied patch so it can't clobber
// nodes that live in other (currently-loaded) workspace folders. Returns a
// rename map (oldId -> newId) the caller applies to incoming edge endpoints.
function dedupeAgainstReserved(
  nodes: Array<{ id: string }>,
  reservedIds: Set<string>,
): Map<string, string> {
  const rename = new Map<string, string>()
  const seen = new Set<string>(reservedIds)
  for (const n of nodes) {
    if (!seen.has(n.id)) {
      seen.add(n.id)
      continue
    }
    let suffix = 2
    let candidate = `${n.id}#${suffix}`
    while (seen.has(candidate)) {
      suffix += 1
      candidate = `${n.id}#${suffix}`
    }
    seen.add(candidate)
    rename.set(n.id, candidate)
    n.id = candidate
  }
  return rename
}

// Strip in-memory workspace tags from each node's data before serializing.
// `folderPath` is added by loadMergedCanvas at load time; it must not bleed
// into the on-disk canvas file or single-folder round-trip drifts.
function stripWorkspaceTags(node: CanvasNode): CanvasNode {
  const data = node.data as Record<string, unknown>
  if (!('folderPath' in data)) return node
  const next: Record<string, unknown> = {}
  for (const k of Object.keys(data)) {
    if (k === 'folderPath') continue
    next[k] = data[k]
  }
  return { ...node, data: next } as CanvasNode
}

function serializeCanvasData(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  settings: ProjectSettings,
): string {
  return JSON.stringify({
    nodes: nodes.map(stripWorkspaceTags),
    edges,
    settings,
    savedAt: new Date().toISOString(),
  })
}

interface RecentProject {
  path: string
  openedAt: string
}

const RECENT_PROJECTS_KEY = 'architect:recent-projects'
const RECENT_PROJECT_LIMIT = 6

function projectNameFromPath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || projectPath
}

function loadRecentProjects(): RecentProject[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is RecentProject =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.path === 'string' &&
        typeof entry.openedAt === 'string',
      )
      .slice(0, RECENT_PROJECT_LIMIT)
  } catch {
    return []
  }
}

function saveRecentProjects(projects: RecentProject[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects.slice(0, RECENT_PROJECT_LIMIT)))
  } catch {}
}

function DirectoryGate({ onOpen }: { onOpen: (dir: string) => void }) {
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() => loadRecentProjects())

  const openProject = useCallback((dir: string) => {
    const next = [
      { path: dir, openedAt: new Date().toISOString() },
      ...recentProjects.filter(project => project.path !== dir),
    ].slice(0, RECENT_PROJECT_LIMIT)
    setRecentProjects(next)
    saveRecentProjects(next)
    onOpen(dir)
  }, [onOpen, recentProjects])

  const pick = async () => {
    setOpeningPath('__picker__')
    try {
      const dir = await window.electron.openDirectory()
      if (dir) openProject(dir)
    } finally {
      setOpeningPath(null)
    }
  }

  return (
    <div
      className="grid h-screen w-screen select-none grid-cols-[218px_minmax(0,1fr)] overflow-hidden text-fg"
      style={{ WebkitAppRegion: 'drag', backgroundColor: 'rgb(30, 30, 30)' } as CSSProperties}
    >
      <aside
        className="flex min-h-0 flex-col border-r border-node-border px-3 pb-4 pt-[58px]"
        style={{ backgroundColor: 'rgb(38, 38, 38)' }}
      >
        <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          Recent
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {recentProjects.length === 0 ? (
            <div className="rounded-md border border-node-border px-3 py-2 text-[11px] leading-4 text-fg-subtle">
              No recent projects.
            </div>
          ) : (
            recentProjects.map(project => {
              const isOpening = openingPath === project.path
              return (
                <button
                  key={project.path}
                  onClick={() => {
                    setOpeningPath(project.path)
                    openProject(project.path)
                  }}
                  disabled={openingPath !== null}
                  title={project.path}
                  className="group w-full rounded-[3px] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-60"
                  style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                >
                  <div className="truncate text-[12px] font-medium text-fg">
                    {isOpening ? 'Opening...' : projectNameFromPath(project.path)}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-fg-subtle group-hover:text-fg-muted">
                    {project.path}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-col px-7 pb-7 pt-[58px]">
        <div className="flex flex-1 flex-col justify-between">
          <div>
            <CliqueLogo size={42} className="text-fg" />
            <h1 className="mt-4 text-[22px] font-semibold leading-none text-fg">
              Clique
            </h1>
            <p className="mt-2 max-w-[23ch] text-[12px] leading-5 text-fg-muted">
              Open a repository to compose and dispatch agent zones.
            </p>
          </div>

          <button
            onClick={pick}
            disabled={openingPath !== null}
            className="inline-flex w-full items-center justify-center gap-2 rounded-[3px] border border-node-border bg-node px-3.5 py-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-white/[0.08] disabled:pointer-events-none disabled:opacity-50"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          >
            <FolderOpen size={14} strokeWidth={1.8} />
            {openingPath === '__picker__' ? 'Opening...' : 'Open project'}
          </button>
        </div>
      </main>
    </div>
  )
}

// Renders inside the docked Terminal tab while the terminal page is open
// in a detached BrowserWindow. The terminals themselves keep running in
// main; this placeholder just gives the user a way to bring the panel back.
function PoppedOutPlaceholder({ onDock }: { onDock: () => void }) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-terminal text-fg-muted">
      <button
        onClick={onDock}
        className="px-3 py-1.5 text-xs font-medium text-fg bg-accent rounded hover:bg-accent/90 transition-colors"
      >
        Dock back here
      </button>
    </div>
  )
}

function CanvasConflictModal({
  changedFolders,
  onLoadIncoming,
  onKeepLocal,
}: {
  // Non-primary folder paths whose on-disk canvas changed while we're dirty.
  // Empty when only the primary folder's canvas changed.
  changedFolders: string[]
  onLoadIncoming: () => void
  onKeepLocal: () => void
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-md border border-node-border bg-panel shadow-2xl">
        <div className="border-b border-node-border px-5 py-4">
          <h2 className="text-sm font-semibold text-fg">External canvas changes detected</h2>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            {changedFolders.length === 0
              ? 'The assistant updated `architect-canvas.json`, but you still have unsaved canvas edits in memory.'
              : 'Linked folders’ canvases changed on disk, but you still have unsaved canvas edits in memory.'}
          </p>
        </div>
        {changedFolders.length > 0 && (
          <div className="px-5 py-3 space-y-1">
            {changedFolders.map(p => (
              <div key={p} className="text-[11px] font-mono text-fg-muted truncate" title={p}>
                {p}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-node-border px-5 py-4">
          <button
            onClick={onKeepLocal}
            className="px-3 py-1.5 text-xs text-fg-muted border border-node-border rounded hover:bg-node transition-colors"
          >
            Keep local edits
          </button>
          <button
            onClick={onLoadIncoming}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-accent/90"
          >
            Load incoming changes
          </button>
        </div>
      </div>
    </div>
  )
}

function MissingFoldersPrompt({
  missing,
  onContinue,
  onCancel,
}: {
  missing: string[]
  onContinue: () => void
  onCancel: () => void
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-md border border-node-border bg-panel shadow-2xl">
        <div className="border-b border-node-border px-5 py-4">
          <h2 className="text-sm font-semibold text-fg">Some folders aren&apos;t loaded</h2>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            This dispatch ran across folders that aren&apos;t currently in the workspace. Resume will skip those zones unless you add the folders first.
          </p>
        </div>
        <div className="px-5 py-3 space-y-1">
          {missing.map(p => (
            <div key={p} className="text-[11px] font-mono text-fg-muted truncate" title={p}>
              {p}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-node-border px-5 py-4">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-fg-muted border border-node-border rounded hover:bg-node transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onContinue}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-accent/90"
          >
            Resume anyway
          </button>
        </div>
      </div>
    </div>
  )
}

function DispatchErrorModal({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-md border border-node-border bg-panel shadow-2xl">
        <div className="border-b border-node-border px-5 py-4">
          <h2 className="text-sm font-semibold text-fg">Dispatch error</h2>
          <p className="mt-1 text-xs leading-5 text-fg-muted">{message}</p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-node-border px-5 py-4">
          <button
            onClick={onClose}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-accent/90"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}

function AutoCanvasOnboardingModal({
  starting,
  onGenerate,
  onDismiss,
}: {
  starting: boolean
  onGenerate: () => void
  onDismiss: () => void
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-md border border-node-border bg-panel shadow-2xl">
        <div className="border-b border-node-border px-5 py-4">
          <h2 className="text-sm font-semibold text-fg">Generate an architecture canvas?</h2>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            This looks like an existing codebase without a Clique canvas. Clique can open the Architecture Assistant and ask it to map the project into zones, components, and dependencies.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-node-border px-5 py-4">
          <button
            onClick={onDismiss}
            disabled={starting}
            className="px-3 py-1.5 text-xs text-fg-muted border border-node-border rounded hover:bg-node disabled:opacity-50 disabled:pointer-events-none transition-colors"
          >
            Not now
          </button>
          <button
            onClick={onGenerate}
            disabled={starting}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {starting ? 'Opening assistant...' : 'Generate Canvas'}
          </button>
        </div>
      </div>
    </div>
  )
}

function zoneHash(n: ZoneNodeType): string {
  // Strip volatile fields so the hash only reflects user-visible config.
  // `status` flips during a dispatch run; `folderPath` is a workspace tag
  // added by loadMergedCanvas — neither is a "user changed this" signal.
  const { data: { status: _s, folderPath: _fp, ...data } } = n as ZoneNodeType & {
    data: { folderPath?: string }
  }
  return JSON.stringify(data)
}

function zonesContainingPoint(zones: ZoneNodeType[], point: XYPosition): ZoneNodeType[] {
  return zones.filter(zone => {
    const w = zone.width ?? ZONE_DEFAULT_WIDTH
    const h = zone.height ?? ZONE_DEFAULT_HEIGHT
    return (
      point.x >= zone.position.x &&
      point.x <= zone.position.x + w &&
      point.y >= zone.position.y &&
      point.y <= zone.position.y + h
    )
  })
}

function ArchitectFlow({ projectDir, onChangeDir }: { projectDir: string; onChangeDir: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>([])
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>(createDefaultProjectSettings())
  const runtimeDetection = useRuntimeDetection()

  // Once the renderer has the real detection snapshot (scannedAt > 0), if
  // the canvas's saved/default dispatchRuntime isn't installed, promote the
  // first installed runtime. Only runs when the runtime would actually
  // change, so it doesn't fight user edits.
  useEffect(() => {
    if (runtimeDetection.result.scannedAt === 0) return
    setProjectSettings(prev => {
      const next = applyDetectionToProjectSettings(
        prev,
        runtimeDetection.installed.map(r => r.id),
      )
      return next === prev ? prev : next
    })
  }, [runtimeDetection.result.scannedAt, runtimeDetection.installed])
  const [activeTab, setActiveTab] = useState('Canvas')
  const [terminalSessions, setTerminalSessions] = useState<TerminalInfo[]>([])
  const [dispatching, setDispatching] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [dispatchedGraph, setDispatchedGraph] = useState<Record<string, string> | null>(null)
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false)
  const [dispatchPrefill, setDispatchPrefill] = useState<string>('')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [filesPanelOpen, setFilesPanelOpen] = useState(false)
  const [assistantRuntime, setAssistantRuntime] = useState<AgentRuntime | null>(null)
  const [autoCanvasOfferOpen, setAutoCanvasOfferOpen] = useState(false)
  const [autoCanvasStarting, setAutoCanvasStarting] = useState(false)
  const [assistantOrientation, setAssistantOrientation] = useState<AssistantOrientation>(() => {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('architect:assistant-orientation') : null
    return raw === 'bottom' ? 'bottom' : 'right'
  })
  const [docPaneTarget, setDocPaneTarget] = useState<DocPaneTarget>(null)
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null)
  const [pendingEdgeDefaults, setPendingEdgeDefaults] = useState<EdgeCreateConfig | null>(null)
  const [pendingExternalCanvasRaw, setPendingExternalCanvasRaw] = useState<string | null>(null)
  // Non-primary folders whose canvas changed externally while the user has
  // unsaved edits. Coexists with `pendingExternalCanvasRaw` (primary's pending
  // raw); together they drive the conflict modal so cross-folder drifts can't
  // be clobbered by the next save.
  const [externalChangedFolders, setExternalChangedFolders] = useState<Set<string>>(
    () => new Set(),
  )
  // Latest pending raw per non-primary folder while we're dirty. Mirrors
  // pendingExternalCanvasRaw (primary's pending raw) but keyed by folder so
  // a multi-folder workspace can hold one pending drift per folder.
  const externalPendingByFolderRef = useRef<Map<string, string>>(new Map())
  // Dismissal cache, mirrors dismissedExternalCanvasRef but keyed by folder
  // path. Lets "Keep local edits" silence a specific raw per folder so the
  // same drift won't re-prompt on every save until the user genuinely picks
  // it up.
  const dismissedExternalByFolderRef = useRef<Map<string, string>>(new Map())
  const [terminalLayout, setTerminalLayout] = useState<TerminalLayout | null>(null)
  const [activeDispatchId, setActiveDispatchId] = useState<string | null>(null)
  const [bugReportOpen, setBugReportOpen] = useState(false)
  // Resume gating: surfaced when a dispatch's involvedFolders aren't all
  // currently loaded. Promise-based so the resume flow can await the user's
  // continue/cancel decision the same way `window.alert` blocked before.
  const [missingFoldersPrompt, setMissingFoldersPrompt] = useState<
    { missing: string[]; resolve: (cont: boolean) => void } | null
  >(null)
  // Fatal-error surface for the dispatch flow (legacy protocol, missing
  // record, etc.). Replaces the second window.alert in handleDispatchSubmit.
  const [dispatchErrorMessage, setDispatchErrorMessage] = useState<string | null>(null)
  // True while the terminal page is rendering in a detached BrowserWindow.
  // The docked panel hides itself and shows a "popped out" placeholder; all
  // session/layout/theme updates flow over the terminalPage IPC bus until
  // the popout window is closed.
  const [terminalPagePoppedOut, setTerminalPagePoppedOut] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)

  const { loadedFolders, primaryFolder, activeFolder, activePageId, activePage, deletePage, ready: workspaceReady } = useWorkspace()

  // Empty-region placement offsets — lifted out of FolderRegions so the
  // pane-click drop targeting and the visual rendering stay aligned after a
  // user drags an empty placeholder. Bases are seeded the first time a
  // folder appears empty and forgotten when it fills.
  const [emptyFolderOffsets, setEmptyFolderOffsets] = useState<Record<string, EmptyOffset>>({})
  const emptyFolderBasesRef = useRef<Record<string, EmptyBase>>({})

  // Resolve which pageId belongs to each loaded folder: the host folder uses
  // the workspace's activePageId; every linked folder uses the pageId stored
  // on the active page's outgoing link to that folder.
  const pageIdForFolder = useCallback(
    (folderPath: string): string => {
      if (folderPath === primaryFolder.path) return activePageId
      const link = activePage.links.find(l => l.folderPath === folderPath)
      return link?.pageId ?? activePageId
    },
    [activePage.links, activePageId, primaryFolder.path],
  )

  useEffect(() => {
    const off = window.electron.update.onDownloaded(() => setUpdateReady(true))
    return () => { off() }
  }, [])

  const onUpdateInstall = useCallback(() => {
    void window.electron.update.install()
  }, [])

  const terminalLayoutSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nodesRef = useRef<CanvasNode[]>([])
  const edgesRef = useRef<CanvasEdge[]>([])
  const settingsRef = useRef<ProjectSettings>(projectSettings)
  const isDirtyRef = useRef(false)
  const lastAppliedCanvasRef = useRef('')
  const dismissedExternalCanvasRef = useRef<string | null>(null)
  // Multi-folder workspace bookkeeping. Steps 3/5 establish them — Step 6
  // adds cross-folder edge ownership tracking on top.
  const perFolderSettingsRef = useRef<Map<string, ProjectSettings>>(new Map())
  const idAliasesRef = useRef<Map<string, FolderIdAlias>>(new Map())
  const edgeAliasesRef = useRef<Map<string, FolderIdAlias>>(new Map())
  // Load-time offset applied per folder so non-primary folders' raw
  // positions don't visually overlap the primary's region. Splitting on
  // save subtracts the same offset, so disk positions stay folder-relative.
  const folderOffsetsRef = useRef<Map<string, FolderOffset>>(new Map())
  // Per-folder echo-suppression. Last-applied raw written/observed for each
  // folder; canvas:changed events whose raw matches are skipped (our own
  // write loop just fired the watcher). Mirrors lastAppliedCanvasRef but
  // keyed by folder so multi-folder writes don't trip each other.
  const lastRawByFolderRef = useRef<Map<string, string>>(new Map())
  const { screenToFlowPosition, fitView } = useReactFlow()

  // Canvas undo/redo: snapshot {nodes, edges} on structural changes (add,
  // remove, connect) and at the start of a drag/resize. Data-only edits from
  // node config modals go through setNodes directly and aren't captured — only
  // graph-shape changes are undoable.
  type CanvasSnapshot = { nodes: CanvasNode[]; edges: CanvasEdge[] }
  const historyPastRef = useRef<CanvasSnapshot[]>([])
  const historyFutureRef = useRef<CanvasSnapshot[]>([])
  const dragOrResizeInFlightRef = useRef(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const MAX_HISTORY = 50

  const snapshotHistory = useCallback(() => {
    historyPastRef.current = [
      ...historyPastRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
    ].slice(-MAX_HISTORY)
    historyFutureRef.current = []
    setHistoryVersion(v => v + 1)
  }, [])

  const resetHistory = useCallback(() => {
    historyPastRef.current = []
    historyFutureRef.current = []
    dragOrResizeInFlightRef.current = false
    setHistoryVersion(v => v + 1)
  }, [])

  const undoCanvas = useCallback(() => {
    const prev = historyPastRef.current[historyPastRef.current.length - 1]
    if (!prev) return
    historyPastRef.current = historyPastRef.current.slice(0, -1)
    historyFutureRef.current = [
      ...historyFutureRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
    ]
    setNodes(prev.nodes)
    setEdges(prev.edges)
    setIsDirty(true)
    setHistoryVersion(v => v + 1)
  }, [setNodes, setEdges])

  const redoCanvas = useCallback(() => {
    const next = historyFutureRef.current[historyFutureRef.current.length - 1]
    if (!next) return
    historyFutureRef.current = historyFutureRef.current.slice(0, -1)
    historyPastRef.current = [
      ...historyPastRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
    ]
    setNodes(next.nodes)
    setEdges(next.edges)
    setIsDirty(true)
    setHistoryVersion(v => v + 1)
  }, [setNodes, setEdges])

  const canUndo = historyPastRef.current.length > 0
  const canRedo = historyFutureRef.current.length > 0
  void historyVersion // re-renders flip canUndo/canRedo via ref reads

  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])
  useEffect(() => { settingsRef.current = projectSettings }, [projectSettings])
  useEffect(() => { isDirtyRef.current = isDirty }, [isDirty])

  useEffect(() => () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    if (terminalLayoutSaveTimer.current) clearTimeout(terminalLayoutSaveTimer.current)
  }, [])

  // Pick up ad-hoc PTY spawns (e.g. canvas Play button) so they get a terminal tab.
  useEffect(() => {
    const unsub = window.electron.terminal.onSpawned(info => {
      setTerminalSessions(prev => {
        const existing = prev.findIndex(s => s.id === info.id)
        if (existing === -1) return [...prev, info]
        const next = prev.slice()
        next[existing] = info
        return next
      })
      setActiveTab('Terminal')
    })
    return unsub
  }, [])

  // Load persisted terminal layout when project changes; reset on dir switch.
  useEffect(() => {
    let cancelled = false
    setTerminalLayout(null)
    window.electron.loadTerminalLayout(projectDir).then(raw => {
      if (cancelled) return
      const parsed = raw && typeof raw === 'object' && 'root' in (raw as object)
        ? (raw as TerminalLayout)
        : emptyLayout()
      // Popout windows aren't reopened automatically on project load — drop the list
      // so those terminals show up in panes again instead of staying invisible.
      parsed.poppedOut = []
      setTerminalLayout(parsed)
    })
    return () => { cancelled = true }
  }, [projectDir])

  const handleTerminalLayoutChange = useCallback((next: TerminalLayout) => {
    setTerminalLayout(next)
    // Publish to the detached terminal page (no-op if no popout is open —
    // the IPC handler short-circuits when there's no peer). Doing this at
    // the call site (rather than via a setTerminalLayout-watching effect)
    // avoids the inbound→setState→re-publish loop that would otherwise
    // bounce layout edits back to the originating window.
    if (terminalPagePoppedOut) {
      window.electron.terminalPage.publishLayout(next)
    }
    if (terminalLayoutSaveTimer.current) clearTimeout(terminalLayoutSaveTimer.current)
    terminalLayoutSaveTimer.current = setTimeout(() => {
      terminalLayoutSaveTimer.current = null
      void window.electron.saveTerminalLayout(projectDir, next)
    }, 400)
  }, [projectDir, terminalPagePoppedOut])

  // Open the terminal page in a detached window. Sends the current
  // sessions + layout + theme + projectDir as the initial snapshot so the
  // popout can render immediately without round-tripping for state.
  const handlePopoutTerminalPage = useCallback(() => {
    void window.electron.terminalPage.popout({
      sessions: terminalSessions,
      layout: terminalLayout,
      projectDir,
      theme: projectSettings.interface.theme,
    })
    setTerminalPagePoppedOut(true)
  }, [terminalSessions, terminalLayout, projectDir, projectSettings.interface.theme])

  // Subscribe to inbound updates from the popout window. Layout edits in
  // the popout flow back here so the docked panel state stays in sync (and
  // so the layout persists correctly when the popout closes). Sessions
  // are pushed back when the popout removes a terminal.
  useEffect(() => {
    if (!terminalPagePoppedOut) return
    const offLayout = window.electron.terminalPage.onLayout(next => {
      const incoming = next as TerminalLayout | null
      if (!incoming) return
      setTerminalLayout(incoming)
      // Persist popout-originated layout edits to disk too. Goes through
      // the same debounced save path as in-window edits (via the timer
      // ref), but skips re-publishing — the popout already has this.
      if (terminalLayoutSaveTimer.current) clearTimeout(terminalLayoutSaveTimer.current)
      terminalLayoutSaveTimer.current = setTimeout(() => {
        terminalLayoutSaveTimer.current = null
        void window.electron.saveTerminalLayout(projectDir, incoming)
      }, 400)
    })
    const offSessions = window.electron.terminalPage.onSessions(next => {
      setTerminalSessions(next)
    })
    return () => {
      offLayout()
      offSessions()
    }
  }, [terminalPagePoppedOut, projectDir])

  // Popout window closed → resume rendering the docked panel. The closed
  // event carries the popout's last-known layout in case the IPC bus
  // dropped any updates between its final edit and the window-closed event.
  useEffect(() => {
    const off = window.electron.terminalPage.onClosed(({ layout }) => {
      setTerminalPagePoppedOut(false)
      const incoming = layout as TerminalLayout | null
      if (incoming) setTerminalLayout(incoming)
    })
    return off
  }, [])

  // Push sessions to the popout whenever they change while it's open.
  // Cheap — the IPC handler is a no-op when no popout window exists.
  useEffect(() => {
    if (!terminalPagePoppedOut) return
    window.electron.terminalPage.publishSessions(terminalSessions)
  }, [terminalPagePoppedOut, terminalSessions])

  // Mirror theme into the popout so a flip on the parent updates the
  // detached terminal page in lockstep.
  useEffect(() => {
    if (!terminalPagePoppedOut) return
    window.electron.terminalPage.publishTheme(projectSettings.interface.theme)
  }, [terminalPagePoppedOut, projectSettings.interface.theme])

  const queueFitView = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void fitView(FIT_VIEW_OPTIONS)
      })
    })
  }, [fitView])

  const persistCanvasRaw = useCallback(async (raw: string, clearDirty: boolean) => {
    // `raw` is the caller's serialization of the in-memory state (primary's
    // slice). Use splitMergedForSave to also write any non-primary folders'
    // canvases. With only the primary folder loaded this writes one file
    // and the output is byte-identical to `raw` (modulo savedAt timestamp
    // — both call new Date()).
    const split = splitMergedForSave({
      nodes: nodesRef.current,
      edges: edgesRef.current,
      primarySettings: settingsRef.current,
      primaryFolderPath: primaryFolder.path,
      folderPaths: loadedFolders.map(f => f.path),
      perFolderSettings: perFolderSettingsRef.current,
      idAliases: idAliasesRef.current,
      edgeAliases: edgeAliasesRef.current,
      folderOffsets: folderOffsetsRef.current,
    })
    const primaryEntry = split.find(s => s.folderPath === primaryFolder.path)
    const primaryRaw = primaryEntry?.raw ?? raw
    lastAppliedCanvasRef.current = primaryRaw
    dismissedExternalCanvasRef.current = null
    setPendingExternalCanvasRaw(null)
    // Cache the raw BEFORE awaiting the write so the canvas:changed event
    // fired by our own save lands on a hot cache hit and short-circuits the
    // watcher's drift-detection path — no need for the post-write split
    // recomputation in the common case.
    for (const file of split) {
      lastRawByFolderRef.current.set(file.folderPath, file.raw)
    }
    for (const file of split) {
      await window.electron.saveCanvas(file.folderPath, pageIdForFolder(file.folderPath), file.raw)
    }
    if (clearDirty) setIsDirty(false)
  }, [primaryFolder.path, loadedFolders, pageIdForFolder])

  // Track the last (runtime, sessionId) actually used per assistant mode so
  // the next app start auto-resumes it. Fresh-spawn captures fire this event;
  // explicit resumes don't capture and are persisted in handleAssistantRelaunch.
  useEffect(() => {
    const unsub = window.electron.zone.onSessionCaptured(event => {
      const mode: AssistantMode | null =
        event.zoneKey === ASSISTANT_ZONE_KEYS.architecture ? 'architecture'
        : event.zoneKey === ASSISTANT_ZONE_KEYS.general ? 'general'
        : null
      if (!mode) return
      const runtime = event.runtime
      if (!isAgentRuntime(runtime)) return
      // Persist immediately. A setIsDirty-only path loses this pointer if the
      // app closes before the next save, and the next startup would fall
      // through to DEFAULT_AGENT_RUNTIME — exactly the bug this field exists to fix.
      //
      // Captured `model` travels alongside so a later resume can replay the
      // exact config the user was running under (user-picked models can drift
      // in the launcher between spawns).
      const nextSettings: ProjectSettings = {
        ...settingsRef.current,
        assistantLastSessionByMode: {
          ...(settingsRef.current.assistantLastSessionByMode ?? {}),
          [mode]: {
            runtime,
            sessionId: event.sessionId,
            ...(event.model ? { model: event.model } : {}),
          },
        },
      }
      setProjectSettings(nextSettings)
      const raw = serializeCanvasData(nodesRef.current, edgesRef.current, nextSettings)
      void persistCanvasRaw(raw, false)
    })
    return unsub
  }, [persistCanvasRaw])

  // Apply an external primary-canvas raw (e.g. user accepted a "merge external
  // edit" prompt). Re-merges with the other loaded folders' current in-memory
  // state preserved — splitMergedForSave reconstructs each non-primary
  // folder's raw from current state, then loadMergedCanvas folds in the new
  // primary raw alongside.
  const applyRawCanvas = useCallback((raw: string, clearDirty: boolean): boolean => {
    try {
      JSON.parse(raw)
      const split = splitMergedForSave({
        nodes: nodesRef.current,
        edges: edgesRef.current,
        primarySettings: settingsRef.current,
        primaryFolderPath: primaryFolder.path,
        folderPaths: loadedFolders.map(f => f.path),
        perFolderSettings: perFolderSettingsRef.current,
        idAliases: idAliasesRef.current,
        edgeAliases: edgeAliasesRef.current,
        folderOffsets: folderOffsetsRef.current,
      })
      const inputs: FolderCanvasInput[] = loadedFolders.map(f => {
        if (f.isPrimary) return { folderPath: f.path, isPrimary: true, raw }
        const entry = split.find(s => s.folderPath === f.path)
        return { folderPath: f.path, isPrimary: false, raw: entry?.raw ?? null }
      })
      const merged = loadMergedCanvas(inputs)
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
      lastAppliedCanvasRef.current = raw
      lastRawByFolderRef.current.set(primaryFolder.path, raw)
      dismissedExternalCanvasRef.current = null
      setPendingExternalCanvasRaw(null)
      setNodes(merged.nodes)
      setEdges(merged.edges)
      setProjectSettings(merged.settings)
      perFolderSettingsRef.current = merged.perFolderSettings
      idAliasesRef.current = merged.idAliases
      edgeAliasesRef.current = merged.edgeAliases
      folderOffsetsRef.current = merged.folderOffsets
      setIsDirty(!clearDirty)
      setDispatchedGraph(null)
      setActiveTab('Canvas')
      resetHistory()
      queueFitView()
      return true
    } catch {
      return false
    }
  }, [primaryFolder.path, loadedFolders, queueFitView, setEdges, setNodes, resetHistory])

  // Stable key for the loaded folder set so this effect doesn't re-fire on
  // every WorkspaceContext value-identity change (only when the actual paths
  // change). Keeps watchers from churning.
  const loadedFolderPathsKey = useMemo(
    () => loadedFolders.map(f => f.path).join('\n'),
    [loadedFolders],
  )

  useEffect(() => {
    if (!workspaceReady) return
    let disposed = false
    lastAppliedCanvasRef.current = ''
    dismissedExternalCanvasRef.current = null
    dismissedExternalByFolderRef.current = new Map()
    externalPendingByFolderRef.current = new Map()
    lastRawByFolderRef.current = new Map()
    setPendingExternalCanvasRaw(null)
    setExternalChangedFolders(new Set())
    setAutoCanvasOfferOpen(false)
    setAutoCanvasStarting(false)

    const watchedFolders = loadedFolders.map(f => f.path)
    for (const path of watchedFolders) {
      void window.electron.watchCanvas(path, pageIdForFolder(path))
    }

    // Re-merge from disk for ALL loaded folders, replacing in-memory state.
    // Called on initial mount and whenever the loaded folder set changes
    // (Add Folder / Remove Folder). Adopting a new folder set is treated as
    // a workspace reload — any unsaved edits to the merged graph are lost,
    // matching the "explicit reshape" mental model the user invokes.
    const reloadAll = async (): Promise<string | null> => {
      const folders = loadedFolders
      const rawArr = await Promise.all(
        folders.map(f => window.electron.loadCanvas(f.path, pageIdForFolder(f.path))),
      )
      if (disposed) return null
      const inputs: FolderCanvasInput[] = folders.map((f, i) => ({
        folderPath: f.path,
        isPrimary: f.isPrimary,
        raw: rawArr[i],
      }))
      const merged = loadMergedCanvas(inputs)
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
      setNodes(merged.nodes)
      setEdges(merged.edges)
      setProjectSettings(merged.settings)
      perFolderSettingsRef.current = merged.perFolderSettings
      idAliasesRef.current = merged.idAliases
      edgeAliasesRef.current = merged.edgeAliases
      folderOffsetsRef.current = merged.folderOffsets
      // Cache each folder's last-observed raw for echo-suppression. Use the
      // raw read from disk (not splitMergedForSave's output) since we want
      // to ignore exactly the bytes the watcher will report next.
      lastRawByFolderRef.current = new Map()
      for (let i = 0; i < folders.length; i += 1) {
        const r = rawArr[i]
        if (r != null) lastRawByFolderRef.current.set(folders[i].path, r)
      }
      const primaryRaw = rawArr[folders.findIndex(f => f.isPrimary)] ?? null
      if (primaryRaw != null) lastAppliedCanvasRef.current = primaryRaw
      setIsDirty(false)
      setDispatchedGraph(null)
      setActiveTab('Canvas')
      resetHistory()
      queueFitView()
      return primaryRaw
    }

    const unsubscribe = window.electron.onCanvasChanged(({ projectDir: changedDir, pageId: changedPageId, raw }) => {
      if (disposed) return
      if (!loadedFolders.some(f => f.path === changedDir)) return
      // Ignore stale events whose pageId no longer matches what we have
      // loaded for that folder (e.g. fired after a page switch + re-watch).
      if (changedPageId !== pageIdForFolder(changedDir)) return
      if (!raw) return
      if (raw === lastRawByFolderRef.current.get(changedDir)) return
      // Primary-only dismissal channel — cross-folder external dismissal is
      // out of scope for v1.
      if (changedDir === primaryFolder.path && raw === dismissedExternalCanvasRef.current) return
      try {
        migrateCanvasData(JSON.parse(raw))
      } catch {
        return
      }

      // Echo-suppression is now driven entirely by lastRawByFolderRef, which
      // persistCanvasRaw pre-sets before its saveCanvas await. If we got here
      // with raw !== lastRaw, it really is an external edit — no need for a
      // splitMergedForSave fallback comparison on every watcher tick.

      if (isDirtyRef.current) {
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current)
          autoSaveTimerRef.current = null
        }
        if (changedDir === primaryFolder.path) {
          setPendingExternalCanvasRaw(raw)
        } else {
          // Skip if the user already dismissed exactly this raw for this
          // folder — matches the primary "remember dismiss" behavior so the
          // modal doesn't reappear on every save.
          if (dismissedExternalByFolderRef.current.get(changedDir) === raw) return
          externalPendingByFolderRef.current.set(changedDir, raw)
          setExternalChangedFolders(prev => {
            if (prev.has(changedDir)) return prev
            const next = new Set(prev)
            next.add(changedDir)
            return next
          })
        }
        return
      }

      // Not dirty: re-merge from disk so the change is reflected. Other
      // folders' on-disk content is re-read too, since they may have been
      // edited by a sibling tool while we sat idle.
      void reloadAll()
    })

    void Promise.all([
      reloadAll(),
      window.electron.inspectProject(primaryFolder.path).catch(() => ({
        projectIsNonEmpty: false,
        hasArchitectDir: false,
        hasCanvasFile: false,
        canvasIsEmpty: false,
      })),
    ]).then(([primaryRaw, projectInfo]) => {
      if (disposed) return
      if (primaryRaw == null) {
        lastAppliedCanvasRef.current = serializeCanvasData(
          nodesRef.current,
          edgesRef.current,
          settingsRef.current,
        )
      }
      let dismissed = false
      try {
        dismissed =
          localStorage.getItem(`${AUTO_CANVAS_DISMISS_PREFIX}${primaryFolder.path}`) === 'true'
      } catch {}
      const lacksMeaningfulCanvas = !projectInfo.hasCanvasFile || projectInfo.canvasIsEmpty
      setAutoCanvasOfferOpen(projectInfo.projectIsNonEmpty && lacksMeaningfulCanvas && !dismissed)
    })

    return () => {
      disposed = true
      unsubscribe()
      for (const path of watchedFolders) {
        void window.electron.unwatchCanvas(path, pageIdForFolder(path))
      }
    }
    // Re-runs on folder set OR active page changes — the watchers, the load,
    // and the merge all key off pageIdForFolder, which changes when the user
    // switches active page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceReady, loadedFolderPathsKey, primaryFolder.path, activePageId, activePage.links.map(l => `${l.folderPath}:${l.pageId}`).join('\n')])

  const cancelCanvasTool = useCallback(() => {
    setPendingCreate(null)
    setPendingEdgeDefaults(null)
  }, [])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      const source = nodesRef.current.find(node => node.id === connection.source)
      const target = nodesRef.current.find(node => node.id === connection.target)
      if (source?.type !== 'component' || target?.type !== 'component') return

      // Detect cross-folder edges so the source folder's canvas can
      // persist the targetFolder annotation. Folder paths come straight
      // from each node's `data.folderPath` (set by load tagging or
      // drop-targeting at creation).
      const sourceFolder = (source.data as { folderPath?: string }).folderPath
      const targetFolder = (target.data as { folderPath?: string }).folderPath
      const isCrossFolder =
        !!sourceFolder && !!targetFolder && sourceFolder !== targetFolder

      snapshotHistory()
      const baseData = normalizeEdgeData(pendingEdgeDefaults ?? { direction: 'source-to-target' })
      const edgeData: ComponentEdgeData = isCrossFolder
        ? { ...baseData, targetFolder: targetFolder! }
        : baseData
      const edge: CanvasEdge = {
        id: createEdgeId(),
        type: 'component-edge',
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        data: edgeData,
      }
      setEdges(eds => addEdge(edge, eds))
      setPendingEdgeDefaults(null)
      setIsDirty(true)
    },
    [pendingEdgeDefaults, setEdges, snapshotHistory]
  )

  const onPaneClick = useCallback((event: ReactMouseEvent) => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    if (!pendingCreate) return
    const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY })

    // Geometric drop targeting: snap the new node to the folder whose
    // region contains the drop point; if the click lands outside every
    // region, fall back to the nearest one (Euclidean distance to the rect
    // edge). Empty placeholders are offset by user drags, so apply those
    // adjustments before testing so the click target matches the visual.
    const rawRegions = computeFolderRegions(nodesRef.current, loadedFolders)
    const regions = applyEmptyAdjustments(rawRegions, emptyFolderOffsets, emptyFolderBasesRef.current)
    const targetRegion = nearestFolderForPoint(regions, flowPoint)
    const folderPath = targetRegion?.folderPath ?? primaryFolder.path

    snapshotHistory()

    if (pendingCreate.kind === 'zone') {
      const config = pendingCreate.config
      setNodes(nds => {
        const usedParticipantIds = new Set<string>()
        for (const n of nds) {
          if (n.type === 'zone') usedParticipantIds.add((n.data as ZoneNodeData).participantId)
        }
        const zoneDefaults = createDefaultZoneAgentConfig(projectSettings)
        const newZone: ZoneNodeType = {
          id: createNodeId('zone'),
          type: 'zone',
          position: { x: flowPoint.x - ZONE_DEFAULT_WIDTH / 2, y: flowPoint.y - ZONE_DEFAULT_HEIGHT / 2 },
          width: ZONE_DEFAULT_WIDTH,
          height: ZONE_DEFAULT_HEIGHT,
          zIndex: 0,
          data: {
            participantId: mintParticipantId(config.label, usedParticipantIds),
            label: config.label,
            description: '',
            color: config.color,
            status: 'idle',
            systemPrompt: config.systemPrompt,
            ...zoneDefaults,
            agentRuntime: config.runtime,
            providerModels: (() => {
              const seed = config.model || DEFAULT_MODEL_BY_RUNTIME[config.runtime]
              if (!seed) return zoneDefaults.providerModels
              return { ...zoneDefaults.providerModels, [config.runtime]: seed }
            })(),
            folderPath,
          },
        }
        return [...nds, newZone]
      })
    } else {
      const config = pendingCreate.config
      const newComp: ComponentNodeType = {
        id: createNodeId('component'),
        type: 'component',
        position: { x: flowPoint.x - COMPONENT_APPROX_W / 2, y: flowPoint.y - COMPONENT_APPROX_H / 2 },
        zIndex: 1,
        data: {
          label: config.label,
          description: '',
          specs: config.specs,
          category: 'custom',
          iconName: 'Wrench',
          color: config.color,
          tag: config.tag,
          folderPath,
        },
      }
      setNodes(nds => [...nds, newComp])
    }

    setPendingCreate(null)
    setIsDirty(true)
  }, [pendingCreate, projectSettings, screenToFlowPosition, setNodes, snapshotHistory, loadedFolders, primaryFolder.path, emptyFolderOffsets])

  const onSave = useCallback(async () => {
    const raw = serializeCanvasData(nodesRef.current, edgesRef.current, settingsRef.current)
    await persistCanvasRaw(raw, true)
    // Big Change: if we've dispatched before and zones changed since, auto-open the
    // dispatch modal with a prefilled prompt describing the diff.
    const snap = dispatchedGraph
    if (!snap) return
    const currentZones = nodesRef.current.filter((n): n is ZoneNodeType => n.type === 'zone')
    const changedLabels = currentZones
      .filter(n => snap[n.id] !== undefined && zoneHash(n) !== snap[n.id])
      .map(n => n.data.label)
    const addedLabels = currentZones
      .filter(n => snap[n.id] === undefined)
      .map(n => n.data.label)
    const removedIds = Object.keys(snap).filter(id => !currentZones.some(z => z.id === id))
    if (changedLabels.length + addedLabels.length + removedIds.length === 0) return
    const parts: string[] = []
    if (changedLabels.length) parts.push(`updated: ${changedLabels.join(', ')}`)
    if (addedLabels.length) parts.push(`added: ${addedLabels.join(', ')}`)
    if (removedIds.length) parts.push(`removed: ${removedIds.length} zone${removedIds.length === 1 ? '' : 's'}`)
    setDispatchPrefill(`Pick up these canvas changes — ${parts.join(' · ')}.`)
    setActiveTab('Canvas')
    setDispatchModalOpen(true)
  }, [persistCanvasRaw, dispatchedGraph])

  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    // Snapshot once at the start of a drag/resize (not every frame) and once
    // per structural change batch.
    const hasSubstantive = changes.some(c => c.type !== 'position' && c.type !== 'select' && c.type !== 'dimensions')
    const startingDragOrResize = changes.some(c =>
      (c.type === 'position' && c.dragging === true) ||
      (c.type === 'dimensions' && c.resizing === true)
    )
    const endingDragOrResize = changes.some(c =>
      (c.type === 'position' && c.dragging === false) ||
      (c.type === 'dimensions' && c.resizing === false)
    )

    if (hasSubstantive) {
      snapshotHistory()
    } else if (startingDragOrResize && !dragOrResizeInFlightRef.current) {
      snapshotHistory()
      dragOrResizeInFlightRef.current = true
    }
    if (endingDragOrResize) {
      dragOrResizeInFlightRef.current = false
    }

    onNodesChange(changes)

    if (hasSubstantive) {
      setIsDirty(true)
      return
    }

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null
      const raw = serializeCanvasData(nodesRef.current, edgesRef.current, settingsRef.current)
      void persistCanvasRaw(raw, false)
    }, 1000)
  }, [onNodesChange, persistCanvasRaw, snapshotHistory])

  const handleEdgesChange = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    const hasSubstantive = changes.some(c => c.type !== 'select')
    if (hasSubstantive) snapshotHistory()
    onEdgesChange(changes)
    setIsDirty(true)
  }, [onEdgesChange, snapshotHistory])

  useEffect(() => {
    const onEdgeMutating = () => {
      snapshotHistory()
      setIsDirty(true)
    }
    // Edge components update through useReactFlow().setEdges, which bypasses
    // the parent onEdgesChange hook. Snapshot here before those local edits land.
    window.addEventListener('architect:edge-mutating', onEdgeMutating)
    return () => window.removeEventListener('architect:edge-mutating', onEdgeMutating)
  }, [snapshotHistory])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelCanvasTool()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancelCanvasTool])

  const onClear = useCallback(() => {
    if (!window.confirm('Clear the canvas? This will remove all zones and components.')) return
    snapshotHistory()
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    setPendingExternalCanvasRaw(null)
    dismissedExternalCanvasRef.current = null
    setNodes([])
    setEdges([])
    setIsDirty(true)
  }, [setEdges, setNodes, snapshotHistory])

  const zones = nodes.filter((n): n is ZoneNodeType => n.type === 'zone')
  const isCanvas = activeTab === 'Canvas'
  const isPages = activeTab === 'Pages'
  const isTerminal = activeTab === 'Terminal'
  const visibleNodes = nodes.filter(node => {
    const folderPath = (node.data as { folderPath?: string }).folderPath ?? primaryFolder.path
    return folderPath === activeFolder.path
  })
  const docPaneNode = docPaneTarget ? nodes.find(node => node.id === docPaneTarget.nodeId) ?? null : null
  const activeZoneDocNode = docPaneTarget?.kind === 'zone' && docPaneNode?.type === 'zone' ? docPaneNode : null
  const activeComponentDocNode = docPaneTarget?.kind === 'component' && docPaneNode?.type === 'component' ? docPaneNode : null
  const patchActiveZoneDocNode = useCallback((partial: Partial<ZoneNodeData>) => {
    if (!activeZoneDocNode) return
    setNodes(nodes => nodes.map(node =>
      node.id === activeZoneDocNode.id
        ? ({ ...node, data: { ...(node.data as ZoneNodeData), ...partial } } as ZoneNodeType)
        : node,
    ))
  }, [activeZoneDocNode, setNodes])
  const patchActiveComponentDocNode = useCallback((partial: Partial<ComponentNodeData>) => {
    if (!activeComponentDocNode) return
    setNodes(nodes => nodes.map(node =>
      node.id === activeComponentDocNode.id
        ? ({ ...node, data: { ...(node.data as ComponentNodeData), ...partial } } as ComponentNodeType)
        : node,
    ))
  }, [activeComponentDocNode, setNodes])

  const changedZoneLabels = dispatchedGraph
    ? zones.filter(n => zoneHash(n) !== dispatchedGraph[n.id]).map(n => n.data.label)
    : []

  const handleDispatchSubmit = useCallback(async (req: DispatchRequest) => {
    if (zones.length === 0) return
    setDispatchModalOpen(false)
    setDispatching(true)
    // Clear the prior dispatch's tabs + active id immediately. The main
    // process kills every non-shell PTY at the top of startDispatch /
    // resumeDispatch; this mirrors that on the renderer so stale tabs
    // don't linger during the spawn await window.
    setTerminalSessions([])
    setActiveDispatchId(null)
    try {
      if (req.mode === 'resume') {
        // Multi-folder dispatch resume: validate all involved folders are
        // currently loaded into the workspace. Any folder that's been
        // removed from the workspace (or moved on disk) gets surfaced so
        // the user can re-add it before retrying. The main process also
        // skips the affected zones gracefully — this just makes the loss
        // visible rather than silent.
        try {
          const records = await window.electron.dispatches.list(projectDir)
          const record = records?.find(r => r.architectSessionId === req.dispatchId)
          const involved = record?.involvedFolders ?? []
          const loadedSet = new Set(loadedFolders.map(f => f.path))
          const missing = involved.filter(p => p && !loadedSet.has(p))
          if (missing.length > 0) {
            const proceed = await new Promise<boolean>(resolve => {
              setMissingFoldersPrompt({ missing, resolve })
            })
            setMissingFoldersPrompt(null)
            if (!proceed) {
              setDispatching(false)
              return
            }
          }
        } catch {
          // Best-effort guard — never block resume on a list-fetch failure.
        }
        // Capture the persisted activity log BEFORE calling resume — the
        // resume wipes the runtime/<dispatchId>/ subtree, so any history
        // we want in the swimlane has to be read first.
        try {
          const [activity, orchestration] = await Promise.all([
            window.electron.dispatches.loadActivity(projectDir, req.dispatchId).catch(() => []),
            window.electron.dispatches.loadOrchestration(projectDir, req.dispatchId).catch(() => []),
          ])
          if (activity.length > 0 || orchestration.length > 0) {
            // Single-shot interleaved seed so the assigned seq matches the
            // chronological order from disk. Two separate seed calls would
            // assign all activity events lower seqs than orchestration events,
            // breaking ordering.
            seedDispatchCombined(req.dispatchId, activity, orchestration)
          }
        } catch {
          // Best-effort — a missing or malformed log file shouldn't block resume.
        }
        const result = await window.electron.dispatches.resume({
          projectDir,
          dispatchId: req.dispatchId,
          nodes,
          edges,
          settings: projectSettings,
        })
        if (!result.ok) {
          const msg = result.error === 'legacy-protocol'
            ? 'This dispatch was created with the legacy protocol and can\'t be resumed under the current build. Start a new dispatch instead.'
            : 'Dispatch record not found.'
          setDispatchErrorMessage(msg)
          return
        }
        setTerminalSessions(result.info)
        // Pre-seed the swimlane so every zone column appears immediately,
        // even before the first activity event from the resumed PTYs lands.
        const participantIds = ['conductor', ...zones.map(z => (z.data.participantId as string) || z.id)]
        seedDispatch(req.dispatchId, participantIds)
        setActiveDispatchId(req.dispatchId)
        // Mark the full current canvas as "dispatched" — the resumed set covers it.
        const snapshot: Record<string, string> = {}
        for (const n of zones) snapshot[n.id] = zoneHash(n)
        setDispatchedGraph(snapshot)
        return
      }

      // Persist the picked Orchestrator CLI so the next DispatchModal
      // pre-selects it. Keep this write alongside the IPC dispatch — they
      // describe the same user action.
      if (projectSettings.conductorRuntime !== req.conductorRuntime) {
        setProjectSettings(current => ({ ...current, conductorRuntime: req.conductorRuntime }))
        setIsDirty(true)
      }
      const sessions = await window.electron.startDispatch(
        nodes,
        edges,
        projectDir,
        projectSettings,
        {
          userPrompt: req.userPrompt,
          model: req.model,
          planMode: req.planMode,
          onlyZoneIds: req.onlyZoneIds,
          conductorRuntime: req.conductorRuntime,
          pageId: activePageId,
        },
      )
      setTerminalSessions(sessions)
      const onlySet = req.onlyZoneIds && req.onlyZoneIds.length > 0
        ? new Set(req.onlyZoneIds)
        : null
      const snapshot: Record<string, string> = { ...(dispatchedGraph ?? {}) }
      for (const n of zones) {
        if (!onlySet || onlySet.has(n.id)) snapshot[n.id] = zoneHash(n)
      }
      setDispatchedGraph(snapshot)
    } finally {
      setDispatching(false)
    }
  }, [zones, nodes, edges, projectDir, projectSettings, dispatchedGraph, changedZoneLabels, loadedFolders])

  const onDispatch = useCallback(() => {
    if (zones.length === 0) return
    setDispatchPrefill('')
    setActiveTab('Canvas')
    setDispatchModalOpen(true)
  }, [zones.length])

  const buildAssistantContext = useCallback((
    mode: AssistantMode,
    currentNodes: CanvasNode[],
    currentEdges: CanvasEdge[],
  ) => {
    const zoneList = currentNodes.filter((n): n is ZoneNodeType => n.type === 'zone')
    const compList = currentNodes.filter((n): n is ComponentNodeType => n.type === 'component')

    if (mode === 'general') {
      // General-mode reads the canvas as reference and never edits it, so
      // hand it the same semantic markdown projection the dispatch prompts
      // use — strips positions/colors/sizes, surfaces cross-zone touchpoints
      // explicitly. Identical formatter as orchestrator/prompts/conductor.ts
      // so what the assistant sees mirrors what coordinated agents see.
      const canvasBlock = zoneList.length === 0 && compList.length === 0
        ? '(empty canvas)'
        : renderProjectionMarkdown(buildCanvasProjection(currentNodes, currentEdges), {
            scope: { kind: 'full' },
            showCrossZoneSection: true,
            showUnassignedSection: true,
          })

      return `You are a general-purpose coding assistant working inside this project directory. Help the user with any coding, debugging, refactoring, research, or shell task they ask about.

The block below is a read-only snapshot of the project's architecture canvas, provided only as reference so you understand the system being built — do not treat it as something to edit. Do NOT modify \`architect-canvas.json\` under any circumstances, and do not emit \`ARCHITECT_CANVAS_UPDATE\` blocks. If the user asks to change the canvas, tell them to switch the assistant to Architecture mode.

## Canvas reference

${canvasBlock}`
    }

    // Architecture mode is the canvas editor — it round-trips
    // ARCHITECT_CANVAS_UPDATE blocks via AssistantPanel's parser, which
    // requires positions, sizes, colors, iconNames, etc. Keep emitting the
    // editable JSON here.
    const componentZones = new Map<string, string | null>()
    for (const c of compList) {
      const center = {
        x: c.position.x + COMPONENT_APPROX_W / 2,
        y: c.position.y + COMPONENT_APPROX_H / 2,
      }
      const containing = zonesContainingPoint(zoneList, center)
      componentZones.set(c.id, containing[0]?.id ?? null)
    }

    const canvasJson = JSON.stringify({
      zones: zoneList.map(z => ({
        id: z.id,
        label: z.data.label,
        description: z.data.description,
        color: z.data.color,
        systemPrompt: z.data.systemPrompt,
        position: z.position,
        width: z.width ?? ZONE_DEFAULT_WIDTH,
        height: z.height ?? ZONE_DEFAULT_HEIGHT,
      })),
      components: compList.map(c => ({
        id: c.id,
        label: c.data.label,
        description: c.data.description,
        specs: c.data.specs,
        category: c.data.category,
        iconName: c.data.iconName,
        color: c.data.color,
        tag: c.data.tag,
        position: c.position,
        overlayedBy: componentZones.get(c.id),
      })),
      edges: currentEdges.map(e => {
        const data = normalizeEdgeData(e.data)
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
          ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
          ...(data.label ? { label: data.label } : {}),
          direction: data.direction ?? 'source-to-target',
        }
      }),
    }, null, 2)

    const canvasBlock = zoneList.length === 0 && compList.length === 0
      ? '(empty canvas)'
      : `\`\`\`json\n${canvasJson}\n\`\`\``

    return `You are an architecture assistant embedded in Architect. The user designs multi-agent systems by drawing **zones** (agent overlays) over **components** (subsystems) on a canvas; the canvas is reference context, not a build manifest.

## Model

- **components** are subsystems/services/modules/UIs/data stores/integrations. Each carries \`label\`, \`specs\` (responsibilities, contracts, schemas), \`tag\`, \`color\`, \`iconName\`. Components do NOT own agent behavior.
- **zones** are translucent agent-ownership overlays. Each zone is one CLI session with a durable role-style \`systemPrompt\` (NOT a build checklist), plus runtime/model/tools/skills/permissions.
- Zone ownership is **geometric**: a component belongs to the zone whose bounding box contains its center. Components outside every zone are design artifacts only.
- **edges** are component-level reference links (dependencies, calls, data flow). Optional \`label\`, \`direction\` (\`source-to-target\` | \`bidirectional\` | \`none\`), and \`sourceHandle\`/\`targetHandle\` connector ids (e.g. \`source-right\`, \`target-left\`).

## Current Canvas
${canvasBlock}

The snapshot above uses the split projection (\`zones\` + \`components\` + \`edges\`); on disk \`architect-canvas.json\` stores a unified \`nodes\` array with a \`type\` discriminator. Both shapes are accepted when patching.

## Canvas JSON shape (file form — what \`architect-canvas.json\` looks like on disk)

\`\`\`json
{
  "nodes": [
    {
      "id": "frontend-zone",
      "type": "zone",
      "position": { "x": 80, "y": 80 },
      "width": 620,
      "height": 360,
      "zIndex": 0,
      "data": {
        "label": "Frontend Agent",
        "description": "Owns the user-facing app shell",
        "color": "#58A6FF",
        "status": "idle",
        "systemPrompt": "Senior frontend engineer. Idiomatic React, accessible UIs.",
        "agentRuntime": "codex",
        "providerModels": { "codex": "gpt-5.2-codex" },
        "openSections": [],
        "skills": [],
        "tools": { "webSearch": false, "codeExec": false, "fileRead": false, "fileWrite": false, "apiCalls": false, "shell": false },
        "behavior": { "mode": "sequential", "retries": 0, "onFailure": "stop", "timeoutMs": 30000 },
        "permissions": { "readFiles": false, "writeFiles": false, "network": false, "shell": false },
        "envVars": []
      }
    },
    {
      "id": "web-ui",
      "type": "component",
      "position": { "x": 120, "y": 170 },
      "zIndex": 1,
      "data": {
        "label": "Frontend",
        "description": "",
        "specs": "React app with auth, dashboard, and settings screens.",
        "category": "custom",
        "iconName": "Monitor",
        "color": "#f472b6",
        "tag": "UI"
      }
    }
  ],
  "edges": [
    {
      "id": "component-flow",
      "source": "web-ui",
      "target": "api-client",
      "sourceHandle": "source-right",
      "targetHandle": "target-left",
      "data": { "label": "uses", "direction": "source-to-target" }
    }
  ],
  "settings": { "dispatchRuntime": "codex" }
}
\`\`\`

### Field rules (for new nodes)

- **Zones** require: \`id\`, \`type: "zone"\`, \`position\`, \`width\`, \`height\`, \`zIndex\`, and \`data\` with \`label\`, \`description\`, \`color\`, \`status\`, \`systemPrompt\`, \`agentRuntime\`, \`providerModels\`, \`openSections\`, \`skills\`, \`tools\`, \`behavior\`, \`permissions\`, \`envVars\`. \`systemPrompt\` is durable role/style, never a build checklist.
- **Components** require: \`id\`, \`type: "component"\`, \`position\`, \`zIndex\`, and \`data\` with \`label\`, \`description\`, \`specs\`, \`category\`, \`iconName\`, \`color\`, \`tag\`. For new components, set \`description: ""\` and \`category: "custom"\` and put detail in \`specs\`.
- Allowed \`iconName\` values: Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench.

## Preservation rules (when patching an existing canvas)

- Preserve existing \`id\`, \`position\`, \`width\`/\`height\`, and top-level \`settings\` unless the user is explicitly changing them.
- Preserve zone \`systemPrompt\`, \`agentRuntime\`, \`providerModels\`, \`tools\`, \`skills\`, \`permissions\`, \`envVars\`, \`behavior\` unless the user is changing those specific fields.
- Preserve component \`specs\` when only renaming/repositioning. Don't blank out specs you didn't author.
- When moving a component to a new zone, change its \`position\` so its center falls inside the target zone's bbox; keep its \`id\`.
- When splitting a zone, keep one half with the original \`id\` (so its participantId survives) and add the other as new.
- After any patch, every edge \`source\`/\`target\` must still reference an existing component id.

## Editing the canvas

You have two ways to apply changes; pick one per response.

**(A) Stream a patch** — the renderer parses fenced blocks out of stdout and applies them live without touching disk. Emit ONE block containing the COMPLETE canvas projection (not just the diff):

~~~
ARCHITECT_CANVAS_UPDATE
{ "zones": [...], "components": [...], "edges": [...] }
END_ARCHITECT_CANVAS_UPDATE
~~~

Either the split form (\`zones\` + \`components\` + \`edges\`) or the unified form (\`nodes\` + \`edges\`) is accepted inside the block.

**(B) Write the file** — overwrite \`architect-canvas.json\` at the project root with the full unified shape (\`nodes\` + \`edges\` + \`settings\`), pretty-printed with 2-space indentation. The app live-reloads on save.

## Optional skills (deeper workflow guidance, if loaded)

- **arch-discover** — generate a canvas by crawling an existing codebase.
- **arch-design** — design a new canvas from a user goal (no code yet).
- **arch-update** — workflow for editing an existing canvas.

These are optional; the shape, field rules, and protocol above are sufficient on their own.

When the user is asking for critique, tradeoffs, or brainstorming, discuss without editing. When they ask to build/generate/update the diagram, edit \`architect-canvas.json\` (or stream a patch) directly.`
  }, [])

  const applyCanvasUpdate = useCallback((update: CanvasUpdate) => {
    snapshotHistory()
    const activeFolderPath = activeFolder.path
    const primaryFolderPath = primaryFolder.path
    // Multi-folder workspaces: the assistant only touches the active
    // folder's slice. Preserve nodes/edges from other folders by filtering
    // them out of the rebuild and re-appending after the assistant's
    // changes are applied. Untagged nodes (no folderPath) are treated as
    // primary-folder residents — otherwise a workspace that flips from
    // single-folder to multi-folder mid-session would silently drop any
    // pre-existing nodes from primary whenever the assistant runs in a
    // non-primary active folder.
    const otherFolderNodes = nodesRef.current.filter(n => {
      const fp = (n.data as { folderPath?: string }).folderPath ?? primaryFolderPath
      return fp !== activeFolderPath
    })
    const otherFolderNodeIds = new Set(otherFolderNodes.map(n => n.id))
    const otherFolderEdges = edgesRef.current.filter(e =>
      otherFolderNodeIds.has(e.source) || otherFolderNodeIds.has(e.target),
    )

    const tagWithActive = <T extends { data: Record<string, unknown> }>(node: T): T => ({
      ...node,
      data: { ...node.data, folderPath: activeFolderPath },
    })

    const rawNodePayload = Array.isArray(update.nodes) ? update.nodes : null
    if (rawNodePayload && !Array.isArray(update.zones) && !Array.isArray(update.components)) {
      const migrated = migrateCanvasData({
        nodes: rawNodePayload,
        edges: Array.isArray(update.edges) ? update.edges : [],
        settings: settingsRef.current,
      })
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
      // De-collide assistant ids against nodes that already live in OTHER
      // workspace folders. Same-folder collisions are intentional (a patch
      // can overwrite an existing node by id), so the reserved set is
      // strictly the other-folder ids.
      const reservedIds = new Set(otherFolderNodes.map(n => n.id))
      const rename = dedupeAgainstReserved(migrated.nodes, reservedIds)
      if (rename.size > 0) {
        for (const e of migrated.edges) {
          const newSource = rename.get(e.source)
          if (newSource) e.source = newSource
          const newTarget = rename.get(e.target)
          if (newTarget) e.target = newTarget
        }
      }
      const taggedAssistantNodes = migrated.nodes.map(n =>
        tagWithActive(n as unknown as { data: Record<string, unknown> }),
      ) as typeof migrated.nodes
      const mergedNodes = [...otherFolderNodes, ...taggedAssistantNodes]
      const mergedEdges = [...otherFolderEdges, ...migrated.edges]
      const rawCanvas = serializeCanvasData(mergedNodes, mergedEdges, migrated.settings)
      setNodes(mergedNodes)
      setEdges(mergedEdges)
      setProjectSettings(migrated.settings)
      setIsDirty(false)
      setDispatchedGraph(null)
      setPendingExternalCanvasRaw(null)
      setActiveTab('Canvas')
      queueFitView()
      void persistCanvasRaw(rawCanvas, true)
      return
    }

    const rawZones = Array.isArray(update.zones) ? (update.zones as Array<Record<string, unknown>>) : []
    const rawComponents = Array.isArray(update.components) ? (update.components as Array<Record<string, unknown>>) : []
    const rawEdges = (update.edges ?? []) as RawCanvasEdge[]

    const existingZones = nodesRef.current.filter((n): n is ZoneNodeType => n.type === 'zone')
    const existingComps = nodesRef.current.filter((n): n is ComponentNodeType => n.type === 'component')
    const existingZoneById = new Map(existingZones.map(z => [z.id, z]))
    const existingCompById = new Map(existingComps.map(c => [c.id, c]))

    const readPosition = (raw: Record<string, unknown>): XYPosition | null => {
      const p = raw.position
      if (p && typeof p === 'object') {
        const obj = p as Record<string, unknown>
        if (typeof obj.x === 'number' && typeof obj.y === 'number') return { x: obj.x, y: obj.y }
      }
      return null
    }

    const readDim = (raw: Record<string, unknown>, key: 'width' | 'height', fallback: number): number => {
      const v = raw[key]
      return typeof v === 'number' && v > 0 ? v : fallback
    }

    const activeSettings = settingsRef.current
    // Seed dedup set with the participantIds of zones that survive this
    // patch (same id in rawZones). Zones being removed don't reserve theirs.
    const survivingIds = new Set(rawZones.map(r => String(r.id ?? '')).filter(Boolean))
    const participantIdsInUse = new Set<string>()
    for (const z of existingZones) {
      if (survivingIds.has(z.id)) participantIdsInUse.add((z.data as ZoneNodeData).participantId)
    }
    const newZones: ZoneNodeType[] = rawZones.map((raw, i) => {
      const id = String(raw.id ?? `gen-zone-${Date.now()}-${i}`)
      const existing = existingZoneById.get(id)
      const position = readPosition(raw) ?? existing?.position ?? {
        x: 120 + (i % 2) * 480,
        y: 120 + Math.floor(i / 2) * 340,
      }
      const width = readDim(raw, 'width', existing?.width ?? ZONE_DEFAULT_WIDTH)
      const height = readDim(raw, 'height', existing?.height ?? ZONE_DEFAULT_HEIGHT)
      const label = String(raw.label ?? 'Zone')
      // Preserve the existing zone's participantId across assistant patches
      // so live dispatches / on-disk activity logs stay addressable; mint a
      // fresh one for brand-new zones the assistant is introducing.
      let participantId = existing?.data.participantId ?? ''
      if (!participantId) {
        participantId = mintParticipantId(label, participantIdsInUse)
        participantIdsInUse.add(participantId)
      }
      return {
        id,
        type: 'zone',
        position,
        width,
        height,
        zIndex: 0,
        data: {
          participantId,
          label,
          description: String(raw.description ?? ''),
          color: String(raw.color ?? '#58A6FF'),
          status: 'idle',
          systemPrompt: String(raw.systemPrompt ?? raw.prompt ?? ''),
          ...createDefaultZoneAgentConfig(activeSettings),
          // Tag with the active folder so multi-folder workspaces persist
          // the assistant's new zones into the right canvas file.
          folderPath: activeFolderPath,
        },
      }
    })

    const zoneById = new Map(newZones.map(z => [z.id, z]))

    const newComps: ComponentNodeType[] = rawComponents.map((raw, i) => {
      const id = String(raw.id ?? `gen-comp-${Date.now()}-${i}`)
      const existing = existingCompById.get(id)
      const explicitPos = readPosition(raw)

      let position: XYPosition
      if (explicitPos) {
        position = explicitPos
      } else if (existing) {
        position = existing.position
      } else {
        const hintZoneId = String(raw.overlayZoneId ?? raw.zoneId ?? '')
        const hintZone = hintZoneId ? zoneById.get(hintZoneId) : undefined
        if (hintZone) {
          const siblings = rawComponents.filter(other =>
            other !== raw && String(other.overlayZoneId ?? other.zoneId ?? '') === hintZoneId
          ).length
          const cols = Math.max(1, Math.floor((hintZone.width ?? ZONE_DEFAULT_WIDTH) / (COMPONENT_APPROX_W + 20)))
          const col = i % cols
          const row = Math.floor(siblings / cols)
          position = {
            x: hintZone.position.x + 24 + col * (COMPONENT_APPROX_W + 20),
            y: hintZone.position.y + 64 + row * (COMPONENT_APPROX_H + 28),
          }
        } else {
          position = {
            x: 120 + (i % 4) * (COMPONENT_APPROX_W + 40),
            y: 520 + Math.floor(i / 4) * (COMPONENT_APPROX_H + 40),
          }
        }
      }

      return {
        id,
        type: 'component',
        position,
        zIndex: 1,
        data: {
          label: String(raw.label ?? 'Component'),
          description: String(raw.description ?? ''),
          specs: typeof raw.specs === 'string' ? raw.specs : '',
          category: (raw.category as ComponentNodeType['data']['category']) ?? 'custom',
          iconName: String(raw.iconName ?? 'Wrench'),
          color: String(raw.color ?? '#60a5fa'),
          tag: String(raw.tag ?? 'NODE'),
          folderPath: activeFolderPath,
        },
      }
    })

    // De-collide assistant ids against nodes from OTHER workspace folders
    // before edges are built — newEdges below reference the (possibly
    // renamed) zone/component ids.
    const reservedIds = new Set(otherFolderNodes.map(n => n.id))
    const renameZones = dedupeAgainstReserved(newZones, reservedIds)
    const renameComps = dedupeAgainstReserved(newComps, reservedIds)
    const rename = new Map([...renameZones, ...renameComps])

    const newEdges: CanvasEdge[] = rawEdges.map(raw => {
      const source = rename.get(raw.source) ?? raw.source
      const target = rename.get(raw.target) ?? raw.target
      return {
        id: raw.id ?? createEdgeId(),
        type: 'component-edge',
        source,
        target,
        sourceHandle: raw.sourceHandle ?? null,
        targetHandle: raw.targetHandle ?? null,
        data: normalizeEdgeData(raw.data ?? raw),
      }
    })

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }

    // Stitch the assistant's edits (active folder) back together with any
    // other folder's nodes/edges that were filtered out at the top of this
    // callback. Single-folder workspaces have empty otherFolder* arrays.
    const mergedNodes = [...otherFolderNodes, ...newZones, ...newComps]
    const mergedEdges = [...otherFolderEdges, ...newEdges]
    const rawCanvas = serializeCanvasData(mergedNodes, mergedEdges, settingsRef.current)
    setNodes(mergedNodes)
    setEdges(mergedEdges)
    setIsDirty(false)
    setDispatchedGraph(null)
    setPendingExternalCanvasRaw(null)
    setActiveTab('Canvas')
    queueFitView()
    void persistCanvasRaw(rawCanvas, true)
  }, [activeFolder.path, primaryFolder.path, persistCanvasRaw, queueFitView, setEdges, setNodes, snapshotHistory])

  // Per-mode effective CLI for the side-panel assistant. Architecture and
  // General maintain independent runtime choices, fully decoupled from the
  // dispatch/zone runtime: if a mode has no entry we fall back to the
  // hardcoded DEFAULT_AGENT_RUNTIME — NEVER to projectSettings.dispatchRuntime.
  // Changing Dispatch CLI in Settings must not retarget the assistant.
  const effectiveAssistantRuntime = useCallback((mode: AssistantMode): AgentRuntime => (
    projectSettings.assistantRuntimeByMode?.[mode] ?? DEFAULT_AGENT_RUNTIME
  ), [projectSettings.assistantRuntimeByMode])

  // When a prior run for this mode was recorded, resume exactly that session
  // under its recorded runtime + model. Overrides both effectiveRuntime and
  // main's latestReachable fallback, so explicit resumes the user made via
  // the launcher aren't clobbered by later fresh captures or model picks.
  const startOptsForImplicitOpen = useCallback((mode: AssistantMode): {
    runtime: AgentRuntime
    opts?: { model?: string; session: { mode: 'resume'; sessionId: string } }
  } => {
    const last = projectSettings.assistantLastSessionByMode?.[mode]
    if (last) {
      return {
        runtime: last.runtime,
        opts: {
          session: { mode: 'resume', sessionId: last.sessionId },
          ...(last.model ? { model: last.model } : {}),
        },
      }
    }
    return { runtime: effectiveAssistantRuntime(mode) }
  }, [projectSettings.assistantLastSessionByMode, effectiveAssistantRuntime])

  const handleAssistantToggle = useCallback(async () => {
    if (assistantOpen) {
      // Close = hide only. Both mode PTYs keep running; their xterm buffers
      // stay mounted so reopening resumes with full scrollback intact.
      setAssistantOpen(false)
      return
    }
    const mode = projectSettings.assistantMode
    const { runtime, opts } = startOptsForImplicitOpen(mode)
    const contextMd = buildAssistantContext(mode, nodes, edges)
    const session = await window.electron.assistant.start(
      activeFolder.path, contextMd, runtime, mode, opts,
    )
    const sessionRuntime = session?.runtime
    setAssistantRuntime(sessionRuntime && sessionRuntime !== 'shell' ? sessionRuntime : runtime)
    setAssistantOpen(true)
  }, [assistantOpen, nodes, edges, activeFolder.path, startOptsForImplicitOpen, projectSettings.assistantMode, buildAssistantContext])

  const handleAutoCanvasDismiss = useCallback(() => {
    try {
      localStorage.setItem(`${AUTO_CANVAS_DISMISS_PREFIX}${projectDir}`, 'true')
    } catch {}
    setAutoCanvasOfferOpen(false)
  }, [projectDir])

  const handleAutoCanvasGenerate = useCallback(async () => {
    if (autoCanvasStarting) return
    setAutoCanvasStarting(true)
    try {
      const mode: AssistantMode = 'architecture'
      const runtime = effectiveAssistantRuntime(mode)
      const contextMd = buildAssistantContext(mode, nodesRef.current, edgesRef.current)
      setProjectSettings(current => ({ ...current, assistantMode: mode }))
      const session = await window.electron.assistant.start(
        activeFolder.path,
        contextMd,
        runtime,
        mode,
        {
          session: { mode: 'new' },
          initialPrompt: AUTO_CANVAS_INITIAL_PROMPT,
          force: true,
        },
      )
      const sessionRuntime = session?.runtime
      setAssistantRuntime(sessionRuntime && sessionRuntime !== 'shell' ? sessionRuntime : runtime)
      setAssistantOpen(true)
      setActiveTab('Canvas')
      setAutoCanvasOfferOpen(false)
    } finally {
      setAutoCanvasStarting(false)
    }
  }, [autoCanvasStarting, buildAssistantContext, effectiveAssistantRuntime, activeFolder.path])

  const handleAssistantClose = useCallback(() => {
    // Hide only — do not tear down PTYs. See handleAssistantToggle.
    setAssistantOpen(false)
  }, [])

  const handleAssistantModeChange = useCallback(async (next: AssistantMode) => {
    if (next === projectSettings.assistantMode) return
    setProjectSettings(s => ({ ...s, assistantMode: next }))
    setIsDirty(true)
    if (assistantOpen) {
      // Spawn the other mode's PTY on first use under ITS last-session or,
      // failing that, its effective runtime. Idempotent thereafter (main
      // returns the existing session instead of respawning).
      const { runtime, opts } = startOptsForImplicitOpen(next)
      const contextMd = buildAssistantContext(next, nodes, edges)
      const session = await window.electron.assistant.start(
        activeFolder.path, contextMd, runtime, next, opts,
      )
      const sessionRuntime = session?.runtime
      setAssistantRuntime(sessionRuntime && sessionRuntime !== 'shell' ? sessionRuntime : runtime)
    }
  }, [assistantOpen, nodes, edges, activeFolder.path, startOptsForImplicitOpen, projectSettings.assistantMode, buildAssistantContext])

  const handleAssistantOrientationChange = useCallback((next: AssistantOrientation) => {
    setAssistantOrientation(next)
    try { localStorage.setItem('architect:assistant-orientation', next) } catch {}
  }, [])

  const handleAssistantRelaunch = useCallback(async (targetMode: AssistantMode, opts: AssistantRelaunchOpts) => {
    const runtime = opts.runtime
    const contextMd = buildAssistantContext(targetMode, nodes, edges)
    const ipcOpts = {
      model: opts.model,
      session: opts.session.mode === 'resume'
        ? { mode: 'resume' as const, sessionId: opts.session.sessionId }
        : { mode: 'new' as const },
      // Launcher submissions always mean "replace the live session with
      // this config" — force a respawn even if the PTY is alive.
      force: true as const,
    }
    const session = await window.electron.assistant.start(
      activeFolder.path, contextMd, runtime, targetMode, ipcOpts,
    )
    const sessionRuntime = session?.runtime
    setAssistantRuntime(sessionRuntime && sessionRuntime !== 'shell' ? sessionRuntime : runtime)
    // Persist the per-mode CLI choice + picked model so the launcher pre-fills
    // them next time. Store the runtime verbatim — once the user explicitly
    // picks an assistant CLI via the modal, it's sticky and doesn't follow
    // Settings-page Dispatch CLI changes.
    //
    // For an explicit resume, stamp assistantLastSessionByMode now — resumes
    // don't trigger a capture event so the zone:session-captured listener
    // won't fire. For "new", the capture listener stamps the new sessionId
    // once it lands; we clear the stale entry here so a crash between respawn
    // and capture doesn't auto-resume the defunct session.
    const resumedSessionId = opts.session.mode === 'resume' ? opts.session.sessionId : null
    const current = settingsRef.current
    const nextByMode = {
      ...(current.assistantRuntimeByMode ?? {}),
      [targetMode]: runtime,
    }
    const nextLastSession = { ...(current.assistantLastSessionByMode ?? {}) }
    if (resumedSessionId) {
      nextLastSession[targetMode] = { runtime, sessionId: resumedSessionId, model: opts.model }
    } else {
      delete nextLastSession[targetMode]
    }
    const cleanedLastSession = Object.keys(nextLastSession).length > 0 ? nextLastSession : undefined
    const nextSettings: ProjectSettings = {
      ...current,
      assistantRuntimeByMode: nextByMode,
      assistantLastSessionByMode: cleanedLastSession,
      assistantModels: { ...(current.assistantModels ?? {}), [runtime]: opts.model },
    }
    setProjectSettings(nextSettings)
    const rawCanvas = serializeCanvasData(nodesRef.current, edgesRef.current, nextSettings)
    void persistCanvasRaw(rawCanvas, false)
  }, [buildAssistantContext, edges, nodes, activeFolder.path, persistCanvasRaw])

  // Project-dir change = real teardown: old PTYs are pinned to old cwd.
  useEffect(() => {
    return () => {
      window.electron.assistant.stop()
    }
  }, [projectDir])

  const handleLoadIncomingCanvas = useCallback(async () => {
    // If non-primary folders also drifted, re-read each one from disk so the
    // merge picks up THEIR changes too (not just primary's). When only the
    // primary changed, fall through to the simpler in-memory merge path.
    if (externalChangedFolders.size > 0) {
      const inputs = await Promise.all(
        loadedFolders.map(async f => {
          if (f.isPrimary) {
            return {
              folderPath: f.path,
              isPrimary: true as const,
              raw: pendingExternalCanvasRaw ?? (await window.electron.loadCanvas(f.path, pageIdForFolder(f.path))),
            }
          }
          if (externalChangedFolders.has(f.path)) {
            return {
              folderPath: f.path,
              isPrimary: false as const,
              raw: await window.electron.loadCanvas(f.path, pageIdForFolder(f.path)),
            }
          }
          // Untouched folder: round-trip its current in-memory slice so the
          // merge result preserves it byte-for-byte.
          const split = splitMergedForSave({
            nodes: nodesRef.current,
            edges: edgesRef.current,
            primarySettings: settingsRef.current,
            primaryFolderPath: primaryFolder.path,
            folderPaths: loadedFolders.map(lf => lf.path),
            perFolderSettings: perFolderSettingsRef.current,
            idAliases: idAliasesRef.current,
            edgeAliases: edgeAliasesRef.current,
            folderOffsets: folderOffsetsRef.current,
          })
          return {
            folderPath: f.path,
            isPrimary: false as const,
            raw: split.find(s => s.folderPath === f.path)?.raw ?? null,
          }
        }),
      )
      const merged = loadMergedCanvas(inputs)
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
      setNodes(merged.nodes)
      setEdges(merged.edges)
      setProjectSettings(merged.settings)
      perFolderSettingsRef.current = merged.perFolderSettings
      idAliasesRef.current = merged.idAliases
      edgeAliasesRef.current = merged.edgeAliases
      folderOffsetsRef.current = merged.folderOffsets
      for (const input of inputs) {
        if (input.raw != null) lastRawByFolderRef.current.set(input.folderPath, input.raw)
      }
      const primaryInput = inputs.find(i => i.isPrimary)
      if (primaryInput?.raw != null) lastAppliedCanvasRef.current = primaryInput.raw
      dismissedExternalCanvasRef.current = null
      dismissedExternalByFolderRef.current = new Map()
      externalPendingByFolderRef.current = new Map()
      setPendingExternalCanvasRaw(null)
      setExternalChangedFolders(new Set())
      setIsDirty(false)
      setDispatchedGraph(null)
      setActiveTab('Canvas')
      resetHistory()
      queueFitView()
      return
    }
    if (pendingExternalCanvasRaw) {
      applyRawCanvas(pendingExternalCanvasRaw, true)
    }
  }, [
    applyRawCanvas,
    externalChangedFolders,
    loadedFolders,
    pageIdForFolder,
    pendingExternalCanvasRaw,
    primaryFolder.path,
    queueFitView,
    resetHistory,
    setEdges,
    setNodes,
  ])

  const handleKeepLocalCanvas = useCallback(() => {
    if (pendingExternalCanvasRaw) {
      dismissedExternalCanvasRef.current = pendingExternalCanvasRaw
      setPendingExternalCanvasRaw(null)
    }
    if (externalChangedFolders.size > 0) {
      // Snapshot each pending folder's latest external raw into the dismissal
      // cache so the same drift won't re-prompt. New, different raws will.
      for (const folderPath of externalChangedFolders) {
        const pending = externalPendingByFolderRef.current.get(folderPath)
        if (pending) dismissedExternalByFolderRef.current.set(folderPath, pending)
      }
      externalPendingByFolderRef.current = new Map()
      setExternalChangedFolders(new Set())
    }
  }, [externalChangedFolders, pendingExternalCanvasRaw])

  // Canvas undo/redo keyboard shortcuts — Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z
  // (or Cmd/Ctrl+Y) redo. Ignored while the user is typing in an input so
  // modals/text fields keep their native undo behavior.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (activeTab !== 'Canvas') return
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const target = e.target as HTMLElement | null
      const inField = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
      if (inField) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoCanvas()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redoCanvas()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeTab, undoCanvas, redoCanvas])

  useEffect(() => {
    return window.electron.menu.onAction((action) => {
      if (action === 'open-folder') onChangeDir()
      else if (action === 'save') void onSave()
      else if (action === 'undo') undoCanvas()
      else if (action === 'redo') redoCanvas()
      else if (action === 'settings') setActiveTab('Settings')
    })
  }, [onChangeDir, onSave, undoCanvas, redoCanvas])

  // 'Logs' is the user-visible tab name in TopNav; the panel it renders is
  // the DispatchView (swimlane + flat log). Keep the variable name aligned
  // with the tab string so a future tab rename only has to be made in one place.
  const isLogs = activeTab === 'Logs'
  const isSettings = activeTab === 'Settings'

  // Mirror the activity store's latestDispatchId so we render the most
  // recently-active dispatch in the Dispatch tab. The store binds its IPC
  // subscriptions on first import, so events that fire before the user opens
  // the Dispatch tab are captured (the previous direct subscription only
  // started receiving once the tab mounted, which dropped early task events).
  const latestStoreDispatchId = useSyncExternalStore(
    subscribeActivityStore,
    () => getActivityStoreSnapshot().latestDispatchId,
    () => getActivityStoreSnapshot().latestDispatchId,
  )
  useEffect(() => {
    if (latestStoreDispatchId && latestStoreDispatchId !== activeDispatchId) {
      setActiveDispatchId(latestStoreDispatchId)
    }
  }, [latestStoreDispatchId, activeDispatchId])

  const participantLabels = useMemo(() => {
    const map: Record<string, string> = { conductor: 'Conductor' }
    for (const z of zones) {
      const pid = (z.data.participantId as string) || z.id
      map[pid] = (z.data.label as string) || z.id
    }
    return map
  }, [zones])

  const participantColors = useMemo(() => {
    // Conductor gets a fixed accent so it reads as orchestration, not a zone.
    // Zones contribute their own color so swimlane column headers match the
    // on-canvas zone they represent.
    const map: Record<string, string> = { conductor: '#7e7eea' }
    for (const z of zones) {
      const pid = (z.data.participantId as string) || z.id
      map[pid] = (z.data.color as string) || '#58A6FF'
    }
    return map
  }, [zones])
  const activePaletteTool: CanvasPaletteTool | null = pendingCreate?.kind ?? (pendingEdgeDefaults ? 'edge' : null)
  const placementHint = pendingCreate
    ? `Click canvas to place ${pendingCreate.kind === 'zone' ? 'zone' : 'component'}`
    : pendingEdgeDefaults
      ? 'Connect two component handles'
      : null
  const defaultZoneRuntime = projectSettings.dispatchRuntime ?? DEFAULT_AGENT_RUNTIME
  const defaultZoneModel = projectSettings.dispatchModels[defaultZoneRuntime] ?? DEFAULT_MODEL_BY_RUNTIME[defaultZoneRuntime] ?? ''

  const handleSettingsChange = useCallback((partial: Partial<ProjectSettings>) => {
    setProjectSettings(current => ({ ...current, ...partial }))
    setIsDirty(true)
    // Picking a new canvas-default CLI bulk-applies it to every zone. Zones
    // can still be manually overridden afterwards; divergence is then
    // surfaced as "Custom" in the Settings panel.
    if ('dispatchRuntime' in partial && partial.dispatchRuntime) {
      const runtime = partial.dispatchRuntime
      setNodes(prev => prev.map(node =>
        node.type === 'zone'
          ? { ...node, data: { ...(node.data as ZoneNodeData), agentRuntime: runtime } }
          : node
      ))
      setDispatchedGraph(null)
    }
  }, [setNodes])

  const openZoneDocPane = useCallback((nodeId: string) => {
    setDocPaneTarget({ kind: 'zone', nodeId })
  }, [])

  const openComponentDocPane = useCallback((nodeId: string) => {
    setDocPaneTarget({ kind: 'component', nodeId })
  }, [])

  const closeDocPane = useCallback(() => {
    setDocPaneTarget(null)
  }, [])

  useEffect(() => {
    if (!docPaneTarget) return
    if (nodes.some(node => node.id === docPaneTarget.nodeId)) return
    setDocPaneTarget(null)
  }, [docPaneTarget, nodes])

  return (
    <ProjectSettingsProvider value={projectSettings}>
      <InterfaceSettingsProvider value={projectSettings.interface}>
      <ProjectDirProvider value={projectDir}>
      <DocPaneProvider
        value={{
          target: docPaneTarget,
          openZone: openZoneDocPane,
          openComponent: openComponentDocPane,
          close: closeDocPane,
        }}
      >
      <div className="flex h-screen flex-col overflow-hidden bg-canvas text-fg">
        <TopNav
          onDispatch={onDispatch}
          dispatching={dispatching}
          nodeCount={zones.length}
          projectDir={projectDir}
          onChangeDir={onChangeDir}
          onAssistantToggle={handleAssistantToggle}
          assistantOpen={assistantOpen}
          onFilesToggle={() => setFilesPanelOpen(o => !o)}
          filesPanelOpen={filesPanelOpen}
          isRedispatch={dispatchedGraph !== null}
          changedCount={changedZoneLabels.length}
          onUndo={undoCanvas}
          onRedo={redoCanvas}
          canUndo={canUndo}
          canRedo={canRedo}
          updateReady={updateReady}
          onUpdateInstall={onUpdateInstall}
        />
        <div className="flex flex-1 overflow-hidden">
          {/* Left rail: Obsidian-style ribbon. Each tab is a bare icon; the
              active tab brightens to full foreground on a soft surface, never
              a colored stripe or hairline. */}
          <nav className="flex flex-col items-stretch w-11 py-2 bg-sidebar border-r border-node-border flex-shrink-0">
            {([
              { id: 'Canvas',   icon: <CanvasGraphIcon size={18} />,                  title: 'Canvas'   },
              { id: 'Pages',    icon: <FileStack size={18} strokeWidth={1.7} />,      title: 'Pages'    },
              { id: 'Terminal', icon: <SquareTerminal size={18} strokeWidth={1.7} />, title: 'Terminal' },
              { id: 'Logs',     icon: <Activity size={18} strokeWidth={1.7} />,       title: 'Logs'     },
            ] as const).map(({ id, icon, title }) => {
              const active = activeTab === id
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  title={title}
                  aria-label={title}
                  className={`flex items-center justify-center mx-1.5 my-0.5 rounded-md py-2 transition-colors ${
                    active
                      ? 'bg-white/[0.09] text-fg'
                      : 'text-fg-subtle hover:text-fg hover:bg-white/[0.05]'
                  }`}
                >
                  {icon}
                </button>
              )
            })}
            <div className="flex-1" />
            <div className="flex items-center justify-center pb-1">
              <UserMenu onOpenSettings={() => setActiveTab('Settings')} />
            </div>
          </nav>
          <div
            className={`flex-1 flex overflow-hidden ${assistantOrientation === 'bottom' ? 'flex-col' : 'flex-row'}`}
          >
            <div className="flex-1 flex overflow-hidden">

          {/* Files: a left-docked resizable panel that lives alongside the
              active tab (Canvas included), mirroring the AssistantPanel
              open/hide pattern. Kept mounted so its directory listing +
              folder-link state survive a close/reopen. */}
          <div style={{ display: filesPanelOpen ? 'contents' : 'none' }}>
            <ResizablePanel side="left" defaultSize={280} minSize={180} maxSize={560}>
              <div className="h-full overflow-hidden">
                <FilesPanel />
              </div>
            </ResizablePanel>
          </div>

          <div className={`flex-1 relative ${isPages ? '' : 'hidden'}`}>
            <PagesPanel onSwitch={() => setActiveTab('Canvas')} />
          </div>
          <div className={`flex-1 relative ${isCanvas ? '' : 'hidden'}`}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onPaneClick={onPaneClick}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              connectionMode={ConnectionMode.Loose}
              elevateNodesOnSelect={false}
              defaultEdgeOptions={{ type: 'component-edge', style: { stroke: '#3a3a3a', strokeWidth: 1.5 } }}
              className={pendingEdgeDefaults ? 'architect-edge-mode' : undefined}
              proOptions={{ hideAttribution: true }}
              fitView
              minZoom={0.05}
              maxZoom={3}
            >
              {/* Grid is still available via Settings; the default canvas is a
                  plain solid surface (no dot texture), painted by the
                  --bg-flow token on .react-flow. */}
              {projectSettings.interface.canvasBackground === 'grid' && (
                <Background
                  variant={BackgroundVariant.Lines}
                  gap={28}
                  size={1}
                  color={projectSettings.interface.theme === 'light' ? '#e2e8f0' : '#69696935'}
                />
              )}
              <FolderRegions
                nodes={nodes}
                emptyOffsets={emptyFolderOffsets}
                setEmptyOffsets={setEmptyFolderOffsets}
                emptyBasesRef={emptyFolderBasesRef}
              />
              <Controls />
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                ariaLabel="Canvas minimap"
                bgColor={projectSettings.interface.theme === 'light' ? '#f9f9f9' : '#1a1a1a'}
                maskColor={
                  projectSettings.interface.theme === 'light'
                    ? 'rgba(0, 0, 0, 0.08)'
                    : 'rgba(0, 0, 0, 0.55)'
                }
                nodeColor={(node) => {
                  const c = (node.data as { color?: string } | undefined)?.color
                  return typeof c === 'string' ? c : '#58A6FF'
                }}
                nodeStrokeColor={projectSettings.interface.theme === 'light' ? '#e0e0e0' : '#3a3a3a'}
                nodeBorderRadius={2}
                style={{
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: 6,
                  width: 180,
                  height: 120,
                }}
              />
            </ReactFlow>

            <div className="absolute right-4 z-30 flex items-center gap-1.5" style={{ bottom: 144 }}>
              <button
                onClick={onClear}
                className="rounded-md border border-node-border bg-node/90 px-2.5 py-1 text-xs text-fg-muted shadow-lg backdrop-blur transition-colors hover:bg-node hover:text-fg"
              >
                Clear
              </button>
              <button
                onClick={onSave}
                className="relative flex items-center gap-1.5 rounded-md border border-node-border bg-node/90 px-2.5 py-1 text-xs text-fg-muted shadow-lg backdrop-blur transition-colors hover:bg-node hover:text-fg"
                title="Save canvas"
              >
                <Save size={11} />
                Save
                {isDirty && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400" />
                )}
              </button>
            </div>

            <CompactCanvasPalette
              activeTool={activePaletteTool}
              placementHint={placementHint}
              defaultZoneRuntime={defaultZoneRuntime}
              defaultZoneModel={defaultZoneModel}
              onCreateComponent={config => {
                setPendingEdgeDefaults(null)
                setPendingCreate({ kind: 'component', config })
              }}
              onCreateZone={config => {
                setPendingEdgeDefaults(null)
                setPendingCreate({ kind: 'zone', config })
              }}
              onCreateEdge={config => {
                setPendingCreate(null)
                setPendingEdgeDefaults(config)
              }}
              onCancel={cancelCanvasTool}
            />

            {autoCanvasOfferOpen && (
              <AutoCanvasOnboardingModal
                starting={autoCanvasStarting}
                onGenerate={() => void handleAutoCanvasGenerate()}
                onDismiss={handleAutoCanvasDismiss}
              />
            )}

            {(pendingExternalCanvasRaw || externalChangedFolders.size > 0) && (
              <CanvasConflictModal
                changedFolders={Array.from(externalChangedFolders)}
                onLoadIncoming={() => void handleLoadIncomingCanvas()}
                onKeepLocal={handleKeepLocalCanvas}
              />
            )}

            {dispatchModalOpen && (
              <DispatchModal
                zones={zones.map(z => ({
                  id: z.id,
                  label: (z.data.label as string) ?? 'Zone',
                  color: (z.data.color as string) ?? '#58A6FF',
                  folderPath:
                    typeof z.data.folderPath === 'string' ? z.data.folderPath : undefined,
                }))}
                prefillPrompt={dispatchPrefill}
                onClose={() => setDispatchModalOpen(false)}
                onSubmit={handleDispatchSubmit}
              />
            )}
          </div>

          <div className={`flex-1 overflow-hidden ${isTerminal ? '' : 'hidden'}`}>
            {terminalPagePoppedOut ? (
              <PoppedOutPlaceholder
                onDock={() => void window.electron.terminalPage.dock()}
              />
            ) : (
              <TerminalPanel
                sessions={terminalSessions}
                isVisible={isTerminal && !terminalPagePoppedOut}
                projectDir={projectDir}
                layout={terminalLayout}
                onLayoutChange={handleTerminalLayoutChange}
                onRemoveSession={(id) =>
                  setTerminalSessions(prev => prev.filter(s => s.id !== id))
                }
                getCanvasSnapshot={() => ({
                  nodes: nodesRef.current,
                  edges: edgesRef.current,
                  settings: settingsRef.current,
                })}
                onPanelPopout={handlePopoutTerminalPage}
              />
            )}
          </div>

          {isLogs && (
            <div className="flex-1 overflow-hidden">
              <DispatchView
                dispatchId={activeDispatchId}
                participantLabels={participantLabels}
                participantColors={participantColors}
                onStartDispatch={onDispatch}
                canStartDispatch={!dispatching && zones.length > 0}
                isLaunching={dispatching}
                onDismiss={() => setActiveTab('Canvas')}
              />
            </div>
          )}

          {isSettings && (
            <div className="flex-1 overflow-hidden">
              <SettingsPanel
                settings={projectSettings}
                zones={zones}
                onChange={handleSettingsChange}
                assistantOrientation={assistantOrientation}
                onAssistantOrientationChange={handleAssistantOrientationChange}
                onGenerateCanvasFromCodebase={() => void handleAutoCanvasGenerate()}
                generatingCanvasFromCodebase={autoCanvasStarting}
                onOpenBugReport={() => setBugReportOpen(true)}
              />
            </div>
          )}

            </div>

            {/* Assistant panel — always mounted once opened, then kept in
                the tree so both mode PTYs + xterm scrollback survive close
                and mode/orientation changes. `visible` toggles display. */}
            <div style={{ display: assistantOpen ? 'contents' : 'none' }}>
              <ResizablePanel
                key={assistantOrientation}
                side={assistantOrientation === 'bottom' ? 'bottom' : 'right'}
                defaultSize={assistantOrientation === 'bottom' ? 320 : 420}
                minSize={160}
                maxSize={900}
              >
                <AssistantPanel
                  visible={assistantOpen}
                  orientation={assistantOrientation}
                  onClose={handleAssistantClose}
                  onCanvasUpdate={applyCanvasUpdate}
                  runtime={assistantRuntime ?? effectiveAssistantRuntime(projectSettings.assistantMode)}
                  mode={projectSettings.assistantMode}
                  onModeChange={handleAssistantModeChange}
                  onRelaunch={handleAssistantRelaunch}
                />
              </ResizablePanel>
            </div>
          </div>
        </div>
        {bugReportOpen && (
          <BugReportModal
            projectDir={projectDir}
            activeDispatchId={activeDispatchId}
            onClose={() => setBugReportOpen(false)}
          />
        )}
        {missingFoldersPrompt && (
          <MissingFoldersPrompt
            missing={missingFoldersPrompt.missing}
            onContinue={() => missingFoldersPrompt.resolve(true)}
            onCancel={() => missingFoldersPrompt.resolve(false)}
          />
        )}
        {dispatchErrorMessage && (
          <DispatchErrorModal
            message={dispatchErrorMessage}
            onClose={() => setDispatchErrorMessage(null)}
          />
        )}
        {activeZoneDocNode && (
          <AgentConfigModal
            zoneColor={(activeZoneDocNode.data.color as string) ?? '#58A6FF'}
            zoneId={activeZoneDocNode.id}
            label={(activeZoneDocNode.data.label as string) ?? 'Zone'}
            systemPrompt={(activeZoneDocNode.data.systemPrompt as string) ?? ''}
            configuredRuntime={(activeZoneDocNode.data.agentRuntime as AgentRuntime) ?? projectSettings.dispatchRuntime}
            effectiveRuntime={getEffectiveRuntime(
              { agentRuntime: (activeZoneDocNode.data.agentRuntime as AgentRuntime) ?? projectSettings.dispatchRuntime },
              projectSettings,
            )}
            effectiveModel={getEffectiveModel(
              {
                providerModels: (activeZoneDocNode.data.providerModels ?? {}) as Record<string, string>,
                agentRuntime: (activeZoneDocNode.data.agentRuntime as AgentRuntime) ?? projectSettings.dispatchRuntime,
              },
              projectSettings,
            )}
            providerModels={(activeZoneDocNode.data.providerModels ?? {}) as Record<string, string>}
            skills={(activeZoneDocNode.data.skills ?? []) as ZoneNodeData['skills']}
            tools={(activeZoneDocNode.data.tools ?? { webSearch: false, codeExec: false, fileRead: false, fileWrite: false, apiCalls: false, shell: false }) as ZoneNodeData['tools']}
            behavior={(activeZoneDocNode.data.behavior ?? { mode: 'sequential', retries: 0, onFailure: 'stop', timeoutMs: 30000 }) as ZoneNodeData['behavior']}
            permissions={(activeZoneDocNode.data.permissions ?? { readFiles: false, writeFiles: false, network: false, shell: false }) as ZoneNodeData['permissions']}
            envVars={(activeZoneDocNode.data.envVars ?? []) as ZoneNodeData['envVars']}
            patch={patchActiveZoneDocNode}
            onClose={closeDocPane}
          />
        )}
        {activeComponentDocNode && (
          <ComponentConfigModal
            label={(activeComponentDocNode.data.label as string) ?? 'Component'}
            specs={(activeComponentDocNode.data.specs as string) ?? ''}
            patch={patchActiveComponentDocNode}
            onClose={closeDocPane}
          />
        )}
      </div>
      </DocPaneProvider>
      </ProjectDirProvider>
      </InterfaceSettingsProvider>
    </ProjectSettingsProvider>
  )
}

function MainApp() {
  const [projectDir, setProjectDir] = useState<string | null>(null)

  useEffect(() => {
    void window.electron.appWindow.setMode(projectDir ? 'workspace' : 'launcher')
  }, [projectDir])

  if (!projectDir) {
    return <DirectoryGate onOpen={setProjectDir} />
  }

  return (
    <ReactFlowProvider>
      <ErrorBoundary>
        <WorkspaceProvider primaryDir={projectDir}>
          <ArchitectFlow projectDir={projectDir} onChangeDir={() => setProjectDir(null)} />
        </WorkspaceProvider>
      </ErrorBoundary>
    </ReactFlowProvider>
  )
}

function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null | 'loading'>('loading')

  useEffect(() => {
    let cancelled = false
    window.electron.auth.getSession().then((s) => {
      if (!cancelled) setSession(s)
    })
    const unsubscribe = window.electron.auth.onSessionChanged((s) => {
      setSession(s)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  if (session === 'loading') {
    return (
      <div className="h-screen w-screen bg-canvas flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-fg-subtle" />
      </div>
    )
  }
  if (session === null && !import.meta.env.RENDERER_VITE_AUTH_BYPASS) {
    return <LoginScreen />
  }
  return <>{children}</>
}

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const popoutId = params.get('popout')
  if (popoutId) {
    return <PopoutTerminalApp id={popoutId} label={params.get('label') ?? popoutId} />
  }
  if (params.get('panel') === 'terminal-page') {
    return <TerminalPagePopoutApp />
  }
  return (
    <AuthGate>
      <RuntimeDetectionProvider>
        <MainApp />
      </RuntimeDetectionProvider>
    </AuthGate>
  )
}
