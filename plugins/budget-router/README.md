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
- **Notices about what you have installed.** If no helper agent fits, a notice to you can name an installed skill or agent whose description clearly matches the prompt (keyword ranking, no model call). The notice goes to you only: nothing is added to the conversation and nothing steers Claude toward another plugin. It cannot find anything you have not installed.
- **Ghost-token guard.** Most of the cost of a long session is context re-read or re-written from the cache. After a long pause the plugin tells you what re-writing the context will cost (`idleGuard`: off, warn, or ask, which also pauses that prompt once), and it notices when the context passes each multiple of `nudgeTokens`.
- **Runbook memory.** It watches shell commands as they run (it does not read the conversation history) and counts the ones that repeat. When the same job has run 4 times it offers to keep it: `/runbook save [name]` writes it to a script file after you ask, and later prompts that match get a one-line pointer to your own script. Commands that look like they hold a key, a login or a long secret string are refused.
- **Learner (0.8).** A cost-aware bandit over model and effort. It records, per kind of work and per project, whether each turn went well (few failed tool calls; you did not redo or rephrase it; a thanks counts as a win) and what the turn cost in tokens. It never leaves the rule-based choice without evidence: a cheaper step needs a record that it works here (or a rare, capped exploration on ordinary prompts, never on deep or max ones), and a dearer step needs a record that the rule choice keeps failing. As the daily budget runs out it weighs cost more heavily. Old evidence fades over about two weeks, and a new model id halves the record for that family. Modes via the `learnMode` option: `live` (default), `shadow` (only logs what it would pick), `classic` (the 0.6 success-rate learner) or `off`. `/budget learn` shows what it has seen and an estimated saving; `/budget learn reset` clears it. The previous turn's size (a long turn tends to follow a long turn) is one of its inputs, and `/budget learn export` prints counts you can choose to share (see the repository README). Costs are estimates from list prices by model id (override with `priceTable`). With `reflect` switched on (it is off by default) it can ask Haiku for a one-word second opinion on unclear turns, a few times a day.
- **Commands.** `/runbook` (list, save, forget), `/budget` (numbers, pace forecast, what the learner has seen; `/budget wipe` deletes everything the plugin stored), `/budget skills` (what your skill and command list costs), `/budget vet <path>` (red-flag scan of a skill or plugin before you install it), `/route` (pin a tier or model, `/route why` shows the recent decisions and token use).

## Install

```
claude plugin marketplace add ValhalaStudio/budget-router-kit
claude plugin install budget-router@budget-router-kit
```

Needs Claude Code 2.1.287 or newer and a Claude subscription (Pro or Max). On an API key routing works, but there are no rate-limit readings, so the budget does not.

## What it runs, reads, sends and stores

- **Sends:** the first 2,000 characters of each prompt to Claude Haiku, through Claude Code's own model call on your account, to label the task. Nothing is sent anywhere else, and the plugin makes no network requests of its own. Set the `classifier` option to `heuristic` to use keyword rules instead and send nothing.
- **Also sends** (only if you switch `reflect` on; it is off by default; at most `reflectPerDay` times): for turns with one or two failed tool calls, the first 300 characters of your prompt and the first 600 of the reply, to Claude Haiku, to get a one-word verdict. Set `reflect` to false to stop it.
- **Reads:** the rate-limit percentages and context size that Claude Code reports, and each shell command as it runs (to count repeats). It does not read the conversation history, memory or uploaded files. Files are read only when you run `/budget vet <path>`. It reads the HOME or USERPROFILE environment variable to find where runbooks go.
- **Runs:** once per session, `date +%z` (or a one-line PowerShell command on Windows) to learn your time zone offset, and `pwd` (or `(Get-Location).Path`) to learn which project folder you are in, which is hashed. Nothing else.
- **Writes:** one script file per `/runbook save`, in `runbookDir` (default `.claude/runbooks` in your home folder). Nothing else is written outside the plugin store.
- **Stores locally** (the plugin store on your machine): the budget ledger, model ids seen, burn-rate samples, a decision log of up to 200 rows (tier, reason, model, token counts; no prompt text), the pace controller state, per-kind success counts for the learner, and, for runbook memory, the text of up to 150 repeated shell commands. Turn the log off with `logDecisions` and runbook memory off with `runbooks`.
- **Adds to the conversation:** a short guidance block once per conversation, and optionally one hint line per prompt (`agentHints`).
- **No telemetry.**

Every setting is a `userConfig` option, shown in `/config`.

## What this mod can decide for you, and what it can send out

This plugin is a mod, so it is worth saying plainly what it can do with that power. Everything here is in `hooks/register.ts`.

**It can refuse or hold, in exactly three cases, and each one is yours to switch off or override:**

| Case | When | Your control |
|---|---|---|
| Refuses a prompt (`prompt.submit`) | Only when today's budget share is 100% spent | `/budget unlock` (1 hour), `/budget soft` (never refuse), or `lockAtLimit` off. The message says how. |
| Refuses a new subagent (`agent.spawn`) | Same condition, same overrides | Same |
| Holds a prompt once and asks you to resend it (`prompt.submit`) | Only if `idleGuard` is set to `ask` (the default is `warn`, which only shows a notice), after a long pause with a big context | Leave `idleGuard` at `warn` or `off` |

It never blocks, rewrites or delays a tool call, and never changes what you typed. The only thing it can hide is agent types you list yourself in `hideAgentsAtCritical` (empty by default), from the model, once usage is high. Choosing the model and effort for a turn is its purpose, `/route <model>` pins one, and the usage caps still apply on top of a pin.

**It reads local data only as listed above** (the prompt, rate-limit numbers, shell commands to count repeats, a path you give `/budget vet`). It does not read the conversation history, memory, credentials, or any file you did not name.

**It can send data out in two places, both through Claude Code's own model call on your account to Claude Haiku, and nowhere else:** the first 2,000 characters of a prompt to label the task (set `classifier` to `heuristic` to send nothing), and, only if you turn `reflect` on, up to 300 characters of a prompt and 600 of the reply. The plugin makes no network requests of its own, has no server and no telemetry, and fetches no code or instructions. Sharing learner counts happens only if you copy `/budget learn export` into an issue yourself.

## What each hook decides

| Hook | What it does |
|---|---|
| `session.start` | Registers `/budget`, `/route` and `/runbook`, loads saved settings, and learns your time zone offset (the small programs listed above). |
| `prompt.context` | Adds one short guidance block once per conversation. |
| `prompt.submit` | Picks the model tier for the turn (rules, then the learner, then pace control, then usage caps). Warns about an expired cache. Refuses the prompt only when today's budget is spent, and not then if you ran `/budget unlock` or `/budget soft` or turned `lockAtLimit` off. With `idleGuard` set to `ask` (default `warn`) it holds a prompt once after a long idle pause. May add one hidden hint line. |
| `turn.step` | Sets model and effort for each request. Subagent requests are only ever lowered when a usage cap applies, never raised. |
| `turn.complete` | Records token counts in the decision log and records how the turn went for the learner. |
| `tool.call` | Passes every tool call through unchanged. Counts failed calls since your last prompt and counts repeated shell commands. Never blocks, rewrites or delays a call. |
| `session.measure` | Reads the rate-limit numbers Claude Code reports; raises a toast and a system note when a cap starts to apply. |
| `agent.spawn` | Starts read-only helper types on Haiku when the call names no model. Refuses new subagents only when today's budget is spent (same exceptions as above). Never touches forks, resumes, teammates or workflow agents. |
| `agent.offer` | Hides the agent types you list in `hideAgentsAtCritical` once usage passes the second threshold. The list is empty by default. |
| `skill.prompt` | Notes which skill was used, so the log can say whether a suggestion was followed. |
| `command.run` | Answers `/budget`, `/route` and `/runbook` itself. |

The plugin does not read credentials, tokens or key files.

## Example prompts and use cases

1. **Keep a day inside a budget.** Work as usual. At 50% of the day's share `/budget` shows turns capped at Sonnet; `/route why` lists what was chosen and why. Try: "rename this variable everywhere" (runs on a cheap tier) and then "redesign the save system" (runs on Opus).
2. **Stop paying twice for the same build.** Run your build command four times. A notice offers to keep it; `/runbook save ue-build compile the editor target` writes the script, and a later "compile the editor target again" gets a pointer to it.
3. **Avoid a surprise after a break.** Come back after an hour with a large conversation. A notice shows what re-writing the context will cost, so you can `/compact` or start fresh first.
4. **Tame a runaway turn.** When a build fails several times in one turn, the next steps get one more notch of effort, and `/route why` shows the change.
5. **Check a skill before installing it.** `/budget vet ./some-skill` lists red flags in its text (hidden characters, pipes into a shell, broad permissions).

No account, sign-in or test data is needed: install the plugin and use Claude Code.

## Troubleshooting

- **A prompt was refused.** Today's budget is spent. `/budget unlock` lifts it for an hour, `/budget soft` stays capped instead of refusing, and the `lockAtLimit` option turns the lock off.
- **The model never changes.** `/route` may be pinned: `/route auto` releases it. In a long conversation a one-step model switch is skipped while the cache is warm.
- **No cache or idle notices.** They need a context of at least `idleMinTokens` (60,000 by default) and a pause longer than `cacheWarmMinutes`.
- **`/runbook save` did nothing useful.** The command must have run at least twice, must not live in a scratch folder, and must not look like it holds a key or login. `/runbook list` shows what is waiting.
- **Too many notices.** Switch off `catalogHints`, `idleGuard` or `nudgeTokens`, or any other feature in `/config`.
- **Start over.** `/budget wipe` deletes everything the plugin stored.
- **Still stuck.** Open an issue: https://github.com/ValhalaStudio/budget-router-kit/issues

## Privacy and support

The full privacy policy, with what is handled, where it goes, how long it is kept and how to delete it, is in [PRIVACY.md](PRIVACY.md). Support is through GitHub issues, and the source here is what runs.

## How it follows the Anthropic Software Directory Policy

| Policy area | What budget-router does |
|---|---|
| Safety and security | It changes only which model and effort a turn uses, and what you are told. It does not weaken Claude's safeguards or sandbox, and the budget lock is yours to override (`/budget unlock`). |
| Privacy and data | Collects only what each feature needs (see PRIVACY.md). No conversation history, memory or file reads. No third party receives data. |
| Hidden or fetched instructions | None. All guidance text is in the source, readable, and nothing is fetched from anywhere. |
| Other plugins | It never calls another plugin's tools and never adds text that points the model at them; notices about installed skills go to you. It does lower the model of subagents when usage is tight, and it can hide agent types, but only ones you list yourself (none by default). |
| Documentation and support | This README, PRIVACY.md and the issue tracker. Three working examples are above. |
| Unsupported use cases | It does not move money, generate images, video or audio, or serve advertisements. The dollar figures it shows are estimates of usage cost, not transactions. |

## License

GPL-3.0-or-later. Copyright (C) 2026 ValhalaStudio. See [LICENSE](LICENSE).
