// The visible terminal surface is painted by xterm's own `theme.background`,
// not by the `--bg-terminal` Tailwind/CSS token. That split meant editing the
// token in index.css did nothing to the actual PTY/shell pane. These helpers
// make the token the single source of truth: the xterm theme's background +
// cursorAccent are derived from `--bg-terminal` at render time, so changing
// the token (or app theme) actually moves the terminal color.

/**
 * Read a CSS custom property off :root. Tokens are stored as a space-separated
 * "R G B" triple (for Tailwind's <alpha-value>), so a numeric value is wrapped
 * as rgb(); a hex/other value is returned verbatim. Falls back when the var is
 * unavailable (e.g. called before styles apply).
 */
export function cssTokenColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!v) return fallback
  return /^[\d.]/.test(v) ? `rgb(${v})` : v
}

/**
 * Return `base` with its terminal surface (background + cursorAccent) pulled
 * from the `--bg-terminal` token. The rest of the ANSI palette is untouched.
 */
export function withTerminalSurface<T extends { background: string; cursorAccent?: string }>(
  base: T,
): T {
  const bg = cssTokenColor('--bg-terminal', base.background)
  return { ...base, background: bg, cursorAccent: bg }
}
