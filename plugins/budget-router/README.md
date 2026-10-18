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
- **Unreal Engine rules.** Prompts about UBT, linker, cook or packaging errors never run on the cheapest tiers, and get a hint to let `log-triage` cut the log down first. budget-router does not touch permission prompts: if you use Epic's Unreal MCP (its `execute_tool_script` runs arbitrary Python inside the editor), keep Claude's tool approvals on.
- **Pace control.** A small controller compares today's use with an even spread across your day (08:00 to 24:00 by default) and steps routes one or two notches cheaper while you are ahead. "Think hard" prompts and `/route` pins are left alone.
- **Escalation.** A turn with 3 failed tool calls gets one more notch of effort; 6 also raises the model one step, once per turn.
- **Suggestions from what you have installed.** If no helper agent fits, one hint can name an installed skill or agent whose description clearly matches the prompt (keyword ranking, no model call). It cannot find anything you have not installed.
- **Ghost-token guard.** Most of the cost of a long session is context re-read or re-written from the cache. After a long pause the plugin tells you what re-writing the context will cost (`idleGuard`: off, warn, or ask, which also pauses that prompt once), and it notices when the context passes each multiple of `nudgeTokens`.
- **Runbook memory.** It counts the shell commands you run. When the same job has run 4 times it offers to keep it: `/runbook save [name]` writes it to a script file after you ask, and later prompts that match get a one-line pointer to it. Commands that look like they hold a key, a login or a long secret string are refused.
- **Learner.** It records whether each turn went well (few failed tool calls, and you did not redo it) per kind of prompt and model step. With enough evidence it moves one step up where a step keeps failing, or one step down where the cheaper step works. For unclear turns it can ask Haiku for a one-word second opinion, a few times a day (`reflect`).
- **Commands.** `/runbook` (list, save, forget), `/budget` (numbers, pace forecast, what the learner has seen), `/budget skills` (what your skill and command list costs), `/budget vet <path>` (red-flag scan of a skill or plugin before you install it), `/route` (pin a tier or model, `/route why` shows the recent decisions and token use).

## Install

```
claude plugin marketplace add ValhalaStudio/budget-router-kit
claude plugin install budget-router@budget-router-kit
```

Needs Claude Code 2.1.287 or newer and a Claude subscription (Pro or Max). On an API key routing works, but there are no rate-limit readings, so the budget does not.

## What it runs, reads, sends and stores

- **Sends:** the first 2,000 characters of each prompt to Claude Haiku, through Claude Code's own model call on your account, to label the task. Nothing is sent anywhere else, and the plugin makes no network requests of its own. Set the `classifier` option to `heuristic` to use keyword rules instead and send nothing.
- **Also sends** (only if `reflect` is on, at most `reflectPerDay` times): for turns with one or two failed tool calls, the first 300 characters of your prompt and the first 600 of the reply, to Claude Haiku, to get a one-word verdict. Set `reflect` to false to stop it.
- **Reads:** the rate-limit percentages and context size that Claude Code reports, and the shell commands in the conversation (to count repeats). Files are read only when you run `/budget vet <path>`. It reads the HOME or USERPROFILE environment variable to find where runbooks go.
- **Runs:** once per session, `date +%z` (or a one-line PowerShell command on Windows) to learn your time zone offset. Nothing else.
- **Writes:** one script file per `/runbook save`, in `runbookDir` (default `.claude/runbooks` in your home folder). Nothing else is written outside the plugin store.
- **Stores locally** (the plugin store on your machine): the budget ledger, model ids seen, burn-rate samples, a decision log of up to 200 rows (tier, reason, model, token counts; no prompt text), the pace controller state, per-kind success counts for the learner, and, for runbook memory, the text of up to 150 repeated shell commands. Turn the log off with `logDecisions` and runbook memory off with `runbooks`.
- **Adds to the conversation:** a short guidance block once per conversation, and optionally one hint line per prompt (`agentHints`).
- **No telemetry.**

Every setting is a `userConfig` option, shown in `/config`.

## What each hook decides

| Hook | What it does |
|---|---|
| `session.start` | Registers `/budget`, `/route` and `/runbook`, loads saved settings, and learns your time zone offset (the small programs listed above). |
| `prompt.context` | Adds one short guidance block once per conversation. |
| `prompt.submit` | Picks the model tier for the turn (rules, then the learner, then pace control, then usage caps). Warns about an expired cache. Refuses the prompt only when today's budget is spent, and not then if you ran `/budget unlock` or `/budget soft` or turned `lockAtLimit` off. May add one hidden hint line. |
| `turn.step` | Sets model and effort for each request. Subagent requests are only ever lowered when a usage cap applies, never raised. |
| `turn.complete` | Records token counts in the decision log, counts shell commands for runbook memory, and records how the turn went for the learner. |
| `session.measure` | Reads the rate-limit numbers Claude Code reports; raises a toast and a system note when a cap starts to apply. |
| `agent.spawn` | Starts read-only helper types on Haiku when the call names no model. Refuses new subagents only when today's budget is spent (same exceptions as above). Never touches forks, resumes, teammates or workflow agents. |
| `agent.offer` | Hides the agent types you list in `hideAgentsAtCritical` once usage passes the second threshold. The list is empty by default. |
| `skill.prompt` | Notes which skill was used, so the log can say whether a suggestion was followed. |
| `command.run` | Answers `/budget`, `/route` and `/runbook` itself. |

The plugin does not read credentials, tokens or key files.

## License

GPL-3.0-or-later. Copyright (C) 2026 ValhalaStudio. See [LICENSE](LICENSE).
