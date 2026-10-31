---
description: Pin the model/effort tier for this session, or auto (/route why shows recent decisions)
argument-hint: "[why|auto|trivial|light|standard|deep|max|haiku|sonnet|opus] [low|medium|high|xhigh|max]"
model: haiku
allowed-tools: mcp__budget-router__route
disable-model-invocation: true
---

Call the `mcp__budget-router__route` tool once, with its `args` input set to exactly this text (empty if nothing follows): `$ARGUMENTS`

The plugin shows the person the tool's text itself, word for word, as lines in the transcript. Your whole reply must be the single word `Done.` Do not repeat, summarise or reword the tool's text, and do not call any other tool.
