# budget-router for Claude Code

Picks the model and effort for every turn and guards a daily usage budget.

| Prompt looks like | Runs on |
|---|---|
| chit-chat, quick fact, one obvious command | Haiku · low |
| small, fully specified edit or lookup | Sonnet · low |
| normal coding, debugging, config work | Sonnet · high |
| design, hard bugs, refactors, security, research | Opus · high |
| "think hard" / "ultrathink" | Opus · xhigh |

A tiny Haiku call (~0.5 s) labels each prompt. On long conversations it avoids small model switches, because a switch re-caches the whole context.

**Daily budget.** Claude subscriptions only have a 5-hour and a weekly limit, so the daily budget is what is left of the weekly limit, split evenly over the days until it resets. A quiet day leaves more for the next ones.

- 50% of today's budget: alert, turns capped at Sonnet · high
- 80%: alert, turns capped at Haiku · medium (the 5-hour window also triggers these caps)
- 100%: new prompts refused until local midnight

A status line under the prompt shows the route and the day / 5-hour / week percentages. The lock covers Claude Code only, not claude.ai chat in the browser or desktop app.

## Requirements

Claude Code 2.1.286 or newer, signed in with a Claude subscription (Pro/Max). On an API key there are no rate-limit readings: routing still works, the budget does not.

## Install

Run these two commands in a terminal (not inside a Claude session):

```
claude plugin marketplace add ValhalaStudio/budget-router-kit
claude plugin install budget-router@budget-router-kit
```

From a downloaded copy instead, pass the folder path to the first command: `claude plugin marketplace add "C:\path\to\budget-router-kit"`.

Then start a new session with plain `claude`. No flags or settings are needed. Inside it, type `/budget`: it should print today's numbers, and the status line under the prompt shows the route. A Claude session that was already open when you installed needs a restart (or `/reload-plugins`).

## Update

```
claude plugin marketplace update budget-router-kit
claude plugin update budget-router@budget-router-kit
```

## Use

- `/budget`: today's numbers and the current route
- `/budget unlock`: lifts the lock for 1 hour
- `/budget reset`: re-measures today's budget from the next reply
- `/route deep`, `/route opus xhigh`, `/route sonnet`, `/route auto`: pin a tier or model for this session (caps still apply)
- `/route why`: the latest routing decisions, the subagent rules that fired, and today's token use with the share of input served from the prompt cache
- `/config`: thresholds, caps, tier mapping and model ids

## Subagents (new in 0.3)

**Model rules.** When the model starts a subagent and its call names no model, the plugin can pick one by agent type. The default sends `Explore`, `claude-code-guide` and `statusline-setup` to Haiku, which is where read-only searching belongs. Forks, resumed agents, teammates and workflow agents are left alone, and a model named in the call always wins. Change the rules in the `subagentModels` option (JSON, `{}` turns them off). The usage caps still apply to every subagent step on top of this.

**The lock covers subagents.** Once today's budget is spent no new subagent starts (`/budget unlock` lifts it for an hour).

**Hiding agent types.** The `hideAgentsAtCritical` option lists agent types (comma separated) that the model is no longer offered once usage passes the second threshold. Empty by default.

**Decision log.** Routing decisions, subagent rules and per-turn token counts are kept in the plugin store (newest 200 rows, no prompt text, never sent anywhere). `/route why` prints them. Turn it off with `logDecisions`.

## More in 0.4

- **Unreal rules.** A prompt about UBT, UHT, linker (`LNK`), `error C####`, cook or packaging failures never runs on the trivial or light tier, and the model is told, in one hidden line, to let `log-triage` cut a long log down first. budget-router does not change permission prompts: with Epic's Unreal MCP, keep Claude's tool approvals on.
- **Helper-agent hints.** A prompt that fits a helper (a size survey, a pre-delete repo check, a diff review, a wide search) gets one hidden line suggesting it. It is decided by keywords, costs no model call, and `/route why` shows how many hints were given and how many were followed.
- **Cache-aware switching.** The "stay on the same model in a long conversation" rule now lapses once the cache has gone cold (`cacheWarmMinutes`, 55 by default), because switching is then free.
- **Pace forecast.** `/budget` shows the burn rate over the last 90 minutes and when the day's budget would run out at that pace. One toast per day warns when that is within `paceWarnHours`.
- **Soft lock.** `/budget soft` stops the refusals at 100%: turns stay at the second cap instead. `/budget hard` brings the refusals back. For a real limit, add Claude Code's own `autoContinueAtUsageLimit` setting so a session waits for the reset.
- **`/budget skills`** lists what the command and skill list costs (names plus descriptions, in estimated tokens, by plugin) and the longest descriptions.
- **`/budget vet <path>`** reads a skill, agent, command or plugin folder before you install it and flags red flags: hidden instructions, `curl | bash`, broad `allowed-tools`, hooks, encoded blobs, data sent out, hidden unicode. It is advisory only: read everything yourself.

## Helper agents

All read-only, on cheap models, with short descriptions (about 60 tokens each in every session):

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

## License

GPL-3.0-or-later. Copyright (C) 2026 ValhalaStudio. See [LICENSE](LICENSE).
