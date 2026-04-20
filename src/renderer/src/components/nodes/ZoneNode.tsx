import { memo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, NodeResizer, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { Play, Settings } from 'lucide-react'
import { getAgentRuntime, type AgentRuntime, type AgentRuntimeMode } from '../../../../shared/agentRuntimes'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import { useProjectDir } from '../../context/ProjectDirContext'
import { getEffectiveModel, getEffectiveRuntime } from '../../lib/canvas'
import AgentConfigModal from './AgentConfigModal'
import type {
  ZoneNodeData,
  NodeStatus,
  NodeSkillFile,
  NodeTools,
  NodeBehavior,
  NodePermissions,
  NodeEnvVar,
  RuntimeModelMap,
} from '../../types'

type ZoneNodeProps = NodeProps<Node<ZoneNodeData>>

function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '')
  const full = cleaned.length === 3
    ? cleaned.split('').map(c => c + c).join('')
    : cleaned
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function ZoneNode({ id, data, selected }: ZoneNodeProps) {
  const { setNodes, getNodes, getEdges } = useReactFlow()
  const [modalOpen, setModalOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const projectSettings = useProjectSettings()
  const projectDir = useProjectDir()

  const zoneColor = (data.color as string) ?? '#58A6FF'
  const label = (data.label as string) ?? 'Zone'
  const systemPrompt = (data.systemPrompt ?? '') as string
  const status = (data.status ?? 'idle') as NodeStatus
  const runtimeMode = (data.agentRuntimeMode ?? 'inherit') as AgentRuntimeMode
  const configuredRuntime = (data.agentRuntime ?? projectSettings.defaultRuntime) as AgentRuntime
  const providerModels = (data.providerModels ?? {}) as RuntimeModelMap
  const effectiveRuntime = getEffectiveRuntime(
    { agentRuntimeMode: runtimeMode, agentRuntime: configuredRuntime },
    projectSettings
  )
  const effectiveModel = getEffectiveModel(
    { providerModels, agentRuntimeMode: runtimeMode, agentRuntime: configuredRuntime },
    projectSettings
  )
  const skills = (data.skills ?? []) as NodeSkillFile[]
  const tools = (data.tools ?? { webSearch: false, codeExec: false, fileRead: false, fileWrite: false, apiCalls: false, shell: false }) as NodeTools
  const behavior = (data.behavior ?? { mode: 'sequential', retries: 0, onFailure: 'stop', timeoutMs: 30000 }) as NodeBehavior
  const permissions = (data.permissions ?? { readFiles: false, writeFiles: false, network: false, shell: false }) as NodePermissions
  const envVars = (data.envVars ?? []) as NodeEnvVar[]
  const runtimeMeta = getAgentRuntime(effectiveRuntime)

  const patch = (partial: Partial<ZoneNodeData>) =>
    setNodes(nodes =>
      nodes.map(node =>
        node.id === id ? { ...node, data: { ...(node.data as ZoneNodeData), ...partial } } : node
      )
    )

  return (
    <>
      <NodeResizer
        color={zoneColor}
        isVisible={selected}
        minWidth={240}
        minHeight={160}
        lineStyle={{ borderColor: zoneColor, opacity: 0.4 }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2, backgroundColor: zoneColor, borderColor: zoneColor }}
      />

      <div
        className="relative w-full h-full rounded-2xl"
        style={{
          backgroundColor: hexToRgba(zoneColor, 0.08),
          border: `1.5px ${selected ? 'solid' : 'dashed'} ${hexToRgba(zoneColor, selected ? 0.6 : 0.35)}`,
          boxShadow: selected ? `0 0 0 1px ${hexToRgba(zoneColor, 0.25)}, 0 0 40px ${hexToRgba(zoneColor, 0.15)}` : 'none',
        }}
      >
        {/* Header strip — shows zone metadata, draggable; gear icon opens modal */}
        <div
          className="absolute left-0 right-0 top-0 flex items-center justify-between gap-2 px-3 py-2 rounded-t-2xl"
          style={{
            backgroundColor: hexToRgba(zoneColor, 0.18),
            borderBottom: `1px solid ${hexToRgba(zoneColor, 0.25)}`,
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: statusColor(status, zoneColor) }}
            />
            <span className="text-[13px] font-semibold text-white truncate">{label}</span>
            <span
              className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider flex-shrink-0"
              style={{ color: runtimeMeta.accentColor, backgroundColor: `${runtimeMeta.accentColor}20` }}
            >
              {runtimeMode === 'inherit' ? `default:${runtimeMeta.shortLabel}` : runtimeMeta.shortLabel}
            </span>
            <span className="text-[10px] text-slate-500 font-mono truncate">{shortModelLabel(effectiveModel)}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {systemPrompt && <span className="text-[10px] text-slate-500 italic truncate max-w-[200px]">{systemPrompt}</span>}
            <button
              onClick={async (e) => {
                e.stopPropagation()
                if (!projectDir || running) return
                setRunning(true)
                try {
                  await window.electron.zone.run({
                    projectDir,
                    zoneId: id,
                    nodes: getNodes(),
                    edges: getEdges(),
                    userPrompt: '',
                    settings: projectSettings,
                  })
                } finally {
                  setRunning(false)
                }
              }}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={running}
              className="w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:text-white hover:bg-white/10 transition-colors nodrag disabled:opacity-50"
              title="Resume this zone"
              aria-label="Resume this zone"
            >
              <Play size={12} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setModalOpen(true) }}
              onMouseDown={(e) => e.stopPropagation()}
              className="w-5 h-5 flex items-center justify-center rounded text-slate-500 hover:text-white hover:bg-white/10 transition-colors nodrag"
              title="Configure zone agent"
              aria-label="Configure zone agent"
            >
              <Settings size={12} />
            </button>
          </div>
        </div>
      </div>

      <Handle
        type="target"
        position={Position.Left}
        style={{ width: 12, height: 12, background: '#1e1e1e', border: `2px solid ${zoneColor}`, left: -7, zIndex: 20 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ width: 12, height: 12, background: '#1e1e1e', border: `2px solid ${zoneColor}`, right: -7, zIndex: 20 }}
      />

      {modalOpen && createPortal(
        <AgentConfigModal
          zoneColor={zoneColor}
          zoneId={id}
          label={label}
          systemPrompt={systemPrompt}
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
        document.body
      )}
    </>
  )
}

function shortModelLabel(model: string): string {
  return model.includes('/') ? model.split('/').pop() || model : model
}

function statusColor(status: NodeStatus, defaultColor: string): string {
  switch (status) {
    case 'running': return '#fbbf24'
    case 'done': return '#4ade80'
    case 'error': return '#f87171'
    default: return defaultColor
  }
}

export default memo(ZoneNode)
