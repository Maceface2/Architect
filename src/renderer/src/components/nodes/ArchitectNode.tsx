import { memo, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Handle,
  Position,
  useReactFlow,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import { Plus, X, FileText, Zap } from "lucide-react";
import {
  AGENT_RUNTIMES,
  DEFAULT_MODEL_BY_RUNTIME,
  getAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeMode,
} from "../../../../shared/agentRuntimes";
import { useProjectSettings } from "../../context/ProjectSettingsContext";
import { useProjectDirectory } from "../../context/ProjectDirectoryContext";
import { useDispatchActions } from "../../context/DispatchActionsContext";
import { getEffectiveModel, getEffectiveRuntime } from "../../lib/canvas";
import type {
  ArchitectNodeData,
  NodeStatus,
  NodeSkillFile,
  NodeTools,
  NodeBehavior,
  NodePermissions,
  NodeEnvVar,
  RunMode,
  OnFailure,
  RuntimeModelMap,
} from "../../types";

type ArchitectNodeProps = NodeProps<Node<ArchitectNodeData>>;

const BUILTIN_SKILLS: Omit<NodeSkillFile, "id">[] = [
  { name: "researcher.md", path: "builtin:researcher", builtin: true },
  { name: "planner.md", path: "builtin:planner", builtin: true },
  { name: "code-reviewer.md", path: "builtin:code-reviewer", builtin: true },
  { name: "debugger.md", path: "builtin:debugger", builtin: true },
  { name: "writer.md", path: "builtin:writer", builtin: true },
  { name: "analyst.md", path: "builtin:analyst", builtin: true },
];

function ArchitectNode({ id, data, selected }: ArchitectNodeProps) {
  const { setNodes, getNodes } = useReactFlow();
  const [modalOpen, setModalOpen] = useState(false);
  const [taskPreview, setTaskPreview] = useState<string | null>(null);
  const projectSettings = useProjectSettings();
  const projectDir = useProjectDirectory();
  const { launchRevision } = useDispatchActions();

  const nodeColor = data.color as string;
  const tag = data.tag as string;
  const label = data.label as string;
  const prompt = (data.prompt ?? "") as string;
  const additionalChanges = (data.additionalChanges ?? "") as string;
  const claudeSessionId = (data.claudeSessionId ?? "") as string;
  const ownedPaths = (data.ownedPaths ?? []) as string[];
  const expectedFiles = (data.expectedFiles ?? []) as string[];
  const contracts = (data.contracts ?? "") as string;
  const reviewHints = (data.reviewHints ?? "") as string;
  const status = data.status as NodeStatus;
  const runtimeMode = (data.agentRuntimeMode ?? "inherit") as AgentRuntimeMode;
  const configuredRuntime = (data.agentRuntime ??
    projectSettings.defaultRuntime) as AgentRuntime;
  const providerModels = (data.providerModels ?? {}) as RuntimeModelMap;
  const effectiveRuntime = getEffectiveRuntime(
    {
      agentRuntimeMode: runtimeMode,
      agentRuntime: configuredRuntime,
    },
    projectSettings,
  );
  const effectiveModel = getEffectiveModel(
    {
      providerModels,
      agentRuntimeMode: runtimeMode,
      agentRuntime: configuredRuntime,
    },
    projectSettings,
  );
  const skills = (data.skills ?? []) as NodeSkillFile[];
  const tools = (data.tools ?? {
    webSearch: false,
    codeExec: false,
    fileRead: false,
    fileWrite: false,
    apiCalls: false,
    shell: false,
  }) as NodeTools;
  const behavior = (data.behavior ?? {
    mode: "sequential",
    retries: 0,
    onFailure: "stop",
    timeoutMs: 30000,
  }) as NodeBehavior;
  const permissions = (data.permissions ?? {
    readFiles: false,
    writeFiles: false,
    network: false,
    shell: false,
  }) as NodePermissions;
  const envVars = (data.envVars ?? []) as NodeEnvVar[];
  const runtimeMeta = getAgentRuntime(effectiveRuntime);

  const patch = (partial: Partial<ArchitectNodeData>) =>
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? {
              ...node,
              data: { ...(node.data as ArchitectNodeData), ...partial },
            }
          : node,
      ),
    );

  const toggleSelected = () => {
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, selected: !node.selected } : node,
      ),
    );
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const maxAttempts = launchRevision > 0 ? 20 : 1;

    const readPreview = async () => {
      let content = await window.electron.readFile(
        getTaskFilePath(projectDir, id),
      );
      if (!content && hasUniqueLabel(label, getNodes())) {
        content = await window.electron.readFile(
          getLegacyTaskFilePath(projectDir, label),
        );
      }
      if (cancelled) return;

      const normalized = normalizeTaskPreview(content);
      setTaskPreview(normalized);

      attempts += 1;
      if (!normalized && attempts < maxAttempts) {
        timer = setTimeout(() => {
          void readPreview();
        }, 1500);
      }
    };

    void readPreview();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectDir, id, label, launchRevision, getNodes]);

  return (
    <div className="relative">
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 11,
          height: 11,
          background: "#1e1e1e",
          border: `2px solid ${nodeColor}`,
          left: -6,
          zIndex: 10,
        }}
      />

      <div
        className={`relative bg-[#1e1e1e] rounded-xl overflow-hidden min-w-[200px] max-w-[240px] border shadow-2xl cursor-pointer transition-colors select-none ${
          selected
            ? "border-[#58A6FF]/70 ring-1 ring-[#58A6FF]/40"
            : "border-white/[0.06] hover:border-white/20"
        }`}
        onClick={() => setModalOpen(true)}
      >
        <div
          className="absolute left-0 top-0 bottom-0 w-[5px]"
          style={{ backgroundColor: nodeColor }}
        />
        <div className="pl-[18px] pr-3.5 pt-3 pb-3">
          <div className="flex items-center justify-between mb-1.5">
            <span
              className="text-[11px] font-bold tracking-widest"
              style={{ color: nodeColor }}
            >
              {tag}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSelected();
                }}
                title={
                  selected
                    ? `Remove ${label} from launch selection`
                    : `Select ${label} for launch`
                }
                className={`nodrag nopan inline-flex items-center justify-center w-6 h-6 rounded-md border bg-black/20 transition-colors ${
                  selected
                    ? "border-[#58A6FF]/50 text-[#58A6FF]"
                    : "border-white/[0.08] text-slate-400 hover:text-white hover:border-white/20"
                }`}
              >
                <Zap size={12} />
              </button>
              <span
                className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider"
                style={{
                  color: runtimeMeta.accentColor,
                  backgroundColor: `${runtimeMeta.accentColor}20`,
                }}
              >
                {runtimeMode === "inherit"
                  ? `default:${runtimeMeta.shortLabel}`
                  : runtimeMeta.shortLabel}
              </span>
              <div
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: statusColor(status, nodeColor) }}
              />
            </div>
          </div>
          <p className="text-[15px] font-semibold text-white leading-snug">
            {label}
          </p>
          <p className="text-[10px] text-slate-600 mt-1 font-mono truncate">
            {shortModelLabel(effectiveModel)}
          </p>
          {(taskPreview || prompt) && (
            <p
              className={`text-[10px] mt-1.5 leading-relaxed line-clamp-3 ${taskPreview ? "text-slate-400" : "text-slate-500"}`}
            >
              {taskPreview ? previewSnippet(taskPreview) : prompt}
            </p>
          )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 11,
          height: 11,
          background: "#1e1e1e",
          border: `2px solid ${nodeColor}`,
          right: -6,
          zIndex: 10,
        }}
      />

      {modalOpen &&
        createPortal(
          <NodeConfigModal
            nodeId={id}
            selected={selected}
            taskPreview={taskPreview}
            nodeColor={nodeColor}
            tag={tag}
            label={label}
            prompt={prompt}
            additionalChanges={additionalChanges}
            claudeSessionId={claudeSessionId}
            ownedPaths={ownedPaths}
            expectedFiles={expectedFiles}
            contracts={contracts}
            reviewHints={reviewHints}
            runtimeMode={runtimeMode}
            configuredRuntime={configuredRuntime}
            effectiveRuntime={effectiveRuntime}
            effectiveModel={effectiveModel}
            providerModels={providerModels}
            skills={skills}
            tools={tools}
            behavior={behavior}
            permissions={permissions}
            envVars={envVars}
            patch={patch}
            onClose={() => setModalOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

interface ModalProps {
  nodeId: string;
  selected: boolean;
  taskPreview: string | null;
  nodeColor: string;
  tag: string;
  label: string;
  prompt: string;
  additionalChanges: string;
  claudeSessionId: string;
  ownedPaths: string[];
  expectedFiles: string[];
  contracts: string;
  reviewHints: string;
  runtimeMode: AgentRuntimeMode;
  configuredRuntime: AgentRuntime;
  effectiveRuntime: AgentRuntime;
  effectiveModel: string;
  providerModels: RuntimeModelMap;
  skills: NodeSkillFile[];
  tools: NodeTools;
  behavior: NodeBehavior;
  permissions: NodePermissions;
  envVars: NodeEnvVar[];
  patch: (partial: Partial<ArchitectNodeData>) => void;
  onClose: () => void;
}

function NodeConfigModal({
  nodeId,
  selected,
  taskPreview,
  nodeColor,
  tag,
  label,
  prompt,
  additionalChanges,
  claudeSessionId,
  ownedPaths,
  expectedFiles,
  contracts,
  reviewHints,
  runtimeMode,
  configuredRuntime,
  effectiveRuntime,
  effectiveModel,
  providerModels,
  skills,
  tools,
  behavior,
  permissions,
  envVars,
  patch,
  onClose,
}: ModalProps) {
  const [labelDraft, setLabelDraft] = useState(label);
  const [customSkillInput, setCustomSkillInput] = useState("");
  const labelInputRef = useRef<HTMLInputElement>(null);
  const { setNodes } = useReactFlow();
  const projectSettings = useProjectSettings();
  const effectiveRuntimeMeta = getAgentRuntime(effectiveRuntime);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasSkill = (path: string) =>
    skills.some((skill) => skill.path === path);
  const toggleBuiltinSkill = (preset: Omit<NodeSkillFile, "id">) => {
    if (hasSkill(preset.path))
      patch({ skills: skills.filter((skill) => skill.path !== preset.path) });
    else patch({ skills: [...skills, { ...preset, id: preset.path }] });
  };

  const addCustomSkill = () => {
    const raw = customSkillInput.trim();
    if (!raw) return;
    const name = raw.endsWith(".md") ? raw : `${raw}.md`;
    const path = `custom:${name}`;
    if (!hasSkill(path))
      patch({ skills: [...skills, { id: path, name, path, builtin: false }] });
    setCustomSkillInput("");
  };

  const removeSkill = (path: string) =>
    patch({ skills: skills.filter((skill) => skill.path !== path) });
  const toggleTool = (key: keyof NodeTools) =>
    patch({ tools: { ...tools, [key]: !tools[key] } });
  const setBehavior = (partial: Partial<NodeBehavior>) =>
    patch({ behavior: { ...behavior, ...partial } });
  const togglePerm = (key: keyof NodePermissions) =>
    patch({ permissions: { ...permissions, [key]: !permissions[key] } });
  const addEnvVar = () =>
    patch({ envVars: [...envVars, { key: "", value: "" }] });
  const removeEnvVar = (index: number) =>
    patch({ envVars: envVars.filter((_, idx) => idx !== index) });
  const updateEnvVar = (
    index: number,
    field: keyof NodeEnvVar,
    value: string,
  ) =>
    patch({
      envVars: envVars.map((envVar, idx) =>
        idx === index ? { ...envVar, [field]: value } : envVar,
      ),
    });

  const setRuntimeMode = (mode: AgentRuntimeMode) => {
    patch({
      agentRuntimeMode: mode,
      agentRuntime: mode === "override" ? effectiveRuntime : configuredRuntime,
    });
  };

  const setConfiguredRuntime = (runtime: AgentRuntime) => {
    patch({ agentRuntime: runtime });
  };

  const setRuntimeModel = (runtime: AgentRuntime, model: string) => {
    patch({
      providerModels: {
        ...providerModels,
        [runtime]: model,
      },
    });
  };

  const saveLabel = () => {
    const trimmed = labelDraft.trim();
    if (trimmed && trimmed !== label) patch({ label: trimmed });
  };

  const toggleSelected = () => {
    saveLabel();
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === nodeId ? { ...node, selected: !node.selected } : node,
      ),
    );
  };

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="bg-[#161616] rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden"
        style={{ width: "90vw", height: "85vh", maxWidth: 1100 }}
      >
        <div
          className="flex items-center gap-4 px-6 py-4 border-b border-white/[0.07] flex-shrink-0"
          style={{ borderLeftColor: nodeColor, borderLeftWidth: 4 }}
        >
          <span
            className="text-[11px] font-bold tracking-widest flex-shrink-0"
            style={{ color: nodeColor }}
          >
            {tag}
          </span>
          <input
            ref={labelInputRef}
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value)}
            onBlur={saveLabel}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                saveLabel();
                labelInputRef.current?.blur();
              }
            }}
            className="text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-white/20 focus:border-white/40 focus:outline-none transition-colors flex-1 min-w-0"
            placeholder="Agent name"
          />
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-white transition-colors flex-shrink-0 p-1"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0 divide-x divide-white/[0.06]">
          <div className="flex flex-col flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-slate-600 px-6 pt-5 pb-2 flex-shrink-0">
              {taskPreview ? "Task Preview" : "Initial Prompt"}
            </p>
            {taskPreview ? (
              <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
                <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4 text-slate-300 text-sm leading-relaxed whitespace-pre-wrap font-mono min-h-[260px]">
                  {taskPreview}
                </div>
                <div className="mt-4">
                  <p className="text-[10px] uppercase tracking-widest text-slate-600 mb-2">
                    Additional Changes
                  </p>
                  <textarea
                    value={additionalChanges}
                    onChange={(event) =>
                      patch({ additionalChanges: event.target.value })
                    }
                    placeholder="Optional follow-up changes to apply when relaunching this component..."
                    className="w-full min-h-28 bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono resize-y"
                  />
                </div>
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] uppercase tracking-widest text-slate-600">
                      Resume Session
                    </p>
                    {claudeSessionId && (
                      <button
                        onClick={() => patch({ claudeSessionId: "" })}
                        className="text-[10px] text-slate-600 hover:text-red-400 transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={claudeSessionId}
                    onChange={(event) =>
                      patch({ claudeSessionId: event.target.value })
                    }
                    placeholder="Session ID auto-saved after completion..."
                    className="w-full bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[11px] text-slate-400 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                  />
                  {claudeSessionId && (
                    <p className="text-[10px] text-slate-600 mt-1">
                      Relaunch will resume this session instead of re-injecting
                      the full prompt.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <textarea
                value={prompt}
                onChange={(event) => patch({ prompt: event.target.value })}
                placeholder="Describe what this agent should do — its role, goals, constraints, and any specific instructions..."
                autoFocus
                className="flex-1 bg-transparent text-slate-200 text-sm leading-relaxed px-6 pb-6 resize-none focus:outline-none placeholder-slate-700 font-mono"
              />
            )}
          </div>

          <div className="w-[340px] flex-shrink-0 overflow-y-auto">
            <div className="p-6 space-y-6">
              {taskPreview && (
                <Section title="Initial Prompt">
                  <textarea
                    value={prompt}
                    onChange={(event) => patch({ prompt: event.target.value })}
                    placeholder="Adjust the seed prompt used the next time Architect regenerates this task file..."
                    className="w-full min-h-28 bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono resize-y"
                  />
                </Section>
              )}

              <Section title="Implementation Signals">
                <div className="space-y-3">
                  <ListField
                    label="Owned paths"
                    value={ownedPaths}
                    placeholder="apps/web\nsrc/server"
                    onChange={(value) =>
                      patch({ ownedPaths: parseMultiLineList(value) })
                    }
                  />
                  <ListField
                    label="Expected files"
                    value={expectedFiles}
                    placeholder="apps/web/package.json\napps/web/src/main.tsx"
                    onChange={(value) =>
                      patch({ expectedFiles: parseMultiLineList(value) })
                    }
                  />
                  <div>
                    <p className="text-[11px] text-slate-500 mb-1.5">
                      Contracts
                    </p>
                    <textarea
                      value={contracts}
                      onChange={(event) =>
                        patch({ contracts: event.target.value })
                      }
                      placeholder="Endpoints, schemas, exports, or ownership boundaries this node is expected to preserve."
                      className="w-full min-h-24 bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono resize-y"
                    />
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500 mb-1.5">
                      Review hints
                    </p>
                    <textarea
                      value={reviewHints}
                      onChange={(event) =>
                        patch({ reviewHints: event.target.value })
                      }
                      placeholder="How this node should inspect existing code before applying deltas."
                      className="w-full min-h-20 bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono resize-y"
                    />
                  </div>
                </div>
              </Section>

              <Section title="Runtime">
                <div className="space-y-3">
                  <Field label="Selection">
                    <Seg
                      options={["inherit", "override"] as AgentRuntimeMode[]}
                      value={runtimeMode}
                      onChange={setRuntimeMode}
                    />
                  </Field>
                  <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2 text-[11px] text-slate-400">
                    {runtimeMode === "inherit"
                      ? `Using project default: ${getAgentRuntime(projectSettings.defaultRuntime).label}`
                      : "This node uses its own CLI selection."}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {AGENT_RUNTIMES.map((runtime) => {
                      const selected =
                        (runtimeMode === "inherit"
                          ? projectSettings.defaultRuntime
                          : configuredRuntime) === runtime.id;
                      return (
                        <button
                          key={runtime.id}
                          onClick={() => setConfiguredRuntime(runtime.id)}
                          disabled={runtimeMode === "inherit"}
                          className={`flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-colors ${
                            selected
                              ? "border-[#58A6FF]/50 bg-[#58A6FF]/10 text-white"
                              : "border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20"
                          } ${runtimeMode === "inherit" ? "opacity-50 cursor-not-allowed" : ""}`}
                        >
                          <span className="text-[12px] font-medium">
                            {runtime.label}
                          </span>
                          <span
                            className="text-[10px] uppercase tracking-wider"
                            style={{ color: runtime.accentColor }}
                          >
                            {runtime.shortLabel}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Section>

              <Section title="Model">
                <div className="space-y-2">
                  <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-slate-600">
                      Effective runtime
                    </p>
                    <p className="text-[12px] text-white mt-1">
                      {effectiveRuntimeMeta.label}
                    </p>
                  </div>
                  <input
                    value={effectiveModel}
                    onChange={(event) =>
                      setRuntimeModel(effectiveRuntime, event.target.value)
                    }
                    placeholder={DEFAULT_MODEL_BY_RUNTIME[effectiveRuntime]}
                    className="w-full bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[12px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {effectiveRuntimeMeta.suggestedModels.map((model) => (
                      <button
                        key={model}
                        onClick={() => setRuntimeModel(effectiveRuntime, model)}
                        className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                          effectiveModel === model
                            ? "border-[#58A6FF]/50 bg-[#58A6FF]/10 text-[#58A6FF]"
                            : "border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20"
                        }`}
                      >
                        {shortModelLabel(model)}
                      </button>
                    ))}
                  </div>
                </div>
              </Section>

              <Section title="Skills">
                <p className="text-[10px] text-slate-700 uppercase tracking-wider mb-2">
                  Presets
                </p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {BUILTIN_SKILLS.map((preset) => {
                    const active = hasSkill(preset.path);
                    return (
                      <button
                        key={preset.path}
                        onClick={() => toggleBuiltinSkill(preset)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] border transition-colors ${
                          active
                            ? "border-[#58A6FF]/50 bg-[#58A6FF]/10 text-[#58A6FF]"
                            : "border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20"
                        }`}
                      >
                        <FileText size={10} />
                        {preset.name}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-slate-700 uppercase tracking-wider mb-2">
                  Custom
                </p>
                <div className="flex gap-2 mb-2">
                  <input
                    value={customSkillInput}
                    onChange={(event) =>
                      setCustomSkillInput(event.target.value)
                    }
                    onKeyDown={(event) =>
                      event.key === "Enter" && addCustomSkill()
                    }
                    placeholder="path/to/skill.md"
                    className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                  />
                  <button
                    onClick={addCustomSkill}
                    className="text-slate-500 hover:text-slate-200 transition-colors"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {skills.length > 0 && (
                  <div className="space-y-1">
                    {skills.map((skill) => (
                      <div
                        key={skill.path}
                        className="flex items-center justify-between gap-2"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <FileText
                            size={10}
                            className="text-[#58A6FF] flex-shrink-0"
                          />
                          <span className="text-[11px] text-slate-400 truncate font-mono">
                            {skill.name}
                          </span>
                        </div>
                        <button
                          onClick={() => removeSkill(skill.path)}
                          className="text-slate-700 hover:text-slate-400 flex-shrink-0"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Tools">
                <div className="space-y-2">
                  {(
                    [
                      ["webSearch", "Web Search"],
                      ["codeExec", "Code Exec"],
                      ["fileRead", "File Read"],
                      ["fileWrite", "File Write"],
                      ["apiCalls", "API Calls"],
                      ["shell", "Shell"],
                    ] as [keyof NodeTools, string][]
                  ).map(([key, label]) => (
                    <Toggle
                      key={key}
                      label={label}
                      value={tools[key]}
                      onChange={() => toggleTool(key)}
                    />
                  ))}
                </div>
              </Section>

              <Section title="Behavior">
                <div className="space-y-3">
                  <Field label="Mode">
                    <Seg
                      options={["sequential", "parallel", "loop"] as RunMode[]}
                      value={behavior.mode}
                      onChange={(value) => setBehavior({ mode: value })}
                    />
                  </Field>
                  <Field label="On failure">
                    <Seg
                      options={["stop", "retry", "skip"] as OnFailure[]}
                      value={behavior.onFailure}
                      onChange={(value) => setBehavior({ onFailure: value })}
                    />
                  </Field>
                  <Field label="Retries">
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={behavior.retries}
                      onChange={(event) =>
                        setBehavior({ retries: Number(event.target.value) })
                      }
                      className="w-16 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-white/20"
                    />
                  </Field>
                  <Field label="Timeout (ms)">
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={behavior.timeoutMs}
                      onChange={(event) =>
                        setBehavior({ timeoutMs: Number(event.target.value) })
                      }
                      className="w-24 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-white/20"
                    />
                  </Field>
                </div>
              </Section>

              <Section title="Permissions">
                <div className="space-y-2">
                  {(
                    [
                      ["readFiles", "Read files"],
                      ["writeFiles", "Write files"],
                      ["network", "Network"],
                      ["shell", "Shell"],
                    ] as [keyof NodePermissions, string][]
                  ).map(([key, label]) => (
                    <Toggle
                      key={key}
                      label={label}
                      value={permissions[key]}
                      onChange={() => togglePerm(key)}
                    />
                  ))}
                </div>
              </Section>

              <Section title="Environment">
                <div className="space-y-2">
                  {envVars.map((envVar, index) => (
                    <div key={index} className="flex gap-2 items-center">
                      <input
                        value={envVar.key}
                        onChange={(event) =>
                          updateEnvVar(index, "key", event.target.value)
                        }
                        placeholder="KEY"
                        className="w-24 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                      />
                      <input
                        value={envVar.value}
                        onChange={(event) =>
                          updateEnvVar(index, "value", event.target.value)
                        }
                        placeholder="value"
                        className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                      />
                      <button
                        onClick={() => removeEnvVar(index)}
                        className="text-slate-700 hover:text-slate-400 flex-shrink-0"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addEnvVar}
                    className="flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-400 transition-colors"
                  >
                    <Plus size={12} /> Add variable
                  </button>
                </div>
              </Section>
            </div>
          </div>
        </div>

        <div className="flex justify-between px-6 py-3 border-t border-white/[0.07] flex-shrink-0">
          <button
            onClick={toggleSelected}
            className={`flex items-center gap-1.5 px-4 py-1.5 border rounded-lg text-sm transition-colors ${
              selected
                ? "border-[#58A6FF]/40 bg-[#58A6FF]/10 text-[#58A6FF] hover:bg-[#58A6FF]/15"
                : "border-white/[0.08] text-slate-200 hover:bg-white/[0.04]"
            }`}
          >
            <Zap size={13} />
            {selected ? "Selected for launch" : "Select for launch"}
          </button>
          <button
            onClick={onClose}
            className="px-5 py-1.5 bg-[#3d3dbf] hover:bg-[#4f4fcf] text-white text-sm rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-slate-600 mb-3">
        {title}
      </p>
      {children}
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className="flex items-center justify-between w-full group"
    >
      <span className="text-[12px] text-slate-500 group-hover:text-slate-300 transition-colors">
        {label}
      </span>
      <div
        className={`relative w-7 h-4 rounded-full transition-colors ${value ? "bg-[#58A6FF]" : "bg-white/10"}`}
      >
        <div
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${value ? "left-[14px]" : "left-0.5"}`}
        />
      </div>
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-slate-500 flex-shrink-0">{label}</span>
      {children}
    </div>
  );
}

function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded overflow-hidden border border-white/[0.08]">
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          className={`px-2 py-0.5 text-[11px] capitalize transition-colors ${
            value === option
              ? "bg-[#58A6FF]/20 text-[#58A6FF]"
              : "text-slate-600 hover:text-slate-400"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function ListField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <p className="text-[11px] text-slate-500 mb-1.5">{label}</p>
      <textarea
        value={value.join("\n")}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full min-h-20 bg-black/30 border border-white/[0.08] rounded px-3 py-2 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono resize-y"
      />
    </div>
  );
}

function shortModelLabel(model: string): string {
  return model.includes("/") ? model.split("/").pop() || model : model;
}

function parseMultiLineList(value: string): string[] {
  return [
    ...new Set(
      value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function statusColor(status: NodeStatus, defaultColor: string): string {
  switch (status) {
    case "running":
      return "#fbbf24";
    case "done":
      return "#4ade80";
    case "error":
      return "#f87171";
    default:
      return defaultColor;
  }
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9-_]/g, "-");
}

function getTaskFilePath(projectDir: string, nodeId: string): string {
  return `${projectDir}/ARCHITECT/tasks/${sanitizeLabel(nodeId)}.md`;
}

function getLegacyTaskFilePath(projectDir: string, label: string): string {
  return `${projectDir}/ARCHITECT/tasks/${sanitizeLabel(label)}.md`;
}

function hasUniqueLabel(
  label: string,
  nodes: Array<{ data?: { label?: string } }>,
): boolean {
  return nodes.filter((node) => node.data?.label === label).length === 1;
}

function normalizeTaskPreview(content: string | null): string | null {
  const trimmed = content?.trim();
  return trimmed ? trimmed : null;
}

function previewSnippet(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 180);
}

export default memo(ArchitectNode);
