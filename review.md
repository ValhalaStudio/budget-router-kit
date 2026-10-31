# Directory review: what was addressed in 0.10.5

Reply to the plugin directory's validation and policy review of `budget-router`. Every note from the review is listed in order with what was done. Code references are to `plugins/budget-router/`. The build was checked with `claude plugin validate` (passes) and `claude plugin test` (104 tests, all pass), and the commands were run once end to end in a headless session.

## Validation (passed with 4 notes)

| # | Note | Status | What was done |
|---|---|---|---|
| 1 | "Nothing to change: the directory records that the mod adds tools, commands or agents." | Informational | Nothing to change. The plugin adds three tools (`budget`, `route`, `runbook`), three markdown commands and five agents; all are named in the README. |
| 2 | "Say in the plugin's README what the hook changes." | Addressed | README, section "What each hook does", lists every hook and what it changes. The only things the plugin changes are the model and effort of each turn (`turn.step`) and one added guidance block (`prompt.context`). 0.10.5 updates the table for the new tool-answering hook. |
| 3 | "Say in the plugin's README what the hook does." | Addressed | Same table; section "What this mod can decide for you, and what it can send out" states that it takes no permission decision and never refuses, holds, drops or rewrites a prompt, tool call or subagent. |
| 4 | "1 well-formed image or font file was let through … `.claude-plugin/icon.png`." | Informational | Nothing to change. The file is an image; it contains no code. |

## Directory policy (held)

| # | Note | Status | What was done |
|---|---|---|---|
| 5 | "Say in the plugin's README what the mod sends and where; if the way out is a call the directory does not know, say what that call does." (two notes) | Addressed by removal | The only way out was the optional Haiku classifier (`$.model.complete`, off by default). **It is removed in 0.10.5**, together with the `classifier` option. The plugin now has no model call, no `http` call and no network request. README section "What it runs, reads, sends, writes and stores" and `PRIVACY.md` say so, and no longer describe a send. |
| 6 | "If the mod needs to run programs, say in the plugin's README which programs and why." | Addressed by removal | The plugin ran `date`, `pwd` and `powershell` (time zone offset and project folder). **All `process.run` calls are removed in 0.10.5.** The time zone offset comes from the engine's clock, and the project folder from `$.session.cwd()`. README: "Runs: no programs." |
| 7 | "Run the one program the mod needs, by name, with fixed arguments; use the http call for requests." | Addressed by removal | The plugin needs no program, so there is nothing to run. The plugin makes no requests, so there is no `http` call. |
| 8 | "In a permission hook, pass the check on unchanged with `return next(e)`. … In a hook on config.set, agent.register, agent.spawn, command.run or fs.write, pass the event on unchanged." | Addressed | There was one such hook family: three `command.run` hooks that answered `/budget`, `/route` and `/runbook` themselves. **They are removed in 0.10.5.** The three commands are now markdown files in `commands/` that call the plugin's own tools, so the plugin hooks no `command.run`, and no `$.command.register` call remains. There is no permission, `config.set`, `agent.register`, `agent.spawn` or `fs.write` hook, and the plugin does not touch the permission mode or Remote Control. Its other hooks (`tool.call`, `agent.offer`, `skill.prompt`) pass every event on unchanged with `next(e)`. The one added `tool.call` hook answers only calls to the plugin's own three command tools. |
| 9 | "If the part that reads the credential and the part that sends data are related, pass a `${user_config.KEY}` value … or remove every part that reads a credential, which clears this hold." | Addressed | The plugin has no code that reads a credential, token, key file or environment variable (README states it). The only sender, the classifier, is removed (note 5), so there is no pair left to relate. |
| 10 | "If you expected the field to do something, check its spelling against the plugins reference." | Addressed by removal | `plugin.json` carried four fields no other plugin uses: `displayName`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`. **All four are removed in 0.10.5**; the same links are in the READMEs. |
| 11 | "Where the plugin runs this, ship the script inside the plugin and run that file instead. Where it only appears in documentation, nothing needs to change." | No change needed | The plugin runs no script and no program (note 6). Scripts such as `study/aggregate.py` appear only in documentation and are run by the person, never by the plugin. |
| 12 | "The plugin ships hooks … Listed for information only." | Informational | Nothing to do. |

## Also fixed while checking

- The guidance block the plugin adds to a conversation still said it "refuses prompts at 100%". It never does since 0.10.4; the text now says it never refuses a prompt.
- The marketplace entry and a config description still mentioned a "lock"; reworded.
- The README test count was stale (109); it is 104.

## Self-audit before resubmission

- **Secrets:** the secret scanner found nothing in the 40 files. The one `sk-ant` string in the history is a dummy value in a test of the "looks like a key" refusal.
- **Personal data:** a real Windows user name appeared in two test fixtures; replaced with a placeholder. `study/turns.jsonl` (derived from the author's own transcripts) is git-ignored and not in the repository.
- **Prompt injection through the new command tools:** because the three tools are visible to the model, text in a file or web page could have told it to call `budget wipe` or `budget vet <path>`. The tools now answer only when the person typed the matching command (`prompt.submit` arms it with the typed arguments, once); a call the model makes on its own is refused with a message, and the model's own `args` are ignored. A test covers it, and it was confirmed live: a typed `/budget-router:route why` runs, and a model-initiated `budget reset` does nothing.
- **Agents:** the five helper agents set no `permissionMode`; they are read-only by their instructions, but `disk-auditor`, `log-triage`, `repo-check` and `scout` hold Bash/PowerShell, so that restriction is the prompt's, not the tool list's. Disclosed in the README.
- **Not checked:** the directory's own safety scan and policy engine, which only run on submission.

## What changes for people using it

- The commands are typed with the plugin prefix: `/budget-router:budget`, `/budget-router:route`, `/budget-router:runbook`. Each costs one very short Haiku turn, because a markdown command is a prompt. The exact text is shown as transcript lines, and the model replies "Done."
- The optional Haiku classifier is gone; prompts are labelled by keyword rules only (the default before).
- The time zone offset no longer falls back to `date`/`powershell`; if the engine reports UTC, days follow UTC.
