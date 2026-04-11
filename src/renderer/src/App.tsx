import { useState, useCallback, useEffect, useRef } from "react";
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
  type Connection,
  type Edge,
} from "@xyflow/react";

import TopNav from "./components/layout/TopNav";
import AssistantPanel from "./components/layout/AssistantPanel";
import Sidebar from "./components/layout/Sidebar";
import AgentLog from "./components/layout/AgentLog";
import FilesPanel from "./components/layout/FilesPanel";
import TerminalPanel from "./components/layout/TerminalPanel";
import ResizablePanel from "./components/layout/ResizablePanel";
import { nodeTypes } from "./components/nodes/nodeTypes";
import { DispatchActionsProvider } from "./context/DispatchActionsContext";
import { ProjectDirectoryProvider } from "./context/ProjectDirectoryContext";
import type { ArchitectNodeType, ProjectSettings } from "./types";
import { palette, type PaletteItemConfig } from "./data/componentPalette";
import {
  createDefaultNodeConfig,
  createDefaultProjectSettings,
  migrateCanvasData,
} from "./lib/canvas";
import { ProjectSettingsProvider } from "./context/ProjectSettingsContext";
import type { AgentRuntime } from "../../shared/agentRuntimes";
import type {
  GraphPreflightSummary,
  LaunchScopeMode,
  RunGraphOptions,
} from "../../shared/graphDispatch";

interface TerminalInfo {
  id: string;
  label: string;
  runtime: AgentRuntime;
}

const DEMO_NODES: ArchitectNodeType[] = [
  {
    id: "demo-1",
    type: "architectNode",
    position: { x: 160, y: 160 },
    data: {
      label: "React App",
      description: "Client UI layer",
      category: "infrastructure",
      iconName: "Monitor",
      color: "#f472b6",
      tag: "UI",
      status: "idle",
      prompt: "",
      ...createDefaultNodeConfig(),
    },
  },
  {
    id: "demo-2",
    type: "architectNode",
    position: { x: 480, y: 80 },
    data: {
      label: "API Gateway",
      description: "Request routing",
      category: "infrastructure",
      iconName: "Shield",
      color: "#fb923c",
      tag: "API",
      status: "idle",
      prompt: "",
      ...createDefaultNodeConfig(),
    },
  },
  {
    id: "demo-3",
    type: "architectNode",
    position: { x: 160, y: 320 },
    data: {
      label: "PostgreSQL",
      description: "Persistent storage",
      category: "storage",
      iconName: "Database",
      color: "#60a5fa",
      tag: "DB",
      status: "idle",
      prompt: "",
      ...createDefaultNodeConfig(),
    },
  },
];
const DEMO_EDGES: Edge[] = [
  { id: "demo-e1", source: "demo-1", target: "demo-2" },
  { id: "demo-e2", source: "demo-1", target: "demo-3" },
];

// ── Directory gate ─────────────────────────────────────────────────────────

function DirectoryGate({ onOpen }: { onOpen: (dir: string) => void }) {
  const [loading, setLoading] = useState(false);

  const pick = async () => {
    setLoading(true);
    try {
      const dir = await window.electron.openDirectory();
      if (dir) onOpen(dir);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen w-screen bg-canvas flex flex-col items-center justify-center gap-8 select-none">
      {/* Logo */}
      <div className="flex flex-col items-center gap-4">
        <svg width="52" height="52" viewBox="0 0 400 400" fill="none">
          <line
            x1="40"
            y1="360"
            x2="360"
            y2="40"
            stroke="#58A6FF"
            strokeWidth="14"
            strokeLinecap="round"
          />
          <line
            x1="40"
            y1="360"
            x2="200"
            y2="360"
            stroke="#58A6FF"
            strokeWidth="14"
            strokeLinecap="round"
          />
          <line
            x1="200"
            y1="360"
            x2="360"
            y2="40"
            stroke="#58A6FF"
            strokeWidth="14"
            strokeLinecap="round"
          />
          <circle cx="40" cy="360" r="14" fill="#58A6FF" />
          <circle cx="200" cy="360" r="14" fill="#58A6FF" />
          <circle cx="360" cy="40" r="14" fill="#58A6FF" />
        </svg>
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            Architect
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Open a project folder to import existing code or continue where you
            left off
          </p>
        </div>
      </div>

      <button
        onClick={pick}
        disabled={loading}
        className="flex items-center gap-2.5 px-6 py-3 bg-accent hover:bg-[#4a4ad0] disabled:opacity-50 disabled:pointer-events-none text-white text-sm font-medium rounded-lg transition-colors"
      >
        {loading ? "Opening…" : "Open Project Folder"}
      </button>

      <p className="text-xs text-slate-700">
        All agents will be scoped to this directory
      </p>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function nodeHash(n: ArchitectNodeType): string {
  const {
    data: { status: _s, ...data },
  } = n;
  return JSON.stringify(data);
}

function computeLayoutPositions(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>,
): Record<string, { x: number; y: number }> {
  const depths = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const id of nodeIds) incoming.set(id, 0);
  for (const e of edges)
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  const queue = nodeIds.filter((id) => (incoming.get(id) ?? 0) === 0);
  for (const id of queue) depths.set(id, 0);

  const bfs = [...queue];
  while (bfs.length > 0) {
    const id = bfs.shift()!;
    const d = depths.get(id) ?? 0;
    for (const child of adj.get(id) ?? []) {
      if ((depths.get(child) ?? -1) < d + 1) {
        depths.set(child, d + 1);
        bfs.push(child);
      }
    }
  }

  const maxDepth = Math.max(0, ...depths.values());
  for (const id of nodeIds) {
    if (!depths.has(id)) depths.set(id, maxDepth + 1);
  }

  const byDepth = new Map<number, string[]>();
  for (const [id, d] of depths) {
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(id);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [depth, ids] of byDepth) {
    ids.forEach((id, i) => {
      positions[id] = { x: 100 + depth * 320, y: 80 + i * 160 };
    });
  }
  return positions;
}

function serializeCanvasData(
  nodes: ArchitectNodeType[],
  edges: Edge[],
  settings: ProjectSettings,
) {
  return JSON.stringify({
    nodes,
    edges,
    settings,
    savedAt: new Date().toISOString(),
  });
}

function getNestedValue(raw: Record<string, unknown>, key: string) {
  if (key in raw) return raw[key];
  const nested = raw.data;
  if (
    nested &&
    typeof nested === "object" &&
    key in (nested as Record<string, unknown>)
  ) {
    return (nested as Record<string, unknown>)[key];
  }
  return undefined;
}

function getStringValue(
  raw: Record<string, unknown>,
  key: string,
  fallback = "",
) {
  const value = getNestedValue(raw, key);
  return typeof value === "string" ? value : fallback;
}

function getStringArrayValue(
  raw: Record<string, unknown>,
  key: string,
  fallback: string[] = [],
) {
  const value = getNestedValue(raw, key);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : fallback;
}

// ── Main flow ──────────────────────────────────────────────────────────────

function ArchitectFlow({
  projectDir,
  onChangeDir,
}: {
  projectDir: string;
  onChangeDir: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ArchitectNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>(
    createDefaultProjectSettings(),
  );
  const [activeTab, setActiveTab] = useState("Canvas");
  const [terminalSessions, setTerminalSessions] = useState<TerminalInfo[]>([]);
  const [dispatching, setDispatching] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [dispatchedGraph, setDispatchedGraph] = useState<Record<
    string,
    string
  > | null>(null);
  const [initializingProject, setInitializingProject] = useState(true);
  const [bootstrapSummary, setBootstrapSummary] = useState<string | null>(null);
  const [bootstrapStatus, setBootstrapStatus] = useState(
    "Loading project canvas…",
  );
  const [lastPreflight, setLastPreflight] =
    useState<GraphPreflightSummary | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantRuntime, setAssistantRuntime] = useState<AgentRuntime | null>(
    null,
  );
  const [launchRevision, setLaunchRevision] = useState(0);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedCanvasRef = useRef<string | null>(null);
  const [hasCanvasFile, setHasCanvasFile] = useState(false);
  const { screenToFlowPosition } = useReactFlow();

  // Cleanup auto-save timer on unmount
  useEffect(
    () => () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    },
    [],
  );

  // Save Claude session IDs back to node data when agents complete
  useEffect(() => {
    return window.electron.terminal.onNodeSessionSaved(
      ({ nodeId, sessionId }) => {
        setNodes((prev) => {
          const updated = prev.map((n) =>
            n.id === nodeId
              ? { ...n, data: { ...n.data, claudeSessionId: sessionId } }
              : n,
          );
          const serialized = serializeCanvasData(
            updated,
            edges,
            projectSettings,
          );
          lastSyncedCanvasRef.current = serialized;
          setHasCanvasFile(true);
          void window.electron.saveCanvas(projectDir, serialized);
          return updated;
        });
      },
    );
  }, [setNodes, projectDir, edges, projectSettings]);

  // Auto-load canvas on mount
  useEffect(() => {
    let cancelled = false;
    setInitializingProject(true);
    setBootstrapSummary(null);
    setBootstrapStatus("Loading project canvas…");
    setLastPreflight(null);
    lastSyncedCanvasRef.current = null;
    setHasCanvasFile(false);

    const loadProject = async () => {
      try {
        const raw = await window.electron.loadCanvas(projectDir);
        if (cancelled) return;

        if (raw) {
          try {
            const migrated = migrateCanvasData(JSON.parse(raw));
            if (cancelled) return;
            setNodes(migrated.nodes);
            setEdges(migrated.edges);
            setProjectSettings(migrated.settings);
            lastSyncedCanvasRef.current = raw;
            setHasCanvasFile(true);
          } catch {}
          return;
        }

        setNodes([]);
        setEdges([]);
        setHasCanvasFile(false);
        setBootstrapStatus("No project canvas found.");
        setBootstrapSummary(
          "No `architect-canvas.json` exists yet. Use the Architecture Assistant to inspect the repo and draft the initial architecture.",
        );
        setIsDirty(false);
        setDispatchedGraph(null);
      } finally {
        if (!cancelled) setInitializingProject(false);
      }
    };

    void loadProject();

    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge(connection, eds));
      setIsDirty(true);
    },
    [setEdges],
  );

  const onSave = useCallback(async () => {
    const serialized = serializeCanvasData(nodes, edges, projectSettings);
    lastSyncedCanvasRef.current = serialized;
    await window.electron.saveCanvas(projectDir, serialized);
    setHasCanvasFile(true);
    setIsDirty(false);
  }, [projectDir, nodes, edges, projectSettings]);

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData("application/architect-node");
      if (!raw) return;
      const item: PaletteItemConfig = JSON.parse(raw);
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const newNode: ArchitectNodeType = {
        id: `${item.id}-${Date.now()}`,
        type: "architectNode",
        position,
        data: {
          label: item.label,
          description: item.description,
          category: item.category,
          iconName: item.iconName,
          color: item.color,
          tag: item.tag,
          status: "idle",
          prompt: "",
          ...createDefaultNodeConfig(projectSettings.defaultRuntime),
        },
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [projectSettings.defaultRuntime, screenToFlowPosition, setNodes],
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      const hasSubstantive = changes.some(
        (c) =>
          c.type !== "position" &&
          c.type !== "select" &&
          c.type !== "dimensions",
      );
      if (hasSubstantive) {
        setIsDirty(true);
      } else {
        // Position/layout changes: auto-save silently after debounce (no dirty indicator)
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = setTimeout(() => {
          const serialized = serializeCanvasData(nodes, edges, projectSettings);
          lastSyncedCanvasRef.current = serialized;
          setHasCanvasFile(true);
          window.electron.saveCanvas(projectDir, serialized);
        }, 1000);
      }
    },
    [onNodesChange, projectDir, nodes, edges, projectSettings],
  );

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      setIsDirty(true);
    },
    [onEdgesChange],
  );

  const onClear = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setBootstrapSummary(null);
    setIsDirty(true);
  }, [setNodes, setEdges]);
  const onLoadDemo = useCallback(() => {
    setNodes(
      DEMO_NODES.map((node) => ({
        ...node,
        data: {
          ...node.data,
          ...createDefaultNodeConfig(projectSettings.defaultRuntime),
        },
      })),
    );
    setEdges(DEMO_EDGES);
    setBootstrapSummary(null);
    setIsDirty(true);
  }, [projectSettings.defaultRuntime, setNodes, setEdges]);

  const changedNodes = dispatchedGraph
    ? nodes.filter((n) => nodeHash(n) !== dispatchedGraph[n.id])
    : [];
  const changedNodeIds = changedNodes.map((node) => node.id);
  const changedNodeLabels = changedNodes.map((node) => node.data.label);
  const selectedNodeIds = nodes
    .filter((node) => node.selected)
    .map((node) => node.id);

  const dispatchGraph = useCallback(
    async (mode: LaunchScopeMode, nodeIds: string[] = []) => {
      if (nodes.length === 0) return;
      const scopedNodeIds = [...new Set(nodeIds)].filter((nodeId) =>
        nodes.some((node) => node.id === nodeId),
      );
      if (mode !== "all" && scopedNodeIds.length === 0) return;

      const isFullLaunch = mode === "all";
      const options: RunGraphOptions = {};
      if (!isFullLaunch) {
        options.launchScope = { mode, nodeIds: scopedNodeIds };
      }

      setDispatching(true);
      if (isFullLaunch && dispatchedGraph !== null) {
        options.dispatchContext = {
          isRedispatch: true,
          changedNodeIds,
          changedNodeLabels,
        };
      }

      try {
        const result = await window.electron.runGraph(
          nodes,
          edges,
          projectDir,
          projectSettings,
          Object.keys(options).length > 0 ? options : undefined,
        );
        setTerminalSessions(result.sessions as TerminalInfo[]);
        setLastPreflight(result.preflight);
        if (result.sessions.length > 0) setActiveTab("Terminal");
        setLaunchRevision((current) => current + 1);
        if (isFullLaunch) {
          // Snapshot the dispatched graph for incremental re-dispatch detection
          const snapshot: Record<string, string> = {};
          for (const n of nodes) snapshot[n.id] = nodeHash(n);
          setDispatchedGraph(snapshot);
        } else {
          setDispatchedGraph(null);
        }
      } finally {
        setDispatching(false);
      }
    },
    [
      nodes,
      edges,
      projectDir,
      projectSettings,
      dispatchedGraph,
      changedNodeIds,
      changedNodeLabels,
    ],
  );

  const onDispatch = useCallback(() => {
    void dispatchGraph("all");
  }, [dispatchGraph]);

  const onDispatchSelected = useCallback(() => {
    void dispatchGraph("selected", selectedNodeIds);
  }, [dispatchGraph, selectedNodeIds]);

  const launchNodes = useCallback(
    async (nodeIds: string[], mode: Exclude<LaunchScopeMode, "all">) => {
      await dispatchGraph(mode, nodeIds);
    },
    [dispatchGraph],
  );

  useEffect(() => {
    if (initializingProject) return;

    const interval = window.setInterval(() => {
      if (isDirty) return;

      void window.electron.loadCanvas(projectDir).then((raw) => {
        if (!raw || raw === lastSyncedCanvasRef.current) return;
        try {
          const migrated = migrateCanvasData(JSON.parse(raw));
          setNodes(migrated.nodes);
          setEdges(migrated.edges);
          setProjectSettings(migrated.settings);
          setBootstrapSummary(null);
          setDispatchedGraph(null);
          lastSyncedCanvasRef.current = raw;
          setHasCanvasFile(true);
        } catch {}
      });
    }, 1200);

    return () => window.clearInterval(interval);
  }, [initializingProject, isDirty, projectDir, setNodes, setEdges]);

  const buildAssistantContext = useCallback(
    (currentNodes: ArchitectNodeType[], currentEdges: Edge[]) => {
      const canvasJson = JSON.stringify(
        {
          nodes: currentNodes.map((n) => ({
            id: n.id,
            type: "architectNode",
            position: n.position,
            data: {
              label: n.data.label,
              description: n.data.description,
              category: n.data.category,
              iconName: n.data.iconName,
              color: n.data.color,
              tag: n.data.tag,
              prompt: n.data.prompt,
              ownedPaths: n.data.ownedPaths,
              expectedFiles: n.data.expectedFiles,
              contracts: n.data.contracts,
              reviewHints: n.data.reviewHints,
            },
          })),
          edges: currentEdges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
          })),
          settings: projectSettings,
        },
        null,
        2,
      );
      const paletteJson = JSON.stringify(
        palette.map((item) => ({
          label: item.label,
          category: item.category,
          iconName: item.iconName,
          color: item.color,
          tag: item.tag,
        })),
        null,
        2,
      );
      const noArchitectureYet = !hasCanvasFile || currentNodes.length === 0;

      return `You are an architecture assistant embedded in Architect — a tool for visually composing multi-agent and software systems.

## Canonical Canvas File
The architecture for this project lives in \`architect-canvas.json\` at the project root.
If the architecture needs to be created or changed, edit \`architect-canvas.json\` directly.
Do not print the full canvas JSON in chat unless the user explicitly asks for it.
After editing the file, reply with a short summary of the change.

## Current Canvas
${noArchitectureYet ? "(no saved architecture yet)" : `\`\`\`json\n${canvasJson}\n\`\`\``}

## Your Role
Help the user design, refine, and reason about their architecture. You can:
- Discuss design decisions, tradeoffs, and patterns
- Suggest components to add, remove, or restructure
- If \`architect-canvas.json\` does not exist yet or the canvas is empty, inspect the repository and create the initial file.
- When the user asks to change the architecture, modify \`architect-canvas.json\` directly instead of pasting graph JSON in chat.
- Keep the file valid JSON at all times.
- The file should contain the complete canvas, not a partial patch.
Preserve existing node ids whenever possible so the user's layout is not lost.
Base the architecture primarily on the repository structure, directory names, file names, and obvious entrypoints.
Avoid repetitive folder-by-folder clarification. If the repo is messy, prefer fewer stronger nodes instead of many weak guesses.

## architect-canvas.json Shape
Top-level keys:
- \`nodes\`: array
- \`edges\`: array
- \`settings\`: object containing at least \`defaultRuntime\`
- \`savedAt\`: ISO timestamp string

Each node object must contain:
- \`id\`: kebab-case string
- \`type\`: always \`architectNode\`
- \`position\`: object with numeric \`x\` and \`y\`
- \`data\`: object containing the node fields

Each node.data object requires:
- \`label\`
- \`description\`
- \`category\`
- \`iconName\`
- \`color\`
- \`tag\`
- \`prompt\`
- \`ownedPaths\`
- \`expectedFiles\`
- \`contracts\`
- \`reviewHints\`

Available categories: infrastructure | services | storage | custom

Available iconNames: Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench

## Palette Reference
\`\`\`json
${paletteJson}
\`\`\`

## Valid File Example
\`\`\`json
{"nodes":[{"id":"frontend","type":"architectNode","position":{"x":100,"y":80},"data":{"label":"Frontend","description":"Owns the web UI.","category":"infrastructure","iconName":"Monitor","color":"#f472b6","tag":"UI","prompt":"Continue from the existing frontend implementation. Inspect routes and state boundaries before making changes.","ownedPaths":["frontend"],"expectedFiles":["frontend/src/main.tsx"],"contracts":"Routes, UI state boundaries, and integration points.","reviewHints":"Inspect the app entrypoint and API integration points before editing."}},{"id":"api-gateway","type":"architectNode","position":{"x":420,"y":80},"data":{"label":"API Gateway","description":"Owns the API surface.","category":"infrastructure","iconName":"Shield","color":"#fb923c","tag":"API","prompt":"Continue from the existing API implementation. Preserve contracts and only make the next required delta.","ownedPaths":["server"],"expectedFiles":["server/app.ts"],"contracts":"Request/response contracts and public endpoints.","reviewHints":"Inspect route registration and public interfaces before editing."}}],"edges":[{"id":"frontend-to-api","source":"frontend","target":"api-gateway"}],"settings":{"defaultRuntime":"${projectSettings.defaultRuntime}"},"savedAt":"2026-04-10T12:00:00.000Z"}
\`\`\`

Each edge requires: id, source (node id), target (node id)

${
  noArchitectureYet
    ? "There is no saved architecture yet, so inspect the repo and create `architect-canvas.json` directly without waiting for extra confirmation."
    : "If the user asks for architecture changes, edit `architect-canvas.json` directly. Otherwise discuss and advise without rewriting the file."
}`;
    },
    [hasCanvasFile, projectSettings],
  );

  const applyCanvasUpdate = useCallback(
    (update: { nodes: unknown[]; edges: unknown[] }) => {
      const rawNodes = (update.nodes ?? []) as Array<Record<string, unknown>>;
      const rawEdges = (update.edges ?? []) as Array<{
        id?: string;
        source: string;
        target: string;
      }>;
      const existingNodes = new Map(nodes.map((node) => [node.id, node]));
      const existingPositions = new Map(nodes.map((n) => [n.id, n.position]));
      const fallbackPrefix = `gen-${Date.now()}`;
      const normalizedIds = rawNodes.map((node, index) =>
        getStringValue(node, "id", `${fallbackPrefix}-${index}`),
      );
      const positions = computeLayoutPositions(normalizedIds, rawEdges);
      const newNodes: ArchitectNodeType[] = rawNodes.map((raw, i) => {
        const id = normalizedIds[i] ?? `${fallbackPrefix}-${i}`;
        const existing = existingNodes.get(id);
        const categoryValue = getNestedValue(raw, "category");
        const positionValue =
          raw.position && typeof raw.position === "object"
            ? (raw.position as { x?: unknown; y?: unknown })
            : undefined;
        return {
          id,
          type: "architectNode" as const,
          position:
            typeof positionValue?.x === "number" &&
            typeof positionValue?.y === "number"
              ? { x: positionValue.x, y: positionValue.y }
              : (existingPositions.get(id) ??
                positions[id] ?? {
                  x: 80 + (i % 3) * 320,
                  y: 80 + Math.floor(i / 3) * 160,
                }),
          data: {
            ...createDefaultNodeConfig(projectSettings.defaultRuntime),
            ...existing?.data,
            label: getStringValue(raw, "label", "Node"),
            description: getStringValue(raw, "description", ""),
            category: (typeof categoryValue === "string"
              ? categoryValue
              : (existing?.data.category ??
                "services")) as ArchitectNodeType["data"]["category"],
            iconName: getStringValue(raw, "iconName", "Settings2"),
            color: getStringValue(raw, "color", "#60a5fa"),
            tag: getStringValue(raw, "tag", "NODE"),
            status: "idle" as const,
            prompt: getStringValue(raw, "prompt", ""),
            ownedPaths: getStringArrayValue(
              raw,
              "ownedPaths",
              existing?.data.ownedPaths ?? [],
            ),
            expectedFiles: getStringArrayValue(
              raw,
              "expectedFiles",
              existing?.data.expectedFiles ?? [],
            ),
            contracts: getStringValue(
              raw,
              "contracts",
              existing?.data.contracts ?? "",
            ),
            reviewHints: getStringValue(
              raw,
              "reviewHints",
              existing?.data.reviewHints ?? "",
            ),
          },
        };
      });
      const newEdges: Edge[] = rawEdges.map((raw, i) => ({
        id: raw.id ?? `gen-edge-${Date.now()}-${i}`,
        source: raw.source,
        target: raw.target,
      }));
      setNodes(newNodes);
      setEdges(newEdges);
      setBootstrapSummary(null);
      setHasCanvasFile(true);
      const serialized = serializeCanvasData(
        newNodes,
        newEdges,
        projectSettings,
      );
      lastSyncedCanvasRef.current = serialized;
      void window.electron.saveCanvas(projectDir, serialized);
      setIsDirty(false);
      setDispatchedGraph(null);
    },
    [
      nodes,
      projectDir,
      projectSettings,
      projectSettings.defaultRuntime,
      setNodes,
      setEdges,
    ],
  );

  const handleAssistantToggle = useCallback(async () => {
    if (assistantOpen) {
      window.electron.assistant.stop();
      setAssistantOpen(false);
      setAssistantRuntime(null);
    } else {
      const contextMd = buildAssistantContext(nodes, edges);
      const session = await window.electron.assistant.start(
        projectDir,
        contextMd,
        projectSettings.defaultRuntime,
      );
      setAssistantRuntime(session?.runtime ?? projectSettings.defaultRuntime);
      setAssistantOpen(true);
    }
  }, [
    assistantOpen,
    nodes,
    edges,
    projectDir,
    projectSettings.defaultRuntime,
    buildAssistantContext,
  ]);

  const handleAssistantClose = useCallback(() => {
    window.electron.assistant.stop();
    setAssistantOpen(false);
    setAssistantRuntime(null);
  }, []);

  const preflightSummaryText = lastPreflight
    ? `${lastPreflight.counts.missing} missing / ${lastPreflight.counts.adopted} adopt / ${lastPreflight.counts.needs_delta} delta / ${lastPreflight.counts.blocked_by_upstream} upstream / ${lastPreflight.counts.unchanged} unchanged`
    : bootstrapSummary;

  const isCanvas = activeTab === "Canvas";
  const isFiles = activeTab === "Files";
  const isTerminal = activeTab === "Terminal";

  return (
    <ProjectDirectoryProvider value={projectDir}>
      <ProjectSettingsProvider value={projectSettings}>
        <DispatchActionsProvider
          value={{ dispatching, launchRevision, launchNodes }}
        >
          <div className="flex flex-col h-screen bg-canvas text-white overflow-hidden">
            <TopNav
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onClear={onClear}
              onLoadDemo={onLoadDemo}
              onDispatch={onDispatch}
              onDispatchSelected={onDispatchSelected}
              dispatching={dispatching}
              nodeCount={nodes.length}
              selectedCount={selectedNodeIds.length}
              projectDir={projectDir}
              onChangeDir={onChangeDir}
              onSave={onSave}
              isDirty={isDirty}
              onAssistantToggle={handleAssistantToggle}
              assistantOpen={assistantOpen}
              isRedispatch={dispatchedGraph !== null}
              changedCount={changedNodeLabels.length}
              preflightSummary={preflightSummaryText}
              projectSettings={projectSettings}
              onDefaultRuntimeChange={(defaultRuntime) => {
                setProjectSettings((current) => ({
                  ...current,
                  defaultRuntime,
                }));
                setIsDirty(true);
                setDispatchedGraph(null);
              }}
            />
            <div className="flex flex-1 overflow-hidden">
              <ResizablePanel side="left" defaultWidth={160}>
                <Sidebar />
              </ResizablePanel>

              <div className={`flex-1 relative ${isCanvas ? "" : "hidden"}`}>
                {initializingProject ? (
                  <div className="absolute inset-0 flex items-center justify-center text-center px-6">
                    <div>
                      <p className="text-sm text-slate-300">
                        {bootstrapStatus}
                      </p>
                      <p className="text-xs text-slate-600 mt-2">
                        Architect is building a draft canvas from the repo so
                        relaunches can continue from current code instead of
                        starting from zero.
                      </p>
                    </div>
                  </div>
                ) : (
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={handleEdgesChange}
                    onConnect={onConnect}
                    onDrop={onDrop}
                    onDragOver={onDragOver}
                    nodeTypes={nodeTypes}
                    defaultEdgeOptions={{
                      style: { stroke: "#3a3a3a", strokeWidth: 1.5 },
                    }}
                    proOptions={{ hideAttribution: true }}
                    fitView
                  >
                    <Background
                      variant={BackgroundVariant.Dots}
                      gap={28}
                      size={1.5}
                      color="#2a2a2a"
                    />
                    <Controls />
                  </ReactFlow>
                )}
              </div>

              {isFiles && (
                <div className="flex-1 overflow-hidden">
                  <FilesPanel rootDir={projectDir} />
                </div>
              )}

              <div
                className={`flex-1 overflow-hidden ${isTerminal ? "" : "hidden"}`}
              >
                <TerminalPanel
                  sessions={terminalSessions}
                  isVisible={isTerminal}
                />
              </div>

              {!isCanvas && !isFiles && !isTerminal && (
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-slate-600 text-sm">
                    {activeTab} — coming soon
                  </span>
                </div>
              )}

              <ResizablePanel
                key={assistantOpen ? "assistant" : "agentlog"}
                side="right"
                defaultWidth={assistantOpen ? 420 : 256}
              >
                {assistantOpen ? (
                  <AssistantPanel
                    onClose={handleAssistantClose}
                    onCanvasUpdate={applyCanvasUpdate}
                    runtime={assistantRuntime ?? projectSettings.defaultRuntime}
                  />
                ) : (
                  <AgentLog projectDir={projectDir} preflight={lastPreflight} />
                )}
              </ResizablePanel>
            </div>
          </div>
        </DispatchActionsProvider>
      </ProjectSettingsProvider>
    </ProjectDirectoryProvider>
  );
}

// ── Root — gates on directory selection ───────────────────────────────────

export default function App() {
  const [projectDir, setProjectDir] = useState<string | null>(null);

  if (!projectDir) {
    return <DirectoryGate onOpen={setProjectDir} />;
  }

  return (
    <ReactFlowProvider>
      <ArchitectFlow
        projectDir={projectDir}
        onChangeDir={() => setProjectDir(null)}
      />
    </ReactFlowProvider>
  );
}
