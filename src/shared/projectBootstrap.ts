export type ImportedNodeCategory = 'infrastructure' | 'services' | 'storage' | 'custom'
export type ProjectBootstrapSource = 'deterministic' | 'agent' | 'fallback'
export type ProjectBootstrapConfidence = 'high' | 'medium' | 'low'

export interface ImportedProjectNode {
  id: string
  label: string
  description: string
  category: ImportedNodeCategory
  iconName: string
  color: string
  tag: string
  prompt: string
  ownedPaths: string[]
  expectedFiles: string[]
  contracts: string
  reviewHints: string
}

export interface ImportedProjectEdge {
  id: string
  source: string
  target: string
}

export interface StructureCandidateBoundary {
  path: string
  labelHint: string
  categoryHint: ImportedNodeCategory
  reasons: string[]
  expectedFiles: string[]
}

export interface RepresentativeSample {
  path: string
  reason: string
  excerpt: string
}

export interface ProjectStructureSummary {
  projectName: string
  tree: string
  topLevelFiles: string[]
  candidateBoundaries: StructureCandidateBoundary[]
  representativeSamples: RepresentativeSample[]
  notes: string[]
  confidence: ProjectBootstrapConfidence
}

export interface ProjectBootstrapResult {
  nodes: ImportedProjectNode[]
  edges: ImportedProjectEdge[]
  summary: string
  source: ProjectBootstrapSource
  confidence: ProjectBootstrapConfidence
  notes: string[]
}
