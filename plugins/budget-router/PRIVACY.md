# budget-router privacy policy

budget-router is a Claude Code plugin that runs on your computer. It has no server, no account, no analytics and no telemetry, and it makes no network requests of its own. This page says what it handles, where that goes, how long it is kept and how to delete it.

Contact: open an issue at https://github.com/ValhalaStudio/budget-router-kit/issues

## What it handles, and why

| Data | Why | Where it goes |
|---|---|---|
| The first 2,000 characters of each prompt | To label the task (trivial, light, standard, deep) | To Claude Haiku, through Claude Code's own model call on your account. Nothing else receives it. Set the `classifier` option to `heuristic` and nothing is sent. |
| Rate-limit percentages and context size that Claude Code reports | To keep you inside a daily budget and warn about expiring caches | Stays in memory and in the local store |
| Each shell command (Bash or PowerShell) as it runs | To notice commands you repeat (runbook memory) | Counted in the local store. Up to 150 repeated commands are kept, with the text of the latest run of each. Turn it off with the `runbooks` option. |
| Whether each tool call failed | To raise effort when a turn goes badly and to learn which model step worked | A counter in memory; the learner keeps only success and failure counts, token costs and hashed weights per kind of work, never prompt text. A short follow-up phrase (such as "try again" or "thanks") is compared in memory with your last prompt and then dropped |
| The first 300 characters of a prompt and 600 of the reply | Only if you turn on `reflect` (off by default): to ask Haiku whether an unclear turn succeeded | To Claude Haiku through your own account, a few times a day at most |
| The name of the folder Claude Code is working in, read once per session by running `pwd` (or `(Get-Location).Path` on Windows) | To keep the learner's record separate per project | Only a short hash of it is kept; the folder name itself is not stored or shared |
| The HOME or USERPROFILE environment variable | To find the folder for saved runbook scripts | Read only; not stored |

It does not read your conversation history, memory, summaries or uploaded files. It does not read credentials, tokens or key files. It does not send data to any other person, service or advertiser, and it contains no advertising.

## What it stores on your computer

In the plugin's own store: the usage ledger, model ids seen, burn-rate samples, a decision log (up to 200 rows of tier, reason, model and token counts, with no prompt text), pace-controller state, counts and token costs for the learner (per kind of work and per project; the project is a short hash of the folder path, never the path), a table of hashed word weights that lets it generalise (256 numbers; the words themselves are not kept and cannot be recovered from them), and the repeated-command counts and runbook list described above.

It writes a file outside the store only when you run `/runbook save`: one script in the runbook folder (default `.claude/runbooks` in your home folder). Commands that look like they hold a key, a login or another private value are refused.

## How long it is kept

- The usage ledger and pace samples roll over each day.
- The decision log keeps the latest 200 rows.
- Repeated-command counts keep the latest 150 commands.
- Learner counts stay until you delete them.
- Saved scripts stay until you delete the files.

## Sharing counts (optional, only if you choose)

`/budget learn export` prints a summary you can read: turns, successes and cost per model/effort pair and per kind of prompt. It holds no prompt text, folder or project names, dates or feature weights. The plugin never sends it anywhere; if you paste it into a public issue, it is public. After about 60 learned turns it shows one notice, once, saying this exists; the `inviteContribution` option turns the notice off.

## Deleting it

- `/budget wipe` deletes everything above that the plugin stored. Scripts you saved are left in place; delete those files yourself.
- `/runbook forget <name>` removes one runbook from the list.
- Uninstalling the plugin stops all collection.
- `logDecisions`, `runbooks`, `learn` and `reflect` each switch one kind of data off.

## Children

The plugin is a developer tool and is not intended for people under 18.

## Changes

Changes to this policy are made in this file and shown in the repository history.
