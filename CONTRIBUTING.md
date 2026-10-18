# Contributing

Thanks for helping with budget-router. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with the bug template. Please include:

- your Claude Code version and operating system,
- the output of `/budget` and, if routing looks wrong, `/route why`,
- what you expected and what happened.

Do not paste prompts, tokens or private file paths. The decision log keeps no prompt text, but check before you share it.

Security problems go through the private report in the Security tab, not a public issue (see [SECURITY.md](SECURITY.md)).

## Suggesting a change

Open an issue with the feature template first, so we can agree on the idea before you write code.

## Pull requests

1. Fork the repo and branch from `main`.
2. Keep each pull request to one change.
3. Run the tests in `plugins/budget-router/hooks/policy.test.ts` and add one for new routing rules.
4. Update `README.md` if behavior or options change.
5. Fill in the pull request template.

The plugin changes only which model and effort a turn uses, and what the user is told. It must not weaken Claude's safeguards or read the conversation history; changes that do will not be merged.

## License

By contributing you agree that your contribution is released under the repository's license (see `LICENSE`).

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).