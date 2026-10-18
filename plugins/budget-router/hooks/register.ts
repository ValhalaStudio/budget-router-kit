import type { EngineInterface, PluginOptions, Register, SessionRateLimit } from 'claude-code'
import { isOffered, parseList, parseSubagentModels, planSpawn, pushLog, summarize } from './policy'
import type { LogEntry } from './policy'

// budget-router: picks the model and effort for every main-thread turn from
// what the prompt asks for, and tightens that choice as today's share of the
// account's usage limits runs down (50% -> first cap, 80% -> second cap,
// 100% -> new prompts refused until local midnight). v0.3 also sets the model
// of subagents (cheap read-only types on Haiku, no new ones at the lock),
// can hide agent types once usage is tight, and keeps a decision log.

type Family = 'haiku' | 'sonnet' | 'opus'
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type Tier = 'trivial' | 'light' | 'standard' | 'deep' | 'max'
type Spec = { family: Family; effort: Effort }
type Route = Spec & { tier: Tier; why: string }
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
  unlockUntil?: number
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
  classifier: string
  tiers: Record<Tier, Spec>
  warnPercent: number
  warnCap: Spec
  criticalPercent: number
  criticalCap: Spec
  lockAtLimit: boolean
  includeFiveHour: boolean
  haikuMaxContext: number
  stickyContext: number
  models: Record<Family, string>
  subagentModels: Record<string, Family>
  hideAgentsAtCritical: string[]
  logDecisions: boolean
}

const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TIERS: readonly Tier[] = ['trivial', 'light', 'standard', 'deep', 'max']
const LEVEL_NAMES = ['normal', 'capped', 'capped hard', 'LOCKED'] as const
const DAY_MS = 86_400_000
const UNLOCK_MS = 3_600_000
const STORE_KEY = 'ledger'
const MODELS_KEY = 'models'

// turn.step takes full model ids, not aliases. These are the current ones;
// ids seen on real requests (the session's model, a subagent's) replace them.
const KNOWN_IDS: Record<Family, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

const MAX_RE = /\b(ultrathink|think\s+(really\s+|very\s+)?hard(er)?|think\s+deeply|think\s+carefully)\b/i
const CONTINUE_RE =
  /^\s*(ok(ay)?|yes|yep|yeah|y|sure|go( on| ahead)?|continue|proceed|do it|go for it|carry on|next|ναι|οκ|εντάξει|συνέχισε|προχώρα)\s*[.!]*\s*$/i
const TRIVIAL_RE = /^\s*(hi|hello|hey|thanks?|thank you|ty|cool|nice|great|ευχαριστώ|γεια)\b/i
const DEEP_RE =
  /\b(architect\w*|design|refactor\w*|security|vulnerab\w*|root cause|investigat\w*|race condition|deadlock|memory leak|performance|optimi[sz]\w*|migrat\w*|research|trade-?offs?|strategy|audit|bypass)\b/i

const CLASSIFY_SYSTEM =
  "You choose the cheapest model tier that can handle a coding assistant's next turn well. Reply with exactly one word."

const classifyPrompt = (text: string, prev: Tier | undefined) => `Tiers:
TRIVIAL: greeting, thanks, yes/no, a quick fact or definition, one obvious command, a tiny wording change.
LIGHT: a small, fully specified edit or shell task; a short summary; finding something in files; formatting.
STANDARD: normal coding, debugging, configuration or writing work; multi-step tasks; reviewing code.
DEEP: design or architecture, hard or vague bugs, large refactors, security, performance, research with tradeoffs, risky or destructive operations.
SAME: a short continuation of the previous task ("ok", "continue", "do it", "yes go ahead"). Previous tier: ${prev ?? 'none'}.
When unsure between two tiers, pick the higher one.

User message:
<<<
${text.slice(0, 2000)}
>>>
One word: TRIVIAL, LIGHT, STANDARD, DEEP or SAME.`

const GUIDANCE = `The budget-router plugin picks the model and effort for every turn, whatever the system prompt says you run on: trivial → Haiku, light/standard → Sonnet, deep or "think hard" → Opus. It caps turns at 50% and 80% of today's usage budget and refuses prompts at 100%. /budget shows the numbers, /route pins a tier.
- If a task clearly needs deeper reasoning than this turn can give, say so in one line and suggest /route deep rather than guessing.
- Spend tokens where they change the outcome: read only the line ranges you need, cap search output, never re-read a file you just edited, keep answers short unless asked for depth.
- For a broad read-only sweep across many files where only the conclusion matters, delegate it to the budget-router:scout agent (Haiku) so the raw output stays out of this context. Do the work inline when it touches a few known files.
- Other cheap helpers: budget-router:log-triage (long build, cook, UAT or test logs cut down to their errors), budget-router:disk-auditor (folder sizes, what fills a drive), budget-router:repo-check (git state: unpushed work, worktrees, LFS), and budget-router:reviewer (Sonnet, read-only diff review). Use them only for read-only work; make edits yourself.`

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

function readOptions(options: PluginOptions): Opts {
  return {
    classifier: str(options.classifier, 'haiku'),
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
    lockAtLimit: bool(options.lockAtLimit, true),
    includeFiveHour: bool(options.includeFiveHour, true),
    haikuMaxContext: num(options.haikuMaxContext, 120_000),
    stickyContext: num(options.stickyContext, 60_000),
    models: {
      haiku: str(options.haikuModel, 'haiku'),
      sonnet: str(options.sonnetModel, 'sonnet'),
      opus: str(options.opusModel, 'opus'),
    },
    subagentModels: parseSubagentModels(options.subagentModels),
    hideAgentsAtCritical: parseList(options.hideAgentsAtCritical),
    logDecisions: bool(options.logDecisions, true),
  }
}

// Session-local: the options, the route the current turn runs on, a /route
// pin, the last known context size and budget level. A reload starts them over.
let o: Opts = readOptions({})
let route: Route | undefined
let pin: Pin | undefined
let ctxTokens = 0
let level: Pressure['level'] = 0
let tzMin = -new Date().getTimezoneOffset()
let learned: Partial<Record<Family, string>> = {}

const isAlias = (v: string) => FAMILIES.includes(v.toLowerCase() as Family)
const modelId = (f: Family) => (isAlias(o.models[f]) ? (learned[f] ?? KNOWN_IDS[f]) : o.models[f])

async function learn($: EngineInterface, model: string) {
  const f = familyOf(model)
  if (!/^claude-/.test(model) || learned[f] === model) return
  learned = { ...learned, [f]: model }
  await $.store.set(MODELS_KEY, learned)
}

const localDay = (ms: number) => new Date(ms + tzMin * 60_000).toISOString().slice(0, 10)
const clock = (ms: number) => new Date(ms + tzMin * 60_000).toISOString().slice(11, 16)
const stamp = (ms: number) => new Date(ms + tzMin * 60_000).toISOString().slice(5, 16).replace('T', ' ')
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

// The decision log: what was routed and why, subagent rules applied, and the
// tokens each turn used. Kept in the plugin store (newest 200 rows), never sent
// anywhere. It holds no prompt text.
const LOG_KEY = 'decisions'
const loadLog = async ($: EngineInterface) => ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []

async function addLog($: EngineInterface, entry: LogEntry) {
  if (!o.logDecisions) return
  try {
    await $.store.set(LOG_KEY, pushLog(await loadLog($), entry))
  } catch {
    // logging must never get in the way of the work
  }
}

function heuristic(text: string, prev: Tier | undefined): { tier: Tier; why: string } {
  if (DEEP_RE.test(text)) return { tier: 'deep', why: 'keywords' }
  if (text.length < 60 && TRIVIAL_RE.test(text)) return { tier: 'trivial', why: 'keywords' }
  return { tier: prev && prev !== 'trivial' ? prev : 'standard', why: 'default' }
}

async function classify($: EngineInterface, raw: string, prev: Tier | undefined) {
  const text = raw.trim()
  if (MAX_RE.test(text)) return { tier: 'max' as Tier, why: 'asked to think hard' }
  if (CONTINUE_RE.test(text)) return { tier: prev ?? 'standard', why: 'continuation' }
  if (o.classifier === 'haiku') {
    try {
      const r = await $.model.complete({
        model: o.models.haiku,
        system: CLASSIFY_SYSTEM,
        prompt: classifyPrompt(text, prev),
        maxTokens: 16,
        effort: 'low',
        timeoutMs: 6000,
      })
      const word = r.isAnswered ? r.text.toUpperCase().match(/TRIVIAL|LIGHT|STANDARD|DEEP|SAME/)?.[0] : undefined
      if (word === 'SAME') return { tier: prev ?? 'standard', why: 'classifier: same' }
      if (word) return { tier: word.toLowerCase() as Tier, why: 'classifier' }
    } catch {
      // fall through to the keyword rules
    }
  }
  return heuristic(text, prev)
}

function decide(tier: Tier, why: string, p: Pressure): Route {
  const notes = [why]
  let spec = pin?.spec ?? o.tiers[tier]
  const last = route
  if (!pin && last && ctxTokens >= o.stickyContext && spec.family !== last.family) {
    // Switching model re-caches the whole conversation; a one-step change
    // on a long conversation costs more than it saves.
    if (Math.abs(rankF(spec.family) - rankF(last.family)) === 1) {
      spec = { ...spec, family: last.family }
      notes.push('sticky')
    }
  }
  if (p.level === 1) spec = capSpec(spec, o.warnCap)
  if (p.level >= 2) spec = capSpec(spec, o.criticalCap)
  if (p.level >= 1) notes.push(`cap ${LEVEL_NAMES[p.level]}`)
  if (spec.family === 'haiku' && ctxTokens > o.haikuMaxContext) {
    spec = { family: 'sonnet', effort: p.level >= 2 ? 'low' : spec.effort }
    notes.push('too long for haiku')
  }
  return { ...spec, tier, why: notes.join(', ') }
}

function showStatus($: EngineInterface, p: Pressure) {
  const r = route
  const head = r ? `${r.family}·${r.effort} (${r.tier}${pin ? ', pinned' : ''})` : 'route: auto'
  const warn = p.level === 3 ? '⛔ ' : p.level > 0 ? '⚠ ' : ''
  const five = p.five > 0 ? ` │ 5h ${Math.round(p.five)}%` : ''
  $.ui.status(`${warn}${head} │ day ${Math.round(p.daily)}%${five} │ week ${Math.round(p.week)}%`)
}

function alert($: EngineInterface, p: Pressure, now: number) {
  const day = `${Math.round(p.daily)}% of today's budget`
  const why = p.daily >= o.warnPercent || !o.includeFiveHour ? day : `5-hour window at ${Math.round(p.five)}%`
  const text =
    p.level === 3
      ? `⛔ Today's Claude budget is spent (${day}). New prompts are refused until ${clock(nextMidnight(now))}; /budget unlock overrides for 1 hour.`
      : p.level === 2
        ? `⚠⚠ Claude usage: ${why}. Turns are now capped at ${o.criticalCap.family}·${o.criticalCap.effort}.`
        : `⚠ Claude usage: ${why}. Turns are now capped at ${o.warnCap.family}·${o.warnCap.effort}.`
  $.ui.toast(text, { timeoutMs: 20_000 })
  void $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text: `budget-router: ${text}` }] } })
    .catch(() => undefined)
}

function report(l: Ledger | undefined, p: Pressure, now: number): string {
  const lines = ['Budget router']
  if (!l) {
    lines.push('  No rate-limit reading yet: it appears after the first reply on a Claude subscription.')
  } else {
    const unlocked = (l.unlockUntil ?? 0) > now ? ` (override until ${clock(l.unlockUntil!)})` : ''
    lines.push(
      `  today ${l.day}: ${Math.round(p.daily)}% of the daily budget used (${p.usedPts.toFixed(1)} of ${p.budgetPts.toFixed(1)} weekly points); day ends ${clock(nextMidnight(now))}`,
      `  weekly window: ${Math.round(p.week)}% used, resets ${stamp(Date.parse(l.windowReset))}`,
      `  5-hour window: ${Math.round(p.five)}%${l.fiveHourReset ? `, resets ${clock(Date.parse(l.fiveHourReset))}` : ''}`,
      `  level: ${LEVEL_NAMES[p.level]}${unlocked}`,
    )
  }
  lines.push(
    `  route: ${route ? `${route.family}·${route.effort} for a ${route.tier} turn (${route.why})` : 'not chosen yet'}${pin ? ' [pinned: /route auto to release]' : ''}`,
    `  caps: ${o.warnPercent}% → ${o.warnCap.family}·${o.warnCap.effort}, ${o.criticalPercent}% → ${o.criticalCap.family}·${o.criticalCap.effort}, 100% → ${o.lockAtLimit ? 'lock' : 'no lock'}`,
    `  subagents: ${Object.entries(o.subagentModels).map(([t, f]) => `${t} → ${f}`).join(', ') || 'no model rules'}${o.hideAgentsAtCritical.length > 0 ? `; hidden past ${o.criticalPercent}%: ${o.hideAgentsAtCritical.join(', ')}` : ''}`,
    `  /route why shows the recent decisions and today's token use${o.logDecisions ? '' : ' (logging is off)'}`,
  )
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  o = readOptions(options)

  on('session.start', async ($, e, next) => {
    if (tzMin === 0) {
      // The hooks environment may run in UTC; ask the OS for the real offset
      // (`date` on macOS/Linux, PowerShell on Windows).
      try {
        const r = await $.process.run(['date', '+%z'], { timeoutMs: 5000 })
        const m = r.stdout.trim().match(/^([+-])(\d{2})(\d{2})$/)
        if (m) tzMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
      } catch {
        try {
          const r = await $.process.run(
            ['powershell', '-NoProfile', '-Command', '[int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).TotalMinutes'],
            { timeoutMs: 8000 },
          )
          const n = Number(r.stdout.trim())
          if (r.stdout.trim() !== '' && Number.isFinite(n)) tzMin = n
        } catch {
          // keep UTC
        }
      }
    }
    await $.command.register({
      name: 'budget',
      description: "Show today's Claude usage budget and route; 'unlock' overrides the lock for 1 hour",
      argumentHint: '[unlock|reset]',
    })
    await $.command.register({
      name: 'route',
      description: 'Pin the model/effort tier for this session, or auto',
      argumentHint: '[why|auto|trivial|light|standard|deep|max|haiku|sonnet|opus] [low|medium|high|xhigh|max]',
    })
    learned = ((await $.store.get(MODELS_KEY)) as typeof learned | undefined) ?? {}
    const p = pressure(await loadLedger($), Date.now())
    level = p.level
    showStatus($, p)
    return next(e)
  })

  // Once per conversation, beside CLAUDE.md: stable text, so it stays in the
  // prompt cache.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    return { ...r, blocks: [...r.blocks, { name: 'budgetRouter', text: GUIDANCE }] }
  })

  on('session.measure', async ($, e, next) => {
    ctxTokens = e.context.tokens ?? ctxTokens
    const now = Date.now()
    const prev = await loadLedger($)
    const l = absorb(prev, e.rateLimits, now)
    if (l) {
      const p = pressure(l, now)
      if (p.level > l.alerted) {
        alert($, p, now)
        l.alerted = p.level
      }
      if (l !== prev) await $.store.set(STORE_KEY, l)
      level = p.level
      showStatus($, p)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const now = Date.now()
    const l = await loadLedger($)
    const p = pressure(l, now)
    level = p.level
    const isOwnCommand = /^\s*\/(budget|route)\b/.test(e.text)
    if (p.level === 3 && o.lockAtLimit && !isOwnCommand && !((l?.unlockUntil ?? 0) > now)) {
      return {
        drop: `⛔ Today's Claude budget is spent (${Math.round(p.daily)}% of today's share; week at ${Math.round(p.week)}%). Locked until ${clock(nextMidnight(now))}. /budget unlock overrides for 1 hour.`,
      }
    }
    // A prompt typed into a running turn rides that turn's model.
    if (e.turnId === undefined && ['composer', 'bridge', 'sdk'].includes(e.origin.kind) && !isOwnCommand) {
      try {
        ctxTokens = (await $.session.usage()).context.tokens ?? ctxTokens
      } catch {
        // keep the last known size
      }
      const c = pin ? { tier: pin.tier ?? route?.tier ?? 'standard', why: 'pinned' } : await classify($, e.text, route?.tier)
      route = decide(c.tier, c.why, p)
      await addLog($, {
        t: now,
        k: 'prompt',
        tier: route.tier,
        why: route.why,
        model: route.family,
        effort: route.effort,
        level: p.level,
        ctx: ctxTokens,
      })
    }
    showStatus($, p)
    return next(e)
  })

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
    const spec = route ?? capSpec(o.tiers.standard, level >= 2 ? o.criticalCap : level === 1 ? o.warnCap : o.tiers.max)
    return yield* next({ ...e, model: modelId(spec.family), effort: spec.effort })
  })

  // A new subagent: no new ones once today's budget is spent (the lock), and
  // read-only helper types run on a cheap model when the call did not name one.
  // The per-step cap in turn.step still applies on top of this.
  on('agent.spawn', async ($, e, next) => {
    const now = Date.now()
    const l = await loadLedger($)
    const p = pressure(l, now)
    level = p.level
    if (p.level === 3 && o.lockAtLimit && !((l?.unlockUntil ?? 0) > now)) {
      await addLog($, { t: now, k: 'spawn', type: e.subagentType, note: 'refused: budget spent', level: p.level })
      return {
        deny: `⛔ budget-router: today's Claude budget is spent, so no new subagents until ${clock(nextMidnight(now))} (/budget unlock overrides for 1 hour).`,
      }
    }
    const plan = planSpawn(e, o.subagentModels)
    await addLog($, { t: now, k: 'spawn', type: e.subagentType, note: plan.note, level: p.level })
    return plan.model ? next({ ...e, model: o.models[plan.model] }) : next(e)
  })

  // Past the second cap the model is not offered the types listed in the
  // hideAgentsAtCritical option (none by default).
  on('agent.offer', ($, e, next) => (isOffered(e.agent, level, o.hideAgentsAtCritical) ? next(e) : { isOffered: false }))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const u = r.usage ?? e.usage
    if (u) {
      await addLog($, {
        t: Date.now(),
        k: 'turn',
        sub: e.agentId !== undefined,
        model: u.model,
        inp: u.input_tokens,
        out: u.output_tokens,
        cr: u.cache_read_input_tokens,
        cc: u.cache_creation_input_tokens,
        ms: e.durationMs,
      })
    }
    return r
  })

  on('command.run', { command: 'budget' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const now = Date.now()
    const l = await loadLedger($)
    if (arg === 'unlock') {
      if (!l) return { text: 'Nothing is locked.' }
      await $.store.set(STORE_KEY, { ...l, unlockUntil: now + UNLOCK_MS })
      return { text: `Lock overridden until ${clock(now + UNLOCK_MS)}.` }
    }
    if (arg === 'reset') {
      await $.store.delete(STORE_KEY)
      level = 0
      showStatus($, pressure(undefined, now))
      return { text: "Budget ledger cleared; today's budget re-baselines on the next reply." }
    }
    const p = pressure(l, now)
    showStatus($, p)
    return { text: report(l, p, now) }
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const [a = '', b = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const p = pressure(await loadLedger($), Date.now())
    if (a === '') {
      return { text: report(await loadLedger($), p, Date.now()) }
    }
    if (a === 'why') {
      const now = Date.now()
      return { text: summarize(await loadLog($), nextMidnight(now) - DAY_MS, clock) }
    }
    if (a === 'auto') {
      pin = undefined
      route = undefined
    } else if (TIERS.includes(a as Tier)) {
      pin = { tier: a as Tier }
      route = decide(a as Tier, 'pinned', p)
    } else if (FAMILIES.includes(a as Family)) {
      const effort = EFFORTS.includes(b as Effort) ? (b as Effort) : 'high'
      pin = { spec: { family: a as Family, effort } }
      route = decide(route?.tier ?? 'standard', 'pinned', p)
    } else {
      return { text: 'Usage: /route why | auto | trivial | light | standard | deep | max | haiku|sonnet|opus [low|medium|high|xhigh|max]' }
    }
    showStatus($, p)
    return {
      text: pin
        ? `Pinned to ${route?.family}·${route?.effort} for this session (budget caps still apply). /route auto releases it.`
        : 'Routing is automatic again.',
    }
  })
}
