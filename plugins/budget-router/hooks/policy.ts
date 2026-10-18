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
  const hit = Object.entries(map).find(([name]) => name.toLowerCase() === e.subagentType.toLowerCase())
  return hit ? { model: hit[1], note: `${e.subagentType} -> ${hit[1]}` } : { note: 'unchanged' }
}

/** Agent types the model should not be offered once the budget is tight (level 2 = past the second cap). */
export function isOffered(agent: string, level: number, hidden: readonly string[]): boolean {
  return !(level >= 2 && hidden.some(h => h.toLowerCase() === agent.toLowerCase()))
}

export type LogEntry =
  | { t: number; k: 'prompt'; tier: string; why: string; model: string; effort: string; level: number; ctx: number }
  | { t: number; k: 'spawn'; type: string; note: string; level: number }
  | { t: number; k: 'hint'; agent: string }
  | { t: number; k: 'escalate'; from: string; to: string; errors: number }
  | { t: number; k: 'skill'; name: string }
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
  const skillUses = log.filter((x): x is Extract<LogEntry, { k: 'skill' }> => x.k === 'skill')
  const hints = log.filter((x): x is Extract<LogEntry, { k: 'hint' }> => x.k === 'hint')
  if (hints.length > 0) {
    const per = new Map<string, { issued: number; followed: number }>()
    for (const h of hints) {
      const row = per.get(h.agent) ?? { issued: 0, followed: 0 }
      row.issued++
      const name = h.agent.toLowerCase()
      const inWindow = (t: number) => t >= h.t && t <= h.t + 15 * 60_000
      if (spawns.some(sp => inWindow(sp.t) && sp.type.toLowerCase().endsWith(name)) || skillUses.some(sk => inWindow(sk.t) && sk.name.toLowerCase().endsWith(name))) row.followed++
      per.set(h.agent, row)
    }
    lines.push('  hints (followed = that agent or skill was used within 15 min):')
    for (const [agent, r] of per) lines.push(`    ${agent}: ${r.issued} given, ${r.followed} followed`)
  }
  const escalations = log.filter((x): x is Extract<LogEntry, { k: 'escalate' }> => x.k === 'escalate')
  if (escalations.length > 0) {
    lines.push('  escalations (a turn with several failed tool calls got more effort or a stronger model):')
    for (const x of escalations.slice(-5)) lines.push(`    ${hhmm(x.t)} ${x.from} -> ${x.to} after ${x.errors} failed tool calls`)
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

// ---------------------------------------------------------------------------------------
// v0.4: Unreal build rules, agent hints, cache-aware switching, skill audit and vetting.

/** Text that looks like an Unreal / C++ build, cook or packaging failure. */
export const UE_BUILD_RE =
  /\b(UnrealBuildTool|UBT|UHT|RunUAT|LNK\d{3,4}|error C\d{4}|unresolved external|Build\.cs|LogCook|BUILD FAILED|cook(ing)? (failed|error)|packag(e|ing) (failed|error)|compile (failed|error))\b/i

export const isUnrealBuildPrompt = (text: string) => UE_BUILD_RE.test(text)

export type Hint = { agent: string; text: string }

const HINT_RULES: ReadonlyArray<{ agent: string; test: (t: string) => boolean; text: string }> = [
  {
    agent: 'log-triage',
    test: t => UE_BUILD_RE.test(t) || /\.log\b/i.test(t),
    text: 'This looks like a build, cook or packaging failure. If a long log is involved, let budget-router:log-triage (Haiku, read-only) cut it down to its errors first, then fix the first error.',
  },
  {
    agent: 'disk-auditor',
    test: t => /\b(disk|storage|free space|drive (is )?full|largest (files?|folders?)|what('s| is) (using|taking|eating)( up)? (the )?(space|disk)|how (big|much space))\b/i.test(t),
    text: 'For size surveys, let budget-router:disk-auditor (Haiku, read-only) do the measuring, then plan any deletions yourself.',
  },
  {
    agent: 'repo-check',
    test: t => /\b(unpushed|uncommitted|safe to (delete|remove|move)|before (deleting|removing|moving)|worktrees?|git status|local[- ]only)\b/i.test(t),
    text: 'Before deleting or moving a repo, have budget-router:repo-check (Haiku, read-only) report what exists only locally.',
  },
  {
    agent: 'reviewer',
    test: t => /\b(code review|review (this|my|the) (diff|changes|branch|pr|pull request|code|commit)|check (my|this|the) (diff|changes|branch))\b/i.test(t),
    text: 'For a diff or branch review, budget-router:reviewer (Sonnet, read-only) can do the first pass.',
  },
  {
    agent: 'scout',
    test: t => /\b(where is|where are|which files?|find all|find every|who (calls|uses)|usages? of|search (the )?(whole )?(codebase|repo|project|folder))\b/i.test(t),
    text: 'For a broad search across many files, delegate it to budget-router:scout (Haiku) and ask for file:line references.',
  },
]

/** At most one helper-agent suggestion for a prompt; deterministic, costs no tokens to decide. */
export function helperHint(text: string): Hint | undefined {
  const rule = HINT_RULES.find(r => r.test(text))
  return rule ? { agent: rule.agent, text: `[budget-router hint] ${rule.text}` } : undefined
}

/**
 * Whether a one-step model change should be skipped because it would re-cache a long
 * conversation. When the last main turn ended longer ago than the cache lives, the cache
 * is already cold and switching is free.
 */
export function shouldStick(a: { ctx: number; stickyContext: number; stepDistance: number; sinceLastTurnMs?: number; warmMs: number }): boolean {
  if (a.stepDistance !== 1 || a.ctx < a.stickyContext) return false
  return !(a.sinceLastTurnMs !== undefined && a.sinceLastTurnMs > a.warmMs)
}

export type PaceSample = { t: number; daily: number }

/** Keeps at most 60 samples; a sample within 3 minutes of the last one replaces it. */
export function addPace(samples: readonly PaceSample[], s: PaceSample): PaceSample[] {
  const last = samples[samples.length - 1]
  const base = last !== undefined && s.t - last.t < 180_000 ? samples.slice(0, -1) : samples
  const next = [...base, s]
  return next.length > 60 ? next.slice(next.length - 60) : next
}

/** Burn rate in percent of today's budget per hour over the recent window, and when 100% is reached at that pace. */
export function projectExhaustion(samples: readonly PaceSample[], now: number, windowMs = 90 * 60_000): { ratePerHour: number; at?: number } | undefined {
  const recent = samples.filter(x => x.t >= now - windowMs)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || last.t - first.t < 10 * 60_000) return undefined
  const rate = (last.daily - first.daily) / ((last.t - first.t) / 3_600_000)
  if (rate < 0.5) return { ratePerHour: Math.max(0, rate) }
  return { ratePerHour: rate, at: Math.max(now, last.t + ((100 - last.daily) / rate) * 3_600_000) }
}

export const roughSize = (chars: number) => Math.ceil(chars / 4)

export type CmdRow = { name: string; description: string; source: string; plugin?: string }

/** What the slash-command / skill list costs: descriptions are text the model reads in every session. */
export function auditCommands(rows: readonly CmdRow[]): string {
  const own = rows.filter(r => r.source !== 'builtin')
  const total = own.reduce((n, r) => n + r.description.length + r.name.length + 4, 0)
  const lines = [
    'Budget router: command and skill list',
    `  ${own.length} entries from plugins, your files and MCP servers; about ${roughSize(total)} tokens of names and descriptions (estimate, chars/4).`,
    '  Skills and plugin commands share this list; the model reads these lines every session.',
  ]
  const by = new Map<string, { n: number; chars: number }>()
  for (const r of own) {
    const origin = r.plugin ?? r.source
    const row = by.get(origin) ?? { n: 0, chars: 0 }
    row.n++
    row.chars += r.description.length + r.name.length + 4
    by.set(origin, row)
  }
  lines.push('  by source:')
  for (const [origin, v] of [...by].sort((a, b) => b[1].chars - a[1].chars).slice(0, 8)) lines.push(`    ${origin}: ${v.n} entries, ~${roughSize(v.chars)} tokens`)
  lines.push('  longest descriptions:')
  for (const r of [...own].sort((a, b) => b.description.length - a.description.length).slice(0, 8)) {
    lines.push(`    ${r.name} (${r.plugin ?? r.source}): ${r.description.length} chars, ~${roughSize(r.description.length)} tokens`)
  }
  lines.push('  To trim: plugin skills and commands are switched off in /plugin (a whole plugin at once); your own skills can be set to name-only or off in /skills (skillOverrides does not apply to plugin skills).')
  return lines.join('\n')
}

export type Finding = { sev: 'high' | 'medium' | 'low'; what: string }

// Text that pipes into a shell, or evaluates a string, is a red flag wherever it came from.
const PIPE_TO_SHELL = /\|\s*(sh|bash|zsh|iex|powershell|pwsh)\b|Invoke-Expression|\biex\b/i

/** Static red flags in a skill, agent, command or hook file. Advisory only: it cannot prove a file is safe. */
export function vetText(text: string): Finding[] {
  const out: Finding[] = []
  const add = (sev: Finding['sev'], what: string, re: RegExp) => {
    if (re.test(text)) out.push({ sev, what })
  }
  add('high', 'tells the model to keep something from you', /do not (tell|mention|inform|reveal)[^.\n]{0,50}(user|human|person)|without (telling|informing) the user|hide this from/i)
  add('high', 'pipes text into a shell or evaluates a string', PIPE_TO_SHELL)
  add('high', 'loads instructions from a URL (they can change after review)', /(load|follow|read)[^.\n]{0,60}(instructions?|prompt|rules)[^.\n]{0,60}https?:\/\//i)
  add('high', 'hidden or direction-changing unicode characters', /[\u200B-\u200F\u2060\uFEFF\u202A-\u202E]/)
  const granted = /^allowed-tools\s*:(.*)$/im.exec(text)?.[1]
  if (granted !== undefined && granted.split(',').some(tok => /^\s*(\*|(Bash|PowerShell|Shell)(\(\*\))?)\s*$/i.test(tok))) {
    out.push({ sev: 'high', what: 'grants itself broad tool permissions (allowed-tools)' })
  }
  add('medium', 'runs shell commands when it loads (inline ! blocks)', /^[ \t]*!`[^`]+`|`!\w/m)
  add('medium', 'defines hooks', /^hooks\s*:/m)
  add('medium', 'contains a long encoded blob or decodes base64', /[A-Za-z0-9+/]{200,}={0,2}|base64\s*(-d|--decode)|FromBase64String|atob\(/i)
  add('medium', 'edits your memory or settings files', /(CLAUDE\.md|AGENTS\.md|settings(\.local)?\.json)[^\n]{0,60}(append|write|modify|edit|add to)/i)
  if (text.length > 10_000) out.push({ sev: 'low', what: `long (${text.length} characters): read all of it, payloads hide at the end` })
  return out
}

export function verdict(findings: readonly Finding[]): string {
  if (findings.some(f => f.sev === 'high')) return 'DO NOT INSTALL until a person has read it'
  if (findings.some(f => f.sev === 'medium')) return 'REVIEW the flagged parts before installing'
  return 'no red flags found (this is not a guarantee)'
}

// ---------------------------------------------------------------------------------------
// v0.5: a PID pacer for the daily budget, escalation when a turn goes badly, and
// suggestions of installed skills and agents ranked by BM25 keyword matching.

export type EffortName = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type LadderSpec = { family: Family; effort: EffortName }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// -- Pacer ------------------------------------------------------------------------------

export type PacerParams = { kp: number; ki: number; kd: number; iMax: number; maxSteps: number }
/** kp: steps per percentage point over pace. ki: steps per point-hour. Derivative is off by default. */
export const PACER_DEFAULTS: PacerParams = { kp: 0.05, ki: 0.02, kd: 0, iMax: 50, maxSteps: 2 }

export type PacerState = { i: number; lastE?: number; lastT?: number; u: number; day: string }

/** Where today's use should be at this hour if spread evenly across the active hours (percent of the daily budget). */
export function targetPercent(hourOfDay: number, startHour: number, endHour: number): number {
  if (endHour <= startHour) return 100
  return 100 * clamp((hourOfDay - startHour) / (endHour - startHour), 0, 1)
}

/**
 * One controller step. `errorPts` is use minus allowed pace, in percentage points of the daily
 * budget. The output `u` is "how many cost steps to shed", 0 to maxSteps. The integral stops
 * growing while the output is saturated and still over pace (anti-windup), and restarts each day.
 */
export function pacerStep(prev: PacerState | undefined, day: string, now: number, errorPts: number, params: PacerParams = PACER_DEFAULTS): PacerState {
  const base: PacerState = prev && prev.day === day ? prev : { i: 0, u: 0, day }
  const dtH = base.lastT === undefined ? 0 : clamp((now - base.lastT) / 3_600_000, 0, 1)
  const saturated = base.u >= params.maxSteps && errorPts > 0
  const i = saturated ? base.i : clamp(base.i + errorPts * dtH, -params.iMax, params.iMax)
  const d = base.lastE !== undefined && dtH > 0 ? (errorPts - base.lastE) / dtH : 0
  const u = clamp(params.kp * errorPts + params.ki * i + params.kd * d, 0, params.maxSteps)
  return { i, lastE: errorPts, lastT: now, u, day }
}

/** The controller output rounded to whole steps: 0, 1 or 2. */
export const paceSteps = (u: number): number => (u < 0.5 ? 0 : u < 1.5 ? 1 : 2)

// -- Cost ladder ------------------------------------------------------------------------

const LADDER: ReadonlyArray<LadderSpec> = [
  { family: 'haiku', effort: 'low' },
  { family: 'haiku', effort: 'medium' },
  { family: 'sonnet', effort: 'low' },
  { family: 'sonnet', effort: 'high' },
  { family: 'opus', effort: 'high' },
  { family: 'opus', effort: 'xhigh' },
]
const EFFORT_RANK: Record<EffortName, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
const FAMILY_RANK: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2 }
const costKey = (s: LadderSpec) => FAMILY_RANK[s.family] * 10 + EFFORT_RANK[s.effort]

/** Index of the dearest ladder rung that is not dearer than the spec. */
export function ladderIndex(spec: LadderSpec): number {
  let idx = 0
  LADDER.forEach((rung, n) => {
    if (costKey(rung) <= costKey(spec)) idx = n
  })
  return idx
}

/** Move along the cost ladder: positive steps go cheaper, negative steps dearer. Stays on the ladder. */
export function shiftLadder(spec: LadderSpec, steps: number): LadderSpec {
  const target = clamp(ladderIndex(spec) - steps, 0, LADDER.length - 1)
  return LADDER[target] ?? spec
}

// -- Escalation when a turn goes badly --------------------------------------------------

export type TroubleRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: ReadonlyArray<{ tool_use_id: string; isError?: boolean }>
  toolResults?: ReadonlyArray<{ tool_use_id: string; isError?: boolean }>
}

/** Distinct tool calls that errored since the last real user prompt (a user row with text and no tool results). */
export function countTurnErrors(rows: readonly TroubleRow[]): number {
  const failed = new Set<string>()
  for (let n = rows.length - 1; n >= 0; n--) {
    const row = rows[n]
    if (!row) continue
    const isPrompt = row.role === 'user' && row.text.trim() !== '' && !(row.toolResults && row.toolResults.length > 0)
    if (isPrompt) break
    for (const u of row.toolUses ?? []) if (u.isError) failed.add(u.tool_use_id)
    for (const r of row.toolResults ?? []) if (r.isError) failed.add(r.tool_use_id)
  }
  return failed.size
}

export type Escalation = { effortUp: boolean; modelUp: boolean }

export function escalationFor(errors: number, afterErrors: number, modelAfterErrors: number): Escalation {
  return { effortUp: errors >= afterErrors, modelUp: errors >= modelAfterErrors }
}

const NEXT_EFFORT: Record<EffortName, EffortName> = { low: 'medium', medium: 'high', high: 'high', xhigh: 'xhigh', max: 'max' }
const NEXT_FAMILY: Record<Family, Family> = { haiku: 'sonnet', sonnet: 'opus', opus: 'opus' }

/** Effort goes up one notch (to high at most); the model goes up one step only for a long run of errors. */
export function applyEscalation(spec: LadderSpec, esc: Escalation): LadderSpec {
  return {
    family: esc.modelUp ? NEXT_FAMILY[spec.family] : spec.family,
    effort: esc.effortUp || esc.modelUp ? NEXT_EFFORT[spec.effort] : spec.effort,
  }
}

// -- Suggesting installed skills and agents (BM25) --------------------------------------

export type CatalogItem = { kind: 'agent' | 'skill'; name: string; description: string; source: string; plugin?: string }

const STOP = new Set(
  ('the and for with that this from your you are was were have has had not but can will use used using when then than into onto over under about also just like want need make made get got ' +
    'its their them they what which who whom how why where does did doing done any all some one two out off our his her she him per via too very more most much many such other another each ' +
    'please should would could might must may let lets file files code these those there here').split(' '),
)

const stem = (w: string) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP.has(w))
    .map(stem)
}

export type CatalogIndex = { items: readonly CatalogItem[]; docs: ReadonlyArray<Map<string, number>>; lens: readonly number[]; avg: number; df: Map<string, number> }

/** Each item becomes a bag of words: its name three times (so naming it counts) plus its description. */
export function buildIndex(items: readonly CatalogItem[]): CatalogIndex {
  const docs: Array<Map<string, number>> = []
  const lens: number[] = []
  const df = new Map<string, number>()
  for (const it of items) {
    const words = [...tokenize(it.name), ...tokenize(it.name), ...tokenize(it.name), ...tokenize(it.description)]
    const tf = new Map<string, number>()
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1)
    docs.push(tf)
    lens.push(words.length)
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1)
  }
  const avg = lens.length > 0 ? lens.reduce((a, b) => a + b, 0) / lens.length : 0
  return { items, docs, lens, avg, df }
}

export type Suggestion = { item: CatalogItem; score: number; matched: string[] }
export type SuggestOptions = { minScore: number; minMatches: number; margin: number }
export const SUGGEST_DEFAULTS: SuggestOptions = { minScore: 5, minMatches: 2, margin: 1.25 }

/** The one item that clearly fits the request, or nothing. BM25 with k1 = 1.2, b = 0.75. */
export function suggestFrom(text: string, idx: CatalogIndex, opts: SuggestOptions = SUGGEST_DEFAULTS): Suggestion | undefined {
  const terms = [...new Set(tokenize(text.slice(0, 600)))]
  if (terms.length === 0 || idx.items.length === 0) return undefined
  // A tiny catalog would give every word a near-zero weight, so score as if it held at least 40 items.
  const n = Math.max(idx.items.length, 40)
  const scored: Suggestion[] = []
  idx.items.forEach((item, k) => {
    const tf = idx.docs[k]
    const len = idx.lens[k]
    if (!tf || len === undefined) return
    let score = 0
    const matched: string[] = []
    for (const t of terms) {
      const f = tf.get(t)
      if (!f) continue
      const dfT = idx.df.get(t) ?? 0
      const idf = Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5))
      score += (idf * (f * 2.2)) / (f + 1.2 * (1 - 0.75 + 0.75 * (len / (idx.avg || 1))))
      matched.push(t)
    }
    if (matched.length > 0) scored.push({ item, score, matched })
  })
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score < opts.minScore || best.matched.length < opts.minMatches) return undefined
  const second = scored[1]
  if (second && best.score < opts.margin * second.score) return undefined
  return best
}
