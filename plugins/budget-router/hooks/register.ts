import type { EngineInterface, PluginOptions, Register, SessionRateLimit } from 'claude-code'
import {
  addPace,
  auditCommands,
  helperHint,
  isOffered,
  isUnrealBuildPrompt,
  parseList,
  parseSubagentModels,
  planSpawn,
  projectExhaustion,
  pushLog,
  shouldStick,
  summarize,
  verdict,
  vetText,
} from './policy'
import type { Finding, LogEntry, PaceSample } from './policy'
import { applyEscalation, buildIndex, escalationFor, pacerStep, paceSteps, shiftLadder, suggestFrom, targetPercent } from './policy'
import type { CatalogIndex, CatalogItem, PacerState } from './policy'
import { ARMS, armIndex, armName, correct as smartCorrect, emptyStore, estimateSavings, exploresLeft, features, followUp, noteExplore, pickArm, record as smartRecord, scopeOf, smartSummary, fadeFamily, kindOf, stepBucket, exportContribution, turnCostUsd, DEFAULT_PRICES, priceFor } from './smart'
import type { Momentum, Price, SmartStore, Usage } from './smart'
import { PRIOR, PRIOR_INFO } from './prior'
import { LADDER_SIZE, REDO_RE, bucketOf, flipOutcome, idleRebuild, idleText, kTokens, ladderIndex, learnedMove, learnedSummary, looksSensitive, noteCommand, recordOutcome, rungName, runbookBody, runbookFile, runbookHintText, runbookItem, runbookName, runbookRunCommand, sizeBucket, sizeNudgeText, stepReadUsd, stepWriteUsd, usd } from './policy'
import type { CmdStats, Learned, Runbook } from './policy'

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
  wrapUpPercent: number
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
  agentHints: boolean
  unrealRules: boolean
  cacheWarmMinutes: number
  paceWarnHours: number
  catalogHints: boolean
  escalateOnTrouble: boolean
  escalateAfterErrors: number
  escalateModelAfterErrors: number
  paceControl: boolean
  dayStartHour: number
  dayEndHour: number
  paceSlack: number
  idleGuard: string
  idleMinTokens: number
  nudgeTokens: number
  runbooks: boolean
  runbookAfter: number
  runbookDir: string
  learn: boolean
  learnMinSamples: number
  learnExplore: number
  learnMode: 'live' | 'shadow' | 'classic' | 'off'
  qualityWeight: number
  invite: boolean
  priceTable?: Record<Family, Price>
  reflect: boolean
  reflectPerDay: number
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
    classifier: str(options.classifier, 'haiku'),
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
    lockAtLimit: bool(options.lockAtLimit, true),
    includeFiveHour: bool(options.includeFiveHour, true),
    haikuMaxContext: num(options.haikuMaxContext, 100_000),
    stickyContext: num(options.stickyContext, 60_000),
    models: {
      haiku: str(options.haikuModel, 'haiku'),
      sonnet: str(options.sonnetModel, 'sonnet'),
      opus: str(options.opusModel, 'opus'),
    },
    subagentModels: parseSubagentModels(options.subagentModels),
    hideAgentsAtCritical: parseList(options.hideAgentsAtCritical),
    logDecisions: bool(options.logDecisions, true),
    agentHints: bool(options.agentHints, true),
    unrealRules: bool(options.unrealRules, true),
    cacheWarmMinutes: num(options.cacheWarmMinutes, 55),
    paceWarnHours: num(options.paceWarnHours, 3),
    catalogHints: bool(options.catalogHints, true),
    escalateOnTrouble: bool(options.escalateOnTrouble, true),
    escalateAfterErrors: num(options.escalateAfterErrors, 3),
    escalateModelAfterErrors: num(options.escalateModelAfterErrors, 6),
    paceControl: bool(options.paceControl, true),
    dayStartHour: num(options.dayStartHour, 8),
    dayEndHour: num(options.dayEndHour, 24),
    paceSlack: num(options.paceSlack, 15),
    idleGuard: ['off', 'warn', 'ask'].includes(str(options.idleGuard, 'warn')) ? str(options.idleGuard, 'warn') : 'warn',
    idleMinTokens: num(options.idleMinTokens, 60_000),
    nudgeTokens: num(options.nudgeTokens, 150_000),
    runbooks: bool(options.runbooks, true),
    runbookAfter: num(options.runbookAfter, 4),
    runbookDir: str(options.runbookDir, ''),
    learn: bool(options.learn, true),
    learnMinSamples: num(options.learnMinSamples, 8),
    learnExplore: num(options.learnExplore, 0.1),
    learnMode: (['live', 'shadow', 'classic', 'off'].includes(str(options.learnMode, 'live')) ? str(options.learnMode, 'live') : 'live') as Opts['learnMode'],
    qualityWeight: num(options.qualityWeight, 0.05),
    invite: bool(options.inviteContribution, true),
    priceTable: parsePrices(options.priceTable),
    reflect: bool(options.reflect, false),
    reflectPerDay: num(options.reflectPerDay, 8),
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
let lastMainTurnAt = 0 // when the last main-conversation turn ended (the prompt cache is warm for a while after)
let soft = false // /budget soft: no refusals at 100%, stay at the second cap
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

const PACE_KEY = 'pace'
const SOFT_KEY = 'soft'

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
        $.ui.toast(`⏱ ${paceNote}. /route light or /route haiku slows it down.`, { timeoutMs: 20_000 })
      }
    } else if (pr) {
      paceNote = `pace ${Math.round(pr.ratePerHour)}% of the day per hour: fine for today`
    }
  } catch {
    // the forecast is a courtesy
  }
}

// ---- v0.5: pacer, escalation, and suggestions from the installed skills and agents ----
const PACER_KEY = 'pacer'
let pacerU = 0 // controller output: how many cost steps to shed (0 to 2)
let escalation: { turnId: string; effortUp: boolean; modelUp: boolean } | undefined
const catalog = new Map<string, CatalogItem>()
let catalogIndex: CatalogIndex | undefined

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

function noteCatalog(item: CatalogItem) {
  if (item.plugin === 'budget-router' || item.name.startsWith('budget-router')) return
  catalog.set(`${item.kind}:${item.name}`, item)
  catalogIndex = undefined
}

async function refreshCatalog($: EngineInterface) {
  try {
    for (const c of await $.command.list()) {
      if (c.source === 'builtin') continue
      noteCatalog({ kind: 'skill', name: c.name, description: c.description, source: c.source, ...(c.plugin ? { plugin: c.plugin } : {}) })
    }
  } catch {
    // suggestions are optional
  }
}

function catalogSuggest(text: string) {
  const items = [...(o.catalogHints ? catalog.values() : []), ...(o.runbooks ? runbooks.map(runbookItem) : [])]
  if (items.length === 0) return undefined
  catalogIndex ??= buildIndex(items)
  return suggestFrom(text, catalogIndex)
}

// ---- v0.6: ghost-token guard, runbook memory, learner ----
const CMDS_KEY = 'cmdstats'
const BOOK_KEY = 'runbooks'
const BANDIT_KEY = 'bandit'
const REFLECT_KEY = 'reflect'
let cmdStats: CmdStats = {}
let runbooks: Runbook[] = []
let learnedData: Learned = {}
let turnErrors = 0 // failed tool calls since the last prompt, counted as they happen
let v06Loaded = false
let lastSizeBucket = 0
let idleAskedAt = 0
let currentBucket = ''
let pending: { bucket: string; rung: number; text: string } | undefined
let lastOutcome: { bucket: string; rung: number; ok: boolean; at: number } | undefined
// Smart learner (0.8): cost-aware bandit, see smart.ts. Stores only counts, costs and hashed weights.
const SMART_KEY = 'smart'
const PLUGIN_VERSION = '0.10.3'
const INVITE_AFTER = 60
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
// The hook event carries no working directory, but a spawned process starts in the project folder.
async function detectProject($: EngineInterface) {
  for (const cmd of [['pwd'], ['powershell', '-NoProfile', '-Command', '(Get-Location).Path']]) {
    try {
      const r = await $.process.run(cmd, { timeoutMs: 8000 })
      const dir = r.stdout.trim()
      if (dir !== '') {
        smartProject = projectHash(dir.toLowerCase())
        return
      }
    } catch {
      // try the next one
    }
  }
}
const smartOn = () => o.learn && (o.learnMode === 'live' || o.learnMode === 'shadow')

const SHELLS = new Set(['Bash', 'PowerShell'])
const plain = (v: string) => v.replace(/[^A-Za-z0-9 .:_/-]/g, '').slice(0, 60)
const waiting = () =>
  Object.entries(cmdStats)
    .filter(([, c]) => !c.saved && c.n >= 2)
    .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)

async function loadV06($: EngineInterface) {
  cmdStats = ((await $.store.get(CMDS_KEY)) as CmdStats | undefined) ?? {}
  runbooks = ((await $.store.get(BOOK_KEY)) as Runbook[] | undefined) ?? []
  learnedData = ((await $.store.get(BANDIT_KEY)) as Learned | undefined) ?? {}
  smartData = ((await $.store.get(SMART_KEY)) as SmartStore | undefined) ?? emptyStore()
  catalogIndex = undefined
  v06Loaded = true
}

// Watches tool calls without changing them: counts failed calls since the last prompt (for
// escalation and the learner) and shell commands that repeat (runbook memory). It reads nothing
// from the conversation history; it sees each call as it happens, like any hook does.
async function observeTool($: EngineInterface, e: { tool: string; agentId?: string; command?: unknown }, failed: boolean) {
  if (e.agentId !== undefined) return
  if (failed) {
    turnErrors++
    return
  }
  if (!o.runbooks || !SHELLS.has(e.tool) || typeof e.command !== 'string') return
  if (!v06Loaded) await loadV06($)
  const hit = noteCommand(cmdStats, e.tool, e.command, Date.now(), o.runbookAfter)
  if (!hit) return
  cmdStats = hit.stats
  const stat = cmdStats[hit.key]
  if (hit.crossed && stat) {
    cmdStats = { ...cmdStats, [hit.key]: { ...stat, offered: true } }
    const snippet = e.command.trim().replace(/\s+/g, ' ').slice(0, 70)
    $.ui.toast(`You have run this ${stat.n} times: "${snippet}". /runbook save keeps it as a script I can point you to.`, { timeoutMs: 20_000 })
    await addLog($, { t: Date.now(), k: 'runbook', name: runbookName(e.command), act: 'offered' })
  }
  await $.store.set(CMDS_KEY, cmdStats)
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
      // One invitation, once, after enough turns to have something worth sharing. Never repeated.
      if (o.invite && !smartData.invited && smartData.seen >= INVITE_AFTER) {
        smartData = { ...smartData, invited: true }
        $.ui.toast(`budget-router has learned from ${smartData.seen} of your turns. If you would like to help it start better for others, /budget learn export prints anonymous counts (no prompts, no names) that you can read and choose to share. This notice shows once; the inviteContribution option turns it off.`, { timeoutMs: 30_000 })
      }
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
    if (o.reflect && !e.isAborted && turnErrors >= 1 && turnErrors <= 2) {
      const verdictOk = await reflectJudge($, done.text, e.answer, turnErrors)
      if (verdictOk !== undefined) ok = verdictOk
    }
    learnedData = recordOutcome(learnedData, done.bucket, done.rung, ok)
    lastOutcome = { bucket: done.bucket, rung: done.rung, ok, at: Date.now() }
    await $.store.set(BANDIT_KEY, learnedData)
  } catch {
    // learning is optional
  }
}

// A cheap second opinion for the unclear cases (one or two failed tool calls), a few per day.
async function reflectJudge($: EngineInterface, request: string, answer: string, errors: number): Promise<boolean | undefined> {
  try {
    const day = localDay(Date.now())
    const used = (await $.store.get(REFLECT_KEY)) as { day: string; n: number } | undefined
    const n = used && used.day === day ? used.n : 0
    if (n >= o.reflectPerDay) return undefined
    await $.store.set(REFLECT_KEY, { day, n: n + 1 })
    const r = await $.model.complete({
      model: o.models.haiku,
      system: 'You grade whether an AI assistant completed a request. Reply with exactly one word: GOOD or WEAK.',
      prompt: `Request: ${request}\nFailed tool calls during the turn: ${errors}\nFinal reply: ${answer.slice(0, 600)}`,
      maxTokens: 8,
      effort: 'low',
      timeoutMs: 6000,
    })
    const word = r.isAnswered ? r.text.toUpperCase().match(/GOOD|WEAK/)?.[0] : undefined
    return word === undefined ? undefined : word === 'GOOD'
  } catch {
    return undefined
  }
}

async function homeDir($: EngineInterface): Promise<string> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
}

async function writeRunbook($: EngineInterface, dir: string, file: string, body: string) {
  const full = `${dir}/${file}`
  try {
    await $.fs.write(full, body)
    return
  } catch {
    // the folder may not exist yet
  }
  if (/^[A-Za-z]:/.test(dir)) {
    await $.process.run(['powershell', '-NoProfile', '-Command', `New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null`], { timeoutMs: 10_000 })
  } else {
    await $.process.run(['mkdir', '-p', dir], { timeoutMs: 10_000 })
  }
  await $.fs.write(full, body)
}

async function runbookCommand($: EngineInterface, raw: string): Promise<string> {
  if (!v06Loaded) await loadV06($)
  const [verb = 'list', ...rest] = raw.trim().split(/\s+/)
  const cands = waiting()
  if (verb === '' || verb === 'list') {
    const lines = ['Runbooks (commands you keep repeating, saved as scripts):']
    if (runbooks.length === 0) lines.push('  none saved yet')
    for (const rb of runbooks) lines.push(`  ${rb.name}: ${rb.runs}`)
    lines.push('Repeated commands not saved yet (most runs first):')
    if (cands.length === 0) lines.push('  none')
    cands.slice(0, 8).forEach(([, c], n) => lines.push(`  #${n + 1} ${c.n}x ${c.tool}: ${c.sample.replace(/\s+/g, ' ').slice(0, 90)}`))
    lines.push('/runbook save [#n] [name] [words describing it] | forget <name> | ignore')
    return lines.join('\n')
  }
  if (verb === 'ignore') {
    for (const [k, c] of cands) cmdStats[k] = { ...c, offered: true }
    await $.store.set(CMDS_KEY, cmdStats)
    return 'Will not offer the commands currently listed again.'
  }
  if (verb === 'forget') {
    const name = rest[0]
    const before = runbooks.length
    runbooks = runbooks.filter(r => r.name !== name)
    if (runbooks.length === before) return `No runbook named "${name ?? ''}".`
    await $.store.set(BOOK_KEY, runbooks)
    catalogIndex = undefined
    return `Forgot ${name}. The script file was left where it is.`
  }
  if (verb === 'save') {
    let args = rest
    let pick = cands[0]
    if (args[0] && /^#?\d+$/.test(args[0])) {
      pick = cands[Number(args[0].replace('#', '')) - 1]
      args = args.slice(1)
    }
    if (!pick) return 'Nothing to save yet: no command has been repeated.'
    const [key, stat] = pick
    if (looksSensitive(stat.sample)) return 'That command looks like it contains a key, a login or other private value, so it was not saved. Put the value in an environment variable and try again.'
    let name = (args[0] ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '') || runbookName(stat.sample)
    const base = name
    for (let n = 2; runbooks.some(r => r.name === name); n++) name = `${base}-${n}`
    const dir = o.runbookDir !== '' ? o.runbookDir.replace(/\\/g, '/') : `${(await homeDir($)).replace(/\\/g, '/')}/.claude/runbooks`
    if (dir.startsWith('/.claude')) return 'Could not find your home folder; set the runbookDir option and try again.'
    const file = `${dir}/${runbookFile(name, stat.tool)}`
    try {
      await writeRunbook($, dir, runbookFile(name, stat.tool), runbookBody(stat.sample, stat.tool, new Date()))
    } catch (err) {
      return `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}`
    }
    const rb: Runbook = { name, file, tool: stat.tool, description: `${args.slice(1).join(' ')} ${stat.sample}`.slice(0, 600), runs: '' }
    rb.runs = runbookRunCommand(rb)
    runbooks = [...runbooks, rb]
    cmdStats[key] = { ...stat, saved: name }
    catalogIndex = undefined
    await $.store.set(BOOK_KEY, runbooks)
    await $.store.set(CMDS_KEY, cmdStats)
    await addLog($, { t: Date.now(), k: 'runbook', name, act: 'saved' })
    return `Saved ${file}\nRun it with: ${rb.runs}\nFuture prompts that match it will get a one-line pointer to it. Read the script before you run it.`
  }
  return 'Usage: /runbook [list] | save [#n] [name] [words describing it] | forget <name> | ignore'
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
        if (!before || before.effortUp !== merged.effortUp || before.modelUp !== merged.modelUp) {
          escalation = merged
          const to = applyEscalation(base, merged)
          await addLog($, { t: Date.now(), k: 'escalate', from: `${base.family}·${base.effort}`, to: `${to.family}·${to.effort}`, errors })
        }
      }
    } catch {
      // keep the route as chosen
    }
  }
  if (!escalation) return base
  const raised = applyEscalation(base, escalation)
  return level >= 2 ? capSpec(raised, o.criticalCap) : level === 1 ? capSpec(raised, o.warnCap) : raised
}

const VET_EXT = /\.(md|json|ts|tsx|js|mjs|cjs|ps1|sh|py|yaml|yml|toml)$/i

// /budget vet <path>: static red-flag scan of a skill, agent, command or plugin folder before installing it.
async function vetPath($: EngineInterface, target: string): Promise<string> {
  if (target === '') return 'Usage: /budget vet <file or folder of a skill, agent or plugin>'
  const files: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return
    for (const ent of await $.fs.list(dir)) {
      if (files.length >= 60) return
      const full = `${dir.replace(/[\\/]+$/, '')}/${ent.name}`
      if (ent.kind === 'dir') {
        if (!/^(node_modules|\.git)$/.test(ent.name)) await walk(full, depth + 1)
      } else if (ent.kind === 'file' && VET_EXT.test(ent.name)) {
        files.push(full)
      }
    }
  }
  try {
    const st = await $.fs.stat(target)
    if (st.kind === 'dir') await walk(target, 0)
    else files.push(target)
  } catch (err) {
    return `Cannot read ${target}: ${err instanceof Error ? err.message : String(err)}`
  }
  const lines = [`Budget router: vet ${target} (${files.length} files read; advisory only, read everything yourself before installing)`]
  const all: Finding[] = []
  for (const f of files) {
    try {
      const found = vetText(String(await $.fs.read(f)))
      all.push(...found)
      for (const x of found) lines.push(`  ${x.sev.toUpperCase().padEnd(6)} ${f.slice(target.length).replace(/^[\\/]/, '') || f}: ${x.what}`)
    } catch {
      lines.push(`  skipped ${f} (unreadable or over 4 MiB)`)
    }
    if (lines.length > 45) {
      lines.push('  ... more findings not shown')
      break
    }
  }
  lines.push(`  verdict: ${verdict(all)}`)
  return lines.join('\n')
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
    const pick = pickArm({ base, tier, scope: scopeOf(smartData, kind, smartProject), w: smartData.weights, x: smartX, now, dailyUsedPct: p.daily, qualityWeight: o.qualityWeight, typical: lastTurnUsage, exploresLeft: exploresLeft(smartData, dayKey()), minSamples: o.learnMinSamples, explore: o.learnExplore, rand: Math.random, kind, prior: PRIOR })
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
  // applies. An explicit "think hard" (max) and a /route pin are left alone.
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
      ? `⛔ Today's Claude budget is spent (${day}). New prompts are refused until ${clock(nextMidnight(now))}; /budget unlock overrides for 1 hour.`
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
  const lock = o.lockAtLimit && !soft ? `Prompts are refused at 100% until ${clock(nextMidnight(now))}` : `Turns stay at ${o.criticalCap.family}·${o.criticalCap.effort} from 100%`
  const text = `⏳ ${Math.round(p.daily)}% of today's Claude budget is used (about ${left}% left). Good moment to finish what is in hand, commit, and note where you stopped. ${lock}.`
  $.ui.toast(text, { timeoutMs: 25_000 })
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
    `  lock: ${!o.lockAtLimit ? 'off (option)' : soft ? 'soft: no refusal at 100%, stays at the second cap (/budget hard to refuse)' : 'hard: refuses prompts at 100%'}`,
    `  /route why shows the recent decisions and today's token use${o.logDecisions ? '' : ' (logging is off)'}; /budget skills and /budget vet <path> check the skill list`,
  )
  if (ctxTokens > 0) lines.push(`  context: ${kTokens(ctxTokens)} tokens, about ${usd(stepReadUsd(ctxTokens, route?.family ?? 'sonnet'))} to re-read per step from cache, about ${usd(stepWriteUsd(ctxTokens, route?.family ?? 'sonnet'))} if the cache has expired; /compact or a fresh session shrinks it`)
  if (paceNote !== '') lines.push(`  ${paceNote}`)
  lines.push(`  pace control: ${!o.paceControl ? 'off' : pacerU >= 0.5 ? `shedding ${paceSteps(pacerU)} cost step(s) (controller ${pacerU.toFixed(2)})` : `on, on pace (controller ${pacerU.toFixed(2)})`}`)
  lines.push(`  idle guard: ${o.idleGuard}${o.idleGuard === 'off' ? '' : ` (after ${o.cacheWarmMinutes} min idle${o.idleGuard === 'ask' ? '; pauses that prompt once' : ''})`}; context nudge ${o.nudgeTokens > 0 ? `every ${kTokens(o.nudgeTokens)}` : 'off'}`)
  lines.push(`  runbooks: ${!o.runbooks ? 'off' : `${runbooks.length} saved, ${waiting().length} repeated command(s) waiting (/runbook)`}`)
  if (!o.learn || o.learnMode === 'off') lines.push('  learner: off')
  else if (smartOn()) {
    const rows = smartSummary(smartData, Date.now())
    lines.push(`  learner: ${o.learnMode} (cost-aware, ${smartData.seen} turns seen${rows.length === 0 ? ', nothing recorded yet' : ''}; ${PRIOR_INFO.contributors > 0 ? `shared prior from ${PRIOR_INFO.contributors} contributors` : 'no shared prior yet'}; /budget learn for detail)`)
    lines.push(...rows)
  } else {
    const rows = learnedSummary(learnedData, rungName)
    lines.push(`  learner: on, success rate per kind of prompt and model step${rows.length === 0 ? ' (no turns recorded yet)' : ':'}`)
    lines.push(...rows)
  }
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
    await detectProject($)
    await $.command.register({
      name: 'budget',
      description: "Show today's Claude usage budget and route; 'unlock' overrides the lock for 1 hour",
      argumentHint: '[unlock|reset|soft|hard|skills|vet <path>|learn [reset|export]|wipe]',
    })
    await $.command.register({
      name: 'route',
      description: 'Pin the model/effort tier for this session, or auto',
      argumentHint: '[why|auto|trivial|light|standard|deep|max|haiku|sonnet|opus] [low|medium|high|xhigh|max]',
    })
    await $.command.register({
      name: 'runbook',
      description: 'Save commands you keep repeating as scripts, and list them',
      argumentHint: '[list|save [#n] [name]|forget <name>|ignore]',
    })
    learned = ((await $.store.get(MODELS_KEY)) as typeof learned | undefined) ?? {}
    soft = (await $.store.get(SOFT_KEY)) === true
    const savedPacer = (await $.store.get(PACER_KEY)) as PacerState | undefined
    pacerU = savedPacer && savedPacer.day === localDay(Date.now()) ? savedPacer.u : 0
    await refreshCatalog($)
    await loadV06($)
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
    if (o.nudgeTokens > 0) {
      const b = sizeBucket(ctxTokens, o.nudgeTokens)
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
      // One heads-up before the lock, so there is time to finish the thing in hand.
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

  on('prompt.submit', async ($, e, next) => {
    const now = Date.now()
    const l = await loadLedger($)
    const p = pressure(l, now)
    level = p.level
    if (!v06Loaded) await loadV06($)
    const isOwnCommand = /^\s*\/(budget|route|runbook)\b/.test(e.text)
    if (p.level === 3 && o.lockAtLimit && !soft && !isOwnCommand && !((l?.unlockUntil ?? 0) > now)) {
      return {
        drop: `⛔ Today's Claude budget is spent (${Math.round(p.daily)}% of today's share; week at ${Math.round(p.week)}%). Locked until ${clock(nextMidnight(now))}. /budget unlock overrides for 1 hour.`,
      }
    }
    let extra: string[] = []
    // A prompt typed into a running turn rides that turn's model.
    if (e.turnId === undefined && ['composer', 'bridge', 'sdk'].includes(e.origin.kind) && !isOwnCommand) {
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
      const idle = o.idleGuard === 'off' ? undefined : idleRebuild(ctxTokens, lastMainTurnAt > 0 ? now - lastMainTurnAt : undefined, o.cacheWarmMinutes * 60_000, o.idleMinTokens, route?.family ?? 'sonnet')
      if (idle) {
        await addLog($, { t: now, k: 'idle', ctx: idle.ctx, usd: Math.round(idle.rebuildUsd * 100) / 100 })
        if (o.idleGuard === 'ask' && now - idleAskedAt > 10 * 60_000) {
          idleAskedAt = now
          return { drop: `${idleText(idle)} Send the prompt again to carry on as it is.` }
        }
        $.ui.toast(idleText(idle), { timeoutMs: 20_000 })
      }
      let c: { tier: Tier; why: string } = pin ? { tier: pin.tier ?? route?.tier ?? 'standard', why: 'pinned' } : await classify($, e.text, route?.tier)
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
      if (route.why.includes('learned')) await addLog($, { t: now, k: 'learn', bucket: currentBucket, why: route.why.split(', ').filter(x => x.startsWith('learned')).join('; ') })
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
      // One suggestion at most, decided by keywords (no model call): this plugin's own helper
      // agents first, then any installed skill or agent whose description clearly fits.
      if (o.agentHints && route.tier !== 'trivial') {
        const hint = helperHint(e.text)
        if (hint) {
          extra = [hint.text]
          await addLog($, { t: now, k: 'hint', agent: hint.agent })
        } else if (o.catalogHints || o.runbooks) {
          const found = catalogSuggest(e.text)
          if (found) {
            const book = found.item.kind === 'runbook' ? runbooks.find(r => r.name === found.item.name) : undefined
            if (book) {
              // the person's own saved script: a pointer for the model
              extra = [runbookHintText(book)]
              await addLog($, { t: now, k: 'runbook', name: book.name, act: 'hint' })
            } else {
              // someone else's skill or agent: tell the person, never steer the model toward it
              const owner = found.item.plugin ? ` from ${plain(found.item.plugin)}` : ''
              $.ui.toast(`An installed ${found.item.kind}${owner} may fit this request: ${plain(found.item.name)}. Use it if you want it.`, { timeoutMs: 15_000 })
              await addLog($, { t: now, k: 'hint', agent: found.item.name })
            }
          }
        }
      }
    }
    showStatus($, p)
    return next(extra.length > 0 ? { ...e, context: [...(e.context ?? []), ...extra] } : e)
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
    stepsNow++
    const base = route ?? capSpec(o.tiers.standard, level >= 2 ? o.criticalCap : level === 1 ? o.warnCap : o.tiers.max)
    const spec = await troubleAdjust($, e, base)
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
    if (p.level === 3 && o.lockAtLimit && !soft && !((l?.unlockUntil ?? 0) > now)) {
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
  on('agent.offer', ($, e, next) => {
    if (e.source !== 'built-in') noteCatalog({ kind: 'agent', name: e.agent, description: e.description, source: e.source })
    return isOffered(e.agent, level, o.hideAgentsAtCritical) ? next(e) : { isOffered: false }
  })

  // Passes every tool call through untouched; see observeTool.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      await observeTool($, e as { tool: string; agentId?: string; command?: unknown }, r.isError === true && r.deny === undefined)
    } catch {
      // observing must never get in the way
    }
    return r
  })

  // Records which skill was used, so /route why can say whether a suggestion was followed.
  on('skill.prompt', async ($, e, next) => {
    await addLog($, { t: Date.now(), k: 'skill', name: e.skill })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const u = r.usage ?? e.usage
    if (e.agentId === undefined) {
      lastMainTurnAt = Date.now()
      await afterMainTurn($, e, u ? { inp: u.input_tokens, out: u.output_tokens, cr: u.cache_read_input_tokens, cc: u.cache_creation_input_tokens, family: familyOf(u.model), model: u.model } : undefined)
    }
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
    const raw = e.args.trim()
    const arg = raw.toLowerCase()
    const now = Date.now()
    const l = await loadLedger($)
    if (arg === 'learn' || arg.startsWith('learn ')) {
      if (!v06Loaded) await loadV06($)
      const sub = arg.slice(5).trim()
      if (sub === 'reset') {
        smartData = emptyStore()
        smartLast = undefined
        await $.store.delete(SMART_KEY)
        return { text: 'Smart learner cleared. It starts from the rule choice again.' }
      }
      if (sub === 'export') {
        const c = exportContribution(smartData, PLUGIN_VERSION, now)
        return { text: ['Learner counts, ready to share if you choose to (nothing is sent anywhere by this plugin). Only turn counts, successes and cost per model/effort and kind of prompt: no prompt text, folders, project names or dates. See README, "Contribute your counts".', JSON.stringify(c, null, 1)].join('\n') }
      }
      const rows = smartSummary(smartData, now)
      const sav = estimateSavings(smartData)
      return { text: [`Smart learner: mode ${o.learnMode}, ${smartData.seen} turns seen, ${exploresLeft(smartData, dayKey())} explorations left today.`, rows.length === 0 ? '  nothing recorded yet' : 'Success rate and cost per turn, by kind of work:', ...rows, `Estimated saving versus always taking the rule choice: about $${sav.toFixed(2)} (price-table estimate, not an invoice).`, '/budget learn reset clears it; /budget learn export prints counts you can choose to share (no prompt text is stored).'].join('\n') }
    }
    if (arg === 'skills') return { text: auditCommands(await $.command.list()) }
    if (arg === 'vet' || arg.startsWith('vet ')) return { text: await vetPath($, raw.slice(3).trim()) }
    if (arg === 'soft' || arg === 'hard') {
      soft = arg === 'soft'
      await $.store.set(SOFT_KEY, soft)
      return {
        text: soft
          ? 'Soft lock: at 100% of the daily budget prompts are not refused; turns stay at the second cap. Pair it with the autoContinueAtUsageLimit setting to wait out a real limit. /budget hard refuses again.'
          : 'Hard lock: prompts are refused at 100% of the daily budget (unless the lockAtLimit option is off).',
      }
    }
    if (arg === 'unlock') {
      if (!l) return { text: 'Nothing is locked.' }
      await $.store.set(STORE_KEY, { ...l, unlockUntil: now + UNLOCK_MS })
      return { text: `Lock overridden until ${clock(now + UNLOCK_MS)}.` }
    }
    if (arg === 'wipe') {
      // Everything this plugin keeps: the budget ledger, models seen, burn-rate samples, the decision
      // log, pace controller, runbook counts and list, and the learner's counts. Script files you saved
      // are left where they are.
      for (const key of [STORE_KEY, MODELS_KEY, LOG_KEY, PACE_KEY, SOFT_KEY, PACER_KEY, CMDS_KEY, BOOK_KEY, BANDIT_KEY, REFLECT_KEY, SMART_KEY]) await $.store.delete(key)
      learned = {}
      soft = false
      pacerU = 0
      cmdStats = {}
      runbooks = []
      learnedData = {}
      smartData = emptyStore()
      smartPending = undefined
      smartLast = undefined
      pending = undefined
      lastOutcome = undefined
      catalogIndex = undefined
      level = 0
      showStatus($, pressure(undefined, now))
      return { text: 'Everything budget-router had stored is deleted. Scripts saved with /runbook were left in place (see /runbook list before you forget them).' }
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

  on('command.run', { command: 'runbook' }, async ($, e) => ({ text: await runbookCommand($, e.args) }))

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
