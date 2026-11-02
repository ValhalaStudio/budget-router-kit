# budget-router

Routes each Claude Code prompt to the right model and effort, and keeps you inside a daily usage budget.

Claude subscriptions only have a 5-hour and a weekly limit. budget-router splits what is left of the weekly limit evenly over the days until it resets, watches how much of today's share you have used, and tightens the model choice as it runs down. It works in Claude Code only (the terminal and the desktop app's Code tab), not in claude.ai chat.

## What it does

| Prompt looks like | Runs on |
|---|---|
| chit-chat, quick fact, one obvious command | Haiku · low |
| small, fully specified edit or lookup | Sonnet · low |
| normal coding, debugging, config work | Sonnet · high |
| design, hard bugs, refactors, security, research | Opus · high |
| "think hard" / "ultrathink" | Opus · xhigh |

- **Daily budget.** At 50% of today's share, turns are capped at Sonnet · high. At 80%, at Haiku · medium (the 5-hour window can trigger the same caps). At 100% turns stay at that second cap. **It never refuses a prompt or a subagent**: when the day's share is spent you are told, and Claude Code's own limits are the only hard stop.
- **Status bar.** The line under the prompt shows the current route, today's share used, the 5-hour and weekly windows, and the estimated saving: `sonnet·high (standard) │ day 42% │ 5h 12% │ week 61% │ saved $3.10`.
- **Cache-aware.** In long conversations a one-step model switch is skipped while the prompt cache is still warm, because switching re-reads the whole conversation.
- **Subagents.** budget-router does not change how subagents start and hides no agents. While a usage cap applies, a subagent's requests are lowered to the same cap as the main turn, never raised.
- **Unreal Engine rule.** Prompts about UBT, linker, cook or packaging errors never run on the two cheapest tiers. budget-router does not touch permission prompts: if you use Epic's Unreal MCP (its `execute_tool_script` runs arbitrary Python inside the editor), keep Claude's tool approvals on.
- **Pace control.** A small controller compares today's use with an even spread across your day (08:00 to 24:00 by default) and steps routes one or two notches cheaper while you are ahead. "Think hard" prompts and a pinned route are left alone.
- **Escalation.** A turn with 3 failed tool calls gets one more notch of effort; 6 also raises the model one step, once per turn.
- **Ghost-token guard.** Most of the cost of a long session is context re-read or re-written from the cache. After a long pause a notice shows what re-writing the context will cost (`idleGuard`: `warn` or `off`; it never holds a prompt), and a notice appears when the context passes each multiple of `nudgeContext`.
- **Learner.** A cost-aware bandit over model and effort. It records, per kind of work and per project, whether each turn went well (few failed tool calls; you did not redo or rephrase it; a thanks counts as a win) and what the turn cost in tokens. It never leaves the rule-based choice without evidence: a cheaper step needs a record that it works here (or a rare, capped exploration on ordinary prompts, never on deep or max ones), and a dearer step needs a record that the rule choice keeps failing. As the daily budget runs out it weighs cost more heavily. Old evidence fades over about two weeks. Modes via `learnMode`: `live` (default), `shadow` (records, never changes the route), `classic` (a simpler success-rate learner) or `off`. Costs are estimates from list prices by model id (override with `priceTable`).
- **Pinning.** The `pin` option fixes the route: a tier (`light`, `deep`, ...) or a model with an optional effort (`haiku`, `sonnet:low`, `opus:high`). `auto` (the default) routes every prompt. Usage caps still apply on top of a pin.
- **Helper agents** (all read-only, in `agents/`): `scout`, `log-triage` (cuts a long build, cook or test log to its errors), `disk-auditor`, `repo-check` (git state before a cleanup or move) and `reviewer`. Claude Code offers them to the model by their own descriptions; the plugin does not point the model at them.

There are no slash commands. Everything is shown in the status bar and in notices, and every setting is a `userConfig` option in `/config`.

## Install

```
claude plugin marketplace add ValhalaStudio/budget-router-kit
claude plugin install budget-router@budget-router-kit
```

Needs Claude Code 2.1.287 or newer and a Claude subscription (Pro or Max). On an API key routing works, but there are no rate-limit readings, so the budget does not.

## What it runs, reads, sends, writes and stores

- **Sends: nothing.** Prompts are labelled by keyword rules on your machine. The plugin has no model call, no `http` call and no network request, and no option can switch one on.
- **Reads:** the rate-limit percentages, context size and per-turn token counts that Claude Code reports, the text of the prompt you type (in memory, to choose the route; never stored), and the name of the working folder, which is hashed at once. Nothing else: it does not read the conversation history, memory, files, the commands you run, credentials, tokens or environment variables. The code has no file access at all.
- **Runs: no programs.**
- **Writes: no files.** Everything it keeps goes to the plugin store. It does not edit any build, start-up, settings or instructions file and does not change Claude Code's settings.
- **Adds to the conversation:** nothing to your prompts or to the system prompt. When a usage cap starts, and once at the wrap-up point, it appends one short system note saying so, so the model knows it is on a cheaper model. The same text is shown to you as a notice.
- **Stores locally** (the plugin store on your machine): the budget ledger, model ids seen, burn-rate samples, the pace controller state, and the learner's counts. No prompt text. See [PRIVACY.md](PRIVACY.md).
- **No telemetry.**

## What this mod can decide for you

This plugin is a mod (a hooks module), so here is plainly what it can do with that. Everything is in `hooks/register.ts`.

**It decides the model and effort of each request** (`turn.step`). That is its purpose. The `pin` option overrides the choice; the usage caps apply on top.

**It takes no other decision.** It never refuses, holds, drops or rewrites a prompt, a tool call or a subagent, and never approves or denies a permission request. It registers no tools, commands or agents of its own, stands in for no tool, and adds nothing to the prompt or the system prompt. It does not touch the permission mode, Remote Control, settings, agent registration, command execution or file writes.

## What each hook does

| Hook | What it does | What it changes |
|---|---|---|
| `session.start` | Loads what the plugin stored and hashes the working folder's name. | Nothing; passes the event on with `next(e)`. |
| `session.measure` | Reads the rate-limit and context figures; updates the status bar; shows a notice and appends a short system note when a usage cap starts. | Nothing in the event; passes it on with `next(e)`. |
| `prompt.submit` | Reads the typed prompt to choose the route for the turn (rules, then the learner, then pace control, then the usage caps). Shows a notice when a long pause means the context is re-written. | Nothing: the prompt and its context are passed on exactly as received, with `next(e)`. It never drops, holds or rewrites a prompt. |
| `turn.step` | Sets model and effort for each request of a main-conversation turn. Subagent requests are only ever lowered when a usage cap applies, never raised. | The `model` and `effort` of the request, nothing else. |
| `tool.call` | Counts failed tool calls since your last prompt (for escalation and the learner). It never looks at what a call was asked to do. | Nothing: every call goes on with `next(e)`, and the hook returns exactly what `next` gives back. |
| `turn.complete` | Reads the finished turn's token counts and records how the turn went for the learner. | Nothing; returns what `next` gives back. |

There is no `prompt.context`, `command.run`, `agent.offer`, `agent.spawn`, `skill.prompt`, `config.set`, `agent.register`, `fs.write` or permission hook.

## Example prompts and use cases

1. **Keep a day inside a budget.** Work as usual and watch the status bar. Try "rename this variable everywhere" (runs on a cheap tier) and then "redesign the save system" (runs on Opus). At 50% of the day's share a notice says turns are now capped at Sonnet.
2. **Avoid a surprise after a break.** Come back after an hour with a large conversation. A notice shows what re-writing the context will cost, so you can `/compact` or start fresh first.
3. **Tame a runaway turn.** When a build fails several times in one turn, the next steps get one more notch of effort, and the status bar shows the new route.

No account, sign-in or test data is needed: install the plugin and use Claude Code.

## Troubleshooting

- **A prompt was refused.** Not by budget-router, which never refuses a prompt. If Claude Code reports a usage limit, that is Anthropic's own limit.
- **The model never changes.** The `pin` option may be set: set it back to `auto` in `/config`. In a long conversation a one-step model switch is skipped while the cache is warm.
- **No budget in the status bar.** The rate-limit readings arrive after the first reply, and only on a Claude subscription.
- **No cache or idle notices.** They need a context of at least `idleMinContext` (60,000 by default) and a pause longer than `cacheWarmMinutes`.
- **Too many notices.** Set `idleGuard` to `off`, `nudgeContext` to 0 or `wrapUpPercent` to 0 in `/config`.
- **Start over.** See "Deleting it" in [PRIVACY.md](PRIVACY.md).
- **Still stuck.** Open an issue: https://github.com/ValhalaStudio/budget-router-kit/issues

## Privacy and support

The full privacy policy, with what is handled, where it goes, how long it is kept and how to delete it, is in [PRIVACY.md](PRIVACY.md). Support is through GitHub issues, and the source here is what runs.

## How it follows the Anthropic Software Directory Policy

| Policy area | What budget-router does |
|---|---|
| Safety and security | It changes only which model and effort a request uses, and what you are told. It does not weaken Claude's safeguards or sandbox, takes no permission decision, and never refuses a prompt, tool call or subagent. |
| Privacy and data | Collects only what each feature needs (see PRIVACY.md). No conversation history, memory or file reads; prompt text is never stored. No third party receives data. |
| Hidden or fetched instructions | None. It adds nothing to prompts or the system prompt; the only text it appends is the cap notice described above, and nothing is fetched from anywhere. |
| Other plugins | It never calls another plugin's tools and never points the model at them. It does not change how subagents start and hides no agents. |
| Documentation and support | This README, PRIVACY.md and the issue tracker. Three working examples are above. |
| Unsupported use cases | It does not move money, generate images, video or audio, or serve advertisements. The dollar figures it shows are estimates of usage cost, not transactions. |

## License

GPL-3.0-or-later. Copyright (C) 2026 ValhalaStudio. See [LICENSE](LICENSE).
