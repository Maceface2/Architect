import type { Edge } from "@xyflow/react";
import {
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_BY_RUNTIME,
  isAgentRuntime,
  isAgentRuntimeMode,
  type AgentRuntime,
} from "../../../shared/agentRuntimes";
import type {
  ArchitectCanvasData,
  ArchitectNodeData,
  ArchitectNodeType,
  ProjectSettings,
  RuntimeModelMap,
} from "../types";

export function createDefaultProjectSettings(): ProjectSettings {
  return {
    defaultRuntime: DEFAULT_AGENT_RUNTIME,
  };
}

export function createDefaultNodeConfig(
  defaultRuntime: AgentRuntime = DEFAULT_AGENT_RUNTIME,
) {
  return {
    agentRuntimeMode: "inherit" as const,
    agentRuntime: defaultRuntime,
    providerModels: {
      [defaultRuntime]: DEFAULT_MODEL_BY_RUNTIME[defaultRuntime],
    } as RuntimeModelMap,
    openSections: [],
    skills: [],
    additionalChanges: "",
    ownedPaths: [],
    expectedFiles: [],
    contracts: "",
    reviewHints: "",
    tools: {
      webSearch: false,
      codeExec: false,
      fileRead: false,
      fileWrite: false,
      apiCalls: false,
      shell: false,
    },
    behavior: {
      mode: "sequential" as const,
      retries: 0,
      onFailure: "stop" as const,
      timeoutMs: 30000,
    },
    permissions: {
      readFiles: false,
      writeFiles: false,
      network: false,
      shell: false,
    },
    envVars: [],
  };
}

export function getEffectiveRuntime(
  data: Pick<ArchitectNodeData, "agentRuntimeMode" | "agentRuntime">,
  settings: ProjectSettings,
): AgentRuntime {
  return data.agentRuntimeMode === "override"
    ? data.agentRuntime
    : settings.defaultRuntime;
}

export function getEffectiveModel(
  data: Pick<
    ArchitectNodeData,
    "providerModels" | "agentRuntimeMode" | "agentRuntime"
  >,
  settings: ProjectSettings,
): string {
  const runtime = getEffectiveRuntime(data, settings);
  return data.providerModels?.[runtime] ?? DEFAULT_MODEL_BY_RUNTIME[runtime];
}

function normalizeProviderModels(
  rawData: Record<string, unknown>,
  defaultRuntime: AgentRuntime,
): RuntimeModelMap {
  const rawProviderModels = rawData.providerModels;
  const providerModels: RuntimeModelMap = {};

  if (rawProviderModels && typeof rawProviderModels === "object") {
    for (const [runtime, value] of Object.entries(rawProviderModels)) {
      if (
        isAgentRuntime(runtime) &&
        typeof value === "string" &&
        value.trim()
      ) {
        providerModels[runtime] = value;
      }
    }
  }

  if (typeof rawData.model === "string" && !providerModels.claude) {
    providerModels.claude = rawData.model;
  }

  if (!providerModels[defaultRuntime]) {
    providerModels[defaultRuntime] = DEFAULT_MODEL_BY_RUNTIME[defaultRuntime];
  }

  return providerModels;
}

export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  const rawSettings =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaultRuntime = isAgentRuntime(rawSettings.defaultRuntime)
    ? rawSettings.defaultRuntime
    : DEFAULT_AGENT_RUNTIME;

  return { defaultRuntime };
}

export function normalizeNodeData(
  raw: unknown,
  settings: ProjectSettings,
): ArchitectNodeData {
  const rawData =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaultConfig = createDefaultNodeConfig(settings.defaultRuntime);
  const agentRuntime = isAgentRuntime(rawData.agentRuntime)
    ? rawData.agentRuntime
    : DEFAULT_AGENT_RUNTIME;

  return {
    label: typeof rawData.label === "string" ? rawData.label : "Node",
    description:
      typeof rawData.description === "string" ? rawData.description : "",
    category: (rawData.category as ArchitectNodeData["category"]) ?? "services",
    iconName:
      typeof rawData.iconName === "string" ? rawData.iconName : "Settings2",
    color: typeof rawData.color === "string" ? rawData.color : "#60a5fa",
    tag: typeof rawData.tag === "string" ? rawData.tag : "NODE",
    status: (rawData.status as ArchitectNodeData["status"]) ?? "idle",
    prompt: typeof rawData.prompt === "string" ? rawData.prompt : "",
    additionalChanges:
      typeof rawData.additionalChanges === "string"
        ? rawData.additionalChanges
        : defaultConfig.additionalChanges,
    ownedPaths: Array.isArray(rawData.ownedPaths)
      ? rawData.ownedPaths.filter(
          (value): value is string => typeof value === "string",
        )
      : defaultConfig.ownedPaths,
    expectedFiles: Array.isArray(rawData.expectedFiles)
      ? rawData.expectedFiles.filter(
          (value): value is string => typeof value === "string",
        )
      : defaultConfig.expectedFiles,
    contracts:
      typeof rawData.contracts === "string"
        ? rawData.contracts
        : defaultConfig.contracts,
    reviewHints:
      typeof rawData.reviewHints === "string"
        ? rawData.reviewHints
        : defaultConfig.reviewHints,
    agentRuntimeMode: isAgentRuntimeMode(rawData.agentRuntimeMode)
      ? rawData.agentRuntimeMode
      : defaultConfig.agentRuntimeMode,
    agentRuntime,
    providerModels: normalizeProviderModels(rawData, settings.defaultRuntime),
    openSections: Array.isArray(rawData.openSections)
      ? (rawData.openSections as string[])
      : defaultConfig.openSections,
    skills: Array.isArray(rawData.skills)
      ? (rawData.skills as ArchitectNodeData["skills"])
      : defaultConfig.skills,
    tools:
      rawData.tools && typeof rawData.tools === "object"
        ? (rawData.tools as ArchitectNodeData["tools"])
        : defaultConfig.tools,
    behavior:
      rawData.behavior && typeof rawData.behavior === "object"
        ? (rawData.behavior as ArchitectNodeData["behavior"])
        : defaultConfig.behavior,
    permissions:
      rawData.permissions && typeof rawData.permissions === "object"
        ? (rawData.permissions as ArchitectNodeData["permissions"])
        : defaultConfig.permissions,
    envVars: Array.isArray(rawData.envVars)
      ? (rawData.envVars as ArchitectNodeData["envVars"])
      : defaultConfig.envVars,
    claudeSessionId:
      typeof rawData.claudeSessionId === "string" && rawData.claudeSessionId
        ? rawData.claudeSessionId
        : undefined,
  };
}

export function migrateCanvasData(raw: unknown): ArchitectCanvasData {
  const root =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const settings = normalizeProjectSettings(root.settings);
  const rawNodes = Array.isArray(root.nodes)
    ? (root.nodes as Array<Record<string, unknown>>)
    : [];
  const rawEdges = Array.isArray(root.edges)
    ? (root.edges as Array<Record<string, unknown>>)
    : [];

  const nodes: ArchitectNodeType[] = rawNodes.map((node, index) => ({
    id: typeof node.id === "string" ? node.id : `node-${index}`,
    type: "architectNode",
    position: (node.position as ArchitectNodeType["position"]) ?? {
      x: 80 + index * 280,
      y: 80,
    },
    data: normalizeNodeData(node.data, settings),
  }));

  const edges: Edge[] = rawEdges.map((edge, index) => ({
    id: typeof edge.id === "string" ? edge.id : `edge-${index}`,
    source: String(edge.source ?? ""),
    target: String(edge.target ?? ""),
  }));

  return {
    nodes,
    edges,
    settings,
    savedAt: typeof root.savedAt === "string" ? root.savedAt : undefined,
  };
}
