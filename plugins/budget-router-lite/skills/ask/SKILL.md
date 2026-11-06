---
name: ask
description: Ask a self-contained side question in a fresh context on Haiku, so it does not re-read your whole conversation.
argument-hint: "[question]"
disable-model-invocation: true
context: fork
model: haiku
effort: low
---
Answer this question briefly and directly. You have no access to the earlier conversation, so if the question depends on it, say what is missing instead of guessing.

Question: $ARGUMENTS
