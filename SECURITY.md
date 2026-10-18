# Security policy

## Supported versions

Only the latest release of budget-router receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use **Security → Report a vulnerability** on this repository to send a private report, and include:

- what you found and which version,
- steps to reproduce,
- the impact you expect.

You will get a reply as soon as the maintainer can read it, and a fix or a decision on whether it is in scope after that. Please allow time to fix the problem before you disclose it.

## Scope

budget-router runs as a Claude Code plugin on your machine. It stores its data locally and sends nothing to a server; see [PRIVACY.md](plugins/budget-router/PRIVACY.md). Reports about the stored ledger, the runbook memory, the `/budget vet` scanner, or any way the plugin could change what Claude is allowed to do are all in scope.