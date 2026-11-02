import { describe, expect, test } from 'claude-code/testing'
import { pickTip } from './tips'
import type { TipSignals } from './tips'

const calm: TipSignals = { text: 'rename this variable', kind: 'change', failedLast: 0, level: 0 }
const id = (s: Partial<TipSignals>, shown: string[] = []) => pickTip({ ...calm, ...s }, new Set(shown))?.id

describe('tips', () => {
  test('an ordinary prompt gets no tip', () => {
    expect(id({})).toBeUndefined()
  })

  test('each situation names its own habit', () => {
    expect(id({ failedLast: 3 })).toBe('failures')
    expect(id({ lastSteps: 31 })).toBe('long-turn')
    expect(id({ kind: 'paste', text: 'x'.repeat(2000) })).toBe('paste')
    expect(id({ text: 'improve the codebase' })).toBe('vague')
    expect(id({ level: 1 })).toBe('capped')
    expect(id({ kind: 'shell', text: 'git status' })).toBe('shell')
    expect(id({ kind: 'paste', text: `LNK2019 unresolved external symbol\n${'x'.repeat(900)}` })).toBe('build-log')
  })

  test('below the thresholds nothing fires', () => {
    expect(id({ failedLast: 2 })).toBeUndefined()
    expect(id({ lastSteps: 29 })).toBeUndefined()
    expect(id({ kind: 'paste', text: 'x'.repeat(1000) })).toBeUndefined()
    expect(id({ text: 'improve the parser in @src/parse.ts' })).toBeUndefined()
    expect(id({ text: 'LNK2019 in Foo.cpp' })).toBeUndefined() // short: no build-log tip
  })

  test('a tip already shown is skipped, and the next applicable one is offered', () => {
    expect(id({ failedLast: 5, level: 2 }, ['failures'])).toBe('capped')
    expect(id({ failedLast: 5 }, ['failures'])).toBeUndefined()
  })

  test('the text names real commands and never the prompt', () => {
    const t = pickTip({ ...calm, text: 'secret plan for acme', failedLast: 4 }, new Set())?.text ?? ''
    expect(t).toContain('/rewind')
    expect(t.includes('acme')).toBe(false)
  })
})
