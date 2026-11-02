import { describe, expect, test } from 'claude-code/testing'
import { absorb, pressure, readLedger } from './ledger'
import type { Ledger } from './ledger'

const HOUR = 3_600_000
const t0 = Date.parse('2026-11-02T09:00:00Z')
const reset = '2026-11-07T00:00:00Z'
const opts = { warnPercent: 50, criticalPercent: 80, includeFiveHour: true }
const week = (percentUsed: number, resetsAt = reset) => [{ kind: 'seven_day', percentUsed, resetsAt }] as never
const five = (percentUsed: number) => ({ kind: 'five_hour', percentUsed, resetsAt: new Date(t0 + 3 * HOUR).toISOString() })

// The earlier shape of the ledger and its arithmetic, kept here as the reference the new form must match.
type OldLedger = { windowStartPct: number; carry: number; lastPct: number }
const oldUsed = (l: OldLedger) => l.carry + Math.max(0, l.lastPct - l.windowStartPct)

const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-6).toBe(true)

describe('ledger', () => {
  test('the first reading of a day sets the budget and spends nothing', () => {
    const l = absorb(undefined, week(20), t0, '2026-11-02')!
    expect(pressure(l, t0, '2026-11-02', opts).usedPts).toBe(0)
    near(l.budgetPts, 80 / 5) // 80 points left over 5 days
  })

  test('use within the day is the rise in the weekly percent', () => {
    const a = absorb(undefined, week(20), t0, '2026-11-02')!
    const b = absorb(a, week(23.2), t0 + HOUR, '2026-11-02')!
    const p = pressure(b, t0 + HOUR, '2026-11-02', opts)
    near(p.usedPts, 3.2)
    near(p.daily, (3.2 / b.budgetPts) * 100)
  })

  test('a weekly reset mid-day keeps what the day already spent', () => {
    const a = absorb(undefined, week(90), t0, '2026-11-02')!
    const b = absorb(a, week(95), t0 + HOUR, '2026-11-02')! // 5 points spent
    const c = absorb(b, week(2, '2026-11-14T00:00:00Z'), t0 + 2 * HOUR, '2026-11-02')! // window reset, 2 more
    near(pressure(c, t0 + 2 * HOUR, '2026-11-02', opts).usedPts, 7)
    const d = absorb(c, week(4, '2026-11-14T00:00:00Z'), t0 + 3 * HOUR, '2026-11-02')!
    near(pressure(d, t0 + 3 * HOUR, '2026-11-02', opts).usedPts, 9)
  })

  test('matches the earlier arithmetic through a day with a reset', () => {
    // old: carry + max(0, lastPct - windowStartPct); a reset moved the spend into carry and set the start to 0
    let old: OldLedger = { windowStartPct: 90, carry: 0, lastPct: 90 }
    let l = absorb(undefined, week(90), t0, '2026-11-02')!
    const steps: [number, string][] = [[91, reset], [93.5, reset], [1, '2026-11-14T00:00:00Z'], [2.5, '2026-11-14T00:00:00Z']]
    steps.forEach(([pct, r], i) => {
      const reseted = r !== reset
      if (reseted && old.windowStartPct !== 0) old = { carry: old.carry + Math.max(0, old.lastPct - old.windowStartPct), windowStartPct: 0, lastPct: old.lastPct }
      old = { ...old, lastPct: pct }
      l = absorb(l, week(pct, r), t0 + (i + 1) * HOUR, '2026-11-02')!
      near(pressure(l, t0 + (i + 1) * HOUR, '2026-11-02', opts).usedPts, oldUsed(old))
    })
  })

  test('a new day starts again from the new reading', () => {
    const a = absorb(undefined, week(20), t0, '2026-11-02')!
    const b = absorb(a, week(30), t0 + 24 * HOUR, '2026-11-03')!
    expect(pressure(b, t0 + 24 * HOUR, '2026-11-03', opts).usedPts).toBe(0)
    expect(b.alerted).toBe(0)
  })

  test('a ledger from another day exerts no pressure', () => {
    const a = absorb(undefined, week(20), t0, '2026-11-02')!
    expect(pressure(a, t0 + 24 * HOUR, '2026-11-03', opts).level).toBe(0)
  })

  test('levels follow the daily share and the five-hour window', () => {
    const a = absorb(undefined, week(20), t0, '2026-11-02')! // budget 16 points
    const at = (pct: number, fh?: number) => pressure(absorb(a, [...(week(pct) as never[]), ...(fh === undefined ? [] : [five(fh)])] as never, t0 + HOUR, '2026-11-02')!, t0 + HOUR, '2026-11-02', opts).level
    expect(at(20 + 4)).toBe(0) // 25%
    expect(at(20 + 8.5)).toBe(1) // 53%
    expect(at(20 + 13)).toBe(2) // 81%
    expect(at(20 + 16)).toBe(3) // 100%
    expect(at(20, 85)).toBe(2) // quiet day, hot 5-hour window
    expect(pressure(absorb(a, [...(week(20) as never[]), five(85)] as never, t0 + HOUR, '2026-11-02')!, t0 + HOUR, '2026-11-02', { ...opts, includeFiveHour: false }).level).toBe(0)
  })

  test('a reading with no weekly figure only updates the five-hour window', () => {
    const a = absorb(undefined, week(20), t0, '2026-11-02')!
    const b = absorb(a, [five(40)] as never, t0 + HOUR, '2026-11-02')!
    expect(b.lastPct).toBe(20)
    expect(b.fiveHourPct).toBe(40)
    expect(absorb(undefined, [five(40)] as never, t0, '2026-11-02')).toBeUndefined()
  })

  test('a ledger stored by an older version is read to the same figures', () => {
    const stored = { day: '2026-11-02', windowReset: reset, windowStartPct: 90, carry: 2, lastPct: 94, budgetPts: 4, fiveHourPct: 0, alerted: 1, wrapped: true, seenAt: t0 }
    const l = readLedger(stored) as Ledger
    expect(l).toBeDefined()
    expect('carry' in l || 'windowStartPct' in l).toBe(false)
    expect(l.alerted).toBe(1)
    expect(l.wrapped).toBe(true)
    near(pressure(l, t0, '2026-11-02', opts).usedPts, oldUsed(stored)) // 2 + 4 = 6
  })

  test('an older ledger whose reading dipped below its start keeps its carried points', () => {
    const stored = { day: '2026-11-02', windowReset: reset, windowStartPct: 90, carry: 2, lastPct: 88, budgetPts: 4, fiveHourPct: 0, alerted: 0, seenAt: t0 }
    near(pressure(readLedger(stored)!, t0, '2026-11-02', opts).usedPts, oldUsed(stored)) // 2, not 0
    near(oldUsed(stored), 2)
  })

  test('an incomplete stored ledger is refused rather than guessed', () => {
    const ok = { day: '2026-11-02', windowReset: reset, base: -20, lastPct: 25, budgetPts: 4, fiveHourPct: 0, alerted: 0, seenAt: t0 }
    expect(readLedger(ok)).toBeDefined()
    expect(readLedger({ ...ok, base: undefined })).toBeUndefined() // neither base nor the older fields
    expect(readLedger({ ...ok, budgetPts: undefined })).toBeUndefined()
    expect(readLedger({ ...ok, windowReset: undefined })).toBeUndefined()
    expect(readLedger({ ...ok, lastPct: Number.NaN })).toBeUndefined()
  })

  test('a current ledger is read unchanged, and rubbish is refused', () => {
    const l = absorb(undefined, week(20), t0, '2026-11-02')!
    expect(readLedger(JSON.parse(JSON.stringify(l)))).toEqual(l)
    expect(readLedger(undefined)).toBeUndefined()
    expect(readLedger('x')).toBeUndefined()
    expect(readLedger({ day: 3 })).toBeUndefined()
  })
})
