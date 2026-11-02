# budget-router privacy policy

budget-router is a Claude Code plugin that runs on your computer. It has no server, no account, no analytics and no telemetry, and it makes no network requests of its own. This page says what it handles, where that goes, how long it is kept and how to delete it.

Contact: open an issue at https://github.com/ValhalaStudio/budget-router-kit/issues

## What it handles, and why

| Data | Why | Where it goes |
|---|---|---|
| Rate-limit percentages and context size that Claude Code reports | To keep you inside a daily budget and warn about expiring caches | Stays in memory and in the local store |
| Whether each tool call failed | To raise effort when a turn goes badly and to learn which model step worked | A counter in memory; the learner keeps only success and failure counts, token costs and hashed weights per kind of work, never prompt text. A short follow-up phrase (such as "try again" or "thanks") is compared in memory with your last prompt and then dropped |
| The name of the folder Claude Code is working in, read once per session from the session's working directory (no program is run) | To keep the learner's record separate per project | Only a short hash of it is kept; the folder name itself is not stored or shared |

It does not read your conversation history, memory, summaries or uploaded files. It does not read credentials, tokens or key files. It does not send data to any other person, service or advertiser, and it contains no advertising.

## What it stores on your computer

In the plugin's own store: the usage ledger, model ids seen, burn-rate samples, a decision log (up to 200 rows of tier, reason, model and token counts, with no prompt text), pace-controller state, counts and token costs for the learner (per kind of work and per project; the project is a short hash of the folder path, never the path), and a table of hashed word weights that lets it generalise (256 numbers; the words themselves are not kept and cannot be recovered from them).

It writes no files outside the store, reads no file and no command you run, and runs no program. Versions up to 0.10.4 kept the text of repeated shell commands (runbook memory); 0.10.5 removes that feature and deletes what it had stored.

## How long it is kept

- The usage ledger and pace samples roll over each day.
- The decision log keeps the latest 200 rows.
- Learner counts stay until you delete them.
- Saved scripts stay until you delete the files.

## Sharing counts (optional, only if you choose)

`/budget learn export` prints a summary you can read: turns, successes and cost per model/effort pair and per kind of prompt. It holds no prompt text, folder or project names, dates or feature weights. The plugin never sends it anywhere; if you paste it into a public issue, it is public. After about 60 learned turns it shows one notice, once, saying this exists; the `inviteContribution` option turns the notice off.

## Deleting it

- `/budget wipe` deletes everything above that the plugin stored. Scripts you saved yourself are untouched; delete those files yourself.
- Uninstalling the plugin stops all collection.
- `logDecisions` and `learn` each switch one kind of data off.

## Children

The plugin is a developer tool and is not intended for people under 18.

## Changes

Changes to this policy are made in this file and shown in the repository history.
