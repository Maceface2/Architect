import type { ComponentCategory } from '../types'

export interface PaletteItemConfig {
  id: string
  label: string
  description: string
  category: ComponentCategory
  iconName: string
  color: string
  tag: string
}

export const palette: PaletteItemConfig[] = [
  { id: 'frontend',    label: 'Frontend',    description: 'Client UI layer',   category: 'infrastructure', iconName: 'Monitor',   color: '#f472b6', tag: 'UI'    },
  { id: 'api-gateway', label: 'API Gateway', description: 'Request routing',   category: 'infrastructure', iconName: 'Shield',    color: '#fb923c', tag: 'API'   },
  { id: 'auth',        label: 'Auth',        description: 'Authentication',     category: 'infrastructure', iconName: 'Lock',      color: '#4ade80', tag: 'AUTH'  },
  { id: 'service',     label: 'Service',     description: 'Business logic',     category: 'services',       iconName: 'Settings2', color: '#60a5fa', tag: 'SVC'   },
  { id: 'ai-model',    label: 'AI Model',    description: 'AI inference',       category: 'services',       iconName: 'Brain',     color: '#a78bfa', tag: 'AI'    },
  { id: 'queue',       label: 'Queue',       description: 'Message queue',      category: 'services',       iconName: 'Layers',    color: '#fbbf24', tag: 'QUEUE' },
  { id: 'database', label: 'Database', description: 'Persistent storage', category: 'storage', iconName: 'Database', color: '#60a5fa', tag: 'DB'    },
  { id: 'cache',    label: 'Cache',    description: 'In-memory cache',    category: 'storage', iconName: 'Zap',      color: '#34d399', tag: 'CACHE' },
]

export const categoryOrder: ComponentCategory[] = ['infrastructure', 'services', 'storage']

export const categoryLabels: Record<ComponentCategory, string> = {
  infrastructure: 'Infrastructure',
  services: 'Services',
  storage: 'Storage',
  custom: 'Custom',
}
