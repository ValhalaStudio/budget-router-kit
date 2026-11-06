---
name: handoff
description: Write a short handoff file so you can /clear and continue without re-reading this whole conversation.
argument-hint: "[optional file name]"
disable-model-invocation: true
model: sonnet
effort: low
---
Write a handoff file so a fresh conversation can pick up this work. Use the file name given below, or HANDOFF.md in the current folder if none is given. Ask before overwriting an existing file.

Keep it under 40 lines, with these sections and nothing else:
- Goal: one or two sentences.
- State: what is done and what is half-done.
- Decisions: choices made and why, one line each.
- Next steps: the next three actions, in order.
- Files: the paths that matter, one line each.
- Open questions.

Do not paste code, logs or long output. Then tell the user to run /clear and start the next conversation with an @ mention of the file.

File name: $ARGUMENTS
