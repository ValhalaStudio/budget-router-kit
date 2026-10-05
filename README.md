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
- `/config`: thresholds, caps, tier mapping and model ids

It also adds a `budget-router:scout` agent (Haiku, read-only) for broad file searches.

## Remove

```
claude plugin uninstall budget-router@budget-router-kit
claude plugin marketplace remove budget-router-kit
```
