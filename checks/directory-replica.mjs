// A local stand-in for the plugin directory's pipeline (validation, directory policy, security scan) plus a
// static pass over the Software Directory Policy and Terms. The real pipeline runs only on submission and its
// rules are not public: this replica encodes (a) the published pre-submission checklist
// (claude.com/docs/plugins/pre-submission-checklist), (b) every finding code the portal showed this plugin
// in rounds 0.4.9-0.10.8, with the trigger each one named, and (c) policy items that can be checked from files.
// It cannot prove acceptance. Usage: node checks/directory-replica.mjs [plugin dir]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const repo = join(import.meta.dirname, '..')
const root = process.argv[2] ?? join(repo, 'plugins', 'budget-router')
const rows = []
const add = (stage, level, code, where, text) => rows.push({ stage, level, code, where, text })

// ---- Fetch ------------------------------------------------------------------------------------
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = join(d, e.name)
  if (e.name === 'node_modules' || e.name === '.git' || (e.isDirectory() && e.name === 'types')) return []
  return e.isDirectory() ? walk(p) : [p]
})
const files = walk(root).map(p => ({ p, rel: relative(root, p).replaceAll('\\', '/'), size: statSync(p).size }))
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf'])
const text = files.filter(f => !BINARY.has(extname(f.rel).toLowerCase())).map(f => ({ ...f, src: readFileSync(f.p, 'utf8') }))
const total = files.reduce((a, f) => a + f.size, 0)
add('Fetch', 'info', 'FETCHED', '', `${files.length} files, ${(total / 1024).toFixed(1)} kB`)
if (files.length > 512) add('Fetch', 'hold', 'TOO_MANY_FILES', '', 'more than 512 files')
for (const f of files) if (f.size > 256 * 1024) add('Fetch', 'hold', 'FILE_TOO_LARGE', f.rel, `${(f.size / 1024).toFixed(0)} KiB > 256 KiB`)

// ---- Validation (pre-submission checklist) -----------------------------------------------------
const manifestPath = join(root, '.claude-plugin', 'plugin.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const readme = existsSync(join(root, 'README.md')) ? readFileSync(join(root, 'README.md'), 'utf8') : ''
if (readme.split(/\s+/).filter(Boolean).length < 40) add('Validation', 'block', 'README_SHORT', 'README.md', 'README missing or under 40 words')
if (!existsSync(join(root, 'LICENSE')) && !manifest.license) add('Validation', 'block', 'NO_LICENSE', '', 'no LICENSE file or license field')
if (!/^[a-z0-9-]+$/.test(manifest.name ?? '')) add('Validation', 'block', 'BAD_NAME', 'plugin.json', 'name must be lowercase letters, digits, hyphens')
for (const k of ['description', 'author', 'version']) if (!manifest[k]) add('Validation', 'warn', 'MISSING_' + k.toUpperCase(), 'plugin.json', `${k} missing`)
if (manifest.hooks) add('Validation', 'warn', 'HOOKS_IN_MANIFEST', 'plugin.json', 'hooks listed in plugin.json')
try { new URL(manifest.homepage) } catch { add('Validation', 'warn', 'BAD_HOMEPAGE', 'plugin.json', 'homepage does not parse as a URL') }
const brand = /claude|anthropic/i
if (brand.test(manifest.name ?? '') || brand.test(manifest.displayName ?? '') || brand.test(manifest.author?.name ?? '')) add('Validation', 'hold', 'BRAND_LIKE_NAME', 'plugin.json', 'name, displayName or author looks like a known brand')
const hooksJson = existsSync(join(root, 'hooks', 'hooks.json')) ? JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')) : undefined
const modules = hooksJson?.modules ?? []
if (hooksJson && !hooksJson.hooks && !Array.isArray(hooksJson.modules)) add('Validation', 'block', 'BAD_HOOKS_JSON', 'hooks/hooks.json', 'needs a hooks object or a modules array')
for (const f of text.filter(f => /^agents\/.+\.md$/.test(f.rel))) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(f.src.replaceAll('\r', ''))
  if (!fm || !/^description:\s*\S/m.test(fm[1])) add('Validation', 'block', 'AGENT_FRONT_MATTER', f.rel, 'front matter missing or without a description')
}
for (const f of files) if (BINARY.has(extname(f.rel).toLowerCase())) add('Validation', 'note', 'ASSETS_PASSED_UNREAD', f.rel, 'image or font let through without being read as code')
for (const f of text.filter(f => /\.(m?[jt]s)$/.test(f.rel) && !/\.test\./.test(f.rel))) {
  const longest = Math.max(...f.src.split('\n').map(l => l.length))
  if (longest > 1000) add('Validation', 'hold', 'UNREADABLE_SOURCE', f.rel, `a line of ${longest} characters looks minified or packed`)
}

// ---- Directory policy: the mod findings this plugin has been shown ------------------------------
const modSrc = modules.map(m => ({ rel: join('hooks', m).replaceAll('\\', '/').replace('/./', '/'), src: readFileSync(join(root, 'hooks', m), 'utf8') }))
// Only comments that start a line, or ` // ` after code, so a regex literal holding `/*` or `//` is left alone;
// line breaks are kept so line numbers still match the file.
const keepLines = (m) => m.replace(/[^\n]/g, '')
const stripComments = (s) => s.replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, keepLines).replace(/^[ \t]*\/\/.*$/gm, '').replace(/[ \t]+\/\/ .*$/gm, '')
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length
if (modules.length > 0) {
  add('Directory policy', 'hold', 'MOD_PRESENT', modSrc[0]?.rel ?? '', 'plugin has a mod: an Anthropic reviewer must clear it (cannot be removed while the plugin is a mod)')
  add('Directory policy', 'info', 'USES_HOOKS', '', 'plugin ships hooks')
}
// Events whose payload carries settings, instructions, hook lists or tool/agent/skill descriptions (round 0.10.6 counted 3: prompt.context, agent.offer, skill.prompt).
const POLICY_EVENTS = ['prompt.context', 'agent.offer', 'skill.prompt', 'config.get', 'config.set', 'tool.describe', 'tool.list', 'command.list']
// Events that share a name with a call (round 0.10.6 counted 1: prompt.submit).
const OPERATION_EVENTS = ['prompt.submit', 'session.append', 'session.send', 'tool.register', 'command.run', 'agent.spawn', 'fs.write', 'config.set']
const ALL_EVENTS = [...new Set([...POLICY_EVENTS, ...OPERATION_EVENTS, 'agent.register', 'fs.read', 'process.run', 'http.fetch', 'model.complete'])]
for (const { rel, src } of modSrc) {
  const code = stripComments(src)
  const hooks = [...code.matchAll(/\bon\(\s*'([a-z.]+)'/g)].map(m => ({ name: m[1], line: lineOf(code, m.index) }))
  const pol = hooks.filter(h => POLICY_EVENTS.includes(h.name))
  if (pol.length) add('Directory policy', 'note', 'MOD_HOOKS_POLICY_EVENT', `${rel}:${pol[0].line}`, `hooks ${pol.map(h => h.name).join(', ')}: README must say what the hook changes`)
  const ops = hooks.filter(h => OPERATION_EVENTS.includes(h.name))
  if (ops.length) add('Directory policy', 'note', 'MOD_HOOKS_OPERATION', `${rel}:${ops[0].line}`, `hooks ${ops.map(h => h.name).join(', ')}: README must say what the hook does`)
  const reg = /\$\.(tool|command|agent)\.register\(/.exec(code)
  if (reg) add('Directory policy', 'note', 'MOD_REGISTERS_SURFACES', `${rel}:${lineOf(code, reg.index)}`, 'mod registers tools, commands or agents')
  for (const h of hooks.filter(h => h.name === 'tool.call')) {
    const start = code.split('\n').slice(h.line - 1).join('\n')
    const body = start.slice(0, start.indexOf('\n  })') + 5)
    const tail = start.slice(body.length, body.length + 200)
    if (/return\s*\{/.test(body) || /\.catch\([^)]*\)\s*=>\s*\(\{/.test(tail)) add('Directory policy', 'warn', 'MOD_ANSWERS_FOR_TOOL', `${rel}:${h.line}`, 'a tool.call hook returns a result of its own')
  }
  const used = new Set(hooks.map(h => h.name))
  const named = ALL_EVENTS.filter(n => !used.has(n) && new RegExp(`\\b${n.replace('.', '\\.')}\\b`).test(src) && !new RegExp(`\\$\\.${n.replace('.', '\\.')}\\(`).test(code))
  if (named.length) add('Directory policy', 'note', 'MOD_CALL_NAMED_IN_TEXT', rel, `source spells ${named.join(', ')} but neither hooks nor calls it`)
}
// Download-and-run text anywhere in the shipped files (round 0.10.6 flagged a regex with "|bash" next to "curl").
const FETCH_EXEC = [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]{0,200}\|\s*(ba|z)?sh\b/i, /\|\s*(bash|sh|pwsh|powershell)\b/i, /\biex\b|\bInvoke-Expression\b|\birm\b[^\n]*\|/i, /\bnpx\s+-y\b|\bbunx\b|\buvx\b|\bpip install\b/i]
for (const f of text) {
  const re = FETCH_EXEC.find(r => r.test(f.src))
  if (re) {
    const m = re.exec(f.src)
    add('Directory policy', 'warn', 'RUNTIME_FETCH_EXEC', `${f.rel}:${lineOf(f.src, m.index)}`, `text that reads as download-and-run: "${m[0].slice(0, 60)}"`)
  }
}
// Credential reads (the portal's MCP_FORWARDS_CREDENTIAL_ENV fired on plugin.json in every round; its real trigger is unknown).
const CRED = [/\bprocess\.env\b|\$\.env\b|\$\.session\.authorize\b/, /\.credentials(\.json)?|keychain|wincred|\.netrc|\.npmrc|\.ssh\/|\.aws\//i, /~\/\.claude\b|os\.path\.expanduser\(['"]~\/\.claude/]
for (const f of text.filter(f => !/\.md$/.test(f.rel))) {
  const re = CRED.find(r => r.test(stripComments(f.src)))
  if (re) add('Directory policy', 'warn', 'READS_CREDENTIAL_LIKE', f.rel, `credential-like read: ${re.exec(f.src)[0]}`)
}
const credKeys = Object.entries(manifest.userConfig ?? {}).filter(([k, v]) => v.sensitive || /token|secret|key$|apikey|password/i.test(k)).map(([k]) => k)
if (credKeys.length) add('Directory policy', 'warn', 'CREDENTIAL_OPTION', 'plugin.json', `options that look like secrets: ${credKeys.join(', ')}`)
if (manifest.mcpServers || existsSync(join(root, '.mcp.json'))) add('Directory policy', 'warn', 'MCP_SERVER', 'plugin.json', 'ships an MCP server: check env forwarding and remote endpoints')

// ---- Security scan ----------------------------------------------------------------------------
const SECRETS = [/sk-ant-[a-z0-9_-]{10,}/i, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAIza[0-9A-Za-z_-]{35}\b/]
for (const f of text) for (const re of SECRETS) { const m = re.exec(f.src); if (m) add('Security scan', 'block', 'SECRET', `${f.rel}:${lineOf(f.src, m.index)}`, 'looks like a live credential') }
for (const f of text.filter(f => /\.(m?[jt]s|py|sh|ps1)$/.test(f.rel))) {
  const code = stripComments(f.src)
  if (/\beval\(|new Function\(/.test(code)) add('Security scan', 'block', 'DYNAMIC_CODE', f.rel, 'eval or new Function')
  if (/[A-Za-z0-9+/]{200,}={0,2}/.test(code)) add('Security scan', 'hold', 'ENCODED_BLOB', f.rel, 'long base64-like string')
  if ((code.match(/\\x[0-9a-f]{2}/gi) ?? []).length > 20) add('Security scan', 'hold', 'OBFUSCATED', f.rel, 'many \\x escapes')
  if (/\$\.http\.|\bfetch\(|XMLHttpRequest|WebSocket|\$\.process\.|child_process/.test(code)) add('Security scan', 'warn', 'NETWORK_OR_PROCESS', f.rel, 'network request or program start: must be disclosed in the README')
  if (/permissionMode|bypassPermissions|dangerously/i.test(code)) add('Security scan', 'block', 'PERMISSION_CHANGE', f.rel, 'changes permission settings')
  const urls = [...code.matchAll(/https?:\/\/[^\s'"`)]+/g)].map(m => m[0])
  if (urls.length) add('Security scan', 'warn', 'URL_IN_CODE', f.rel, urls.slice(0, 3).join(' '))
}

// ---- Software Directory Policy and Terms (what files can show) ----------------------------------
const pol = (level, code, text) => add('Policy & Terms', level, code, '', text)
const privacy = existsSync(join(root, 'PRIVACY.md'))
pol(privacy ? 'pass' : 'block', '3A_PRIVACY_POLICY', privacy ? 'PRIVACY.md present; link it as the listing privacy policy' : 'no privacy policy')
pol(/github\.com\/[^\s)]+\/issues/.test(readme) ? 'pass' : 'warn', '3B_SUPPORT', 'support channel (issues URL) in README')
pol(/##\s*Troubleshooting/i.test(readme) ? 'pass' : 'warn', '3C_DOCS', 'purpose, how it works and troubleshooting documented')
pol(/no account|No account/i.test(readme) ? 'pass' : 'warn', '3D_TEST_ACCOUNT', 'README says no account or test data is needed')
const examples = (/##\s*Example[\s\S]*?(?=\n## )/.exec(readme)?.[0].match(/^\d+\.\s/gm) ?? []).length
pol(examples >= 3 ? 'pass' : 'block', '3E_EXAMPLES', `${examples} working examples (3 required)`)
pol(existsSync(join(repo, 'SECURITY.md')) ? 'pass' : 'warn', 'TERMS_SECURITY_REPORTS', 'a way to receive vulnerability reports (SECURITY.md)')
const allCode = modSrc.map(m => stripComments(m.src)).join('\n')
if (/\$\.session\.append\(/.test(allCode)) pol('note', '1C_2G_APPENDS_MESSAGE', 'mod appends a message to the conversation: must be documented, readable and not an instruction')
if (/\$\.store\.set\(/.test(allCode)) pol('note', '1G_CROSS_SESSION_STATE', 'mod keeps state across sessions: must not be conversation content or a user profile')
const smartSrc = stripComments(text.find(f => f.rel === 'hooks/smart.ts')?.src ?? '')
if (/hash\(`w:\$\{/.test(smartSrc) || /\.match\(\/\[a-z_\]/.test(smartSrc)) pol('warn', '1G_PROMPT_DERIVED_STORE', 'learner stores weights trained on hashed words of prompts across sessions: arguably "use conversation content to build user profiles"')
for (const f of text.filter(f => /^agents\/.+\.md$/.test(f.rel))) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(f.src.replaceAll('\r', ''))?.[1] ?? ''
  if (/read-only/i.test(fm) && /tools:.*\b(Bash|PowerShell|Write|Edit)\b/.test(fm)) pol('warn', '2B_DESCRIPTION_MATCH', `${f.rel}: says read-only but holds ${/tools:(.*)/.exec(fm)[1].trim()}`)
}
if (readme.split('\n').some(l => /\b(advertis|sponsored|affiliate)/i.test(l) && !/\b(not|no|never)\b/i.test(l))) pol('warn', '4_ADS', 'advertising mentioned')
if (/\$\.(pay|wallet|purchase)\b|stripe|paypal|checkout\(/i.test(allCode)) pol('warn', '4_FINANCIAL', 'financial actions in code')

// ---- Report -----------------------------------------------------------------------------------
const order = ['block', 'hold', 'warn', 'note', 'info', 'pass']
const stages = ['Fetch', 'Validation', 'Directory policy', 'Security scan', 'Policy & Terms']
for (const s of stages) {
  const r = rows.filter(x => x.stage === s).sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level))
  const worst = r.find(x => x.level !== 'info' && x.level !== 'pass')?.level
  console.log(`\n${s}: ${worst === 'block' ? 'DOES NOT PASS' : worst === 'hold' ? 'HELD' : worst === 'warn' ? 'passed with warnings' : worst === 'note' ? 'passed with notes' : 'passed'}`)
  for (const x of r) console.log(`  [${x.level.toUpperCase().padEnd(5)}] ${x.code.padEnd(24)} ${x.where ? x.where + ' - ' : ''}${x.text}`)
}
const blocks = rows.filter(x => x.level === 'block').length
const holds = rows.filter(x => x.level === 'hold').map(x => x.code)
console.log(`\nOutcome: ${blocks ? 'Doesn\'t pass' : holds.length ? `Held for a reviewer (${holds.join(', ')})` : 'Passes every check'}`)
process.exitCode = blocks ? 1 : 0
