// budget-router's hooks module. It sets the model and effort of each request from what the prompt asks
// for, tightened as today's share of the weekly usage limit runs down (50% -> first cap, 80% -> second
// cap, 100% -> stays at the second cap; nothing is ever refused). Subagents are only capped, never raised.
// It registers no tools or commands, adds nothing to prompts, and passes every event on.
// Reading order: types, fixed values, options, session state, budget ledger, route decision, notices, hooks.
// See ARCHITECTURE.md for diagrams.
import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { absorb, pressure, readLedger } from './ledger'
import type { Ledger, Pressure } from './ledger'
import { EFFORT_RANK, FAMILY_RANK, applyEscalation, escalationFor, idleRebuild, idleText, isUnrealBuildPrompt, pacerStep, paceSteps, shiftLadder, shouldStick, sizeBucket, sizeNudgeText, targetPercent } from './policy'
import type { EffortName as Effort, Family, LadderSpec as Spec, PacerState } from './policy'
import { ARMS, DEFAULT_PRICES, REDO_RE, armIndex, armName, correct, emptyStore, exploresLeft, fadeFamily, features, followUp, kindOf, noteExplore, pickArm, priceFor, record, scopeOf, stepBucket, turnCostUsd } from './smart'
import type { SmartStore, Usage } from './smart'
import { pickTip } from './tips'

// ---- Types ------------------------------------------------------------------------------------

type Tier = 'trivial' | 'light' | 'standard' | 'deep' | 'max'
type Route = Spec & { tier: Tier; why: string }
type Pin = { tier?: Tier; spec?: Spec }

// ---- Fixed values -----------------------------------------------------------------------------

const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TIERS: readonly Tier[] = ['trivial', 'light', 'standard', 'deep', 'max']

/** turn.step needs full model ids; ids seen on real requests replace these. */
const KNOWN_IDS: Record<Family, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }

const HAIKU_MAX_CONTEXT = 100_000 // never route a conversation larger than this to Haiku
const STICKY_CONTEXT = 60_000 // above this, a one-step model switch is skipped while the cache is warm
const CACHE_WARM_MS = 55 * 60_000 // how long the prompt cache is taken to stay warm after a turn
const IDLE_MIN_CONTEXT = 60_000 // the idle notice needs at least this much context
const ESCALATE_EFFORT_AFTER = 3 // failed tool calls in one turn before effort goes up a notch
const ESCALATE_MODEL_AFTER = 6 // ... before the model goes up a step
const DAY_START_HOUR = 8 // the even-pace line runs from here ...
const DAY_END_HOUR = 24 // ... to here
const PACE_SLACK = 15 // points ahead of the line before pace control reacts
const FAMILY_FULL = 92 // a model family whose own weekly limit is this full is skipped
const LEARN_MIN_SAMPLES = 8
const LEARN_EXPLORE = 0.1
const QUALITY_WEIGHT = 0.05
const TIP_COOLDOWN_MS = 10 * 60_000 // at most one tip in this time

// Store keys. Older versions also kept the keys in RETIRED_KEYS; they are deleted on load.
const LEDGER_KEY = 'ledger'
const MODELS_KEY = 'models'
const PACER_KEY = 'pacer'
const SMART_KEY = 'smart'
const RETIRED_KEYS = ['cmdstats', 'runbooks', 'decisions', 'bandit', 'pace']

const MAX_RE = /\b(ultrathink|think\s+(really\s+|very\s+)?hard(er)?|think\s+deeply|think\s+carefully)\b/i
const CONTINUE_RE = /^\s*(ok(ay)?|yes|yep|yeah|y|sure|go( on| ahead)?|continue|proceed|do it|go for it|carry on|next|ναι|οκ|εντάξει|συνέχισε|προχώρα)\s*[.!]*\s*$/i
const TRIVIAL_RE = /^\s*(hi|hello|hey|thanks?|thank you|ty|cool|nice|great|ευχαριστώ|γεια)\b/i
const DEEP_RE = /\b(architect\w*|design|refactor\w*|security|vulnerab\w*|root cause|investigat\w*|race condition|deadlock|memory leak|performance|optimi[sz]\w*|migrat\w*|research|trade-?offs?|strategy|audit|bypass)\b/i

// ---- Options (the userConfig in plugin.json) --------------------------------------------------

type Opts = {
  tiers: Record<Tier, Spec>
  warnPercent: number
  warnCap: Spec
  criticalPercent: number
  criticalCap: Spec
  wrapUpPercent: number
  includeFiveHour: boolean
  pin?: Pin
  learnMode: 'live' | 'shadow' | 'off'
  idleGuard: 'warn' | 'off'
  nudgeContext: number
  paceControl: boolean
  unrealRules: boolean
  escalateOnTrouble: boolean
  tips: boolean
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)

/** "family:effort", each part falling back on its own. */
function parseSpec(value: unknown, fallback: Spec): Spec {
  const [f = '', e = ''] = str(value).split(':').map(s => s.trim())
  return {
    family: FAMILIES.includes(f as Family) ? (f as Family) : fallback.family,
    effort: EFFORTS.includes(e as Effort) ? (e as Effort) : fallback.effort,
  }
}

/** The `pin` option: blank or `auto` routes automatically; a tier name or `model[:effort]` fixes the route. */
function parsePin(raw: unknown): Pin | undefined {
  const v = str(raw)
  if (v === '' || v === 'auto') return undefined
  if (TIERS.includes(v as Tier)) return { tier: v as Tier }
  const [f = '', e = ''] = v.split(/[:·\s]+/)
  if (!FAMILIES.includes(f as Family)) return undefined
  return { spec: { family: f as Family, effort: EFFORTS.includes(e as Effort) ? (e as Effort) : 'high' } }
}

function readOptions(options: PluginOptions): Opts {
  const mode = str(options.learnMode)
  return {
    tiers: {
      trivial: parseSpec(options.tierTrivial, { family: 'haiku', effort: 'low' }),
      light: parseSpec(options.tierLight, { family: 'sonnet', effort: 'low' }),
      standard: parseSpec(options.tierStandard, { family: 'sonnet', effort: 'high' }),
      deep: parseSpec(options.tierDeep, { family: 'opus', effort: 'high' }),
      max: parseSpec(options.tierMax, { family: 'opus', effort: 'xhigh' }),
    },
    warnPercent: num(options.warnPercent, 50),
    warnCap: parseSpec(options.warnCap, { family: 'sonnet', effort: 'high' }),
    criticalPercent: num(options.criticalPercent, 80),
    criticalCap: parseSpec(options.criticalCap, { family: 'haiku', effort: 'medium' }),
    wrapUpPercent: num(options.wrapUpPercent, 90),
    includeFiveHour: bool(options.includeFiveHour, true),
    pin: parsePin(options.pin),
    // `learn: false` from older versions still means off.
    learnMode: options.learn === false || mode === 'off' ? 'off' : mode === 'shadow' ? 'shadow' : 'live',
    idleGuard: str(options.idleGuard) === 'off' ? 'off' : 'warn',
    nudgeContext: num(options.nudgeContext, 150_000),
    paceControl: bool(options.paceControl, true),
    unrealRules: bool(options.unrealRules, true),
    escalateOnTrouble: bool(options.escalateOnTrouble, true),
    tips: bool(options.tips, true),
  }
}

// ---- Session state (in memory; a reload starts it over) ----------------------------------------

let o: Opts = readOptions({})
let pin: Pin | undefined
let route: Route | undefined // the route of the current main-conversation turn
let level: Pressure['level'] = 0
let ctxTokens = 0
let lastSizeBucket = 0
let lastMainTurnAt = 0 // when the last main turn ended (the prompt cache stays warm for a while)
let famWeekly: Partial<Record<Family, number>> = {} // weekly percent per model family, when the plan reports one
let learned: Partial<Record<Family, string>> = {} // full model ids seen on real requests
let pacerU = 0 // pace controller output: cost steps to shed (0 to 2)
let escalation: { turnId: string; effortUp: boolean; modelUp: boolean } | undefined
let turnErrors = 0 // failed tool calls since the last prompt
let storeLoaded = false
let smartData: SmartStore = emptyStore()
let project = 'x' // hash of the working folder
let stepsNow = 0 // requests made by the current main turn
let lastSteps: number | undefined // requests made by the previous main turn
let lastTurnUsage: Usage = { inp: 2000, out: 1500, cr: 40000, cc: 3000 }
let lastPromptText = '' // kept in memory only, to spot a quick "try again"
const tipsShown = new Set<string>() // tips already shown this session
let lastTipAt = 0

/** What the learner chose for this turn, and what to record once the turn ends. */
type Pending = { kind: string; project: string; arm: number; base: number; x: number[] }
let pending: Pending | undefined
let lastOutcome: (Pending & { ok: boolean; at: number }) | undefined

const learnOn = () => o.learnMode !== 'off'
const rankF = (f: Family) => FAMILY_RANK[f]
const rankE = (e: Effort) => EFFORT_RANK[e]
const capSpec = (s: Spec, cap: Spec): Spec => ({
  family: rankF(s.family) > rankF(cap.family) ? cap.family : s.family,
  effort: rankE(s.effort) > rankE(cap.effort) ? cap.effort : s.effort,
})
/** What a model id is. `above`: Fable or Mythos, ranked above Opus and never a route target. `known`: one this router can act on. */
function parseModel(id: string): { family: Family; above: boolean; known: boolean; plain: boolean } {
  const m = id.toLowerCase()
  const above = /fable|mythos/.test(m)
  return {
    family: m.includes('haiku') ? 'haiku' : m.includes('sonnet') ? 'sonnet' : 'opus',
    above,
    known: above || /haiku|sonnet|opus/.test(m),
    plain: /^claude-(haiku|sonnet|opus)-\d+(-\d{1,2})?$/.test(m),
  }
}
const familyOf = (model: string): Family => parseModel(model).family
/** The cap that applies at a pressure level, if any. */
const capFor = (lvl: Pressure['level']): Spec | undefined => (lvl >= 2 ? o.criticalCap : lvl === 1 ? o.warnCap : undefined)

/**
 * The model id to send for a family, or nothing when unsure (the request then stays on the model Claude Code chose).
 * In order: an id this session has already run for that family; the same generation as the model in use, when its
 * id is a plain `claude-<family>-<version>` (a dated or provider-specific id is not swapped, it may not exist for
 * the other family); the known current id when the session runs a model above Opus (Fable, Mythos).
 */
function targetModel(f: Family, current: string): string | undefined {
  if (learned[f]) return learned[f]
  const m = parseModel(current)
  if (m.plain) return current.replace(/haiku|sonnet|opus/i, f)
  return m.above && /^claude-/i.test(current) ? KNOWN_IDS[f] : undefined
}

// ---- Time ---------------------------------------------------------------------------------------

const tzMin = -new Date().getTimezoneOffset()
const localDay = (ms: number) => new Date(ms + tzMin * 60_000).toISOString().slice(0, 10)
const clock = (ms: number) => new Date(ms + tzMin * 60_000).toISOString().slice(11, 16)
const nextMidnight = (ms: number) => {
  const d = new Date(ms + tzMin * 60_000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - tzMin * 60_000
}

// ---- Store --------------------------------------------------------------------------------------

async function loadStore($: EngineInterface) {
  await Promise.all(RETIRED_KEYS.map(key => $.store.delete(key)))
  const stored = (await $.store.get(SMART_KEY)) as (Omit<SmartStore, 'v'> & { v?: number }) | undefined
  // Version 1 weights were partly trained on hashed words of prompts: dropped; the counts are kept.
  smartData = stored ? { ...stored, v: 2, weights: stored.v === 2 ? stored.weights : {} } : emptyStore()
  storeLoaded = true
}

/** Remembers the full id of a model seen on a real request. A new id for a family halves that family's record. */
async function noteModel($: EngineInterface, model: string) {
  const f = familyOf(model)
  // Fable and Mythos rank above Opus but are not a tier this router routes to; never adopt one as the Opus id.
  if (!/^claude-/.test(model) || parseModel(model).above || learned[f] === model) return
  const hadOlder = learned[f] !== undefined
  learned = { ...learned, [f]: model }
  if (hadOlder) {
    if (!storeLoaded) await loadStore($)
    smartData = fadeFamily(smartData, f)
    await $.store.set(SMART_KEY, smartData)
  }
  await $.store.set(MODELS_KEY, learned)
}

async function detectProject($: EngineInterface) {
  try {
    const dir = (await $.session.cwd()).toLowerCase()
    let h = 5381
    for (let i = 0; i < dir.length; i++) h = (Math.imul(h, 33) ^ dir.charCodeAt(i)) >>> 0
    project = dir === '' ? 'x' : h.toString(36)
  } catch {
    // no project hash: the learner pools everything under one project
  }
}

// ---- Daily budget ledger ------------------------------------------------------------------------

const loadLedger = async ($: EngineInterface) => readLedger(await $.store.get(LEDGER_KEY))
const pressureAt = (l: Ledger | undefined, now: number) => pressure(l, now, localDay(now), o)

/** Pace control: compares today's use with an even spread over the active hours. */
async function pacerUpdate($: EngineInterface, p: Pressure, now: number) {
  if (!o.paceControl) {
    pacerU = 0
    return
  }
  try {
    const local = new Date(now + tzMin * 60_000)
    const target = targetPercent(local.getUTCHours() + local.getUTCMinutes() / 60, DAY_START_HOUR, DAY_END_HOUR)
    const next = pacerStep((await $.store.get(PACER_KEY)) as PacerState | undefined, localDay(now), now, p.daily - (target + PACE_SLACK))
    await $.store.set(PACER_KEY, next)
    pacerU = next.u
  } catch {
    // pace control is an optimisation; never get in the way of work
  }
}

// ---- Route decision ------------------------------------------------------------------------------

/** The tier a prompt asks for, by keyword rules. */
function classify(raw: string, prev: Tier | undefined): { tier: Tier; why: string } {
  const text = raw.trim()
  if (MAX_RE.test(text)) return { tier: 'max', why: 'asked to think hard' }
  if (CONTINUE_RE.test(text)) return { tier: prev ?? 'standard', why: 'continuation' }
  if (DEEP_RE.test(text)) return { tier: 'deep', why: 'keywords' }
  if (text.length < 60 && TRIVIAL_RE.test(text)) return { tier: 'trivial', why: 'keywords' }
  return { tier: prev && prev !== 'trivial' ? prev : 'standard', why: 'default' }
}

/**
 * The route for a main-conversation turn. Steps, in order: the tier's model and effort (or the pin),
 * stay on the same model in a long warm conversation, the learner, skip a family whose weekly limit is
 * nearly spent, pace control, the usage caps, and no Haiku on a very long conversation.
 */
function decide(tier: Tier, why: string, p: Pressure, x: number[], kind: string): { route: Route; pending?: Pending; explored: boolean } {
  const notes = [why]
  let spec = pin?.spec ?? o.tiers[tier]
  const last = route
  if (!pin && last && spec.family !== last.family) {
    const dist = Math.abs(rankF(spec.family) - rankF(last.family))
    const sinceLast = lastMainTurnAt > 0 ? Date.now() - lastMainTurnAt : undefined
    if (shouldStick({ ctx: ctxTokens, stickyContext: STICKY_CONTEXT, stepDistance: dist, sinceLastTurnMs: sinceLast, warmMs: CACHE_WARM_MS })) {
      spec = { ...spec, family: last.family }
      notes.push('sticky')
    }
  }
  let picked: Pending | undefined
  let explored = false
  if (learnOn() && !pin) {
    const base = armIndex(spec)
    const pick = pickArm({ base, tier, scope: scopeOf(smartData, kind, project), w: smartData.weights, x, now: Date.now(), dailyUsedPct: p.daily, qualityWeight: QUALITY_WEIGHT, typical: lastTurnUsage, exploresLeft: exploresLeft(smartData, localDay(Date.now())), minSamples: LEARN_MIN_SAMPLES, explore: LEARN_EXPLORE })
    const live = o.learnMode === 'live'
    picked = { kind, project, arm: live ? pick.arm : base, base, x }
    explored = pick.explored && live
    if (pick.arm !== base && live) {
      const a = ARMS[pick.arm]!
      spec = { family: a.family, effort: a.effort }
      notes.push(pick.why)
    } else if (pick.arm !== base) notes.push(`shadow: would pick ${armName(pick.arm)}`)
  }
  if (!pin) {
    for (let n = 0; n < 2; n++) {
      const used = famWeekly[spec.family]
      if (used === undefined || used < FAMILY_FULL || spec.family === 'haiku') break
      notes.push(`${spec.family} weekly ${Math.round(used)}% used`)
      spec = { family: spec.family === 'opus' ? 'sonnet' : 'haiku', effort: spec.effort === 'max' || spec.effort === 'xhigh' ? 'high' : spec.effort }
    }
  }
  // "Think hard" and a pinned route are left alone by pace control.
  const shed = o.paceControl && !pin && tier !== 'max' ? paceSteps(pacerU) : 0
  if (shed > 0) {
    spec = shiftLadder(spec, shed)
    notes.push(`pace -${shed}`)
  }
  const cap = capFor(p.level)
  if (cap) spec = capSpec(spec, cap)
  if (spec.family === 'haiku' && ctxTokens > HAIKU_MAX_CONTEXT) {
    spec = { family: 'sonnet', effort: p.level >= 2 ? 'low' : spec.effort }
    notes.push('too long for haiku')
  }
  return { route: { ...spec, tier, why: notes.join(', ') }, pending: picked, explored }
}

/** Raises effort (and after a longer run the model) for the rest of a turn whose tool calls keep failing. Caps still apply. */
function escalate(e: { turnId: string; index: number }, base: Spec): Spec {
  if (!o.escalateOnTrouble || pin) return base
  if (escalation && escalation.turnId !== e.turnId) escalation = undefined
  if (e.index >= 2 && !escalation?.modelUp) {
    const esc = escalationFor(turnErrors, ESCALATE_EFFORT_AFTER, ESCALATE_MODEL_AFTER)
    if (esc.effortUp || esc.modelUp) escalation = { turnId: e.turnId, effortUp: esc.effortUp || escalation?.effortUp === true, modelUp: esc.modelUp || escalation?.modelUp === true }
  }
  if (!escalation) return base
  const raised = applyEscalation(base, escalation)
  const cap = capFor(level)
  return cap ? capSpec(raised, cap) : raised
}

/** After a main turn: record how it went (few failed tool calls, not aborted) and what it cost. */
async function learnFromTurn($: EngineInterface, isAborted: boolean, u?: Usage & { family: Family; model: string }) {
  if (!storeLoaded) await loadStore($)
  lastSteps = stepsNow
  if (u) lastTurnUsage = { inp: u.inp, out: u.out, cr: u.cr, cc: u.cc }
  if (!learnOn() || !pending) return
  const done = pending
  pending = undefined
  try {
    const ok = !isAborted && turnErrors <= 1
    const cost = u ? turnCostUsd(u.family, u, { ...DEFAULT_PRICES, [u.family]: priceFor(u.model, u.family) }) : 0
    lastOutcome = { ...done, ok, at: Date.now() }
    smartData = record(smartData, { ...done, ok, costUsd: cost, now: Date.now() })
    await $.store.set(SMART_KEY, smartData)
  } catch {
    // learning is optional
  }
}

// ---- Status bar and notices ----------------------------------------------------------------------

function showStatus($: EngineInterface, p: Pressure) {
  const head = route ? `${route.family}·${route.effort} (${route.tier}${pin ? ', pinned' : ''})` : 'route: auto'
  const warn = p.level === 3 ? '⛔ ' : p.level > 0 ? '⚠ ' : ''
  const five = p.five > 0 ? ` │ 5h ${Math.round(p.five)}%` : ''
  const saved = learnOn() && smartData.saved >= 0.05 ? ` │ saved $${smartData.saved.toFixed(2)}` : ''
  $.ui.status(`${warn}${head} │ day ${Math.round(p.daily)}%${five} │ week ${Math.round(p.week)}%${saved}`)
}

/** Shows a notice and appends the same text as a system note, so the model knows it is on a cheaper model. */
function notify($: EngineInterface, text: string, timeoutMs: number) {
  $.ui.toast(text, { timeoutMs })
  void $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `budget-router: ${text}` }] } }).catch(() => undefined)
}

function capNotice(p: Pressure, now: number): string {
  const day = `${Math.round(p.daily)}% of today's budget`
  const why = p.daily >= o.warnPercent || !o.includeFiveHour ? day : `5-hour window at ${Math.round(p.five)}%`
  const cap = (s: Spec) => `${s.family}·${s.effort}`
  if (p.level === 3) return `⛔ Today's Claude budget is spent (${day}). Turns stay at ${cap(o.criticalCap)}; nothing is refused. A new share starts at ${clock(nextMidnight(now))}.`
  if (p.level === 2) return `⚠⚠ Claude usage: ${why}. Turns are now capped at ${cap(o.criticalCap)}.`
  return `⚠ Claude usage: ${why}. Turns are now capped at ${cap(o.warnCap)}.`
}

function wrapUpNotice(p: Pressure): string {
  const left = Math.max(0, Math.round(100 - p.daily))
  return `⏳ ${Math.round(p.daily)}% of today's Claude budget is used (about ${left}% left). Good moment to finish what is in hand, commit, and note where you stopped. Turns stay at ${o.criticalCap.family}·${o.criticalCap.effort} from 100%; no prompt is ever refused.`
}

// ---- Hooks ---------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  o = readOptions(options)
  pin = o.pin

  // Loads what the plugin stored and hashes the working folder's name. Changes nothing.
  on('session.start', async ($, e, next) => {
    const [, models, savedPacer, ledger] = await Promise.all([
      detectProject($),
      $.store.get(MODELS_KEY),
      $.store.get(PACER_KEY) as Promise<PacerState | undefined>,
      loadLedger($),
      loadStore($),
    ])
    learned = (models as typeof learned | undefined) ?? {}
    pacerU = savedPacer && savedPacer.day === localDay(Date.now()) ? savedPacer.u : 0
    const p = pressureAt(ledger, Date.now())
    level = p.level
    showStatus($, p)
    return next(e)
  })

  // Reads the rate-limit and context figures; updates the ledger, status bar and notices. Changes nothing.
  on('session.measure', async ($, e, next) => {
    ctxTokens = e.context.tokens ?? ctxTokens
    if (o.nudgeContext > 0) {
      const b = sizeBucket(ctxTokens, o.nudgeContext)
      if (b > lastSizeBucket) $.ui.toast(sizeNudgeText(ctxTokens, route?.family ?? 'sonnet'), { timeoutMs: 20_000 })
      lastSizeBucket = b
    }
    famWeekly = {}
    for (const r of e.rateLimits) {
      const m = /^seven_day_(opus|sonnet)$/.exec(r.kind)
      if (m) famWeekly[m[1] as Family] = r.percentUsed
    }
    const now = Date.now()
    const prev = await loadLedger($)
    const l = absorb(prev, e.rateLimits, now, localDay(now))
    if (l) {
      const p = pressureAt(l, now)
      if (p.level > l.alerted) {
        notify($, capNotice(p, now), 20_000)
        l.alerted = p.level
      }
      if (o.wrapUpPercent > 0 && !l.wrapped && p.level < 3 && p.daily >= o.wrapUpPercent) {
        l.wrapped = true
        notify($, wrapUpNotice(p), 25_000)
      }
      if (l !== prev) await $.store.set(LEDGER_KEY, l)
      level = p.level
      showStatus($, p)
      await pacerUpdate($, p, now)
    }
    return next(e)
  })

  // Reads the typed prompt to choose the turn's route. The prompt goes on exactly as received.
  on('prompt.submit', async ($, e, next) => {
    const now = Date.now()
    const p = pressureAt(await loadLedger($), now)
    level = p.level
    if (!storeLoaded) await loadStore($)
    // Only a prompt the person typed starts a new route; one typed into a running turn rides that turn.
    if (e.turnId === undefined && ['composer', 'bridge', 'sdk'].includes(e.origin.kind)) {
      try {
        ctxTokens = (await $.session.usage()).context.tokens ?? ctxTokens
      } catch {
        // keep the last known size
      }
      const failedLast = turnErrors
      turnErrors = 0
      // A quick redo or rephrase means the last turn missed; a thanks means it hit.
      if (learnOn() && lastOutcome && now - lastOutcome.at < 15 * 60_000) {
        const f = followUp(lastPromptText, e.text, now - lastOutcome.at, REDO_RE)
        const toOk = f === 'ack' ? true : f === 'redo' || f === 'rephrase' ? false : undefined
        if (toOk !== undefined && toOk !== lastOutcome.ok) {
          smartData = correct(smartData, { ...lastOutcome, toOk })
          lastOutcome = { ...lastOutcome, ok: toOk }
          await $.store.set(SMART_KEY, smartData)
        }
      }
      lastPromptText = e.text
      const idle = o.idleGuard === 'off' ? undefined : idleRebuild(ctxTokens, lastMainTurnAt > 0 ? now - lastMainTurnAt : undefined, CACHE_WARM_MS, IDLE_MIN_CONTEXT, route?.family ?? 'sonnet')
      if (idle) $.ui.toast(idleText(idle), { timeoutMs: 20_000 })
      let c = pin ? { tier: pin.tier ?? route?.tier ?? 'standard', why: 'pinned' } : classify(e.text, route?.tier)
      // Build, link and cook errors need more than the two cheapest tiers.
      if (o.unrealRules && !pin && isUnrealBuildPrompt(e.text) && (c.tier === 'trivial' || c.tier === 'light')) c = { tier: 'standard', why: `${c.why}; unreal build text` }
      // The learner's features are only read when it chooses; nothing else uses them.
      const kind = kindOf(e.text)
      const x = learnOn() && !pin ? features(e.text, ctxTokens, stepBucket(lastSteps)) : []
      stepsNow = 0
      const d = decide(c.tier, c.why, p, x, kind)
      route = d.route
      pending = d.pending
      if (d.explored) smartData = noteExplore(smartData, localDay(now))
      // A contextual tip for the person (a toast, never added to the conversation), at most one every 10 minutes.
      if (o.tips && now - lastTipAt >= TIP_COOLDOWN_MS) {
        const tip = pickTip({ text: e.text, kind: kindOf(e.text), lastSteps, failedLast, level: p.level }, tipsShown)
        if (tip) {
          tipsShown.add(tip.id)
          lastTipAt = now
          $.ui.toast(tip.text, { timeoutMs: 20_000 })
        }
      }
    }
    showStatus($, p)
    return next(e)
  }).catch(($, e, next) => next(e)) // a failure here never stops the prompt: it goes on unchanged

  // Sets model and effort for each request: the route for main turns; subagents are only ever capped.
  on('turn.step', async function* ($, e, next) {
    await noteModel($, e.model)
    if (e.agentId !== undefined) {
      let cap = capFor(level)
      if (!cap || !parseModel(e.model).known) return yield* next(e)
      const cur: Spec = { family: familyOf(e.model), effort: typeof e.effort === 'string' ? e.effort : 'high' }
      // Capped like the main turn, but never pushed down to Haiku (a subagent's context is unknown).
      if (cap.family === 'haiku' && cur.family !== 'haiku') cap = { family: 'sonnet', effort: 'low' }
      const s = capSpec(cur, cap)
      if (s.family === cur.family && s.effort === cur.effort) return yield* next(e)
      const model = s.family === cur.family ? e.model : targetModel(s.family, e.model)
      if (model === undefined) return yield* next(e)
      return yield* next({ ...e, model, ...(e.effort === undefined ? {} : { effort: s.effort }) })
    }
    stepsNow++
    const base = route ?? capSpec(o.tiers.standard, capFor(level) ?? o.tiers.max)
    const spec = escalate(e, base)
    // Only act on a model it recognises, and only move to an id it can name safely.
    const cur = parseModel(e.model)
    const model = !cur.known ? undefined : spec.family === cur.family && !cur.above ? e.model : targetModel(spec.family, e.model)
    if (model === undefined) return yield* next(e)
    return yield* next({ ...e, model, effort: spec.effort })
  }).catch(async function* ($, e, next) {
    return yield* next(e) // a failure here leaves the request on the model Claude Code chose
  })

  // Counts failed tool calls of the main turn; returns exactly what next gives back.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if ((e as { agentId?: string }).agentId === undefined && r.isError === true && r.deny === undefined) turnErrors++
    return r
  }).catch(($, e, next) => next(e)) // the call's own result, never run twice (next is replay-safe here)

  // Reads the finished turn's token counts for the learner; returns what next gives back.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const u = r.usage ?? e.usage
    if (e.agentId === undefined) {
      lastMainTurnAt = Date.now()
      await learnFromTurn($, e.isAborted, u ? { inp: u.input_tokens, out: u.output_tokens, cr: u.cache_read_input_tokens, cc: u.cache_creation_input_tokens, family: familyOf(u.model), model: u.model } : undefined)
    }
    return r
  })
}
