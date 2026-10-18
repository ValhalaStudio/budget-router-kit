// Pure helpers for budget-router: no engine calls, so tests can run them directly.

export type Family = 'haiku' | 'sonnet' | 'opus'
export const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus']

// Subagent types that only read and summarise run on Haiku unless the call names a model.
export const DEFAULT_SUBAGENT_MODELS = '{"Explore":"haiku","claude-code-guide":"haiku","statusline-setup":"haiku"}'

function toMap(raw: string): Record<string, Family> | undefined {
  try {
    const obj: unknown = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
    const out: Record<string, Family> = {}
    for (const [k, v] of Object.entries(obj)) {
      const f = String(v).toLowerCase()
      if ((FAMILIES as readonly string[]).includes(f)) out[k] = f as Family
    }
    return out
  } catch {
    return undefined
  }
}

/** `{"Explore":"haiku"}` -> map. An empty string or bad JSON gives the default; `{}` switches the rules off. */
export function parseSubagentModels(raw: unknown): Record<string, Family> {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return (text !== '' ? toMap(text) : undefined) ?? toMap(DEFAULT_SUBAGENT_MODELS) ?? {}
}

export function parseList(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export type SpawnFacts = {
  subagentType: string
  model?: string
  fork?: boolean
  isTeammate?: boolean
  resume?: unknown
  workflow?: unknown
}
export type SpawnPlan = { model?: Family; note: string }

/** Which model a new subagent should get. Only plain subagents with no model named by the call are touched. */
export function planSpawn(e: SpawnFacts, map: Record<string, Family>): SpawnPlan {
  if (e.fork) return { note: 'fork: inherits the parent' }
  if (e.resume !== undefined) return { note: 'resume: left alone' }
  if (e.isTeammate) return { note: 'teammate: left alone' }
  if (e.workflow !== undefined) return { note: 'workflow agent: left alone' }
  if (e.model !== undefined && e.model !== '') return { note: `call chose ${e.model}` }
  const key = Object.keys(map).find(k => k.toLowerCase() === e.subagentType.toLowerCase())
  return key ? { model: map[key], note: `${e.subagentType} -> ${map[key]}` } : { note: 'unchanged' }
}

/** Agent types the model should not be offered once the budget is tight (level 2 = past the second cap). */
export function isOffered(agent: string, level: number, hidden: readonly string[]): boolean {
  return !(level >= 2 && hidden.some(h => h.toLowerCase() === agent.toLowerCase()))
}

export type LogEntry =
  | { t: number; k: 'prompt'; tier: string; why: string; model: string; effort: string; level: number; ctx: number }
  | { t: number; k: 'spawn'; type: string; note: string; level: number }
  | { t: number; k: 'turn'; sub: boolean; model: string; inp: number; out: number; cr: number; cc: number; ms: number }

export const MAX_LOG = 200

export function pushLog(log: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...log, entry]
  return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** The text behind `/route why`: recent decisions, spawn rules and today's token use. */
export function summarize(log: readonly LogEntry[], since: number, hhmm: (ms: number) => string): string {
  const lines: string[] = ['Budget router: recent decisions']
  const prompts = log.filter((x): x is Extract<LogEntry, { k: 'prompt' }> => x.k === 'prompt')
  if (prompts.length === 0) lines.push('  no routed prompts yet')
  for (const p of prompts.slice(-8)) {
    const caps = p.level > 0 ? ` [level ${p.level}]` : ''
    lines.push(`  ${hhmm(p.t)} ${p.tier.padEnd(8)} -> ${p.model}·${p.effort}${caps}  (${p.why}; context ${k(p.ctx)})`)
  }
  const spawns = log.filter((x): x is Extract<LogEntry, { k: 'spawn' }> => x.k === 'spawn')
  if (spawns.length > 0) {
    lines.push('  subagents:')
    for (const s of spawns.slice(-5)) lines.push(`    ${hhmm(s.t)} ${s.type}: ${s.note}`)
  }
  const today = log.filter((x): x is Extract<LogEntry, { k: 'turn' }> => x.k === 'turn' && x.t >= since)
  if (today.length > 0) {
    const sum = (rows: typeof today) =>
      rows.reduce(
        (a, r) => ({ inp: a.inp + r.inp, out: a.out + r.out, cr: a.cr + r.cr, cc: a.cc + r.cc, n: a.n + 1 }),
        { inp: 0, out: 0, cr: 0, cc: 0, n: 0 },
      )
    const row = (name: string, s: ReturnType<typeof sum>) => {
      const hit = s.inp + s.cr + s.cc > 0 ? Math.round((100 * s.cr) / (s.inp + s.cr + s.cc)) : 0
      return `    ${name}: ${s.n} turns, in ${k(s.inp)}, out ${k(s.out)}, cache read ${k(s.cr)} / written ${k(s.cc)} (${hit}% of input from cache)`
    }
    lines.push('  tokens today (counted by this plugin):')
    lines.push(row('main     ', sum(today.filter(r => !r.sub))))
    const sub = today.filter(r => r.sub)
    if (sub.length > 0) lines.push(row('subagents', sum(sub)))
    const byModel = new Map<string, number>()
    for (const r of today) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.inp + r.cr + r.cc + r.out)
    lines.push(`    by model: ${[...byModel].map(([m, n]) => `${m.replace('claude-', '')} ${k(n)}`).join(', ')}`)
  }
  return lines.join('\n')
}
