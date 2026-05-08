// Convert a 3- or 6-digit hex color to an `rgba(r, g, b, alpha)` string.
// Used wherever the canvas needs to apply a per-zone or per-component accent
// color at varying opacities (borders, fills, glows, tinted strips).
export function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '')
  const full =
    cleaned.length === 3
      ? cleaned.split('').map(c => c + c).join('')
      : cleaned
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
