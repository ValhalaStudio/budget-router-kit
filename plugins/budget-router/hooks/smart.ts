// Cost-aware learner for budget-router: a contextual bandit over (model, effort) arms.
// Pure functions only (no engine calls), so tests can run them directly.

import type { Family } from './policy'

export type Arm = { family: Family; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }

/** Cheapest to dearest. The order is the cost order the window and the prior lean on. */
export const ARMS: readonly Arm[] = [
  { family: 'haiku', effort: 'low' },
  { family: 'haiku', effort: 'medium' },
  { family: 'haiku', effort: 'high' },
  { family: 'sonnet', effort: 'low' },
  { family: 'sonnet', effort: 'medium' },
  { family: 'sonnet', effort: 'high' },
  { family: 'sonnet', effort: 'xhigh' },
  { family: 'opus', effort: 'medium' },
  { family: 'opus', effort: 'high' },
  { family: 'opus', effort: 'xhigh' },
  { family: 'opus', effort: 'max' },
]

export const armName = (i: number): string => `${ARMS[i]?.family ?? '?'}·${ARMS[i]?.effort ?? '?'}`

/** Nearest arm that is not dearer than the spec (same idea as the old ladderIndex). */
export function armIndex(spec: Arm): number {
  const exact = ARMS.findIndex(a => a.family === spec.family && a.effort === spec.effort)
  if (exact >= 0) return exact
  const same = ARMS.map((a, i) => ({ a, i })).filter(x => x.a.family === spec.family)
  if (same.length === 0) return 0
  const rank = ['low', 'medium', 'high', 'xhigh', 'max']
  const want = rank.indexOf(spec.effort)
  let best = same[0]!.i
  for (const x of same) if (rank.indexOf(x.a.effort) <= want) best = x.i
  return best
}

// -- Cells with exponential decay ------------------------------------------------------

export type Cell = { s: number; f: number; c: number; n: number; t: number }
export const HALF_LIFE_MS = 14 * 24 * 3600_000
const EMPTY: Cell = { s: 0, f: 0, c: 0, n: 0, t: 0 }

export function decayed(cell: Cell | undefined, now: number, halfLife = HALF_LIFE_MS): Cell {
  if (!cell || cell.t === 0) return EMPTY
  const k = Math.pow(0.5, Math.max(0, now - cell.t) / halfLife)
  return { s: cell.s * k, f: cell.f * k, c: cell.c * k, n: cell.n * k, t: now }
}

export function addToCell(cell: Cell | undefined, now: number, ok: boolean, costUsd: number): Cell {
  const d = decayed(cell, now)
  return { s: d.s + (ok ? 1 : 0), f: d.f + (ok ? 0 : 1), c: d.c + Math.max(0, costUsd), n: d.n + 1, t: now }
}

/** The user said the last answer was wrong (or right): move one unit between success and failure. */
export function flipCell(cell: Cell | undefined, toOk: boolean): Cell | undefined {
  if (!cell) return cell
  if (toOk) return cell.f >= 1 ? { ...cell, s: cell.s + 1, f: cell.f - 1 } : cell
  return cell.s >= 1 ? { ...cell, s: cell.s - 1, f: cell.f + 1 } : cell
}

// -- Features and the logistic prior -----------------------------------------------------

export const DIM = 256

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % DIM
}

/** Hashed bag of words plus a few shape features. Only the hashed weights are ever stored. */
export function features(text: string, ctxTokens = 0): number[] {
  const t = text.slice(0, 1500).toLowerCase()
  const idx = new Set<number>()
  for (const w of t.match(/[a-z_]{3,}/g)?.slice(0, 60) ?? []) idx.add(hash(`w:${w}`))
  idx.add(hash(`len:${Math.min(6, Math.floor(Math.log2(1 + t.length / 40)))}`))
  if (/```|[{};]\s*$/m.test(text)) idx.add(hash('code'))
  if (/[\w-]+\.(ts|js|py|cpp|h|cs|json|md|ps1)\b/i.test(t)) idx.add(hash('files'))
  idx.add(hash(`ctx:${Math.min(5, Math.floor(ctxTokens / 40_000))}`))
  return [...idx]
}

export type Weights = Record<number, number>

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
const logit = (p: number) => Math.log(p / (1 - p))

/** Prior chance an arm does the job: the rule-based pick works 85% of the time, each cheaper step costs a bit. */
export function priorP(w: Weights, x: readonly number[], arm: number, base: number, target = 0.85): number {
  let z = logit(target) + 0.8 * (arm - base)
  for (const i of x) z += w[i] ?? 0
  return Math.min(0.99, Math.max(0.02, sigmoid(z)))
}

/** One SGD step on the hashed weights: the arm tried, the outcome seen. Small rate, clipped weights. */
export function trainWeights(w: Weights, x: readonly number[], arm: number, base: number, ok: boolean, lr = 0.15): Weights {
  const p = priorP(w, x, arm, base)
  const g = (ok ? 1 : 0) - p
  const out: Weights = { ...w }
  for (const i of x) out[i] = Math.max(-3, Math.min(3, (out[i] ?? 0) + (lr * g) / Math.sqrt(x.length || 1)))
  return out
}

// -- Beta posterior with a hierarchy ------------------------------------------------------

const PRIOR_STRENGTH = 6

/** Posterior (a, b) for one scope, shrunk toward the scope above it. */
export function posterior(cell: Cell | undefined, parentMean: number, now: number): { a: number; b: number } {
  const d = decayed(cell, now)
  return { a: d.s + PRIOR_STRENGTH * parentMean, b: d.f + PRIOR_STRENGTH * (1 - parentMean) }
}

/** global -> kind -> project: each level starts from the mean of the one above. */
export function hierMean(levels: ReadonlyArray<Cell | undefined>, root: number, now: number): { a: number; b: number } {
  let mean = root
  let post = { a: PRIOR_STRENGTH * root, b: PRIOR_STRENGTH * (1 - root) }
  for (const cell of levels) {
    post = posterior(cell, mean, now)
    mean = post.a / (post.a + post.b)
  }
  return post
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand())
}

function gamma(k: number, rand: () => number): number {
  if (k < 1) return gamma(k + 1, rand) * Math.pow(Math.max(1e-12, rand()), 1 / k)
  const d = k - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (let n = 0; n < 50; n++) {
    const x = gaussian(rand)
    const v = Math.pow(1 + c * x, 3)
    if (v <= 0) continue
    const u = rand()
    if (Math.log(Math.max(1e-12, u)) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v
  }
  return d
}

export function sampleBeta(a: number, b: number, rand: () => number = Math.random): number {
  const x = gamma(a, rand)
  const y = gamma(b, rand)
  return x / (x + y)
}

// -- Prices and cost -------------------------------------------------------------------

export type Price = { inp: number; out: number; read: number; write: number } // USD per million tokens
/** Estimates, not an invoice. Override with the `priceTable` option when the real prices differ. */
export const DEFAULT_PRICES: Record<Family, Price> = {
  haiku: { inp: 1, out: 5, read: 0.1, write: 1.25 },
  sonnet: { inp: 3, out: 15, read: 0.3, write: 3.75 },
  opus: { inp: 5, out: 25, read: 0.5, write: 6.25 },
}
/** Extra thinking: higher effort writes more output tokens for the same answer. Rough multipliers on output. */
export const EFFORT_OUT: Record<Arm['effort'], number> = { low: 0.7, medium: 1, high: 1.4, xhigh: 1.9, max: 2.6 }

export type Usage = { inp: number; out: number; cr: number; cc: number }

export function turnCostUsd(family: Family, u: Usage, prices: Record<Family, Price> = DEFAULT_PRICES): number {
  const p = prices[family]
  return (u.inp * p.inp + u.out * p.out + u.cr * p.read + u.cc * p.write) / 1e6
}

/** Expected cost of an arm for a typical turn, from its own history if it has any, else from the price table. */
export function expectedCost(arm: number, cell: Cell | undefined, now: number, typical: Usage, prices: Record<Family, Price> = DEFAULT_PRICES): number {
  const d = decayed(cell, now)
  if (d.n >= 3) return d.c / d.n
  const a = ARMS[arm]!
  return turnCostUsd(a.family, { ...typical, out: typical.out * EFFORT_OUT[a.effort] }, prices)
}

// -- The choice ------------------------------------------------------------------------

export type Scope = { global: Record<string, Cell>; kind: Record<string, Cell>; project: Record<string, Cell> }

export type PickInput = {
  base: number // arm the rules chose
  tier: string // 'deep' and 'max' never explore
  scope: Scope
  w: Weights
  x: readonly number[]
  now: number
  dailyUsedPct: number // 0..100, how much of today's budget is gone
  qualityWeight?: number // USD of "pain" for a failed turn when the budget is empty
  typical: Usage
  prices?: Record<Family, Price>
  rand?: () => number
  exploresLeft: number
  minSamples?: number
  explore?: number // chance per turn of trying one cheaper step with no record
}

export type Pick = { arm: number; why: string; explored: boolean; scores: Array<{ arm: number; p: number; score: number }> }

/** Window of arms the learner may pick from: one or two below the rule choice, one above. Deep work gets less room down, max none. */
export function window(base: number, tier: string): [number, number] {
  if (tier === 'max') return [base, base]
  const down = tier === 'deep' ? 1 : 2
  return [Math.max(0, base - down), Math.min(ARMS.length - 1, base + 1)]
}

/**
 * score = cost + (1 - p) * (cost of the next arm up + quality pain), where pain grows as the
 * daily budget shrinks. Thompson sampling draws p from its posterior, so thin evidence explores
 * and strong evidence settles. Pruned: an arm that costs no less than a better-looking one is dropped.
 */
export function pickArm(inp: PickInput): Pick {
  const rand = inp.rand ?? Math.random
  const [lo, hi] = window(inp.base, inp.tier)
  const q = (inp.qualityWeight ?? 0.05) * (1 - Math.min(100, Math.max(0, inp.dailyUsedPct)) / 100)
  const may = inp.tier !== 'deep' && inp.tier !== 'max' && inp.exploresLeft > 0
  const scores: Pick['scores'] = []
  const cost = (i: number) => expectedCost(i, inp.scope.global[String(i)], inp.now, inp.typical, inp.prices)
  const minN = inp.minSamples ?? 5
  const seen = (i: number) => decayed(inp.scope.kind[armName(i)] ?? inp.scope.global[armName(i)], inp.now).n
  const roll = may && rand() < (inp.explore ?? 0.1)
  let tried = false
  for (let i = lo; i <= hi; i++) {
    // No evidence, no move: a cheaper arm needs a record here (or the rare exploration roll),
    // a dearer one needs a record that the rule choice keeps failing.
    if (i < inp.base && seen(i) < minN && !(roll && i === inp.base - 1)) continue
    if (i > inp.base && seen(inp.base) < minN) continue
    if (i < inp.base && seen(i) < minN) tried = true
    const root = priorP(inp.w, inp.x, i, inp.base)
    const key = armName(i)
    const post = hierMean([inp.scope.global[key], inp.scope.kind[key], inp.scope.project[key]], root, inp.now)
    const p = sampleBeta(post.a, post.b, rand)
    const up = Math.min(ARMS.length - 1, i + 1)
    scores.push({ arm: i, p, score: cost(i) + (1 - p) * (cost(up) + q) })
  }
  if (scores.length === 0) return { arm: inp.base, why: 'smart: rule choice holds', explored: false, scores }
  if (tried) {
    // the exploration step: take it, but only the one cheaper step
    const t = scores.find(x => x.arm === inp.base - 1)
    if (t) return { arm: t.arm, why: `smart: trying ${armName(t.arm)}`, explored: true, scores }
  }
  scores.sort((a, b) => a.score - b.score)
  // dominance: drop an arm that is dearer than another and no more likely to work
  const kept = scores.filter(s => !scores.some(o => o !== s && cost(o.arm) <= cost(s.arm) && o.p >= s.p && (cost(o.arm) < cost(s.arm) || o.p > s.p)))
  const best = (kept[0] ?? scores[0])!
  const explored = false
  const why = best.arm === inp.base ? 'smart: rule choice holds' : best.arm < inp.base ? `smart: ${armName(best.arm)} (p≈${Math.round(best.p * 100)}%)${explored ? ', exploring' : ''}` : `smart: ${armName(best.arm)} (cheaper step has been failing here)`
  return { arm: best.arm, why, explored, scores }
}

// -- Store ------------------------------------------------------------------------------

export type SmartStore = {
  v: 1
  weights: Weights
  cells: Record<string, Record<string, Cell>> // scope key -> arm name -> cell
  explore: { day: string; n: number }
  seen: number
}

export const emptyStore = (): SmartStore => ({ v: 1, weights: {}, cells: {}, explore: { day: '', n: 0 }, seen: 0 })
export const MAX_SCOPES = 120

export const scopeKeys = (kind: string, projectHash: string) => ({ global: 'g', kind: `k:${kind}`, project: `p:${projectHash}:${kind}` })

export function scopeOf(s: SmartStore, kind: string, projectHash: string): Scope {
  const k = scopeKeys(kind, projectHash)
  return { global: s.cells[k.global] ?? {}, kind: s.cells[k.kind] ?? {}, project: s.cells[k.project] ?? {} }
}

export function exploresLeft(s: SmartStore, day: string, cap = 12): number {
  return s.explore.day === day ? Math.max(0, cap - s.explore.n) : cap
}

export function noteExplore(s: SmartStore, day: string): SmartStore {
  return { ...s, explore: { day, n: (s.explore.day === day ? s.explore.n : 0) + 1 } }
}

export type Outcome = { kind: string; project: string; arm: number; base: number; x: readonly number[]; ok: boolean; costUsd: number; now: number }

export function record(s: SmartStore, o: Outcome): SmartStore {
  const keys = scopeKeys(o.kind, o.project)
  const name = armName(o.arm)
  const cells = { ...s.cells }
  for (const key of [keys.global, keys.kind, keys.project]) cells[key] = { ...(cells[key] ?? {}), [name]: addToCell(cells[key]?.[name], o.now, o.ok, o.costUsd) }
  const names = Object.keys(cells)
  if (names.length > MAX_SCOPES) {
    const size = (k: string) => Object.values(cells[k] ?? {}).reduce((a, c) => a + c.n, 0)
    for (const k of names.filter(n => n !== 'g').sort((a, b) => size(a) - size(b)).slice(0, names.length - MAX_SCOPES)) delete cells[k]
  }
  return { ...s, cells, weights: trainWeights(s.weights, o.x, o.arm, o.base, o.ok), seen: s.seen + 1 }
}

/** The user's reply showed the last turn's outcome was the opposite. */
export function correct(s: SmartStore, o: Pick<Outcome, 'kind' | 'project' | 'arm' | 'base' | 'x'> & { toOk: boolean }): SmartStore {
  const keys = scopeKeys(o.kind, o.project)
  const name = armName(o.arm)
  const cells = { ...s.cells }
  for (const key of [keys.global, keys.kind, keys.project]) {
    const cur = cells[key]?.[name]
    const next = flipCell(cur, o.toOk)
    if (next && cur) cells[key] = { ...cells[key], [name]: next }
  }
  return { ...s, cells, weights: trainWeights(s.weights, o.x, o.arm, o.base, o.toOk, 0.1) }
}

/** A new model id arrived for a family: its old record no longer describes it, so fade it by half. */
export function fadeFamily(s: SmartStore, family: Family): SmartStore {
  const cells: SmartStore['cells'] = {}
  for (const [k, row] of Object.entries(s.cells)) {
    cells[k] = Object.fromEntries(Object.entries(row).map(([name, c]) => (name.startsWith(`${family}·`) ? [name, { ...c, s: c.s / 2, f: c.f / 2, c: c.c / 2, n: c.n / 2 }] : [name, c]))) as Record<string, Cell>
  }
  return { ...s, cells }
}

// -- Outcome signals -----------------------------------------------------------------------

export const THANKS_RE = /^\s*(thanks|thank you|thx|perfect|great|works|it works|nice|awesome|that worked|good job|looks good|lgtm)\b/i

function trigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, ' ').trim()
  const out = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
  return out
}

/** Dice similarity of two prompts: a quick rephrase of the same ask is a sign the first answer missed. */
export function similarity(a: string, b: string): number {
  const x = trigrams(a)
  const y = trigrams(b)
  if (x.size === 0 || y.size === 0) return 0
  let hit = 0
  for (const g of x) if (y.has(g)) hit++
  return (2 * hit) / (x.size + y.size)
}

export type FollowUp = 'redo' | 'rephrase' | 'ack' | 'none'

export function followUp(prev: string, text: string, sinceMs: number, redo: RegExp): FollowUp {
  if (redo.test(text)) return 'redo'
  if (sinceMs < 4 * 60_000 && prev.length > 20 && text.length > 20 && similarity(prev, text) > 0.6) return 'rephrase'
  if (sinceMs < 15 * 60_000 && THANKS_RE.test(text) && text.length < 80) return 'ack'
  return 'none'
}

// -- Reporting ---------------------------------------------------------------------------

/** What the learner has seen, per kind of work. Used by `/budget learn`. */
export function smartSummary(s: SmartStore, now: number): string[] {
  const rows: string[] = []
  for (const [key, row] of Object.entries(s.cells)) {
    if (!key.startsWith('k:')) continue
    const parts = Object.entries(row)
      .map(([name, c]) => ({ name, c: decayed(c, now) }))
      .filter(x => x.c.n >= 0.5)
      .map(x => `${x.name} ${Math.round((100 * x.c.s) / Math.max(1e-9, x.c.s + x.c.f))}% of ${Math.round(x.c.n)}, $${(x.c.c / Math.max(1e-9, x.c.n)).toFixed(3)}/turn`)
    if (parts.length > 0) rows.push(`    ${key.slice(2)}: ${parts.join('; ')}`)
  }
  return rows.slice(0, 8)
}

/** Money the learner saved versus always taking the rule choice, from the arm costs it has measured. */
export function estimateSavings(s: SmartStore, now: number): number {
  const g = s.cells.g ?? {}
  let saved = 0
  for (const [name, c0] of Object.entries(g)) {
    const idx = ARMS.findIndex((_, i) => armName(i) === name)
    const c = decayed(c0, now)
    if (idx < 1 || c.n < 3) continue
    const up = decayed(g[armName(idx + 1)], now)
    if (up.n < 3) continue
    saved += Math.max(0, up.c / up.n - c.c / c.n) * c.n * 0.5
  }
  return saved
}
