# budget-router

A community plugin for Claude Code (not made or endorsed by Anthropic). Picks the model and effort for every turn, guards a daily usage budget, and learns what is enough for your kind of work.

| Prompt looks like | Runs on |
|---|---|
| chit-chat, quick fact, one obvious command | Haiku · low |
| small, fully specified edit or lookup | Sonnet · low |
| normal coding, debugging, config work | Sonnet · high |
| design, hard bugs, refactors, security, research | Opus · high |
| "think hard" / "ultrathink" | Opus · xhigh |

Keyword rules label each prompt, and nothing is sent anywhere. On long conversations it avoids small model switches, because a switch re-caches the whole context.

**Daily budget.** Claude subscriptions only have a 5-hour and a weekly limit, so the daily budget is what is left of the weekly limit, split evenly over the days until it resets. A quiet day leaves more for the next ones.

- 50% of today's budget: notice, turns capped at Sonnet · high
- 80%: notice, turns capped at Haiku · medium (the 5-hour window also triggers these caps)
- 90%: one wrap-up heads-up (`wrapUpPercent`, 0 turns it off)
- 100%: turns stay at the second cap. budget-router never refuses a prompt, a tool call or a subagent; it only chooses the model and effort and tells you where you stand

The status bar under the prompt shows the route, the day / 5-hour / week percentages and what the learner has saved. It covers Claude Code only, not claude.ai chat in the browser or desktop app.

The plugin itself is small on purpose: one hooks module with six hooks, no commands, no registered tools, nothing added to your prompts, no file or network access. [plugins/budget-router/README.md](plugins/budget-router/README.md) lists every hook and exactly what it reads and changes, and [ARCHITECTURE.md](plugins/budget-router/ARCHITECTURE.md) has the architecture, class, sequence and decision diagrams.

**Using Claude with fewer tokens:** [plugins/budget-router/CHEATSHEET.md](plugins/budget-router/CHEATSHEET.md) collects the habits that matter (clear and compact, subagents, skills, scripts outside Claude, keeping CLAUDE.md small), each checked against Claude Code's documentation. The plugin shows the relevant one as a notice when the situation comes up.

## Requirements

Claude Code 2.1.287 or newer, signed in with a Claude subscription (Pro/Max). On an API key there are no rate-limit readings: routing still works, the budget does not.

## Install

Run these two commands in a terminal (not inside a Claude session):

```
claude plugin marketplace add ValhalaStudio/budget-router-kit
claude plugin install budget-router@budget-router-kit
```

From a downloaded copy instead, pass the folder path to the first command: `claude plugin marketplace add "C:\path\to\budget-router-kit"`.

Then start a new session with plain `claude`. No flags or settings are needed. After the first reply the status bar under the prompt shows the route and today's budget. A Claude session that was already open when you installed needs a restart (or `/reload-plugins`).

## Settings

Everything is a plugin option in `/config`: the tier mapping, the two caps and their thresholds, the wrap-up point, pace control, the cache and idle notices, the tips, the learner mode, and `pin`, which fixes the route to a tier (`light`, `deep`, ...) or a model with an optional effort (`haiku`, `sonnet:low`, `opus:high`); `auto` routes every prompt. Caps still apply on top of a pin.

## How it differs from other tools

Written from the projects' public READMEs on 2026-10-18; corrections welcome as issues.

| Kind of tool | Examples | What they do | What budget-router adds |
|---|---|---|---|
| Usage gauges and status lines | claude-hud, ccusage, ccstatusline | Show how much you have used | Acts on it: picks the model and effort per turn and enforces a daily share of the weekly limit |
| Pacing hooks | claude-pacer | Status line plus a wrap-up warning near the limit | Routes and caps turns as the day fills, and learns which model and effort is enough for your work |
| Recommenders | FlintRelay | Suggests a model, with a shadow mode | Applies the choice (and has its own `shadow` mode for the learner) |
| Routers with a proof ledger | nobodyohm router | Routes and reports statistics | Ties routing to the real subscription limit; the learner weighs cost against a failure risk that grows as the budget shrinks |
| Proxies | ccrouter | Sit in front of the API and route requests | Runs as a plugin inside Claude Code, no proxy or API key; stores no prompt text |

What no other tool I found does: treat the weekly limit as a daily budget, and let that budget decide how cautious the model choice is.

Limits to know about: it only guards Claude Code (not claude.ai chat), and the daily budget needs a subscription's rate-limit readings.

## Tested with

| Component | Version |
|---|---|
| Claude Code | 2.1.302 (minimum supported 2.1.287) |
| budget-router | 0.11.0 |
| OS | Windows 11 |
| Plan | Claude subscription with 5-hour and weekly limits |
| Test suite | `claude plugin test` and `claude plugin validate` in `plugins/budget-router`, plus `node --test checks/compliance.test.mjs` |

Not tested by the author: macOS and Linux, API-key sessions, and plans that report per-model weekly limits (handled in code and unit-tested, never seen live). Reports of other setups are welcome.

## Your own analysis (optional, offline)

`study/` (not part of the plugin, never run by it) holds scripts for looking at your own usage: `extract.py` turns your local Claude Code transcripts into one row per prompt (no prompt text kept), and `describe.py` and `predict_size.py` read those rows. They are pure Python and run entirely offline.

## Update

```
claude plugin marketplace update budget-router-kit
claude plugin update budget-router@budget-router-kit
```

## Subagents

budget-router does not change how subagents start and hides no agents. While a usage cap applies, a subagent's requests are lowered to the same cap as the main turn, never raised.

## Helper agents

On cheap models, with short descriptions (about 60 tokens each in every session). `scout` and `log-triage` have no shell; the other three use the shell to measure or run git and are instructed never to change anything. Claude Code offers them to the model by their own descriptions:

| Agent | Model | For |
|---|---|---|
| `budget-router:scout` | Haiku | broad searches across many files |
| `budget-router:log-triage` | Haiku | cutting a long build, cook, UAT or test log down to its errors |
| `budget-router:disk-auditor` | Haiku | folder sizes, what fills a drive (measures, never deletes) |
| `budget-router:repo-check` | Haiku | git state before a cleanup or move: unpushed work, worktrees, LFS |
| `budget-router:reviewer` | Sonnet | a diff or branch reviewed for real bugs |

## Remove

```
claude plugin uninstall budget-router@budget-router-kit
claude plugin marketplace remove budget-router-kit
```

To also delete what it stored, remove its file in `~/.claude/plugins/store/` (the name starts with `budget-router_`).

## License

GPL-3.0-or-later. Copyright (C) 2026 ValhalaStudio. See [LICENSE](LICENSE).
