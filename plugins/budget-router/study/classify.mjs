// Runs the plugin's own kindOf and followUp over a batch, so the study and the plugin cannot drift.
// stdin: {"texts": [...], "pairs": [[prev, next, gapMs], ...]}  stdout: {"kinds": [...], "follows": [...]}
import { kindOf, followUp } from '../hooks/smart.ts'
import { REDO_RE } from '../hooks/policy.ts'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
const { texts, pairs } = JSON.parse(raw)
process.stdout.write(JSON.stringify({
  kinds: texts.map(kindOf),
  follows: pairs.map(([a, b, gap]) => followUp(a, b, gap, REDO_RE)),
}))
