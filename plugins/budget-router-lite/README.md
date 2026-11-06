# Budget Router Lite

**Make your Claude limit last.** A community plugin for Claude Code (not made or endorsed by Anthropic) that turns the habits that save the most usage into one-line commands. It is plain markdown: no code runs, nothing is sent anywhere, nothing is stored.

## Why

Most of a session's usage is not your new words. It is the whole conversation being re-sent with every request. So the biggest savings come from keeping conversations small and from not carrying a long history into small questions. These commands do that.

## Commands

| Command | What it does | When it saves |
|---|---|---|
| `/budget-router-lite:ask <question>` | Answers a self-contained question in a **fresh context** on Haiku, low effort. It does not see your conversation. | Any quick lookup: it never re-reads a long history |
| `/budget-router-lite:quick <task>` | Runs this one prompt on Haiku, low effort, then your usual model returns | Small, fully specified tasks on a small or fresh conversation |
| `/budget-router-lite:deep <problem>` | Runs this one prompt on Opus, extra-high effort, then your usual model returns | Hard design or debugging, where you want the strongest setting once |
| `/budget-router-lite:handoff [file]` | Writes a short handoff file (goal, state, decisions, next steps, files) so you can `/clear` and continue | Before clearing a long conversation |
| `/budget-router-lite:pace <percent used> <days left>` | Today's allowance and a suggested tier from your weekly usage | Planning your week; `/usage` shows the numbers |
| `/budget-router-lite:tips` | Answers "how do I use fewer tokens?" from the [cheatsheet](CHEATSHEET.md), each habit with its command | Anytime; it also loads when you ask in plain words |

`:quick` and `:deep` change the model for the current prompt only; your next prompt returns to your session model. The prompt cache is kept per model, so switching in the middle of a big conversation can cost more than it saves: use them on small or fresh conversations, and use `:ask` for side questions on big ones.

## Helper agents

Five small subagents on cheap models, offered to Claude by their own descriptions: `scout` (wide searches) and `log-triage` (cut a build or test log to its errors) have no shell, only Read, Grep and Glob. `disk-auditor`, `repo-check` and `reviewer` use the shell to measure or run git, and their instructions forbid changing anything; the tool list does not enforce that, so keep Claude's tool approvals on. They run in their own context and return a short summary, so long reads stay out of your main conversation.

## What it runs, reads, sends, writes and stores

- **Sends: nothing.** There is no code, no network request and no server.
- **Runs: no programs.** There are no hooks, no scripts, no options and no tools. Everything is a skill or agent definition, which you can read in `skills/` and `agents/`.
- **Reads:** nothing on its own. A command works on what you type; `:tips` reads the cheatsheet bundled in this plugin; `:handoff` and the helper agents act through Claude's normal tools and ask permission as usual.
- **Writes:** only the handoff file you ask for, through Claude's file tool, asking before it overwrites one.
- **Stores:** nothing. **No telemetry.**

## Install

```
claude plugin marketplace add ValhalaStudio/budget-router-kit
claude plugin install budget-router-lite@budget-router-kit
```

Needs a recent Claude Code (skills with `model` and `effort` settings). No account, sign-in or test data is needed.

## Example prompts

1. **Ask without the history.** In the middle of a long session: `/budget-router-lite:ask what does the --max-turns flag do?` It answers from a fresh context, so it does not re-read your conversation.
2. **Clear without losing the thread.** `/budget-router-lite:handoff`, then `/clear`, then start with `@HANDOFF.md`.
3. **Plan your week.** `/budget-router-lite:pace 61 3` (61% used, 3 days left) gives today's share and a tier to use.

## Troubleshooting

- **The command is not found.** Type `/budget-router-lite:` and pick from the list. A session open before you installed needs a restart (or `/reload-plugins`).
- **`:quick` or `:deep` did not change the model.** Your organization may restrict models, or an effort setting in your environment may override it. The change lasts one prompt.
- **`:pace` asks for numbers.** Give the percent used and the days until reset, for example `61 3`. `/usage` shows both.
- **Still stuck.** Open an issue: https://github.com/ValhalaStudio/budget-router-kit/issues

## More

The full router, which picks the model and effort for every prompt automatically, keeps a daily budget and shows a status bar, is a separate plugin in the same repository (`budget-router`). It is a hooks module, so it installs from this marketplace and not from the directory. See the repository README.

## Privacy and support

[PRIVACY.md](PRIVACY.md). Support is through GitHub issues, and the files here are all there is to the plugin.

## License

GPL-3.0-or-later. Copyright (C) 2026 ValhalaStudio. See [LICENSE](LICENSE).
