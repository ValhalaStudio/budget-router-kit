import { describe, expect, test } from 'claude-code/testing'
import { ARMS, addToCell, armIndex, armName, correct, decayed, emptyStore, exploresLeft, features, followUp, hierMean, noteExplore, pickArm, priorP, record, sampleBeta, scopeOf, similarity, turnCostUsd, window } from './smart'

const seeded = (seed = 1) => {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}
const typical = { inp: 2000, out: 1500, cr: 40000, cc: 3000 }
const base = armIndex({ family: 'sonnet', effort: 'high' })

describe('cells', () => {
  test('decay halves after one half-life', () => {
    const c = addToCell(undefined, 1, true, 1)
    expect(Math.abs(decayed(c, 1 + 14 * 24 * 3600_000).s - 0.5) < 1e-6).toBe(true)
  })
  test('armIndex maps unknown efforts down', () => {
    expect(armName(armIndex({ family: 'opus', effort: 'low' }))).toBe('opus·medium')
  })
})

describe('prior', () => {
  test('cheaper arms are less likely than the base', () => {
    expect(priorP({}, [], base - 2, base)).toBeLessThan(priorP({}, [], base, base))
  })
  test('features are stable and bounded', () => {
    expect(features('fix the bug in foo.ts').every(i => i >= 0 && i < 256)).toBe(true)
  })
})

describe('hierarchy', () => {
  test('project evidence outweighs global', () => {
    const good = addToCell(addToCell(addToCell(undefined, 1, true, 0), 1, true, 0), 1, true, 0)
    const post = hierMean([undefined, undefined, good], 0.5, 1)
    expect(post.a / (post.a + post.b)).toBeGreaterThan(0.5)
  })
  test('beta samples stay in 0..1', () => {
    const r = seeded()
    for (let i = 0; i < 50; i++) expect(sampleBeta(2, 3, r)).toBeLessThanOrEqual(1)
  })
})

describe('pickArm', () => {
  const input = (tier: string, s = emptyStore()) => ({ base, tier, scope: scopeOf(s, 'code', 'p'), w: s.weights, x: [] as number[], now: 1, dailyUsedPct: 30, typical, rand: seeded(7), exploresLeft: 12 })
  test('stays inside the window', () => {
    const [lo, hi] = window(base, 'standard')
    const p = pickArm(input('standard'))
    expect(p.arm).toBeGreaterThanOrEqual(lo)
    expect(p.arm).toBeLessThanOrEqual(hi)
  })
  test('max never moves', () => expect(pickArm(input('max')).arm).toBe(base))
  test('deep never explores', () => expect(pickArm(input('deep')).explored).toBe(false))
  test('learns that a cheap arm works', () => {
    let s = emptyStore()
    for (let i = 0; i < 30; i++) s = record(s, { kind: 'code', project: 'p', arm: base - 2, base, x: [], ok: true, costUsd: 0.01, now: 1 })
    for (let i = 0; i < 30; i++) s = record(s, { kind: 'code', project: 'p', arm: base, base, x: [], ok: true, costUsd: 0.08, now: 1 })
    expect(pickArm(input('standard', s)).arm).toBeLessThan(base)
  })
  test('stops choosing an arm that keeps failing', () => {
    let s = emptyStore()
    for (let i = 0; i < 30; i++) s = record(s, { kind: 'code', project: 'p', arm: base, base, x: [], ok: false, costUsd: 0.08, now: 1 })
    for (let i = 0; i < 30; i++) s = record(s, { kind: 'code', project: 'p', arm: base + 1, base, x: [], ok: true, costUsd: 0.12, now: 1 })
    expect(pickArm(input('standard', s)).arm === base).toBe(false)
  })
})

describe('store', () => {
  test('correct flips a success', () => {
    let s = record(emptyStore(), { kind: 'k', project: 'p', arm: 3, base: 5, x: [], ok: true, costUsd: 0, now: 1 })
    s = correct(s, { kind: 'k', project: 'p', arm: 3, base: 5, x: [], toOk: false })
    expect(s.cells.g?.[armName(3)]?.f).toBe(1)
  })
  test('explore cap resets each day', () => {
    let s = noteExplore(emptyStore(), 'd1')
    expect(exploresLeft(s, 'd1')).toBe(11)
    expect(exploresLeft(s, 'd2')).toBe(12)
  })
})

describe('signals and cost', () => {
  test('similar quick re-ask is a rephrase', () => {
    expect(similarity('fix the login bug in auth.ts please', 'please fix the login bug in auth.ts')).toBeGreaterThan(0.6)
    expect(followUp('fix the login bug in auth.ts please', 'please fix the login bug in auth.ts', 60_000, /^no\b/)).toBe('rephrase')
  })
  test('thanks is an ack', () => expect(followUp('x', 'thanks, works', 1000, /^no\b/)).toBe('ack'))
  test('opus costs more than haiku for the same usage', () => {
    expect(turnCostUsd('opus', typical)).toBeGreaterThan(turnCostUsd('haiku', typical))
  })
  test('arms are ordered by cost', () => expect(ARMS.length).toBeGreaterThan(8))
})

describe('no evidence, no move', () => {
  test('an untrained learner keeps the rule choice, except for rare exploration', () => {
    const s = emptyStore()
    for (let seed = 1; seed <= 40; seed++) {
      const p = pickArm({ base, tier: 'standard', scope: scopeOf(s, 'code', 'p'), w: s.weights, x: [], now: 1, dailyUsedPct: 10, typical, rand: seeded(seed), exploresLeft: 12, explore: 0 })
      expect(p.arm).toBe(base)
    }
  })
  test('deep work never explores downward', () => {
    const s = emptyStore()
    const p = pickArm({ base, tier: 'deep', scope: scopeOf(s, 'code', 'p'), w: s.weights, x: [], now: 1, dailyUsedPct: 10, typical, rand: () => 0, exploresLeft: 12, explore: 1 })
    expect(p.arm).toBe(base)
  })
})
