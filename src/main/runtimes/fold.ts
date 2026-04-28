import type { ComposedPrompt } from './types'

// Shared helper for runtimes that don't support a system-prompt flag. Folds
// the role prompt into the first-turn user message. Used by codex, gemini,
// and opencode adapters. Claude uses --append-system-prompt instead and
// doesn't call this.
export function foldSystemIntoUser(systemPrompt: string, userPrompt: string): string {
  const user = userPrompt.trim() || "(waiting for user's first message — acknowledge the role above and ask what to work on)"
  return `<<SYSTEM PROMPT — read this first, then respond to the user request at the bottom>>
${systemPrompt}
<<END SYSTEM PROMPT>>

User request:
${user}`
}

// Standard composeSystemAndUser implementation for runtimes without a
// system-prompt flag. Identical body across codex/gemini/opencode adapters.
export function foldComposeSystemAndUser(systemPrompt: string, userPrompt: string): ComposedPrompt {
  if (!systemPrompt) return { firstUserPrompt: userPrompt || undefined }
  return { firstUserPrompt: foldSystemIntoUser(systemPrompt, userPrompt) }
}
