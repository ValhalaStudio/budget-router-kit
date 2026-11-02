// Pure helpers for budget-router: no engine calls, so tests can run them directly.

export type Family = 'haiku' | 'sonnet' | 'opus'
export const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus']

// ---------------------------------------------------------------------------------------
// Unreal build rules and cache-aware switching.

/** Text that looks like an Unreal / C++ build, cook or packaging failure. */
export const UE_BUILD_RE =
  /\b(UnrealBuildTool|UBT|UHT|RunUAT|LNK\d{3,4}|error C\d{4}|unresolved external|Build\.cs|LogCook|BUILD FAILED|cook(ing)? (failed|error)|packag(e|ing) (failed|error)|compile (failed|error))\b/i

export const isUnrealBuildPrompt = (text: string) => UE_BUILD_RE.test(text)

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

// ---------------------------------------------------------------------------------------
// A PID pacer for the daily budget and escalation when a turn goes badly.

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
export const LADDER_SIZE = LADDER.length
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

// ---------------------------------------------------------------------------------------
// v0.6: ghost-token guard (idle cache rebuilds, big contexts) and a small learner that finds the cheapest model and effort that works
// for each kind of prompt.

// -- Ghost tokens -----------------------------------------------------------------------

// List prices in USD per million tokens: cache read and 1-hour cache write.
const CACHE_PRICE: Record<Family, { read: number; write: number }> = {
  opus: { read: 0.2, write: 5 }, // Opus 5.5
  sonnet: { read: 0.2, write: 2.5 }, // Sonnet 5.5
  haiku: { read: 0.1, write: 1.25 }, // Haiku 4.5
}

export const usd = (n: number): string => (n < 0.01 ? '<$0.01' : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`)
export const kTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** What one more step costs just to re-read a context of this size from the cache. */
export const stepReadUsd = (ctx: number, family: Family): number => (ctx * CACHE_PRICE[family].read) / 1e6
export const stepWriteUsd = (ctx: number, family: Family): number => (ctx * CACHE_PRICE[family].write) / 1e6

export type IdleRebuild = { ctx: number; idleMin: number; rebuildUsd: number; warmUsd: number }

/** After a long pause the cache has expired, so the next prompt re-writes the whole context. */
export function idleRebuild(ctx: number, sinceLastMs: number | undefined, warmMs: number, minTokens: number, family: Family): IdleRebuild | undefined {
  if (sinceLastMs === undefined || sinceLastMs <= warmMs || ctx < minTokens) return undefined
  const pr = CACHE_PRICE[family]
  return { ctx, idleMin: Math.round(sinceLastMs / 60_000), rebuildUsd: (ctx * pr.write) / 1e6, warmUsd: (ctx * pr.read) / 1e6 }
}

export function idleText(r: IdleRebuild): string {
  return `Idle ${r.idleMin} min: the cache has expired, so this prompt re-writes about ${kTokens(r.ctx)} tokens of context (about ${usd(r.rebuildUsd)}, against ${usd(r.warmUsd)} warm). If you do not need that history, /compact or a fresh session is cheaper.`
}

/** Which multiple of the size threshold the context is in (0 below it). */
export const sizeBucket = (ctx: number, threshold: number): number => (threshold <= 0 ? 0 : Math.floor(ctx / threshold))

export function sizeNudgeText(ctx: number, family: Family): string {
  return `Context is ${kTokens(ctx)} tokens: every step re-reads it (about ${usd(stepReadUsd(ctx, family))} each on ${family}). /compact or a fresh session cuts that; long build or log output belongs with a helper agent.`
}

export type Counts = { s: number; f: number }
export type Learned = Record<string, Record<string, Counts>>

const DOMAINS: ReadonlyArray<[string, RegExp]> = [
  ['unreal', /unreal|\bue ?[45]\b|uproject|blueprint|uasset|\bubt\b|lyra|niagara/i],
  ['git', /\bgit\b|commit|branch|merge|pull request|\bpush\b|rebase/i],
  ['docs', /readme|documentation|write[- ]?up|explain|summar|diagram|report/i],
  ['system', /disk|storage|drive|folder|install|uninstall|delete|move|junction|registry|service/i],
  ['code', /function|\bbug\b|refactor|\btest|compile|class\b|stack ?trace|\berror\b|implement|plugin/i],
]

/** The kind of work a prompt is: its tier plus a coarse topic, so the learner pools similar prompts. */
export function bucketOf(tier: string, text: string): string {
  const t = text.slice(0, 800)
  for (const [name, re] of DOMAINS) if (re.test(t)) return `${tier}|${name}`
  return `${tier}|general`
}

/** Lower and upper end of a 90% Wilson interval on the success rate. */
export function wilson(s: number, n: number, z = 1.645): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 }
  const p = s / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) }
}

const MAX_BUCKETS = 60

export function recordOutcome(l: Learned, bucket: string, rung: number, ok: boolean): Learned {
  const row = { ...(l[bucket] ?? {}) }
  const cur = row[String(rung)] ?? { s: 0, f: 0 }
  row[String(rung)] = ok ? { s: cur.s + 1, f: cur.f } : { s: cur.s, f: cur.f + 1 }
  let out: Learned = { ...l, [bucket]: row }
  const keys = Object.keys(out)
  if (keys.length > MAX_BUCKETS) {
    const size = (k: string) => Object.values(out[k] ?? {}).reduce((a, c) => a + c.s + c.f, 0)
    const drop = keys.sort((a, b) => size(a) - size(b)).slice(0, keys.length - MAX_BUCKETS)
    out = Object.fromEntries(Object.entries(out).filter(([k]) => !drop.includes(k)))
  }
  return out
}

/** The user redid or corrected the answer: turn the last success into a failure. */
export function flipOutcome(l: Learned, bucket: string, rung: number): Learned {
  const cur = l[bucket]?.[String(rung)]
  if (!cur || cur.s <= 0) return l
  return { ...l, [bucket]: { ...l[bucket], [String(rung)]: { s: cur.s - 1, f: cur.f + 1 } } }
}

export const REDO_RE = /^\s*(no\b|nope|wrong|that'?s (not|wrong)|not what i|still (broken|failing|not|wrong)|again\b|try again|redo|you (missed|forgot|didn'?t)|doesn'?t work|didn'?t work|it'?s still)/i

export type LearnOptions = { minSamples: number; target: number; explore: number; rand: () => number }
export const LEARN_DEFAULTS: LearnOptions = { minSamples: 8, target: 0.85, explore: 0.1, rand: Math.random }

export type LearnedMove = { steps: number; why: string }

/**
 * At most one rung up or down from the rule-based choice, and only on evidence:
 * a rung that keeps failing here moves up; a rung that nearly always works lets us try the
 * next cheaper one (and once that has a record, keep using it if it works as well).
 */
export function learnedMove(l: Learned, bucket: string, baseRung: number, ladderSize: number, opts: LearnOptions = LEARN_DEFAULTS): LearnedMove | undefined {
  const row = l[bucket]
  if (!row) return undefined
  const at = (r: number): Counts => row[String(r)] ?? { s: 0, f: 0 }
  const n = (c: Counts) => c.s + c.f
  const base = at(baseRung)
  if (n(base) >= opts.minSamples) {
    const w = wilson(base.s, n(base))
    if (w.hi < 0.6 && baseRung < ladderSize - 1) return { steps: -1, why: `learned: ${Math.round(100 * (base.s / n(base)))}% success here, one step up` }
  }
  if (baseRung > 0) {
    const cheaper = at(baseRung - 1)
    if (n(cheaper) >= opts.minSamples && wilson(cheaper.s, n(cheaper)).lo >= opts.target - 0.05) return { steps: 1, why: 'learned: the cheaper step works here' }
    if (n(base) >= opts.minSamples && wilson(base.s, n(base)).lo >= opts.target && n(cheaper) < opts.minSamples && opts.rand() < opts.explore) return { steps: 1, why: 'learned: trying the cheaper step' }
  }
  return undefined
}
