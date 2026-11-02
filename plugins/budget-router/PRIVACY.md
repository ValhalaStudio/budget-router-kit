# budget-router privacy policy

budget-router is a Claude Code plugin that runs on your computer. It has no server, no account, no analytics and no telemetry, and it makes no network requests. This page says what it handles, where that goes, how long it is kept and how to delete it.

Contact: open an issue at https://github.com/ValhalaStudio/budget-router-kit/issues

## What it handles, and why

| Data | Why | Where it goes |
|---|---|---|
| Rate-limit percentages, context size and per-turn token counts that Claude Code reports | To keep you inside a daily budget, warn about expiring caches and estimate what a turn cost | In memory and in the local store |
| The text of the prompt you type | To choose the model and effort for the turn, and to notice a quick "try again" or "thanks" after the last turn | In memory only, for the current and the next prompt; never stored and never sent |
| Whether each tool call failed (not what it did) | To raise effort when a turn goes badly and to learn which model step worked | A counter in memory |
| The name of the folder Claude Code is working in | To keep the learner's record separate per project | Hashed at once; only the short hash is kept |

It does not read your conversation history, memory, summaries, files or uploaded files. It does not read credentials, tokens, key files or environment variables. It runs no programs. It does not send data to any person, service or advertiser, and it contains no advertising.

## What it stores on your computer

In the plugin's own store (one file in `~/.claude/plugins/store/` whose name starts with `budget-router_`): the usage ledger, model ids seen, pace-controller state, the learner's counts and token costs per kind of work and per project (the project is the short hash, never the path), and 256 weights over the shape of prompts (length band, whether there is code or a file name, context size, the previous turn's size) that let it generalise. No prompt text and no words of a prompt are stored. The only thing derived from a prompt is one fixed label for its kind (go, question, change, research, paste, shell, chat or ask), chosen by rules in the source.

It writes no files outside the store. Data that older versions kept and this one has no use for (a decision log, burn-rate samples, an older learner's counts and the text of repeated shell commands) is deleted when the plugin starts.

## How long it is kept

- The usage ledger and pace-controller state roll over each day.
- The learner's counts fade over about two weeks and stay until you delete them.

## Deleting it

- Set `learnMode` to `off` in `/config` to stop collecting learner counts.
- Uninstall the plugin to stop all collection.
- To delete what it stored, uninstall or disable the plugin and delete its file in `~/.claude/plugins/store/` (the name starts with `budget-router_`).

## Children

The plugin is a developer tool and is not intended for people under 18.

## Changes

Changes to this policy are made in this file and shown in the repository history.
