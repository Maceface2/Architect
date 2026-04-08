import { memo, useState, useRef } from 'react'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { ChevronDown, ChevronUp, Plus, X, FileText } from 'lucide-react'
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
} from '../../types'

type ArchitectNodeProps = NodeProps<Node<ArchitectNodeData>>

const SECTIONS = ['prompt', 'skills', 'tools', 'behavior', 'permissions', 'environment'] as const
type Section = typeof SECTIONS[number]

const SECTION_LABELS: Record<Section, string> = {
  prompt:      'Agent prompt',
  skills:      'Skills',
  tools:       'Tools',
  behavior:    'Behavior',
  permissions: 'Permissions',
  environment: 'Environment',
}

// Built-in skill presets — like Claude Code skill markdown files
const BUILTIN_SKILLS: Omit<NodeSkillFile, 'id'>[] = [
  { name: 'researcher.md',     path: 'builtin:researcher',     builtin: true },
  { name: 'planner.md',        path: 'builtin:planner',        builtin: true },
  { name: 'code-reviewer.md',  path: 'builtin:code-reviewer',  builtin: true },
  { name: 'debugger.md',       path: 'builtin:debugger',       builtin: true },
  { name: 'writer.md',         path: 'builtin:writer',         builtin: true },
  { name: 'analyst.md',        path: 'builtin:analyst',        builtin: true },
]

function ArchitectNode({ id, data }: ArchitectNodeProps) {
  const { setNodes } = useReactFlow()
  const [customSkillInput, setCustomSkillInput] = useState('')
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const labelInputRef = useRef<HTMLInputElement>(null)

  const nodeColor   = data.color as string
  const tag         = data.tag as string
  const label       = data.label as string
  const prompt      = (data.prompt ?? '') as string
  const status      = data.status as NodeStatus
  const openSections = (data.openSections ?? []) as string[]
  const skills      = (data.skills ?? []) as NodeSkillFile[]
  const tools       = (data.tools ?? { webSearch: false, codeExec: false, fileRead: false, fileWrite: false, apiCalls: false, shell: false }) as NodeTools
  const behavior    = (data.behavior ?? { mode: 'sequential', retries: 0, onFailure: 'stop', timeoutMs: 30000 }) as NodeBehavior
  const permissions = (data.permissions ?? { readFiles: false, writeFiles: false, network: false, shell: false }) as NodePermissions
  const envVars     = (data.envVars ?? []) as NodeEnvVar[]

  const patch = (partial: Partial<ArchitectNodeData>) =>
    setNodes(nodes =>
      nodes.map(n =>
        n.id === id ? { ...n, data: { ...(n.data as ArchitectNodeData), ...partial } } : n
      )
    )

  const toggleSection = (section: Section) => {
    const next = openSections.includes(section)
      ? openSections.filter(s => s !== section)
      : [...openSections, section]
    patch({ openSections: next })
  }

  const isOpen = (s: Section) => openSections.includes(s)

  // ── Skills ──────────────────────────────────────────────────────────────
  const hasSkill = (path: string) => skills.some(s => s.path === path)

  const toggleBuiltinSkill = (preset: Omit<NodeSkillFile, 'id'>) => {
    if (hasSkill(preset.path)) {
      patch({ skills: skills.filter(s => s.path !== preset.path) })
    } else {
      patch({ skills: [...skills, { ...preset, id: preset.path }] })
    }
  }

  const addCustomSkill = () => {
    const raw = customSkillInput.trim()
    if (!raw) return
    const name = raw.endsWith('.md') ? raw : `${raw}.md`
    const path = `custom:${name}`
    if (!hasSkill(path)) {
      patch({ skills: [...skills, { id: path, name, path, builtin: false }] })
    }
    setCustomSkillInput('')
  }

  const removeSkill = (path: string) => patch({ skills: skills.filter(s => s.path !== path) })

  // ── Tools ────────────────────────────────────────────────────────────────
  const toggleTool = (key: keyof NodeTools) =>
    patch({ tools: { ...tools, [key]: !tools[key] } })

  // ── Behavior ─────────────────────────────────────────────────────────────
  const setBehavior = (partial: Partial<NodeBehavior>) =>
    patch({ behavior: { ...behavior, ...partial } })

  // ── Permissions ──────────────────────────────────────────────────────────
  const togglePerm = (key: keyof NodePermissions) =>
    patch({ permissions: { ...permissions, [key]: !permissions[key] } })

  // ── Env vars ─────────────────────────────────────────────────────────────
  const addEnvVar = () => patch({ envVars: [...envVars, { key: '', value: '' }] })
  const removeEnvVar = (i: number) => patch({ envVars: envVars.filter((_, idx) => idx !== i) })
  const updateEnvVar = (i: number, field: keyof NodeEnvVar, val: string) =>
    patch({ envVars: envVars.map((ev, idx) => idx === i ? { ...ev, [field]: val } : ev) })

  return (
    <div className="relative">
      <Handle
        type="target"
        position={Position.Left}
        style={{ width: 11, height: 11, background: '#1e1e1e', border: `2px solid ${nodeColor}`, left: -6, zIndex: 10 }}
      />

      <div className="relative bg-[#1e1e1e] rounded-xl overflow-hidden min-w-[220px] max-w-[260px] border border-white/[0.06] shadow-2xl">
        {/* Color accent strip */}
        <div className="absolute left-0 top-0 bottom-0 w-[5px]" style={{ backgroundColor: nodeColor }} />

        {/* Header */}
        <div className="pl-[18px] pr-3.5 pt-3 pb-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold tracking-widest" style={{ color: nodeColor }}>{tag}</span>
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: statusColor(status, nodeColor) }} />
          </div>
          {editingLabel ? (
            <input
              ref={labelInputRef}
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              onBlur={() => { patch({ label: labelDraft.trim() || label }); setEditingLabel(false) }}
              onKeyDown={e => {
                if (e.key === 'Enter') { patch({ label: labelDraft.trim() || label }); setEditingLabel(false) }
                if (e.key === 'Escape') setEditingLabel(false)
              }}
              className="text-[15px] font-semibold text-white leading-snug bg-transparent border-b border-white/30 focus:outline-none focus:border-white/60 w-full"
            />
          ) : (
            <p
              className="text-[15px] font-semibold text-white leading-snug cursor-text"
              onDoubleClick={() => { setLabelDraft(label); setEditingLabel(true); setTimeout(() => labelInputRef.current?.select(), 0) }}
              title="Double-click to rename"
            >{label}</p>
          )}
        </div>

        {/* Sections */}
        {SECTIONS.map(section => (
          <div key={section} className="border-t border-white/[0.05]">
            <button
              onClick={() => toggleSection(section)}
              className="flex items-center justify-between w-full pl-[18px] pr-3.5 py-1.5 text-[11px] text-slate-600 hover:text-slate-400 hover:bg-white/[0.03] transition-colors"
            >
              <span>{SECTION_LABELS[section]}</span>
              {isOpen(section) ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </button>

            {isOpen(section) && (
              <div className="pl-[18px] pr-3.5 pb-3 space-y-2">

                {/* ── Agent Prompt ── */}
                {section === 'prompt' && (
                  <textarea
                    value={prompt}
                    onChange={e => patch({ prompt: e.target.value })}
                    placeholder="Describe what this component should do..."
                    className="w-full bg-black/30 border border-white/[0.08] rounded-lg text-xs text-slate-300 placeholder-slate-700 p-2.5 resize-none focus:outline-none focus:border-white/20 min-h-[72px] leading-relaxed"
                    rows={3}
                  />
                )}

                {/* ── Skills (markdown files pre-injected as context) ── */}
                {section === 'skills' && (
                  <div className="space-y-2">
                    {/* Preset library */}
                    <p className="text-[10px] text-slate-700 uppercase tracking-wider">Presets</p>
                    <div className="flex flex-wrap gap-1">
                      {BUILTIN_SKILLS.map(preset => {
                        const active = hasSkill(preset.path)
                        return (
                          <button
                            key={preset.path}
                            onClick={() => toggleBuiltinSkill(preset)}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border transition-colors ${
                              active
                                ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-[#58A6FF]'
                                : 'border-white/[0.08] text-slate-600 hover:text-slate-400 hover:border-white/20'
                            }`}
                          >
                            <FileText size={9} />
                            {preset.name}
                          </button>
                        )
                      })}
                    </div>

                    {/* Custom skill file path */}
                    <p className="text-[10px] text-slate-700 uppercase tracking-wider pt-1">Custom</p>
                    <div className="flex gap-1">
                      <input
                        value={customSkillInput}
                        onChange={e => setCustomSkillInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && addCustomSkill()}
                        placeholder="path/to/skill.md"
                        className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-2 py-0.5 text-[10px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                      />
                      <button
                        onClick={addCustomSkill}
                        className="text-slate-600 hover:text-slate-300 transition-colors"
                      >
                        <Plus size={12} />
                      </button>
                    </div>

                    {/* Attached skill files */}
                    {skills.length > 0 && (
                      <div className="space-y-1 pt-0.5">
                        {skills.map(skill => (
                          <div key={skill.path} className="flex items-center justify-between gap-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <FileText size={9} className="text-[#58A6FF] flex-shrink-0" />
                              <span className="text-[10px] text-slate-400 truncate font-mono">{skill.name}</span>
                            </div>
                            <button onClick={() => removeSkill(skill.path)} className="text-slate-700 hover:text-slate-400 flex-shrink-0">
                              <X size={9} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Tools (runtime capabilities) ── */}
                {section === 'tools' && (
                  <div className="space-y-1.5">
                    {([
                      ['webSearch', 'Web Search'],
                      ['codeExec',  'Code Exec'],
                      ['fileRead',  'File Read'],
                      ['fileWrite', 'File Write'],
                      ['apiCalls',  'API Calls'],
                      ['shell',     'Shell'],
                    ] as [keyof NodeTools, string][]).map(([key, lbl]) => (
                      <Toggle key={key} label={lbl} value={tools[key]} onChange={() => toggleTool(key)} />
                    ))}
                  </div>
                )}

                {/* ── Behavior ── */}
                {section === 'behavior' && (
                  <div className="space-y-2">
                    <Field label="Mode">
                      <Seg
                        options={['sequential', 'parallel', 'loop'] as RunMode[]}
                        value={behavior.mode}
                        onChange={v => setBehavior({ mode: v })}
                      />
                    </Field>
                    <Field label="On failure">
                      <Seg
                        options={['stop', 'retry', 'skip'] as OnFailure[]}
                        value={behavior.onFailure}
                        onChange={v => setBehavior({ onFailure: v })}
                      />
                    </Field>
                    <Field label="Retries">
                      <input
                        type="number" min={0} max={10}
                        value={behavior.retries}
                        onChange={e => setBehavior({ retries: Number(e.target.value) })}
                        className="w-16 bg-black/30 border border-white/[0.08] rounded px-2 py-0.5 text-xs text-slate-300 focus:outline-none focus:border-white/20"
                      />
                    </Field>
                    <Field label="Timeout (ms)">
                      <input
                        type="number" min={0} step={1000}
                        value={behavior.timeoutMs}
                        onChange={e => setBehavior({ timeoutMs: Number(e.target.value) })}
                        className="w-24 bg-black/30 border border-white/[0.08] rounded px-2 py-0.5 text-xs text-slate-300 focus:outline-none focus:border-white/20"
                      />
                    </Field>
                  </div>
                )}

                {/* ── Permissions ── */}
                {section === 'permissions' && (
                  <div className="space-y-1.5">
                    {([
                      ['readFiles',  'Read files'],
                      ['writeFiles', 'Write files'],
                      ['network',    'Network'],
                      ['shell',      'Shell'],
                    ] as [keyof NodePermissions, string][]).map(([key, lbl]) => (
                      <Toggle key={key} label={lbl} value={permissions[key]} onChange={() => togglePerm(key)} />
                    ))}
                  </div>
                )}

                {/* ── Environment ── */}
                {section === 'environment' && (
                  <div className="space-y-1.5">
                    {envVars.map((ev, i) => (
                      <div key={i} className="flex gap-1 items-center">
                        <input
                          value={ev.key}
                          onChange={e => updateEnvVar(i, 'key', e.target.value)}
                          placeholder="KEY"
                          className="w-[68px] bg-black/30 border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                        />
                        <input
                          value={ev.value}
                          onChange={e => updateEnvVar(i, 'value', e.target.value)}
                          placeholder="value"
                          className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                        />
                        <button onClick={() => removeEnvVar(i)} className="text-slate-700 hover:text-slate-400 flex-shrink-0">
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={addEnvVar}
                      className="flex items-center gap-1 text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
                    >
                      <Plus size={10} /> Add variable
                    </button>
                  </div>
                )}

              </div>
            )}
          </div>
        ))}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{ width: 11, height: 11, background: '#1e1e1e', border: `2px solid ${nodeColor}`, right: -6, zIndex: 10 }}
      />
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="flex items-center justify-between w-full group">
      <span className="text-[11px] text-slate-500 group-hover:text-slate-400 transition-colors">{label}</span>
      <div className={`relative w-7 h-4 rounded-full transition-colors ${value ? 'bg-[#58A6FF]' : 'bg-white/10'}`}>
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${value ? 'left-[14px]' : 'left-0.5'}`} />
      </div>
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-slate-500 flex-shrink-0">{label}</span>
      {children}
    </div>
  )
}

function Seg<T extends string>({ options, value, onChange }: { options: T[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded overflow-hidden border border-white/[0.08]">
      {options.map(opt => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-1.5 py-0.5 text-[10px] capitalize transition-colors ${
            value === opt ? 'bg-[#58A6FF]/20 text-[#58A6FF]' : 'text-slate-600 hover:text-slate-400'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

function statusColor(status: NodeStatus, defaultColor: string): string {
  switch (status) {
    case 'running': return '#fbbf24'
    case 'done':    return '#4ade80'
    case 'error':   return '#f87171'
    default:        return defaultColor
  }
}

export default memo(ArchitectNode)
