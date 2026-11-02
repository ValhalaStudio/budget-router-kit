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
- **Cache-aware.** In long conversations a one-step model switch is skipped while the prompt cache is still warm, because switching re-reads the whole conversation.
- **Subagents.** budget-router does not change how subagents start and hides no agents. While a usage cap applies, a subagent's requests are lowered to the same cap as the main turn, never raised.
- **Helper agents** (all read-only): `scout`, `log-triage` (cuts a long build, cook or test log to its errors), `disk-auditor`, `repo-check` (git state before a cleanup or move) and `reviewer`. A prompt that fits one gets a one-line hint, decided by keywords.
- **Unreal Engine rules.** Prompts about UBT, linker, cook or packaging errors never run on the cheapest tiers, and get a hint to let `log-triage` cut the log down first. budget-router does not touch permission prompts: if you use Epic's Unreal MCP (its `execute_tool_script` runs arbitrary Python inside the editor), keep Claude's tool approvals on.
- **Pace control.** A small controller compares today's use with an even spread across your day (08:00 to 24:00 by default) and steps routes one or two notches cheaper while you are ahead. "Think hard" prompts and `/route` pins are left alone.
- **Escalation.** A turn with 3 failed tool calls gets one more notch of effort; 6 also raises the model one step, once per turn.
- **Notices about what you have installed.** If no helper agent fits, a notice to you can name an installed skill or agent whose description clearly matches the prompt (keyword ranking, no model call). The notice goes to you only: nothing is added to the conversation and nothing steers Claude toward another plugin. It cannot find anything you have not installed.
- **Ghost-token guard.** Most of the cost of a long session is context re-read or re-written from the cache. After a long pause the plugin shows a notice with what re-writing the context will cost (`idleGuard`: `warn` or `off`; it never holds a prompt), and it notices when the context passes each multiple of `nudgeContext`.
- **Learner (0.8).** A cost-aware bandit over model and effort. It records, per kind of work and per project, whether each turn went well (few failed tool calls; you did not redo or rephrase it; a thanks counts as a win) and what the turn cost in tokens. It never leaves the rule-based choice without evidence: a cheaper step needs a record that it works here (or a rare, capped exploration on ordinary prompts, never on deep or max ones), and a dearer step needs a record that the rule choice keeps failing. As the daily budget runs out it weighs cost more heavily. Old evidence fades over about two weeks, and a new model id halves the record for that family. Modes via the `learnMode` option: `live` (default), `shadow` (only logs what it would pick), `classic` (the 0.6 success-rate learner) or `off`. `/budget learn` shows what it has seen and an estimated saving; `/budget learn reset` clears it. The previous turn's size (a long turn tends to follow a long turn) is one of its inputs, and `/budget learn export` prints counts you can choose to share (see the repository README). Costs are estimates from list prices by model id (override with `priceTable`).
- **Commands.** Since 0.10.5 the commands are plugin markdown commands, so Claude Code lists them with the plugin name: `/budget-router:budget` and `/budget-router:route` (this README and the notices write them short, as `/budget` and `/route`). Each one calls a tool of the plugin that does the work and prints its text exactly as transcript lines, then the model says "Done." (the tool's text also goes to the model as the tool result, so `/budget skills`, `/route why` and `/budget learn export` reach the model and the API like any tool output); a command costs one very short Haiku turn. The two tools answer only a command you typed, with the arguments you typed; if the model calls one on its own (for instance after reading a hostile file), nothing happens. `/budget` shows the numbers, the pace forecast and what the learner has seen; `/budget wipe` deletes everything the plugin stored; `/budget skills` shows what your skill and command list costs; `/route` pins a tier or model, and `/route why` shows the recent decisions and token use.

## Install

```
claude plugin marketplace add ValhalaStudio/budget-router-kit
claude plugin install budget-router@budget-router-kit
```

Needs Claude Code 2.1.287 or newer and a Claude subscription (Pro or Max). On an API key routing works, but there are no rate-limit readings, so the budget does not.

## What it runs, reads, sends, writes and stores

- **Sends: nothing.** Prompts are labelled by keyword rules on your machine (there is no model call and no `http` call), and the plugin makes no network requests. Versions up to 0.10.4 had an optional Haiku classifier; 0.10.5 removed it, so the plugin has no code that sends anything.
- **Reads:** the rate-limit percentages and context size that Claude Code reports. Nothing else: it does not read the conversation history, memory, files, the commands you run, credentials, tokens or environment variables, and the plugin has no code that opens a file. Older versions could read shell commands and files you named; that is gone, and the repeated-command text they had stored is cleared when the plugin starts.
- **Runs: no programs.** It does not call `process.run` or any other way of starting a program. The time zone offset comes from the engine's own clock and the project folder from the session's working directory (`$.session.cwd()`), which is hashed. Earlier versions ran `date`, `pwd` and `powershell` for these two values; 0.10.5 removed them.
- **Writes: no files.** Everything it keeps goes to the plugin store. It does not edit any build, start-up, settings or instructions file and does not change Claude Code's settings.
- **Stores locally** (the plugin store on your machine): the budget ledger, model ids seen, burn-rate samples, a decision log of up to 200 rows (tier, reason, model, token counts; no prompt text), the pace controller state, and per-kind success counts for the learner. Turn the log off with `logDecisions`; `/budget wipe` deletes it all.
- **Adds to the conversation:** a short guidance block once per conversation, and optionally one hint line per prompt (`agentHints`).
- **No telemetry.**

Every setting is a `userConfig` option, shown in `/config`.

## What this mod can decide for you, and what it can send out

This plugin is a mod, so it is worth saying plainly what it can do with that power. Everything here is in `hooks/register.ts`.

**It takes no permission decision.** It never refuses, holds, drops or rewrites a prompt, a tool call or a subagent (the one exception: a call the model makes on its own to the plugin's two command tools, which is refused so that only you can run `/budget wipe`), and never approves or denies a permission request. It does not touch the permission mode, Remote Control, settings, agent registration, command execution or file writes. `tool.call` (for every tool but its own two), `agent.offer` and `skill.prompt` only listen and pass every event on unchanged with `next(e)`. It hooks no `command.run`: `/budget` and `/route` are markdown commands in `commands/` that call the plugin's own two tools, `budget` and `route`, and print what they return. What it does decide is the model and effort of each turn (`turn.step`), which is its stated purpose; `/route <model>` pins one, and the usage caps apply on top of a pin. Past the budget it shows notices and stays at the second cap; it does not stop you.

**Reads of local data are only those listed above.** It has no code that reads a credential, token, key file or environment variable.

**Tools it stands in for:** only `mcp__budget-router__budget` and `mcp__budget-router__route`. They exist only because this plugin registers them, and the plugin answers them (instead of passing them on) when, and only when, you have typed `/budget` or `/route` (or the `/budget-router:` forms) in this turn. It stands in for no other tool: every other tool call is returned exactly as `next` gives it back.

**Nothing leaves your machine.** The plugin has no server, makes no network requests, calls no model of its own, runs no programs, fetches no code or instructions, reads no credential, token or environment variable, and has no telemetry. Sharing learner counts happens only if you copy `/budget learn export` into an issue yourself.

The five helper agents (`agents/`) set no permission mode. `disk-auditor`, `log-triage`, `repo-check` and `scout` hold Bash or PowerShell and are read-only because their instructions say so, not because the tool list prevents writing.

## What each hook does

| Hook | What it does |
|---|---|
| `session.start` | Registers the two command tools (`budget`, `route`), loads saved settings, and reads your project folder (hashed). |
| `prompt.context` | Adds one block named `budgetRouter` (fixed guidance text, the same every time) to the end of the context blocks. That is the only change: the settings, instructions, CLAUDE.md, other blocks and tool descriptions it receives are passed on exactly as `next` returns them, and none is read, removed or edited. |
| `prompt.submit` | Reads the typed text to pick the model tier for the turn (rules, then the learner, then pace control, then usage caps) and to note a typed `/budget` or `/route`. Shows a notice about an expired cache. The only change it can make is to add one hint line (a helper agent that fits) to the prompt's hidden context; the typed text itself is passed on unchanged, and the prompt is never dropped, held or rewritten. |
| `turn.step` | Sets model and effort for each request. Subagent requests are only ever lowered when a usage cap applies, never raised. |
| `turn.complete` | Records token counts in the decision log and records how the turn went for the learner. |
| `tool.call` | Passes every tool call through unchanged with `next(e)`, counting failed calls since your last prompt. A second hook, matched to the plugin's own `budget` and `route` tools only, answers them and does not pass them on; it never sees any other tool. |
| `session.measure` | Reads the rate-limit numbers Claude Code reports; raises a toast and a system note when a cap starts to apply. |
| `agent.offer` | Learns which agents are installed (for the notices about installed agents) and passes every offer on unchanged with `next(e)`. |
| `skill.prompt` | Notes which skill was used, so the log can say whether a suggestion was followed. Passes the event on unchanged. |

There is no `command.run`, `agent.spawn`, `config.set`, `agent.register`, `fs.write` or permission hook, and the plugin runs no program. The two commands are `commands/budget.md` and `commands/route.md`; each runs on Haiku with only its own tool allowed, so a command costs one very short turn.

## Example prompts and use cases

1. **Keep a day inside a budget.** Work as usual. At 50% of the day's share `/budget` shows turns capped at Sonnet; `/route why` lists what was chosen and why. Try: "rename this variable everywhere" (runs on a cheap tier) and then "redesign the save system" (runs on Opus).
2. **Avoid a surprise after a break.** Come back after an hour with a large conversation. A notice shows what re-writing the context will cost, so you can `/compact` or start fresh first.
3. **Tame a runaway turn.** When a build fails several times in one turn, the next steps get one more notch of effort, and `/route why` shows the change.

No account, sign-in or test data is needed: install the plugin and use Claude Code.

## Troubleshooting

- **A prompt was refused.** Not by budget-router, which never refuses a prompt. If Claude Code reports a usage limit, that is Anthropic's own limit.
- **The model never changes.** `/route` may be pinned: `/route auto` releases it. In a long conversation a one-step model switch is skipped while the cache is warm.
- **No cache or idle notices.** They need a context of at least `idleMinContext` (60,000 by default) and a pause longer than `cacheWarmMinutes`.
- **Too many notices.** Switch off `catalogHints`, `idleGuard` or `nudgeContext`, or any other feature in `/config`.
- **Start over.** `/budget wipe` deletes everything the plugin stored.
- **Still stuck.** Open an issue: https://github.com/ValhalaStudio/budget-router-kit/issues

## Privacy and support

The full privacy policy, with what is handled, where it goes, how long it is kept and how to delete it, is in [PRIVACY.md](PRIVACY.md). Support is through GitHub issues, and the source here is what runs.

## How it follows the Anthropic Software Directory Policy

| Policy area | What budget-router does |
|---|---|
| Safety and security | It changes only which model and effort a turn uses, and what you are told. It does not weaken Claude's safeguards or sandbox, takes no permission decision, and never refuses a prompt, tool call or subagent. |
| Privacy and data | Collects only what each feature needs (see PRIVACY.md). No conversation history, memory or file reads. No third party receives data. |
| Hidden or fetched instructions | None. All guidance text is in the source, readable, and nothing is fetched from anywhere. |
| Other plugins | It never calls another plugin's tools and never adds text that points the model at them; notices about installed skills go to you. It does not change how subagents start and hides no agents. |
| Documentation and support | This README, PRIVACY.md and the issue tracker. Three working examples are above. |
| Unsupported use cases | It does not move money, generate images, video or audio, or serve advertisements. The dollar figures it shows are estimates of usage cost, not transactions. |

## License

GPL-3.0-or-later. Copyright (C) 2026 ValhalaStudio. See [LICENSE](LICENSE).
