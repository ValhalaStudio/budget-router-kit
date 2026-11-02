"""Descriptive numbers from turns.jsonl (see extract.py). usage: python -I describe.py [turns.jsonl]"""
import collections
import json
import statistics
import sys

rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else 'turns.jsonl', encoding='utf8')]
tot = sum(r['usd'] for r in rows)
print(f'{len(rows)} turns, ${tot:.0f} at list prices, median ${statistics.median(r["usd"] for r in rows):.2f}/turn\n')

by = collections.defaultdict(list)
for r in rows:
    by[(r['kind'], r['arm'])].append(r)
print('kind x arm (n>=8): n, $/turn, turns with >=2 tool errors, redo/rephrase follow-ups')
for (k, a), v in sorted(by.items(), key=lambda x: -sum(r['usd'] for r in x[1])):
    if len(v) < 8:
        continue
    bad = sum(r['errors'] >= 2 for r in v) / len(v)
    fu = sum(r['follow'] in ('redo', 'rephrase') for r in v) / len(v)
    print(f'  {k:8} {a:34} n={len(v):3} ${sum(r["usd"] for r in v) / len(v):5.2f}  err2+ {bad:4.0%}  redo/rephr {fu:4.0%}')

print('\nfollow-up signals:', dict(collections.Counter(r['follow'] for r in rows)))
print('tool errors per turn (5 = 5+):', dict(sorted(collections.Counter(min(r['errors'], 5) for r in rows).items())))

opus = [r for r in rows if 'opus' in r['arm']]
simple = [r for r in opus if r['prompt_len'] < 200 and r['msgs'] <= 4 and r['errors'] == 0]
ospend = sum(r['usd'] for r in opus)
sspend = sum(r['usd'] for r in simple)
print(f'\nOpus turns: {len(opus)}, ${ospend:.0f}. Short, quick, error-free ones: {len(simple)} (${sspend:.0f}, {sspend / max(1, ospend):.0%} of Opus spend)')
print(f'  at about half the price they would save ~${sspend * 0.5:.0f} (an upper bound; quality unchecked)')

ms = sorted(r['msgs'] for r in rows)
print('\nassistant messages per turn, median / p90:', statistics.median(ms), ms[int(len(ms) * 0.9)])
byday = collections.defaultdict(float)
for r in rows:
    byday[r['when'][:10]] += r['usd']
print('busiest days ($ at list):', sorted(((round(v), d) for d, v in byday.items()), reverse=True)[:4])
