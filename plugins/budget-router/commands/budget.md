---
description: Show today's Claude usage budget and route (also: learn [reset|export], skills, vet <path>, reset, wipe)
argument-hint: "[reset|skills|vet <path>|learn [reset|export]|wipe]"
model: haiku
allowed-tools: mcp__budget-router__budget
disable-model-invocation: true
---

Call the `mcp__budget-router__budget` tool once, with its `args` input set to exactly this text (empty if nothing follows): `$ARGUMENTS`

The plugin shows the person the tool's text itself, word for word, as lines in the transcript. Your whole reply must be the single word `Done.` Do not repeat, summarise or reword the tool's text, and do not call any other tool.
