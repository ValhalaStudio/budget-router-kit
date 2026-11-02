# budget-router

**Stay inside your Claude weekly limit without thinking about it.** A community plugin for Claude Code (not made or endorsed by Anthropic) that routes each prompt to the right model and effort, keeps you inside a daily usage budget, and shows you cheaper habits when they matter.

Claude subscriptions have only a 5-hour and a weekly limit. budget-router splits what is left of the weekly limit evenly over the days until it resets, watches how much of today's share you have used, and tightens the model choice as it runs down. It is listed for Claude Code (the terminal and the desktop app's Code tab) and for Cowork, and has been tested in Claude Code only. It cannot see or change a chat in claude.ai.

```
sonnet·high (standard) │ day 42% │ 5h 12% │ week 61% │ saved $3.10      ← the status bar under your prompt
```

## What it does

### Routing

| Prompt looks like | Runs on |
|---|---|
| chit-chat, quick fact, one obvious command | Haiku · low |
| small, fully specified edit or lookup | Sonnet · low |
| normal coding, debugging, config work | Sonnet · high |
| design, hard bugs, refactors, security, research | Opus · high |
| "think hard" / "ultrathink" | Opus · xhigh |

The first choice is **rules**: keywords and the shape of the prompt choose the tier. Then, in order: the learner may move one step on evidence; a model family whose own weekly limit is nearly full is skipped; pace control steps routes cheaper while you are ahead of an even day; the usage caps apply; and Haiku is not used on a very long conversation.

- **Pinning.** The `pin` option fixes the route: a tier (`light`, `deep`, ...) or a model with an optional effort (`haiku`, `sonnet:low`, `opus:high`). `auto` (the default) routes every prompt. Usage caps still apply on top of a pin.
- **Cache-aware.** In long conversations a one-step model switch is skipped while the prompt cache is still warm, because switching re-reads the whole conversation.
- **Model ids.** The plugin acts only on models it recognises. It prefers an id the session has already run for that family; otherwise it swaps within the same generation, and only for plain ids such as `claude-sonnet-4-5`. A dated or provider-specific id is not swapped, so the request stays on the model Claude Code chose. A session on a model above Opus (Fable, Mythos) is routed to the current Opus, Sonnet or Haiku id.
- **Unreal Engine rule.** Prompts about UBT, linker, cook or packaging errors never run on the two cheapest tiers. budget-router does not touch permission prompts: if you use Epic's Unreal MCP (its `execute_tool_script` runs arbitrary Python inside the editor), keep Claude's tool approvals on.

### Budget

- **Daily budget.** At 50% of today's share, turns are capped at Sonnet · high. At 80%, at Haiku · medium (the 5-hour window can trigger the same caps). At 100% turns stay at that second cap. **It never refuses a prompt or a subagent**: when the day's share is spent you are told, and Claude Code's own limits are the only hard stop.
- **Status bar.** The route, today's share used, the 5-hour and weekly windows, and the estimated saving once it is positive.
- **Pace control.** A small controller compares today's use with an even spread across your day (08:00 to 24:00) and steps routes one or two notches cheaper while you are ahead. "Think hard" prompts and a pinned route are left alone.
- **Escalation.** A turn with 3 failed tool calls gets one more notch of effort; 6 also raises the model one step, once per turn.
- **Subagents.** budget-router does not change how subagents start and hides no agents. While a usage cap applies, a subagent's requests are lowered to the same cap as the main turn, never raised.

### Learning

- **Learner.** A cost-aware bandit over model and effort. It records, per kind of work and per project, whether each turn went well (few failed tool calls; you did not redo or rephrase it; a thanks counts as a win) and what the turn cost in tokens. It never leaves the rule-based choice without evidence: a cheaper step needs a record that it works here (about 8 turns, or a rare, capped exploration on ordinary prompts, never on deep or max ones), and a dearer step needs a record that the rule choice keeps failing. As the daily budget runs out it weighs cost more heavily. Old evidence fades over about two weeks, and a new model id halves the record for that family. `learnMode`: `live` (default), `shadow` (learns, never changes the route) or `off`. Costs are estimates from list prices by model id. It is early and cautious, so expect little effect until it has a few weeks of your turns.
- **Report.** `study/report.py` in the repository (not part of the plugin, never run by it) turns your local transcripts and the plugin's store into one HTML page: where the usage went, your longest turns and pauses, the measured cost of each effort level on each model, what the learner has found, and plain conclusions on what to change.

### Habits

- **Ghost-token guard.** Most of the cost of a long session is context re-read or re-written from the cache. After a long pause a notice shows what re-writing the context will cost (`idleGuard`: `warn` or `off`; it never holds a prompt), and a notice appears when the context passes each multiple of `nudgeContext`.
- **Tips.** A short notice when the situation calls for a cheaper habit: a long paste, a build log, a long turn, repeated failed tool calls, a vague broad ask, a capped day, a command you could run yourself. Shown to you only (never added to the conversation), at most one every 10 minutes, each once per session; the `tips` option turns them off. Every habit, with its source, is in [CHEATSHEET.md](CHEATSHEET.md).
- **Helper agents** (in `agents/`): `scout` (wide searches) and `log-triage` (cuts a long build, cook or test log to its errors) have no shell, only Read, Grep and Glob. `disk-auditor`, `repo-check` (git state before a cleanup or move) and `reviewer` use the shell to measure or run git, and their instructions forbid changing anything; the tool list does not enforce that, so keep Claude's tool approvals on. Claude Code offers them to the model by their own descriptions; the plugin does not point the model at them.

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
- **Stores locally** (the plugin store on your machine): the budget ledger, model ids seen, the pace controller state, and the learner's counts. No prompt text. See [PRIVACY.md](PRIVACY.md).
- **No telemetry.**

## What this mod can decide for you

This plugin is a mod (a hooks module, wired in `hooks/register.ts`). It decides one thing: the model and effort of each request (`turn.step`). The `pin` option overrides the choice, and the usage caps apply on top. It takes no other decision: it never refuses, holds, drops or rewrites a prompt, a tool call or a subagent, never approves or denies a permission request, registers no tools, commands or agents, stands in for no tool, and adds nothing to the prompt or the system prompt. It does not touch the permission mode, Remote Control, settings, agent registration, command execution or file writes.

## What each hook does

The habits behind the tips are in [CHEATSHEET.md](CHEATSHEET.md). Diagrams of the architecture, the types, one turn, how a route is decided and the budget states are in [ARCHITECTURE.md](ARCHITECTURE.md).

| Hook | What it does | What it changes |
|---|---|---|
| `session.start` | Loads what the plugin stored and hashes the working folder's name. | Nothing; passes the event on with `next(e)`. |
| `session.measure` | Reads the rate-limit and context figures; updates the status bar; shows a notice and appends a short system note when a usage cap starts. | Nothing in the event; passes it on with `next(e)`. |
| `prompt.submit` | Reads the typed prompt to choose the route for the turn (rules, then the learner, then pace control, then the usage caps). Shows a notice when a long pause means the context is re-written, and at most one tip (`hooks/tips.ts`, fixed texts). | Nothing: the prompt and its context are passed on exactly as received, with `next(e)`. It never drops, holds or rewrites a prompt. |
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
- **No cache or idle notices.** The idle notice needs a context of at least 60,000 tokens and a pause of over 55 minutes.
- **Too many notices.** Set `idleGuard` to `off`, `nudgeContext` to 0 or `wrapUpPercent` to 0 in `/config`.
- **Start over.** See "Deleting it" in [PRIVACY.md](PRIVACY.md).
- **Still stuck.** Open an issue: https://github.com/ValhalaStudio/budget-router-kit/issues

## Privacy and support

The full privacy policy is in [PRIVACY.md](PRIVACY.md). Support is through [GitHub issues](https://github.com/ValhalaStudio/budget-router-kit/issues); the source here is what runs. How the plugin meets the Anthropic Software Directory Policy is set out in [review.md](https://github.com/ValhalaStudio/budget-router-kit/blob/main/review.md).

## License

GPL-3.0-or-later. Copyright (C) 2026 ValhalaStudio. See [LICENSE](LICENSE).
