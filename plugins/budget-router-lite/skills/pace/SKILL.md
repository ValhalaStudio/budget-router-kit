---
name: pace
description: Turn your weekly usage percentage and days left into today's allowance and a suggested model tier.
argument-hint: "[weekly percent used] [days until reset]"
disable-model-invocation: true
context: fork
model: haiku
effort: low
---
The user gives two numbers: the percent of their weekly usage limit already used, and the days until it resets. Arguments: $ARGUMENTS

If either number is missing or unclear, ask for it and stop. Otherwise compute and answer in at most five lines:
1. Left this week: 100 minus the percent used.
2. Even share per day: left divided by days, one decimal.
3. Today's allowance if they start today: the same figure.
4. Tier to use today: below 50% of the allowance used, Opus for hard work and Sonnet for the rest; from 50% to 80%, Sonnet; above 80%, Haiku and short prompts.
5. One habit to try: /clear between unrelated tasks.

Tell them their usage and reset time are shown by /usage. Do not invent numbers.
