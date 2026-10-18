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

- **Daily budget.** At 50% of today's share, turns are capped at Sonnet · high. At 80%, at Haiku · medium (the 5-hour window can trigger the same caps). At 100%, new prompts and new subagents are refused until local midnight. `/budget soft` stays capped instead of refusing, `/budget unlock` lifts the lock for an hour.
- **Cache-aware.** In long conversations a one-step model switch is skipped while the prompt cache is still warm, because switching re-reads the whole conversation.
- **Subagents.** Read-only helper types (`Explore`, `claude-code-guide`, `statusline-setup`) start on Haiku unless the call names a model. Forks, resumes, teammates and workflow agents are never touched. Agent types can be hidden once usage is tight.
- **Helper agents** (all read-only): `scout`, `log-triage` (cuts a long build, cook or test log to its errors), `disk-auditor`, `repo-check` (git state before a cleanup or move) and `reviewer`. A prompt that fits one gets a one-line hint, decided by keywords.
- **Unreal Engine rules.** Prompts about UBT, linker, cook or packaging errors never run on the cheapest tiers, and Epic's `execute_tool_script` (arbitrary Python in the editor) always asks first.
- **Commands.** `/budget` (numbers, pace forecast), `/budget skills` (what your skill and command list costs), `/budget vet <path>` (red-flag scan of a skill or plugin before you install it), `/route` (pin a tier or model, `/route why` shows the recent decisions and token use).

## Install

```
claude plugin marketplace add ValhalaStudio/budget-router-kit
claude plugin install budget-router@budget-router-kit
```

Needs Claude Code 2.1.287 or newer and a Claude subscription (Pro or Max). On an API key routing works, but there are no rate-limit readings, so the budget does not.

## What it runs, reads, sends and stores

- **Sends:** the first 2,000 characters of each prompt to Claude Haiku, through Claude Code's own model call on your account, to label the task. Nothing is sent anywhere else, and the plugin makes no network requests of its own. Set the `classifier` option to `heuristic` to use keyword rules instead and send nothing.
- **Reads:** the rate-limit percentages and context size that Claude Code reports. Files are read only when you run `/budget vet <path>`.
- **Runs:** once per session, `date +%z` (or a one-line PowerShell command on Windows) to learn your time zone offset. Nothing else.
- **Stores locally** (the plugin store on your machine): the budget ledger, model ids seen, burn-rate samples, and a decision log of up to 200 rows (tier, reason, model, token counts; no prompt text). Turn the log off with `logDecisions`.
- **Adds to the conversation:** a short guidance block once per conversation, and optionally one hint line per prompt (`agentHints`).
- **No telemetry.**

Every setting is a `userConfig` option, shown in `/config`.

## What each hook decides

| Hook | What it does |
|---|---|
| `session.start` | Registers `/budget` and `/route`, loads saved settings, and learns your time zone offset (the small programs listed above). |
| `prompt.context` | Adds one short guidance block once per conversation. |
| `prompt.submit` | Picks the model tier for the turn. Refuses the prompt only when today's budget is spent, and not then if you ran `/budget unlock` or `/budget soft` or turned `lockAtLimit` off. May add one hidden hint line. |
| `turn.step` | Sets model and effort for each request. Subagent requests are only ever lowered when a usage cap applies, never raised. |
| `turn.complete` | Records token counts in the decision log. |
| `session.measure` | Reads the rate-limit numbers Claude Code reports; raises a toast and a system note when a cap starts to apply. |
| `agent.spawn` | Starts read-only helper types on Haiku when the call names no model. Refuses new subagents only when today's budget is spent (same exceptions as above). Never touches forks, resumes, teammates or workflow agents. |
| `agent.offer` | Hides the agent types you list in `hideAgentsAtCritical` once usage passes the second threshold. The list is empty by default. |
| `tool.check` | For Epic's Unreal `execute_tool_script` only: turns an allow into "ask you first". Never loosens a deny, and leaves every other tool alone. |
| `command.run` | Answers `/budget` and `/route` itself. |

The plugin does not read credentials, tokens or key files. `/budget vet` only looks for such patterns in the text of a skill or plugin you point it at.

## License

GPL-3.0-or-later. Copyright (C) 2026 ValhalaStudio. See [LICENSE](LICENSE).
