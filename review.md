# Notes for the directory review (0.11.0)

budget-router is a mod: a hooks module (`plugins/budget-router/hooks/register.ts`) that sets the model and effort of each request from a daily share of the subscription's weekly limit. A mod is what makes this possible; no other plugin surface can change the model per request. 0.11.0 is a rewrite down to that core: 5 source files (`register.ts` wiring and state, `ledger.ts` the daily budget, `policy.ts` pure routing helpers, `smart.ts` the learner, `tips.ts` fixed-text tips). `ARCHITECTURE.md` in the plugin folder has the diagrams. Earlier submissions (0.4.9 to 0.10.8) and the answers to their notes are in the git history of this file.

## What 0.11.0 removed

| Removed | Why it was there | Effect on review |
|---|---|---|
| `/budget` and `/route` commands, the two registered tools that backed them, and the `tool.call` hook that answered those tools | Showing numbers and pinning a route | No tool is registered and no hook stands in for a tool. The numbers are in the status bar; pinning is the `pin` option. |
| The guidance block (`prompt.context`) | Told the model about routing and the helper agents | No hook touches settings, instructions or tool descriptions. |
| Helper hints (a hidden line on matching prompts) and notices about installed skills (`agent.offer`, `skill.prompt`, `$.command.list`) | Pointing at cheap helper agents | `prompt.submit` passes the prompt on unchanged; the mod reads no list of installed commands or agents. |
| The decision log | Fed `/route why` | Less stored data; old logs are deleted at start. |
| Opt-in sharing of learner counts (export, invitation, issue template, merge script, shipped prior) | Improving the learner's starting point | Nothing in the plugin is about sending data. |
| Author's study scripts inside the plugin folder (0.10.8 already moved them) | Offline analysis | The plugin folder holds no script. |
| A second, older learner (`learnMode: classic`) and the burn-rate forecast notice | Superseded by the cost-aware learner and the pace controller | One learner, less code; their stored data is deleted on load. |
| 18 expert options (model ids, price table, learner tuning, escalation and pace thresholds, cache and idle thresholds) | Tuning | Fixed named constants at the top of `register.ts`; 18 options remain. |

## Tips

`hooks/tips.ts` holds seven fixed texts and the rules for when one applies. A tip is a toast to the person: it is never appended to the conversation or the prompt, uses only signals already in memory for the current prompt (its text and kind label, the previous turn's size and failure count, the cap level), stores nothing, shows at most one per 10 minutes and each once per session, and is switched off by the `tips` option. `CHEATSHEET.md` gives each habit with its source in Claude Code's documentation.

## Model ids

`turn.step` only moves a request to a model id the mod can justify: an id this session has already run for that family, or the same generation of the model in use when its id is a plain `claude-<family>-<version>`. A dated, provider-specific or unrecognised id is left alone, so a company with restricted models is never sent to a model it may not have. Covered by tests in `policy.test.ts` ("model ids on restricted deployments").

## Outside the plugin

`study/` (repository root, not in the plugin folder the directory fetches) holds offline scripts for the author's own analysis, including `report.py`, which turns local transcripts and the plugin store into an HTML report. The plugin never runs them and nothing in them is sent anywhere.

## The six hooks

| Hook | Changes |
|---|---|
| `session.start` | nothing (`next(e)`) |
| `session.measure` | nothing (`next(e)`); updates the status bar, shows a notice and appends one system note when a cap starts |
| `prompt.submit` | nothing (`next(e)`); reads the prompt in memory to choose the route |
| `turn.step` | `model` and `effort` of the request; subagents only lowered under a cap |
| `tool.call` | nothing; returns what `next` gives back (counts failures) |
| `turn.complete` | nothing; returns what `next` gives back (records the outcome) |

Engine calls: `$.store`, `$.ui.status`, `$.ui.toast`, `$.session.usage`, `$.session.cwd` (hashed), `$.session.append` (the cap note). No `$.fs`, `$.http`, `$.process`, `$.model`, `$.mcp`, `$.tool`, `$.command`, `$.agent`, `$.config`, `$.env` or `$.session.authorize`. `checks/compliance.test.mjs` enforces this list.

## Notes we expect, answered

- **"This plugin includes a mod."** Yes; see above. The README section "What each hook does" says what every hook reads and changes.
- **"Uses a credential from the user's machine" (`plugin.json`).** The plugin reads no credential, token, key file or environment variable, and sends nothing, so there is no credential-to-sender path. No option is `sensitive` and none holds a secret. If this note still appears, we would be grateful to learn what triggers it.
- **"Say in the README what the hook does / changes."** The table in the plugin README, column "What it changes".
- **Icon passed without a code check.** It is a PNG image.

## Software Directory Policy and Terms

| Item | How budget-router meets it |
|---|---|
| 1A Usage Policy; Consumer Terms on automation and limits | Runs only inside the user's own Claude Code session and only on turns the user starts; makes no requests of its own; never bypasses, resets or pools a usage limit. It keeps use below the limit. |
| 1C safeguards and system instructions | Sets model and effort only. Adds nothing to prompts or the system prompt; the one appended system note states that a usage cap applies, shown to the user too. |
| 1E/1G data, conversation content, profiles | Prompt text is read in memory to choose the route and never stored. Stored: budget ledger, pace-controller state, and learner counts keyed by a fixed kind label and a hash of the project folder; learner weights use prompt shape only (length, code, file name, context size, previous turn size). Version 1 weights, which also used hashed words, are dropped on load. |
| 2B descriptions match functionality | `scout` and `log-triage` have no shell. `disk-auditor`, `repo-check` and `reviewer` say they use the shell and are instructed not to change anything. |
| 2F/2G no fetched or hidden instructions | Nothing is fetched; source is plain TypeScript; no encoded text. |
| 3A privacy policy | `plugins/budget-router/PRIVACY.md` (use as the listing's privacy policy link). |
| 3B-3E support, docs, testing, examples | GitHub issues; README with troubleshooting; no account or test data needed; three examples. |
| Terms: security reports | `SECURITY.md`, private vulnerability reporting enabled on the repository. |
| Naming | Product name `budget-router`; README states it is a community plugin, not made or endorsed by Anthropic. |

## Checked

`claude plugin validate` passes, `claude plugin test` passes, `node --test checks/compliance.test.mjs` passes, and `node checks/directory-replica.mjs` (a local stand-in for the pipeline, calibrated against the findings this plugin received in earlier rounds) predicts one hold, `MOD_PRESENT`, and one note on `prompt.submit`. Submission setting: "This plugin collects or transmits user data" = No.
