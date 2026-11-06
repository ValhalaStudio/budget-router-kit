// Budget Router Lite promises to be markdown only. These checks fail if code, hooks, options or tools appear.
// Run with: node --test checks/lite.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'plugins', 'budget-router-lite')
const read = (...p) => readFileSync(join(root, ...p), 'utf8')
const files = readdirSync(root, { recursive: true }).map(String).filter(f => !f.includes('node_modules'))
const front = (text) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''

describe('Budget Router Lite is markdown only', () => {
  const manifest = JSON.parse(read('.claude-plugin', 'plugin.json'))

  test('no code, scripts, hooks, servers or tools', () => {
    assert.deepEqual(files.filter(f => /\.(m?[jt]s|py|sh|ps1|bat|cmd)$/i.test(f)), [])
    for (const gone of ['hooks', 'bin', 'commands', '.mcp.json', 'settings.json', 'package.json']) assert.ok(!existsSync(join(root, gone)), gone)
  })

  test('the manifest has no options, hooks, servers or settings', () => {
    const known = ['name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']
    assert.deepEqual(Object.keys(manifest).filter(k => !known.includes(k)), [])
    assert.ok(!/claude|anthropic|official/i.test(manifest.name + manifest.displayName))
  })

  test('every skill is user-run or explicitly a cheatsheet loader, with a description', () => {
    const skills = readdirSync(join(root, 'skills'))
    assert.deepEqual(skills.sort(), ['deep', 'handoff', 'pace', 'quick', 'tips'])
    for (const s of skills) {
      const fm = front(read('skills', s, 'SKILL.md'))
      assert.match(fm, /^description:\s*\S/m, s)
      if (s !== 'tips') assert.match(fm, /^disable-model-invocation:\s*true/m, `${s} runs only when the person types it`)
      assert.ok(!/allowed-tools|shell:|hooks:/.test(fm), `${s} grants no tools and runs no hooks`)
    }
  })

  test('the tier skills set model and effort, and no skill uses a key outside the allowed list', () => {
    const fm = (s) => front(read('skills', s, 'SKILL.md'))
    assert.match(fm('quick'), /model:\s*haiku[\s\S]*effort:\s*low/)
    assert.match(fm('deep'), /model:\s*opus[\s\S]*effort:\s*xhigh/)
    const allowed = ['name', 'description', 'argument-hint', 'disable-model-invocation', 'model', 'effort']
    for (const s of ['deep', 'handoff', 'pace', 'quick', 'tips']) {
      const keys = [...fm(s).matchAll(/^([a-z-]+):/gm)].map(m => m[1])
      assert.deepEqual(keys.filter(k => !allowed.includes(k)), [], s)
    }
  })

  test('agents tell the truth about their tools', () => {
    for (const a of readdirSync(join(root, 'agents'))) {
      const fm = front(read('agents', a))
      assert.match(fm, /^description:\s*\S/m, a)
      if (/read-only/i.test(fm)) assert.ok(!/tools:.*\b(Bash|PowerShell|Write|Edit)\b/.test(fm), `${a} says read-only but holds a shell or write tool`)
    }
  })

  test('README and PRIVACY say nothing is sent and no program runs, and give three examples', () => {
    const text = read('README.md') + read('PRIVACY.md')
    assert.match(text, /Sends: nothing/)
    assert.match(text, /Runs: no programs/)
    assert.ok(existsSync(join(root, 'LICENSE')))
    const examples = /## Example prompts\n([\s\S]*?)\n## /.exec(read('README.md'))?.[1] ?? ''
    assert.ok((examples.match(/^\d+\.\s/gm) ?? []).length >= 3)
  })
})
