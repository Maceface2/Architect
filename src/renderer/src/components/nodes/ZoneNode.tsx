import { memo, useState } from 'react'
import { createPortal } from 'react-dom'
import { NodeResizer, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { Play, Settings, Trash2 } from 'lucide-react'
import { getAgentRuntime, type AgentRuntime } from '../../../../shared/agentRuntimes'
import { useProjectSettings } from '../../context/ProjectSettingsContext'
import { useProjectDir } from '../../context/ProjectDirContext'
import { useInterfaceSettings } from '../../context/InterfaceSettingsContext'
import { useDocPane } from '../../context/DocPaneContext'
import { getEffectiveModel, getEffectiveRuntime } from '../../lib/canvas'
import { hexToRgba } from '../../lib/color'
import ZoneLaunchModal from './ZoneLaunchModal'
import type {
  ZoneNodeData,
  NodeSkillFile,
  NodeTools,
  NodeBehavior,
  NodePermissions,
  NodeEnvVar,
  RuntimeModelMap,
} from '../../types'

type ZoneNodeProps = NodeProps<Node<ZoneNodeData>>

function ZoneNode({ id, data, selected }: ZoneNodeProps) {
  const { setNodes, getNodes, getEdges, deleteElements } = useReactFlow()
  const [launchOpen, setLaunchOpen] = useState(false)
  const { openZone, close: closeDocPane } = useDocPane()
  const projectSettings = useProjectSettings()
  const { zoneTreatment, theme } = useInterfaceSettings()
  const projectDir = useProjectDir()
  const isArchitectural = zoneTreatment === 'architectural'
  const isTerminal = zoneTreatment === 'terminal'
  const isChromeOnly = isArchitectural || isTerminal
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
        className={`relative w-full h-full ${isChromeOnly ? 'rounded-[2px]' : 'rounded-[6px]'}`}
        style={
          isTerminal
            ? {
                // Terminal treatment: no fill, no border. The four neutral
                // L-brackets do all the work, like a TUI window frame.
                backgroundColor: 'transparent',
                border: 'none',
                boxShadow: selected ? `0 0 0 1px ${hexToRgba(zoneColor, 0.25)}, 0 0 40px ${hexToRgba(zoneColor, 0.12)}` : 'none',
                pointerEvents: 'none',
              }
            : isArchitectural
              ? {
                  backgroundColor: 'transparent',
                  border: `1px solid ${hexToRgba(zoneColor, selected ? 0.55 : 0.3)}`,
                  boxShadow: 'none',
                  pointerEvents: 'none',
                }
              : {
                  // Default zone v2: solid hairline border (no longer dashed)
                  // + tighter radius. Reads as a deliberate drawing region
                  // rather than a soft container.
                  backgroundColor: hexToRgba(zoneColor, fillAlpha),
                  border: `1px solid ${hexToRgba(zoneColor, selected ? 0.6 : 0.32)}`,
                  boxShadow: selected ? `0 0 0 1px ${hexToRgba(zoneColor, 0.25)}, 0 0 40px ${hexToRgba(zoneColor, 0.15)}` : 'none',
                  pointerEvents: 'none',
                }
        }
      >
        {isArchitectural && <CornerTicks color={zoneColor} tick={12} thick={1.5} inset={6} />}
        {isTerminal && (
          <CornerTicks color="rgb(var(--fg-muted))" tick={22} thick={2} inset={10} />
        )}
        {/* Floating header: a fitted chip inset from the zone's top-left
            corner, detached from edges and connected to nothing. Reads as
            a label tag floating inside the zone rather than a flush header
            strip. Default treatment gets its own tinted surface; the chrome-
            only treatments (architectural / terminal) carry the same float
            geometry but stay transparent so they read as raw annotations. */}
        <div
          className={`absolute flex items-center justify-between gap-2 whitespace-nowrap rounded-md ${isChromeOnly ? '' : 'border'} px-2.5 py-1`}
          style={{
            top: 12,
            left: 12,
            right: 12,
            pointerEvents: 'auto',
            backgroundColor: isChromeOnly ? 'transparent' : hexToRgba(zoneColor, headerAlpha),
            borderColor: isChromeOnly ? 'transparent' : hexToRgba(zoneColor, headerBorderAlpha),
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`truncate ${
                isTerminal
                  ? 'text-[12px] font-medium text-fg-muted'
                  : isArchitectural
                    ? 'text-[11px] font-medium uppercase tracking-[0.22em]'
                    : `text-[12px] font-semibold uppercase tracking-[0.12em] ${labelTextClass}`
              }`}
              style={isArchitectural ? { color: zoneColor } : undefined}
            >
              {isTerminal ? `[ ${label} ]` : isArchitectural ? `/ ${label}` : label}
            </span>
            <span
              className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider flex-shrink-0"
              style={{ color: runtimeMeta.accentColor, backgroundColor: `${runtimeMeta.accentColor}20` }}
            >
              {isOverride ? runtimeMeta.shortLabel : `default:${runtimeMeta.shortLabel}`}
            </span>
            {runtimeMeta.supportsModelSelection && effectiveModel && (
              <span className={`text-[10px] font-mono truncate ${subtleTextClass}`}>{shortModelLabel(effectiveModel)}</span>
            )}
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
              onClick={(e) => {
                e.stopPropagation()
                openZone(id)
              }}
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
                closeDocPane()
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

    </>
  )
}

function shortModelLabel(model: string): string {
  if (!model) return ''
  return model.includes('/') ? model.split('/').pop() || model : model
}

// L-bracket corner marks. Used by both architectural (12px / 1.5px / zone
// color) and terminal (22px / 2px / neutral fg-muted) treatments — geometry
// is identical, scale and color differ.
function CornerTicks({
  color,
  tick = 12,
  thick = 1.5,
  inset = 6,
}: {
  color: string
  tick?: number
  thick?: number
  inset?: number
}) {
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

export default memo(ZoneNode)
