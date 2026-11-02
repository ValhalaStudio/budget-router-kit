// Pure routing helpers: no engine calls, so tests run them directly.
// Sections: Unreal rule, cache-aware switching, pace controller, cost ladder, escalation, context notices.
import { DEFAULT_PRICES } from './smart'

export type Family = 'haiku' | 'sonnet' | 'opus'
export type EffortName = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type LadderSpec = { family: Family; effort: EffortName }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// -- Unreal rule ---------------------------------------------------------------------------

/** Text that looks like an Unreal / C++ build, cook or packaging failure. */
export const UE_BUILD_RE =
  /\b(UnrealBuildTool|UBT|UHT|RunUAT|LNK\d{3,4}|error C\d{4}|unresolved external|Build\.cs|LogCook|BUILD FAILED|cook(ing)? (failed|error)|packag(e|ing) (failed|error)|compile (failed|error))\b/i

export const isUnrealBuildPrompt = (text: string) => UE_BUILD_RE.test(text)

// -- Cache-aware switching -----------------------------------------------------------------

/**
 * Whether a one-step model change should be skipped because it would re-cache a long
 * conversation. Once the cache has gone cold (the last turn ended long ago), switching is free.
 */
export function shouldStick(a: { ctx: number; stickyContext: number; stepDistance: number; sinceLastTurnMs?: number; warmMs: number }): boolean {
  if (a.stepDistance !== 1 || a.ctx < a.stickyContext) return false
  return !(a.sinceLastTurnMs !== undefined && a.sinceLastTurnMs > a.warmMs)
}

// -- Pace controller -----------------------------------------------------------------------

export type PacerParams = { kp: number; ki: number; kd: number; iMax: number; maxSteps: number }
/** kp: steps per percentage point over pace. ki: steps per point-hour. Derivative off. */
export const PACER_DEFAULTS: PacerParams = { kp: 0.05, ki: 0.02, kd: 0, iMax: 50, maxSteps: 2 }

export type PacerState = { i: number; lastE?: number; lastT?: number; u: number; day: string }

/** Where today's use should be at this hour if spread evenly across the active hours (percent of the daily budget). */
export function targetPercent(hourOfDay: number, startHour: number, endHour: number): number {
  if (endHour <= startHour) return 100
  return 100 * clamp((hourOfDay - startHour) / (endHour - startHour), 0, 1)
}

/**
 * One PI controller step. `errorPts` is use minus allowed pace, in points of the daily budget.
 * The output `u` is how many cost steps to shed (0 to maxSteps). The integral stops growing while
 * the output is saturated and still over pace (anti-windup), and restarts each day.
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

// -- Cost ladder (what pace control steps along) --------------------------------------------

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

/** Move along the ladder: positive steps go cheaper, negative dearer. Stays on the ladder. */
export function shiftLadder(spec: LadderSpec, steps: number): LadderSpec {
  return LADDER[clamp(ladderIndex(spec) - steps, 0, LADDER.length - 1)] ?? spec
}

// -- Escalation when a turn goes badly ------------------------------------------------------

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

// -- Context notices (idle cache rebuild, large context) -------------------------------------

export const usd = (n: number): string => (n < 0.01 ? '<$0.01' : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`)
export const kTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** What one more step costs just to re-read a context of this size from the cache. */
export const stepReadUsd = (ctx: number, family: Family): number => (ctx * DEFAULT_PRICES[family].read) / 1e6

export type IdleRebuild = { ctx: number; idleMin: number; rebuildUsd: number; warmUsd: number }

/** After a long pause the cache has expired, so the next prompt re-writes the whole context. */
export function idleRebuild(ctx: number, sinceLastMs: number | undefined, warmMs: number, minTokens: number, family: Family): IdleRebuild | undefined {
  if (sinceLastMs === undefined || sinceLastMs <= warmMs || ctx < minTokens) return undefined
  const pr = DEFAULT_PRICES[family]
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
