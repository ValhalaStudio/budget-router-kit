"""Can the size of a turn be predicted from what the router sees at prompt time?

Target: a long turn = 30 or more assistant messages (the turns that hold most of the spend).
Features: kind, length bucket, previous turn's size and kind in the same session, turn index.
Evaluation: leave-one-session-out, so a model never sees the session it is scored on.
usage: python -I predict_size.py [turns.jsonl]     (pure Python, no dependencies)
"""
import collections
import json
import math
import sys

rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else 'turns.jsonl', encoding='utf8')]
rows.sort(key=lambda r: (r['sess'], r['idx']))
LONG = 30
prev_kind = {}
last = {}
for r in rows:
    r['prev_kind'] = last.get(r['sess'], 'none')
    last[r['sess']] = r['kind']
    r['long'] = r['msgs'] >= LONG


def lenb(n):
    return 0 if n < 15 else 1 if n < 40 else 2 if n < 100 else 3 if n < 300 else 4


def feats(r, level):
    f = ['bias', 'k:' + r['kind']]
    if level >= 1:
        f.append('len:%d' % lenb(r['prompt_len']))
    if level >= 2:
        pm = r['prev_msgs']
        f.append('prev:%s' % ('none' if pm is None else 'long' if pm >= LONG else 'mid' if pm >= 10 else 'short'))
        f.append('pk:' + r['prev_kind'])
    if level >= 3:
        f.append('early' if r['idx'] < 3 else 'late')
    return f


def fit(train, level, epochs=60, lr=0.2, l2=0.02):
    w = collections.defaultdict(float)
    for _ in range(epochs):
        for r in train:
            f = feats(r, level)
            p = 1 / (1 + math.exp(-sum(w[x] for x in f)))
            g = (1 if r['long'] else 0) - p
            for x in f:
                w[x] += lr * (g - l2 * w[x])
    return w


def auc(scores):
    pos = [s for s, y in scores if y]
    neg = [s for s, y in scores if not y]
    if not pos or not neg:
        return float('nan')
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


sessions = sorted({r['sess'] for r in rows})
print(f'{len(rows)} turns, {sum(r["long"] for r in rows)} long (>= {LONG} msgs), {len(sessions)} sessions\n')
names = ['kind only', '+ prompt length', '+ previous turn', '+ turn index']
results = {}
for level in range(4):
    sc = []
    for s in sessions:
        train = [r for r in rows if r['sess'] != s]
        test = [r for r in rows if r['sess'] == s]
        if not test:
            continue
        w = fit(train, level)
        for r in test:
            r['_p%d' % level] = 1 / (1 + math.exp(-sum(w[x] for x in feats(r, level))))
            sc.append((r['_p%d' % level], r['long']))
    results[level] = sc
    print(f'{names[level]:18} AUC {auc(sc):.3f}')
base = sum(r['long'] for r in rows) / len(rows)
print(f'(chance 0.500; base rate of long turns {base:.0%})')

# What it would let a router do: treat the lowest-risk half as "short".
tot = sum(r['usd'] for r in rows)
best = max(results, key=lambda k: auc(results[k]))
key = '_p%d' % best
rs = sorted(rows, key=lambda r: r[key])
for frac in (0.25, 0.5):
    low = rs[:int(len(rs) * frac)]
    missed = sum(r['long'] for r in low)
    print(f'\nlowest-risk {frac:.0%} of turns ({len(low)}): {missed} are actually long ({missed / max(1, sum(r["long"] for r in rows)):.0%} of all long turns), '
          f'they hold {sum(r["usd"] for r in low) / tot:.0%} of spend')
