# Notes for the directory review (0.11.0)

budget-router is a mod: a hooks module (`plugins/budget-router/hooks/register.ts`) that sets the model and effort of each request from a daily share of the subscription's weekly limit. A mod is what makes this possible; no other plugin surface can change the model per request. 0.11.0 is a rewrite down to that core. Earlier submissions (0.4.9 to 0.10.8) and the answers to their notes are in the git history of this file.

## What 0.11.0 removed

| Removed | Why it was there | Effect on review |
|---|---|---|
| `/budget` and `/route` commands, the two registered tools that backed them, and the `tool.call` hook that answered those tools | Showing numbers and pinning a route | No tool is registered and no hook stands in for a tool. The numbers are in the status bar; pinning is the `pin` option. |
| The guidance block (`prompt.context`) | Told the model about routing and the helper agents | No hook touches settings, instructions or tool descriptions. |
| Helper hints (a hidden line on matching prompts) and notices about installed skills (`agent.offer`, `skill.prompt`, `$.command.list`) | Pointing at cheap helper agents | `prompt.submit` passes the prompt on unchanged; the mod reads no list of installed commands or agents. |
| The decision log | Fed `/route why` | Less stored data; old logs are deleted at start. |
| Opt-in sharing of learner counts (export, invitation, issue template, merge script, shipped prior) | Improving the learner's starting point | Nothing in the plugin is about sending data. |
| Author's study scripts inside the plugin folder (0.10.8 already moved them) | Offline analysis | The plugin folder holds no script. |

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

## Checked

`claude plugin validate` passes, `claude plugin test` passes, `node --test checks/compliance.test.mjs` passes. Submission setting: "This plugin collects or transmits user data" = No.
