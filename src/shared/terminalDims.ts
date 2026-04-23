// Single source of truth for PTY + xterm initial dimensions.
//
// These values are used both when spawning node-pty in the main process and
// when constructing the xterm.js Terminal in the renderer. Keeping them in
// lockstep prevents the class of bug where xterm starts at one size and the
// PTY at another, producing hard-wrapped output that can't be reflowed
// (because the CLI on the PTY side has already baked \n's into the stream).
//
// The values are intentionally wide so that the first banner a CLI prints
// (e.g. Claude Code's Ink TUI) has room to render without narrow wrapping,
// even in the brief window before the renderer's first fit() arrives.
export const DEFAULT_COLS = 220
export const DEFAULT_ROWS = 50
