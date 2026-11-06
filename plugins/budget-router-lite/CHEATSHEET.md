# Using Claude Code with fewer tokens: a cheatsheet

Checked against Claude Code's own documentation on 2026-11-02 (sources at the end). Documentation changes: where a command or setting matters, confirm it with `/help` or the docs. Items marked *reasoning* follow from how Claude Code works but are not a figure the docs state.

## Start here

1. Read **The one idea** below (one minute).
2. Pick two habits from **Habits** and try them for a week: `/clear` between tasks, and `/compact` before a context gets huge.
3. Check `/usage` once a day, and `/context` when a session feels slow, to see what is using the space.

## The one idea

**Claude Code sends your whole conversation with every request.** The prompt cache makes re-reading cheaper, not free: it lasts about an hour on a subscription (five minutes on an API key, a cloud provider or usage credits). So the cost of a session is mostly *how big the conversation is* times *how many requests you make*. Everything below either shrinks the conversation, cuts the number of requests, or picks a cheaper model and effort.

"Ghost tokens" are the ones you never typed: the old history re-read on every request, and the whole context re-written from scratch when the cache has expired after a pause. budget-router warns about both (the idle notice and the large-context notice).

## Habits (what you do)

| Do this | Why | How |
|---|---|---|
| Clear between unrelated tasks | An old task's history is re-read on every request of the next one | `/clear` (free). `/rename` first if you want to find the session later, then `/resume` |
| Compact before the context is huge | Compacting reads the whole conversation, so doing it late is itself a large request | `/compact keep the API changes and the test commands` (a focus helps) |
| Go back instead of arguing | A wrong turn stays in the context unless you rewind | `/rewind`, or Esc twice on an empty prompt |
| Look at what is using the space | You cannot trim what you cannot see | `/context` for the breakdown, `/usage` for plan usage (it also suggests changes for habits behind 10% or more of your usage) |
| Plan before a big change | A wrong direction costs a whole redo | Shift+Tab to cycle to plan mode |
| Name the target | Vague asks trigger broad scanning | `@path/to/file` instead of "improve this codebase" |
| Pick the model and effort for the job | Most coding does not need the dearest setting | `/model` (Sonnet handles most coding tasks), `/effort low` for simple work, `ultrathink` in one prompt instead of raising the setting for the session. Thinking is billed as output tokens, and on the 5.5 models thinking cannot be turned off: effort is the lever |
| Do not leave schedules running | Idle sessions can still spend: recaps, idle compaction, a scheduled task that fires on its interval | Stop or end sessions you are not using |

## Keep always-loaded text small

Everything below is read in *every* session whether you use it or not.

- **CLAUDE.md:** aim for under 200 lines. Block-level HTML comments (`<!-- ... -->`) are stripped before it reaches Claude, so notes to yourself are free. `@path` imports organise a long file but do not reduce its cost. Path-scoped rules (a `paths:` frontmatter) load only when Claude works on matching files. `/doctor` suggests cuts for what Claude can work out from the code.
- **Move procedures into skills.** A skill's body loads only when it is used; its short description is all that is always present. A skill you only want to run by hand can add `disable-model-invocation: true`, so Claude does not invoke it on its own.
- **Keep descriptions short.** Skill and agent descriptions are read every session (this plugin's five helper agents cost about 60 tokens each).
- **MCP servers:** their tool names and instructions are in context even when you are not using them. Tool definitions are deferred by default, but `/mcp` lets you disable servers you are not using, and a plain CLI adds no per-tool listing at all.
- **Deny what Claude should never read** with permission `deny` rules, for example `Read(./.env)` or `Read(./secrets/**)`. They hold in every permission mode.

## Skills and agents (create them for repeated work)

**Create a skill** when you keep explaining the same procedure ("how we release", "how we name assets"). It costs a short description every session and its body only when used, where the same text in CLAUDE.md would cost every request.

**Create a subagent** for work that reads a lot and concludes briefly: searching many files, triaging a long log, reviewing a diff. A subagent runs in its own context window and returns only its summary, so the reading never enters your main conversation.

- Subagents still count toward the same usage limits as your main chat. They save *main-context bloat*, not usage by themselves.
- Give each only the tools it needs (a search agent: `tools: Read, Grep, Glob`), and `model: haiku` for simple tasks. Ask for short summaries back.
- Skip CLAUDE.md in a helper that does not need it (`omitClaudeMd: true`).
- Agent *teams* are not cheap: the docs cite roughly 7x the tokens of a standard session when teammates run in plan mode.

This plugin ships five helpers: `scout` (wide searches), `log-triage` (cut a build or cook log to its errors), `disk-auditor`, `repo-check` and `reviewer`.

## Scripts outside Claude (create them for repeated deterministic work)

*Reasoning:* a script that does not call Claude costs no tokens, so anything with one right answer should not go through a model.

- **Run it yourself in a terminal:** builds, tests, formatters, linters, `git status`, disk listings. Give Claude only the failing lines.
- **Filter output before it arrives.** The docs describe a hook that runs a test command and returns only matching lines, cutting "tens of thousands of tokens to hundreds". A small script that prints the first error of a build log does the same by hand.
- **Make the deterministic rule a hook or a deny rule** instead of an instruction Claude has to re-read and remember.
- **Scripted Claude (`claude -p "..."`)** is documented for non-interactive work. It still uses your plan's usage. Bound it with `--max-turns` or `--max-budget-usd`, and the JSON result reports `total_cost_usd`. `--bare` skips hooks and skills for a faster start but does not use your subscription login (it needs an API key). Check the current terms before automating on a subscription.

## Real cases

These are the situations that come up most, and what to do.

| The situation | What to do |
|---|---|
| You paste a long log or file | Put it in a file and point Claude at the part that matters (`@path`), or paste only the failing lines. A paste is re-read on every later request |
| A build or cook error with hundreds of lines | Paste the first error with a few lines around it, or have `log-triage` cut the log down |
| Three or more tool calls failed in one turn | Stop retrying. `/rewind` to before it went wrong and re-ask with the exact error |
| The last turn took 30 or more requests | Hand wide searches and log reads to a subagent next time and ask for a short summary |
| "Improve the codebase", "review everything" | Name the file or function and the outcome you want |
| The day's budget is capped | `/clear` between tasks, `/effort low` for simple work, plan with Shift+Tab before big edits |
| You are about to type a command | Run it in your own terminal and paste back only what matters |
| Back after a long break with a big context | The cache has expired and the whole context is re-written: `/compact` or `/clear` first |
| The context passes a large size | Every request re-reads it: `/compact` with a focus, or start fresh |

## Make the habits one command

This plugin turns a few of them into commands: `/budget-router-lite:handoff` before a `/clear`, `/budget-router-lite:pace` for today's allowance, and `/budget-router-lite:quick` or `:deep` to pick a cheaper or stronger model for one prompt.

## What this plugin does, and what stays with you

- **It does:** gives you the commands above, the five helper agents, and this cheatsheet on demand (`/budget-router-lite:tips`).
- **It does not:** change your model on its own, clear or compact for you, edit CLAUDE.md, or change your settings. It has no code, no hooks and no network access, so every habit here is yours to apply.
- **A caution about switching models:** the prompt cache is kept per model. Switching to another model in the middle of a big conversation makes that model read the whole context fresh, which can cost more than it saves. A fresh session or `/clear` avoids this, so use `:quick` and `:deep` on small or fresh conversations.

## Sources

Claude Code documentation (code.claude.com/docs/en/): *costs*, *best-practices*, *memory*, *skills*, *sub-agents*, *model-config*, *mcp*, *headless*. Several long pages were read only in part; anything not stated in them is marked *reasoning* above or left out (for example, there is no `.claudeignore` in the documentation, so it is not recommended here). Enterprise cost figures in the docs are team averages, not subscription figures, and are not quoted.
