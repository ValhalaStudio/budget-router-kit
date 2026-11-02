// What the plugin promises in its README, as checks on its own source and manifest, so a later
// version cannot slip back. Run with: node --test checks/compliance.test.mjs
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'plugins', 'budget-router')
const read = (...p) => readFileSync(join(root, ...p), 'utf8')
const code = ['register.ts', 'policy.ts', 'smart.ts'].map(f => ({ f, text: read('hooks', f) }))
// Comments may mention what the plugin avoids; the checks look at code only.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1')
const register = stripComments(code[0].text)
const hookBody = (name) => {
  const start = register.indexOf(`on('${name}'`)
  assert.ok(start >= 0, `${name} hook exists`)
  return register.slice(start, register.indexOf('\n  })', start))
}

describe('calls the plugin must not make', () => {
  const banned = [
    ['starts a program', /\$\.process\.|\bprocess\.run\b|child_process|(^|[^.\w])(spawn|exec|execSync|spawnSync)\(/],
    ['makes a request', /\$\.http\.|\bfetch\(|XMLHttpRequest|WebSocket/],
    ['calls a model of its own', /\$\.model\./],
    ['opens or writes a file', /\$\.fs\.|writeFile|appendFile|readFile/],
    ['registers or lists tools, commands or agents', /\$\.tool\.|\$\.command\.|\$\.agent\./],
    ['changes settings', /\$\.config\./],
    ['reads an environment variable or credential', /\bprocess\.env\b|\bEnv\b\s*[.(]|\$\.env\b|\$\.session\.(authorize|auth)\b|credential|keychain|\.ssh|\.aws|\.npmrc|api[_-]?key\s*[:=]/i],
    ['sets a permission mode or Remote Control', /permissionMode|dangerously|bypassPermissions|remoteControl/i],
    ['evaluates code', /\beval\(|new Function\(/],
  ]
  for (const [what, re] of banned) {
    test(`no code ${what}`, () => {
      for (const { f, text } of code) assert.deepEqual([f, re.test(stripComments(text)) ? 'found' : 'clean'], [f, 'clean'])
    })
  }

  test('exactly the six hooks the README lists, none of them a policy or permission hook', () => {
    const used = [...register.matchAll(/\bon\(\s*'([a-z.]+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(used, ['prompt.submit', 'session.measure', 'session.start', 'tool.call', 'turn.complete', 'turn.step'])
  })

  test('prompt.submit passes the prompt on exactly as received', () => {
    const body = hookBody('prompt.submit')
    assert.ok(body.includes('return next(e)'))
    assert.equal([...body.matchAll(/next\(/g)].length, 1, 'one call to next, with e unchanged')
  })

  test('tool.call returns what next gives back', () => {
    const body = hookBody('tool.call')
    assert.ok(body.includes('const r = await next(e)') && body.includes('return r'))
    assert.ok(!/return\s*\{/.test(body), 'never answers a call itself')
  })

  test('the other listening hooks pass the event on', () => {
    for (const name of ['session.start', 'session.measure']) assert.ok(hookBody(name).includes('return next(e)'), name)
    assert.ok(hookBody('turn.complete').includes('return r'))
  })
})

describe('manifest and shipped files', () => {
  const manifest = JSON.parse(read('.claude-plugin', 'plugin.json'))
  test('the manifest has only fields the plugins reference knows', () => {
    const known = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'userConfig', 'commands', 'agents', 'hooks', 'mcpServers', 'icon']
    assert.deepEqual(Object.keys(manifest).filter(k => !known.includes(k)), [])
  })
  test('no option holds a secret or switches on a send', () => {
    assert.deepEqual(Object.keys(manifest.userConfig).filter(k => /classifier|endpoint|webhook|secret|apikey|password|token|key$|url/i.test(k)), [])
    assert.deepEqual(Object.values(manifest.userConfig).filter(v => v.sensitive), [])
  })
  test('the plugin ships no script, command, server or study file', () => {
    const files = readdirSync(root, { recursive: true }).map(String).filter(f => !f.includes('node_modules') && !f.startsWith('.claude-plugin'))
    assert.deepEqual(files.filter(f => /\.(sh|bat|cmd|ps1|py|mjs|js)$/i.test(f)), [])
    assert.ok(!existsSync(join(root, 'commands')))
    assert.ok(!existsSync(join(root, '.mcp.json')))
  })
  test('README and PRIVACY state that nothing is sent and no program runs', () => {
    const text = read('README.md') + read('PRIVACY.md')
    assert.match(text, /Sends: nothing/)
    assert.match(text, /Runs: no programs/)
    assert.doesNotMatch(text, /(^|[\s`(])\/(budget|route)\b|decision log of|agentHints|catalogHints|learn export/)
    assert.ok(existsSync(join(root, 'LICENSE')))
  })
})
