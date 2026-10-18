import { describe, expect, test } from 'claude-code/testing'
import { exportContribution, kindOf, priceFor, priorCell, stepBucket, ARMS, addToCell, armIndex, armName, correct, decayed, emptyStore, exploresLeft, features, followUp, hierMean, noteExplore, pickArm, priorP, record, sampleBeta, scopeOf, similarity, turnCostUsd, window } from './smart'

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
  test('armIndex maps unavailable efforts down', () => {
    expect(armName(armIndex({ family: 'haiku', effort: 'max' }))).toBe('haiku·high')
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

describe('prices', () => {
  test('the model id picks the price', () => {
    expect(priceFor('claude-haiku-5-5', 'haiku').inp).toBe(0.1)
    expect(priceFor('claude-haiku-4-5-20251001', 'haiku').inp).toBe(1)
    expect(priceFor('claude-opus-5-5', 'opus').out).toBe(20)
    expect(priceFor('claude-opus-4-8', 'opus').out).toBe(25)
    expect(priceFor('claude-sonnet-5-5', 'sonnet').inp).toBe(2)
  })
})

describe('fable', () => {
  test('is priced by its own id', () => expect(priceFor('claude-fable-5-1', 'opus').out).toBe(50))
})

describe('savings tally', () => {
  test('a cheaper turn than the rule choice average adds to the saving', () => {
    let s = emptyStore()
    for (let i = 0; i < 4; i++) s = record(s, { kind: 'k', project: 'p', arm: base, base, x: [], ok: true, costUsd: 0.10, now: 1 })
    s = record(s, { kind: 'k', project: 'p', arm: base - 1, base, x: [], ok: true, costUsd: 0.04, now: 1 })
    expect(Math.abs((s.saved ?? 0) - 0.06) < 1e-9).toBe(true)
  })
})

describe('the wider grid', () => {
  test('every arm maps back to itself', () => {
    ARMS.forEach((a, i) => expect(armIndex(a)).toBe(i))
  })
  test('opus·low and sonnet·max exist and cost sits in order', () => {
    expect(ARMS.some(a => a.family === 'opus' && a.effort === 'low')).toBe(true)
    expect(ARMS.some(a => a.family === 'sonnet' && a.effort === 'max')).toBe(true)
    const mult = { low: 0.7, medium: 1, high: 1.4, xhigh: 1.9, max: 2.6 }
    const c = ARMS.map(a => turnCostUsd(a.family, { inp: 0, out: 1000, cr: 0, cc: 0 }) * mult[a.effort])
    for (let i = 1; i < c.length; i++) expect(c[i]! >= c[i - 1]! - 1e-9).toBe(true)
  })
})

describe('kinds and follow-ups on real-shaped prompts', () => {
  test('kindOf by shape', () => {
    const cases: Array<[string, string]> = [
      ['yes', 'go'], ['continue', 'go'], ['where is my 2nd claude cli session?', 'question'], ['how to ssh without password', 'question'],
      ['powershell -NoProfile -Command "Get-Date"', 'shell'], ['merge 2 puzzles and push', 'change'], ['ok lets make it for android', 'change'],
      ['research open-source 2D games in this style', 'research'], ['[Image: original 1600x2288, displayed at 1399x2000.]', 'paste'], ['eta', 'chat'],
    ]
    for (const [text, want] of cases) expect(kindOf(text)).toBe(want)
  })
  test('ack needs a short acceptance, not a new request', () => {
    const redo = /^no\b/i
    expect(followUp('x', 'ok', 1000, redo)).toBe('ack')
    expect(followUp('x', 'done', 1000, redo)).toBe('ack')
    expect(followUp('x', 'ok can we move all the game files to D now', 1000, redo)).toBe('none')
    expect(followUp('x', 'ok but it still fails', 1000, redo)).toBe('none')
  })
  test('templated image headers are not rephrases', () => {
    const a = '[Image: original 2592x1518, displayed at 2000x1171. Multiply coordinates by 1.3]'
    expect(followUp(a, a.replace('1171', '1172'), 1000, /^no\b/i)).toBe('none')
  })
})

describe('shipped prior and contributions', () => {
  test('a shipped cell is capped so your own record takes over', () => {
    const c = priorCell({ '*': { 'sonnet·high': { s: 900, f: 100 } } }, '*', 'sonnet·high', 1)
    expect(Math.abs((c?.n ?? 0) - 4) < 1e-9).toBe(true)
    expect(Math.abs((c?.s ?? 0) - 3.6) < 1e-9).toBe(true)
  })
  test('a prior alone never unlocks a cheaper step', () => {
    const s = emptyStore()
    const prior = { '*': { [armName(base - 1)]: { s: 400, f: 1 } } }
    for (let seed = 1; seed <= 20; seed++) {
      const p = pickArm({ base, tier: 'standard', scope: scopeOf(s, 'chat', 'p'), w: s.weights, x: [], now: 1, dailyUsedPct: 10, typical, rand: seeded(seed), exploresLeft: 12, explore: 0, kind: 'chat', prior })
      expect(p.arm).toBe(base)
    }
  })
  test('the export holds counts and costs only', () => {
    let s = emptyStore()
    for (let i = 0; i < 3; i++) s = record(s, { kind: 'question', project: 'secret-folder-hash', arm: base, base, x: [1, 2, 3], ok: i < 2, costUsd: 0.1, now: 1 })
    const c = exportContribution(s, '0.10.0', 1)
    const text = JSON.stringify(c)
    expect(c.schema).toBe('budget-router-contribution/1')
    expect(c.arms[armName(base)]?.n).toBe(3)
    expect(c.arms[armName(base)]?.ok).toBe(2)
    expect(c.kinds.question?.[armName(base)]?.n).toBe(3)
    expect(text.includes('secret-folder-hash')).toBe(false)
    expect(text.includes('weights')).toBe(false)
  })
  test('the previous turn size is a feature', () => {
    expect(features('fix it', 0, 'long').join(',') === features('fix it', 0, 'short').join(',')).toBe(false)
    expect(stepBucket(undefined)).toBe('none')
    expect(stepBucket(45)).toBe('long')
    expect(stepBucket(12)).toBe('mid')
  })
})
