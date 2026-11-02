import type { EngineInterface, PluginOptions, Register, SessionRateLimit } from 'claude-code'
import { addPace, isUnrealBuildPrompt, projectExhaustion, shouldStick } from './policy'
import type { PaceSample } from './policy'
import { applyEscalation, escalationFor, pacerStep, paceSteps, shiftLadder, targetPercent } from './policy'
import type { PacerState } from './policy'
import { ARMS, armIndex, armName, correct as smartCorrect, emptyStore, exploresLeft, features, followUp, noteExplore, pickArm, record as smartRecord, scopeOf, fadeFamily, kindOf, stepBucket, turnCostUsd, DEFAULT_PRICES, priceFor } from './smart'
import type { Momentum, Price, SmartStore, Usage } from './smart'
import { LADDER_SIZE, REDO_RE, bucketOf, flipOutcome, idleRebuild, idleText, ladderIndex, learnedMove, recordOutcome, sizeBucket, sizeNudgeText } from './policy'
import type { Learned } from './policy'

// budget-router: picks the model and effort for every main-thread turn from
// what the prompt asks for, and tightens that choice as today's share of the
// account's usage limits runs down (50% -> first cap, 80% -> second cap; at
// 100% turns stay at the second cap, nothing is refused). Subagents are only
// ever capped, never raised. It registers no tools or commands, adds nothing to
// the prompt, and passes every event it does not route on unchanged.

type Family = 'haiku' | 'sonnet' | 'opus'
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type Tier = 'trivial' | 'light' | 'standard' | 'deep' | 'max'
type Spec = { family: Family; effort: Effort }
type Route = Spec & { tier: Tier; why: string; rung?: number }
type Pin = { tier?: Tier; spec?: Spec }

// Today's share of the weekly limit, kept in the plugin store so every
// session (and the next day) sees the same numbers. Percent points are the
// seven_day window's own units.
type Ledger = {
  day: string
  windowReset: string
  windowStartPct: number
  carry: number
  lastPct: number
  budgetPts: number
  fiveHourPct: number
  fiveHourReset?: string
  alerted: number
  wrapped?: boolean // the wrap-up notice was given today
  seenAt: number
}

type Pressure = {
  daily: number
  five: number
  week: number
  usedPts: number
  budgetPts: number
  level: 0 | 1 | 2 | 3
}

type Opts = {
  tiers: Record<Tier, Spec>
  warnPercent: number
  wrapUpPercent: number
  warnCap: Spec
  criticalPercent: number
  criticalCap: Spec
  includeFiveHour: boolean
  haikuMaxContext: number
  stickyContext: number
  models: Record<Family, string>
  pin?: Pin
  unrealRules: boolean
  cacheWarmMinutes: number
  paceWarnHours: number
  escalateOnTrouble: boolean
  escalateAfterErrors: number
  escalateModelAfterErrors: number
  paceControl: boolean
  dayStartHour: number
  dayEndHour: number
  paceSlack: number
  idleGuard: string
  idleMinContext: number
  nudgeContext: number
  learn: boolean
  learnMinSamples: number
  learnExplore: number
  learnMode: 'live' | 'shadow' | 'classic' | 'off'
  qualityWeight: number
  priceTable?: Record<Family, Price>
}

const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TIERS: readonly Tier[] = ['trivial', 'light', 'standard', 'deep', 'max']
const LEVEL_NAMES = ['normal', 'capped', 'capped hard', 'spent'] as const
const DAY_MS = 86_400_000
const STORE_KEY = 'ledger'
const MODELS_KEY = 'models'

// turn.step takes full model ids, not aliases. These are the current ones;
// ids seen on real requests (the session's model, a subagent's) replace them.
const KNOWN_IDS: Record<Family, string> = {
  haiku: 'claude-haiku-5-5', // $0.10/$0.50 up to a 100K prompt; 4.5 was $1/$5
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

const MAX_RE = /\b(ultrathink|think\s+(really\s+|very\s+)?hard(er)?|think\s+deeply|think\s+carefully)\b/i
const CONTINUE_RE =
  /^\s*(ok(ay)?|yes|yep|yeah|y|sure|go( on| ahead)?|continue|proceed|do it|go for it|carry on|next|ναι|οκ|εντάξει|συνέχισε|προχώρα)\s*[.!]*\s*$/i
const TRIVIAL_RE = /^\s*(hi|hello|hey|thanks?|thank you|ty|cool|nice|great|ευχαριστώ|γεια)\b/i
const DEEP_RE =
  /\b(architect\w*|design|refactor\w*|security|vulnerab\w*|root cause|investigat\w*|race condition|deadlock|memory leak|performance|optimi[sz]\w*|migrat\w*|research|trade-?offs?|strategy|audit|bypass)\b/i

const rankF = (f: Family) => FAMILIES.indexOf(f)
const rankE = (e: Effort) => EFFORTS.indexOf(e)

function parseSpec(value: unknown, fallback: Spec): Spec {
  const [f = '', e = ''] = String(value ?? '')
    .toLowerCase()
    .split(':')
    .map(s => s.trim())
  return {
    family: FAMILIES.includes(f as Family) ? (f as Family) : fallback.family,
    effort: EFFORTS.includes(e as Effort) ? (e as Effort) : fallback.effort,
  }
}

function capSpec(s: Spec, cap: Spec): Spec {
  return {
    family: rankF(s.family) > rankF(cap.family) ? cap.family : s.family,
    effort: rankE(s.effort) > rankE(cap.effort) ? cap.effort : s.effort,
  }
}

function familyOf(model: string): Family {
  const m = model.toLowerCase()
  return m.includes('haiku') ? 'haiku' : m.includes('sonnet') ? 'sonnet' : 'opus'
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)

// priceTable: {"haiku":{"inp":1,"out":5,"read":0.1,"write":1.25},"sonnet":{...},"opus":{...}}, USD per million tokens.
function parsePrices(raw: unknown): Record<Family, Price> | undefined {
  try {
    const t = typeof raw === 'string' && raw.trim() !== '' ? (JSON.parse(raw) as Record<string, Partial<Price>>) : undefined
    if (!t) return undefined
    const out = { ...DEFAULT_PRICES }
    for (const f of FAMILIES) {
      const p = t[f]
      if (p && [p.inp, p.out, p.read, p.write].every(n => typeof n === 'number' && n >= 0)) out[f] = p as Price
    }
    return out
  } catch {
    return undefined
  }
}

function readOptions(options: PluginOptions): Opts {
  return {
    tiers: {
      trivial: parseSpec(options.tierTrivial, { family: 'haiku', effort: 'low' }),
      light: parseSpec(options.tierLight, { family: 'sonnet', effort: 'low' }),
      standard: parseSpec(options.tierStandard, { family: 'sonnet', effort: 'high' }),
      deep: parseSpec(options.tierDeep, { family: 'opus', effort: 'high' }),
      max: parseSpec(options.tierMax, { family: 'opus', effort: 'xhigh' }),
    },
    warnPercent: num(options.warnPercent, 50),
    wrapUpPercent: num(options.wrapUpPercent, 90),
    warnCap: parseSpec(options.warnCap, { family: 'sonnet', effort: 'high' }),
    criticalPercent: num(options.criticalPercent, 80),
    criticalCap: parseSpec(options.criticalCap, { family: 'haiku', effort: 'medium' }),
    includeFiveHour: bool(options.includeFiveHour, true),
    haikuMaxContext: num(options.haikuMaxContext, 100_000),
    stickyContext: num(options.stickyContext, 60_000),
    models: {
      haiku: str(options.haikuModel, 'haiku'),
      sonnet: str(options.sonnetModel, 'sonnet'),
      opus: str(options.opusModel, 'opus'),
    },
    pin: parsePin(options.pin),
    unrealRules: bool(options.unrealRules, true),
    cacheWarmMinutes: num(options.cacheWarmMinutes, 55),
    paceWarnHours: num(options.paceWarnHours, 3),
    escalateOnTrouble: bool(options.escalateOnTrouble, true),
    escalateAfterErrors: num(options.escalateAfterErrors, 3),
    escalateModelAfterErrors: num(options.escalateModelAfterErrors, 6),
    paceControl: bool(options.paceControl, true),
    dayStartHour: num(options.dayStartHour, 8),
    dayEndHour: num(options.dayEndHour, 24),
    paceSlack: num(options.paceSlack, 15),
    idleGuard: ['off', 'warn'].includes(str(options.idleGuard, 'warn')) ? str(options.idleGuard, 'warn') : 'warn',
    idleMinContext: num(options.idleMinContext, 60_000),
    nudgeContext: num(options.nudgeContext, 150_000),
    learn: bool(options.learn, true),
    learnMinSamples: num(options.learnMinSamples, 8),
    learnExplore: num(options.learnExplore, 0.1),
    learnMode: (['live', 'shadow', 'classic', 'off'].includes(str(options.learnMode, 'live')) ? str(options.learnMode, 'live') : 'live') as Opts['learnMode'],
    qualityWeight: num(options.qualityWeight, 0.05),
    priceTable: parsePrices(options.priceTable),
  }
}

/** The `pin` option: blank or `auto` routes automatically; a tier name or `model[:effort]` fixes the route. */
function parsePin(raw: unknown): Pin | undefined {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === '' || v === 'auto') return undefined
  if (TIERS.includes(v as Tier)) return { tier: v as Tier }
  const [f = '', e = ''] = v.split(/[:·\s]+/)
  if (!FAMILIES.includes(f as Family)) return undefined
  return { spec: { family: f as Family, effort: EFFORTS.includes(e as Effort) ? (e as Effort) : 'high' } }
}

// Session-local: the options, the route the current turn runs on, the pin from
// the options, the last known context size and budget level. A reload starts them over.
let o: Opts = readOptions({})
let route: Route | undefined
let pin: Pin | undefined
let ctxTokens = 0
let level: Pressure['level'] = 0
let tzMin = -new Date().getTimezoneOffset()
let learned: Partial<Record<Family, string>> = {}
let lastMainTurnAt = 0 // when the last main-conversation turn ended (the prompt cache is warm for a while after)
let paceWarnedDay = ''
let paceNote = ''

const isAlias = (v: string) => FAMILIES.includes(v.toLowerCase() as Family)
const modelId = (f: Family) => (isAlias(o.models[f]) ? (learned[f] ?? KNOWN_IDS[f]) : o.models[f])

async function learn($: EngineInterface, model: string) {
  const f = familyOf(model)
  // Fable and Mythos rank above Opus but are not a tier this router routes to; never adopt one as the Opus id.
  if (!/^claude-/.test(model) || /fable|mythos/i.test(model) || learned[f] === model) return
  const hadOlder = learned[f] !== undefined
  learned = { ...learned, [f]: model }
  if (hadOlder) {
    if (!v06Loaded) await loadV06($)
    smartData = fadeFamily(smartData, f)
    await $.store.set(SMART_KEY, smartData)
  }
  await $.store.set(MODELS_KEY, learned)
}

const localDay = (ms: number) => new Date(ms + tzMin * 60_000).toISOString().slice(0, 10)
const clock = (ms: number) => new Date(ms + tzMin * 60_000).toISOString().slice(11, 16)
const nextMidnight = (ms: number) => {
  const d = new Date(ms + tzMin * 60_000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - tzMin * 60_000
}

function absorb(prev: Ledger | undefined, limits: readonly SessionRateLimit[], now: number): Ledger | undefined {
  const week = limits.find(l => l.kind === 'seven_day')
  const five = limits.find(l => l.kind === 'five_hour')
  if (!week) {
    return prev && five ? { ...prev, fiveHourPct: five.percentUsed, fiveHourReset: five.resetsAt, seenAt: now } : prev
  }
  const pct = week.percentUsed
  const reset = week.resetsAt ?? prev?.windowReset ?? new Date(now + 7 * DAY_MS).toISOString()
  const resetMs = Date.parse(reset)
  const daysLeft = Math.max(1, Math.ceil((resetMs - now) / DAY_MS))
  const day = localDay(now)
  const isSameWindow =
    prev !== undefined && Math.abs(Date.parse(prev.windowReset) - resetMs) < 6 * 3_600_000 && pct + 3 >= prev.lastPct

  let l: Ledger
  if (!prev || prev.day !== day) {
    // First reading of the day: today may spend an even share of what is
    // left of the week, so a quiet day leaves more for the next ones.
    l = {
      day,
      windowReset: reset,
      windowStartPct: pct,
      carry: 0,
      lastPct: pct,
      budgetPts: Math.max(0.5, (100 - pct) / daysLeft),
      fiveHourPct: 0,
      alerted: 0,
      seenAt: now,
    }
  } else if (!isSameWindow) {
    // The weekly window reset during the day: keep what today already
    // spent and grant at least an even share of the fresh week.
    l = {
      ...prev,
      carry: prev.carry + Math.max(0, prev.lastPct - prev.windowStartPct),
      windowStartPct: 0,
      budgetPts: Math.max(prev.budgetPts, 100 / daysLeft),
    }
  } else {
    l = { ...prev }
  }
  l.lastPct = pct
  l.windowReset = reset
  l.fiveHourPct = five?.percentUsed ?? 0
  l.fiveHourReset = five?.resetsAt
  l.seenAt = now
  return l
}

function pressure(l: Ledger | undefined, now: number): Pressure {
  if (!l || l.day !== localDay(now)) {
    return { daily: 0, five: 0, week: l?.lastPct ?? 0, usedPts: 0, budgetPts: l?.budgetPts ?? 0, level: 0 }
  }
  const usedPts = l.carry + Math.max(0, l.lastPct - l.windowStartPct)
  const daily = l.budgetPts > 0 ? (usedPts / l.budgetPts) * 100 : 0
  const five = l.fiveHourReset && Date.parse(l.fiveHourReset) > now ? l.fiveHourPct : 0
  const worst = Math.max(daily, o.includeFiveHour ? five : 0)
  const lvl = daily >= 100 ? 3 : worst >= o.criticalPercent ? 2 : worst >= o.warnPercent ? 1 : 0
  return { daily, five, week: l.lastPct, usedPts, budgetPts: l.budgetPts, level: lvl }
}

const loadLedger = async ($: EngineInterface) => (await $.store.get(STORE_KEY)) as Ledger | undefined

const PACE_KEY = 'pace'

// Samples of today's budget use over time: the burn rate, and a one-time heads-up
// when the last 90 minutes' pace would use the whole day's budget within a few hours.
async function paceWatch($: EngineInterface, p: Pressure, now: number) {
  try {
    const samples = addPace(((await $.store.get(PACE_KEY)) as PaceSample[] | undefined) ?? [], { t: now, daily: p.daily })
    await $.store.set(PACE_KEY, samples)
    const pr = projectExhaustion(samples, now)
    paceNote = ''
    if (pr?.at !== undefined && pr.at < nextMidnight(now)) {
      paceNote = `at the last 90 minutes' pace (${Math.round(pr.ratePerHour)}% of the day per hour) today's budget runs out around ${clock(pr.at)}`
      if (p.level < 2 && (pr.at - now) / 3_600_000 <= o.paceWarnHours && paceWarnedDay !== localDay(now)) {
        paceWarnedDay = localDay(now)
        $.ui.toast(`⏱ ${paceNote}. Setting the plugin's pin option to light or haiku in /config slows it down.`, { timeoutMs: 20_000 })
      }
    } else if (pr) {
      paceNote = `pace ${Math.round(pr.ratePerHour)}% of the day per hour: fine for today`
    }
  } catch {
    // the forecast is a courtesy
  }
}

// ---- pace controller and escalation ----
const PACER_KEY = 'pacer'
let pacerU = 0 // controller output: how many cost steps to shed (0 to 2)
let escalation: { turnId: string; effortUp: boolean; modelUp: boolean } | undefined

async function pacerUpdate($: EngineInterface, p: Pressure, now: number) {
  if (!o.paceControl) {
    pacerU = 0
    return
  }
  try {
    const local = new Date(now + tzMin * 60_000)
    const hour = local.getUTCHours() + local.getUTCMinutes() / 60
    const target = targetPercent(hour, o.dayStartHour, o.dayEndHour)
    const prev = (await $.store.get(PACER_KEY)) as PacerState | undefined
    const next = pacerStep(prev, localDay(now), now, p.daily - (target + o.paceSlack))
    await $.store.set(PACER_KEY, next)
    pacerU = next.u
  } catch {
    // the pacer is an optimisation; never block work for it
  }
}

// ---- v0.6: ghost-token guard, learner ----
const BANDIT_KEY = 'bandit'
let learnedData: Learned = {}
let turnErrors = 0 // failed tool calls since the last prompt, counted as they happen
let v06Loaded = false
let lastSizeBucket = 0
let currentBucket = ''
let pending: { bucket: string; rung: number; text: string } | undefined
let lastOutcome: { bucket: string; rung: number; ok: boolean; at: number } | undefined
// Smart learner (0.8): cost-aware bandit, see smart.ts. Stores only counts, costs and hashed weights.
const SMART_KEY = 'smart'
let smartData: SmartStore = emptyStore()
type SmartPending = { kind: string; project: string; arm: number; base: number; x: number[]; text: string; shadow: boolean }
let smartPending: SmartPending | undefined
let smartLast: (SmartPending & { ok: boolean; at: number }) | undefined
let smartProject = 'x'
let smartX: number[] = []
let smartKind = 'ask'
let smartPrev: Momentum = 'none'
let stepsNow = 0 // steps taken by the current main turn
let lastSteps: number | undefined // steps in the previous main turn of this session
let smartText = ''
let lastTurnUsage: Usage = { inp: 2000, out: 1500, cr: 40000, cc: 3000 }
const dayKey = () => localDay(Date.now())
const projectHash = (cwd: string) => {
  let h = 5381
  for (let i = 0; i < cwd.length; i++) h = (Math.imul(h, 33) ^ cwd.charCodeAt(i)) >>> 0
  return cwd === '' ? 'x' : h.toString(36)
}
// The project folder, hashed, from the session's own working directory.
function setProject(dir: string) {
  if (dir === '') return false
  smartProject = projectHash(dir.toLowerCase())
  return true
}
async function detectProject($: EngineInterface) {
  try {
    setProject(await $.session.cwd())
  } catch {
    // no project hash
  }
}
const smartOn = () => o.learn && (o.learnMode === 'live' || o.learnMode === 'shadow')

// Data older versions kept and this one no longer has a use for: deleted at start.
const RETIRED_KEYS = ['cmdstats', 'runbooks', 'decisions']
async function loadV06($: EngineInterface) {
  for (const key of RETIRED_KEYS) await $.store.delete(key)
  learnedData = ((await $.store.get(BANDIT_KEY)) as Learned | undefined) ?? {}
  const stored = (await $.store.get(SMART_KEY)) as (Omit<SmartStore, 'v'> & { v?: number }) | undefined
  // Version 1 weights were partly trained on hashed words of prompts: dropped, the counts are kept.
  smartData = stored ? { ...stored, v: 2, weights: stored.v === 2 ? stored.weights : {} } : emptyStore()
  v06Loaded = true
}

// Watches tool calls without changing them: counts failed calls since the last prompt (for
// escalation and the learner). It never looks at what a call was asked to do.
async function observeTool(e: { agentId?: string }, failed: boolean) {
  if (e.agentId !== undefined) return
  if (failed) turnErrors++
}

// After each main turn: record how it went for the learner.
async function afterMainTurn($: EngineInterface, e: { answer: string; isAborted: boolean }, u?: Usage & { family: Family; model: string }) {
  if (!v06Loaded) await loadV06($)
  lastSteps = stepsNow
  if (u) lastTurnUsage = { inp: u.inp, out: u.out, cr: u.cr, cc: u.cc }
  if (o.learn && smartPending) {
    const sp = smartPending
    smartPending = undefined
    try {
      const ok = !e.isAborted && turnErrors <= 1
      const cost = u ? turnCostUsd(u.family, u, o.priceTable ? o.priceTable : { ...DEFAULT_PRICES, [u.family]: priceFor(u.model, u.family) }) : 0
      smartLast = { ...sp, ok, at: Date.now() }
      smartData = smartRecord(smartData, { kind: sp.kind, project: sp.project, arm: sp.arm, base: sp.base, x: sp.x, ok, costUsd: cost, now: Date.now() })
      await $.store.set(SMART_KEY, smartData)
    } catch {
      // learning is optional
    }
  }
  if (!o.learn || !pending) return
  const done = pending
  pending = undefined
  try {
    let ok = !e.isAborted && turnErrors <= 1
    learnedData = recordOutcome(learnedData, done.bucket, done.rung, ok)
    lastOutcome = { bucket: done.bucket, rung: done.rung, ok, at: Date.now() }
    await $.store.set(BANDIT_KEY, learnedData)
  } catch {
    // learning is optional
  }
}



// A turn with several failed tool calls gets more effort, and after a long run a stronger model.
// Effort changes keep the prompt cache on the 5.5 models; a model step happens at most once a turn.
async function troubleAdjust($: EngineInterface, e: { turnId: string; index: number }, base: Spec): Promise<Spec> {
  if (!o.escalateOnTrouble || pin) return base
  if (escalation && escalation.turnId !== e.turnId) escalation = undefined
  if (e.index >= 2 && !escalation?.modelUp) {
    try {
      const errors = turnErrors
      const esc = escalationFor(errors, o.escalateAfterErrors, o.escalateModelAfterErrors)
      if (esc.effortUp || esc.modelUp) {
        const before = escalation
        const merged = { turnId: e.turnId, effortUp: esc.effortUp || before?.effortUp === true, modelUp: esc.modelUp || before?.modelUp === true }
        if (!before || before.effortUp !== merged.effortUp || before.modelUp !== merged.modelUp) escalation = merged
      }
    } catch {
      // keep the route as chosen
    }
  }
  if (!escalation) return base
  const raised = applyEscalation(base, escalation)
  return level >= 2 ? capSpec(raised, o.criticalCap) : level === 1 ? capSpec(raised, o.warnCap) : raised
}

function heuristic(text: string, prev: Tier | undefined): { tier: Tier; why: string } {
  if (DEEP_RE.test(text)) return { tier: 'deep', why: 'keywords' }
  if (text.length < 60 && TRIVIAL_RE.test(text)) return { tier: 'trivial', why: 'keywords' }
  return { tier: prev && prev !== 'trivial' ? prev : 'standard', why: 'default' }
}

function classify(raw: string, prev: Tier | undefined) {
  const text = raw.trim()
  if (MAX_RE.test(text)) return { tier: 'max' as Tier, why: 'asked to think hard' }
  if (CONTINUE_RE.test(text)) return { tier: prev ?? 'standard', why: 'continuation' }
  return heuristic(text, prev)
}

// Weekly percent used per model family, when the plan reports one.
let famWeekly: Partial<Record<Family, number>> = {}
const FAMILY_FULL = 92

let smartDecision: { kind: string; base: number; arm: number; shadowArm: number; why: string; explored: boolean } | undefined
const pickToSpec = (arm: number): Spec => {
  const a = ARMS[arm]!
  return { family: a.family, effort: a.effort } as Spec
}

function decide(tier: Tier, why: string, p: Pressure): Route {
  const notes = [why]
  let spec = pin?.spec ?? o.tiers[tier]
  const last = route
  if (!pin && last && spec.family !== last.family) {
    // Switching model re-caches the whole conversation; a one-step change on a
    // long conversation costs more than it saves, but only while the cache is
    // still warm (the last turn ended recently).
    const dist = Math.abs(rankF(spec.family) - rankF(last.family))
    const sinceLast = lastMainTurnAt > 0 ? Date.now() - lastMainTurnAt : undefined
    if (shouldStick({ ctx: ctxTokens, stickyContext: o.stickyContext, stepDistance: dist, sinceLastTurnMs: sinceLast, warmMs: o.cacheWarmMinutes * 60_000 })) {
      spec = { ...spec, family: last.family }
      notes.push('sticky')
    } else if (dist === 1 && ctxTokens >= o.stickyContext) {
      notes.push('cache cold, switched freely')
    }
  }
  // The learner: move one rung on evidence from earlier outcomes of this kind of prompt.
  smartDecision = undefined
  if (smartOn() && !pin && currentBucket !== '') {
    const base = armIndex(spec)
    const kind = smartKind
    const now = Date.now()
    const pick = pickArm({ base, tier, scope: scopeOf(smartData, kind, smartProject), w: smartData.weights, x: smartX, now, dailyUsedPct: p.daily, qualityWeight: o.qualityWeight, typical: lastTurnUsage, exploresLeft: exploresLeft(smartData, dayKey()), minSamples: o.learnMinSamples, explore: o.learnExplore, rand: Math.random })
    const live = o.learnMode === 'live'
    smartDecision = { kind, base, arm: live ? pick.arm : base, shadowArm: pick.arm, why: pick.why, explored: pick.explored && live }
    if (live && pick.arm !== base) {
      const a = pickToSpec(pick.arm)
      spec = a
      notes.push(pick.why)
    } else if (!live && pick.arm !== base) notes.push(`shadow: would pick ${armName(pick.arm)}`)
  }
  if (o.learn && o.learnMode === 'classic' && !pin && tier !== 'max' && currentBucket !== '') {
    const mv = learnedMove(learnedData, currentBucket, ladderIndex(spec), LADDER_SIZE, { minSamples: o.learnMinSamples, target: 0.85, explore: o.learnExplore, rand: Math.random })
    if (mv) {
      const moved = shiftLadder(spec, mv.steps)
      if (moved.family !== spec.family || moved.effort !== spec.effort) {
        spec = moved
        notes.push(mv.why)
      }
    }
  }
  // A model whose own weekly limit is nearly spent is skipped, one family down.
  if (!pin) {
    for (let n = 0; n < 2; n++) {
      const used = famWeekly[spec.family]
      if (used === undefined || used < FAMILY_FULL || spec.family === 'haiku') break
      const down: Family = spec.family === 'opus' ? 'sonnet' : 'haiku'
      notes.push(`${spec.family} weekly ${Math.round(used)}% used`)
      spec = { family: down, effort: spec.effort === 'max' || spec.effort === 'xhigh' ? 'high' : spec.effort } as Spec
    }
  }
  // Pace control: spending ahead of an even day sheds one or two cost steps before any cap
  // applies. An explicit "think hard" (max) and a pinned route are left alone.
  const shed = o.paceControl && !pin && tier !== 'max' ? paceSteps(pacerU) : 0
  if (shed > 0) {
    const lowered = shiftLadder(spec, shed)
    if (lowered.family !== spec.family || lowered.effort !== spec.effort) {
      spec = lowered
      notes.push(`pace -${shed}`)
    }
  }
  if (p.level === 1) spec = capSpec(spec, o.warnCap)
  if (p.level >= 2) spec = capSpec(spec, o.criticalCap)
  if (p.level >= 1) notes.push(`cap ${LEVEL_NAMES[p.level]}`)
  if (spec.family === 'haiku' && ctxTokens > o.haikuMaxContext) {
    spec = { family: 'sonnet', effort: p.level >= 2 ? 'low' : spec.effort }
    notes.push('too long for haiku')
  }
  return { ...spec, tier, why: notes.join(', '), rung: ladderIndex(spec) }
}

function showStatus($: EngineInterface, p: Pressure) {
  const r = route
  const head = r ? `${r.family}·${r.effort} (${r.tier}${pin ? ', pinned' : ''})` : 'route: auto'
  const warn = p.level === 3 ? '⛔ ' : p.level > 0 ? '⚠ ' : ''
  const five = p.five > 0 ? ` │ 5h ${Math.round(p.five)}%` : ''
  const saved = smartOn() && (smartData.saved ?? 0) >= 0.05 ? ` │ saved $${(smartData.saved ?? 0).toFixed(2)}` : ''
  $.ui.status(`${warn}${head} │ day ${Math.round(p.daily)}%${five} │ week ${Math.round(p.week)}%${saved}`)
}

function alert($: EngineInterface, p: Pressure, now: number) {
  const day = `${Math.round(p.daily)}% of today's budget`
  const why = p.daily >= o.warnPercent || !o.includeFiveHour ? day : `5-hour window at ${Math.round(p.five)}%`
  const text =
    p.level === 3
      ? `⛔ Today's Claude budget is spent (${day}). Turns stay at ${o.criticalCap.family}·${o.criticalCap.effort}; nothing is refused. A new share starts at ${clock(nextMidnight(now))}.`
      : p.level === 2
        ? `⚠⚠ Claude usage: ${why}. Turns are now capped at ${o.criticalCap.family}·${o.criticalCap.effort}.`
        : `⚠ Claude usage: ${why}. Turns are now capped at ${o.warnCap.family}·${o.warnCap.effort}.`
  $.ui.toast(text, { timeoutMs: 20_000 })
  void $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text: `budget-router: ${text}` }] } })
    .catch(() => undefined)
}

function wrapUp($: EngineInterface, p: Pressure, now: number) {
  const left = Math.max(0, Math.round(100 - p.daily))
  const lock = `Turns stay at ${o.criticalCap.family}·${o.criticalCap.effort} from 100%; no prompt is ever refused`
  const text = `⏳ ${Math.round(p.daily)}% of today's Claude budget is used (about ${left}% left). Good moment to finish what is in hand, commit, and note where you stopped. ${lock}.`
  $.ui.toast(text, { timeoutMs: 25_000 })
  void $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text: `budget-router: ${text}` }] } })
    .catch(() => undefined)
}

export const register: Register = (on, options) => {
  o = readOptions(options)
  pin = o.pin

  // Loads what the plugin stored (budget ledger, model ids seen, pace, learner counts) and the
  // working folder's name, hashed. Registers nothing.
  on('session.start', async ($, e, next) => {
    await detectProject($)
    learned = ((await $.store.get(MODELS_KEY)) as typeof learned | undefined) ?? {}
    const savedPacer = (await $.store.get(PACER_KEY)) as PacerState | undefined
    pacerU = savedPacer && savedPacer.day === localDay(Date.now()) ? savedPacer.u : 0
    await loadV06($)
    const p = pressure(await loadLedger($), Date.now())
    level = p.level
    showStatus($, p)
    return next(e)
  })

  // Reads the rate-limit and context figures Claude Code reports; passes the event on unchanged.
  on('session.measure', async ($, e, next) => {
    ctxTokens = e.context.tokens ?? ctxTokens
    if (o.nudgeContext > 0) {
      const b = sizeBucket(ctxTokens, o.nudgeContext)
      if (b > lastSizeBucket) $.ui.toast(sizeNudgeText(ctxTokens, route?.family ?? 'sonnet'), { timeoutMs: 20_000 })
      lastSizeBucket = b
    }
    const now = Date.now()
    // Some plans report a weekly limit per model (seven_day_opus, seven_day_sonnet).
    famWeekly = {}
    for (const r of e.rateLimits) {
      const m = /^seven_day_(opus|sonnet)$/.exec(r.kind)
      if (m) famWeekly[m[1] as Family] = r.percentUsed
    }
    const prev = await loadLedger($)
    const l = absorb(prev, e.rateLimits, now)
    if (l) {
      const p = pressure(l, now)
      if (p.level > l.alerted) {
        alert($, p, now)
        l.alerted = p.level
      }
      // One heads-up before the second cap holds for the rest of the day, so there is time to finish.
      if (o.wrapUpPercent > 0 && !l.wrapped && p.level < 3 && p.daily >= o.wrapUpPercent) {
        l.wrapped = true
        wrapUp($, p, now)
      }
      if (l !== prev) await $.store.set(STORE_KEY, l)
      level = p.level
      showStatus($, p)
      await paceWatch($, p, now)
      await pacerUpdate($, p, now)
    }
    return next(e)
  })

  // Reads the typed prompt to choose the route for the turn. The prompt is passed on exactly as received.
  on('prompt.submit', async ($, e, next) => {
    const now = Date.now()
    const p = pressure(await loadLedger($), now)
    level = p.level
    if (!v06Loaded) await loadV06($)
    // A prompt typed into a running turn rides that turn's model.
    if (e.turnId === undefined && ['composer', 'bridge', 'sdk'].includes(e.origin.kind)) {
      try {
        ctxTokens = (await $.session.usage()).context.tokens ?? ctxTokens
      } catch {
        // keep the last known size
      }
      turnErrors = 0
      // Follow-ups tell how the last turn went: a redo or a quick rephrase means it missed, thanks means it hit.
      if (smartOn() && smartLast && now - smartLast.at < 15 * 60_000) {
        const f = followUp(smartText, e.text, now - smartLast.at, REDO_RE)
        const toOk = f === 'ack' ? true : f === 'redo' || f === 'rephrase' ? false : undefined
        if (toOk !== undefined && toOk !== smartLast.ok) {
          smartData = smartCorrect(smartData, { kind: smartLast.kind, project: smartLast.project, arm: smartLast.arm, base: smartLast.base, x: smartLast.x, toOk })
          smartLast = { ...smartLast, ok: toOk }
          await $.store.set(SMART_KEY, smartData)
        }
      }
      smartText = e.text
      // A redo or correction right after a "successful" turn means it was not.
      if (o.learn && o.learnMode === 'classic' && lastOutcome?.ok && now - lastOutcome.at < 15 * 60_000 && REDO_RE.test(e.text)) {
        learnedData = flipOutcome(learnedData, lastOutcome.bucket, lastOutcome.rung)
        lastOutcome = { ...lastOutcome, ok: false }
        await $.store.set(BANDIT_KEY, learnedData)
      }
      // Ghost-token guard: after a long pause the cache has expired and the whole context is re-written.
      const idle = o.idleGuard === 'off' ? undefined : idleRebuild(ctxTokens, lastMainTurnAt > 0 ? now - lastMainTurnAt : undefined, o.cacheWarmMinutes * 60_000, o.idleMinContext, route?.family ?? 'sonnet')
      if (idle) $.ui.toast(idleText(idle), { timeoutMs: 20_000 })
      let c: { tier: Tier; why: string } = pin ? { tier: pin.tier ?? route?.tier ?? 'standard', why: 'pinned' } : classify(e.text, route?.tier)
      // Build, link and cook errors need more than the cheapest tier.
      if (o.unrealRules && !pin && isUnrealBuildPrompt(e.text) && (c.tier === 'trivial' || c.tier === 'light')) {
        c = { tier: 'standard', why: `${c.why}; unreal build text` }
      }
      currentBucket = o.learn ? bucketOf(c.tier, e.text) : ''
      smartPrev = stepBucket(lastSteps)
      stepsNow = 0
      smartX = features(e.text, ctxTokens, smartPrev)
      smartKind = kindOf(e.text)
      route = decide(c.tier, c.why, p)
      if (smartDecision) {
        smartPending = pin ? undefined : { kind: smartDecision.kind, project: smartProject, arm: smartDecision.arm, base: smartDecision.base, x: smartX, text: e.text.slice(0, 300), shadow: o.learnMode === 'shadow' }
        if (smartDecision.explored) smartData = noteExplore(smartData, dayKey())
      }
      pending = o.learn && !pin ? { bucket: currentBucket, rung: route.rung ?? 0, text: e.text.slice(0, 300) } : undefined
    }
    showStatus($, p)
    return next(e)
  }).catch(($, e, next) => next(e)) // a failure here never stops the prompt: it goes on unchanged

  // Sets model and effort for each request: the route for main-conversation turns; subagents are only capped.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      // Subagents keep the model they were given; past a threshold they are
      // capped too, but never pushed down to Haiku (their context is unknown).
      await learn($, e.model)
      if (level === 0) return yield* next(e)
      const effort: Effort = typeof e.effort === 'string' ? e.effort : 'high'
      const cur: Spec = { family: familyOf(e.model), effort }
      let cap = level >= 2 ? o.criticalCap : o.warnCap
      if (cap.family === 'haiku' && cur.family !== 'haiku') cap = { family: 'sonnet', effort: 'low' }
      const s = capSpec(cur, cap)
      if (s.family === cur.family && s.effort === cur.effort) return yield* next(e)
      return yield* next({
        ...e,
        model: modelId(s.family),
        ...(e.effort === undefined ? {} : { effort: s.effort }),
      })
    }
    await learn($, e.model)
    stepsNow++
    const base = route ?? capSpec(o.tiers.standard, level >= 2 ? o.criticalCap : level === 1 ? o.warnCap : o.tiers.max)
    const spec = await troubleAdjust($, e, base)
    return yield* next({ ...e, model: modelId(spec.family), effort: spec.effort })
  }).catch(async function* ($, e, next) {
    return yield* next(e) // a failure here leaves the request on the model Claude Code chose
  })

  // Passes every tool call through untouched and returns exactly what next gives back; see observeTool.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      await observeTool(e as { agentId?: string }, r.isError === true && r.deny === undefined)
    } catch {
      // observing must never get in the way
    }
    return r
  }).catch(($, e, next) => next(e)) // the call's own result, never run twice (next is replay-safe here)

  // Reads the token counts of a finished turn for the learner; returns what next gives back.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const u = r.usage ?? e.usage
    if (e.agentId === undefined) {
      lastMainTurnAt = Date.now()
      await afterMainTurn($, e, u ? { inp: u.input_tokens, out: u.output_tokens, cr: u.cache_read_input_tokens, cc: u.cache_creation_input_tokens, family: familyOf(u.model), model: u.model } : undefined)
    }
    return r
  })
}
