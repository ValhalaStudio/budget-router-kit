// The daily budget ledger: today's share of the weekly limit, in the weekly window's own percent points.
// Pure: the caller passes the clock and the local day, and does the storing.
import type { SessionRateLimit } from 'claude-code'

const DAY_MS = 86_400_000

export type Ledger = {
  day: string
  windowReset: string
  /** Points spent today = max(0, base + lastPct). It starts at -pct on a new day and absorbs the old window's spend on a reset. */
  base: number
  lastPct: number
  budgetPts: number
  fiveHourPct: number
  fiveHourReset?: string
  alerted: number
  wrapped?: boolean // the wrap-up notice was given today
  seenAt: number
}

/** Where today stands: percent of the daily budget used, the 5-hour and weekly windows, and the cap level. */
export type Pressure = { daily: number; five: number; week: number; usedPts: number; budgetPts: number; level: 0 | 1 | 2 | 3 }

export type PressureOptions = { warnPercent: number; criticalPercent: number; includeFiveHour: boolean }

/** A stored ledger from any version: older ones kept `windowStartPct` and `carry`, which fold into `base`. */
export function readLedger(raw: unknown): Ledger | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Partial<Ledger> & { windowStartPct?: number; carry?: number }
  if (typeof r.day !== 'string' || typeof r.lastPct !== 'number') return undefined
  const { windowStartPct, carry, ...rest } = r
  const base = typeof r.base === 'number' ? r.base : (carry ?? 0) - (windowStartPct ?? 0)
  return { ...(rest as Ledger), base }
}

const usedPoints = (l: Ledger) => Math.max(0, l.base + l.lastPct)

/** Folds a rate-limit reading into the ledger. The first reading of a day sets the day's budget. */
export function absorb(prev: Ledger | undefined, limits: readonly SessionRateLimit[], now: number, day: string): Ledger | undefined {
  const week = limits.find(l => l.kind === 'seven_day')
  const five = limits.find(l => l.kind === 'five_hour')
  if (!week) return prev && five ? { ...prev, fiveHourPct: five.percentUsed, fiveHourReset: five.resetsAt, seenAt: now } : prev
  const pct = week.percentUsed
  const reset = week.resetsAt ?? prev?.windowReset ?? new Date(now + 7 * DAY_MS).toISOString()
  const resetMs = Date.parse(reset)
  const daysLeft = Math.max(1, Math.ceil((resetMs - now) / DAY_MS))
  const sameWindow = prev !== undefined && Math.abs(Date.parse(prev.windowReset) - resetMs) < 6 * 3_600_000 && pct + 3 >= prev.lastPct
  let l: Ledger
  if (!prev || prev.day !== day) {
    // A new day may spend an even share of what is left of the week, so a quiet day leaves more for the next.
    l = { day, windowReset: reset, base: -pct, lastPct: pct, budgetPts: Math.max(0.5, (100 - pct) / daysLeft), fiveHourPct: 0, alerted: 0, seenAt: now }
  } else if (!sameWindow) {
    // The weekly window reset during the day: keep what today spent, grant at least an even share of the new week.
    l = { ...prev, base: usedPoints(prev), budgetPts: Math.max(prev.budgetPts, 100 / daysLeft) }
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

export function pressure(l: Ledger | undefined, now: number, day: string, opts: PressureOptions): Pressure {
  if (!l || l.day !== day) return { daily: 0, five: 0, week: l?.lastPct ?? 0, usedPts: 0, budgetPts: l?.budgetPts ?? 0, level: 0 }
  const usedPts = usedPoints(l)
  const daily = l.budgetPts > 0 ? (usedPts / l.budgetPts) * 100 : 0
  const five = l.fiveHourReset && Date.parse(l.fiveHourReset) > now ? l.fiveHourPct : 0
  const worst = Math.max(daily, opts.includeFiveHour ? five : 0)
  const level = daily >= 100 ? 3 : worst >= opts.criticalPercent ? 2 : worst >= opts.warnPercent ? 1 : 0
  return { daily, five, week: l.lastPct, usedPts, budgetPts: l.budgetPts, level }
}
