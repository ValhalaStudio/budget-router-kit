// Pure helpers for budget-router: no engine calls, so tests can run them directly.

export type Family = 'haiku' | 'sonnet' | 'opus'
export const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus']

// Subagent types that only read and summarise run on Haiku unless the call names a model.
export const DEFAULT_SUBAGENT_MODELS = '{"Explore":"haiku","claude-code-guide":"haiku","statusline-setup":"haiku"}'

function toMap(raw: string): Record<string, Family> | undefined {
  try {
    const obj: unknown = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
    const out: Record<string, Family> = {}
    for (const [k, v] of Object.entries(obj)) {
      const f = String(v).toLowerCase()
      if ((FAMILIES as readonly string[]).includes(f)) out[k] = f as Family
    }
    return out
  } catch {
    return undefined
  }
}

/** `{"Explore":"haiku"}` -> map. An empty string or bad JSON gives the default; `{}` switches the rules off. */
export function parseSubagentModels(raw: unknown): Record<string, Family> {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return (text !== '' ? toMap(text) : undefined) ?? toMap(DEFAULT_SUBAGENT_MODELS) ?? {}
}

export function parseList(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export type SpawnFacts = {
  subagentType: string
  model?: string
  fork?: boolean
  isTeammate?: boolean
  resume?: unknown
  workflow?: unknown
}
export type SpawnPlan = { model?: Family; note: string }

/** Which model a new subagent should get. Only plain subagents with no model named by the call are touched. */
export function planSpawn(e: SpawnFacts, map: Record<string, Family>): SpawnPlan {
  if (e.fork) return { note: 'fork: inherits the parent' }
  if (e.resume !== undefined) return { note: 'resume: left alone' }
  if (e.isTeammate) return { note: 'teammate: left alone' }
  if (e.workflow !== undefined) return { note: 'workflow agent: left alone' }
  if (e.model !== undefined && e.model !== '') return { note: `call chose ${e.model}` }
  const key = Object.keys(map).find(k => k.toLowerCase() === e.subagentType.toLowerCase())
  return key ? { model: map[key], note: `${e.subagentType} -> ${map[key]}` } : { note: 'unchanged' }
}

/** Agent types the model should not be offered once the budget is tight (level 2 = past the second cap). */
export function isOffered(agent: string, level: number, hidden: readonly string[]): boolean {
  return !(level >= 2 && hidden.some(h => h.toLowerCase() === agent.toLowerCase()))
}

export type LogEntry =
  | { t: number; k: 'prompt'; tier: string; why: string; model: string; effort: string; level: number; ctx: number }
  | { t: number; k: 'spawn'; type: string; note: string; level: number }
  | { t: number; k: 'hint'; agent: string }
  | { t: number; k: 'turn'; sub: boolean; model: string; inp: number; out: number; cr: number; cc: number; ms: number }

export const MAX_LOG = 200

export function pushLog(log: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...log, entry]
  return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** The text behind `/route why`: recent decisions, spawn rules and today's token use. */
export function summarize(log: readonly LogEntry[], since: number, hhmm: (ms: number) => string): string {
  const lines: string[] = ['Budget router: recent decisions']
  const prompts = log.filter((x): x is Extract<LogEntry, { k: 'prompt' }> => x.k === 'prompt')
  if (prompts.length === 0) lines.push('  no routed prompts yet')
  for (const p of prompts.slice(-8)) {
    const caps = p.level > 0 ? ` [level ${p.level}]` : ''
    lines.push(`  ${hhmm(p.t)} ${p.tier.padEnd(8)} -> ${p.model}·${p.effort}${caps}  (${p.why}; context ${k(p.ctx)})`)
  }
  const spawns = log.filter((x): x is Extract<LogEntry, { k: 'spawn' }> => x.k === 'spawn')
  if (spawns.length > 0) {
    lines.push('  subagents:')
    for (const s of spawns.slice(-5)) lines.push(`    ${hhmm(s.t)} ${s.type}: ${s.note}`)
  }
  const hints = log.filter((x): x is Extract<LogEntry, { k: 'hint' }> => x.k === 'hint')
  if (hints.length > 0) {
    const per = new Map<string, { issued: number; followed: number }>()
    for (const h of hints) {
      const row = per.get(h.agent) ?? { issued: 0, followed: 0 }
      row.issued++
      if (spawns.some(sp => sp.t >= h.t && sp.t <= h.t + 15 * 60_000 && sp.type.toLowerCase().endsWith(h.agent.toLowerCase()))) row.followed++
      per.set(h.agent, row)
    }
    lines.push('  agent hints (followed = that agent started within 15 min):')
    for (const [agent, r] of per) lines.push(`    ${agent}: ${r.issued} given, ${r.followed} followed`)
  }
  const today = log.filter((x): x is Extract<LogEntry, { k: 'turn' }> => x.k === 'turn' && x.t >= since)
  if (today.length > 0) {
    const sum = (rows: typeof today) =>
      rows.reduce(
        (a, r) => ({ inp: a.inp + r.inp, out: a.out + r.out, cr: a.cr + r.cr, cc: a.cc + r.cc, n: a.n + 1 }),
        { inp: 0, out: 0, cr: 0, cc: 0, n: 0 },
      )
    const row = (name: string, s: ReturnType<typeof sum>) => {
      const hit = s.inp + s.cr + s.cc > 0 ? Math.round((100 * s.cr) / (s.inp + s.cr + s.cc)) : 0
      return `    ${name}: ${s.n} turns, in ${k(s.inp)}, out ${k(s.out)}, cache read ${k(s.cr)} / written ${k(s.cc)} (${hit}% of input from cache)`
    }
    lines.push('  tokens today (counted by this plugin):')
    lines.push(row('main     ', sum(today.filter(r => !r.sub))))
    const sub = today.filter(r => r.sub)
    if (sub.length > 0) lines.push(row('subagents', sum(sub)))
    const byModel = new Map<string, number>()
    for (const r of today) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.inp + r.cr + r.cc + r.out)
    lines.push(`    by model: ${[...byModel].map(([m, n]) => `${m.replace('claude-', '')} ${k(n)}`).join(', ')}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------
// v0.4: Unreal build rules, agent hints, cache-aware switching, skill audit and vetting.

/** Text that looks like an Unreal / C++ build, cook or packaging failure. */
export const UE_BUILD_RE =
  /\b(UnrealBuildTool|UBT|UHT|RunUAT|LNK\d{3,4}|error C\d{4}|unresolved external|Build\.cs|LogCook|BUILD FAILED|cook(ing)? (failed|error)|packag(e|ing) (failed|error)|compile (failed|error))\b/i

export const isUnrealBuildPrompt = (text: string) => UE_BUILD_RE.test(text)

/** MCP tools that run arbitrary scripts inside the Unreal editor. */
export const isUnrealScriptTool = (tool: string) => /execute_tool_script|ProgrammaticToolset/i.test(tool)

export type Hint = { agent: string; text: string }

const HINT_RULES: ReadonlyArray<{ agent: string; test: (t: string) => boolean; text: string }> = [
  {
    agent: 'log-triage',
    test: t => UE_BUILD_RE.test(t) || /\.log\b/i.test(t),
    text: 'This looks like a build, cook or packaging failure. If a long log is involved, let budget-router:log-triage (Haiku, read-only) cut it down to its errors first, then fix the first error.',
  },
  {
    agent: 'disk-auditor',
    test: t => /\b(disk|storage|free space|drive (is )?full|largest (files?|folders?)|what('s| is) (using|taking|eating)( up)? (the )?(space|disk)|how (big|much space))\b/i.test(t),
    text: 'For size surveys, let budget-router:disk-auditor (Haiku, read-only) do the measuring, then plan any deletions yourself.',
  },
  {
    agent: 'repo-check',
    test: t => /\b(unpushed|uncommitted|safe to (delete|remove|move)|before (deleting|removing|moving)|worktrees?|git status|local[- ]only)\b/i.test(t),
    text: 'Before deleting or moving a repo, have budget-router:repo-check (Haiku, read-only) report what exists only locally.',
  },
  {
    agent: 'reviewer',
    test: t => /\b(code review|review (this|my|the) (diff|changes|branch|pr|pull request|code|commit)|check (my|this|the) (diff|changes|branch))\b/i.test(t),
    text: 'For a diff or branch review, budget-router:reviewer (Sonnet, read-only) can do the first pass.',
  },
  {
    agent: 'scout',
    test: t => /\b(where is|where are|which files?|find all|find every|who (calls|uses)|usages? of|search (the )?(whole )?(codebase|repo|project|folder))\b/i.test(t),
    text: 'For a broad search across many files, delegate it to budget-router:scout (Haiku) and ask for file:line references.',
  },
]

/** At most one helper-agent suggestion for a prompt; deterministic, costs no tokens to decide. */
export function helperHint(text: string): Hint | undefined {
  const rule = HINT_RULES.find(r => r.test(text))
  return rule ? { agent: rule.agent, text: `[budget-router hint] ${rule.text}` } : undefined
}

/**
 * Whether a one-step model change should be skipped because it would re-cache a long
 * conversation. When the last main turn ended longer ago than the cache lives, the cache
 * is already cold and switching is free.
 */
export function shouldStick(a: { ctx: number; stickyContext: number; stepDistance: number; sinceLastTurnMs?: number; warmMs: number }): boolean {
  if (a.stepDistance !== 1 || a.ctx < a.stickyContext) return false
  return !(a.sinceLastTurnMs !== undefined && a.sinceLastTurnMs > a.warmMs)
}

export type PaceSample = { t: number; daily: number }

/** Keeps at most 60 samples; a sample within 3 minutes of the last one replaces it. */
export function addPace(samples: readonly PaceSample[], s: PaceSample): PaceSample[] {
  const last = samples[samples.length - 1]
  const base = last !== undefined && s.t - last.t < 180_000 ? samples.slice(0, -1) : samples
  const next = [...base, s]
  return next.length > 60 ? next.slice(next.length - 60) : next
}

/** Burn rate in percent of today's budget per hour over the recent window, and when 100% is reached at that pace. */
export function projectExhaustion(samples: readonly PaceSample[], now: number, windowMs = 90 * 60_000): { ratePerHour: number; at?: number } | undefined {
  const recent = samples.filter(x => x.t >= now - windowMs)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || last.t - first.t < 10 * 60_000) return undefined
  const rate = (last.daily - first.daily) / ((last.t - first.t) / 3_600_000)
  if (rate < 0.5) return { ratePerHour: Math.max(0, rate) }
  return { ratePerHour: rate, at: Math.max(now, last.t + ((100 - last.daily) / rate) * 3_600_000) }
}

export const estimateTokens = (chars: number) => Math.ceil(chars / 4)

export type CmdRow = { name: string; description: string; source: string; plugin?: string }

/** What the slash-command / skill list costs: descriptions are text the model reads in every session. */
export function auditCommands(rows: readonly CmdRow[]): string {
  const own = rows.filter(r => r.source !== 'builtin')
  const total = own.reduce((n, r) => n + r.description.length + r.name.length + 4, 0)
  const lines = [
    'Budget router: command and skill list',
    `  ${own.length} entries from plugins, your files and MCP servers; about ${estimateTokens(total)} tokens of names and descriptions (estimate, chars/4).`,
    '  Skills and plugin commands share this list; the model reads these lines every session.',
  ]
  const by = new Map<string, { n: number; chars: number }>()
  for (const r of own) {
    const key = r.plugin ?? r.source
    const row = by.get(key) ?? { n: 0, chars: 0 }
    row.n++
    row.chars += r.description.length + r.name.length + 4
    by.set(key, row)
  }
  lines.push('  by source:')
  for (const [key, v] of [...by].sort((a, b) => b[1].chars - a[1].chars).slice(0, 8)) lines.push(`    ${key}: ${v.n} entries, ~${estimateTokens(v.chars)} tokens`)
  lines.push('  longest descriptions:')
  for (const r of [...own].sort((a, b) => b.description.length - a.description.length).slice(0, 8)) {
    lines.push(`    ${r.name} (${r.plugin ?? r.source}): ${r.description.length} chars, ~${estimateTokens(r.description.length)} tokens`)
  }
  lines.push('  To trim: plugin skills and commands are switched off in /plugin (a whole plugin at once); your own skills can be set to name-only or off in /skills (skillOverrides does not apply to plugin skills).')
  return lines.join('\n')
}

export type Finding = { sev: 'high' | 'medium' | 'low'; what: string }

/** Static red flags in a skill, agent, command or hook file. Advisory only: it cannot prove a file is safe. */
export function vetText(text: string): Finding[] {
  const out: Finding[] = []
  const add = (sev: Finding['sev'], what: string, re: RegExp) => {
    if (re.test(text)) out.push({ sev, what })
  }
  add('high', 'tells the model to keep something from you', /do not (tell|mention|inform|reveal)[^.\n]{0,50}(user|human|person)|without (telling|informing) the user|hide this from/i)
  add('high', 'downloads and runs code', /(curl|wget|Invoke-WebRequest|iwr)[^\n|]{0,200}\|\s*(sh|bash|iex|powershell|pwsh)\b|Invoke-Expression|\biex\b/i)
  add('high', 'loads instructions from a URL (they can change after review)', /(fetch|download|load|follow|read)[^.\n]{0,60}(instructions?|prompt|rules)[^.\n]{0,60}https?:\/\//i)
  add('high', 'hidden or direction-changing unicode characters', /[​-‏⁠﻿‪-‮]/)
  const granted = /^allowed-tools\s*:(.*)$/im.exec(text)?.[1]
  if (granted !== undefined && granted.split(',').some(tok => /^\s*(\*|(Bash|PowerShell|Shell)(\(\*\))?)\s*$/i.test(tok))) {
    out.push({ sev: 'high', what: 'grants itself broad tool permissions (allowed-tools)' })
  }
  add('medium', 'runs shell commands when it loads (inline ! blocks)', /^[ \t]*!`[^`]+`|`!\w/m)
  add('medium', 'defines hooks', /^hooks\s*:/m)
  add('medium', 'contains a long encoded blob or decodes base64', /[A-Za-z0-9+/]{200,}={0,2}|base64\s*(-d|--decode)|FromBase64String|atob\(/i)
  add('medium', 'sends data out (POST / upload)', /(curl|Invoke-RestMethod|Invoke-WebRequest|fetch)\b[^\n]{0,80}(\s-d\s|--data|-Body|POST)/i)
  add('medium', 'touches credentials or key files', /(\.ssh|id_rsa|\.aws[\\/]credentials|\.env\b|api[_-]?key|secret|token)[^\n]{0,60}(read|cat|send|upload|post|curl|copy)/i)
  add('medium', 'edits your memory or settings files', /(CLAUDE\.md|AGENTS\.md|settings(\.local)?\.json)[^\n]{0,60}(append|write|modify|edit|add to)/i)
  if (text.length > 10_000) out.push({ sev: 'low', what: `long (${text.length} characters): read all of it, payloads hide at the end` })
  return out
}

export function verdict(findings: readonly Finding[]): string {
  if (findings.some(f => f.sev === 'high')) return 'DO NOT INSTALL until a person has read it'
  if (findings.some(f => f.sev === 'medium')) return 'REVIEW the flagged parts before installing'
  return 'no red flags found (this is not a guarantee)'
}
