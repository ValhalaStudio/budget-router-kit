// Contextual tips: short notices that name a cheaper habit when the situation calls for it.
// Pure: the caller decides when to show one. A tip is shown to the person only (a toast); it is never
// added to the conversation. Each rule uses only what the plugin already holds in memory for the
// current prompt: its text, its kind label, the previous turn's size and failure count, the cap level.
// CHEATSHEET.md has the longer version of every habit named here, with its source.

export type TipSignals = {
  text: string // the typed prompt, in memory only
  kind: string // the fixed label from kindOf()
  lastSteps?: number // requests made by the previous main turn
  failedLast: number // failed tool calls in the previous turn
  level: number // budget cap level, 0 to 3
}

export type Tip = { id: string; text: string }

const LONG_TURN_STEPS = 30
const FAILED_TOOL_CALLS = 3
const LONG_PASTE_CHARS = 1500
const BUILD_LOG_CHARS = 800
const VAGUE = /\b(improve|clean ?up|optimi[sz]e|refactor|review|fix|check)\b[^.\n]{0,25}\b(the )?(whole |entire |all (of )?(the )?)?(code ?base|project|repo(sitory)?|everything)\b/i
const BUILD_ERROR = /\b(UnrealBuildTool|UBT|UHT|RunUAT|LNK\d{3,4}|error C\d{4}|BUILD FAILED|LogCook)\b/i

/** Each rule: an id (a tip is shown once per session), when it applies, and what to say. */
const RULES: ReadonlyArray<{ id: string; when: (s: TipSignals) => boolean; text: (s: TipSignals) => string }> = [
  {
    id: 'failures',
    when: s => s.failedLast >= FAILED_TOOL_CALLS,
    text: s => `${s.failedLast} tool calls failed in the last turn. Every retry re-reads the whole conversation. /rewind (or Esc twice) to before it went wrong, then ask again with the exact error.`,
  },
  {
    id: 'long-turn',
    when: s => (s.lastSteps ?? 0) >= LONG_TURN_STEPS,
    text: s => `The last turn took ${s.lastSteps} requests, and each one re-reads the conversation. Hand a wide search or log read to a subagent and ask for a short summary back, so only the summary stays here.`,
  },
  {
    id: 'build-log',
    when: s => s.text.length >= BUILD_LOG_CHARS && BUILD_ERROR.test(s.text),
    text: () => 'Build and cook logs run to thousands of lines, and everything you paste is re-read on every later request. Paste only the first error with a few lines around it, or let a helper agent cut the log down.',
  },
  {
    id: 'paste',
    when: s => s.kind === 'paste' && s.text.length >= LONG_PASTE_CHARS,
    text: () => 'A long paste stays in the conversation and is re-read on every later request. Put it in a file and point Claude at the part that matters (@path), or paste only the relevant lines.',
  },
  {
    id: 'vague',
    when: s => s.text.length < 200 && !/@\S/.test(s.text) && VAGUE.test(s.text),
    text: () => 'A broad ask like this makes Claude scan widely. Name the file or function (@path) and the result you want, and it reads far less.',
  },
  {
    id: 'capped',
    when: s => s.level >= 1,
    text: () => 'While capped: /clear between unrelated tasks, /effort low for simple work, and Shift+Tab to plan before a big change, so a wrong direction is cheap.',
  },
  {
    id: 'shell',
    when: s => s.kind === 'shell',
    text: () => 'A command you can run yourself costs no tokens in your own terminal. Paste back only the lines that matter.',
  },
]

/** The first applicable tip that has not been shown yet, or nothing. */
export function pickTip(s: TipSignals, shown: ReadonlySet<string>): Tip | undefined {
  for (const r of RULES) if (!shown.has(r.id) && r.when(s)) return { id: r.id, text: r.text(s) }
  return undefined
}
