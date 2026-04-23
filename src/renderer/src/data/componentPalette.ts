import type { ComponentCategory } from '../types'

export type PaletteItemKind = 'zone' | 'component'

export interface PaletteItemConfig {
  id: string
  label: string
  description: string
  category: ComponentCategory
  iconName: string
  color: string
  tag: string
  kind?: PaletteItemKind
}

export const ZONE_PALETTE_ITEM: PaletteItemConfig = {
  id: 'zone',
  label: 'Empty Zone',
  description: 'An agent zone — drop components inside',
  category: 'custom',
  iconName: 'Layers',
  color: '#58A6FF',
  tag: 'ZONE',
  kind: 'zone',
}

export const palette: PaletteItemConfig[] = [
  // Infrastructure
  { id: 'frontend',       label: 'Frontend',       description: 'Client UI layer',          category: 'infrastructure', iconName: 'Monitor',      color: '#f472b6', tag: 'UI'      },
  { id: 'api-gateway',    label: 'API Gateway',    description: 'Request routing & auth',   category: 'infrastructure', iconName: 'Shield',       color: '#fb923c', tag: 'API'     },
  { id: 'auth',           label: 'Auth',           description: 'Authentication & SSO',     category: 'infrastructure', iconName: 'Lock',         color: '#4ade80', tag: 'AUTH'    },
  { id: 'load-balancer',  label: 'Load Balancer',  description: 'Traffic distribution',     category: 'infrastructure', iconName: 'Network',      color: '#f59e0b', tag: 'LB'      },
  { id: 'cdn',            label: 'CDN',            description: 'Edge content delivery',    category: 'infrastructure', iconName: 'Globe',        color: '#06b6d4', tag: 'CDN'     },
  { id: 'reverse-proxy',  label: 'Reverse Proxy',  description: 'Ingress / TLS termination',category: 'infrastructure', iconName: 'ArrowLeftRight', color: '#8b5cf6', tag: 'PROXY' },
  { id: 'event-bus',      label: 'Event Bus',      description: 'Pub/sub event routing',    category: 'infrastructure', iconName: 'GitBranch',    color: '#f472b6', tag: 'EVTBUS'  },
  { id: 'webhook',        label: 'Webhook',        description: 'Outbound HTTP callbacks',  category: 'infrastructure', iconName: 'Webhook',      color: '#e879f9', tag: 'HOOK'    },
  // Services
  { id: 'service',        label: 'Service',        description: 'Business logic',           category: 'services',       iconName: 'Settings2',    color: '#60a5fa', tag: 'SVC'     },
  { id: 'ai-model',       label: 'AI Model',       description: 'AI inference',             category: 'services',       iconName: 'Brain',        color: '#a78bfa', tag: 'AI'      },
  { id: 'queue',          label: 'Queue',          description: 'Message queue / broker',   category: 'services',       iconName: 'Layers',       color: '#fbbf24', tag: 'QUEUE'   },
  { id: 'worker',         label: 'Worker',         description: 'Async background jobs',    category: 'services',       iconName: 'Cpu',          color: '#94a3b8', tag: 'WORKER'  },
  { id: 'scheduler',      label: 'Scheduler',      description: 'Cron / timed jobs',        category: 'services',       iconName: 'Clock',        color: '#f97316', tag: 'CRON'    },
  { id: 'email',          label: 'Email',          description: 'Transactional email',      category: 'services',       iconName: 'Mail',         color: '#0ea5e9', tag: 'EMAIL'   },
  { id: 'notification',   label: 'Notification',   description: 'Push / SMS alerts',        category: 'services',       iconName: 'Bell',         color: '#eab308', tag: 'NOTIF'   },
  { id: 'payment',        label: 'Payment',        description: 'Billing & transactions',   category: 'services',       iconName: 'CreditCard',   color: '#10b981', tag: 'PAY'     },
  { id: 'search',         label: 'Search',         description: 'Full-text search engine',  category: 'services',       iconName: 'Search',       color: '#6366f1', tag: 'SEARCH'  },
  { id: 'monitoring',     label: 'Monitoring',     description: 'Metrics & alerting',       category: 'services',       iconName: 'Activity',     color: '#22c55e', tag: 'OBS'     },
  { id: 'analytics',      label: 'Analytics',      description: 'Event tracking & BI',      category: 'services',       iconName: 'BarChart2',    color: '#ec4899', tag: 'STATS'   },
  { id: 'feature-flags',  label: 'Feature Flags',  description: 'Runtime toggles',          category: 'services',       iconName: 'ToggleLeft',   color: '#64748b', tag: 'FLAGS'   },
  // Storage
  { id: 'database',       label: 'Database',       description: 'Relational / SQL',         category: 'storage',        iconName: 'Database',     color: '#60a5fa', tag: 'DB'      },
  { id: 'cache',          label: 'Cache',          description: 'In-memory cache',          category: 'storage',        iconName: 'Zap',          color: '#34d399', tag: 'CACHE'   },
  { id: 'object-storage', label: 'Object Storage', description: 'Blob / S3-compatible',     category: 'storage',        iconName: 'Archive',      color: '#0284c7', tag: 'S3'      },
  { id: 'data-warehouse', label: 'Data Warehouse', description: 'OLAP / analytics store',   category: 'storage',        iconName: 'Table',        color: '#7c3aed', tag: 'DWH'     },
  { id: 'vector-db',      label: 'Vector DB',      description: 'Embeddings & similarity',  category: 'storage',        iconName: 'Boxes',        color: '#a78bfa', tag: 'VEC'     },
  { id: 'graph-db',       label: 'Graph DB',       description: 'Nodes & relationships',    category: 'storage',        iconName: 'Share2',       color: '#fb923c', tag: 'GRAPH'   },
  { id: 'time-series-db', label: 'Time Series DB', description: 'Time-stamped metrics',     category: 'storage',        iconName: 'TrendingUp',   color: '#f472b6', tag: 'TSDB'    },
  // Custom
  { id: 'custom',         label: 'Custom',         description: 'User-defined component',   category: 'custom',         iconName: 'Wrench',       color: '#94a3b8', tag: 'CUSTOM'  },
]

export const categoryOrder: ComponentCategory[] = ['infrastructure', 'services', 'storage', 'custom']

export const categoryLabels: Record<ComponentCategory, string> = {
  infrastructure: 'Infrastructure',
  services: 'Services',
  storage: 'Storage',
  custom: 'Custom',
}
