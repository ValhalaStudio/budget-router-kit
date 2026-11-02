// The plugin directory's review, as checks on this plugin's own source and manifest, so a later version
// cannot slip back. Each test names the review note it answers (see review.md); run with: node --test checks/.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'plugins', 'budget-router')
const read = (...p) => readFileSync(join(root, ...p), 'utf8')
const code = ['register.ts', 'policy.ts', 'smart.ts', 'prior.ts'].map(f => ({ f, text: read('hooks', f) }))
// Comments may mention what the plugin avoids; the checks look at code only.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1')

describe('directory review: calls the plugin must not make', () => {
  const banned = [
    ['starts a program (notes 6, 7)', /\$\.process\.|\bprocess\.run\b|child_process|(^|[^.\w])(spawn|exec|execSync|spawnSync)\(/],
    ['makes a request (notes 5, 7)', /\$\.http\.|\bfetch\(|XMLHttpRequest|WebSocket/],
    ['calls a model of its own (notes 5, 9)', /\$\.model\./],
    ['opens or writes a file (notes 8, 9)', /\$\.fs\.|writeFile|appendFile|readFile/],
    ['changes settings, agents or commands (note 8)', /\$\.config\.set|\$\.agent\.(spawn|register)|\$\.command\.(register|run)\b/],
    ['reads an environment variable or credential (note 9)', /\bprocess\.env\b|\bEnv\b\s*[.(]|\$\.env\b|credential|keychain|\.ssh|\.aws|\.npmrc|api[_-]?key\s*[:=]/i],
    ['sets a permission mode or Remote Control (note 8)', /permissionMode|dangerously|bypassPermissions|remoteControl/i],
    ['evaluates code', /\beval\(|new Function\(/],
  ]
  for (const [what, re] of banned) {
    test(`no code ${what}`, () => {
      for (const { f, text } of code) assert.deepEqual([f, re.test(stripComments(text)) ? 'found' : 'clean'], [f, 'clean'])
    })
  }

  test('only the allowed hooks exist, and none of them is command.run or a permission hook (note 8)', () => {
    const used = new Set([...stripComments(code[0].text).matchAll(/\bon\(\s*'([a-z.]+)'/g)].map(m => m[1]))
    const allowed = ['session.start', 'prompt.context', 'session.measure', 'prompt.submit', 'turn.step', 'agent.offer', 'tool.call', 'skill.prompt', 'turn.complete']
    assert.deepEqual([...used].filter(h => !allowed.includes(h)), [])
  })

  test('the hooks that only listen pass the event on with next(e) (note 8)', () => {
    const src = stripComments(code[0].text)
    for (const name of ['agent.offer', 'skill.prompt']) {
      const start = src.indexOf(`on('${name}'`)
      const body = src.slice(start, src.indexOf('\n  })', start))
      assert.ok(body.includes('return next(e)'), name + ' must return next(e)')
    }
  })
})

describe('directory review: manifest and shipped files', () => {
  const manifest = JSON.parse(read('.claude-plugin', 'plugin.json')) 
  test('the manifest has only fields the plugins reference knows (note 10)', () => {
    const known = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'userConfig', 'commands', 'agents', 'hooks', 'mcpServers', 'icon']
    assert.deepEqual(Object.keys(manifest).filter(k => !known.includes(k)), [])
  })
  test('no option can switch on a send (notes 5, 9)', () => {
    assert.deepEqual(Object.keys(manifest.userConfig).filter(k => /classifier|endpoint|webhook|secret|apikey|password|^url|url$|^token$|^key$/i.test(k)), [])
  })
  test('the plugin ships no script to run (note 11)', () => {
    const files = readdirSync(root, { recursive: true }).map(String)
    assert.deepEqual(files.filter(f => /\.(sh|bat|cmd|ps1)$/i.test(f) && !f.includes('node_modules')), [])
  })
  test('every command is a markdown file that allows only its own tool', () => {
    for (const n of ['budget', 'route']) {
      const md = read('commands', `${n}.md`)
      assert.ok(md.includes(`allowed-tools: mcp__budget-router__${n}
`))
      assert.ok(!/^!`|\$\(|```(bash|sh|powershell)/m.test(md))
    }
  })
  test('README and PRIVACY state that nothing is sent and no program runs (notes 2, 3, 5, 6)', () => {
    const text = read('README.md') + read('PRIVACY.md')
    assert.match(text, /Sends: nothing/)
    assert.match(text, /Runs: no programs/)
    assert.doesNotMatch(text, /Runbook memory\.|`\/budget vet/)
    assert.ok(existsSync(join(root, 'LICENSE')))
  })
})
