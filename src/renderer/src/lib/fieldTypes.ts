// Color map for component field types. Mirrors the standard schema-coloring
// you'd see in a database GUI or UML class diagram: each primitive maps to
// a stable hue so columns of fields read at a glance. Type matching is
// case-insensitive and accepts common aliases (`int`, `integer`, `number`).
//
// Unknown types fall back to a muted neutral so user-coined types still
// render legibly without picking a misleading color.

const TYPE_ALIASES: Record<string, string[]> = {
  string:    ['string', 'text', 'str', 'varchar', 'char'],
  int:       ['int', 'integer', 'number', 'num', 'i32', 'i64', 'long', 'short'],
  float:     ['float', 'double', 'decimal', 'f32', 'f64', 'real'],
  bool:      ['bool', 'boolean', 'bit'],
  enum:      ['enum'],
  uuid:      ['uuid', 'guid'],
  date:      ['date', 'datetime', 'timestamp', 'time', 'instant'],
  json:      ['json', 'object', 'record', 'map', 'struct'],
  array:     ['array', 'list', 'vec', 'set'],
  ref:       ['ref', 'reference', 'fk', 'foreignkey'],
  blob:      ['blob', 'bytes', 'binary', 'buffer'],
}

// Muted schema palette: lower-chroma versions of the standard primitive
// hues. Designed to read at a glance against the warm-graphite surfaces
// without going garish; OKLCH lightness ~70%, chroma ~0.07-0.13. Hues are
// chosen so adjacent rows stay visually distinct (string/sage vs int/blue
// vs bool/light-blue, etc.).
const TYPE_COLOR: Record<string, string> = {
  string: '#86b399',  // sage — text-like
  int:    '#7193d6',  // blue — integers
  float:  '#d9a26a',  // sand — decimals
  bool:   '#a3bfd6',  // light-blue — flags (cooler, lighter than int)
  enum:   '#d68fb8',  // muted pink — enumerations
  uuid:   '#b794f6',  // violet — identifiers
  date:   '#dba27e',  // peach — temporal (warmer than float)
  json:   '#7fb9d3',  // cyan-blue — structured
  array:  '#9bd0d6',  // pale cyan — collections
  ref:    '#a89bd9',  // lavender — relations
  blob:   '#94a3b8',  // slate — binary
}

const NEUTRAL = '#a29e9c'

export function fieldTypeColor(type: string): string {
  const t = type.trim().toLowerCase()
  if (!t) return NEUTRAL
  for (const [canonical, aliases] of Object.entries(TYPE_ALIASES)) {
    if (aliases.includes(t)) return TYPE_COLOR[canonical]
  }
  return NEUTRAL
}

export function mintFieldId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `f-${uuid}` : `f-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
