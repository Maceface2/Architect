import { memo, useState } from 'react'
import { createPortal } from 'react-dom'
import { NodeResizer, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { Play, Settings, Trash2 } from 'lucide-react'
import { getAgentRuntime, type AgentRuntime } from '../../../../shared/agentRuntimes'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import { useProjectDir } from '../../context/ProjectDirContext'
import { useInterfaceSettings } from '../../context/InterfaceSettingsContext'
import { getEffectiveModel, getEffectiveRuntime } from '../../lib/canvas'
import AgentConfigModal from './AgentConfigModal'
import ZoneLaunchModal from './ZoneLaunchModal'
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
  const { setNodes, getNodes, getEdges, deleteElements } = useReactFlow()
  const [modalOpen, setModalOpen] = useState(false)
  const [launchOpen, setLaunchOpen] = useState(false)
  const projectSettings = useProjectSettings()
  const { zoneTreatment, theme } = useInterfaceSettings()
  const projectDir = useProjectDir()
  const isArchitectural = zoneTreatment === 'architectural'
  const isLight = theme === 'light'
  // In light mode the canvas is near-white. The default treatment's colored
  // tint overlays canvas, so we need higher alpha to keep the zone visible
  // and a darker text so labels stay readable on the lighter fill.
  const fillAlpha = isLight ? 0.18 : 0.08
  const headerAlpha = isLight ? 0.32 : 0.18
  const headerBorderAlpha = isLight ? 0.45 : 0.25
  const labelTextClass = isLight ? 'text-slate-900' : 'text-white'
  const subtleTextClass = isLight ? 'text-slate-700' : 'text-slate-400'
  const buttonIdleClass = isLight ? 'text-slate-700 hover:text-slate-900 hover:bg-black/10' : 'text-slate-400 hover:text-white hover:bg-white/10'

  const zoneColor = (data.color as string) ?? '#58A6FF'
  const label = (data.label as string) ?? 'Zone'
  const systemPrompt = (data.systemPrompt ?? '') as string
  const status = (data.status ?? 'idle') as NodeStatus
  const configuredRuntime = (data.agentRuntime ?? projectSettings.dispatchRuntime) as AgentRuntime
  const providerModels = (data.providerModels ?? {}) as RuntimeModelMap
  const effectiveRuntime = getEffectiveRuntime({ agentRuntime: configuredRuntime }, projectSettings)
  const effectiveModel = getEffectiveModel(
    { providerModels, agentRuntime: configuredRuntime },
    projectSettings
  )
  const isOverride = configuredRuntime !== projectSettings.dispatchRuntime
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
        className={`relative w-full h-full ${isArchitectural ? 'rounded-[2px]' : 'rounded-2xl'}`}
        style={
          isArchitectural
            ? {
                backgroundColor: 'transparent',
                border: `1px solid ${hexToRgba(zoneColor, selected ? 0.55 : 0.3)}`,
                boxShadow: 'none',
              }
            : {
                backgroundColor: hexToRgba(zoneColor, fillAlpha),
                border: `1.5px ${selected ? 'solid' : 'dashed'} ${hexToRgba(zoneColor, selected ? 0.6 : 0.35)}`,
                boxShadow: selected ? `0 0 0 1px ${hexToRgba(zoneColor, 0.25)}, 0 0 40px ${hexToRgba(zoneColor, 0.15)}` : 'none',
              }
        }
      >
        {isArchitectural && <CornerTicks color={zoneColor} />}
        {/* Header strip — shows zone metadata, draggable; gear icon opens modal */}
        <div
          className={`absolute left-0 right-0 top-0 flex items-center justify-between gap-2 px-3 py-2 ${isArchitectural ? '' : 'rounded-t-2xl'}`}
          style={
            isArchitectural
              ? { backgroundColor: 'transparent', borderBottom: 'none' }
              : {
                  backgroundColor: hexToRgba(zoneColor, headerAlpha),
                  borderBottom: `1px solid ${hexToRgba(zoneColor, headerBorderAlpha)}`,
                }
          }
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: statusColor(status, zoneColor) }}
            />
            <span
              className={`truncate ${isArchitectural ? 'text-[11px] font-medium uppercase tracking-[0.18em]' : `text-[13px] font-semibold ${labelTextClass}`}`}
              style={isArchitectural ? { color: zoneColor } : undefined}
            >
              {label}
            </span>
            <span
              className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider flex-shrink-0"
              style={{ color: runtimeMeta.accentColor, backgroundColor: `${runtimeMeta.accentColor}20` }}
            >
              {isOverride ? runtimeMeta.shortLabel : `default:${runtimeMeta.shortLabel}`}
            </span>
            <span className={`text-[10px] font-mono truncate ${subtleTextClass}`}>{shortModelLabel(effectiveModel)}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (!projectDir) return
                setLaunchOpen(true)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`w-5 h-5 flex items-center justify-center rounded transition-colors nodrag ${buttonIdleClass}`}
              title="Launch this zone"
              aria-label="Launch this zone"
            >
              <Play size={12} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setModalOpen(true) }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`w-5 h-5 flex items-center justify-center rounded transition-colors nodrag ${buttonIdleClass}`}
              title="Configure zone agent"
              aria-label="Configure zone agent"
            >
              <Settings size={12} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(`Delete zone "${label}"? This removes the node and its connections.`)) {
                  deleteElements({ nodes: [{ id }] })
                }
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="w-5 h-5 flex items-center justify-center rounded text-fg-subtle hover:text-red-300 hover:bg-red-500/15 transition-colors nodrag"
              title="Delete zone"
              aria-label="Delete zone"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      </div>

      {launchOpen && projectDir && createPortal(
        <ZoneLaunchModal
          zoneId={id}
          zoneLabel={label}
          zoneColor={zoneColor}
          effectiveRuntime={effectiveRuntime}
          nodes={getNodes()}
          edges={getEdges()}
          onClose={() => setLaunchOpen(false)}
          onLaunched={() => { /* terminal panel picks up spawn event */ }}
        />,
        document.body
      )}

      {modalOpen && createPortal(
        <AgentConfigModal
          zoneColor={zoneColor}
          zoneId={id}
          label={label}
          systemPrompt={systemPrompt}
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

// Architectural treatment: 12px L-shaped marks at every corner, inset 6px,
// drawn from two perpendicular 1.5px spans in the zone color.
function CornerTicks({ color }: { color: string }) {
  const tick = 12
  const thick = 1.5
  const inset = 6
  return (
    <>
      {/* top-left */}
      <span style={{ position: 'absolute', left: inset, top: inset, width: tick, height: thick, backgroundColor: color, pointerEvents: 'none' }} />
      <span style={{ position: 'absolute', left: inset, top: inset, width: thick, height: tick, backgroundColor: color, pointerEvents: 'none' }} />
      {/* top-right */}
      <span style={{ position: 'absolute', right: inset, top: inset, width: tick, height: thick, backgroundColor: color, pointerEvents: 'none' }} />
      <span style={{ position: 'absolute', right: inset, top: inset, width: thick, height: tick, backgroundColor: color, pointerEvents: 'none' }} />
      {/* bottom-left */}
      <span style={{ position: 'absolute', left: inset, bottom: inset, width: tick, height: thick, backgroundColor: color, pointerEvents: 'none' }} />
      <span style={{ position: 'absolute', left: inset, bottom: inset, width: thick, height: tick, backgroundColor: color, pointerEvents: 'none' }} />
      {/* bottom-right */}
      <span style={{ position: 'absolute', right: inset, bottom: inset, width: tick, height: thick, backgroundColor: color, pointerEvents: 'none' }} />
      <span style={{ position: 'absolute', right: inset, bottom: inset, width: thick, height: tick, backgroundColor: color, pointerEvents: 'none' }} />
    </>
  )
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
