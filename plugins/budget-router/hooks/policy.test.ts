import { describe, expect, mock, test } from 'claude-code/testing'
import { addPace, isUnrealBuildPrompt, projectExhaustion, shouldStick } from './policy'
import { PACER_DEFAULTS, applyEscalation, escalationFor, ladderIndex, pacerStep, paceSteps, shiftLadder, targetPercent } from './policy'
import { LADDER_SIZE, REDO_RE, bucketOf, flipOutcome, idleRebuild, idleText, learnedMove, recordOutcome, sizeBucket, sizeNudgeText, stepReadUsd, wilson } from './policy'
import type { Learned } from './policy'

// --- pure helpers --------------------------------------------------------------------------

describe('unreal build text', () => {
  test('recognises build, link and cook failures, not ordinary talk', async () => {
    for (const t of ['UBT failed with error C2065 in Foo.cpp', 'LNK2019 unresolved external symbol', 'Build.cs is missing a module', 'LogCook: Error: bad asset', 'BUILD FAILED', 'RunUAT stopped']) {
      expect(isUnrealBuildPrompt(t)).toBe(true)
    }
    for (const t of ['hello', 'rename this variable', 'write a README', 'the build looks fine']) expect(isUnrealBuildPrompt(t)).toBe(false)
  })

})

describe('cache-aware switching', () => {
  const base = { ctx: 90_000, stickyContext: 60_000, stepDistance: 1, warmMs: 55 * 60_000 }
  test('sticks only for a one-step change on a long conversation whose cache is still warm', async () => {
    expect(shouldStick({ ...base, sinceLastTurnMs: 5 * 60_000 })).toBe(true)
    expect(shouldStick({ ...base })).toBe(true) // unknown last turn: stay careful
    expect(shouldStick({ ...base, sinceLastTurnMs: 70 * 60_000 })).toBe(false) // cache already cold
    expect(shouldStick({ ...base, ctx: 20_000, sinceLastTurnMs: 1000 })).toBe(false)
    expect(shouldStick({ ...base, stepDistance: 2, sinceLastTurnMs: 1000 })).toBe(false)
  })
})

describe('pace forecast', () => {
  const min = 60_000
  test('keeps the newest samples and projects when the day runs out', async () => {
    let s = addPace([], { t: 0, daily: 10 })
    s = addPace(s, { t: 1 * min, daily: 11 }) // within 3 min: replaces
    expect(s.length).toBe(1)
    s = addPace(s, { t: 30 * min, daily: 20 })
    s = addPace(s, { t: 60 * min, daily: 30 })
    expect(s.length).toBe(3)
    const pr = projectExhaustion(s, 60 * min)
    expect(Math.round(pr?.ratePerHour ?? 0)).toBe(19) // 11 -> 30 over 59 minutes
    expect(pr?.at).toBeGreaterThan(60 * min)
    expect(Math.round(((pr?.at ?? 0) - 60 * min) / min)).toBe(217) // 70 points left at ~19/h
  })

  test('says nothing with too little data and calm usage reports no end time', async () => {
    expect(projectExhaustion([{ t: 0, daily: 5 }], 1000)).toBeUndefined()
    expect(projectExhaustion([{ t: 0, daily: 5 }, { t: 5 * min, daily: 9 }], 5 * min)).toBeUndefined()
    const calm = projectExhaustion([{ t: 0, daily: 5 }, { t: 60 * min, daily: 5.2 }], 60 * min)
    expect(calm?.at).toBeUndefined()
  })
})

describe('pace target and PID pacer', () => {
  test('the even-pace line runs from the start hour to the end hour', async () => {
    expect(targetPercent(8, 8, 24)).toBe(0)
    expect(targetPercent(16, 8, 24)).toBe(50)
    expect(targetPercent(24, 8, 24)).toBe(100)
    expect(targetPercent(3, 8, 24)).toBe(0)
    expect(targetPercent(5, 8, 8)).toBe(100)
  })

  test('on pace or under it, nothing is shed', async () => {
    let s = pacerStep(undefined, 'd1', 0, -10)
    s = pacerStep(s, 'd1', 3_600_000, 0)
    expect(s.u).toBe(0)
    expect(paceSteps(s.u)).toBe(0)
  })

  test('sustained overspending ramps up to two steps, and the integral stops growing there', async () => {
    const h = 3_600_000
    let s = pacerStep(undefined, 'd1', 0, 20) // proportional only: 0.05 * 20 = 1.0
    expect(Math.round(s.u * 1000) / 1000).toBe(1)
    s = pacerStep(s, 'd1', h, 20) // an hour later the integral adds 0.02 * 20
    expect(Math.round(s.u * 1000) / 1000).toBe(1.4)
    s = pacerStep(s, 'd1', 2 * h, 40)
    expect(s.u).toBe(PACER_DEFAULTS.maxSteps)
    const frozen = s.i
    s = pacerStep(s, 'd1', 3 * h, 40) // saturated and still over: no wind-up
    expect(s.i).toBe(frozen)
  })

  test('it relaxes when use falls back under the line, and restarts each day', async () => {
    const h = 3_600_000
    let s = pacerStep(undefined, 'd1', 0, 40)
    s = pacerStep(s, 'd1', h, 40)
    expect(s.u).toBe(2)
    s = pacerStep(s, 'd1', 2 * h, -60)
    expect(s.u).toBe(0)
    const next = pacerStep(s, 'd2', 3 * h, 0)
    expect(next.i).toBe(0)
    expect(next.day).toBe('d2')
  })

  test('rounding to whole steps', async () => {
    expect([0.4, 0.5, 1.4, 1.5, 2].map(paceSteps)).toEqual([0, 1, 1, 2, 2])
  })
})

describe('cost ladder', () => {
  test('moves cheaper and dearer and stays on the ladder', async () => {
    expect(shiftLadder({ family: 'sonnet', effort: 'high' }, 1)).toEqual({ family: 'sonnet', effort: 'low' })
    expect(shiftLadder({ family: 'sonnet', effort: 'high' }, 2)).toEqual({ family: 'haiku', effort: 'medium' })
    expect(shiftLadder({ family: 'opus', effort: 'xhigh' }, 1)).toEqual({ family: 'opus', effort: 'high' })
    expect(shiftLadder({ family: 'haiku', effort: 'low' }, 3)).toEqual({ family: 'haiku', effort: 'low' })
    expect(shiftLadder({ family: 'sonnet', effort: 'low' }, -2)).toEqual({ family: 'opus', effort: 'high' })
    expect(shiftLadder({ family: 'opus', effort: 'xhigh' }, -3)).toEqual({ family: 'opus', effort: 'xhigh' })
  })

  test('off-ladder specs map to the dearest rung that is not dearer', async () => {
    expect(ladderIndex({ family: 'sonnet', effort: 'medium' })).toBe(ladderIndex({ family: 'sonnet', effort: 'low' }))
    expect(shiftLadder({ family: 'sonnet', effort: 'medium' }, 1)).toEqual({ family: 'haiku', effort: 'medium' })
    expect(ladderIndex({ family: 'opus', effort: 'max' })).toBe(ladderIndex({ family: 'opus', effort: 'xhigh' }))
  })
})

describe('escalation when a turn goes badly', () => {
  test('effort rises first, the model only after a longer run, and effort stops at high', async () => {
    expect(escalationFor(2, 3, 6)).toEqual({ effortUp: false, modelUp: false })
    expect(escalationFor(3, 3, 6)).toEqual({ effortUp: true, modelUp: false })
    expect(escalationFor(6, 3, 6)).toEqual({ effortUp: true, modelUp: true })
    expect(applyEscalation({ family: 'sonnet', effort: 'low' }, { effortUp: true, modelUp: false })).toEqual({ family: 'sonnet', effort: 'medium' })
    expect(applyEscalation({ family: 'sonnet', effort: 'high' }, { effortUp: true, modelUp: false })).toEqual({ family: 'sonnet', effort: 'high' })
    expect(applyEscalation({ family: 'haiku', effort: 'low' }, { effortUp: true, modelUp: true })).toEqual({ family: 'sonnet', effort: 'medium' })
    expect(applyEscalation({ family: 'opus', effort: 'high' }, { effortUp: true, modelUp: true })).toEqual({ family: 'opus', effort: 'high' })
  })
})

// Test values that look private are assembled here so no file holds one whole.
const fake = (...parts: string[]) => parts.join('')

describe('ghost-token guard', () => {
  const warm = 55 * 60_000
  test('warns only when the cache has expired and the context is big enough', async () => {
    expect(idleRebuild(300_000, 10 * 60_000, warm, 60_000, 'sonnet')).toBeUndefined()
    expect(idleRebuild(30_000, 90 * 60_000, warm, 60_000, 'sonnet')).toBeUndefined()
    expect(idleRebuild(300_000, undefined, warm, 60_000, 'sonnet')).toBeUndefined()
    const r = idleRebuild(300_000, 90 * 60_000, warm, 60_000, 'sonnet')
    expect(r?.idleMin).toBe(90)
    expect(Math.round((r?.rebuildUsd ?? 0) * 100) / 100).toBe(0.75)
    expect(Math.round((r?.warmUsd ?? 0) * 100) / 100).toBe(0.06)
    expect(idleText(r!)).toContain('300k')
    expect(idleText(r!)).toContain('$0.75')
  })

  test('size notices fire on each multiple of the threshold and say what a step costs', async () => {
    expect([0, 199_999, 200_000, 399_999, 400_000].map(n => sizeBucket(n, 200_000))).toEqual([0, 0, 1, 1, 2])
    expect(sizeBucket(500_000, 0)).toBe(0)
    expect(Math.round(stepReadUsd(1_000_000, 'opus') * 100) / 100).toBe(0.2)
    expect(sizeNudgeText(250_000, 'opus')).toContain('250k')
  })
})

describe('learner', () => {
  test('buckets by tier and topic', async () => {
    expect(bucketOf('deep', 'refactor the module and add a test')).toBe('deep|code')
    expect(bucketOf('light', 'commit and push the branch')).toBe('light|git')
    expect(bucketOf('standard', 'fix the Unreal build error')).toBe('standard|unreal')
    expect(bucketOf('trivial', 'hello')).toBe('trivial|general')
  })

  test('Wilson interval tightens with data', async () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 })
    expect(wilson(9, 10).lo).toBeLessThan(wilson(90, 100).lo)
    expect(wilson(1, 10).hi).toBeLessThan(0.4)
  })

  test('outcomes add up, and a redo flips the last success', async () => {
    let l: Learned = {}
    l = recordOutcome(l, 'b', 3, true)
    l = recordOutcome(l, 'b', 3, false)
    expect(l.b?.['3']).toEqual({ s: 1, f: 1 })
    l = flipOutcome(l, 'b', 3)
    expect(l.b?.['3']).toEqual({ s: 0, f: 2 })
    expect(flipOutcome(l, 'b', 3)).toBe(l)
    expect(REDO_RE.test('no, that is wrong')).toBe(true)
    expect(REDO_RE.test('still failing')).toBe(true)
    expect(REDO_RE.test('now add the readme')).toBe(false)
  })

  const never = { minSamples: 8, target: 0.85, explore: 0.1, rand: () => 0.99 }
  const always = { ...never, rand: () => 0 }

  test('no record, no move', async () => {
    expect(learnedMove({}, 'b', 3, LADDER_SIZE, never)).toBeUndefined()
    expect(learnedMove({ b: { '3': { s: 2, f: 3 } } }, 'b', 3, LADDER_SIZE, never)).toBeUndefined()
  })

  test('a step that keeps failing moves up one', async () => {
    const m = learnedMove({ b: { '3': { s: 2, f: 10 } } }, 'b', 3, LADDER_SIZE, never)
    expect(m?.steps).toBe(-1)
    expect(learnedMove({ b: { '5': { s: 0, f: 20 } } }, 'b', 5, LADDER_SIZE, never)).toBeUndefined() // already the top
  })

  test('a step that nearly always works may try the cheaper one, and keeps it once proven', async () => {
    const strong: Learned = { b: { '3': { s: 20, f: 0 } } }
    expect(learnedMove(strong, 'b', 3, LADDER_SIZE, never)).toBeUndefined()
    expect(learnedMove(strong, 'b', 3, LADDER_SIZE, always)?.steps).toBe(1)
    const proven: Learned = { b: { '3': { s: 20, f: 0 }, '2': { s: 14, f: 0 } } }
    expect(learnedMove(proven, 'b', 3, LADDER_SIZE, never)?.steps).toBe(1)
    const shaky: Learned = { b: { '3': { s: 20, f: 0 }, '2': { s: 5, f: 5 } } }
    expect(learnedMove(shaky, 'b', 3, LADDER_SIZE, always)).toBeUndefined()
    expect(learnedMove({ b: { '0': { s: 30, f: 0 } } }, 'b', 0, LADDER_SIZE, always)).toBeUndefined() // nothing cheaper
  })
})

describe('escalation inside turn.step', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quiet = (on: any) => {
    on('ui.status', async () => ({ value: undefined }) as never)
    on('ui.toast', async () => ({ value: undefined }) as never)
  }
  async function step($: any, on: any, errors: number, index = 3) { // eslint-disable-line @typescript-eslint/no-explicit-any
    on('tool.call', async () => ({ ref: 'r', result: 'boom', text: 'boom', isError: true }) as never)
    const seen: Array<{ model: string; effort: unknown }> = []
    on('turn.step', async function* (_$: unknown, e: { model: string; effort?: unknown; turnId: string; index: number }) {
      seen.push({ model: e.model, effort: e.effort })
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    on('prompt.submit', async (_$: unknown, e: { text: string; context?: unknown }) => ({ text: e.text, context: e.context }) as never)
    await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as never) // trivial: haiku · low
    for (let k = 0; k < errors; k++) await $.tool.call({ tool: 'Bash', command: 'false', tool_use_id: `t${k}` } as never)
    const stream = $.turn.step({ turnId: 'turn-1', index, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 8 } as never)
    for await (const _chunk of stream) { /* drain */ }
    return seen[0]
  }

  test('three failed tool calls raise effort one notch, the model stays', { options: {} }, async ($, on) => {
    mock.store(on)
    quiet(on)
    const seen = await step($, on, 3)
    expect(seen?.effort).toBe('medium')
    expect(String(seen?.model)).toContain('haiku')
  })

  test('six failed tool calls also raise the model one step', { options: {} }, async ($, on) => {
    mock.store(on)
    quiet(on)
    const seen = await step($, on, 6)
    expect(seen?.effort).toBe('medium')
    expect(String(seen?.model)).toContain('sonnet')
  })

  test('two failures change nothing, and escalation can be switched off', { options: {} }, async ($, on) => {
    mock.store(on)
    quiet(on)
    const seen = await step($, on, 2)
    expect(seen?.effort).toBe('low')
  })

  test('off means off', { options: { escalateOnTrouble: false } }, async ($, on) => {
    mock.store(on)
    quiet(on)
    const seen = await step($, on, 9)
    expect(seen?.effort).toBe('low')
    expect(String(seen?.model)).toContain('haiku')
  })
})

// --- the hooks as the engine raises them ---------------------------------------------------
// With no commands, a test reads what the plugin decided where a person sees it (the status
// line and notices) or what it stored.

const core = { plugin: 'engine', tier: 'core' }
const spawn = (subagentType: string, extra: Record<string, unknown> = {}) =>
  ({ tool_use_id: 't1', prompt: 'look around', description: 'look', subagentType, provider: core, parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra }) as never
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const DEEP = 'refactor the architecture of this module'
const done = (extra: Record<string, unknown> = {}) => ({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer', ...extra }) as never

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kit = (on: any, seen: { status?: string[]; toasts?: string[] } = {}) => {
  on('ui.status', async (_$: unknown, e: { text?: string }) => {
    seen.status?.push(e.text ?? '')
    return { value: undefined } as never
  })
  on('ui.toast', async (_$: unknown, e: { text: string }) => {
    seen.toasts?.push(e.text)
    return { value: undefined } as never
  })
  on('session.measure', async () => ({ changed: ['rateLimits'] }) as never)
  on('prompt.submit', async (_$: unknown, e: { text: string; context?: unknown }) => ({ text: e.text, context: e.context }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
}
const last = (rows: readonly string[]) => rows[rows.length - 1] ?? ''
const submit = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never) // eslint-disable-line @typescript-eslint/no-explicit-any

// The test engine has no $.store, so these tests keep the plugin's store in a map they can read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const watched = (on: any, entries: Record<string, unknown> = {}) => {
  const m = new Map<string, unknown>(Object.entries(entries))
  on('store.get', async (_$: unknown, e: { key: string }) => ({ value: m.get(e.key) }) as never)
  on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => {
    m.set(e.key, structuredClone(e.value))
    return { value: undefined } as never
  })
  on('store.delete', async (_$: unknown, e: { key: string }) => {
    m.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...m.keys()] }) as never)
  return { get: async (key: string) => m.get(key) }
}

describe('what the mod leaves alone', () => {
  test('the prompt is passed on exactly as typed, with nothing added', async ($, on) => {
    mock.store(on)
    kit(on)
    const r = await submit($, 'where is the damage calculated? which files use it')
    expect(r.text).toBe('where is the damage calculated? which files use it')
    expect(r.context).toBeUndefined()
  })

  test('data older versions kept is deleted', async ($, on) => {
    const st = watched(on, { decisions: [{ t: 1, k: 'hint', agent: 'scout' }], cmdstats: { k: { n: 5 } }, runbooks: { a: 1 } })
    kit(on)
    await submit($, 'hello')
    expect(await st.get('decisions')).toBeUndefined()
    expect(await st.get('cmdstats')).toBeUndefined()
    expect(await st.get('runbooks')).toBeUndefined()
  })

  test('a spent day does not drop a prompt, and no spawn hook exists', async ($, on) => {
    mock.store(on, { ledger: { day: today(), windowReset: new Date(Date.now() + 3 * 86_400_000).toISOString(), windowStartPct: 10, carry: 0, lastPct: 40, budgetPts: 10, fiveHourPct: 0, alerted: 3, seenAt: Date.now() } })
    kit(on)
    on('agent.spawn', async () => ({ model: 'inherit', agentId: 'a1' }))
    const r = await submit($, 'rename this variable')
    expect((r as { drop?: string }).drop).toBeUndefined()
    const a = await $.agent.spawn(spawn('Explore'))
    expect(a.deny).toBeUndefined()
    expect(a.model).toBe('inherit')
  })
})

describe('the pin option', () => {
  test('a model pin holds whatever the prompt asks', { options: { pin: 'haiku' } }, async ($, on) => {
    const status: string[] = []
    mock.store(on)
    kit(on, { status })
    await submit($, DEEP)
    expect(last(status)).toContain('haiku·high (standard, pinned)')
  })

  test('a tier pin uses that tier', { options: { pin: 'light' } }, async ($, on) => {
    const status: string[] = []
    mock.store(on)
    kit(on, { status })
    await submit($, DEEP)
    expect(last(status)).toContain('sonnet·low (light, pinned)')
  })

  test('model:effort', { options: { pin: 'opus:medium' } }, async ($, on) => {
    const status: string[] = []
    mock.store(on)
    kit(on, { status })
    await submit($, 'hi')
    expect(last(status)).toContain('opus·medium')
  })

  test('blank, auto or nonsense routes automatically', { options: { pin: 'gpt-9' } }, async ($, on) => {
    const status: string[] = []
    mock.store(on)
    kit(on, { status })
    await submit($, DEEP)
    expect(last(status)).toContain('opus·high (deep)')
  })
})

describe('pace control', () => {
  const rateLimits = [
    { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    { kind: 'five_hour', percentUsed: 5, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
  ]

  test('spending ahead of the even-pace line lowers the next route by up to two steps', { options: { paceSlack: -200 } }, async ($, on) => {
    const status: string[] = []
    const st = watched(on)
    kit(on, { status })
    await $.session.measure({ context: { tokens: 1000, window: 200000 }, rateLimits, changed: ['rateLimits'] } as never)
    await submit($, DEEP)
    expect(last(status)).toContain('sonnet·low')
    expect(((await st.get('pacer')) as { u: number }).u).toBe(2)
  })

  test('with pace control off the route is untouched', { options: { paceSlack: -200, paceControl: false } }, async ($, on) => {
    const status: string[] = []
    mock.store(on)
    kit(on, { status })
    await $.session.measure({ context: { tokens: 1000, window: 200000 }, rateLimits, changed: ['rateLimits'] } as never)
    await submit($, DEEP)
    expect(last(status)).toContain('opus·high')
  })
})

describe('notices', () => {
  test('a long pause with a big context gets a notice with the cost', { options: { cacheWarmMinutes: -1, idleMinContext: 1 } }, async ($, on) => {
    const toasts: string[] = []
    mock.store(on)
    kit(on, { toasts })
    on('session.usage', async () => ({ value: { context: { tokens: 300_000, window: 1_000_000 } } }) as never)
    await $.turn.complete(done())
    await submit($, DEEP)
    expect(toasts.some(t => t.includes('re-writes about 300k'))).toBe(true)
  })
})

describe('learning in the engine', () => {
  test('a step with a poor record here is moved up one', { options: { learnMode: 'classic', paceControl: false } }, async ($, on) => {
    const status: string[] = []
    mock.store(on, { bandit: { 'deep|code': { '4': { s: 1, f: 11 } } } })
    kit(on, { status })
    await submit($, DEEP)
    expect(last(status)).toContain('opus·xhigh')
  })

  test('finished turns are recorded, a redo counts against the last one', { options: { learnMode: 'classic', paceControl: false } }, async ($, on) => {
    const st = watched(on)
    kit(on)
    await submit($, DEEP)
    await $.turn.complete(done())
    const cell = async () => ((await st.get('bandit')) as Learned)['deep|code']?.['4']
    expect(await cell()).toEqual({ s: 1, f: 0 })
    await submit($, 'no, that is wrong, try again')
    expect(await cell()).toEqual({ s: 0, f: 1 })
  })

  test('the smart learner records a turn with its cost, and a redo flips it', { options: { paceControl: false } }, async ($, on) => {
    const st = watched(on)
    kit(on)
    await submit($, DEEP)
    await $.turn.complete(done({ usage: { model: 'claude-opus-4-1', input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
    type Store = { seen: number; cells: Record<string, Record<string, { s: number; f: number; c: number }>> }
    let s = (await st.get('smart')) as Store
    expect(s.seen).toBe(1)
    expect(s.cells.g?.['opus·high']?.s).toBeGreaterThan(0.5)
    expect(s.cells.g?.['opus·high']?.c).toBeGreaterThan(0)
    await submit($, 'no, that is wrong, try again')
    s = (await st.get('smart')) as Store
    expect(s.cells.g?.['opus·high']?.f).toBeGreaterThan(0.5)
  })

  test('shadow mode never changes the route', { options: { paceControl: false, learnMode: 'shadow', learnExplore: 1 } }, async ($, on) => {
    const status: string[] = []
    mock.store(on)
    kit(on, { status })
    for (let k = 0; k < 6; k++) {
      await submit($, DEEP)
      await $.turn.complete(done())
    }
    expect(status.some(t => t.includes('opus·medium'))).toBe(false)
    expect(last(status)).toContain('opus·high')
  })

  test('the learner can be switched off', { options: { learn: false } }, async ($, on) => {
    const status: string[] = []
    mock.store(on, { bandit: { 'deep|code': { '4': { s: 1, f: 11 } } } })
    kit(on, { status })
    await submit($, DEEP)
    expect(last(status)).toContain('opus·high')
  })
})

describe('daily budget at the edges of the weekly window', () => {
  const ledger = async (st: { get: (k: string) => Promise<unknown> }) => (await st.get('ledger')) as { budgetPts: number }
  const measure = ($: any, percentUsed: number, resetsInMs: number) => // eslint-disable-line @typescript-eslint/no-explicit-any
    $.session.measure({ context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed, resetsAt: new Date(Date.now() + resetsInMs).toISOString() }], changed: ['rateLimits'] } as never)

  test('on the last day the whole remainder of the week is today\'s budget', async ($, on) => {
    const status: string[] = []
    const st = watched(on)
    kit(on, { status })
    await measure($, 60, 10 * 3_600_000)
    expect((await ledger(st)).budgetPts).toBe(40)
    expect(last(status)).toContain('day 0%')
  })

  test('a weekly reset in the middle of the day keeps what was spent and grants at least an even share', async ($, on) => {
    const status: string[] = []
    const st = watched(on, { ledger: { day: today(), windowReset: new Date(Date.now() - 3_600_000).toISOString(), windowStartPct: 10, carry: 0, lastPct: 50, budgetPts: 10, fiveHourPct: 0, alerted: 0, seenAt: Date.now() - 60_000 } })
    kit(on, { status })
    await measure($, 2, 7 * 86_400_000)
    expect(Math.round((await ledger(st)).budgetPts * 10) / 10).toBe(14.3)
    expect(last(status)).toContain('day 294%')
  })

  test('a new day starts from the first reading, not from yesterday\'s spend', async ($, on) => {
    const status: string[] = []
    const st = watched(on, { ledger: { day: '2000-01-01', windowReset: new Date(Date.now() + 2 * 86_400_000).toISOString(), windowStartPct: 10, carry: 5, lastPct: 50, budgetPts: 10, fiveHourPct: 0, alerted: 3, seenAt: Date.now() - 86_400_000 } })
    kit(on, { status })
    await measure($, 50, 2 * 86_400_000)
    expect((await ledger(st)).budgetPts).toBe(25)
    expect(last(status)).toContain('day 0%')
  })
})

describe('per-model weekly limits', () => {
  test('a nearly spent Opus weekly limit routes a deep prompt to Sonnet', { options: { paceControl: false } }, async ($, on) => {
    const status: string[] = []
    mock.store(on)
    kit(on, { status })
    const reset = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const rateLimits = [
      { kind: 'seven_day', percentUsed: 20, resetsAt: reset },
      { kind: 'seven_day_opus', percentUsed: 95, resetsAt: reset },
    ]
    await $.session.measure({ context: { tokens: 1000, window: 200000 }, rateLimits, changed: ['rateLimits'] } as never)
    await submit($, DEEP)
    expect(last(status)).toContain('sonnet·high')
  })
})

describe('fable is never adopted as the opus id', () => {
  test('a turn on Fable leaves the opus route on Opus', { options: { paceControl: false } }, async ($, on) => {
    mock.store(on)
    on('ui.status', async () => ({ value: undefined }) as never)
    const seen: string[] = []
    on('turn.step', async function* (_$: unknown, e: { model: string; turnId: string; index: number }) {
      seen.push(e.model)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    on('prompt.submit', async (_$: unknown, e: { text: string; context?: unknown }) => ({ text: e.text, context: e.context }) as never)
    await $.prompt.submit({ text: 'refactor the architecture of this module', origin: { kind: 'composer' } } as never)
    for (const model of ['claude-fable-5-1', 'claude-sonnet-5-5']) {
      for await (const _c of $.turn.step({ turnId: 't', index: 0, model, effort: 'high', messageCount: 2 } as never)) { /* drain */ }
    }
    expect(seen.every(m => m.includes('opus'))).toBe(true)
  })
})

describe('wrap-up notice', () => {
  const day = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
  test('one heads-up at 90% of the day, not repeated, not before', async ($, on) => {
    const toasts: string[] = []
    const reset = new Date(Date.now() + 3 * 86_400_000).toISOString()
    mock.store(on, { ledger: { day: day(), windowReset: reset, windowStartPct: 10, carry: 0, lastPct: 10, budgetPts: 10, fiveHourPct: 0, alerted: 0, seenAt: Date.now() } })
    on('ui.status', async () => ({ value: undefined }) as never)
    on('ui.toast', async (_$: unknown, e: { text: string }) => {
      toasts.push(e.text)
      return { value: undefined } as never
    })
    on('session.measure', async () => ({ changed: ['rateLimits'] }) as never)
    const measure = (pct: number) => $.session.measure({ context: { tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: reset }], changed: ['rateLimits'] } as never)
    await measure(15)
    expect(toasts.some(t => t.includes('Good moment to finish'))).toBe(false)
    await measure(19.5)
    expect(toasts.filter(t => t.includes('Good moment to finish')).length).toBe(1)
    await measure(19.8)
    expect(toasts.filter(t => t.includes('Good moment to finish')).length).toBe(1)
  })
})
