import { memo, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react'
import { Plus, X, FileText } from 'lucide-react'
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

// Built-in skill presets
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
  const [modalOpen, setModalOpen] = useState(false)

  const nodeColor   = data.color as string
  const tag         = data.tag as string
  const label       = data.label as string
  const prompt      = (data.prompt ?? '') as string
  const status      = data.status as NodeStatus
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

  return (
    <div className="relative">
      <Handle
        type="target"
        position={Position.Left}
        style={{ width: 11, height: 11, background: '#1e1e1e', border: `2px solid ${nodeColor}`, left: -6, zIndex: 10 }}
      />

      {/* Compact card — click to open full config */}
      <div
        className="relative bg-[#1e1e1e] rounded-xl overflow-hidden min-w-[200px] max-w-[240px] border border-white/[0.06] shadow-2xl cursor-pointer hover:border-white/20 transition-colors select-none"
        onClick={() => setModalOpen(true)}
      >
        <div className="absolute left-0 top-0 bottom-0 w-[5px]" style={{ backgroundColor: nodeColor }} />
        <div className="pl-[18px] pr-3.5 pt-3 pb-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold tracking-widest" style={{ color: nodeColor }}>{tag}</span>
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: statusColor(status, nodeColor) }} />
          </div>
          <p className="text-[15px] font-semibold text-white leading-snug">{label}</p>
          {prompt && (
            <p className="text-[10px] text-slate-500 mt-1.5 leading-relaxed line-clamp-2">{prompt}</p>
          )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{ width: 11, height: 11, background: '#1e1e1e', border: `2px solid ${nodeColor}`, right: -6, zIndex: 10 }}
      />

      {modalOpen && createPortal(
        <NodeConfigModal
          nodeColor={nodeColor}
          tag={tag}
          label={label}
          prompt={prompt}
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
    </div>
  )
}

// ── Full-screen config modal ────────────────────────────────────────────────

interface ModalProps {
  nodeColor: string
  tag: string
  label: string
  prompt: string
  skills: NodeSkillFile[]
  tools: NodeTools
  behavior: NodeBehavior
  permissions: NodePermissions
  envVars: NodeEnvVar[]
  patch: (partial: Partial<ArchitectNodeData>) => void
  onClose: () => void
}

function NodeConfigModal({
  nodeColor, tag, label, prompt, skills, tools, behavior, permissions, envVars, patch, onClose
}: ModalProps) {
  const [labelDraft, setLabelDraft] = useState(label)
  const [customSkillInput, setCustomSkillInput] = useState('')
  const labelInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ── Skills ──────────────────────────────────────────────────────────────
  const hasSkill = (path: string) => skills.some(s => s.path === path)
  const toggleBuiltinSkill = (preset: Omit<NodeSkillFile, 'id'>) => {
    if (hasSkill(preset.path)) patch({ skills: skills.filter(s => s.path !== preset.path) })
    else patch({ skills: [...skills, { ...preset, id: preset.path }] })
  }
  const addCustomSkill = () => {
    const raw = customSkillInput.trim()
    if (!raw) return
    const name = raw.endsWith('.md') ? raw : `${raw}.md`
    const path = `custom:${name}`
    if (!hasSkill(path)) patch({ skills: [...skills, { id: path, name, path, builtin: false }] })
    setCustomSkillInput('')
  }
  const removeSkill = (path: string) => patch({ skills: skills.filter(s => s.path !== path) })

  // ── Tools ────────────────────────────────────────────────────────────────
  const toggleTool = (key: keyof NodeTools) => patch({ tools: { ...tools, [key]: !tools[key] } })

  // ── Behavior ─────────────────────────────────────────────────────────────
  const setBehavior = (partial: Partial<NodeBehavior>) => patch({ behavior: { ...behavior, ...partial } })

  // ── Permissions ──────────────────────────────────────────────────────────
  const togglePerm = (key: keyof NodePermissions) => patch({ permissions: { ...permissions, [key]: !permissions[key] } })

  // ── Env vars ─────────────────────────────────────────────────────────────
  const addEnvVar = () => patch({ envVars: [...envVars, { key: '', value: '' }] })
  const removeEnvVar = (i: number) => patch({ envVars: envVars.filter((_, idx) => idx !== i) })
  const updateEnvVar = (i: number, field: keyof NodeEnvVar, val: string) =>
    patch({ envVars: envVars.map((ev, idx) => idx === i ? { ...ev, [field]: val } : ev) })

  const saveLabel = () => {
    const trimmed = labelDraft.trim()
    if (trimmed && trimmed !== label) patch({ label: trimmed })
  }

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-[#161616] rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '90vw', height: '85vh', maxWidth: 1100 }}
      >
        {/* ── Modal header ── */}
        <div className="flex items-center gap-4 px-6 py-4 border-b border-white/[0.07] flex-shrink-0" style={{ borderLeftColor: nodeColor, borderLeftWidth: 4 }}>
          <span className="text-[11px] font-bold tracking-widest flex-shrink-0" style={{ color: nodeColor }}>{tag}</span>
          <input
            ref={labelInputRef}
            value={labelDraft}
            onChange={e => setLabelDraft(e.target.value)}
            onBlur={saveLabel}
            onKeyDown={e => { if (e.key === 'Enter') { saveLabel(); labelInputRef.current?.blur() } }}
            className="text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-white/20 focus:border-white/40 focus:outline-none transition-colors flex-1 min-w-0"
            placeholder="Agent name"
          />
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors flex-shrink-0 p-1">
            <X size={18} />
          </button>
        </div>

        {/* ── Body: two columns ── */}
        <div className="flex flex-1 min-h-0 divide-x divide-white/[0.06]">

          {/* Left: Prompt */}
          <div className="flex flex-col flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-slate-600 px-6 pt-5 pb-2 flex-shrink-0">Agent prompt</p>
            <textarea
              value={prompt}
              onChange={e => patch({ prompt: e.target.value })}
              placeholder="Describe what this agent should do — its role, goals, constraints, and any specific instructions..."
              autoFocus
              className="flex-1 bg-transparent text-slate-200 text-sm leading-relaxed px-6 pb-6 resize-none focus:outline-none placeholder-slate-700 font-mono"
            />
          </div>

          {/* Right: all other config, scrollable */}
          <div className="w-[340px] flex-shrink-0 overflow-y-auto">
            <div className="p-6 space-y-6">

              {/* Skills */}
              <Section title="Skills">
                <p className="text-[10px] text-slate-700 uppercase tracking-wider mb-2">Presets</p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {BUILTIN_SKILLS.map(preset => {
                    const active = hasSkill(preset.path)
                    return (
                      <button
                        key={preset.path}
                        onClick={() => toggleBuiltinSkill(preset)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] border transition-colors ${
                          active
                            ? 'border-[#58A6FF]/50 bg-[#58A6FF]/10 text-[#58A6FF]'
                            : 'border-white/[0.08] text-slate-500 hover:text-slate-300 hover:border-white/20'
                        }`}
                      >
                        <FileText size={10} />
                        {preset.name}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[10px] text-slate-700 uppercase tracking-wider mb-2">Custom</p>
                <div className="flex gap-2 mb-2">
                  <input
                    value={customSkillInput}
                    onChange={e => setCustomSkillInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addCustomSkill()}
                    placeholder="path/to/skill.md"
                    className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                  />
                  <button onClick={addCustomSkill} className="text-slate-500 hover:text-slate-200 transition-colors">
                    <Plus size={14} />
                  </button>
                </div>
                {skills.length > 0 && (
                  <div className="space-y-1">
                    {skills.map(skill => (
                      <div key={skill.path} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <FileText size={10} className="text-[#58A6FF] flex-shrink-0" />
                          <span className="text-[11px] text-slate-400 truncate font-mono">{skill.name}</span>
                        </div>
                        <button onClick={() => removeSkill(skill.path)} className="text-slate-700 hover:text-slate-400 flex-shrink-0">
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* Tools */}
              <Section title="Tools">
                <div className="space-y-2">
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
              </Section>

              {/* Behavior */}
              <Section title="Behavior">
                <div className="space-y-3">
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
                      className="w-16 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-white/20"
                    />
                  </Field>
                  <Field label="Timeout (ms)">
                    <input
                      type="number" min={0} step={1000}
                      value={behavior.timeoutMs}
                      onChange={e => setBehavior({ timeoutMs: Number(e.target.value) })}
                      className="w-24 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-white/20"
                    />
                  </Field>
                </div>
              </Section>

              {/* Permissions */}
              <Section title="Permissions">
                <div className="space-y-2">
                  {([
                    ['readFiles',  'Read files'],
                    ['writeFiles', 'Write files'],
                    ['network',    'Network'],
                    ['shell',      'Shell'],
                  ] as [keyof NodePermissions, string][]).map(([key, lbl]) => (
                    <Toggle key={key} label={lbl} value={permissions[key]} onChange={() => togglePerm(key)} />
                  ))}
                </div>
              </Section>

              {/* Environment */}
              <Section title="Environment">
                <div className="space-y-2">
                  {envVars.map((ev, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        value={ev.key}
                        onChange={e => updateEnvVar(i, 'key', e.target.value)}
                        placeholder="KEY"
                        className="w-24 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                      />
                      <input
                        value={ev.value}
                        onChange={e => updateEnvVar(i, 'value', e.target.value)}
                        placeholder="value"
                        className="flex-1 min-w-0 bg-black/30 border border-white/[0.08] rounded px-2 py-1 text-[11px] text-slate-300 placeholder-slate-700 focus:outline-none focus:border-white/20 font-mono"
                      />
                      <button onClick={() => removeEnvVar(i)} className="text-slate-700 hover:text-slate-400 flex-shrink-0">
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

        {/* ── Footer ── */}
        <div className="flex justify-end px-6 py-3 border-t border-white/[0.07] flex-shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-1.5 bg-[#3d3dbf] hover:bg-[#4f4fcf] text-white text-sm rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-slate-600 mb-3">{title}</p>
      {children}
    </div>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="flex items-center justify-between w-full group">
      <span className="text-[12px] text-slate-500 group-hover:text-slate-300 transition-colors">{label}</span>
      <div className={`relative w-7 h-4 rounded-full transition-colors ${value ? 'bg-[#58A6FF]' : 'bg-white/10'}`}>
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${value ? 'left-[14px]' : 'left-0.5'}`} />
      </div>
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-slate-500 flex-shrink-0">{label}</span>
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
          className={`px-2 py-0.5 text-[11px] capitalize transition-colors ${
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
