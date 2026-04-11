import type { AgentRuntime } from "./agentRuntimes";

export interface DispatchContext {
  isRedispatch: boolean;
  changedNodeIds: string[];
  changedNodeLabels: string[];
}

export type LaunchScopeMode = "all" | "selected" | "single";

export type PreflightNodeStatus =
  | "missing"
  | "adopted"
  | "needs_delta"
  | "blocked_by_upstream"
  | "unchanged";
export type LaunchIntent = "build" | "plan_delta" | "skip";

export interface LaunchScope {
  mode: LaunchScopeMode;
  nodeIds: string[];
}

export interface PreflightNodeResult {
  nodeId: string;
  label: string;
  status: PreflightNodeStatus;
  launchIntent: LaunchIntent;
  reason: string;
  ownedPaths: string[];
  existingOwnedPaths: string[];
  missingOwnedPaths: string[];
  expectedFiles: string[];
  existingExpectedFiles: string[];
  missingExpectedFiles: string[];
  upstreamChanged: boolean;
  hasExistingOutput: boolean;
}

export interface GraphPreflightSummary {
  generatedAt: string;
  counts: Record<PreflightNodeStatus, number>;
  nodes: PreflightNodeResult[];
}

export interface GraphTerminalSession {
  id: string;
  label: string;
  runtime: AgentRuntime;
}

export interface RunGraphResult {
  sessions: GraphTerminalSession[];
  preflight: GraphPreflightSummary;
}

export interface RunGraphOptions {
  launchScope?: LaunchScope;
  dispatchContext?: DispatchContext;
}
