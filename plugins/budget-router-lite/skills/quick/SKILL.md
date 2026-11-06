---
name: quick
description: Run this one prompt on Haiku with low effort, then return to your usual model.
argument-hint: "[small, fully specified task]"
disable-model-invocation: true
model: haiku
effort: low
---
Do this small, fully specified task directly and briefly. Do not explore beyond what it needs.

Task: $ARGUMENTS
