import { describe, expect, mock, test } from 'claude-code/testing'
import { isUnrealBuildPrompt, shouldStick } from './policy'
import { PACER_DEFAULTS, applyEscalation, escalationFor, ladderIndex, pacerStep, paceSteps, shiftLadder, targetPercent } from './policy'
import { idleRebuild, idleText, sizeBucket, sizeNudgeText, stepReadUsd } from './policy'
import { REDO_RE } from './smart'

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

describe('redo replies', () => {
  test('a reply that says the last answer missed', async () => {
    expect(REDO_RE.test('no, that is wrong')).toBe(true)
    expect(REDO_RE.test('still failing')).toBe(true)
    expect(REDO_RE.test('now add the readme')).toBe(false)
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

  test('learner weights from version 1 (partly trained on hashed words) are dropped, its counts kept', async ($, on) => {
    const old = { v: 1, weights: { 7: 1.5, 99: -2 }, cells: { g: { 'opus·high': { s: 3, f: 1, c: 0.4, n: 4, t: Date.now() } } }, explore: { day: '', n: 0 }, seen: 4, saved: 0 }
    const st = watched(on, { smart: old })
    kit(on)
    await submit($, DEEP)
    await $.turn.complete(done())
    const s = (await st.get('smart')) as { v: number; weights: Record<string, number>; seen: number }
    expect(s.v).toBe(2)
    expect(s.weights['99']).toBeUndefined()
    expect(s.seen).toBe(5)
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
  const ahead = { pacer: { i: 50, u: 2, day: today() } } // the controller's saved state: two steps to shed today

  test('spending ahead of the even-pace line lowers the next route by up to two steps', async ($, on) => {
    const status: string[] = []
    mock.store(on, ahead)
    kit(on, { status })
    await $.session.start({ cwd: '' } as never).catch(() => undefined)
    await submit($, DEEP)
    expect(last(status)).toContain('sonnet·low')
  })

  test('with pace control off the route is untouched', { options: { paceControl: false } }, async ($, on) => {
    const status: string[] = []
    mock.store(on, ahead)
    kit(on, { status })
    await $.session.start({ cwd: '' } as never).catch(() => undefined)
    await submit($, DEEP)
    expect(last(status)).toContain('opus·high')
  })
})

describe('learning in the engine', () => {
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

  test('shadow mode never changes the route', { options: { paceControl: false, learnMode: 'shadow' } }, async ($, on) => {
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

  for (const options of [{ learnMode: 'off' }, { learn: false }]) {
    test(`the learner can be switched off (${JSON.stringify(options)})`, { options }, async ($, on) => {
      const status: string[] = []
      const st = watched(on)
      kit(on, { status })
      await submit($, DEEP)
      await $.turn.complete(done())
      expect(last(status)).toContain('opus·high')
      expect(await st.get('smart')).toBeUndefined()
    })
  }
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

describe('tips in the engine', () => {
  const longPaste = `${'log line with an error in it\n'.repeat(80)}`
  const appended: unknown[] = []

  test('a long paste shows one tip, a toast only, and nothing is added to the prompt', async ($, on) => {
    const toasts: string[] = []
    mock.store(on)
    kit(on, { toasts })
    on('session.append', async (_$: unknown, e: unknown) => { appended.push(e); return { value: undefined } as never })
    const r = await submit($, longPaste)
    expect(toasts.filter(t => t.includes('long paste'))).toHaveLength(1)
    expect(r.text).toBe(longPaste)
    expect(r.context).toBeUndefined()
    expect(appended).toHaveLength(0)
  })

  test('the same tip is not repeated, and a second tip waits for the cooldown', async ($, on) => {
    const toasts: string[] = []
    mock.store(on)
    kit(on, { toasts })
    await submit($, longPaste)
    await submit($, longPaste)
    await submit($, 'improve the codebase')
    expect(toasts.filter(t => /long paste|broad ask/.test(t))).toHaveLength(1)
  })

  test('the tips option switches them off', { options: { tips: false } }, async ($, on) => {
    const toasts: string[] = []
    mock.store(on)
    kit(on, { toasts })
    await submit($, longPaste)
    expect(toasts.some(t => /long paste/.test(t))).toBe(false)
  })
})
